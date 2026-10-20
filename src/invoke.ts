/**
 * The full invocation pipeline for a guarded account, in the order the Stellar
 * host actually requires:
 *
 *  1. simulate with no authorization  → RPC reports which authorizations the
 *     call needs (and the footprint that call touches);
 *  2. sign each reported authorization — a classic keypair for admin calls, or
 *     an agent-signed `SorobanAuthorizationEntry` for the guard contract;
 *  3. simulate again with the signed entries → this second simulation runs the
 *     *real* `__check_auth` against live ledger state, so a policy violation is
 *     reported here, **before** anything is broadcast;
 *  4. only if step 3 succeeds, assemble the real resources, sign the envelope
 *     and broadcast.
 *
 * Steps 1–3 never mutate the ledger. A blocked action therefore costs nothing,
 * which is the property the pre-flight interceptor is built to expose.
 */
import { Account, Address, Keypair, Operation, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { systemClock, type Clock } from "./clock.ts";
import { feeBreakdown, type FeeBreakdown } from "./cost.ts";
import {
  BroadcastError,
  ContractResponseError,
  GuardError,
  SigningError,
  SimulationError,
} from "./errors.ts";
import { GUARD_AUTH_RESULTS, decodeAuthDecision } from "./events.ts";
import {
  SILENT_LOGGER,
  resolveLogger,
  type GuardLogger,
  type GuardLoggerInput,
} from "./logger.ts";
import type { TraceStepName, TraceStepStatus } from "./trace.ts";
import type {
  InvokeErrorCause,
  InvokeRetryAttempt,
  InvokeRetryMetadata,
  RetryableInvokeFailure,
} from "./retry.ts";
export type {
  InvokeErrorCause,
  InvokeRetryAttempt,
  InvokeRetryMetadata,
  RetryableInvokeFailure,
} from "./retry.ts";
import {
  SIG_EXPIRATION_LEDGERS,
  assembleFromSimulation,
  buildGuardAuthEntry,
  buildInitialEnvelope,
  describeSimulationResources,
  describeSubmissionFailure,
  INCLUSION_FEE,
  isMinimumFeeBroadcastFailure,
  isSequenceNumberFailure,
  isStaleLedgerResourceFailure,
  parseSimulationResourceFee,
  signAccountAuthEntry,
  summarizeDiagnosticEvents,
  submitAndPoll,
  type AdminSigner,
  type AgentSigner,
  type ContractCall,
  type SubmissionAcceptedEvent,
  type SubmissionResult,
  toAgentSigner,
} from "./tx.ts";

export type { SubmissionAcceptedEvent } from "./tx.ts";

/** How the guard's authorization is produced for a call that needs it. */
export interface GuardAuthorization {
  guard: string;
  /**
   * The account's registered agent signer: an `AgentSigner` for any signing
   * setup, or a plain Ed25519 `Keypair` for the single-key default. The
   * multi-key shape (contracts v2) arrives behind the same interface — see
   * `docs/concepts/multi-key-agent-signing.md`.
   */
  agent: AgentSigner | Keypair;
}

/**
 * Default RPC timeout applied when a caller supplies neither `timeoutMs` nor
 * its own `signal`. A hung Soroban RPC (network partition, black-holed
 * connection) would otherwise leave `check()`/`invoke()` pending forever, which
 * turns a fail-closed guardrail into an unbounded hang — not a decision. A
 * bounded default is the safer posture: an agent that cannot reach the network
 * gets a typed `RpcTimeoutError` and can fail closed on its own terms.
 *
 * 30s is generous enough for a slow-but-live RPC (a full enforced simulation
 * against a busy ledger) while still bounding the worst case. Callers that
 * need a different budget pass `timeoutMs` explicitly; callers that need no
 * bound at all pass `timeoutMs: 0` (documented below).
 */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * Raised when an RPC call is aborted or exceeds its timeout.
 *
 * The underlying HTTP request is *not* cancelled at the transport layer:
 * `stellar-sdk` 17's `Server` methods do not accept an `AbortSignal`, so this
 * SDK races the in-flight promise against the signal/timeout. The request
 * therefore continues server-side until it completes or the connection times
 * out; cancellation here is local-only. That is an honest limitation, not a
 * bug — the caller's decision (fail closed) is what matters, and it is made
 * promptly.
 */
export class RpcTimeoutError extends GuardError {
  readonly kind = "timeout" as const;
  /** Which pipeline stage was in flight when the bound fired. */
  readonly stage: string;
  /** True when the caller's own `AbortSignal` fired; false for a timeout. */
  readonly aborted: boolean;
  /** True when the overall `deadlineMs` budget fired, false for `timeoutMs`. */
  readonly deadline: boolean;
  /** The budget that fired, in milliseconds; absent when the bound was a signal abort. */
  readonly timeoutMs?: number | undefined;
  /**
   * The transaction hash, when the bound fired *after* the transaction was
   * broadcast.
   *
   * A bound that fires while the pipeline is waiting for an inclusion does not
   * un-send the transaction: it may still land. Carrying the hash here is what
   * lets the caller look it up instead of parsing the error text.
   */
  readonly transactionHash?: string | undefined;

  constructor(params: {
    stage: string;
    aborted: boolean;
    timeoutMs?: number;
    deadline?: boolean;
    transactionHash?: string;
  }) {
    const reason = params.aborted
      ? "aborted by caller signal"
      : params.deadline
        ? "exceeded the overall invoke deadline"
        : `exceeded timeout of ${params.timeoutMs}ms`;
    // The classified cause the pipeline surfaces for an abort or a timeout:
    // callers branch on `cause === "timeout"`. The `stage` and `aborted` fields
    // carry the detail, so nothing is lost to the single coarse cause.
    super(`RPC call during '${params.stage}' ${reason}`, { cause: "timeout" });
    this.stage = params.stage;
    this.aborted = params.aborted;
    this.deadline = params.deadline === true;
    if (params.timeoutMs !== undefined) this.timeoutMs = params.timeoutMs;
    if (params.transactionHash !== undefined) this.transactionHash = params.transactionHash;
  }
}

/**
 * Shared plumbing for every RPC call the pipeline makes.
 *
 * One implementation, used by `getAccount`, `getLatestLedger`,
 * `simulateTransaction` (both probe and enforced), and `submitAndPoll` — so
 * abort/timeout semantics cannot drift between stages. The rules:
 *
 *  - An already-aborted signal short-circuits *before* `run()` is invoked, so
 *    no RPC call is made at all (the acceptance criterion: "already-aborted
 *    signal returns without RPC call").
 *  - A mid-flight abort or a fired timeout rejects promptly with
 *    `RpcTimeoutError`, even though the underlying request keeps running.
 *  - `timeoutMs: 0` disables the timeout entirely (opt-out for callers that
 *    manage their own bound); `undefined` uses `DEFAULT_RPC_TIMEOUT_MS`.
 *  - The signal/timeout listeners are always removed, so a long-lived signal
 *    shared across many calls does not accumulate listeners.
 */
export async function withRpcAbort<T>(
  params: {
    stage: string;
    signal?: AbortSignal | undefined;
    timeoutMs?: number | undefined;
  },
  run: () => Promise<T>,
): Promise<T> {
  const { stage, signal } = params;
  const timeoutMs = params.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

  if (signal?.aborted) {
    throw new RpcTimeoutError({ stage, aborted: true });
  }

  if (timeoutMs <= 0 && !signal) return run();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new RpcTimeoutError({ stage, aborted: true }));
    };

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new RpcTimeoutError({ stage, aborted: false, timeoutMs }));
      }, timeoutMs);
    }

    run().then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Machine-readable causes attached to non-policy `invoke()` failures.
 *
 * `undetermined` deliberately covers errors for which the guard did not make a
 * decision (a bad input, an RPC/host failure, or an unsupported auth shape).
 * It is the same fail-closed category used by pre-flight decisions; it must not
 * be confused with `blocked`, which means the guard actually refused the call.
 */
export const INVOKE_ERROR_CAUSES = {
  undetermined: "undetermined",
  staleLedgerResourceLimit: "stale_ledger_resource_limit",
  sequenceNumberCollision: "sequence_number_collision",
} as const;

/**
 * Failures that a fresh invocation pipeline can fix: a stale-ledger resource
 * declaration (see `isStaleLedgerResourceFailure`), a sequence-number collision
 * (see `isSequenceNumberFailure`) in `tx.ts`, or a minimum-fee broadcast
 * rejection. They share the bounded retry policy in `invoke`.
 */

/** The coarse cause each retryable failure reports once the budget is spent. */
const RETRYABLE_CAUSES = {
  stale_ledger_resource_limit: INVOKE_ERROR_CAUSES.staleLedgerResourceLimit,
  sequence_number_collision: INVOKE_ERROR_CAUSES.sequenceNumberCollision,
  min_fee: INVOKE_ERROR_CAUSES.undetermined,
} as const satisfies Record<RetryableInvokeFailure, InvokeErrorCause>;

/** The error arm returned by one invocation attempt. */
export interface InvokeErrorOutcome {
  kind: "error";
  detail: string;
  /** Machine-readable failure; branch on this with `instanceof`. */
  error: GuardError;
  /** Diagnostic events the host bundled with the failure, if any. */
  diagnosticEvents: unknown[];
  /**
   * The transaction hash, when the failure happened *after* the transaction was
   * broadcast.
   *
   * This is the operator's recovery handle: a failed status poll, a spent
   * deadline or a post-inclusion rejection all leave the transaction on the
   * network, and the hash is what lets the caller look it up. It is absent when
   * nothing was broadcast.
   */
  transactionHash?: string | undefined;
  /** Coarse cause; absent for a dry run because no failure was classified. */
  cause?: InvokeErrorCause;
  /** Set when a re-simulation against fresh state can fix the failure. */
  retryable?: RetryableInvokeFailure;
  /** Fee of the transaction when broadcast was attempted. */
  lastFee?: bigint | undefined;
  /** Submission result when broadcast was attempted. */
  submission?: SubmissionResult | undefined;
  /** Structured retry metadata attached to the terminal outcome. */
  retry?: InvokeRetryMetadata | undefined;
}

/**
 * Raised/returned when the bounded stale-ledger retry budget is exhausted.
 *
 * `invoke()` returns this object as its `kind: "error"` outcome rather than
 * throwing, preserving the result-oriented API. It is still a real `Error`, so
 * callers can use `instanceof`, retain it for diagnostics, or rethrow it.
 */
