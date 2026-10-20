/**
 * The guard contract's block reasons.
 *
 * These mirror `Error`/`BlockReason` in
 * `stellar-agent-guard-contracts/src/types.rs` exactly — both the numeric
 * enum value (as returned in a `CheckResult::Blocked(Symbol)` payload from
 * `check`) and the stable snake_case symbol the contract publishes as an event
 * topic (`event_auth_checked` → `blocked, <reason>`). Off-chain code and on-chain
 * code therefore share one vocabulary, which is why this table is duplicated
 * rather than inferred.
 *
 * The table is checked against the contracts repo's own vocabulary fixture —
 * `tests/fixtures/vendor/auth-checked-vocabulary.json`, vendored from
 * `stellar-agent-guard-contracts/tests/fixtures/auth-checked-vocabulary.json` —
 * so a reason the contract adds is a failing test here until this table is
 * extended, rather than a symbol the SDK silently mislabels.
 */
import { GuardError } from "./errors.ts";

export const GUARD_REASON_CODES = {
  unauthorized: 1,
  already_initialized: 2,
  not_initialized: 3,
  invalid_config: 4,
  invalid_amount: 5,
  no_pending_admin: 6,
  admin_frozen: 10,
  heartbeat_expired: 11,
  no_policy: 12,
  paused: 13,
  outside_active_window: 14,
  asset_not_allowed: 20,
  recipient_not_allowed: 21,
  per_tx_cap_exceeded: 22,
  window_cap_exceeded: 23,
  protocol_not_allowed: 24,
  function_not_allowed: 25,
  unknown_contract: 26,
  self_function_not_allowed: 27,
  create_contract_not_allowed: 28,
  recipient_blocked: 29,
  protocol_call_rate_exceeded: 30,
  decision_invariant_violation: 31,
  asset_fn_not_allowed: 32,
  too_many_auth_contexts: 33,
} as const;

/**
 * The guard's block reasons, as a symbol-only union derived from the single
 * source above.
 *
 * Numeric codes stay runtime-side (`GUARD_REASON_CODES`); the type is intentionally
 * symbol-only so a value cannot carry a code where the contract emits a symbol.
 * Use this instead of `string` wherever a value must be one of the contract's
 * known reasons.
 */
export type GuardReason = keyof typeof GUARD_REASON_CODES;

/**
 * The reason vocabulary, derived from the single source above.
 *
 * Every reason is listed exactly once in this module (`GUARD_REASON_CODES`);
 * this object only reshapes it into symbol -> symbol so callers can enumerate
 * the vocabulary without a second, drift-prone literal. `tests/unit/reasons.test.ts`
 * keeps its keys in lockstep with the vendored contract fixture in both
 * directions.
 */
export const GUARD_REASONS: Readonly<Record<GuardReason, GuardReason>> = Object.freeze(
  (Object.keys(GUARD_REASON_CODES) as GuardReason[]).reduce(
    (reasons, reason) => {
      reasons[reason] = reason;
      return reasons;
    },
    {} as Record<GuardReason, GuardReason>,
  ),
);

/**
 * @deprecated Use `GuardReason`. Kept as an alias so existing imports keep
 * compiling; new code should import the canonical name.
 */
export type GuardReasonName = GuardReason;

/** True when `value` is one of the contract's known reason symbols. */
export function isGuardReason(value: unknown): value is GuardReason {
  return typeof value === "string" && value in GUARD_REASON_CODES;
}

const BY_CODE = new Map<number, GuardReason>(
  Object.entries(GUARD_REASON_CODES).map(([name, code]) => [code, name as GuardReason]),
);

/**
 * A reason's stable message keys plus its numeric contract code (issue #96).
 *
 * The keys — not concatenated English sentences — are the contract a consumer
 * builds against: a dashboard can look up its own translation for
 * `bodyKey`, and a locale change never churns the diff of a consumer that only
 * reads the keys. The keys are namespaced (`guard.reason.<reason>.<part>`) and
 * derived from the reason name, so they cannot drift from the vocabulary above.
 */
export interface ReasonMessage {
  /** The contract's numeric enum value for this reason. */
  code: number;
  /** Key for a short human title, e.g. a table row heading. */
  titleKey: string;
  /** Key for the one-line explanation returned by `explainReason`. */
  bodyKey: string;
  /** Key for operator remediation guidance. */
  remediationKey: string;
}

