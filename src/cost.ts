/**
 * Cost pre-checking: what will this call cost, asked *before* it is submitted.
 *
 * ## Why this is in-process and simulation-priced
 *
 * The choice was made deliberately and is recorded in the README: a call is
 * priced from the **real enforced simulation**, not from a local cost profiler.
 * `soroban-cost-estimator` profiles a locally compiled WASM artifact through the
 * `stellar` CLI, which this SDK does not have and does not need — it never
 * compiles a contract, it calls one that is already deployed. Making the SDK
 * depend on a CLI artifact it does not produce would be inventing a requirement.
 *
 * The number is not modelled or approximated. Every `enforceCall` already
 * returns it: `simulation.minResourceFee` is the network's own price for
 * executing *this* call with the guard's `__check_auth` run as part of it, since
 * the enforced simulation is the one that actually exercises the account's
 * authorization. A cost pre-check therefore costs one simulation and no
 * transaction, and the estimate is the same value the submission will declare.
 *
 * ## What this does not claim
 *
 * The estimate is a *resource* fee against the ledger snapshot the simulation
 * saw. It is not a promise about the final charged amount if the ledger moves
 * under the submission — `invoke.ts` documents that case and retries it once —
 * and it does not include any future surge pricing. It is reported as an
 * estimate, with the inclusion fee shown separately so the two are never
 * conflated.
 *
 * ## A block is not a cost overrun
 *
 * A guard refusal is reported as `blocked`, not as a cheap success, and carries
 * an explicitly zero fee because a refusal happens before broadcast: nothing was
 * submitted, so nothing was charged. Folding a refusal into an "over budget"
 * answer would tell a caller their call was too expensive when the truth is that
 * it was never allowed.
 */
import { resolveLogger, type GuardLogger, type GuardLoggerInput } from "./logger.ts";
import { SorobanDataBuilder, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { InvalidFeeCeilingError } from "./errors.ts";
import { INCLUSION_FEE } from "./tx.ts";
import type { PreFlightDecision, PreFlightInterceptor } from "./preflight.ts";
import type { ContractCall } from "./tx.ts";
import type { PolicyConfig } from "./policy.ts";

/** Additive policy context exposed when a policy source is configured. */
export interface PolicyContext {
  /**
   * Whether the transaction is within the policy's per-transaction cap.
   * `true` if within cap, `false` if per-tx cap exceeded, or `null` if not determinable.
   */
  perTxCapOk: boolean | null;
  /**
   * Estimated remaining budget in the current rolling window.
   * `null` when the contract does not expose sufficient window state.
   *
   * NOTE: null means "not available / cannot be determined from current contract state",
   * NOT "zero remaining budget". The SDK never fabricates a zero budget.
   */
  windowRemainingEstimate: number | null;
  /**
   * The policy reason if the check was blocked or exceeded a constraint; `null` if allowed.
   */
  reason: string | null;
}

/**
 * Stroops in one XLM. Stellar defines 10^7 stroops per lumen, fixed by the
 * protocol — not a display choice.
 */
export const STROOPS_PER_XLM = 10_000_000n;

/**
 * Validate a fee ceiling without collapsing "omitted" into "zero".
 *
 * Only `undefined` means "no ceiling"; a caller that passes `0n` has chosen a
 * real, maximally strict policy and it must survive. Anything that is not a
 * non-negative `bigint` — including a `number`, a numeric string or `null` — is
 * rejected with a typed input error before any simulation runs.
 */
function validateFeeCeiling(value: unknown, field = "maxFeeStroops"): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new InvalidFeeCeilingError(field, value);
  }
  return value;
}