export class InvokeRetryError extends Error {
  readonly kind = "error" as const;
  readonly attempts: number;
  override readonly cause: InvokeErrorCause;
  readonly lastCause: InvokeErrorCause;
  readonly detail: string;
  readonly lastOutcome: InvokeErrorOutcome;
  /**
   * The last attempt's typed failure. Present so that narrowing an
   * `InvokeOutcome` to `kind: "error"` always yields an `error` to branch on
   * with `instanceof`, whatever exhausted the retry budget.
   */
  readonly error: GuardError;
  /** Diagnostic events from the last attempt, if any. */
  readonly diagnosticEvents: unknown[];
  /** An exhausted attempt is no longer itself retryable. */
  readonly retryable?: undefined;
  /** Structured retry metadata; always present on an exhausted invocation. */
  readonly retry: InvokeRetryMetadata;
  /**
   * The transaction hash of the last attempt, when that attempt had broadcast
   * one.
   *
   * A retry budget that runs out still leaves the last transaction on the
   * network, so the hash — the operator's recovery handle — travels with the
   * exhausted outcome rather than only with the attempt that failed.
   */
  get transactionHash(): string | undefined {
    return this.lastOutcome.transactionHash;
  }

  constructor(params: {
    attempts: number;
    lastOutcome: InvokeErrorOutcome;
    retry?: InvokeRetryMetadata;
  }) {
    const lastCause =
      params.lastOutcome.retryable === undefined
        ? (params.lastOutcome.cause ?? INVOKE_ERROR_CAUSES.undetermined)
        : RETRYABLE_CAUSES[params.lastOutcome.retryable];
    super(
      `stellar-agent-guard invoke retry budget exhausted after ${params.attempts} attempt(s) ` +
        `(last cause: ${lastCause})\n${params.lastOutcome.detail}`,
    );
    this.name = "InvokeRetryError";
    this.attempts = params.attempts;
    this.cause = lastCause;
    this.lastCause = lastCause;
    this.detail = params.lastOutcome.detail;
    this.lastOutcome = params.lastOutcome;
    this.error = params.lastOutcome.error;
    this.diagnosticEvents = params.lastOutcome.diagnosticEvents;
    this.retry = params.retry ?? {
      attempts: params.attempts,
      maxAttempts: params.attempts,
      retried: params.attempts > 1,
      exhausted: true,
      totalDelayMs: 0,
      retries: [],
      terminalFailure: params.lastOutcome.retryable ?? null,
      terminalCause: lastCause,
      outcome: "error",
    };
  }
}

export type InvokeDryRunVerdict = "admissible" | "blocked" | "undetermined";

/**
 * Stage names a dry-run trace reports.
 *
 * The first three come from the shared trace vocabulary so a dry run and an
 * `onStep` trace can never name the same stage differently; `verdict` and
 * `fees` are the two stages a dry run adds, which a real invocation has no
 * equivalent of. `broadcast` is excluded on purpose: a dry run must be
 * structurally incapable of reporting it.
 */
export type InvokeDryRunStepName = Exclude<TraceStepName, "broadcast"> | "verdict" | "fees";

/** One completed stage in a dry run. `ok` describes the stage, not policy approval. */
export interface InvokePipelineStep {
  name: InvokeDryRunStepName;
  durationMs: number;
  ok: boolean;
}

/**
 * Full pre-broadcast result from `invoke({ dryRun: true })`.
 *
 * There is intentionally no submission/hash field: dry-run execution cannot
 * enter assembly or `sendTransaction`, so exposing a transaction hash would be
 * false evidence. `fees` is the network estimate when admissible and an
 * explicit zero breakdown when no admissible execution was priced.
 */
export interface InvokeDryRunResult {
  kind: "dry_run";
  admissible: boolean;
  verdict: InvokeDryRunVerdict;
  reason: string | null;
  detail: string | null;
  /** Typed failure for an undetermined verdict; null for admissible/blocked. */
  error: GuardError | null;
  fees: FeeBreakdown;
  diagnostics: unknown[];
  steps: InvokePipelineStep[];
}

/** Configuration for bounded fee bumping when broadcast fails due to minimum fee. */
export interface FeeBumpConfig {
  /**
   * Maximum total broadcast attempts permitted (initial attempt + retries).
   * Default: 3 attempts.
   */
  maxAttempts?: number | undefined;
  /**
   * Multiplier applied to the inclusion fee on each fee-bump retry.
   * Default: 2 (doubles the inclusion fee per attempt).
   */
  feeMultiplier?: number | undefined;
  /**
   * Initial inclusion fee in stroops to use on the first attempt.
   * Default: 100 stroops (`INCLUSION_FEE`).
   */
  initialInclusionFee?: bigint | undefined;
}

export type PipelineOutcome =
  | {
      kind: "allowed";
      submission: SubmissionResult;
      /** Structured retry metadata attached to the terminal outcome. */
      retry?: InvokeRetryMetadata | undefined;
    }
  | {
      kind: "blocked";
      /** Reason symbol from the contract's own event/topic vocabulary. */
      reason: string | null;
      detail: string;
      /** Diagnostic events emitted by the contract during enforced simulation. */
      diagnosticEvents: unknown[];
      /** Present only when policy/account state changed and blocked after inclusion. */
      transactionHash?: string;
      /** True only for a post-broadcast refusal; absent for free preflight blocks. */
      charged?: boolean;
      /** Structured retry metadata attached to the terminal outcome. */
      retry?: InvokeRetryMetadata | undefined;
    }
  | InvokeErrorOutcome
  | InvokeRetryError;

export type InvokeOutcome =
  | InvokeDryRunResult
  | PipelineOutcome
  | BroadcastError;

/** Defaults for the bounded stale-ledger retry policy. */
export const DEFAULT_INVOKE_RETRY_OPTIONS = {
  /** Total attempts, including the first attempt. */
  maxAttempts: 3,
  /** Upper bound used for the first full-jitter delay. */
  baseDelayMs: 100,
  /** Upper bound for every later full-jitter delay. */
  maxDelayMs: 2_000,
} as const;

export interface InvokeRetryOptions {
  /** Total attempts, including the first attempt. Default: 3. */
  maxAttempts?: number;
  /** Base full-jitter window in milliseconds. Default: 100. */
  baseDelayMs?: number;
  /** Maximum full-jitter window in milliseconds. Default: 2,000. */
  maxDelayMs?: number;
  /**
   * RNG used for full jitter; it must return a finite value in `[0, 1)`.
   * Supplying both `random` and `jitter` is rejected as contradictory.
   */
  random?: () => number;
  /** Alias for `random`, useful when describing the jitter strategy. */
  jitter?: () => number;
  /** Sleep implementation, injectable for deterministic tests/custom clocks. */
  sleep?: (delayMs: number) => Promise<void>;
  /** Compatibility alias for `baseDelayMs`. */
  initialDelayMs?: number;
}

export interface InvokePollOptions {
  /** Number of ledger-status polls after a pending broadcast. */
  pollAttempts?: number;
  /** Delay between ledger-status polls. */
  pollIntervalMs?: number;
}

export interface InvokeParams {
  server: rpc.Server;
  /** Classic account that pays the fee and supplies the sequence number. */
  source: Keypair | AdminSigner;
  call: ContractCall;
  networkPassphrase: string;
  /** Present when the call requires the smart account's own authorization. */
  guardAuth?: GuardAuthorization | null | undefined;
  /** Extra classic-account authorizers available to sign (e.g. an admin). */
  accountSigners?: Array<Keypair | AdminSigner> | undefined;
  /** Skip broadcast even if the enforced simulation passes (dry run). */
  dryRun?: boolean | undefined;
  /** Configure bounded full-jitter retries for stale ledger resource limits. */
  retry?: InvokeRetryOptions | undefined;
  pollAttempts?: number | undefined;
  pollIntervalMs?: number | undefined;
  /** Options controlling polling interval and attempts after submission. */
  pollOptions?: { pollAttempts?: number; pollIntervalMs?: number } | undefined;
  /**
   * Optional configuration for fee-bump retry when broadcast hits min-fee.
   * If omitted, defaults to 3 attempts with a 2x fee multiplier. Every field is
   * validated at the public boundary before any RPC, signing or broadcast work.
   */
  feeBump?: FeeBumpConfig | undefined;
  /**
   * Overall maximum retries across retryable classes. If specified, bounds the
   * total attempts across all triggers (so `0` means one attempt). When both
   * this and a per-class budget are supplied, the tighter bound wins.
   */
  maxRetries?: number | undefined;
  /** Custom inclusion fee (used internally during fee-bump retries). */
  fee?: bigint | string | undefined;
  /**
   * Caller-owned cancellation. When aborted, the pipeline stops at the next
   * RPC boundary and `invoke()` returns its `error` outcome carrying an
   * `RpcTimeoutError` (see `RpcTimeoutError` for the local-only cancellation
   * caveat). An already-aborted signal short-circuits before any RPC call.
   */
  signal?: AbortSignal | undefined;
  /**
   * Bound on each individual RPC call, in milliseconds. Defaults to
   * `DEFAULT_RPC_TIMEOUT_MS` (30s); pass `0` to disable the timeout and rely
   * solely on `signal`. A fired timeout produces the same `RpcTimeoutError`
   * outcome as an abort.
   */
  timeoutMs?: number | undefined;
  /**
   * Overall time budget for the whole invocation, in milliseconds, measured
   * from the moment `invoke()` starts. It bounds discovery, signing, enforced
   * simulation, retry backoff, assembly, broadcast and post-submit polling in
   * one budget: each RPC call and each delay consumes the same remaining time.
   *
   * Expiry is fail-closed. It produces an `error` outcome carrying a
   * `RpcTimeoutError` with `deadline: true` (never `allowed`, never a dry run's
   * `admissible`), even when the guard had already approved the call. Omit it
   * to keep the per-call `timeoutMs` behaviour; pass a positive finite number
   * of milliseconds. Cannot be combined with `timeoutMs: 0` into an unbounded
   * pipeline: the deadline still applies.
   */
  deadlineMs?: number | undefined;
  /**
   * Time source used for deadline accounting and poll/backoff delays. Defaults
   * to `systemClock`; inject a `FakeClock` for deterministic time control.
   */
  clock?: Clock | undefined;
  /**
   * Optional, logger-agnostic observability hook: one `InvokeStepEvent` per
   * pipeline-stage attempt, covering probe → sign → simulate → broadcast,
   * including every attempt of the built-in stale-ledger retry. Omitting it
   * leaves `invoke()` exactly as it was before this hook existed; what a
   * consumer does with the events is entirely the consumer's business.
   */
  onStep?: ((step: InvokeStepEvent) => void) | undefined;
  /**
   * Optional hook called **once**, with the network's answer to the
   * broadcast, before any status polling.
   *
   * The transaction hash is the operator's recovery handle: it is what makes a
   * transaction findable on an explorer when the SDK's own polling is slow,
   * times out or fails. This hook publishes it as soon as the server accepts
   * the submission, so a caller can keep it even when the invocation never
   * returns a successful outcome.
   *
   * The event carries `hash: null` when the broadcast response was ambiguous
   * and named no transaction; that submission fails closed rather than being
   * reported as submitted. A throwing hook is isolated and cannot change the
   * outcome.
   */
  onSubmitted?: ((event: SubmissionAcceptedEvent) => void) | undefined;
  /**
   * Optional log sink. Omitted — the default — `invoke()` writes nothing
   * anywhere: no console output, no stdout or stderr, no implicit
   * process-level logger.
   *
   * Supplying one reports the same decision points `onStep` exposes (each stage
   * attempt), plus the retry loop's attempts and the terminal outcome, at
   * levels a host can filter: stage attempts and retries at `debug`, a guard
   * refusal at `info`, anything that ended without a verdict at `warn`.
   *
   * A logger never changes behaviour — outcomes, retry counts and timings are
   * identical with and without one — and a logger that throws is isolated, so
   * a broken sink cannot decide whether a transaction runs.
   */
  logger?: GuardLoggerInput | undefined;
}