/**
 * The reason structure map, derived from the single `GUARD_REASON_CODES` source
 * so a reason cannot exist in one and not the other. This is the map a consumer
 * iterates to render a table or to key its own translations; the English text
 * itself lives in `reasonMessagesEn`.
 */
export const reasonMessages: Readonly<Record<GuardReason, ReasonMessage>> = Object.freeze(
  (Object.keys(GUARD_REASON_CODES) as GuardReason[]).reduce(
    (messages, reason) => {
      messages[reason] = {
        code: GUARD_REASON_CODES[reason],
        titleKey: `guard.reason.${reason}.title`,
        bodyKey: `guard.reason.${reason}.body`,
        remediationKey: `guard.reason.${reason}.remediation`,
      };
      return messages;
    },
    {} as Record<GuardReason, ReasonMessage>,
  ),
);

/** The three pieces of operator-facing English text for one reason. */
export interface ReasonMessageText {
  /** Short heading, e.g. "Per-transaction cap exceeded". */
  title: string;
  /** One-line meaning; `explainReason` returns this by default. */
  body: string;
  /** What an operator or agent can do about it. */
  remediation: string;
}

/**
 * A locale's catalog: message key -> translated string. Missing keys fall back
 * to the English default, so a partial translation is safe to ship.
 */
export type ReasonMessageCatalog = Readonly<Record<string, string>>;

/**
 * The built-in English messages, keyed by reason (issue #96).
 *
 * This is the zero-dependency default locale: no i18n framework is pulled in,
 * just maps. `explainReason(reason)` returns `body` byte-for-byte as the SDK
 * always has; `title` and `remediation` are the additional text a table or an
 * operator alert can use without the SDK inventing a format for them.
 */