/**
 * Render a **non-negative** fee in stroops as an XLM decimal string, using
 * **integer arithmetic only**.
 *
 * ## Why negative values are refused
 *
 * This is a fee formatter, not a generic signed-unit formatter: a fee quote is
 * never negative on Stellar, so a negative input is an upstream sign error.
 * Formatting it as `-0.0000001` would put an impossible value into a log or UI
 * where it looks authoritative. `formatFee` therefore throws `TypeError` for a
 * negative `bigint` or a string carrying a sign, rather than inventing a
 * negative amount.
 *
 * ## Why there is no floating point here
 *
 * XLM has exactly 7 decimal places, so every stroop value is a rational number
 * with a denominator that is a power of ten — representable exactly as a decimal
 * string and *not* representable exactly as an IEEE-754 binary64. `0.1` stroops
 * is not a thing, but `stroops / 1e7` in `Number` lands on 0.1 for `1_000_000`
 * and drifts for others, and `Number` cannot even hold integers above 2^53.
 * This is a security tool that prints money-adjacent numbers: a formatter that
 * rounds silently is worse than one that refuses, so the division is done on
 * `bigint` and the digits are produced by string padding. Nothing here ever
 * passes through `Number`, `parseFloat`, `/`, or `toFixed`.
 *
 * ## Output convention: minimal, exact, no trailing garbage
 *
 * The result is the shortest decimal string that equals the input exactly —
 * trailing fractional zeros are dropped and a whole number prints with no
 * separator: `10_000_000` → `"1"`, `1_000_000` → `"0.1"` (not `"0.1000000"`),
 * `0` → `"0"`, `1` → `"0.0000001"`. The alternative, a fixed 7-dp pad, adds
 * zeros that imply precision the fee does not have; the minimal form is exact
 * in both directions, so `formatFee(parse(x)) === x` holds for every value this
 * function accepts.
 *
 * Input is `bigint` (exact, and the only way to express values above 2^53) or an
 * unsigned base-10 integer string. A `number` is rejected outright rather than
 * coerced: by the time it reaches this function any precision loss has already
 * happened, and accepting it would launder that loss into output that looks
 * authoritative.
 */
export function formatFee(stroops: bigint | string): string {
  const value = parseStroops(stroops);

  const whole = value / STROOPS_PER_XLM;
  const fraction = value % STROOPS_PER_XLM;

  // Exact decimal digits: pad to 7 places, then drop trailing zeros. String
  // padding is the whole trick — it is the step that would silently become a
  // rounding operation if any of this were done in floating point.
  const fractionDigits = fraction.toString().padStart(7, "0").replace(/0+$/, "");
  return fractionDigits.length === 0 ? whole.toString() : `${whole}.${fractionDigits}`;
}

/** Parse and reject fee input without ever routing it through `Number`. */
function parseStroops(stroops: bigint | string): bigint {
  if (typeof stroops === "bigint") {
    if (stroops < 0n) {
      throw new TypeError(
        `formatFee expects a non-negative fee in stroops, got ${stroops}n ` +
          `(a fee quote cannot be negative; a negative value is an upstream sign error)`,
      );
    }
    return stroops;
  }
  if (typeof stroops === "string") {
    if (/^\d+$/.test(stroops)) return BigInt(stroops);
    throw new TypeError(
      `formatFee expects a non-negative base-10 integer stroops value, got ${JSON.stringify(stroops)} ` +
        `(fee math is integer-only: XLM has 7 decimals, and binary floating point cannot ` +
        `represent them exactly)`,
    );
  }
  throw new TypeError(
    `formatFee expects bigint | string, got ${typeof stroops} ` +
      `(a number would already have lost precision before reaching this function)`,
  );
}

/**
 * Resource limits and footprint sizes declared by a Soroban simulation.
 *
 * The names mirror `SorobanResources` in stellar-sdk v17: `instructions`,
 * `diskReadBytes`, and `writeBytes` are the actual resource fields. The SDK
 * simulation payload does not contain a `memBytes` field, so this type does
 * not invent one. `readOnlyEntries` and `readWriteEntries` are counts derived
 * from the payload's footprint arrays; `storageEntries` is their sum.
 */
export interface ResourceBreakdown {
  /** `SorobanResources.instructions` — CPU instruction budget. */
  instructions: number;
  /** `SorobanResources.diskReadBytes` — ledger bytes read from disk. */
  diskReadBytes: number;
  /** `SorobanResources.writeBytes` — ledger bytes written. */
  writeBytes: number;
  /** Number of read-only ledger keys in the simulation footprint. */
  readOnlyEntries: number;
  /** Number of read-write ledger keys in the simulation footprint. */
  readWriteEntries: number;
  /** Total number of ledger keys in the simulation footprint. */
  storageEntries: number;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as Record<string, unknown>;
}

