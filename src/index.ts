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
  AdapterConfigError,
  AdapterMappingError,
  BroadcastError,
  ContractResponseError,
  GuardError,
  PolicyDecodeError,
  SigningError,
  SimulationError,
} from "./errors.ts";

export {
  FakeClock,
  systemClock,
} from "./clock.ts";

export type {
  Clock,
} from "./clock.ts";

export {
  GuardBlockedError,
  ACCOUNT_STATE_REASONS,
  GUARD_REASON_CODES,
  GUARD_REASONS,
  explainReason,
  isGuardReason,
  reasonMessages,
  reasonMessagesEn,
  reasonName,
  reasonNameFromCode,
} from "./reasons.ts";

export type {
  GuardBlockedErrorParams,
  GuardReason,
  GuardReasonName,
  ReasonMessage,
  ReasonMessageCatalog,
  ReasonMessageText,
} from "./reasons.ts";

export {
  POLICY_RULE_IDS,
  deadManRemaining,
  decodeCheckResult,
  decodePolicy,
  describePolicy,
  extractTransferAmount,
  fetchGuardPolicyAndWindow,
  freezePolicy,
  isAccountAddress,
  isContractAddress,
  isDeadManFrozen,
  isPublicKeyHex,
  isStrKeyAddress,
  policyFromScVal,
  policyToScVal,
  readPersistentEntry,
  unsafeAccountAddress,
  unsafeContractAddress,
  unsafePublicKeyHex,
  unsafeStrKeyAddress,
  validateGuardPolicy,
} from "./policy.ts";

export type {
  ActiveWindowState,
  DescribePolicyOptions,
} from "./policy.ts";

export { DMS_WARN_RATIO_DEFAULT, dmsUrgency } from "./dms.ts";
export { policyDiff } from "./policy-diff.ts";
export type { PolicyChange, PolicyValue } from "./policy-diff.ts";
export type { DmsUrgency } from "./dms.ts";

export type {
  AccountAddress,
  CheckResult,
  ContractAddress,
  DeepReadonly,
  GuardPolicy,
  GuardStatus,
  PolicyConfig,
  PolicyFailure,
  PolicyRuleId,
  ProtocolRule,
  PublicKeyHex,
  ReadonlyPolicyConfig,
  RecipientWindowCap,
  StrKeyAddress,
  ValidatePolicyOptions,
} from "./policy.ts";

export {
  POLICY_JSON_VERSION,
  decodePolicyJson,
  encodePolicyJson,
  policyFromJson,
  policyToJson,
} from "./policy-json.ts";

export type {
  PolicyJson,
  PolicyJsonProtocolRule,
  PolicyJsonRecipientWindowCap,
} from "./policy-json.ts";

export {
  POLICY_SCHEMA_PATH,
  SCHEMA_DIALECT,
  SCHEMA_RULE_ID_ANNOTATION,
  SCHEMA_VS_CODE_RULES,
  ruleFromAnnotation,
  ruleForKeyword,
  validateGuardPolicyAgainstSchema,
} from "./policy-schema.ts";

export type {
  SchemaKeyword,
  SchemaPolicyFailure,
  SchemaValidationOptions,
} from "./policy-schema.ts";

export {
  decodeAuthDecision,
  decodeGuardEventXdr,
  GUARD_AUTH_RESULTS,
  GUARD_EVENT_TOPICS,
  validateGuardEventXdr,
} from "./events.ts";

export type {
  GuardAuthDecision,
  GuardAuthResult,
  GuardEventValidationCode,
  GuardEventValidationEntry,
  GuardEventValidationFailure,
  GuardEventValidationOptions,
  GuardEventValidationReport,
  GuardEventValidationStage,
  GuardEventValidationSuccess,
} from "./events.ts";