/**
 * One pipeline-stage attempt, as reported to `onStep`.
 *
 * `name` comes from the shared trace vocabulary (`TraceStepName`), the same
 * names a dry-run trace uses, so the two can never drift apart. `attempt` is
 * the retry index, 0-based, and is always present: `0` for the first (and
 * usually only) pass over the pipeline, `1` for the built-in stale-ledger
 * re-run — so a consumer never has to special-case its absence.
 */
export interface InvokeStepEvent {
  name: TraceStepName;
  status: TraceStepStatus;
  /**
   * Elapsed wall-clock time of *this* stage attempt, in milliseconds. On
   * `start` it is always `0` — nothing has been timed yet.
   */
  durationMs: number;
  /** 0-based retry index: `0` normally, `1` on the stale-ledger re-run. */
  attempt: number;
}

/** Human-readable rendering of an option value for a field-specific error. */
function describeOptionValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return "function";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  return value === undefined ? "undefined" : String(value);
}

/** Throw a `RangeError` naming the exact option field and its expected shape. */
function rejectOption(field: string, expected: string, value: unknown): never {
  throw new RangeError(`${field} must be ${expected} (received ${describeOptionValue(value)})`);
}

function assertIntegerOption(field: string, value: unknown, minimum: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    rejectOption(field, `a safe integer >= ${minimum}`, value);
  }
}

function assertFiniteOption(
  field: string,
  value: unknown,
  minimum: number,
  inclusive = true,
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (inclusive ? value < minimum : value <= minimum)
  ) {
    rejectOption(
      field,
      `a finite number ${inclusive ? ">=" : ">"} ${minimum}`,
      value,
    );
  }
}

/**
 * Validate every caller-controlled option at the public `invoke()` boundary.
 *
 * This runs first, before the account queue, any signer is invoked, or any RPC
 * request is made, so a `NaN`, a negative delay, a contradictory alias, or a
 * nonsensical fee multiplier fails as a field-specific `RangeError` with zero
 * network calls. The checks are deliberately runtime checks even where the
 * TypeScript type already says the value is a number: JavaScript callers and
 * JSON-derived config objects are not protected by the type system.
 */
function validateInvokeOptions(params: InvokeParams): void {
  const retry = params.retry as InvokeRetryOptions | null | undefined;
  if (retry !== undefined) {
    if (retry === null || typeof retry !== "object") {
      rejectOption("retry", "an object", retry);
    }
    if (retry.maxAttempts !== undefined) {
      assertIntegerOption("retry.maxAttempts", retry.maxAttempts, 1);
    }
    if (retry.baseDelayMs !== undefined) {
      assertFiniteOption("retry.baseDelayMs", retry.baseDelayMs, 0);
    }
    if (retry.initialDelayMs !== undefined) {
      assertFiniteOption("retry.initialDelayMs", retry.initialDelayMs, 0);
    }
    if (retry.maxDelayMs !== undefined) {
      assertFiniteOption("retry.maxDelayMs", retry.maxDelayMs, 0);
    }
    if (
      retry.baseDelayMs !== undefined &&
      retry.initialDelayMs !== undefined &&
      retry.baseDelayMs !== retry.initialDelayMs
    ) {
      rejectOption(
        "retry.initialDelayMs",
        "equal to retry.baseDelayMs when both are provided",
        retry.initialDelayMs,
      );
    }
    const effectiveBaseDelay = retry.baseDelayMs ?? retry.initialDelayMs;
    if (
      effectiveBaseDelay !== undefined &&
      retry.maxDelayMs !== undefined &&
      retry.maxDelayMs < effectiveBaseDelay
    ) {
      rejectOption(
        "retry.maxDelayMs",
        "greater than or equal to retry.baseDelayMs",
        retry.maxDelayMs,
      );
    }
    if (retry.random !== undefined && typeof retry.random !== "function") {
      rejectOption("retry.random", "a function returning a number in [0, 1)", retry.random);
    }
    if (retry.jitter !== undefined && typeof retry.jitter !== "function") {
      rejectOption("retry.jitter", "a function returning a number in [0, 1)", retry.jitter);
    }
    if (retry.random !== undefined && retry.jitter !== undefined) {
      rejectOption("retry.jitter", "omitted when retry.random is provided", retry.jitter);
    }
    if (retry.sleep !== undefined && typeof retry.sleep !== "function") {
      rejectOption("retry.sleep", "a function returning a promise", retry.sleep);
    }
  }

  if (params.maxRetries !== undefined) {
    assertIntegerOption("maxRetries", params.maxRetries, 0);
  }

  const feeBump = params.feeBump as FeeBumpConfig | null | undefined;
  if (feeBump !== undefined) {
    if (feeBump === null || typeof feeBump !== "object") {
      rejectOption("feeBump", "an object", feeBump);
    }
    if (feeBump.maxAttempts !== undefined) {
      assertIntegerOption("feeBump.maxAttempts", feeBump.maxAttempts, 1);
    }
    if (feeBump.feeMultiplier !== undefined) {
      assertFiniteOption("feeBump.feeMultiplier", feeBump.feeMultiplier, 1, false);
    }
    if (feeBump.initialInclusionFee !== undefined) {
      if (
        typeof feeBump.initialInclusionFee !== "bigint" ||
        feeBump.initialInclusionFee <= 0n
      ) {
        rejectOption(
          "feeBump.initialInclusionFee",
          "a positive bigint in stroops",
          feeBump.initialInclusionFee,
        );
      }
    }
  }

  if (params.pollAttempts !== undefined) {
    assertIntegerOption("pollAttempts", params.pollAttempts, 1);
  }
  if (params.pollIntervalMs !== undefined) {
    assertFiniteOption("pollIntervalMs", params.pollIntervalMs, 0);
  }

  const pollOptions = params.pollOptions as
    | { pollAttempts?: number; pollIntervalMs?: number }
    | null
    | undefined;
  if (pollOptions !== undefined) {
    if (pollOptions === null || typeof pollOptions !== "object") {
      rejectOption("pollOptions", "an object", pollOptions);
    }
    if (pollOptions.pollAttempts !== undefined) {
      assertIntegerOption("pollOptions.pollAttempts", pollOptions.pollAttempts, 1);
    }
    if (pollOptions.pollIntervalMs !== undefined) {
      assertFiniteOption("pollOptions.pollIntervalMs", pollOptions.pollIntervalMs, 0);
    }
    if (
      pollOptions.pollAttempts !== undefined &&
      params.pollAttempts !== undefined &&
      pollOptions.pollAttempts !== params.pollAttempts
    ) {
      rejectOption(
        "pollOptions.pollAttempts",
        "equal to pollAttempts when both are provided",
        pollOptions.pollAttempts,
      );
    }
    if (
      pollOptions.pollIntervalMs !== undefined &&
      params.pollIntervalMs !== undefined &&
      pollOptions.pollIntervalMs !== params.pollIntervalMs
    ) {
      rejectOption(
        "pollOptions.pollIntervalMs",
        "equal to pollIntervalMs when both are provided",
        pollOptions.pollIntervalMs,
      );
    }
  }

  if (params.timeoutMs !== undefined) {
    assertFiniteOption("timeoutMs", params.timeoutMs, 0);
  }
  if (params.deadlineMs !== undefined) {
    assertFiniteOption("deadlineMs", params.deadlineMs, 0, false);
  }

  const clock = params.clock as Clock | null | undefined;
  if (clock !== undefined) {
    if (
      clock === null ||
      typeof clock !== "object" ||
      typeof clock.now !== "function" ||
      typeof clock.sleep !== "function"
    ) {
      rejectOption("clock", "an object with now() and sleep()", clock);
    }
  }
}

/**
 * An absolute deadline measured on the invocation's injected clock.
 *
 * `deadlineMs` is a duration, so it is converted once at the start of the call.
 * Every retry, backoff and poll then reads the same absolute instant, which is
 * what makes the budget shared rather than restarted per stage.
 */
interface InvokeDeadline {
  /** Absolute clock time, in milliseconds, at which the budget is spent. */
  readonly at: number;
  /** Milliseconds left; negative once the deadline has passed. */
  remainingMs(): number;
  /** True at or after the deadline instant. */
  expired(): boolean;
}

function makeDeadline(params: InvokeParams, clock: Clock): InvokeDeadline | undefined {
  if (params.deadlineMs === undefined) return undefined;
  const at = clock.now() + params.deadlineMs;
  return {
    at,
    remainingMs: () => at - clock.now(),
    expired: () => clock.now() >= at,
  };
}

/** The fail-closed error for a spent overall deadline. */
function deadlineTimeout(stage: string): RpcTimeoutError {
  return new RpcTimeoutError({ stage, aborted: false, deadline: true });
}

function assertWithinDeadline(deadline: InvokeDeadline | undefined, stage: string): void {
  if (deadline !== undefined && deadline.remainingMs() <= 0) {
    throw deadlineTimeout(stage);
  }
}