function firstDefined(value: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (value[key] !== undefined) return value[key];
  }
  return undefined;
}

function resourceCount(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  }
  if (typeof value === "string" && value.trim() === "") return undefined;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function footprintCounts(value: unknown):
  | { readOnlyEntries: number; readWriteEntries: number; storageEntries: number }
  | undefined {
  const footprint = recordOf(value);
  const readOnly = footprint
    ? firstDefined(footprint, "readOnly", "read_only")
    : undefined;
  const readWrite = footprint
    ? firstDefined(footprint, "readWrite", "read_write")
    : undefined;
  if (!Array.isArray(readOnly) || !Array.isArray(readWrite)) return undefined;
  const readOnlyEntries = readOnly.length;
  const readWriteEntries = readWrite.length;
  return {
    readOnlyEntries,
    readWriteEntries,
    storageEntries: readOnlyEntries + readWriteEntries,
  };
}

/**
 * Parse the resource block from a stellar-sdk simulation response.
 *
 * The public SDK parser normally gives callers a `SorobanDataBuilder`; the
 * structural fallbacks also accept its built XDR value and the wire-shaped
 * object used by recorded RPC fixtures. Missing or malformed fields return
 * `undefined` as a whole, never a partially fabricated zero-filled breakdown.
 */
export function resourceBreakdownFromSimulation(simulation: unknown): ResourceBreakdown | undefined {
  const response = recordOf(simulation);
  const transactionData = response?.transactionData ?? simulation;
  let transaction: Record<string, unknown> | undefined;
  if (typeof transactionData === "string") {
    if (transactionData.trim() === "") return undefined;
    try {
      transaction = recordOf(new SorobanDataBuilder(transactionData).build());
    } catch {
      return undefined;
    }
  } else {
    transaction = recordOf(transactionData);
  }
  if (!transaction) return undefined;

  let built: unknown = transaction;
  if (typeof transaction.build === "function") {
    try {
      built = (transaction.build as () => unknown)();
    } catch {
      return undefined;
    }
  }

  const builtRecord = recordOf(built);
  if (!builtRecord) return undefined;
  const resources = recordOf(builtRecord.resources) ?? builtRecord;
  const instructions = resourceCount(resources.instructions);
  const diskReadBytes = resourceCount(
    firstDefined(resources, "diskReadBytes", "disk_read_bytes"),
  );
  const writeBytes = resourceCount(firstDefined(resources, "writeBytes", "write_bytes"));
  const footprint = footprintCounts(resources.footprint);
  if (
    instructions === undefined ||
    diskReadBytes === undefined ||
    writeBytes === undefined ||
    footprint === undefined
  ) {
    return undefined;
  }

  return { instructions, diskReadBytes, writeBytes, ...footprint };
}

/** Optional resource details carried by a pre-flight admissible decision. */
interface CostResultBreakdown {
  /** Present only when the simulation exposed a complete resource block. */
  breakdown?: ResourceBreakdown;
}

export interface CostPreCheckConfig {
  /**
   * The pre-flight interceptor whose `check` produces the network's own price.
   *
   * Typed structurally so a caller can supply the real `PreFlightInterceptor`
   * (the normal case) or a stand-in — the budget arithmetic is pure and worth
   * testing without a network.
   */
  interceptor: Pick<PreFlightInterceptor, "check">;
  /**
   * Refuse (as `over_budget`) when the estimated *total* fee exceeds this many
   * stroops. Must be a non-negative `bigint`; a negative, `number`, string or
   * other value throws `InvalidFeeCeilingError` at construction.
   *
   * Omitted means "price it, never object to the price". `0n` is a real
   * ceiling, distinct from omission: every quoted total (which includes the
   * inclusion fee) is then over budget.
   */
  maxFeeStroops?: bigint | undefined;
  /**
   * Optional log sink for this pre-checker's decision points: the priced verdict
   * and whether the ceiling was exceeded.
   *
   * Omitted — the default — the pre-checker says nothing at all. The cost
   * decision is still returned either way; the logger only decides who hears
   * about it.
   */
  logger?: GuardLoggerInput | undefined;
  /**
   * Opt-in policy source (contract address string or PolicyConfig/GuardPolicy).
   * When provided, `policyContext` is populated with policy-relative context.
   * When omitted or null, `policyContext` is `null`.
   */
  policySource?: string | PolicyConfig | null | undefined;
  /**
   * Optional policy or contract address. Alias for `policySource`.
   */
  policy?: string | PolicyConfig | null | undefined;
}