export {
  DEFAULT_INVOKE_RETRY_OPTIONS,
  DEFAULT_RPC_TIMEOUT_MS,
  enforceCall,
  INVOKE_ERROR_CAUSES,
  InvokeRetryError,
  invoke,
  RpcTimeoutError,
  topicSymbols,
  type EnforcementOutcome,
  type FeeBumpConfig,
  type GuardAuthorization,
  type InvokeDryRunResult,
  type InvokeDryRunStepName,
  type InvokeDryRunVerdict,
  type InvokeErrorCause,
  type InvokeErrorOutcome,
  type InvokeOptions,
  type InvokeOutcome,
  type InvokePipelineStep,
  type InvokeParams,
  type InvokeRetryAttempt,
  type InvokeRetryMetadata,
  type InvokeStepEvent,
  type RetryableInvokeFailure,
} from "./invoke.ts";

export {
  TRACE_STEP_NAMES,
} from "./trace.ts";

export type {
  TraceStepName,
  TraceStepStatus,
} from "./trace.ts";

export {
  InvalidInputError,
  PreFlightInterceptor,
  PreFlightUndeterminedError,
  preflight,
  preflightBatch,
  validateContractCall,
} from "./preflight.ts";

export type {
  BatchStagingSource,
  CheckBatchOptions,
  PolicyRevision,
  PreFlightBatchDecision,
  PreFlightBatchStaging,
  PreFlightCacheOptions,
  PreFlightCheckOptions,
  PreFlightConfig,
  PreFlightDecision,
  PreFlightInterceptorOptions,
} from "./preflight.ts";

export {
  CostPreChecker,
  STROOPS_PER_XLM,
  describeCostDecision,
  exceedsCeiling,
  feeBreakdown,
  formatFee,
  precheckCost,
  precheckCostWithDecision,
  resourceBreakdownFromSimulation,
} from "./cost.ts";

export type {
  CostDecision,
  CostPreCheckConfig,
  CostPreCheckOptions,
  CostPreCheckResult,
  CostWithDecision,
  FeeBreakdown,
  PolicyContext,
  ResourceBreakdown,
} from "./cost.ts";

export {
  ConcurrentTelemetryStreamError,
  DEFAULT_JITTER_FRACTION,
  GuardEventRingBuffer,
  GuardTelemetryListener,
  InMemoryCursorStore,
  compareCommittedEvents,
  computePollDelay,
  describeGuardEvent,
  diagnosticsToEvents,
  guardEventId,
  guardEventsFromDiagnostics,
  guardEventsFromFailedTransaction,
  isAllowedDecision,
  mergeGuardEventStreams,
  parseEventRecord,
  serializeEvent,
  serializeEventRecord,
  telemetryFromDecision,
  TELEMETRY_EVENT_RECORD_VERSION,
  type CursorStore,
  type GuardDiagnosticBatch,
  type GuardEvent,
  type GuardEventBufferOptions,
  type GuardEventContext,
  type GuardEventDecodeOptions,
  type GuardEventDropCounts,
  type GuardEventIdentityInput,
  type GuardEventKind,
  type GuardEventRecord,
  type GuardEventStream,
  type GuardTelemetryConfig,
  type GuardTelemetryGap,
  type GuardTelemetryGapReason,
  type GuardTelemetryHealthSnapshot,
  type GuardTelemetryStreamState,
  type GuardTelemetryUnifiedParams,
  type GuardTelemetryWatchParams,
  type GuardUnknownTopic,
  type ParsedGuardEventRecord,
  type PollResult,
  type PollSleep,
  type RecentEventFilter,
  type TelemetryJitter,
} from "./telemetry.ts";

export {
  GUARD_STORAGE_KEYS,
  INCLUSION_FEE,
  SIG_EXPIRATION_LEDGERS,
  assembleFromSimulation,
  buildGuardAuthEntry,
  buildInitialEnvelope,
  describeSimulationResources,
  describeSubmissionFailure,
  describeTransactionResult,
  isMinimumFeeBroadcastFailure,
  isSequenceNumberFailure,
  isStaleLedgerResourceFailure,
  isValidAgentPublicKey,
  keypairAgentSigner,
  toAgentSigner,
  validateAgentPublicKey,
  verifyAgentSignature,
} from "./tx.ts";

