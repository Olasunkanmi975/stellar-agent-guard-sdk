/**
 * ElizaOS adapter — built on `Action.validate`.
 *
 * `Action.validate` is already a pre-execution gate: the runtime calls it with
 * the same `(runtime, message, state, options)` triple the handler receives and
 * admits the action to the eligible set only when it returns truthy. Composing
 * the guard into `validate` therefore stops the handler from ever running — see
 * `docs/integration-hooks.md` §2 for the source-pinned signatures and the three
 * call sites that enforce it.
 *
 * Wrapping `handler` instead would be weaker: by the time a handler runs, the
 * runtime has already committed to executing the action, and an error thrown
 * there is a failure rather than a refusal.
 *
 * Written structurally, so `@elizaos/core` is not a dependency of this SDK.
 *
 * ### Undetermined handling
 *
 * The guard fails closed. An `undetermined` verdict is not a pass: the
 * validator returns `false` and the action is dropped from the eligible set,
 * exactly as for a `blocked` verdict. The difference between the two is
 * observable through `onDecision` (and `onBlocked`, which is called for both),
 * not through the return value. A mapper that throws or returns a malformed
 * call is the same fail-closed halt (issue #316): the validator returns `false`
 * and `onBlocked` reports an `undetermined` halt. This is the documented
 * contract the shared verdict-fixture harness asserts against.
 * Options are validated at construction time (see `src/adapters/validate.ts`):
 * a misconfigured adapter throws `AdapterConfigError` before any action runs,
 * rather than failing mid-loop on the first tool call.
 */
import type { PreFlightDecision, PreFlightInterceptor } from "../preflight.ts";
import type { ContractCall } from "../tx.ts";
import {
  throwAdapterConfigError,
  validateBatchInterceptor,
  validateBlockedHookLogger,
  validateContractMapping,
  validateInterceptor,
  validateOptionalFunction,
  validateOptionalSignal,
  validateOptionalTimeout,
  type AdapterConfigIssue,
} from "./validate.ts";
import {
  blockedInfoFor,
  blockedInfoForBatch,
  checkOptionsFor,
  mappingFailureFor,
  normalizeMappedCall,
  normalizeMappedCalls,
  runBlockedHook,
  runDecisionHook,
  type BlockedHookLogger,
  type GuardBlockedHook,
} from "./shared.ts";

/** The subset of ElizaOS's `Validator` signature this adapter implements. */
export type ElizaValidator = (
  runtime: unknown,
  message: unknown,
  state?: unknown,
  options?: unknown,
) => Promise<boolean>;

/** The subset of the `Action` interface this adapter reads. */
export interface ElizaActionLike {
  name: string;
  validate: ElizaValidator;
}

export interface ElizaGuardOptions {
  interceptor: PreFlightInterceptor;
  /**
   * Turn the action's intent into the guarded contract call it would make, or
   * `null` when this action moves no funds.
   */
  toContractCall?: (message: unknown, state: unknown) => ContractCall | null;
  /**
   * Additive batch mapping (issue #318): the ordered calls this action performs.
   * Takes precedence over `toContractCall`; every call is checked before the
   * action is admitted (all-or-nothing). `null` or an empty array means the
   * action moves no funds.
   */
  toContractCalls?: (message: unknown, state: unknown) => readonly ContractCall[] | null;
  /** The action's own validation, composed in front of the guard's. */
  baseValidate?: ElizaValidator;
  /** Observe every decision — the place to wire telemetry. */
  onDecision?: (decision: PreFlightDecision) => void;
  /**
   * Operator alerting: called once per halt with the same structured payload
   * every adapter uses (`{ adapter, kind, reason, call, explanation }`). A
   * `false` verdict is silent by design — the runtime simply drops the action —
   * so without this a blocked action leaves no trace anywhere. Fires for a
   * `blocked` verdict and for a fail-closed `undetermined` one; a throwing
   * callback is logged and swallowed rather than breaking the halt. See
   * `src/adapters/shared.ts`.
   */
  onBlocked?: GuardBlockedHook;
  /**
   * Explicit sink for a swallowed `onBlocked` failure. Omitted (the default),
   * a throwing hook is silent (issue #314).
   */
  blockedHookLogger?: BlockedHookLogger;
  /**
   * Caller-owned cancellation, forwarded to every pre-flight `check()`
   * (issue #315). ElizaOS's validator hook exposes no invocation signal, so
   * this is the only cancellation channel; aborting yields `undetermined`,
   * which the validator fails closed on.
   */
  signal?: AbortSignal | undefined;
  /**
   * Bound on each RPC call made by the pre-flight check, in milliseconds
   * (issue #315); `0` disables it. A fired timeout yields the same fail-closed
   * `undetermined` verdict as an abort.
   */
  timeoutMs?: number | undefined;
}