/**
 * Bound the outer RPC race by the smaller of the per-call timeout and the
 * overall deadline. `timeoutMs: 0` disables the per-call bound but never the
 * deadline, so an opt-out of one cannot silently opt out of the other.
 */
function outerRpcTimeout(
  params: InvokeParams,
  deadline: InvokeDeadline | undefined,
): number | undefined {
  if (deadline === undefined) return params.timeoutMs;
  const remaining = deadline.remainingMs();
  if (remaining <= 0) return 0;
  const perCall = params.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  return perCall === 0 ? remaining : Math.min(perCall, remaining);
}

function resolvePollOptions(params: InvokeParams): {
  pollAttempts?: number;
  pollIntervalMs?: number;
} {
  const pollAttempts = params.pollOptions?.pollAttempts ?? params.pollAttempts;
  const pollIntervalMs = params.pollOptions?.pollIntervalMs ?? params.pollIntervalMs;
  return {
    ...(pollAttempts !== undefined ? { pollAttempts } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  };
}

function resolveFeeBumpOptions(params: InvokeParams): {
  maxAttempts: number;
  feeMultiplier: number;
  initialInclusionFee: bigint;
} {
  const requested = params.feeBump?.maxAttempts ?? 3;
  const overall = params.maxRetries !== undefined ? params.maxRetries + 1 : Number.POSITIVE_INFINITY;
  return {
    maxAttempts: Math.max(1, Math.min(requested, overall)),
    feeMultiplier: params.feeBump?.feeMultiplier ?? 2,
    initialInclusionFee: params.feeBump?.initialInclusionFee ?? BigInt(INCLUSION_FEE),
  };
}

/**
 * Emit one step event to the caller's `onStep` callback.
 *
 * The callback is the caller's, and it is not routed anywhere: a `logger` is a
 * separate sink, so a throwing callback is swallowed and the pipeline carries
 * on: observability must never decide whether a transaction runs. Two cases matter. A callback throw on the happy
 * path must not turn a successful stage into a failed one. And when the stage
 * itself failed, the original error must survive untouched: swallowing here
 * means the callback's error simply vanishes, and `invoke()` rethrows the real
 * pipeline error — never a callback error wearing its clothes.
 */
function emitStep(
  hook: ((step: InvokeStepEvent) => void) | undefined,
  event: InvokeStepEvent,
): void {
  if (!hook) return;
  try {
    hook(event);
  } catch {
    /* a broken consumer must not break the pipeline */
  }
}

/**
 * The stage hook the pipeline actually uses: the caller's `onStep` and, when a
 * logger was injected, a `debug` line for the same event.
 *
 * Returns `undefined` when neither sink is supplied, which is what keeps the
 * default path free of timing work: `withStepTiming` runs the stage directly
 * on `undefined`, adding no timers and emitting nothing. The two sinks are
 * independent — a host may supply either, both, or neither — and a logger is
 * compared against `SILENT_LOGGER` by identity so a caller that passed no
 * logger is not taxed for a sink that writes nothing.
 */
function stepHook(
  hook: ((step: InvokeStepEvent) => void) | undefined,
  logger: GuardLogger,
): ((step: InvokeStepEvent) => void) | undefined {
  const logs = logger !== SILENT_LOGGER;
  if (!hook && !logs) return undefined;
  return (step: InvokeStepEvent): void => {
    emitStep(hook, step);
    if (logs) {
      logger.debug(`pipeline step ${step.name} ${step.status}`, {
        step: step.name,
        status: step.status,
        durationMs: step.durationMs,
        attempt: step.attempt,
      });
    }
  };
}

/**
 * Time one stage attempt, emitting `start` before it runs and `ok` or `fail`
 * with the attempt's own elapsed time after it settles. `ok` means the stage
 * passed; `fail` covers both a thrown error and — via the optional `failed`
 * classifier — a response the pipeline treats as that stage failing (a
 * simulation-error response, a submission that never made it into a ledger).
 * Returns the stage's value and rethrows its error untouched; the `fail`
 * callback throwing only loses the callback's error, never the stage's. With
 * no hook, the stage runs directly — no timers, no events, no work added to
 * the default path.
 */
async function withStepTiming<T>(
  hook: ((step: InvokeStepEvent) => void) | undefined,
  params: { name: TraceStepName; attempt: number },
  run: () => Promise<T>,
  failed?: (value: T) => boolean,
): Promise<T> {
  if (!hook) return run();
  emitStep(hook, { name: params.name, status: "start", durationMs: 0, attempt: params.attempt });
  const startedAt = performance.now();
  try {
    const value = await run();
    emitStep(hook, {
      name: params.name,
      status: failed?.(value) ? "fail" : "ok",
      durationMs: performance.now() - startedAt,
      attempt: params.attempt,
    });
    return value;
  } catch (error) {
    emitStep(hook, {
      name: params.name,
      status: "fail",
      durationMs: performance.now() - startedAt,
      attempt: params.attempt,
    });
    throw error;
  }
}

/**
 * Internal signal that the signing stage refused an authorization shape.
 *
 * Carries the exact detail text the pipeline has always reported plus the
 * typed failure the caller should branch on. `enforceCall` converts it back to
 * an `error` outcome so a shape refusal stays a result, while still giving the
 * `sign` stage a real `fail` event on the way through.
 */
class SigningStageError extends Error {
  readonly detail: string;
  readonly guardError: GuardError;

  constructor(detail: string, guardError: GuardError) {
    super(detail);
    this.name = "SigningStageError";
    this.detail = detail;
    this.guardError = guardError;
  }
}

/** Alias matching the terminology used by the README API reference. */
export type InvokeOptions = InvokeParams;

/**
 * Topic symbols of a contract event, tolerating the several shapes RPC and the
 * SDK use for the same event: decoded `xdr.DiagnosticEvent` instances, bare
 * event objects, or base64 XDR strings in a JSON error payload.
 *
 * Exported because a telemetry consumer needs the same tolerance to read a
 * guard decision out of either stream, and duplicating the shape-handling would
 * mean two places to get it wrong.
 */
export function topicSymbols(raw: unknown): string[] {
  const candidate = raw as {
    event?: { body?: unknown };
    body?: unknown;
  };
  const body = (candidate.event?.body ?? candidate.body) as
    | { v0?: { topics?: unknown[] }; value?: { v0?: { topics?: unknown[] } } }
    | undefined;
  const topics = body?.v0?.topics ?? body?.value?.v0?.topics;
  if (!Array.isArray(topics)) return [];
  return topics.flatMap((topic) => {
    try {
      if (typeof topic === "string") {
        return [String(scValToNative(xdr.ScVal.fromXDR(topic, "base64")))];
      }
      return [String(scValToNative(topic as xdr.ScVal))];
    } catch {
      return [];
    }
  });
}

/**
 * Extract the contract's own block reason from a simulation failure.
 *
 * The RPC error string is not the contract's reason vocabulary, but the
 * diagnostic events bundled with the failure are: the guard publishes
 * `topics = [event_auth_checked, blocked, <reason>]` on every decision,
 * including decisions taken inside an enforced simulation. Note the `event_`
 * prefix — see `events.ts` for why the live topic differs from the docs' name.
 *
 * A *blocked* decision is only ever observed here, as a diagnostic: the guard
 * returns `Err`, which rolls the event back, so it never reaches a ledger.
 */
export function reasonFromDiagnosticEvents(events: unknown[]): string | null {
  for (const event of events) {
    const decision = decodeAuthDecision(topicSymbols(event), "diagnostic");
    if (decision?.result === GUARD_AUTH_RESULTS.blocked && decision.reason) {
      return decision.reason;
    }
  }
  return null;
}

/**
 * Diagnostic events attached to a failed simulation, if the RPC supplied any.
 * Both the top-level `events` field and the nested error payload are checked:
 * which one carries them varies by failure kind.
 */
/**
 * Payload of an address-bound credential, for either arm.
 *
 * The two arms name their payload differently (`address` for legacy, `addressV2`
 * for CAP-71's address-bound form), which mirrors the SDK's own internal
 * `getAddressCredentials` switch.
 */
function addressCredentialsOf(
  credentials: xdr.SorobanCredentials,
): xdr.SorobanAddressCredentials | null {
  if (credentials.type === "sorobanCredentialsAddress") {
    return credentials.address;
  }
  if (credentials.type === "sorobanCredentialsAddressV2") {
    return credentials.addressV2;
  }
  return null;
}

function diagnosticEventsOf(response: unknown): unknown[] {
  const candidate = response as {
    events?: unknown;
    error?: { data?: { events?: unknown } };
  };
  for (const value of [candidate.events, candidate.error?.data?.events]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

/**
 * The authorization entries a recording-mode probe asked for, read strictly.
 *
 * RPC hands these back as decoded objects, but the same payload can arrive from
 * a proxy, a fixture, or a host that reports a different JSON shape. Every
 * downstream step assumes a well-formed entry, so a malformed one is rejected
 * here with a typed `ContractResponseError` naming the exact field rather than
 * surfacing later as a `TypeError` that says nothing about which response was
 * bad. An absent `auth` is legitimate and means "nothing to sign".
 */
function requiredAuthorizationEntries(
  response: unknown,
): xdr.SorobanAuthorizationEntry[] {
  const result = (response as { result?: unknown }).result;
  if (result !== undefined && (result === null || typeof result !== "object")) {
    throw new ContractResponseError("simulation result is not an object", {
      field: "result",
    });
  }
  const auth = (result as { auth?: unknown } | undefined)?.auth;
  if (auth === undefined) return [];
  if (!Array.isArray(auth)) {
    throw new ContractResponseError("simulation result.auth is not an array", {
      field: "result.auth",
    });
  }
  return auth.map((entry, index) => {
    const credentials = (entry as { credentials?: unknown } | null)?.credentials;
    if (
      entry === null ||
      typeof entry !== "object" ||
      credentials === null ||
      typeof credentials !== "object" ||
      typeof (credentials as { type?: unknown }).type !== "string"
    ) {
      throw new ContractResponseError(
        `simulation result.auth[${index}] has no credential payload`,
        { field: `result.auth[${index}].credentials` },
      );
    }
    return entry as xdr.SorobanAuthorizationEntry;
  });
}

interface ResolvedRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random: () => number;
  sleep: (delayMs: number) => Promise<void>;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function resolveRetryOptions(options: InvokeRetryOptions | undefined): ResolvedRetryOptions {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_INVOKE_RETRY_OPTIONS.maxAttempts;
  const baseDelayMs =
    options?.baseDelayMs ??
    options?.initialDelayMs ??
    DEFAULT_INVOKE_RETRY_OPTIONS.baseDelayMs;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_INVOKE_RETRY_OPTIONS.maxDelayMs;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`retry.maxAttempts must be an integer >= 1 (received ${maxAttempts})`);
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError(`retry.baseDelayMs must be finite and >= 0 (received ${baseDelayMs})`);
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new RangeError(`retry.maxDelayMs must be finite and >= 0 (received ${maxDelayMs})`);
  }

  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    random: options?.random ?? options?.jitter ?? Math.random,
    sleep: options?.sleep ?? defaultSleep,
  };
}