/** The two fee components, kept separate so they are never conflated. */
export interface FeeBreakdown {
  /** The network's price for the call's resources, from the simulation. */
  resourceFeeStroops: bigint;
  /** The inclusion fee the SDK declares for a one-operation transaction. */
  inclusionFeeStroops: bigint;
  /** `resourceFeeStroops + inclusionFeeStroops` — what the caller actually pays. */
  totalFeeStroops: bigint;
}

/**
 * Ledger marker for the snapshot a simulation-based quote describes.
 *
 * **Informational, not an execution guarantee.** Two quotes with the same
 * provenance were priced against the same ledger state; a quote whose ledger is
 * older than the current chain may no longer reflect what submission will
 * charge. The SDK does not promise that a transaction will land in this ledger.
 */
export interface CostProvenance {
  /**
   * Ledger sequence the pricing simulation observed.
   *
   * Taken from that same simulation response (`latestLedger`), never from a
   * second RPC read that could race ahead of the state that was actually priced.
   */
  ledger: number;
}

export type CostDecision =
  | ({
      kind: "within_budget";
      allowed: true;
      /** Ledger keys the call is priced to touch, from the same simulation. */
      footprintKeys: number;
      /** The ceiling this was judged against, or `null` when none was given. */
      feeCeilingStroops: bigint | null;
      /** Additive policy-relative context when a policy source is configured; null otherwise. */
      policyContext: PolicyContext | null;
      /** Ledger snapshot this quote describes, or `null` when it was unavailable. */
      provenance: CostProvenance | null;
    } & FeeBreakdown &
      CostResultBreakdown)
  | ({
      kind: "over_budget";
      /** Not allowed to proceed *at this price* — the guard itself may allow it. */
      allowed: false;
      footprintKeys: number;
      feeCeilingStroops: bigint;
      policyContext: PolicyContext | null;
      /** Ledger snapshot this quote describes, or `null` when it was unavailable. */
      provenance: CostProvenance | null;
    } & FeeBreakdown &
      CostResultBreakdown)
  | ({
      kind: "blocked";
      /** The guard refused. This is not a cost problem. */
      allowed: false;
      reason: string;
      explanation: string;
      detail: string;
      /** Zero by construction: a refusal precedes broadcast, so nothing is charged. */
      resourceFeeStroops: bigint;
      inclusionFeeStroops: bigint;
      totalFeeStroops: bigint;
      policyContext: PolicyContext | null;
      /** A refusal is not simulation-priced, so there is no ledger provenance. */
      provenance: CostProvenance | null;
    } & CostResultBreakdown)
  | ({
      kind: "undetermined";
      /** Enforcement could not reach a decision; treated as not-allowed. */
      allowed: false;
      detail: string;
      resourceFeeStroops: bigint;
      inclusionFeeStroops: bigint;
      totalFeeStroops: bigint;
      policyContext: PolicyContext | null;
      /** No usable simulation means no ledger provenance. */
      provenance: CostProvenance | null;
    } & CostResultBreakdown);

/** Type alias matching documentation nomenclature. */
export type CostPreCheckResult = CostDecision;

/**
 * Per-call options for cost checking, including fee ceilings and opt-in policy context.
 */
