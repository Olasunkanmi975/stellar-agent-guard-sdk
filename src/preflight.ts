/**
 * The pre-flight interceptor: ask the guard whether an action is permitted
 * *before* anything is signed for broadcast.
 *
 * This is the surface an agent framework integrates with. It answers one
 * question — "may this call proceed?" — and it answers it the same way the chain
 * would, because it runs the same enforcement: the guarded account's real
 * `__check_auth` against live ledger state, in a simulation that cannot mutate
 * anything. A refusal therefore costs nothing and cannot be bypassed by an agent
 * that ignores the answer, since the on-chain check still stands behind it.
 *
 * Three distinct answers, kept distinct on purpose:
 *
 *  - `admissible` — the guard approved. `estimatedResourceFee` is the network's
 *    own price for the call, taken from the same simulation.
 *  - `blocked` — the guard refused, with the contract's own reason. This is the
 *    guardrail working, and the reason is safe to show an operator.
 *  - `undetermined` — the enforcement run failed for a reason that is not a
 *    policy decision (a contract trap, a missing trustline, an unsupported
 *    credential type). **Treated as not-allowed**, because a guardrail must fail
 *    closed, but reported separately so an adapter never claims the guard
 *    refused something it never ruled on.
 *
 * A refused call never has a transaction hash. That is not a gap in the
 * evidence: the block happens before broadcast, which is what makes it free.
 */
import { Keypair, StrKey, rpc, xdr } from "@stellar/stellar-sdk";
import { concatBytes, sha256Hex, utf8Bytes } from "./hash.ts";
import { GuardError, InvalidInputError, SimulationError } from "./errors.ts";
import { enforceCall, RpcTimeoutError, timeoutOutcome, withRpcAbort } from "./invoke.ts";
import {
  DEFAULT_RPC_TIMEOUT_MS,
} from "./invoke.ts";
import {
  resourceBreakdownFromSimulation,
  type CostProvenance,
  type ResourceBreakdown,
} from "./cost.ts";
import {
  extractTransferAmount,
  readPersistentEntry,
  type ContractAddress,
  type ReadonlyPolicyConfig,
} from "./policy.ts";
import { GuardBlockedError, explainReason } from "./reasons.ts";
import type { EnforcementOutcome, InvokeStepEvent } from "./invoke.ts";
import { resolveLogger, type GuardLogger, type GuardLoggerInput } from "./logger.ts";
import { parseSimulationResourceFee, toAgentSigner } from "./tx.ts";
import type { AgentSigner, ContractCall } from "./tx.ts";
import { systemClock, type Clock } from "./clock.ts";

/**
 * Re-exported from `errors.ts` for the existing import path. Thrown
 * synchronously when a ContractCall has invalid shape or types before any RPC
 * round-trip is attempted, distinguishing programmer errors from policy
 * outcomes (blocked decisions).
 */
export { InvalidInputError };

/**
 * Validate a ContractCall's input shape before RPC dispatch.
 * Throws InvalidInputError synchronously if any validation rule fails.
 */
export function validateContractCall(call: ContractCall): void {
  if (!call || typeof call !== "object") {
    throw new InvalidInputError("call", "required", "call must be an object");
  }

  // 1. Contract format check
  if (typeof call.contract !== "string" || call.contract.trim() === "") {
    throw new InvalidInputError("contract", "required", "contract ID is required and must be non-empty");
  }
  if (!StrKey.isValidContract(call.contract)) {
    throw new InvalidInputError(
      "contract",
      "invalid_format",
      "contract ID must be a valid C... StrKey contract address",
    );
  }

  // 2. Method presence and shape check
  if (typeof call.fn !== "string" || call.fn.trim() === "") {
    throw new InvalidInputError("fn", "required", "method name is required and must be non-empty");
  }
  if (call.fn.length > 32 || !/^[a-zA-Z0-9_]+$/.test(call.fn)) {
    throw new InvalidInputError(
      "fn",
      "symbol_shape",
      "method name must be a symbol-shaped string of 1-32 alphanumeric or underscore characters",
    );
  }

  // 3. Args array check
  if (!Array.isArray(call.args)) {
    throw new InvalidInputError("args", "array", "args must be an array of xdr.ScVal");
  }
  for (let i = 0; i < call.args.length; i++) {
    const arg = call.args[i] as unknown;
    if (!(arg instanceof xdr.ScVal)) {
      if (
        (call.fn === "transfer" && i === 2) ||
        (call.fn === "transfer_from" && i === 3)
      ) {
        throw new InvalidInputError(
          "amount",
          "i128_type",
          `amount at argument index ${i} must be an i128 ScVal (got ${typeof arg})`,
        );
      }
      throw new InvalidInputError(
        "args",
        "typed_scval",
        `argument at index ${i} must be an xdr.ScVal instance`,
      );
    }
  }

  // 4. Amount type check for known token operations
  if (call.fn === "transfer") {
    if (call.args.length < 3) {
      throw new InvalidInputError(
        "args",
        "missing_argument",
        "transfer expects at least 3 arguments: [from, to, amount]",
      );
    }
    const amountVal = call.args[2];
    if (!amountVal || amountVal.type !== "scvI128") {
      throw new InvalidInputError(
        "amount",
        "i128_type",
        `transfer amount must be an i128 ScVal (received type: ${amountVal?.type ?? "missing"})`,
      );
    }
  } else if (call.fn === "transfer_from") {
    if (call.args.length < 4) {
      throw new InvalidInputError(
        "args",
        "missing_argument",
        "transfer_from expects at least 4 arguments: [spender, from, to, amount]",
      );
    }
    const amountVal = call.args[3];
    if (!amountVal || amountVal.type !== "scvI128") {
      throw new InvalidInputError(
        "amount",
        "i128_type",
        `transfer_from amount must be an i128 ScVal (received type: ${amountVal?.type ?? "missing"})`,
      );
    }
  }
}