/**
 * Full-jitter delay for the retry after `attempt` has failed.
 *
 * The exponential value is only the window: multiplying it by an independent
 * random sample spreads agents that observed the same ledger pressure instead
 * of releasing them in a synchronized thundering herd.
 */
function fullJitterDelay(attempt: number, options: ResolvedRetryOptions): number {
  const window = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const sample = options.random();
  // A custom RNG must return [0, 1). Clamping a bad value would hide a
  // misconfigured source and could silently disable the intended distribution;
  // fail with the field named instead, before the retry sleeps or any further
  // RPC is made.
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError(
      `retry.random must return a finite value in [0, 1) (received ${describeOptionValue(sample)})`,
    );
  }
  return Math.floor(window * sample);
}

/**
 * Run one contract call through simulate → sign → enforce, submitting only on a
 * pass. Returns a discriminated result rather than throwing, so callers can
 * decide whether a block is an expected outcome (agents hitting a guardrail) or
 * a failure worth surfacing.
 *
 * The whole invocation, submission included, is serialized per source account
 * so two concurrent calls can never build from the same account sequence.
 *
 * With `dryRun`, the pipeline stops after the enforced simulation and returns a
 * structured {@link InvokeDryRunResult} instead of an `invoke()` outcome: no
 * transaction is ever assembled, signed for broadcast, or submitted, so there is
 * no hash to report and nothing was charged.
 *
 * Stale-ledger resource failures and sequence-number collisions are retried
 * with bounded full-jitter backoff. Every attempt starts a fresh invocation
 * pipeline, including discovery and enforced simulation, so the resource
 * declaration is always priced against current ledger state. Non-retryable
 * outcomes return immediately and never sleep. When the budget is exhausted,
 * the returned `InvokeRetryError` carries the attempt count and the last retry
 * cause.
 */
type AccountState = {
  queue: Promise<void>;
  lastReservedSequence?: bigint;
};

const accountStates = new WeakMap<object, Map<string, AccountState>>();

function accountStateFor(server: rpc.Server, publicKey: string): AccountState {
  let states = accountStates.get(server);
  if (!states) {
    states = new Map<string, AccountState>();
    accountStates.set(server, states);
  }
  let state = states.get(publicKey);
  if (!state) {
    state = { queue: Promise.resolve() };
    states.set(publicKey, state);
  }
  return state;
}

/**
 * Serialize invoke() for one source account, including its submission.
 *
 * The queue is scoped to the RPC server object as well as the account key: the
 * same account can have an unrelated sequence on a different network/server.
 * A rejected task releases the queue in `finally`, so one failed transaction
 * cannot strand all later calls.
 */
async function withAccountQueue<T>(
  server: rpc.Server,
  publicKey: string,
  task: () => Promise<T>,
): Promise<T> {
  const state = accountStateFor(server, publicKey);
  const previous = state.queue;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.queue = current;
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (state.queue === current) state.queue = Promise.resolve();
  }
}

/**
 * Reserve a sequence number for an account.
 *
 * The RPC snapshot can remain one transaction behind immediately after a
 * successful broadcast (and test doubles commonly do). Remember the last
 * reservation and advance past it when the next fetch is not newer. This also
 * makes the reservation safe when `enforceCall` is used directly, while the
 * invoke queue still guarantees fetch → build → submit ordering.
 */
function reserveNextSequence(
  server: rpc.Server,
  publicKey: string,
  fetchedSequence: string,
): string {
  const state = accountStateFor(server, publicKey);
  const fetched = BigInt(fetchedSequence);
  const next =
    state.lastReservedSequence !== undefined && state.lastReservedSequence >= fetched
      ? state.lastReservedSequence + 1n
      : fetched;
  state.lastReservedSequence = next;
  return next.toString();
}

export function invoke(params: InvokeParams & { dryRun: true }): Promise<InvokeDryRunResult>;
export function invoke(
  params: InvokeParams & { dryRun?: false },
): Promise<Exclude<InvokeOutcome, InvokeDryRunResult>>;
export function invoke(params: InvokeParams): Promise<InvokeOutcome>;
export async function invoke(params: InvokeParams): Promise<InvokeOutcome> {
  // The public boundary: every option is validated before the account queue,
  // signing or any RPC. A bad option is a field-specific RangeError, not an
  // `undetermined` outcome produced after a wasted simulation.
  validateInvokeOptions(params);

  const clock = params.clock ?? systemClock;
  const deadline = makeDeadline(params, clock);
  if (deadline !== undefined && deadline.expired()) {
    return timeoutOutcome(deadlineTimeout("invoke"));
  }

  // A dry run performs exactly one pass: it never reaches broadcast, so there
  // is no stale-ledger rejection to retry, no sleep to justify, and nothing to
  // serialize against the account queue. The same deadline and per-call bound
  // still apply, and expiry is reported as an `undetermined` dry run.
  if (params.dryRun) {
    try {
      return await withRpcAbort(
        {
          stage: "invoke",
          signal: params.signal,
          timeoutMs: outerRpcTimeout(params, deadline),
        },
        () => invokeDryRun(params, deadline, clock),
      );
    } catch (error) {
      if (error instanceof RpcTimeoutError) return dryRunTimeoutResult(error);
      throw error;
    }
  }

  try {
    // Every RPC the pipeline makes sits inside this bound: an already-aborted
    // signal short-circuits before the account is looked up, and a mid-flight
    // abort or a fired timeout rejects promptly with `RpcTimeoutError`.
    return await withRpcAbort(
      {
        stage: "invoke",
        signal: params.signal,
        // With a deadline, the outer race is the smaller of the per-call bound
        // and the time left; `timeoutMs: 0` disables only the former.
        timeoutMs: outerRpcTimeout(params, deadline),
      },
      () => invokeWithQueue(params, deadline, clock),
    );
  } catch (error) {
    if (error instanceof RpcTimeoutError) {
      // A bound that fired is a fail-closed *decision*, not a crash: the guard
      // never reached a verdict, which is exactly the `error` arm's meaning.
      return timeoutOutcome(error);
    }
    throw error;
  }
}

/**
 * Build the additive retry record once, so the outcome, the typed error and the
 * logger all describe the same attempts. Only numbers, attempt indexes and
 * retryable-class names are copied — never details, XDR, hashes or diagnostics.
 */
function retryMetadata(params: {
  attempts: number;
  maxAttempts: number;
  retries: readonly InvokeRetryAttempt[];
  totalDelayMs: number;
  exhausted: boolean;
  outcome: "allowed" | "blocked" | "error";
  terminalFailure: RetryableInvokeFailure | null;
  terminalCause: InvokeErrorCause | null;
}): InvokeRetryMetadata {
  return {
    attempts: params.attempts,
    maxAttempts: params.maxAttempts,
    retried: params.retries.length > 0,
    exhausted: params.exhausted,
    totalDelayMs: params.totalDelayMs,
    retries: params.retries.map((attempt) => ({ ...attempt })),
    terminalFailure: params.terminalFailure,
    terminalCause: params.terminalCause,
    outcome: params.outcome,
  };
}

