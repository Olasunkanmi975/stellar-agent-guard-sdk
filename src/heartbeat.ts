/**
 * `startHeartbeat()` — keep a guard's dead-man switch alive.
 *
 * Every long-running agent must send a `heartbeat()` inside the policy's grace
 * window or the account self-freezes. Doing that with an ad-hoc
 * `setTimeout` loop gets the failure modes wrong: an event-loop stall silently
 * skips a beat, a transient RPC failure becomes an unhandled rejection, and
 * nothing reports that a beat was late until the account freezes.
 *
 * This module is the SDK-side primitive: a drift-aware scheduler that fires a
 * heartbeat on an interval, reports lateness instead of swallowing it, routes
 * every rejection to a callback, and stops cleanly (including mid-flight).
 *
 * ## Scope
 *
 * The client-side skip is a courtesy, not the guarantee: the contract also
 * deduplicates heartbeats within a ledger/grace rule. This scheduler skips a
 * beat that falls in the same wall-clock second as the previous accepted beat,
 * which saves a redundant round trip; it never claims to be the enforcement.
 */
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { DEFAULT_NETWORK_PASSPHRASE } from "./admin.ts";
import { BroadcastError, GuardError, SimulationError } from "./errors.ts";
import { invoke, RpcTimeoutError, type InvokeOutcome } from "./invoke.ts";
import { unsafeContractAddress, type PolicyConfig } from "./policy.ts";
import { explainReason, GuardBlockedError } from "./reasons.ts";
import type { AgentSigner, AdminSigner } from "./tx.ts";

/** What one heartbeat submission reports back to the scheduler. */
export interface HeartbeatSubmission {
  /** Ledger the heartbeat committed to, when the submission knows it. */
  ledger?: number;
  /** The full invoke outcome, for callers that want it. */
  outcome?: InvokeOutcome;
}

/**
 * Cancellation contract handed to every submission attempt.
 *
 * `stop()` requests cancellation through `signal` before it starts waiting, so
 * a custom transport can abandon its own pending work instead of making
 * shutdown wait for a request it no longer needs. The signal is advisory: the
 * scheduler still waits for the submission promise to settle (subject to
 * `stop`'s optional deadline), because abandoning a promise cannot undo work
 * that already reached the network.
 */
export interface HeartbeatSubmitContext {
  /** Aborted when `stop()` begins. */
  signal: AbortSignal;
}

/** One fired beat, as handed to `onBeat`. */
export interface HeartbeatBeat {
  /** Epoch milliseconds the beat fired. */
  at: number;
  /**
   * How late the beat fired past its scheduled deadline (>= 0). Agents alert on
   * lateness — a beat that lands after the next slot has effectively been
   * missed even though the transaction still succeeded.
   */
  lateMs: number;
  /** Ledger the heartbeat committed to, when the submission reported one. */
  ledger?: number;
  /**
   * How many attempts this beat took (1 = the first attempt was accepted).
   *
   * A beat that needed a retry took more than one attempt, and an operator
   * watching a flaky RPC wants to see that without counting callbacks. Absent
   * only when a caller hands `onBeat` a beat of its own making.
   */
  attempt?: number;
}

/**
 * The guard refused the heartbeat.
 *
 * A refusal is a *decision*, not a transport failure: retrying it would only
 * add load to a call the guard has already refused, so it is never retried
 * (see `isRetryableHeartbeatFailure`). It is reported through `onError` like
 * any other failed beat, because a refused heartbeat does not keep the
 * dead-man switch alive — silently treating it as a beat would be the worst
 * possible outcome for an operator.
 */
export class HeartbeatBlockedError extends GuardError {
  /** The contract's reason symbol, when the outcome carried one. */
  readonly reason: string | null;
  /** The pipeline's detail line, when it carried one. */
  readonly detail: string | undefined;

  constructor(params: { reason: string | null; detail?: string | undefined }) {
    const explanation = params.reason
      ? explainReason(params.reason)
      : "the guard refused the heartbeat without stating a reason";
    super(
      `stellar-agent-guard blocked the heartbeat${params.reason ? ` (${params.reason})` : ""}: ${explanation}` +
        (params.detail ? `\n${params.detail}` : ""),
    );
    this.name = "HeartbeatBlockedError";
    this.reason = params.reason;
    this.detail = params.detail;
  }
}