/**
 * Thrown when enforcement could not reach a decision.
 *
 * Deliberately not a `GuardBlockedError`: reporting "the guard refused this"
 * when the guard never ruled would be a false claim about the security
 * boundary, which is the one thing an operator must be able to trust.
 */
export class PreFlightUndeterminedError extends SimulationError {
  readonly detail: string;

  constructor(detail: string, options: { cause?: unknown } = {}) {
    super(`stellar-agent-guard could not determine this action's status\n${detail}`, {
      stage: "preflight",
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "PreFlightUndeterminedError";
    this.detail = detail;
  }
}

export type PreFlightDecision =
  | {
      allowed: true;
      kind: "admissible";
      /** The network's own resource fee estimate for this call, in stroops. */
      estimatedResourceFee: bigint;
      /** Number of ledger keys the call is priced to touch. */
      footprintKeys: number;
      /** Resource limits and footprint counts from the same simulation. */
      resourceBreakdown?: ResourceBreakdown;
      /**
       * Ledger snapshot the simulation priced against, read from that same
       * simulation response. Informational only: it identifies the state the
       * quote describes, not a guarantee that submission will land there.
       * Omitted when the RPC response did not establish a usable ledger.
       */
      provenance?: CostProvenance;
    }
  | {
      allowed: false;
      kind: "blocked";
      /** The contract's reason symbol, e.g. `per_tx_cap_exceeded`. */
      reason: string;
      /** One-line operator-facing meaning of `reason`. */
      explanation: string;
      detail: string;
      diagnosticEvents: unknown[];
    }
  | {
      allowed: false;
      kind: "undetermined";
      detail: string;
      /** Machine-readable cause; use `instanceof` instead of matching `detail`. */
      error?: GuardError;
    };

/**
 * Read the ledger marker out of the simulation that produced the quote.
 *
 * This deliberately reads the successful enforced simulation's own
 * `latestLedger` instead of issuing `getLatestLedger()` again: a second read
 * can land on a newer ledger and would then describe state the simulation never
 * saw. The value is informational, and an absent or malformed marker is omitted
 * rather than replaced with a fabricated sequence number.
 */
function provenanceFromSimulation(simulation: unknown): CostProvenance | undefined {
  if (typeof simulation !== "object" || simulation === null) return undefined;
  const ledger = (simulation as { latestLedger?: unknown }).latestLedger;
  if (typeof ledger !== "number" || !Number.isSafeInteger(ledger) || ledger < 0) {
    return undefined;
  }
  return { ledger };
}

/**
 * Options for a batched pre-flight check.
 *
 * Both fields exist so a caller can run the batch check against values it
 * already knows, without an extra ledger read. Omit them and the interceptor
 * fetches the live policy and committed window spend from the guard's storage.
 */
export interface CheckBatchOptions {
  /**
   * Policy configuration to enforce against during batch staging.
   * If omitted, the interceptor attempts to fetch it from the guard's ledger storage.
   */
  policy?: ReadonlyPolicyConfig | null;

  /**
   * Initial committed amount already spent in the current rolling window.
   * If omitted, attempts to fetch it from the guard's `Window` ledger entry (defaults to 0n).
   */
  initialWindowSpent?: bigint;

  /**
   * Optional per-call observability, forwarded to each call's `check()`:
   * one event per enforcement-stage attempt, in call order.
   */
  onStep?: (step: InvokeStepEvent) => void;

  /**
   * Caller-owned cancellation for the whole batch. Once it fires, no further
   * call is started; every unfinished call is reported as a fail-closed
   * `undetermined` verdict carrying a typed `RpcTimeoutError`.
   */
  signal?: AbortSignal | undefined;

  /**
   * Per-call timeout, forwarded to each `check()`. Independent of
   * `deadlineMs`: a fired per-call timeout leaves the rest of the batch free to
   * continue, while a spent batch deadline stops it.
   */
  timeoutMs?: number | undefined;

  /**
   * Overall time budget for the whole batch, in milliseconds, measured from
   * the start of `checkBatch()` on the interceptor's injected clock.
   *
   * Once spent, no further call is started and the remaining verdicts are
   * fail-closed `undetermined` results carrying an `RpcTimeoutError` with
   * `deadline: true`. The budget also caps each individual check's timeout, so
   * a single long RPC cannot overrun it. Omit for the per-call default.
   */
  deadlineMs?: number | undefined;
}

/**
 * Where the committed window spend used for batch staging came from.
 *
 * The distinction matters: an explicit `initialWindowSpent` (including `0n`)
 * is a caller-provided snapshot and is trusted, while a failed live read means
 * the SDK does not know the committed spend. A missing `Window` ledger entry is
 * a definitive "nothing committed yet", not a failed read.
 */
export type BatchStagingSource = "provided" | "ledger" | "absent" | "unavailable";

/** The staging snapshot a batch verdict was evaluated against. */
export interface PreFlightBatchStaging {
  /**
   * Committed window spend used for staging, or `null` when a required live
   * read failed. An explicitly supplied `0n` is reported as `0n` with source
   * `"provided"` — never confused with an unavailable read.
   */
  windowSpent: bigint | null;
  /** Where `windowSpent` came from. */
  source: BatchStagingSource;
  /**
   * True when a positive SAC transfer needed state that could not be read, so
   * the batch could not be staged to a definite verdict.
   */
  unavailable: boolean;
}

export interface PreFlightBatchDecision {
  /**
   * Overall batch verdict: true only if every call in the batch is admissible.
   * Mirrors the contract's all-or-nothing auth batch semantics.
   */
  admissible: boolean;

  /**
   * Alias for `admissible`.
   */
  overallAdmissible: boolean;

  /**
   * Overall batch classification. `undetermined` means the batch cannot be
   * reported as admissible because required staging state was unavailable (or
   * an individual call was undetermined); `blocked` means at least one call was
   * definitely refused. Always set on a result returned by `checkBatch()`.
   */
  kind?: "admissible" | "blocked" | "undetermined";

  /** Human-readable explanation when `kind` is `undetermined`. */
  detail?: string;

  /**
   * Per-call decisions in the exact order of the input batch.
   */
  verdicts: PreFlightDecision[];

  /**
   * Alias for `verdicts`.
   */
  calls: PreFlightDecision[];

  /**
   * Total estimated resource fee in stroops across all calls in the batch
   * that were admissible.
   */
  totalEstimatedResourceFee: bigint;

  /**
   * The window snapshot used for staging. Omitted for an empty batch, which
   * performs no staging.
   */
  staging?: PreFlightBatchStaging;
}

/** A caller-supplied policy revision token used as part of the cache key. */
export type PolicyRevision = string | number | bigint | boolean | null | undefined;

/**
 * Per-call options for `check()`.
 *
 * `onStep` receives the enforcement pipeline's stage attempts (probe → sign →
 * simulate; `check()` never broadcasts), using the same `InvokeStepEvent`
 * shape and shared trace vocabulary as `invoke()`'s `onStep`. Entirely
 * optional — omitting it changes nothing about the check.
 *
 * `signal` and `timeoutMs` bound the RPC calls the check makes (the ledger
 * lookup and the probe/enforced simulations). An already-aborted signal
 * returns before any RPC call is made; a mid-flight abort or a fired timeout
 * returns the check's fail-closed `undetermined` verdict carrying a typed
 * `RpcTimeoutError` — the guard reached no decision, which is exactly what
 * `undetermined` means, so a bound can never produce an `admissible` verdict.
 * Both default to the pipeline's shared behaviour: no signal, and
 * `DEFAULT_RPC_TIMEOUT_MS` for the timeout.
 */
export interface PreFlightCheckOptions {
  onStep?: (step: InvokeStepEvent) => void;
  /**
   * Caller-owned cancellation; aborts the RPC calls the check makes. A fired
   * signal yields an `undetermined` verdict, never a throw.
   */
  signal?: AbortSignal | undefined;
  /**
   * Bound on each RPC call, in milliseconds; `0` disables the timeout. A fired
   * timeout yields the same `undetermined` verdict as an abort.
   */
  timeoutMs?: number | undefined;
}

export interface PreFlightCacheOptions {
  /**
   * Maximum cache age in milliseconds. The effective value is capped at one
   * approximate ledger-close interval (5 seconds), so a cache hit can never
   * cross a ledger boundary.
   */
  ttlMs?: number;
  /** Ledger-based spelling of `ttlMs`; one ledger is approximately 5 seconds. */
  ttlLedgers?: number;
  /**
   * Optional policy revision, or a getter for it. Supplying this makes a policy
   * change invalidate the entry even if the wall-clock TTL has not elapsed.
   */
  policyRevision?: PolicyRevision | (() => PolicyRevision | Promise<PolicyRevision>);
}

export interface PreFlightConfig {
  server: rpc.Server;
  networkPassphrase: string;
  /** The guarded smart account whose policy is being enforced. */
  guard: ContractAddress;
  /**
   * The key registered as the account's agent, used to sign the auth entry: an
   * `AgentSigner` for any signing setup, or a plain Ed25519 `Keypair` for the
   * single-key default.
   */
  agent: AgentSigner | Keypair;
  /** Classic account that pays fees and supplies the sequence number. */
  source: Keypair;
  /** Authorizers for non-guard requirements (e.g. an admin on a policy call). */
  accountSigners?: Keypair[];
  /** Optional policy to use for batch staging (otherwise fetched from ledger). */
  policy?: ReadonlyPolicyConfig | null;
  /**
   * Opt-in short-lived cache. Omit this property to preserve uncached behavior.
   * A cached verdict can be staler than one admitted transfer.
   */
  cache?: PreFlightCacheOptions;
  /**
   * Optional log sink for this interceptor's decision points: each verdict, and
   * every cache hit, store and invalidation.
   *
   * Omitted — the default — the interceptor says nothing at all. A verdict is
   * still returned exactly as before; the logger changes only whether anyone is
   * told about it.
   */
  logger?: GuardLoggerInput | undefined;
  /**
   * Coalesce concurrent checks for the same call and config into one
   * discovery/enforcement run. Defaults to `true`; set `false` to force every
   * call to run its own simulation.
   *
   * Coalescing is per interceptor, so the call fingerprint plus this instance's
   * config identity is the whole key. Each waiter still applies its own
   * `signal`/`timeoutMs`, and a settled run — including an undetermined one — is
   * removed immediately rather than retained as a cache. Checks that supply
   * `onStep` are never coalesced, so each caller receives its own trace.
   */
  coalesceInFlight?: boolean;
  /**
   * Inject a custom clock for time-dependent operations (cache TTL, batch
   * deadlines, etc.). Defaults to the system clock; use a FakeClock in tests
   * for deterministic timing.
   */
  clock?: Clock;
}

/** Alias used by the README's constructor terminology. */
export type PreFlightInterceptorOptions = PreFlightConfig;

const LEDGER_CLOSE_MS = 5_000;
const MAX_CACHE_TTL_MS = LEDGER_CLOSE_MS;

interface CacheEntry {
  decision: PreFlightDecision;
  ledger: number;
  expiresAt: number;
}

interface CacheContext {
  key: string;
  ledger: number;
  expiresAt: number;
}

/** The fail-closed verdict for a caller bound that fired. */
function timeoutDecision(error: RpcTimeoutError): PreFlightDecision {
  const outcome = timeoutOutcome(error);
  return {
    allowed: false,
    kind: "undetermined",
    detail: outcome.detail,
    error: outcome.error,
  };
}

function policyRevisionToken(revision: PolicyRevision): string {
  if (revision === undefined) return "unknown";
  if (revision === null) return "null";
  return `${typeof revision}:${String(revision)}`;
}

function hashPart(parts: Uint8Array[], value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? utf8Bytes(value) : value;
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, false);
  parts.push(length, bytes);
}

function callFingerprint(call: ContractCall): string {
  const parts: Uint8Array[] = [];
  hashPart(parts, call.contract);
  hashPart(parts, call.fn);
  for (const arg of call.args) hashPart(parts, arg.toXDR());
  return sha256Hex(concatBytes(parts));
}

function configFingerprint(config: PreFlightConfig): string {
  const parts: Uint8Array[] = [];
  hashPart(parts, config.networkPassphrase);
  hashPart(parts, config.guard);
  hashPart(parts, config.source.publicKey());
  hashPart(parts, toAgentSigner(config.agent).publicKey);
  for (const signer of (config.accountSigners ?? []).map((keypair) => keypair.publicKey()).sort()) {
    hashPart(parts, signer);
  }
  return sha256Hex(concatBytes(parts));
}

export class PreFlightInterceptor {
  private readonly config: PreFlightConfig;
  private readonly cacheOptions: PreFlightCacheOptions | undefined;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<PreFlightDecision>>();
  private readonly namespace: string;
  private readonly coalesceInFlight: boolean;
  private readonly logger: GuardLogger;
  private readonly clock: Clock;
  private _hits = 0;
  private _misses = 0;
  private _invalidations = 0;