export const reasonMessagesEn: Readonly<Record<GuardReason, ReasonMessageText>> = Object.freeze({
  unauthorized: {
    title: "Unauthorized agent key",
    body: "The presented signature did not verify against the account's registered agent key.",
    remediation: "Register the agent key on the guard account, or sign with the registered key.",
  },
  already_initialized: {
    title: "Already initialized",
    body: "The guard account has already been initialized.",
    remediation: "Read the existing guard state instead of initializing it again.",
  },
  not_initialized: {
    title: "Guard not initialized",
    body: "The guard account has no registered agent key yet.",
    remediation: "Initialize the guard account and register an agent key.",
  },
  invalid_config: {
    title: "Invalid policy configuration",
    body: "The policy configuration was rejected by validation and was not applied.",
    remediation: "Fix the failing validation rules and re-submit the policy.",
  },
  invalid_amount: {
    title: "Invalid amount",
    body: "The transfer amount was zero or negative.",
    remediation: "Send a positive transfer amount.",
  },
  no_pending_admin: {
    title: "No pending admin rotation",
    body: "The account has no pending admin rotation to confirm or cancel.",
    remediation: "Start an admin rotation first, then confirm or cancel it.",
  },
  admin_frozen: {
    title: "Account frozen",
    body: "An admin froze the account (freeze), or the dead-man switch grace window lapsed.",
    remediation: "Unfreeze the account with an admin signature, or check the dead-man switch.",
  },
  heartbeat_expired: {
    title: "Heartbeat expired",
    body: "The dead-man switch fired: no heartbeat within the policy's grace window, so the account is frozen until an admin unfreezes it.",
    remediation: "Have an admin unfreeze the account, then resume agent heartbeats.",
  },
  no_policy: {
    title: "No policy installed",
    body: "No policy is installed (never set, or revoked) — the account is default-deny.",
    remediation: "Install a policy for the account before the agent transacts.",
  },
  paused: {
    title: "Policy paused",
    body: "The policy's admin kill switch is engaged.",
    remediation: "Clear the policy's paused flag as the policy admin.",
  },
  outside_active_window: {
    title: "Outside active window",
    body: "The current ledger time is outside the policy's active_from/active_until window.",
    remediation: "Retry within the policy's active_from/active_until window.",
  },
  asset_not_allowed: {
    title: "Asset not allowed",
    body: "The SAC token being called is not in the policy's assets list.",
    remediation: "Add the SAC token to the policy's assets list.",
  },
  recipient_not_allowed: {
    title: "Recipient not allowed",
    body: "The transfer recipient is not in the policy's recipients allowlist.",
    remediation: "Add the recipient to the policy's allowlist.",
  },
  per_tx_cap_exceeded: {
    title: "Per-transaction cap exceeded",
    body: "The transfer amount exceeds the policy's per-transaction cap.",
    remediation: "Reduce the transfer to the policy's per-transaction cap or below.",
  },
  window_cap_exceeded: {
    title: "Rolling-window cap exceeded",
    body: "The transfer would push cumulative spend over the rolling-window cap.",
    remediation: "Wait for the rolling window to free capacity, or reduce the amount.",
  },
  protocol_not_allowed: {
    title: "Protocol not allowed",
    body: "The contract being called is not in the policy's protocols allowlist.",
    remediation: "Add the contract to the policy's protocols allowlist.",
  },
  function_not_allowed: {
    title: "Function not allowed",
    body: "The function being called on an allowlisted contract is not in its function allowlist.",
    remediation: "Add the function to the allowlisted contract's function list.",
  },
  unknown_contract: {
    title: "Unknown contract",
    body: "The contract being called is neither the account itself, an allowlisted asset, nor an allowlisted protocol (default deny).",
    remediation: "Allowlist the contract as an asset or protocol, or call the account itself.",
  },
  self_function_not_allowed: {
    title: "Guard function not permitted",
    body: "The call targets a guard function that the agent key may not invoke.",
    remediation: "Invoke the guard function from an admin key, not the agent key.",
  },
  create_contract_not_allowed: {
    title: "Contract creation not permitted",
    body: "The account may not authorize contract creation.",
    remediation: "Create the contract from an admin account instead of the guarded account.",
  },
  recipient_blocked: {
    title: "Recipient blocked",
    body: "The transfer recipient is explicitly blocked by the account's policy.",
    remediation: "Send to a different recipient, or remove the block if it is no longer wanted.",
  },
  protocol_call_rate_exceeded: {
    title: "Protocol call rate exceeded",
    body: "The call would push the rolling protocol-call count past its configured limit.",
    remediation: "Wait for the rolling window to free capacity, or make fewer protocol calls.",
  },
  decision_invariant_violation: {
    title: "Decision invariant violation",
    body: "The guard's decision engine hit an internal invariant, so the call was refused rather than allowed.",
    remediation: "Treat this as a guard defect: capture the call and report it to the contract maintainers.",
  },
  asset_fn_not_allowed: {
    title: "Asset function not permitted",
    body: "The call invoked a function other than `transfer` on an allowlisted asset.",
    remediation: "Call `transfer`, or allowlist the asset's function explicitly.",
  },
  too_many_auth_contexts: {
    title: "Too many authorization contexts",
    body: "The call carried more authorization contexts than the guard's decision engine evaluates.",
    remediation: "Split the call so each authorization carries fewer contexts.",
  },
});

export function reasonNameFromCode(code: number): GuardReason | undefined {
  return BY_CODE.get(code);
}

/** Accepts either the numeric enum value or its snake_case name. */
export function reasonName(reason: number | string): GuardReason | string {
  if (typeof reason === "number") return BY_CODE.get(reason) ?? `unknown_reason_${reason}`;
  return reason;
}

/**
 * Human-readable, one-line explanation for a guard reason.
 *
 * The default call is unchanged: `explainReason(reason)` returns the same
 * English string it always has (the `body` from `reasonMessagesEn`), so no
 * existing caller sees a different refusal. Two optional arguments make it
 * localisable without a framework (issue #96):
 *
 * - `locale` is a `key -> translation` catalog, typically built from
 *   `reasonMessages[reason].bodyKey`. A key the catalog omits falls back to
 *   English, so a partial translation is safe.
 * - `overrides` lets a consumer replace individual reasons outright (theming a
 *   dashboard, house wording) without forking the SDK.
 *
 * An unrecognised reason is still never thrown on: it yields
 * `Unrecognised guard reason: <value>`, exactly as before.
 */