/**
 * True when a heartbeat submission failure is worth retrying (issue #340).
 *
 * Only a *transport* failure qualifies: the RPC was unreachable, the request
 * timed out, or the simulation could not run. Those are the failures a later
 * attempt can plausibly fix, and they are the ones that used to freeze an
 * account when an outage landed near the grace boundary.
 *
 * Two things are deliberately **not** retryable:
 *
 * - a **policy block** (`GuardBlockedError`, `HeartbeatBlockedError`, or a
 *   blocked `invoke` outcome): the guard made a decision, and hammering a call
 *   it has already refused only adds load;
 * - anything the SDK cannot classify: an unknown error is reported, not
 *   retried, because retrying a deterministic failure is just load.
 */
export function isRetryableHeartbeatFailure(error: unknown): boolean {
  if (error instanceof GuardBlockedError) return false;
  if (error instanceof HeartbeatBlockedError) return false;
  if (error instanceof BroadcastError) return true;
  if (error instanceof RpcTimeoutError) return true;
  if (error instanceof SimulationError) return true;
  return false;
}

/**
 * The bounded retry policy applied to a failed heartbeat submission (#340).
 *
 * Retries are **opt-in**: with no `retry` option the scheduler makes exactly
 * one attempt per beat, so the SDK never adds RPC load a caller did not ask
 * for. An operator who knows the RPC path is flaky opts in with a small
 * budget (`{ maxAttempts: 3 }`), which is bounded by construction: the
 * attempts per beat are capped, and the delay between them is capped too.
 */
export interface HeartbeatRetryOptions {
  /**
   * Total attempts per beat, including the first. Default 1 (no retry).
   * Must be an integer >= 1.
   */
  maxAttempts?: number;
  /**
   * Base full-jitter window in milliseconds. Default 250. The delay before
   * attempt *n* is a uniform sample from `[0, min(maxDelayMs, baseDelayMs *
   * 2^(n-1)))`.
   */
  baseDelayMs?: number;
  /** Upper bound for every full-jitter window in milliseconds. Default 5,000. */
  maxDelayMs?: number;
  /**
   * RNG used for the full-jitter sample; it must return a value in [0, 1).
   * Inject it to make the backoff deterministic in tests.
   */
  random?: () => number;
}

/** The defaults behind `HeartbeatRetryOptions` (issue #340). */
export const DEFAULT_HEARTBEAT_RETRY_OPTIONS = {
  /** One attempt per beat: retries are opt-in. */
  maxAttempts: 1,
  /** Base full-jitter window, in milliseconds. */
  baseDelayMs: 250,
  /** Upper bound for every full-jitter window, in milliseconds. */
  maxDelayMs: 5_000,
} as const;

/** Bounds for one `stop()` call. Both are optional; without either, stop is graceful and unbounded. */
export interface HeartbeatStopOptions {
  /**
   * How long to wait for the in-flight submission (and the loop teardown)
   * before returning. `stop()` always requests cancellation first; on a fired
   * deadline it stops waiting and reports `reason: "timeout"`.
   */
  timeoutMs?: number;
  /** Cancels the wait (not the scheduler, which `stop()` already stopped). */
  signal?: AbortSignal;
}

/**
 * What `stop()` observed. A graceful stop waits for the in-flight submission to
 * settle; a bounded stop can return before that, and says so.
 */
export interface HeartbeatStopResult {
  /**
   * `completed` — the loop and any in-flight submission settled before the
   * bound. `timeout` / `aborted` — `stop()` returned first; the submission was
   * asked to cancel and its eventual result, if any, follows the normal
   * `onBeat` / `onError` channels.
   */
  reason: "completed" | "timeout" | "aborted";
  /** True when the submission (if one was in flight) settled before return. */
  settled: boolean;
  /** The in-flight submission's value when it settled successfully. */
  submission?: HeartbeatSubmission | void;
  /** The in-flight submission's terminal error when it settled with one. */
  error?: unknown;
}