  constructor(config: PreFlightConfig) {
    this.config = config;
    this.cacheOptions = config.cache;
    this.clock = config.clock ?? systemClock;
    this.coalesceInFlight = config.coalesceInFlight !== false;
    this.validateCacheOptions();
    this.namespace = this.cacheOptions ? configFingerprint(config) : "";
    this.logger = resolveLogger(config.logger);
  }

  private validateCacheOptions(): void {
    if (!this.cacheOptions) return;
    const { ttlMs, ttlLedgers } = this.cacheOptions;
    if (ttlMs === undefined && ttlLedgers === undefined) {
      throw new TypeError("preflight cache requires ttlMs or ttlLedgers");
    }
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new TypeError("preflight cache ttlMs must be a positive finite number");
    }
    if (ttlLedgers !== undefined && (!Number.isFinite(ttlLedgers) || ttlLedgers <= 0)) {
      throw new TypeError("preflight cache ttlLedgers must be a positive finite number");
    }
  }

  private cacheTtlMs(): number {
    const { ttlMs, ttlLedgers } = this.cacheOptions ?? {};
    const requested = ttlMs ?? (ttlLedgers ?? 0) * LEDGER_CLOSE_MS;
    return Math.min(requested, MAX_CACHE_TTL_MS);
  }

  private async cacheContext(call: ContractCall): Promise<CacheContext | null> {
    if (!this.cacheOptions) return null;

    let revision: PolicyRevision;
    try {
      if (typeof this.cacheOptions.policyRevision === "function") {
        revision = await this.cacheOptions.policyRevision();
        if (revision === undefined) return null;
      } else {
        revision = this.cacheOptions.policyRevision;
      }
    } catch {
      // A revision read failure must not turn a cache lookup into a security
      // decision. Fall through to the uncached path instead.
      return null;
    }

    let ledger: number;
    try {
      const latest = await this.config.server.getLatestLedger();
      ledger = latest.sequence;
    } catch {
      // Without a trustworthy ledger marker, do not reuse a cached verdict.
      return null;
    }

    const now = this.clock.now();
    for (const [key, entry] of this.cache) {
      if (entry.ledger !== ledger || entry.expiresAt <= now) this.cache.delete(key);
    }

    return {
      key: `${this.namespace}:${callFingerprint(call)}:${policyRevisionToken(revision)}`,
      ledger,
      expiresAt: now + this.cacheTtlMs(),
    };
  }