export interface CostPreCheckOptions {
  /** Opt-in policy source (contract address or PolicyConfig/GuardPolicy). */
  policySource?: string | PolicyConfig | null | undefined;
  /** Optional policy or contract address. Alias for `policySource`. */
  policy?: string | PolicyConfig | null | undefined;
  /**
   * Override the fee ceiling in stroops for this check. Must be a non-negative
   * `bigint`; invalid values throw `InvalidFeeCeilingError` before the
   * interceptor is called. `0n` is a real ceiling, distinct from omission.
   */
  maxFeeStroops?: bigint | undefined;
  /**
   * Caller-owned cancellation for the underlying enforced simulation. An
   * already-aborted signal returns before any RPC call; a mid-flight abort or a
   * fired timeout yields a fail-closed `undetermined` verdict (and therefore an
   * `undetermined` cost decision) carrying the typed `RpcTimeoutError`.
   */
  signal?: AbortSignal | undefined;
  /**
   * Bound on the underlying RPC call, in milliseconds; `0` disables it. A fired
   * timeout is reported exactly like an abort — never as an admissible verdict.
   */
  timeoutMs?: number | undefined;
}

/**
 * One interceptor verdict and the cost of the exact simulation that produced it.
 *
 * `cost` is derived from `decision`, never from a second simulation, so the two
 * always describe the same ledger snapshot. See `checkWithCost`.
 */
export interface CostWithDecision {
  /** The verdict, exactly as `PreFlightInterceptor.check` returns it. */
  decision: PreFlightDecision;
  /** The cost view of that same verdict. */
  cost: CostDecision;
}

/**
 * Split a simulation's resource fee into the two components a caller is charged.
 *
 * Pure: no network, no configuration. The inclusion fee is the SDK's own
 * declared floor for a single-operation transaction (`INCLUSION_FEE` in `tx.ts`),
 * which is the same value the built envelope uses, so this cannot drift from what
 * is actually submitted.
 */
export function feeBreakdown(resourceFeeStroops: bigint): FeeBreakdown {
  const inclusionFeeStroops = BigInt(INCLUSION_FEE);
  return {
    resourceFeeStroops,
    inclusionFeeStroops,
    totalFeeStroops: resourceFeeStroops + inclusionFeeStroops,
  };
}

/**
 * Is the estimated total over the caller's ceiling?
 *
 * A missing ceiling is not a zero ceiling: `null`/`undefined` means "no
 * objection", never "refuse everything that costs anything".
 */
export function exceedsCeiling(
  totalFeeStroops: bigint,
  ceilingStroops: bigint | null | undefined,
): boolean {
  if (ceilingStroops === null || ceilingStroops === undefined) return false;
  return totalFeeStroops > validateFeeCeiling(ceilingStroops);
}

/** A compact, log-friendly rendering of a cost decision. */
export function describeCostDecision(
  decision:
    | CostDecision
    | {
        kind: "within_budget" | "over_budget" | "blocked" | "undetermined";
        allowed: boolean;
        totalFeeStroops: bigint;
        resourceFeeStroops?: bigint | undefined;
        inclusionFeeStroops?: bigint | undefined;
        feeCeilingStroops?: bigint | null | undefined;
        reason?: string | undefined;
        policyContext?: PolicyContext | null | undefined;
      },
): string {
  switch (decision.kind) {
    case "within_budget": {
      const ceiling =
        decision.feeCeilingStroops === null || decision.feeCeilingStroops === undefined
          ? "no ceiling"
          : `ceiling ${decision.feeCeilingStroops}`;
      return `within budget: ${decision.totalFeeStroops} stroops (${decision.resourceFeeStroops ?? 0n} resource + ${decision.inclusionFeeStroops ?? 0n} inclusion), ${ceiling}`;
    }
    case "over_budget":
      return `over budget: ${decision.totalFeeStroops} stroops exceeds ceiling ${decision.feeCeilingStroops}`;
    case "blocked":
      return `blocked before broadcast (${decision.reason ?? "unknown"}): 0 stroops charged`;
    case "undetermined":
      return "undetermined: not priced, not executed";
  }
}