/** The running scheduler, returned by `startHeartbeat`. */
export interface HeartbeatHandle {
  /**
   * Stop the scheduler. Idempotent, and by default resolves once an in-flight
   * beat has settled — so after `await stop()` no further submission can occur
   * and none is in progress.
   *
   * Stopping first aborts the submission context's `signal` (a request to
   * cancel) and then waits for the submission promise. Pass `timeoutMs` or a
   * `signal` to bound that wait; when the bound fires, `stop()` returns with
   * `reason: "timeout"` / `"aborted"` and `settled: false` instead of hanging
   * on a transport that ignores cancellation. No beat is scheduled or sent
   * after the call.
   */
  stop(options?: HeartbeatStopOptions): Promise<HeartbeatStopResult>;
  /** Epoch ms of the last successfully submitted beat, or `null`. */
  readonly lastBeatAt: number | null;
  /** Beats that fired later than `maxSkewMs` or whose cadence slots were skipped. */
  readonly missedBeats: number;
  /** True once stopped (by `stop()` or by the abort signal). */
  readonly stopped: boolean;
}

/**
 * Thrown before the first beat when the requested interval is unsafe for the
 * account's dead-man grace window: beating less often than once per
 * `grace / 3` leaves room for a single missed beat to freeze the account.
 */
export class HeartbeatIntervalError extends Error {
  readonly intervalMs: number;
  readonly graceSecs: bigint;
  readonly maxIntervalMs: number;

  constructor(intervalMs: number, graceSecs: bigint, maxIntervalMs: number) {
    super(
      `heartbeat interval ${intervalMs}ms exceeds one third of the dead-man grace window ` +
        `(${graceSecs}s → at most ${maxIntervalMs}ms); a single missed beat could freeze the account`,
    );
    this.name = "HeartbeatIntervalError";
    this.intervalMs = intervalMs;
    this.graceSecs = graceSecs;
    this.maxIntervalMs = maxIntervalMs;
  }
}

/** Parameters to the default submission, `submitHeartbeat()`. */
export interface SubmitHeartbeatParams {
  server: rpc.Server;
  /** The guard smart account to heartbeat. */
  guard: string;
  /** The account's registered agent signer (Keypair or `AgentSigner`). */
  signer: AgentSigner | Keypair;
  /**
   * Classic account that pays the fee and supplies the sequence number.
   * Defaults to `signer` when it is a `Keypair`; required otherwise, since an
   * `AgentSigner` is a signing capability, not a fee-paying account.
   */
  source?: Keypair | AdminSigner;
  networkPassphrase?: string;
  pollAttempts?: number;
  pollIntervalMs?: number;
  /** Cancellation forwarded to the underlying `invoke()` pipeline. */
  signal?: AbortSignal;
}

export interface HeartbeatOptions {
  /** The guard smart account to keep alive. */
  guard: string;
  /** The account's registered agent signer (Keypair or `AgentSigner`). */
  signer: AgentSigner | Keypair;
  /**
   * How often to beat, in ms. The first beat fires immediately on start, then
   * every `intervalMs`. Must be positive.
   */
  intervalMs: number;
  /**
   * Lateness tolerated before a beat counts as missed. Defaults to `0`
   * (strict): set it to your scheduler's tolerable drift (e.g. `2_000` for a
   * 30s interval) if timer jitter should not be reported as lateness.
   *
   * Must be a finite, non-negative number: a negative threshold would make
   * every beat look late, and a non-finite one would make the lateness report
   * meaningless. Both are rejected before the first beat (issue #341).
   */
  maxSkewMs?: number;
  onBeat?: (beat: HeartbeatBeat) => void;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;

  /** Required for the default submission (unless `submit` is supplied). */
  server?: rpc.Server;
  /** Classic fee/sequence account; defaults to `signer` when it is a Keypair. */
  source?: Keypair | AdminSigner;
  networkPassphrase?: string;
  pollAttempts?: number;
  pollIntervalMs?: number;

  /**
   * Optional read of the live policy, used to validate the interval against
   * `dms_grace_secs` before the first beat. If it resolves to a policy with a
   * window, an unsafe interval throws `HeartbeatIntervalError`; if it resolves
   * to `null` or rejects, the check is skipped with an `onWarning`. Providing
   * `graceSecs` directly avoids the read.
   */
  readPolicy?: () => Promise<PolicyConfig | null>;
  /**
   * A known grace window, in seconds, for the pre-start interval check.
   *
   * Accepted values: a non-negative `bigint` (exact, any size) or a
   * non-negative safe integer. A fractional, non-finite, negative or
   * unsafe-precision number is rejected before the scheduler starts: the
   * `BigInt` conversion it feeds would either throw with an opaque message
   * or silently carry a rounded value into the `interval <= grace/3` check
   * (issue #341).
   */
  graceSecs?: number | bigint;
  /** Warning channel. The SDK carries no logger; this keeps it that way. */
  onWarning?: (message: string) => void;