/**
 * Build a `validate` that returns `true` only when the action is both valid and
 * permitted by the guard.
 *
 * Fails closed: a refusal and an undetermined enforcement run both return
 * `false`, so the action never executes either way.
 */
export function createGuardValidator(options: ElizaGuardOptions): ElizaValidator {
  const issues: AdapterConfigIssue[] = [];
  const interceptorIssue = validateInterceptor(options.interceptor);
  if (interceptorIssue) issues.push(interceptorIssue);
  issues.push(...validateContractMapping(options));
  if (options.toContractCalls) {
    const batchIssue = validateBatchInterceptor(options.interceptor);
    if (batchIssue) issues.push(batchIssue);
  }
  const blockedLoggerIssue = validateBlockedHookLogger(options.blockedHookLogger);
  if (blockedLoggerIssue) issues.push(blockedLoggerIssue);
  const baseValidateIssue = validateOptionalFunction("baseValidate", options.baseValidate);
  if (baseValidateIssue) issues.push(baseValidateIssue);
  const onDecisionIssue = validateOptionalFunction("onDecision", options.onDecision);
  if (onDecisionIssue) issues.push(onDecisionIssue);
  const onBlockedIssue = validateOptionalFunction("onBlocked", options.onBlocked);
  if (onBlockedIssue) issues.push(onBlockedIssue);
  const signalIssue = validateOptionalSignal(options.signal);
  if (signalIssue) issues.push(signalIssue);
  const timeoutIssue = validateOptionalTimeout(options.timeoutMs);
  if (timeoutIssue) issues.push(timeoutIssue);
  throwAdapterConfigError("elizaos", issues);

  return async (runtime, message, state, handlerOptions) => {
    if (options.baseValidate) {
      const baseOk = await options.baseValidate(runtime, message, state, handlerOptions);
      if (!baseOk) return false; // the action was not applicable in the first place
    }

    let calls: ContractCall[];
    try {
      calls = options.toContractCalls
        ? normalizeMappedCalls(options.toContractCalls(message, state), "toContractCalls")
        : normalizeMappedCall(options.toContractCall?.(message, state), "toContractCall");
    } catch (error) {
      // A mapper failure is a fail-closed halt, not an "applicable" action
      // (issue #316): the runtime drops the action before its handler runs.
      const failure = mappingFailureFor("elizaos", error);
      runBlockedHook(options.onBlocked, failure.info, options.blockedHookLogger);
      return false;
    }
    if (calls.length === 0) return true; // not fund-moving; nothing for the guard to say

    const checkOptions = checkOptionsFor(options);

    if (calls.length === 1) {
      const decision = await options.interceptor.check(calls[0]!, checkOptions);
      runDecisionHook(options.onDecision, [decision], "elizaos", options.blockedHookLogger);
      if (decision.allowed) return true;

      runBlockedHook(
        options.onBlocked,
        blockedInfoFor("elizaos", calls[0]!, decision),
        options.blockedHookLogger,
      );
      return false;
    }

    // Batch mapping: a single refusal drops the whole action before its handler
    // runs; every per-call verdict is reported through `onDecision`.
    const batch = await options.interceptor.checkBatch(calls, checkOptions);
    for (const verdict of batch.verdicts) {
      runDecisionHook(options.onDecision, [verdict], "elizaos", options.blockedHookLogger);
    }
    if (batch.admissible) return true;

    runBlockedHook(
      options.onBlocked,
      blockedInfoForBatch("elizaos", calls, batch.verdicts),
      options.blockedHookLogger,
    );
    return false;
  };
}

/**
 * Wrap an existing action, returning a copy whose `validate` composes the guard.
 *
 * The returned `validate` is deliberately typed as the full `ElizaValidator`, not
 * as the wrapped action's own (possibly narrower) signature. An action authored
 * with `validate: async () => boolean` is assignable to `ElizaValidator` — extra
 * parameters are allowed to be ignored — but the *wrapped* validator genuinely accepts all four arguments and forwards them to the base, so reporting the
 * narrower type would both misdescribe it and prevent a caller from invoking
 * the action the way the runtime does.
 */
export function guardAction<T extends ElizaActionLike>(
  action: T,
  options: Omit<ElizaGuardOptions, "baseValidate">,
): Omit<T, "validate"> & { validate: ElizaValidator } {
  return {
    ...action,
    validate: createGuardValidator({ ...options, baseValidate: action.validate }),
  };
}
