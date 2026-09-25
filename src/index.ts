/**
 * stellar-agent-guard-sdk — the public surface.
 *
 * An integration bridge between AI agent frameworks and `stellar-agent-guard`
 * smart accounts: pre-flight policy interception, agent-auth transaction
 * signing, and on-chain event telemetry.
 *
 * **Enforcement scope, stated where the capability is claimed:** full
 * recipient/amount enforcement — spend caps, allowlists, per-transaction limits
 * — is native and automatic for SAC token transfers (`transfer`/`transfer_from`),
 * since these are the calls whose arguments the Soroban auth context exposes for
 * inspection. For other Soroban contract calls made by the guarded account
 * (arbitrary DEX/lending/protocol calls), the policy engine still enforces window
 * and pause state, but per-call amount/recipient limits are not yet enforced —
 * extending fine-grained enforcement to arbitrary calls is tracked as a v2 item,
 * not implied as already covered.
 *
 * This sentence is copied verbatim from the contracts repo's
 * `docs/enforcement-scope.md` ("The confirmed scope"), not paraphrased: the
 * boundary is a property of the platform, and stating it in one shared wording
 * is what keeps the two repos from drifting apart on it.
 */
export {
  GuardBlockedError,
  ACCOUNT_STATE_REASONS,
  GUARD_REASON_CODES,
  explainReason,
  reasonName,
  reasonNameFromCode,
  type GuardReasonName,
} from "./reasons.ts";

export {
  decodeCheckResult,
  deadManRemaining,
  describePolicy,
  isDeadManFrozen,
  policyToScVal,
  type CheckResult,
  type GuardStatus,
  type PolicyConfig,
  type ProtocolRule,
} from "./policy.ts";

export {
  decodeAuthDecision,
  GUARD_AUTH_RESULTS,
  GUARD_EVENT_TOPICS,
  type GuardAuthDecision,
  type GuardAuthResult,
} from "./events.ts";

export {
  enforceCall,
  invoke,
  topicSymbols,
  type EnforcementOutcome,
  type GuardAuthorization,
  type InvokeOutcome,
  type InvokeParams,
} from "./invoke.ts";

export {
  PreFlightInterceptor,
  PreFlightUndeterminedError,
  preflight,
  type PolicyRevision,
  type PreFlightCacheOptions,
  type PreFlightConfig,
  type PreFlightDecision,
  type PreFlightInterceptorOptions,
} from "./preflight.ts";

export {
  CostPreChecker,
  describeCostDecision,
  exceedsCeiling,
  feeBreakdown,
  precheckCost,
  type CostDecision,
  type CostPreCheckConfig,
  type FeeBreakdown,
} from "./cost.ts";

export {
  GuardTelemetryListener,
  describeGuardEvent,
  guardEventsFromDiagnostics,
  isAllowedDecision,
  telemetryFromDecision,
  type GuardEvent,
  type GuardEventKind,
  type GuardTelemetryConfig,
} from "./telemetry.ts";

export {
  GUARD_STORAGE_KEYS,
  isStaleLedgerResourceFailure,
  type ContractCall,
  type SubmissionResult,
} from "./tx.ts";

// Framework adapters. Both are written structurally against their host's hook,
// so neither framework is a dependency of this package.
export {
  createLangChainGuardMiddleware,
  type LangChainGuardOptions,
  type LangChainToolCallRequest,
  type LangChainToolMessage,
} from "./adapters/langchain.ts";

export {
  createGuardValidator,
  guardAction,
  type ElizaActionLike,
  type ElizaGuardOptions,
  type ElizaValidator,
} from "./adapters/elizaos.ts";