  /**
   * Bounded retry for a failed submission (issue #340).
   *
   * Omitted → one attempt per beat, exactly as before. A configured policy
   * retries a *transport* failure with full-jitter backoff; a policy block is
   * never retried.
   */
  retry?: HeartbeatRetryOptions;

  /**
   * Replace the submission step (testing seam, or a custom transport). Receives
   * the beat and a cancellation context whose `signal` aborts when `stop()`
   * begins. Defaults to `submitHeartbeat()`.
   */
  submit?: (
    beat: HeartbeatBeat,
    context: HeartbeatSubmitContext,
  ) => Promise<HeartbeatSubmission | void>;
  /**
   * Default deadline for a graceful `stop()`. Omitted → `stop()` waits
   * indefinitely for an in-flight submission (the pre-existing behaviour).
   * `stop({ timeoutMs })` overrides it for one call.
   */
  stopTimeoutMs?: number;
  /** Clock seam (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Wait seam. Defaults to an abortable `setTimeout`. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The default poll delay: a `setTimeout` an abort cancels outright. */
function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAgentSigner(signer: AgentSigner | Keypair): signer is AgentSigner {
  return typeof (signer as AgentSigner).signDigest === "function";
}

/**
 * Submit a single `heartbeat()` to the guard with the agent's authorization.
 *
 * The heartbeat is a guard call like any other, so it goes through `invoke()`
 * with the agent's `guardAuth` (the custom account's own authorization) and a
 * classic `source` that pays the fee.
 */
export async function submitHeartbeat(params: SubmitHeartbeatParams): Promise<HeartbeatSubmission> {
  const source = params.source ?? (isAgentSigner(params.signer) ? undefined : params.signer);
  if (!source) {
    throw new Error(
      "submitHeartbeat requires `source`: an AgentSigner is a signing capability, not a fee-paying classic account",
    );
  }
  const outcome = await invoke({
    server: params.server,
    source,
    call: { contract: unsafeContractAddress(params.guard), fn: "heartbeat", args: [] },
    networkPassphrase: params.networkPassphrase ?? DEFAULT_NETWORK_PASSPHRASE,
    guardAuth: { guard: unsafeContractAddress(params.guard), agent: params.signer },
    ...(params.pollAttempts !== undefined ? { pollAttempts: params.pollAttempts } : {}),
    ...(params.pollIntervalMs !== undefined ? { pollIntervalMs: params.pollIntervalMs } : {}),
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
  });
  const ledger = outcome.kind === "allowed" ? outcome.submission.ledger : null;
  return {
    outcome,
    ...(ledger !== null && ledger !== undefined ? { ledger } : {}),
  };
}

async function resolveGrace(
  options: HeartbeatOptions,
): Promise<{ grace: bigint | null; readable: boolean }> {
  if (options.graceSecs !== undefined) {
    const grace =
      typeof options.graceSecs === "bigint" ? options.graceSecs : BigInt(options.graceSecs);
    return { grace, readable: true };
  }
  if (options.readPolicy) {
    try {
      const policy = await options.readPolicy();
      if (policy) return { grace: policy.dms_grace_secs, readable: true };
      return { grace: null, readable: false };
    } catch {
      return { grace: null, readable: false };
    }
  }
  return { grace: null, readable: false };
}

function defaultSubmit(
  options: HeartbeatOptions,
): (beat: HeartbeatBeat, context: HeartbeatSubmitContext) => Promise<HeartbeatSubmission> {
  return async (_beat, context) => {
    if (!options.server) {
      throw new Error("startHeartbeat needs `server` (or an explicit `submit`) to send heartbeats");
    }
    return submitHeartbeat({
      server: options.server,
      guard: options.guard,
      signer: options.signer,
      ...(options.source !== undefined ? { source: options.source } : {}),
      ...(options.networkPassphrase !== undefined
        ? { networkPassphrase: options.networkPassphrase }
        : {}),
      ...(options.pollAttempts !== undefined ? { pollAttempts: options.pollAttempts } : {}),
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      signal: context.signal,
    });
  };
}

/**
 * Assert that an option the scheduler will call is callable.
 *
 * A `wait` that is not a function kills the loop on its first tick with an
 * error nobody sees (the loop's rejection is swallowed on purpose), so the
 * misconfiguration is caught here instead, where the stack still points at
 * the caller's code (issue #341).
 */
function assertFunctionOption(name: string, value: unknown): void {
  if (value !== undefined && typeof value !== "function") {
    throw new TypeError(`heartbeat ${name} must be a function, received ${typeof value}`);
  }
}

/**
 * Validate every scheduler input before anything is scheduled or submitted
 * (issue #341).
 *
 * These inputs are the difference between "the agent is late" and "the agent
 * is misconfigured": a negative `maxSkewMs` makes every beat look late, a
 * `NaN` or fractional grace window makes the `interval <= grace/3` check
 * meaningless, and a non-callable `wait` kills the loop silently. All of them
 * fail here — before the first beat, and before the grace window is even read
 * from the chain — with an error that names the offending field.
 */
function assertHeartbeatOptions(options: HeartbeatOptions): void {
  const { intervalMs } = options;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`heartbeat intervalMs must be a positive number, received ${intervalMs}`);
  }
  if (options.maxSkewMs !== undefined) {
    const maxSkewMs = options.maxSkewMs;
    if (!Number.isFinite(maxSkewMs) || maxSkewMs < 0) {
      throw new RangeError(
        `heartbeat maxSkewMs must be a finite, non-negative number, received ${maxSkewMs}`,
      );
    }
  }
  if (options.stopTimeoutMs !== undefined) {
    const stopTimeoutMs = options.stopTimeoutMs;
    if (!Number.isFinite(stopTimeoutMs) || stopTimeoutMs < 0) {
      throw new RangeError(
        `heartbeat stopTimeoutMs must be a finite, non-negative number, received ${stopTimeoutMs}`,
      );
    }
  }
  if (options.graceSecs !== undefined) {
    const graceSecs = options.graceSecs;
    if (typeof graceSecs === "bigint") {
      if (graceSecs < 0n) {
        throw new RangeError(
          `heartbeat graceSecs must be a non-negative bigint, received ${graceSecs}`,
        );
      }
    } else if (typeof graceSecs === "number") {
      // A safe integer is the only number that survives the `BigInt` conversion
      // unchanged; a fractional one throws, and an imprecise one would carry a
      // rounded value into the grace check.
      if (!Number.isSafeInteger(graceSecs) || graceSecs < 0) {
        throw new RangeError(
          `heartbeat graceSecs must be a non-negative safe integer, received ${graceSecs}`,
        );
      }
    } else {
      throw new TypeError(
        `heartbeat graceSecs must be a number or a bigint, received ${typeof graceSecs}`,
      );
    }
  }
  assertFunctionOption("onBeat", options.onBeat);
  assertFunctionOption("onError", options.onError);
  assertFunctionOption("onWarning", options.onWarning);
  assertFunctionOption("readPolicy", options.readPolicy);
  assertFunctionOption("submit", options.submit);
  assertFunctionOption("now", options.now);
  assertFunctionOption("wait", options.wait);
  if (options.retry !== undefined) {
    if (typeof options.retry !== "object" || options.retry === null) {
      throw new TypeError(`heartbeat retry must be an object, received ${typeof options.retry}`);
    }
    assertFunctionOption("retry.random", options.retry.random);
  }
}