export function explainReason(
  reason: number | string,
  locale?: ReasonMessageCatalog,
  overrides?: Partial<Record<GuardReason, string>>,
): string {
  const name = reasonName(reason);
  if (!isGuardReason(name)) {
    return `Unrecognised guard reason: ${String(reason)}`;
  }
  const override = overrides?.[name];
  if (override !== undefined) return override;
  const english = reasonMessagesEn[name].body;
  if (locale === undefined) return english;
  return locale[reasonMessages[name].bodyKey] ?? english;
}

import type { ContractCall } from "./tx.ts";

/**
 * Parameters for constructing a `GuardBlockedError`.
 */
export interface GuardBlockedErrorParams {
  reason: number | string;
  stage: "preflight" | "submission";
  detail?: string | undefined;
  charged?: boolean | undefined;
  call?: ContractCall | undefined;
  rawEvent?: unknown | undefined;
}

/**
 * Thrown by the SDK whenever the guard blocks an action.
 *
 * Carries the full decision payload available at the throw-site:
 *  - `reason`: stable snake_case reason symbol (e.g. `per_tx_cap_exceeded`)
 *  - `code`: numeric error enum code matching the contract
 *  - `explanation`: human-readable one-line description
 *  - `call`: the offending `ContractCall` that violated policy
 *  - `rawEvent`: the raw diagnostic event emitted during enforced simulation
 *  - `stage`: `"preflight"` or `"submission"`
 *  - `charged`: boolean flag (`false` for pre-flight blocks)
 *  - `detail`: optional low-level RPC or error diagnostic detail
 *
 * **Memory profile:**
 * The error maintains a bounded memory footprint. Decoded strings, codes, and
 * a structural summary of the offending call are retained. Large raw XDR payloads
 * are not duplicated or serialized into error messages by default.
 *
 * **Policy snapshot note:**
 * A policy snapshot reference is intentionally omitted from the throw-site payload
 * because enforced simulation returns diagnostic events/topics without querying
 * persistent contract storage. Querying policy state on every refusal would introduce
 * an extra RPC round-trip. Catch-sites have the reason, explanation, and call
 * needed to construct operator alerts without re-simulating.
 */
export class GuardBlockedError extends GuardError {
  readonly reason: string;
  readonly code: number | undefined;
  readonly explanation: string;
  readonly stage: "preflight" | "submission";
  readonly charged: boolean;
  readonly detail: string | undefined;
  readonly call: ContractCall | undefined;
  readonly rawEvent: unknown | undefined;

  constructor(params: GuardBlockedErrorParams) {
    const name = reasonName(params.reason);
    const explanation = explainReason(params.reason);
    const callSummary = params.call
      ? ` [call: ${params.call.contract}.${params.call.fn}(${params.call.args?.length ?? 0} args)]`
      : "";
    super(
      `stellar-agent-guard blocked this action (${name}): ${explanation}` +
        callSummary +
        (params.detail ? `\n${params.detail}` : ""),
    );
    this.name = "GuardBlockedError";
    this.reason = name;
    this.code =
      typeof params.reason === "number"
        ? params.reason
        : GUARD_REASON_CODES[name as GuardReason];
    this.explanation = explanation;
    this.stage = params.stage;
    this.charged = params.charged ?? false;
    this.detail = params.detail;
    this.call = params.call;
    this.rawEvent = params.rawEvent;
  }

  /**
   * Structured, logging-friendly representation.
   *
   * Omits huge XDR blobs while carrying essential decision context, reason,
   * explanation, and call summary.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      reason: this.reason,
      code: this.code,
      explanation: this.explanation,
      stage: this.stage,
      charged: this.charged,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      ...(this.call !== undefined
        ? {
            call: {
              contract: this.call.contract,
              fn: this.call.fn,
              argsCount: this.call.args?.length ?? 0,
            },
          }
        : {}),
      ...(this.rawEvent !== undefined ? { rawEvent: this.rawEvent } : {}),
    };
  }
}

/** Reasons that mean "the guard itself is not ready", as opposed to "this call violated policy". */
export const ACCOUNT_STATE_REASONS: readonly GuardReason[] = [
  "admin_frozen",
  "heartbeat_expired",
  "no_policy",
  "paused",
  "outside_active_window",
  "not_initialized",
];