async function invokeWithQueue(
  params: InvokeParams,
  deadline: InvokeDeadline | undefined,
  clock: Clock,
): Promise<InvokeOutcome> {
  const sourceKey = await params.source.publicKey();
  return withAccountQueue(params.server, sourceKey, async () => {
    const retry = resolveRetryOptions(params.retry);
    const logger = resolveLogger(params.logger);
    const poll = resolvePollOptions(params);
    const feeOptions = resolveFeeBumpOptions(params);
    const generalMaxAttempts = Math.min(
      retry.maxAttempts,
      params.maxRetries !== undefined ? params.maxRetries + 1 : Number.POSITIVE_INFINITY,
    );
    let currentInclusionFee = feeOptions.initialInclusionFee;

    let feeAttempt = 0;
    let generalAttempt = 0;
    const retries: InvokeRetryAttempt[] = [];
    let totalDelayMs = 0;

    const metadata = (
      outcome: "allowed" | "blocked" | "error",
      terminalFailure: RetryableInvokeFailure | null,
      terminalCause: InvokeErrorCause | null,
      exhausted: boolean,
      maxAttempts: number = generalMaxAttempts,
    ): InvokeRetryMetadata =>
      retryMetadata({
        attempts: generalAttempt,
        maxAttempts,
        retries,
        totalDelayMs,
        exhausted,
        outcome,
        terminalFailure,
        terminalCause,
      });

    const deadlineErrorOutcome = (error: RpcTimeoutError): InvokeErrorOutcome => ({
      ...timeoutOutcome(error),
      retry: metadata("error", null, null, false),
    });

    try {
      while (true) {
        assertWithinDeadline(deadline, "probe");
        generalAttempt += 1;
        feeAttempt += 1;
        // `attempt` is the 0-based index `onStep` reports; `attempts` is the count.
        const outcome = await invokePipeline(params, generalAttempt - 1, {
          inclusionFee: currentInclusionFee,
          deadline,
          clock,
          poll,
        });

        if (outcome.kind !== "error" || outcome.retryable === undefined) {
          const terminal = outcome.kind === "error" ? outcome : null;
          const enriched = {
            ...outcome,
            retry: metadata(
              outcome.kind,
              terminal?.retryable ?? null,
              terminal?.cause ?? null,
              false,
            ),
          } as PipelineOutcome;
          logTerminalOutcome(logger, enriched);
          return enriched;
        }

        if (outcome.retryable === "min_fee") {
          if (feeAttempt < feeOptions.maxAttempts) {
            retries.push({
              attempt: generalAttempt,
              failure: "min_fee",
              cause: RETRYABLE_CAUSES.min_fee,
              delayMs: 0,
            });
            const bumped = BigInt(
              Math.ceil(Number(currentInclusionFee) * feeOptions.feeMultiplier),
            );
            currentInclusionFee = bumped > currentInclusionFee ? bumped : currentInclusionFee + 100n;
            continue;
          }

          const broadcastError = new BroadcastError({
            attempts: feeAttempt,
            lastFee: outcome.lastFee ?? currentInclusionFee,
            failure: outcome.submission?.failure ?? {
              resultXdr: null,
              resultCode: "result=txInsufficientFee",
              message: outcome.detail,
              diagnosticEvents: [],
            },
            detail: outcome.detail,
            retry: metadata(
              "error",
              "min_fee",
              RETRYABLE_CAUSES.min_fee,
              true,
              feeOptions.maxAttempts,
            ),
          });
          return broadcastError;
        }

        if (generalAttempt >= generalMaxAttempts) {
          logger.warn(`invoke retry budget exhausted after ${generalAttempt} attempt(s)`, {
            attempts: generalAttempt,
            maxAttempts: generalMaxAttempts,
            retryable: outcome.retryable,
          });
          return new InvokeRetryError({
            attempts: generalAttempt,
            lastOutcome: outcome,
            retry: metadata(
              "error",
              outcome.retryable,
              RETRYABLE_CAUSES[outcome.retryable],
              true,
            ),
          });
        }

        const delay = fullJitterDelay(generalAttempt, retry);
        const remaining = deadline?.remainingMs();
        if (remaining !== undefined && remaining <= 0) {
          return deadlineErrorOutcome(deadlineTimeout("retry_backoff"));
        }
        // The backoff consumes the same budget as the RPC calls: never sleep
        // past the deadline, and if the bounded sleep reaches it, fail closed.
        const sleepMs = remaining === undefined ? delay : Math.min(delay, remaining);
        logger.debug(
          `retrying invoke after a retryable failure (attempt ${generalAttempt} of ${generalMaxAttempts})`,
          {
            attempt: generalAttempt,
            maxAttempts: generalMaxAttempts,
            retryable: outcome.retryable,
            delayMs: sleepMs,
          },
        );
        retries.push({
          attempt: generalAttempt,
          failure: outcome.retryable,
          cause: RETRYABLE_CAUSES[outcome.retryable],
          delayMs: sleepMs,
        });
        totalDelayMs += sleepMs;
        const sleep = params.retry?.sleep ?? ((delayMs: number) => clock.sleep(delayMs));
        await sleep(sleepMs);
        if (deadline?.expired()) {
          return deadlineErrorOutcome(deadlineTimeout("retry_backoff"));
        }
      }
    } catch (error) {
      if (error instanceof RpcTimeoutError) return deadlineErrorOutcome(error);
      throw error;
    }
  });
}

/**
 * Report a terminal pipeline outcome at the level its severity deserves.
 *
 * Terminal means "this is the answer the caller is about to receive". A failure
 * the retry loop is still going to retry is announced by the loop's own retry
 * line instead, so one failure is never reported twice and a retry that
 * eventually succeeds does not leave a warning behind.
 */
function logTerminalOutcome(logger: GuardLogger, outcome: InvokeOutcome): void {
  // Unreachable from `invoke()` — a dry run returns before the retry loop — but
  // the outcome union is shared, and a dry run is not a submission to report.
  if (outcome.kind === "dry_run") return;
  if (outcome.kind === "blocked") {
    logger.info(`guard refused the call (${outcome.reason ?? "unstated"})`, {
      reason: outcome.reason,
      // A post-broadcast refusal was charged; a pre-broadcast one was free, and
      // that distinction is the whole point of the pipeline order.
      charged: outcome.charged === true,
      transactionHash: outcome.transactionHash ?? null,
    });
    return;
  }
  if (outcome.kind === "error") {
    logger.warn(`invoke ended without a verdict: ${outcome.detail}`, {
      cause: outcome.cause ?? null,
    });
    return;
  }
  logger.debug("call admitted and submitted", {
    transactionHash: outcome.submission?.hash ?? null,
  });
}

/**
 * `probe → sign → simulate → verdict → fees`, then stop before assembly.
 *
 * The first three stages are the real pipeline, instrumented through the same
 * `onStep` hook an ordinary invocation uses, so a dry run's trace and a live
 * invocation's trace are the same measurement of the same code. The last two
 * are local to this function: classifying the guard's answer, and pricing it.
 */
function dryRunTimeoutResult(error: RpcTimeoutError): InvokeDryRunResult {
  return {
    kind: "dry_run",
    admissible: false,
    verdict: "undetermined",
    reason: null,
    detail: error.message,
    error,
    fees: {
      resourceFeeStroops: 0n,
      inclusionFeeStroops: 0n,
      totalFeeStroops: 0n,
    },
    diagnostics: [],
    steps: [],
  };
}

async function invokeDryRun(
  params: InvokeParams,
  deadline: InvokeDeadline | undefined,
  clock: Clock,
): Promise<InvokeDryRunResult> {
  const steps: InvokePipelineStep[] = [];
  const observer = params.onStep;
  let enforced: EnforcementOutcome;
  try {
    enforced = await enforceCall(
      {
        ...params,
        onStep: (event) => {
          // A dry run can never reach broadcast, so a broadcast stage is a bug
          // rather than a stage to report. Dropping it here keeps that guarantee
          // in the trace itself, not just in the control flow.
          if (event.status !== "start" && event.name !== "broadcast") {
            steps.push({
              name: event.name,
              durationMs: event.durationMs,
              ok: event.status === "ok",
            });
          }
          observer?.(event);
        },
      },
      0,
      { deadline, clock },
    );
  } catch (error) {
    if (error instanceof RpcTimeoutError) return dryRunTimeoutResult(error);
    throw error;
  }
  const verdictStartedAt = performance.now();

  let verdict: InvokeDryRunVerdict =
    enforced.kind === "admissible" ? "admissible" : enforced.kind === "blocked" ? "blocked" : "undetermined";
  const reason: string | null = enforced.kind === "blocked" ? enforced.reason : null;
  let detail: string | null =
    enforced.kind === "error" || enforced.kind === "blocked" ? enforced.detail : null;
  let error: GuardError | null = enforced.kind === "error" ? enforced.error : null;
  const diagnostics: unknown[] =
    enforced.kind === "blocked" || enforced.kind === "error"
      ? enforced.diagnosticEvents
      : diagnosticEventsOf(enforced.simulation);
  let resourceFee = 0n;
  let feesOk = true;

  if (enforced.kind === "admissible") {
    try {
      resourceFee = parseSimulationResourceFee(enforced.simulation.minResourceFee, {
        stage: "simulate",
      });
    } catch (cause) {
      // The guard approved, but the network's own price for it is unusable.
      // Reporting `admissible` here would hand the caller a fee figure that
      // never came from the host, so the verdict degrades to undetermined.
      verdict = "undetermined";
      detail = `enforced simulation succeeded but returned an invalid resource fee: ${
        cause instanceof Error ? cause.message : String(cause)
      }`;
      error =
        cause instanceof GuardError
          ? cause
          : new SimulationError("enforced simulation returned an invalid resource fee", {
              stage: "simulate",
              cause,
            });
      feesOk = false;
    }
  }
  const verdictDurationMs = Math.max(0, performance.now() - verdictStartedAt);

  const feesStartedAt = performance.now();
  const fees: FeeBreakdown =
    verdict === "admissible"
      ? feeBreakdown(resourceFee)
      : {
          resourceFeeStroops: 0n,
          inclusionFeeStroops: 0n,
          totalFeeStroops: 0n,
        };
  const feesDurationMs = Math.max(0, performance.now() - feesStartedAt);
  // The pipeline stages above are the three `enforceCall` produced; append the
  // two local ones so all five stages are in one ordered trace.
  steps.push(
    { name: "verdict", durationMs: verdictDurationMs, ok: enforced.kind !== "error" },
    { name: "fees", durationMs: feesDurationMs, ok: feesOk },
  );

  return {
    kind: "dry_run",
    admissible: verdict === "admissible",
    verdict,
    reason,
    detail,
    error,
    fees,
    diagnostics,
    steps,
  };
}

/**
 * The outcome of steps 1–3: the guard has been asked, and answered.
 *
 * `admissible` means the enforced simulation ran the real `__check_auth` against
 * live ledger state and it passed. It is separated from submission so the
 * pre-flight interceptor can ask the same question without broadcasting
 * anything — one implementation of the enforcement question, two callers.
 */
export type EnforcementOutcome =
  | {
      kind: "admissible";
      /** The successful enforced simulation, carrying real resource pricing. */
      simulation: rpc.Api.SimulateTransactionSuccessResponse;
      /** The operation with signed authorizations attached, ready to assemble. */
      operation: xdr.Operation;
      /** Base sequence number for building the submitting envelope. */
      nextSeq: string;
    }
  | {
      kind: "blocked";
      reason: string;
      detail: string;
      diagnosticEvents: unknown[];
    }
  | {
      kind: "error";
      detail: string;
      error: GuardError;
      diagnosticEvents: unknown[];
    };