/** The retry policy with every default filled in. */
interface ResolvedHeartbeatRetry {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random: () => number;
}

/**
 * Fill in the retry defaults and reject an unusable policy (issue #340).
 *
 * The bounds are checked here, before the first beat, so a typo in the retry
 * budget cannot turn into an unbounded storm of heartbeats.
 */
function resolveRetryOptions(options: HeartbeatRetryOptions | undefined): ResolvedHeartbeatRetry {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_HEARTBEAT_RETRY_OPTIONS.maxAttempts;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_HEARTBEAT_RETRY_OPTIONS.baseDelayMs;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_HEARTBEAT_RETRY_OPTIONS.maxDelayMs;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(
      `heartbeat retry.maxAttempts must be an integer >= 1, received ${maxAttempts}`,
    );
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError(
      `heartbeat retry.baseDelayMs must be finite and >= 0, received ${baseDelayMs}`,
    );
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new RangeError(
      `heartbeat retry.maxDelayMs must be finite and >= 0, received ${maxDelayMs}`,
    );
  }

  return { maxAttempts, baseDelayMs, maxDelayMs, random: options?.random ?? Math.random };
}

/**
 * Full-jitter delay before the next attempt (issue #340).
 *
 * The exponential value is only the window: multiplying it by an independent
 * random sample spreads agents that hit the same RPC outage instead of
 * releasing them in a synchronized thundering herd.
 */