/** Extract transfer amount from a call if it represents a token transfer. */
function extractCallAmount(call: ContractCall): bigint | null {
  if (call.fn === "transfer" && call.args.length >= 3) {
    try {
      const val = scValToNative(call.args[2] as xdr.ScVal);
      if (typeof val === "bigint") return val;
      if (typeof val === "number") return BigInt(val);
    } catch {
      return null;
    }
  }
  if (call.fn === "transfer_from" && call.args.length >= 4) {
    try {
      const val = scValToNative(call.args[3] as xdr.ScVal);
      if (typeof val === "bigint") return val;
      if (typeof val === "number") return BigInt(val);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Derive additive policy-relative context from the live check response.
 *
 * When no policy source is configured, returns null.
 * When a policy source is supplied:
 *  - perTxCapOk: true if admissible or window_cap_exceeded; false if per_tx_cap_exceeded;
 *    or evaluated against policy.per_tx_cap if a static policy is provided.
 *  - windowRemainingEstimate: null when the contract does not expose sufficient window state.
 *    NOTE: null means unknown/unavailable, NEVER zero budget.
 *  - reason: the policy block reason or null if permitted.
 */
function computePolicyContext(
  policySource: string | PolicyConfig | null | undefined,
  decision: PreFlightDecision,
  call: ContractCall,
): PolicyContext | null {
  if (!policySource) {
    return null;
  }

  const policy =
    typeof policySource === "object" && policySource !== null && "per_tx_cap" in policySource
      ? (policySource as PolicyConfig)
      : null;

  if (decision.kind === "admissible") {
    return {
      perTxCapOk: true,
      windowRemainingEstimate: null,
      reason: null,
    };
  }

  if (decision.kind === "blocked") {
    let perTxCapOk: boolean | null = null;
    if (decision.reason === "per_tx_cap_exceeded") {
      perTxCapOk = false;
    } else if (decision.reason === "window_cap_exceeded") {
      perTxCapOk = true;
    } else if (policy) {
      const amount = extractCallAmount(call);
      if (amount !== null) {
        perTxCapOk = amount <= policy.per_tx_cap;
      }
    }

    return {
      perTxCapOk,
      windowRemainingEstimate: null,
      reason: decision.reason,
    };
  }

  // decision.kind === "undetermined"
  return {
    perTxCapOk: null,
    windowRemainingEstimate: null,
    reason: null,
  };
}

/**
 * Price a call, and optionally object to the price.
 *
 * Runs the same enforcement question the pre-flight interceptor runs — one
 * simulation of the real `__check_auth` — and reports the result in cost terms.
 * Nothing is broadcast, so calling this repeatedly costs only RPC time.
 *
 * When an opt-in policy source is configured, returns additive `policyContext`.
 */
export class CostPreChecker {
  private readonly config: CostPreCheckConfig;
  private readonly logger: GuardLogger;
  private readonly maxFeeStroops: bigint | undefined;

  constructor(config: CostPreCheckConfig) {
    this.config = config;
    // Validate at the configuration boundary: a typo must fail here, not turn
    // every later quote into a fabricated over-budget answer.
    this.maxFeeStroops =
      config.maxFeeStroops === undefined
        ? undefined
        : validateFeeCeiling(config.maxFeeStroops);
    this.logger = resolveLogger(config.logger);
  }

  /** Price a call. Equivalent to `(await this.checkWithCost(call, options)).cost`. */
  async check(
    call: ContractCall,
    options?: CostPreCheckOptions,
  ): Promise<CostDecision> {
    return (await this.checkWithCost(call, options)).cost;
  }

  /**
   * Price a call **and** return the interceptor's verdict, from one enforced
   * simulation.
   *
   * ## Why this exists — and why not to call `check()` twice
   *
   * The obvious consumer flow is `interceptor.check(call)` for the policy
   * verdict, then `costChecker.check(call)` for the price. Those are two
   * simulations of the same call, and the problem is not only the extra RPC: the
   * two simulations see two ledger snapshots, so the fee the caller is *told* can
   * differ from the fee implied by the verdict that was actually enforced. A
   * price that no longer corresponds to the approved decision is a correctness
   * bug in a security tool, not a performance one — so this method asks the
   * interceptor once and derives both results from that one verdict.
   *
   * Additive: `check()`, `precheckCost()` and `PreFlightInterceptor.check()` are
   * unchanged.
   */
  async checkWithCost(
    call: ContractCall,
    options?: CostPreCheckOptions,
  ): Promise<CostWithDecision> {
    // Resolve and validate the ceiling *before* the simulation: a bad budget
    // policy must never spend an RPC or be masked by a guard verdict. Only an
    // absent per-call ceiling falls back to configuration; 0n is preserved.
    const ceiling =
      options?.maxFeeStroops !== undefined
        ? validateFeeCeiling(options.maxFeeStroops)
        : this.maxFeeStroops ?? null;

    const decision = await this.config.interceptor.check(call, {
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
    const policySource =
      options?.policySource ?? options?.policy ?? this.config.policySource ?? this.config.policy;
    const policyContext = computePolicyContext(policySource, decision, call);
    const cost = this.costOf(decision, policyContext, ceiling);
    // The one place a cost decision is produced, so the one place it is logged:
    // `check()` and both one-shot helpers funnel through here, and a second log
    // site would mean a caller could see the same decision twice.
    if (cost.kind === "over_budget") {
      this.logger.warn(`call exceeds the fee ceiling: ${describeCostDecision(cost)}`, {
        totalFeeStroops: cost.totalFeeStroops.toString(),
        feeCeilingStroops: cost.feeCeilingStroops.toString(),
      });
    } else if (cost.kind === "undetermined") {
      this.logger.warn(`call could not be priced: ${cost.detail}`);
    } else {
      this.logger.debug(describeCostDecision(cost));
    }
    return { decision, cost };
  }

  /** The pure cost view of an already-obtained verdict. No network, no state. */
  private costOf(
    decision: PreFlightDecision,
    policyContext: PolicyContext | null,
    ceiling: bigint | null,
  ): CostDecision {
    // Provenance travels with the verdict from the same simulation. A block or
    // an undetermined run has no priced snapshot, so it is explicitly null
    // rather than an invented ledger marker.
    const provenance = decision.kind === "admissible" ? decision.provenance ?? null : null;
    if (decision.kind === "blocked") {
      return {
        kind: "blocked",
        allowed: false,
        reason: decision.reason,
        explanation: decision.explanation,
        detail: decision.detail,
        resourceFeeStroops: 0n,
        inclusionFeeStroops: 0n,
        totalFeeStroops: 0n,
        policyContext,
        provenance,
      };
    }
    if (decision.kind === "undetermined") {
      return {
        kind: "undetermined",
        allowed: false,
        detail: decision.detail,
        resourceFeeStroops: 0n,
        inclusionFeeStroops: 0n,
        totalFeeStroops: 0n,
        policyContext,
        provenance,
      };
    }

    const fees = feeBreakdown(decision.estimatedResourceFee);
    if (exceedsCeiling(fees.totalFeeStroops, ceiling)) {
      return {
        kind: "over_budget",
        allowed: false,
        ...fees,
        footprintKeys: decision.footprintKeys,
        feeCeilingStroops: ceiling as bigint,
        policyContext,
        provenance,
        ...(decision.resourceBreakdown ? { breakdown: decision.resourceBreakdown } : {}),
      };
    }
    return {
      kind: "within_budget",
      allowed: true,
      ...fees,
      footprintKeys: decision.footprintKeys,
      feeCeilingStroops: ceiling,
      policyContext,
      provenance,
      ...(decision.resourceBreakdown ? { breakdown: decision.resourceBreakdown } : {}),
    };
  }
}

/** One-shot form, for callers that do not want to hold a pre-checker. */
export function precheckCost(
  config: CostPreCheckConfig,
  call: ContractCall,
  options?: CostPreCheckOptions,
): Promise<CostDecision> {
  return new CostPreChecker(config).check(call, options);
}

/**
 * One-shot form of `checkWithCost`: one simulation, both the verdict and the
 * price. Prefer this over a `preflight()` + `precheckCost()` pair.
 */
export function precheckCostWithDecision(
  config: CostPreCheckConfig,
  call: ContractCall,
  options?: CostPreCheckOptions,
): Promise<CostWithDecision> {
  return new CostPreChecker(config).checkWithCost(call, options);
}