  /** Clear all cached verdicts, or only entries for `call` when provided. */
  invalidate(call?: ContractCall): void {
    if (!call) {
      const cleared = this.cache.size;
      this.cache.clear();
      this.logger.debug("pre-flight cache invalidated", { scope: "all", cleared });
      this._invalidations += cleared;
      return;
    }
    const prefix = `${this.namespace}:${callFingerprint(call)}:`;
    let cleared = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        cleared += 1;
      }
    }
    this.logger.debug("pre-flight cache invalidated", { scope: "call", cleared });
    this._invalidations += cleared;
  }

  /**
   * Decide whether `call` may proceed. Never broadcasts, never mutates, never
   * throws for a refusal — a block is a normal, expected result.
   *
   * Accepts per-call `options` (e.g. `onStep` observability) without any
   * effect on the verdict itself; existing single-argument callers are
   * unaffected.
   *
   * Concurrent checks for the same call and config share a single in-flight
   * discovery/enforcement run by default. The shared run is not bound by any
   * one caller's signal or timeout — one caller giving up must not cancel a
   * result another waiter is still entitled to — so each caller races the same
   * work against its own bound instead.
   */
  async check(call: ContractCall, options?: PreFlightCheckOptions): Promise<PreFlightDecision> {
    validateContractCall(call);

    // An already-aborted caller asks for no work at all, including the cache
    // lookup's ledger read. Answer before any RPC or in-flight registration.
    if (options?.signal?.aborted) {
      return timeoutDecision(new RpcTimeoutError({ stage: "pre-flight", aborted: true }));
    }

    const context = await this.cacheContext(call);
    if (context) {
      const cached = this.cache.get(context.key);
      if (cached) {
        const now = this.clock.now();
        if (cached.ledger === context.ledger && cached.expiresAt > now) {
          // A hit is worth a line of its own: it is the one verdict the caller
          // gets without a simulation, so a host reading logs needs to be able
          // to tell a reused verdict from a fresh one.
          this.logger.debug("pre-flight verdict served from cache", {
            guard: this.config.guard,
            contract: call.contract,
            fn: call.fn,
            kind: cached.decision.kind,
            ledger: context.ledger,
          });
          this._hits++;
          return cached.decision;
        }
        this.cache.delete(context.key);
      }
      // If we have a context but didn't get a valid hit, it's a miss.
      this._misses++;
    }

    // An `onStep` observer owns its enforcement trace, so a check that supplies
    // one is not coalesced: sharing a run would either drop that observer's
    // events or interleave two observers over one pipeline.
    if (options?.onStep || !this.coalesceInFlight) {
      return this.computeDecision(call, context, options?.onStep, {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      });
    }

    // The map is per interceptor, so the call fingerprint plus this instance's
    // config identity is the whole in-flight key.
    const key = context ? context.key : callFingerprint(call);
    let shared = this.inFlight.get(key);
    if (!shared) {
      // The shared run keeps the pipeline's default bound so a hung RPC cannot
      // pin the entry forever; callers that asked for a tighter bound race it
      // below, and never shorten it for anyone else.
      shared = this.computeDecision(call, context, undefined, {
        timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
      });
      this.inFlight.set(key, shared);
      const settle = () => {
        if (this.inFlight.get(key) === shared) this.inFlight.delete(key);
      };
      // Remove on both success and failure. Coalescing is not a cache: no
      // outcome — admitted, refused or undetermined — survives the run.
      shared.then(settle, settle);
    }
    return this.awaitWithCallerBound(shared, options);
  }

  /** Race coalesced work against the waiting caller's own signal/timeout. */
  private async awaitWithCallerBound(
    work: Promise<PreFlightDecision>,
    options?: PreFlightCheckOptions,
  ): Promise<PreFlightDecision> {
    const { signal, timeoutMs } = options ?? {};
    if (!signal && timeoutMs === undefined) return work;
    try {
      return await withRpcAbort(
        { stage: "pre-flight", signal, timeoutMs: timeoutMs ?? 0 },
        () => work,
      );
    } catch (error) {
      if (!(error instanceof RpcTimeoutError)) throw error;
      return timeoutDecision(error);
    }
  }

  private async computeDecision(
    call: ContractCall,
    context: CacheContext | null,
    onStep: ((step: InvokeStepEvent) => void) | undefined,
    bound: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined },
  ): Promise<PreFlightDecision> {
    // A bound that fired is a verdict, not a crash: the guard never reached a
    // decision, so the check returns its fail-closed `undetermined` arm (the
    // same arm any other unrunnable simulation takes) carrying the typed
    // `RpcTimeoutError`. `invoke()` reports the same error through its own
    // `error` outcome instead — a verdict question versus a pipeline question.
    let outcome: EnforcementOutcome;
    try {
      outcome = await withRpcAbort(
        {
          stage: "pre-flight",
          signal: bound.signal,
          timeoutMs: bound.timeoutMs,
        },
        () =>
          enforceCall({
            server: this.config.server,
            source: this.config.source,
            call,
            networkPassphrase: this.config.networkPassphrase,
            guardAuth: { guard: this.config.guard, agent: this.config.agent },
            ...(this.config.accountSigners ? { accountSigners: this.config.accountSigners } : {}),
            ...(onStep ? { onStep } : {}),
            ...(this.config.logger ? { logger: this.config.logger } : {}),
          }),
      );
    } catch (error) {
      if (!(error instanceof RpcTimeoutError)) throw error;
      outcome = timeoutOutcome(error);
    }

    let decision: PreFlightDecision;
    if (outcome.kind === "error") {
      decision = {
        allowed: false,
        kind: "undetermined",
        detail: outcome.detail,
        error: outcome.error,
      };
    } else if (outcome.kind === "blocked") {
      decision = {
        allowed: false,
        kind: "blocked",
        reason: outcome.reason,
        explanation: explainReason(outcome.reason),
        detail: outcome.detail,
        diagnosticEvents: outcome.diagnosticEvents,
      };
    } else {
      const resourceBreakdown = resourceBreakdownFromSimulation(outcome.simulation);
      const data = outcome.simulation.transactionData as unknown as
        | { getReadOnly?: () => unknown[]; getReadWrite?: () => unknown[] }
        | undefined;
      const footprintKeys =
        (data?.getReadOnly?.().length ?? 0) + (data?.getReadWrite?.().length ?? 0);

      // Fail closed on an unpriceable simulation: a guardrail must never hand
      // back an admissible verdict carrying a fabricated or silently zero fee.
      let estimatedResourceFee: bigint;
      try {
        estimatedResourceFee = parseSimulationResourceFee(outcome.simulation.minResourceFee, {
          stage: "preflight",
        });
      } catch (cause) {
        decision = {
          allowed: false,
          kind: "undetermined",
          detail: `enforced simulation returned an invalid resource fee: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          error:
            cause instanceof GuardError
              ? cause
              : new SimulationError("enforced simulation returned an invalid resource fee", {
                  stage: "preflight",
                  cause,
                }),
        };
        return decision;
      }
      const provenance = provenanceFromSimulation(outcome.simulation);
      decision = {
        allowed: true,
        kind: "admissible",
        estimatedResourceFee,
        footprintKeys,
        ...(resourceBreakdown ? { resourceBreakdown } : {}),
        ...(provenance ? { provenance } : {}),
      };
    }

    // An undetermined result is not a verdict and may be transient, so it is
    // deliberately not cached. Actual admissible/blocked results are.
    if (context && decision.kind !== "undetermined") {
      this.cache.set(context.key, {
        decision,
        ledger: context.ledger,
        expiresAt: context.expiresAt,
      });
      this.logger.debug("pre-flight verdict cached", {
        kind: decision.kind,
        ledger: context.ledger,
      });
    }

    // The verdict itself, at the level its severity deserves: a refusal is the
    // guardrail working and is reported as information, a decision that could
    // not be reached is a degraded state and is reported as a warning.
    if (decision.kind === "blocked") {
      this.logger.info(`guard refused the call (${decision.reason})`, {
        guard: this.config.guard,
        contract: call.contract,
        fn: call.fn,
        reason: decision.reason,
      });
    } else if (decision.kind === "undetermined") {
      this.logger.warn(`pre-flight could not determine enforcement: ${decision.detail}`, {
        guard: this.config.guard,
        contract: call.contract,
        fn: call.fn,
      });
    } else {
      this.logger.debug("call admitted by the guard", {
        guard: this.config.guard,
        contract: call.contract,
        fn: call.fn,
        // A string, not the raw bigint: a JSON logger cannot serialise one.
        estimatedResourceFee: decision.estimatedResourceFee.toString(),
        footprintKeys: decision.footprintKeys,
      });
    }
    return decision;
  }

  /**
   * Decide whether an entire batch of calls may proceed with all-or-nothing semantics.
   *
   * Mirrors the contract's staged window evaluation:
   * 1. Evaluates each call in sequence.
   * 2. For SAC transfers, tracks the cumulative admitted amounts in memory ("simulated staging").
   * 3. If an individual call passes simulation in isolation but would push the cumulative
   *    staged window spend past `window_cap`, it is marked as `blocked` with reason
   *    `window_cap_exceeded`.
   * 4. If any call is blocked or undetermined, the overall batch `admissible` is false.
   *
   * Staging state is fail-closed. An explicit `initialWindowSpent` (including
   * `0n`) is a caller snapshot and is trusted; an absent `Window` ledger entry
   * means no spend has been committed yet. A *failed* policy or window read is
   * different: when a positive transfer needs that state, the affected calls
   * are reported `undetermined` and the batch is never reported admissible from
   * missing state. Non-transfer calls, and batches whose known cap is zero, do
   * not need the snapshot and are unaffected.
   *
   * Documented approximation vs true batch simulation:
   * This sequential simulation with staged window accounting is an off-chain approximation
   * of the contract's atomic auth batch evaluation:
   * - State mutations between calls (other than guard window spend) are not observed during
   *   independent simulations.
   * - Window entries are staged against the initial window snapshot without modelling intra-batch
   *   time expiration.
   * - Total estimated resource fee is the sum of per-call estimates rather than a single
   *   transaction envelope's resource fee.
   *
   * Note cross-dependency:
   * When contract-side `check_batch` lands in `stellar-agent-guard-contracts`, `checkBatch`
   * will route to that entrypoint for atomic on-chain simulation, and this sequential
   * staging implementation will serve as the fallback for contracts on earlier ABI versions.
   */
  async checkBatch(
    calls: ContractCall[],
    options?: CheckBatchOptions,
  ): Promise<PreFlightBatchDecision> {
    if (options?.deadlineMs !== undefined) {
      if (
        typeof options.deadlineMs !== "number" ||
        !Number.isFinite(options.deadlineMs) ||
        options.deadlineMs <= 0
      ) {
        throw new RangeError(
          "checkBatch deadlineMs must be a positive finite number of milliseconds",
        );
      }
    }

    if (calls.length === 0) {
      return {
        admissible: true,
        overallAdmissible: true,
        kind: "admissible",
        verdicts: [],
        calls: [],
        totalEstimatedResourceFee: 0n,
      };
    }

    // Resolve policy and committed window spend. `undefined` means "not
    // supplied"; an explicit `null` policy is a caller decision that there is
    // no policy to enforce, not a missing read.
    const suppliedPolicy =
      options?.policy !== undefined ? options.policy : this.config.policy;
    const suppliedWindowSpent = options?.initialWindowSpent;

    let policy: ReadonlyPolicyConfig | null = suppliedPolicy ?? null;
    let policyStatus: BatchStagingSource = suppliedPolicy === undefined ? "unavailable" : "provided";
    let policyReadError: unknown;

    let initialWindowSpent = suppliedWindowSpent ?? 0n;
    let windowStatus: BatchStagingSource =
      suppliedWindowSpent === undefined ? "unavailable" : "provided";
    let windowReadError: unknown;

    if (suppliedPolicy === undefined || suppliedWindowSpent === undefined) {
      // Read the missing entries independently: one failed read must not hide a
      // successful read of the other, and the result must distinguish an absent
      // entry (a definitive zero/no-policy answer) from an RPC failure.
      const [policyRead, windowRead] = await Promise.allSettled([
        suppliedPolicy === undefined
          ? readPersistentEntry(this.config.server, this.config.guard, "Policy")
          : Promise.resolve(null),
        suppliedWindowSpent === undefined
          ? readPersistentEntry(this.config.server, this.config.guard, "Window")
          : Promise.resolve(null),
      ]);

      if (suppliedPolicy === undefined) {
        if (policyRead.status === "rejected") {
          policyReadError = policyRead.reason;
        } else if (policyRead.value === null) {
          policyStatus = "absent";
        } else if (policyRead.value.value && typeof policyRead.value.value === "object") {
          policy = policyRead.value.value as ReadonlyPolicyConfig;
          policyStatus = "ledger";
        } else {
          // A present but malformed policy is not evidence of "no cap".
          policyStatus = "unavailable";
          policyReadError = new Error("Policy ledger entry did not contain a policy object");
        }
      }

      if (suppliedWindowSpent === undefined) {
        if (windowRead.status === "rejected") {
          windowReadError = windowRead.reason;
        } else if (windowRead.value === null) {
          initialWindowSpent = 0n;
          windowStatus = "absent";
        } else if (windowRead.value.value && typeof windowRead.value.value === "object") {
          try {
            const windowValue = windowRead.value.value as { total?: bigint | number };
            initialWindowSpent = BigInt(windowValue.total ?? 0);
            windowStatus = "ledger";
          } catch (error) {
            windowReadError = error;
            windowStatus = "unavailable";
          }
        } else {
          // A present but malformed window entry is not evidence of zero spend.
          windowStatus = "unavailable";
          windowReadError = new Error("Window ledger entry did not contain a window object");
        }
      }
    }

    let stagedWindowSpent = 0n;
    let totalEstimatedResourceFee = 0n;
    const verdicts: PreFlightDecision[] = [];
    let stagingRequired = false;
    let stagingUnavailableDetail: string | undefined;
    let stagingUnavailableError: unknown;

    const describeUnavailable = (source: string, error: unknown): string => {
      const reason = error instanceof Error ? `: ${error.message}` : "";
      return (
        `batch staging state unavailable: could not read the guard ${source}${reason}; ` +
        "the rolling window cap cannot be evaluated for this transfer"
      );
    };

    for (const call of calls) {
      const checkOptions: PreFlightCheckOptions = {
        ...(options?.onStep ? { onStep: options.onStep } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      };

      const decision = await this.check(call, checkOptions);

      if (decision.kind === "admissible") {
        const amount = extractTransferAmount(call);

        if (amount !== null && amount > 0n) {
          const windowCap = policy?.window_cap ?? 0n;
          const policyKnown = policyStatus !== "unavailable";

          if (!policyKnown) {
            stagingRequired = true;
            stagingUnavailableDetail ??= describeUnavailable("policy", policyReadError);
            stagingUnavailableError ??= policyReadError;
          } else if (windowCap > 0n) {
            stagingRequired = true;
            if (windowStatus === "unavailable") {
              stagingUnavailableDetail ??= describeUnavailable(
                "committed window spend",
                windowReadError,
              );
              stagingUnavailableError ??= windowReadError;
            }
          }

          if (stagingUnavailableDetail !== undefined) {
            // The individual simulation is admissible, but a batch verdict
            // cannot be staged from state we do not have. Report it as
            // undetermined rather than silently staging against zero.
            verdicts.push({
              allowed: false,
              kind: "undetermined",
              detail: stagingUnavailableDetail,
              error:
                stagingUnavailableError instanceof GuardError
                  ? stagingUnavailableError
                  : new SimulationError(stagingUnavailableDetail, {
                      stage: "preflight",
                      ...(stagingUnavailableError === undefined
                        ? {}
                        : { cause: stagingUnavailableError }),
                    }),
            });
            continue;
          }

          if (windowCap > 0n) {
            const projectedSpend = initialWindowSpent + stagedWindowSpent + amount;
            if (projectedSpend > windowCap) {
              verdicts.push({
                allowed: false,
                kind: "blocked",
                reason: "window_cap_exceeded",
                explanation: explainReason("window_cap_exceeded"),
                detail: `staged window cap exceeded: cumulative spend ${projectedSpend} > window_cap ${windowCap}`,
                diagnosticEvents: [],
              });
              continue;
            }
            stagedWindowSpent += amount;
          }
        }

        verdicts.push(decision);
        totalEstimatedResourceFee += decision.estimatedResourceFee;
      } else {
        verdicts.push(decision);
      }
    }

    const hasBlocked = verdicts.some((verdict) => verdict.kind === "blocked");
    const undeterminedVerdict = verdicts.find((verdict) => verdict.kind === "undetermined");
    const kind: PreFlightBatchDecision["kind"] = hasBlocked
      ? "blocked"
      : undeterminedVerdict
        ? "undetermined"
        : "admissible";

    return {
      admissible: kind === "admissible",
      overallAdmissible: kind === "admissible",
      kind,
      ...(kind === "undetermined" && undeterminedVerdict?.kind === "undetermined"
        ? { detail: undeterminedVerdict.detail }
        : {}),
      verdicts,
      calls: verdicts,
      totalEstimatedResourceFee,
      ...(stagingRequired || windowStatus !== "unavailable"
        ? {
            staging: {
              windowSpent: windowStatus === "unavailable" ? null : initialWindowSpent,
              source: windowStatus,
              unavailable: stagingUnavailableDetail !== undefined,
            },
          }
        : {}),
    };
  }

  /**
   * Convenience for adapters that want a throw-on-refusal shape.
   *
   * Throws `GuardBlockedError` for both `blocked` and `undetermined` — an
   * interceptor that returned happily on `undetermined` would hand an agent a
   * green light the chain never gave.
   */
  async assertAllowed(call: ContractCall): Promise<PreFlightDecision & { allowed: true }> {
    const decision = await this.check(call);
    if (decision.allowed) return decision;
    if (decision.kind === "blocked") {
      const rawEvent = decision.diagnosticEvents?.[0];
      throw new GuardBlockedError({
        reason: decision.reason,
        stage: "preflight",
        detail: decision.detail,
        call,
        rawEvent,
      });
    }
    throw new PreFlightUndeterminedError(decision.detail, { cause: decision.error });
  }

  /**
   * Convenience for adapters that want a throw-on-refusal shape for batches.
   *
   * Throws `GuardBlockedError` if any call in the batch is blocked, or
   * `PreFlightUndeterminedError` if any call is undetermined.
   */
  async assertBatchAllowed(
    calls: ContractCall[],
    options?: CheckBatchOptions,
  ): Promise<PreFlightBatchDecision & { admissible: true }> {
    const decision = await this.checkBatch(calls, options);
    if (decision.admissible) return decision as PreFlightBatchDecision & { admissible: true };
    for (const verdict of decision.verdicts) {
      if (verdict.kind === "blocked") {
        throw new GuardBlockedError({
          reason: verdict.reason,
          stage: "preflight",
          detail: verdict.detail,
        });
      }
      if (verdict.kind === "undetermined") {
        throw new PreFlightUndeterminedError(verdict.detail, {
          ...(verdict.error === undefined ? {} : { cause: verdict.error }),
        });
      }
    }
    throw new PreFlightUndeterminedError(
      decision.kind === "undetermined" && decision.detail !== undefined
        ? decision.detail
        : "batch refused by guardrails",
    );
  }

  /**
   * Get a snapshot of the cache statistics.
   * @returns An object with hits, misses, invalidations, and size.
   */
  getCacheStats() {
    return {
      hits: this._hits,
      misses: this._misses,
      invalidations: this._invalidations,
      size: this.cache.size,
    };
  }
}

/** One-shot form, for callers that do not want to hold an interceptor. */
export function preflight(config: PreFlightConfig, call: ContractCall): Promise<PreFlightDecision> {
  return new PreFlightInterceptor(config).check(call);
}

/** One-shot form for batch pre-flight checks. */
export function preflightBatch(
  config: PreFlightConfig,
  calls: ContractCall[],
  options?: CheckBatchOptions,
): Promise<PreFlightBatchDecision> {
  return new PreFlightInterceptor(config).checkBatch(calls, options);
}