function fullJitterDelay(attempt: number, options: ResolvedHeartbeatRetry): number {
  const window = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const sample = options.random();
  // A custom RNG should return [0, 1), but clamp a bad edge value rather than
  // allowing a production retry policy to be disabled by an out-of-range sample.
  const normalized = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
  return Math.floor(window * normalized);
}

/** A one-line rendering of a failure, for the retry warning. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The result of one heartbeat submission attempt. */
type HeartbeatAttemptResult =
  | { ok: true; submission: HeartbeatSubmission | void }
  | { ok: false; error: unknown; retryable: boolean };

/** The result of one beat, after any configured retries. */
type BeatSubmissionResult =
  | {
      ok: true;
      attempt: number;
      ledger?: number;
      submission: HeartbeatSubmission | void;
    }
  | { ok: false; attempt: number; error: unknown };

/**
 * Run one submission attempt and classify what came back (issue #340).
 *
 * A heartbeat can fail in two shapes: the submission throws, or it *resolves*
 * with an outcome that is not a success — `invoke()` reports a policy block
 * and a pipeline failure as outcomes, not as throws. Both are failures here,
 * because a heartbeat that was refused or that never reached the ledger does
 * not keep the dead-man switch alive.
 */
async function attemptSubmission(
  submit: (beat: HeartbeatBeat, context: HeartbeatSubmitContext) => Promise<HeartbeatSubmission | void>,
  beat: HeartbeatBeat,
  context: HeartbeatSubmitContext,
): Promise<HeartbeatAttemptResult> {
  let submission: HeartbeatSubmission | void;
  try {
    submission = await submit(beat, context);
  } catch (error) {
    return { ok: false, error, retryable: isRetryableHeartbeatFailure(error) };
  }

  const outcome = submission?.outcome;
  if (outcome === undefined) return { ok: true, submission };
  if (outcome.kind === "blocked") {
    // The guard refused the heartbeat. A refusal is a decision: it is reported
    // and never retried.
    return {
      ok: false,
      error: new HeartbeatBlockedError({ reason: outcome.reason, detail: outcome.detail }),
      retryable: false,
    };
  }
  if (outcome.kind === "error") {
    // A pipeline failure. The typed error says whether it was a transport
    // problem (retryable) or something the SDK cannot classify.
    const error = outcome.error;
    return { ok: false, error, retryable: isRetryableHeartbeatFailure(error) };
  }
  return { ok: true, submission };
}

/**
 * Start beating. Resolves once any pre-start grace validation has run (which is
 * why it is async), and returns a handle to the running scheduler.
 *
 * ## Scheduling
 *
 * Beats are scheduled on a **fixed cadence from the start**, not "interval
 * after the previous beat finished", so a slow beat does not push every later
 * one. A submission that outlives one or more slots does not trigger a
 * catch-up burst: the stale slots are counted in `missedBeats` and the next
 * beat waits for the next future deadline. The first beat fires immediately, so
 * a freshly started agent registers without waiting a full interval.
 *
 * ## Lateness and failures
 *
 * A beat that fires more than `maxSkewMs` past its deadline increments
 * `missedBeats` and is reported through `onBeat`'s `lateMs`; every cadence slot
 * skipped while a submission was in flight is counted too. A submission
 * failure goes to `onError` and never escapes as an unhandled rejection.
 *
 * ## Stopping
 *
 * `stop()` requests cancellation through the submission context's `signal` and
 * then waits for the in-flight submission to settle, preserving graceful
 * teardown. A custom transport that cannot guarantee settlement can be bounded
 * with `stopTimeoutMs` or `stop({ timeoutMs })`; when that bound fires, stop
 * returns `{ reason: "timeout", settled: false }` instead of hanging. The
 * submission's eventual result, if it arrives, is reported through the usual
 * `onBeat` / `onError` channels.
 *
 * ## Retries (issue #340)
 *
 * With a `retry` policy, a *transport* failure is retried with bounded
 * full-jitter backoff; a policy block is never retried. The attempt that
 * failed and the delay before the next one are announced through `onWarning`,
 * and the failure that ends the beat is reported once through `onError`.
 */