export type {
  AdminSigner,
  AgentSigner,
  ContractCall,
  GuardCredentialType,
  SimulationOutcome,
  SubmissionResult,
} from "./tx.ts";

export {
  DEFAULT_NETWORK_PASSPHRASE,
  agentPubkeyToScVal,
  buildFreezeCall,
  buildRotateAgentKeyCall,
  buildSetPolicyCall,
  buildUnfreezeCall,
  submitFreeze,
  submitRotateAgentKey,
  submitSetPolicy,
  submitUnfreeze,
} from "./admin.ts";

export type {
  AdminOpParams,
  RotateAgentKeyParams,
  SetPolicyParams,
} from "./admin.ts";

export {
  GUARD_WASM_HASH,
  sha256Hex,
  toHex,
  verifyGuardWasm,
  type GuardWasmVerification,
} from "./wasm.ts";

export {
  DEFAULT_HEARTBEAT_RETRY_OPTIONS,
  HeartbeatBlockedError,
  HeartbeatIntervalError,
  isRetryableHeartbeatFailure,
  startHeartbeat,
  submitHeartbeat,
  type HeartbeatBeat,
  type HeartbeatHandle,
  type HeartbeatOptions,
  type HeartbeatRetryOptions,
  type HeartbeatStopOptions,
  type HeartbeatStopResult,
  type HeartbeatSubmission,
  type HeartbeatSubmitContext,
  type SubmitHeartbeatParams,
} from "./heartbeat.ts";

// Framework adapters. Both are written structurally against their host's hook,
// so neither framework is a dependency of this package. Options are validated
// at construction time (see `src/adapters/validate.ts`), so a misconfigured
// adapter throws `AdapterConfigError` before the first action rather than
// failing mid-loop.
export {
  createLangChainGuardMiddleware,
} from "./adapters/langchain.ts";

export type {
  LangChainGuardOptions,
  LangChainToolCallRequest,
  LangChainToolMessage,
} from "./adapters/langchain.ts";

export {
  createGuardValidator,
  guardAction,
} from "./adapters/elizaos.ts";

export type {
  ElizaActionLike,
  ElizaGuardOptions,
  ElizaValidator,
} from "./adapters/elizaos.ts";

export {
  throwAdapterConfigError,
  validateBatchInterceptor,
  validateBlockedHookLogger,
  validateContractMapping,
  validateInterceptor,
  validateOptionalFunction,
  validateOptionalSignal,
  validateOptionalTimeout,
  validateRequiredFunction,
  type AdapterConfigIssue,
} from "./adapters/validate.ts";

export {
  createVercelAIGuard,
  wrapToolWithGuard,
  type VercelAIGuardOptions,
  type VercelAIToolCallInput,
  type VercelAIToolLike,
} from "./adapters/vercelai.ts";

export {
  guardMcpCallTool,
  guardMcpToolHandler,
} from "./adapters/mcp.ts";

export type {
  McpCallTool,
  McpGuardOptions,
  McpToolCallRequest,
  McpToolHandler,
  McpToolResult,
} from "./adapters/mcp.ts";

// The operator alerting primitive every adapter shares (`onBlocked`).
// Exported so a consumer can type its sink and build the payload itself.
export {
  blockedInfoFor,
  blockedInfoForBatch,
  checkOptionsFor,
  hostAbortSignal,
  mapContractCalls,
  mappingFailureFor,
  normalizeMappedCall,
  normalizeMappedCalls,
  runBlockedHook,
  runDecisionHook,
} from "./adapters/shared.ts";

export type {
  BlockedHookLogger,
  GuardAdapterName,
  GuardBlockedHook,
  GuardBlockedInfo,
  GuardCallMapper,
} from "./adapters/shared.ts";

// Optional logging. `SILENT_LOGGER` is the default every config resolves to
// when no logger is supplied: the SDK writes nothing unless a host asks.
export {
  GUARD_LOG_LEVELS,
  redactLogMeta,
  SILENT_LOGGER,
  resolveLogger,
  type GuardLogger,
  type GuardLoggerInput,
  type GuardLogLevel,
  type GuardLogMeta,
} from "./logger.ts";
