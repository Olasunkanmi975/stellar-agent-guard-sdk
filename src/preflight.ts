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
import { createHash } from "node:crypto";
import { Keypair, StrKey, rpc, xdr } from "@stellar/stellar-sdk";
import { enforceCall } from "./invoke.ts";
import { GuardBlockedError, explainReason } from "./reasons.ts";
import type { ContractCall } from "./tx.ts";

/**
 * Thrown synchronously when a ContractCall has invalid shape or types
 * before any RPC round-trip is attempted.
 *
 * Distinguishes programmer errors (malformed contract ID, invalid symbol shape,
 * invalid argument types) from policy outcomes (blocked decisions).
 */
export class InvalidInputError extends Error {
  readonly field: string;
  readonly rule: string;
  readonly detail?: string | undefined;

  constructor(field: string, rule: string, detail?: string) {
    const message = detail
      ? `Invalid input for '${field}': violates rule '${rule}' (${detail})`
      : `Invalid input for '${field}': violates rule '${rule}'`;
    super(message);
    this.name = "InvalidInputError";
    this.field = field;
    this.rule = rule;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

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
export class PreFlightUndeterminedError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`stellar-agent-guard could not determine this action's status\n${detail}`);
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
    };

/** A caller-supplied policy revision token used as part of the cache key. */
export type PolicyRevision = string | number | bigint | boolean | null | undefined;

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
  guard: string;
  /** The key registered as the account's agent, used to sign the auth entry. */
  agent: Keypair;
  /** Classic account that pays fees and supplies the sequence number. */
  source: Keypair;
  /** Authorizers for non-guard requirements (e.g. an admin on a policy call). */
  accountSigners?: Keypair[];
  /**
   * Opt-in short-lived cache. Omit this property to preserve uncached behavior.
   * A cached verdict can be staler than one admitted transfer.
   */
  cache?: PreFlightCacheOptions;
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

function policyRevisionToken(revision: PolicyRevision): string {
  if (revision === undefined) return "unknown";
  if (revision === null) return "null";
  return `${typeof revision}:${String(revision)}`;
}

function hashPart(hash: ReturnType<typeof createHash>, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  hash.update(length);
  hash.update(bytes);
}

function callFingerprint(call: ContractCall): string {
  const hash = createHash("sha256");
  hashPart(hash, call.contract);
  hashPart(hash, call.fn);
  for (const arg of call.args) hashPart(hash, arg.toXDR());
  return hash.digest("hex");
}

function configFingerprint(config: PreFlightConfig): string {
  const hash = createHash("sha256");
  hashPart(hash, config.networkPassphrase);
  hashPart(hash, config.guard);
  hashPart(hash, config.source.publicKey());
  hashPart(hash, config.agent.publicKey());
  for (const signer of (config.accountSigners ?? []).map((keypair) => keypair.publicKey()).sort()) {
    hashPart(hash, signer);
  }
  return hash.digest("hex");
}

export class PreFlightInterceptor {
  private readonly config: PreFlightConfig;
  private readonly cacheOptions: PreFlightCacheOptions | undefined;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly namespace: string;

  constructor(config: PreFlightConfig) {
    this.config = config;
    this.cacheOptions = config.cache;
    this.validateCacheOptions();
    this.namespace = this.cacheOptions ? configFingerprint(config) : "";
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

    const now = Date.now();
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
      this.cache.clear();
      return;
    }
    const prefix = `${this.namespace}:${callFingerprint(call)}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /**
   * Decide whether `call` may proceed. Never broadcasts, never mutates, never
   * throws for a refusal — a block is a normal, expected result.
   */
  async check(call: ContractCall): Promise<PreFlightDecision> {
    validateContractCall(call);

    const context = await this.cacheContext(call);
    if (context) {
      const cached = this.cache.get(context.key);
      if (cached) {
        const now = Date.now();
        if (cached.ledger === context.ledger && cached.expiresAt > now) {
          return cached.decision;
        }
        this.cache.delete(context.key);
      }
    }
    const outcome = await enforceCall({
      server: this.config.server,
      source: this.config.source,
      call,
      networkPassphrase: this.config.networkPassphrase,
      guardAuth: { guard: this.config.guard, agent: this.config.agent },
      ...(this.config.accountSigners ? { accountSigners: this.config.accountSigners } : {}),
    });

    let decision: PreFlightDecision;
    if (outcome.kind === "error") {
      decision = { allowed: false, kind: "undetermined", detail: outcome.detail };
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
      const data = outcome.simulation.transactionData as unknown as
        | { getReadOnly?: () => unknown[]; getReadWrite?: () => unknown[] }
        | undefined;
      const footprintKeys =
        (data?.getReadOnly?.().length ?? 0) + (data?.getReadWrite?.().length ?? 0);
      decision = {
        allowed: true,
        kind: "admissible",
        estimatedResourceFee: BigInt(outcome.simulation.minResourceFee ?? 0),
        footprintKeys,
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
    }
    return decision;
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
      throw new GuardBlockedError({
        reason: decision.reason,
        stage: "preflight",
        detail: decision.detail,
      });
    }
    throw new PreFlightUndeterminedError(decision.detail);
  }
}

/** One-shot form, for callers that do not want to hold an interceptor. */
export function preflight(config: PreFlightConfig, call: ContractCall): Promise<PreFlightDecision> {
  return new PreFlightInterceptor(config).check(call);
}