export async function startHeartbeat(options: HeartbeatOptions): Promise<HeartbeatHandle> {
  // Every input is checked before the scheduler exists: an invalid skew
  // threshold, grace window or callback must not reach the first beat (issue
  // #341), and an unusable retry budget must not become a request storm
  // (issue #340).
  assertHeartbeatOptions(options);
  const retry = resolveRetryOptions(options.retry);

  const { intervalMs } = options;
  const maxSkewMs = options.maxSkewMs ?? 0;
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? defaultWait;

  const { grace, readable } = await resolveGrace(options);
  if (grace !== null && grace > 0n) {
    const maxIntervalMs = Number((grace * 1000n) / 3n);
    if (intervalMs > maxIntervalMs) {
      throw new HeartbeatIntervalError(intervalMs, grace, maxIntervalMs);
    }
  } else if (!readable) {
    options.onWarning?.(
      "dead-man grace window unavailable; skipping the interval <= grace/3 check. " +
        "Pass `graceSecs` or a `readPolicy` to enforce it before the first beat.",
    );
  }

  let stopped = false;
  let lastBeatAt: number | null = null;
  let missedBeats = 0;
  let lastBeatSecond: number | null = null;
  const controller = new AbortController();
  // Submission cancellation is separate from the scheduler's wait controller:
  // stopping always requests it, while the loop preserves graceful teardown.
  const submissionController = new AbortController();
  const submissionContext: HeartbeatSubmitContext = { signal: submissionController.signal };
  let beatInFlight = false;
  let lastBeatResult: BeatSubmissionResult | null = null;

  const external = options.signal;
  const onExternalAbort = () => {
    void stop();
  };

  const submit = options.submit ?? defaultSubmit(options);

  // Settles when the loop has fully exited, so `stop()` can await teardown
  // (including an in-flight beat) rather than returning early.
  let resolveLoopDone: () => void = () => {};
  const loopDone = new Promise<void>((resolve) => {
    resolveLoopDone = resolve;
  });

  let stopPromise: Promise<HeartbeatStopResult> | undefined;

  function completedStopResult(inFlightAtStop: boolean): HeartbeatStopResult {
    if (!inFlightAtStop || lastBeatResult === null) {
      return { reason: "completed", settled: true };
    }
    if (lastBeatResult.ok) {
      return {
        reason: "completed",
        settled: true,
        submission: lastBeatResult.submission,
      };
    }
    return { reason: "completed", settled: true, error: lastBeatResult.error };
  }

  function waitForStop(
    stopOptions: HeartbeatStopOptions | undefined,
    inFlightAtStop: boolean,
  ): Promise<HeartbeatStopResult> {
    const timeoutMs = stopOptions?.timeoutMs ?? options.stopTimeoutMs;
    const signal = stopOptions?.signal;

    if (signal?.aborted) {
      return Promise.resolve({ reason: "aborted", settled: false });
    }
    if (timeoutMs === undefined && signal === undefined) {
      return loopDone.then(() => completedStopResult(inFlightAtStop));
    }

    return new Promise<HeartbeatStopResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (result: HeartbeatStopResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onAbort = () => finish({ reason: "aborted", settled: false });

      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => finish({ reason: "timeout", settled: false }), timeoutMs);
      }
      loopDone.then(() => finish(completedStopResult(inFlightAtStop)));
    });
  }

  function stop(stopOptions?: HeartbeatStopOptions): Promise<HeartbeatStopResult> {
    if (stopOptions?.timeoutMs !== undefined) {
      const timeoutMs = stopOptions.timeoutMs;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        return Promise.reject(
          new RangeError(
            `heartbeat stop timeoutMs must be a finite, non-negative number, received ${timeoutMs}`,
          ),
        );
      }
    }
    if (stopPromise) return stopPromise;

    const inFlightAtStop = beatInFlight;
    stopped = true;
    controller.abort();
    submissionController.abort();
    external?.removeEventListener("abort", onExternalAbort);
    stopPromise = waitForStop(stopOptions, inFlightAtStop);
    return stopPromise;
  }

  /**
   * Submit one beat, retrying a retryable failure with bounded backoff
   * (issue #340).
   *
   * The attempts and the final failure are both reported, each exactly once:
   * the attempt that failed and the delay before the next one are announced
   * through `onWarning`, and the failure that ends the beat is returned to
   * the caller, which reports it through `onError`.
   */
  async function submitBeat(beat: HeartbeatBeat): Promise<BeatSubmissionResult> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const result = await attemptSubmission(submit, beat, submissionContext);
      if (result.ok) {
        const ledger = result.submission?.ledger;
        return {
          ok: true,
          attempt,
          ...(ledger !== undefined ? { ledger } : {}),
          submission: result.submission,
        };
      }
      // A policy block (or a failure the SDK cannot classify) is final, and so
      // is an exhausted budget: retrying either adds load without a chance of
      // a different answer.
      if (!result.retryable || attempt >= retry.maxAttempts || stopped) {
        return { ok: false, attempt, error: result.error };
      }
      const delay = fullJitterDelay(attempt, retry);
      try {
        options.onWarning?.(
          `heartbeat submission failed on attempt ${attempt} of ${retry.maxAttempts}; ` +
            `retrying in ${delay}ms: ${describeFailure(result.error)}`,
        );
      } catch {
        /* a broken warning handler must not kill the scheduler */
      }
      // The backoff uses the same abortable wait as the cadence, so a stop
      // during the delay ends the wait at once instead of idling until it
      // expires.
      await wait(delay, controller.signal);
      if (stopped) return { ok: false, attempt, error: result.error };
    }
  }

  async function run(): Promise<void> {
    let deadline = now();

    // A submission can outlive several cadence slots. Advance over every slot
    // that is already stale instead of firing the backlog back-to-back; each
    // skipped slot is counted once for `missedBeats`.
    const skipExpiredSlots = (): void => {
      const current = now();
      if (deadline > current) return;
      // Count the whole stale range arithmetically so a large clock jump cannot
      // spin the loop once per skipped slot.
      const skipped = Math.floor((current - deadline) / intervalMs) + 1;
      deadline += skipped * intervalMs;
      missedBeats += skipped;
    };

    while (!stopped) {
      await wait(Math.max(0, deadline - now()), controller.signal);
      if (stopped) break;

      const at = now();
      const lateMs = Math.max(0, at - deadline);
      deadline += intervalMs;
      skipExpiredSlots();

      const second = Math.floor(at / 1000);
      if (lastBeatSecond !== null && second === lastBeatSecond) {
        // Same wall-clock second as the last accepted beat: skip the redundant
        // submission. The contract also dedupes; this only saves the round trip.
        continue;
      }

      if (lateMs > maxSkewMs) missedBeats += 1;

      beatInFlight = true;
      const result = await submitBeat({ at, lateMs });
      beatInFlight = false;
      lastBeatResult = result;
      skipExpiredSlots();

      if (stopped) break;

      if (!result.ok) {
        try {
          options.onError?.(result.error);
        } catch {
          /* ditto: a broken error handler must not kill the scheduler */
        }
        continue;
      }

      lastBeatAt = at;
      lastBeatSecond = second;
      try {
        options.onBeat?.({
          at,
          lateMs,
          attempt: result.attempt,
          ...(result.ledger !== undefined ? { ledger: result.ledger } : {}),
        });
      } catch {
        // The consumer's callback is theirs to get wrong; it must not stop the
        // dead-man switch from being kept alive.
      }
    }
  }

  if (external?.aborted) {
    stopped = true;
    submissionController.abort();
    return {
      stop: async () => ({ reason: "completed", settled: true }),
      get lastBeatAt() {
        return null;
      },
      get missedBeats() {
        return 0;
      },
      get stopped() {
        return true;
      },
    };
  }
  external?.addEventListener("abort", onExternalAbort, { once: true });

  void run().then(resolveLoopDone, resolveLoopDone);

  return {
    stop,
    get lastBeatAt() {
      return lastBeatAt;
    },
    get missedBeats() {
      return missedBeats;
    },
    get stopped() {
      return stopped;
    },
  };
}