/** One attempt: simulate → sign → enforce → submit. No retry logic lives here. */
async function invokePipeline(
  params: InvokeParams,
  attempt: number,
  options?: {
    inclusionFee?: bigint | undefined;
    deadline?: InvokeDeadline | undefined;
    clock?: Clock | undefined;
    poll?: { pollAttempts?: number; pollIntervalMs?: number };
  },
): Promise<PipelineOutcome> {
  const { server } = params;
  const onStep = stepHook(params.onStep, resolveLogger(params.logger));
  const enforced = await enforceCall(
    {
      ...params,
      ...(options?.inclusionFee !== undefined ? { fee: options.inclusionFee } : {}),
    },
    attempt,
    { deadline: options?.deadline, clock: options?.clock },
  );
  if (enforced.kind === "error") {
    // The guard never made a decision, so this is `undetermined` and not
    // `blocked`. Classify it here, at the point the failure is produced, so
    // every consumer sees a cause without having to re-derive it.
    return {
      ...enforced,
      cause: INVOKE_ERROR_CAUSES.undetermined,
    };
  }
  if (enforced.kind !== "admissible") return enforced;

  // The guard may have approved just as the budget ran out. Approval is not an
  // admissible result for the *invocation*: assembly, signing and broadcast
  // would all happen outside the caller's deadline, so fail closed instead.
  assertWithinDeadline(options?.deadline, "broadcast");

  // ── Step 4: assemble real resources, sign the envelope, broadcast ─────
  const sourcePubKey = await params.source.publicKey();
  let assembled: ReturnType<typeof assembleFromSimulation>;
  try {
    assembled = assembleFromSimulation({
      simulation: enforced.simulation,
      // A fresh `Account` per build: `TransactionBuilder` advances the sequence of
      // the instance it is handed, so sharing one across builds silently produces
      // `tx_bad_seq`.
      source: new Account(sourcePubKey, enforced.nextSeq),
      operation: enforced.operation,
      networkPassphrase: params.networkPassphrase,
      guard: params.guardAuth?.guard ?? null,
      ...(options?.inclusionFee !== undefined ? { inclusionFee: options.inclusionFee } : {}),
    });
  } catch (cause) {
    // The enforced simulation passed, so a failure to turn its result into a
    // transaction is a defect in construction — never a guardrail deciding.
    const detail = `transaction assembly failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    return {
      kind: "error",
      detail,
      // A malformed simulation is reported with the SDK's own typed error, so
      // the field that was wrong (`minResourceFee`) and the stage that read it
      // survive to the caller instead of being flattened into a generic
      // simulation failure — or, worse, escaping as a native conversion error.
      error:
        cause instanceof ContractResponseError
          ? cause
          : new SimulationError("could not assemble transaction from enforced simulation", {
              stage: "simulate",
              cause,
            }),
      diagnosticEvents: [],
    };
  }

  let submission: SubmissionResult;
  const poll = options?.poll ?? resolvePollOptions(params);
  const signers: Array<Keypair | AdminSigner> = [
    params.source,
    ...(params.accountSigners ?? []),
  ];

  assertWithinDeadline(options?.deadline, "broadcast");
  try {
    submission = await withStepTiming(
      onStep,
      { name: "broadcast", attempt },
      () =>
        submitAndPoll(server, assembled.transaction, signers, {
          pollAttempts: poll.pollAttempts,
          pollIntervalMs: poll.pollIntervalMs,
          clock: options?.clock,
          deadlineAt: options?.deadline?.at,
          // The hash is published the moment the network accepts the
          // submission, so a caller can keep it even when the polling that
          // follows fails or runs out of budget.
          ...(params.onSubmitted ? { onSubmitted: params.onSubmitted } : {}),
        }),
      (result) => result.failure !== null,
    );
  } catch (error) {
    if (error instanceof RpcTimeoutError) throw error;
    const typed =
      error instanceof GuardError ? error : new BroadcastError(String(error), { cause: error });
    return {
      kind: "error",
      detail: typed.message,
      error: typed,
      diagnosticEvents: [],
      // The transaction was broadcast before the failure, so its hash is the
      // caller's recovery handle: a poll that failed, a transport error or an
      // ambiguous broadcast must not take it away.
      ...(typed instanceof BroadcastError && typed.transactionHash
        ? { transactionHash: typed.transactionHash }
        : {}),
    };
  }
  if (submission.deadlineExceeded) {
    // The transaction may still land; the caller's budget is nevertheless spent,
    // and reporting that as a normal broadcast failure would invite a retry the
    // deadline was meant to prevent. The hash travels with the error, so the
    // caller can still look the transaction up.
    throw new RpcTimeoutError({
      stage: "poll",
      aborted: false,
      deadline: true,
      transactionHash: submission.hash,
    });
  }
  if (submission.failure) {
    // A post-broadcast rejection is a hard error, not a policy block: the
    // enforced simulation already passed, so anything here is a defect in
    // construction (sequence, fee, footprint) or a contract trap — never a
    // guardrail doing its job.
    const detail = `tx ${submission.hash} ${describeSubmissionFailure(submission.failure)}`;
    const events = submission.failure.diagnosticEvents;
    // One exception, and it is a real one: the guard can refuse *after*
    // inclusion, when policy or account state has already moved. That is
    // still the guard refusing, so it stays a `blocked` outcome — carrying the
    // real hash and `charged`, because the caller did pay for the attempt.
    const reason = reasonFromDiagnosticEvents(events);
    if (reason !== null) {
      return {
        kind: "blocked",
        reason,
        detail,
        diagnosticEvents: events,
        transactionHash: submission.hash,
        charged: true,
      };
    }
    const isMinFee = isMinimumFeeBroadcastFailure(submission.failure);
    const staleLedger = !isMinFee && isStaleLedgerResourceFailure(submission.failure);
    // A sequence collision is only expected when something outside this queue
    // broadcasts for the same account; inside the queue it means the RPC
    // snapshot lagged further than the per-account reservation assumed.
    const sequenceCollision = !isMinFee && !staleLedger && isSequenceNumberFailure(submission.failure);
    return {
      kind: "error",
      detail,
      error: new BroadcastError(detail, { transactionHash: submission.hash }),
      diagnosticEvents: events,
      // The transaction was included and then rejected: the hash is how the
      // caller finds it on-chain.
      transactionHash: submission.hash,
      cause: staleLedger
        ? INVOKE_ERROR_CAUSES.staleLedgerResourceLimit
        : sequenceCollision
          ? INVOKE_ERROR_CAUSES.sequenceNumberCollision
          : INVOKE_ERROR_CAUSES.undetermined,
      ...(staleLedger
        ? { retryable: "stale_ledger_resource_limit" as const }
        : sequenceCollision
          ? { retryable: "sequence_number_collision" as const }
          : isMinFee
            ? { retryable: "min_fee" as const }
            : {}),
      lastFee: BigInt(assembled.transaction.fee),
      submission,
    };
  }
  return { kind: "allowed", submission };
}

/**
 * Steps 1–3 of the pipeline, with no submission: discover what the call needs,
 * sign it, then run the *enforced* simulation that actually exercises the
 * guard's `__check_auth` against live ledger state.
 *
 * Nothing here mutates the ledger, which is what makes a refusal free.
 */
export async function enforceCall(
  params: InvokeParams,
  attempt: number = 0,
  options: { deadline?: InvokeDeadline | undefined; clock?: Clock | undefined } = {},
): Promise<EnforcementOutcome> {
  validateInvokeOptions(params);
  const clock = options.clock ?? params.clock ?? systemClock;
  const deadline = options.deadline ?? makeDeadline(params, clock);
  const { server, source, call, networkPassphrase } = params;
  const logger = resolveLogger(params.logger);
  const onStep = stepHook(params.onStep, logger);

  // Validate the agent identity before the first RPC. A misconfigured signer is
  // a setup error, not a contract verdict, and it should cost zero network round
  // trips. `toAgentSigner` accepts a `Keypair` or an already-adapted signer and
  // rejects secret seeds, checksum-invalid StrKeys and malformed values.
  if (params.guardAuth) {
    try {
      toAgentSigner(params.guardAuth.agent);
    } catch (error) {
      return {
        kind: "error",
        detail: error instanceof Error ? error.message : String(error),
        error:
          error instanceof SigningError
            ? error
            : new SigningError("could not validate the agent signer identity", { cause: error }),
        diagnosticEvents: [],
      };
    }
  }

  let operation: xdr.Operation;
  let expiration: number;
  let nextSeq: string;
  let freshAccount: () => Account;
  let first: rpc.Api.SimulateTransactionResponse;

  try {
    assertWithinDeadline(deadline, "probe");
    operation = Operation.invokeContractFunction({
      contract: call.contract,
      function: call.fn,
      args: call.args,
    });
    // `publicKey()` may be async: an `AdminSigner` is allowed to resolve its
    // identity late (a remote or threshold signer).
    const sourcePubKey = await source.publicKey();
    assertWithinDeadline(deadline, "probe");
    const sourceAccount = await server.getAccount(sourcePubKey);
    assertWithinDeadline(deadline, "probe");
    const latest = await server.getLatestLedger();
    assertWithinDeadline(deadline, "probe");
    expiration = latest.sequence + SIG_EXPIRATION_LEDGERS;
    // `TransactionBuilder` advances the sequence of the `Account` it is handed,
    // so every build in this function gets its own instance built from the same
    // base sequence. Sharing one would silently build the second transaction on
    // sequence N+2 and the network would reject it with `tx_bad_seq`. The
    // per-account reservation also advances past an RPC snapshot that has not
    // yet observed the preceding submission.
    nextSeq = reserveNextSequence(server, sourcePubKey, sourceAccount.sequenceNumber());
    freshAccount = () => new Account(sourcePubKey, nextSeq);

    // ── Step 1: discover required authorizations ──────────────────────────
    const probe = buildInitialEnvelope({
      source: freshAccount(),
      operation,
      networkPassphrase,
      guard: params.guardAuth?.guard ?? null,
      fee: params.fee,
    });
    first = await withStepTiming(
      onStep,
      { name: "probe", attempt },
      () => server.simulateTransaction(probe),
      (response) => rpc.Api.isSimulationError(response),
    );
  } catch (error) {
    // A spent overall deadline is a cancellation, not a simulation failure;
    // keep its typed stage and `deadline` flag intact for the caller.
    if (error instanceof RpcTimeoutError) throw error;
    // Ledger lookup or transport failure: the guard was never asked, so this is
    // `undetermined` rather than a refusal. The original error is kept as the
    // typed cause — it is the only thing that explains *why* the probe failed.
    return {
      kind: "error",
      detail: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
      error: new SimulationError("authorization probe failed", {
        stage: "probe",
        cause: error,
      }),
      diagnosticEvents: [],
    };
  }

  if (rpc.Api.isSimulationError(first)) {
    // The discovery simulation runs in recording mode, so it can fail for
    // reasons that have nothing to do with policy (a contract trap, a missing
    // trustline). Report it as an error with the host's own diagnostics rather
    // than pretending the guard made a decision.
    const error = first as rpc.Api.SimulateTransactionErrorResponse;
    const events = diagnosticEventsOf(error);
    return {
      kind: "error",
      detail: [
        typeof error.error === "string" ? error.error : JSON.stringify(error.error),
        ...summarizeDiagnosticEvents(events),
      ].join("\n  "),
      error: new SimulationError("authorization probe simulation failed", {
        stage: "probe",
        diagnosticEvents: events,
      }),
      diagnosticEvents: events,
    };
  }
  const success = first as rpc.Api.SimulateTransactionSuccessResponse;

  // ── Step 2: sign every authorization the call requires ────────────────
  // One `sign` stage per attempt, spanning every entry the discovery probe
  // reported: a caller tracing the pipeline cares that signing happened and
  // how long it took, not how the loop over entries is shaped inside. A shape
  // this SDK cannot sign raises the internal `SigningStageError` so the stage
  // reports a real `fail`; `enforceCall` converts it straight back into the
  // error outcome the pipeline has always returned, detail text unchanged.
  const signRequiredAuth = async (): Promise<xdr.SorobanAuthorizationEntry[]> => {
    assertWithinDeadline(deadline, "sign");
    let requiredAuth: xdr.SorobanAuthorizationEntry[];
    try {
      requiredAuth = requiredAuthorizationEntries(success);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new SigningStageError(
        detail,
        cause instanceof ContractResponseError
          ? cause
          : new SimulationError("could not read required authorization entries", {
              stage: "probe",
              cause,
            }),
      );
    }

    const signedAuth: xdr.SorobanAuthorizationEntry[] = [];
    for (const entry of requiredAuth) {
      const creds = entry.credentials;
      if (creds.type === "sorobanCredentialsSourceAccount") {
        // Nothing to sign: the transaction source's authorization is carried by
        // the envelope signature. The entry itself is NOT droppable, though — an
        // operation whose auth list is empty is treated as a recording-mode
        // request by the RPC (so `__check_auth` never runs and policy is never
        // enforced), and core then rejects the submitted transaction because no
        // authorization was actually provided.
        signedAuth.push(entry);
        continue;
      }
      if (
        creds.type !== "sorobanCredentialsAddress" &&
        creds.type !== "sorobanCredentialsAddressV2"
      ) {
        // ADDRESS_WITH_DELEGATES (CAP-71 delegation) is out of v1 scope; the
        // contract's SPEC records the same boundary.
        const detail = `unsupported credential type in required authorization: ${creds.type}`;
        throw new SigningStageError(detail, new SigningError(detail));
      }
      const addressCredentials = addressCredentialsOf(creds);
      if (!addressCredentials) {
        const detail = `credential kind has no address payload: ${creds.type}`;
        throw new SigningStageError(detail, new SigningError(detail));
      }
      // Works for both account (G…) and contract (C…) authorizers; the guard's
      // address is a contract, which is exactly why the agent key — not the
      // transaction source — has to produce this signature.
      let address: string;
      try {
        address = Address.fromScAddress(addressCredentials.address).toString();
      } catch (cause) {
        const detail = `required authorization has an invalid address payload: ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
        throw new SigningStageError(detail, new SigningError(detail, { cause }));
      }

      if (params.guardAuth && address === params.guardAuth.guard) {
        // The smart account authorizes: sign with the registered agent key over
        // the guard's own preimage (fresh nonce per transaction).
        try {
          signedAuth.push(
            await buildGuardAuthEntry({
              guard: params.guardAuth.guard,
              call,
              signer: params.guardAuth.agent,
              // The transaction's own sequence number doubles as the nonce: unique
              // per transaction and never reused, so the host can never see a
              // replay for this guard address.
              nonce: BigInt(nextSeq),
              signatureExpirationLedger: expiration,
              networkPassphrase,
              // Answer in the same credential kind the host asked for: the signed
              // preimage differs between legacy ADDRESS and ADDRESS_V2, so using
              // the wrong one produces a signature the account cannot verify.
              credentialType: creds.type,
            }),
          );
        } catch (error) {
          const detail = `could not sign guard authorization for ${address}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          throw new SigningStageError(
            detail,
            new SigningError(detail, { address, cause: error }),
          );
        }
        continue;
      }

      let signer: Keypair | AdminSigner | undefined;
      const suppliedPubkeys: string[] = [];
      for (const s of params.accountSigners ?? []) {
        const pubkey = await s.publicKey();
        suppliedPubkeys.push(pubkey);
        if (pubkey === address) {
          signer = s;
        }
      }
      if (!signer) {
        const detail =
          `call requires authorization from ${address}, but no matching key was provided ` +
          `(supplied: ${suppliedPubkeys.join(", ") || "none"})`;
        throw new SigningStageError(detail, new SigningError(detail, { address }));
      }
      try {
        signedAuth.push(
          await signAccountAuthEntry({
            entry,
            signer,
            signatureExpirationLedger: expiration,
            networkPassphrase,
          }),
        );
      } catch (error) {
        const detail = `could not sign authorization for ${address}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        throw new SigningStageError(detail, new SigningError(detail, { address, cause: error }));
      }
    }
    assertWithinDeadline(deadline, "sign");
    return signedAuth;
  };

  let signedAuth: xdr.SorobanAuthorizationEntry[];
  try {
    signedAuth = await withStepTiming(onStep, { name: "sign", attempt }, signRequiredAuth);
  } catch (error) {
    // A signing-stage shape refusal is a result, not an exception: keep
    // reporting it exactly as the pipeline always has, word for word, with the
    // typed failure attached so a caller never has to match on the text.
    if (error instanceof SigningStageError) {
      return {
        kind: "error",
        detail: error.detail,
        error: error.guardError,
        diagnosticEvents: [],
      };
    }
    throw error;
  }

  // ── Step 3: enforced simulation — this is where policy is applied ─────
  // Building the signed envelope and running the enforced simulation are one
  // timed stage: from a tracer's point of view they are the same question
  // ("did the guard approve?"), and a build failure is a stage failure exactly
  // like a transport failure.
  let signedOperation: xdr.Operation;
  let enforced: rpc.Api.SimulateTransactionResponse;
  try {
    assertWithinDeadline(deadline, "simulate");
    const simulated = await withStepTiming(
      onStep,
      { name: "simulate", attempt },
      async () => {
        assertWithinDeadline(deadline, "simulate");
        const authorized = Operation.invokeContractFunction({
          contract: call.contract,
          function: call.fn,
          args: call.args,
          auth: signedAuth,
        });
        const enforcingTx = buildInitialEnvelope({
          source: freshAccount(),
          operation: authorized,
          networkPassphrase,
          guard: params.guardAuth?.guard ?? null,
          fee: params.fee,
        });
        return { operation: authorized, response: await server.simulateTransaction(enforcingTx) };
      },
      (value) => rpc.Api.isSimulationError(value.response),
    );
    signedOperation = simulated.operation;
    enforced = simulated.response;
  } catch (cause) {
    if (cause instanceof RpcTimeoutError) throw cause;
    return {
      kind: "error",
      detail: `enforced simulation could not be prepared or run: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      error: new SimulationError("enforced simulation could not be prepared or run", {
        stage: "simulate",
        cause,
      }),
      diagnosticEvents: [],
    };
  }
  // This used to be an env-gated write straight to the host's stdout
  // (`SAG_DEBUG_RESOURCES=1`). The description is the same; it now reaches an
  // injected logger and otherwise goes nowhere, because a library does not get
  // to decide where an application's output goes. The README's logging section
  // shows the one-liner that deliberately restores the old behaviour.
  //
  // Two guards around it. The description is only rendered when a logger is
  // attached, so the default path pays nothing for output nobody will read — and
  // it is isolated, because rendering parses the simulation's XDR and a
  // description that cannot be produced is not a reason to fail a call whose
  // simulation just succeeded.
  if (logger !== SILENT_LOGGER) {
    try {
      logger.debug(describeSimulationResources(enforced, params.guardAuth?.guard ?? null), {
        guard: params.guardAuth?.guard ?? null,
        stage: "simulate",
      });
    } catch {
      logger.debug("enforced simulation succeeded (resource description unavailable)", {
        guard: params.guardAuth?.guard ?? null,
        stage: "simulate",
      });
    }
  }
  if (rpc.Api.isSimulationError(enforced)) {
    // NOTE: a simulation failure here is not automatically a block — see the
    // discriminator below. Returning `error` rather than `blocked` in that case
    // is deliberate: an adapter must be able to tell "the guard refused this"
    // from "we could not determine".
    const error = enforced as rpc.Api.SimulateTransactionErrorResponse;
    const events = diagnosticEventsOf(error);
    const reason = reasonFromDiagnosticEvents(events);
    // A guard decision is identifiable: the contract publishes its own
    // `event_auth_checked/blocked/<reason>` event. Any other simulation failure
    // — a contract trap, an absent trustline, a host misuse — is an error, not
    // a block, and must not be reported as the guard refusing anything.
    if (reason === null) {
      return {
        kind: "error",
        detail: [
          typeof error.error === "string" ? error.error : JSON.stringify(error.error),
          ...summarizeDiagnosticEvents(events),
        ].join("\n  "),
        error: new SimulationError("enforced simulation failed without a guard verdict", {
          stage: "simulate",
          diagnosticEvents: events,
        }),
        diagnosticEvents: events,
      };
    }
    return {
      kind: "blocked",
      reason,
      detail: typeof error.error === "string" ? error.error : JSON.stringify(error.error),
      diagnosticEvents: events,
    };
  }

  // Approval that arrives exactly as the budget expires is not an admissible
  // result: the caller has no time left to act on it, and `invokePipeline`
  // must not go on to assemble or broadcast.
  assertWithinDeadline(deadline, "simulate");

  return {
    kind: "admissible",
    simulation: enforced as rpc.Api.SimulateTransactionSuccessResponse,
    operation: signedOperation,
    nextSeq,
  };
}

/**
 * Convert a fired cancel/timeout into the pipeline's `error`/`undetermined` arm
 * rather than letting it escape as an exception.
 *
 * The asymmetry with `invoke()` is deliberate and documented in the README:
 * `check()`/`cost()` answer a *verdict* question, so a timeout is reported as
 * `undetermined` carrying the typed `RpcTimeoutError` — the guard made no
 * decision, and the caller's fail-closed policy takes over. `invoke()` drives a
 * *pipeline* that was already committed to broadcasting, so a timeout there
 * surfaces through `invoke()`'s own `error` outcome, which the caller must
 * handle explicitly. Either way the error class is the same one — callers
 * branch on `instanceof RpcTimeoutError`, never on a message.
 *
 * The `RpcTimeoutError` is carried as-is (not re-wrapped) so `instanceof`,
 * `stage` and `aborted` survive the trip to the caller.
 */
export function timeoutOutcome(error: RpcTimeoutError): InvokeErrorOutcome {
  return {
    kind: "error",
    detail: error.message,
    error,
    diagnosticEvents: [],
    // A bound that fired after the broadcast leaves the transaction on the
    // network; the hash travels with the outcome so the caller can reconcile
    // it out of band.
    ...(error.transactionHash !== undefined ? { transactionHash: error.transactionHash } : {}),
  };
}
