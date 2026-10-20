/**
 * Vercel AI SDK adapter — built on wrapping tool `execute` functions.
 *
 * The Vercel AI SDK's language-model middleware (`wrapLanguageModel`) transforms
 * *model streams*, which already contain tool-call arguments the model has
 * emitted — intercepting there is post-decision, not pre-execution. The earliest
 * hook the SDK owns where nothing has run yet is the tool's own `execute`
 * function: a tool with `execute: undefined` never runs, so wrapping the
 * function body is the same pre-execution guarantee the LangChain continuation
 * hook gives. The AI SDK itself documents exactly this pattern (`ai` ≥ 4.1 /
 * 5.x tool wrapping, tested against the structural `Tool` shape below): pass
 * `wrapTool`-style helpers a tool and return a copy whose `execute` is
 * `guard(toolImpl)`.
 *
 * Verdict → halt semantics, shared with the other adapters:
 *
 * | verdict        | behaviour                                                       |
 * |----------------|-----------------------------------------------------------------|
 * | `admissible`   | the wrapped `execute` runs and its result is returned untouched |
 * | `blocked`      | throws `GuardBlockedError` before `execute` is entered          |
 * | `undetermined` | throws `PreFlightUndeterminedError` before `execute` is entered |
 * | mapper failure | throws `PreFlightUndeterminedError` (cause: `AdapterMappingError`) before `execute` is entered |
 *
 * Throwing (rather than returning a marker like the LangChain `ToolMessage`) is
 * the harness's documented contract for this adapter: the AI SDK renders a
 * thrown tool error into the model's error stream, and a blocked call must not
 * produce a tool *result* the model can read as success.
 *
 * Written structurally against the `Tool` shape, so `ai` is not a dependency of
 * this package.
 */
import { GuardBlockedError } from "../reasons.ts";
import { PreFlightUndeterminedError } from "../preflight.ts";
import type { PreFlightDecision, PreFlightInterceptor } from "../preflight.ts";
import type { ContractCall } from "../tx.ts";
import {
  checkOptionsFor,
  mapContractCalls,
  mappingFailureFor,
  runDecisionHook,
  type BlockedHookLogger,
} from "./shared.ts";

/**
 * The subset of the Vercel AI SDK's `Tool` interface this adapter reads.
 *
 * `input` is the framework's typed tool input (`ToolCallOptions.input` in
 * `ai` ≥ 5); it is structurally opaque here because turning it into a guarded
 * `ContractCall` is application knowledge, supplied as `toContractCall`.
 */
export interface VercelAIToolLike {
  /** The tool's own `execute`; may be absent, in which case there is nothing to guard. */
  execute?: ((input: never, options: unknown) => Promise<unknown>) | undefined;
}

/** The subset of an AI SDK tool call this adapter can describe. */
export interface VercelAIToolCallInput {
  toolName: string;
  input: unknown;
}

export interface VercelAIGuardOptions {
  interceptor: PreFlightInterceptor;
  /**
   * Turn a tool call into the guarded contract call it would make, or `null`
   * when this tool moves no funds and should not be intercepted at all.
   */
  toContractCall?: (call: VercelAIToolCallInput) => ContractCall | null;
  /**
   * Additive batch mapping (issue #318): the ordered calls this tool performs.
   * Takes precedence over `toContractCall`; the whole batch is checked before
   * `execute` runs (all-or-nothing).
   */
  toContractCalls?: (call: VercelAIToolCallInput) => readonly ContractCall[] | null;
  /**
   * Observe every decision — the place to wire telemetry.
   *
   * The observer is **advisory**: an exception it throws is swallowed, and can
   * never change whether the guard permits `execute` to run (issue #277).
   * Reporting a decision is not part of the verdict, so a broken log sink must
   * not turn an admissible call into a failure nor rescue a blocked one. This
   * matches the SDK's other failure-isolated callbacks (`onGap`,
   * `onStep`/`onUnknownTopics`).
   */
  onDecision?: (call: VercelAIToolCallInput, decision: PreFlightDecision) => void;
  /**
   * Explicit sink for a swallowed `onDecision` failure. Omitted (the default),
   * a throwing or rejecting observer is silent (issue #313/#314).
   */
  blockedHookLogger?: BlockedHookLogger;
  /**
   * Caller-owned cancellation, forwarded to every pre-flight `check()`
   * (issue #315). The AI SDK's tool `execute` receives its own `abortSignal`;
   * pass it here if you have it at wrap time.
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
 * Wrap a tool definition so its `execute` asks the guard before it runs.
 *
 * A tool without `execute` is returned untouched: a tool that cannot execute
 * cannot move funds, and inventing a verdict for it would be the guard ruling
 * on something it has no opinion about.
 */
export function wrapToolWithGuard<T extends VercelAIToolLike>(
  tool: T,
  options: VercelAIGuardOptions,
  call: VercelAIToolCallInput,
): T {
  if (typeof tool.execute !== "function") return tool;
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(input: never, toolOptions: unknown): Promise<unknown> {
      const request = { toolName: call.toolName, input };
      let contractCalls: ContractCall[];
      try {
        contractCalls = mapContractCalls(request, options);
      } catch (error) {
        // Fail closed on a mapper failure (issue #316). This adapter documents
        // `undetermined` as a thrown PreFlightUndeterminedError, so the mapping
        // failure keeps that shape with the AdapterMappingError as its cause.
        const failure = mappingFailureFor("vercelai", error);
        throw new PreFlightUndeterminedError(failure.info.explanation, {
          cause: failure.decision.error,
        });
      }
      if (contractCalls.length === 0) return execute(input, toolOptions);

      const checkOptions = checkOptionsFor(options);

      if (contractCalls.length === 1) {
        const decision = await options.interceptor.check(contractCalls[0]!, checkOptions);
        runDecisionHook(
          options.onDecision,
          [request, decision],
          "vercelai",
          options.blockedHookLogger,
        );
        if (decision.allowed) return execute(input, toolOptions);
        throw refusalFor(decision, contractCalls[0]!);
      }

      // Batch mapping: only an all-admissible batch reaches `execute`.
      const batch = await options.interceptor.checkBatch(contractCalls, checkOptions);
      for (const verdict of batch.verdicts) {
        runDecisionHook(
          options.onDecision,
          [request, verdict],
          "vercelai",
          options.blockedHookLogger,
        );
      }
      if (batch.admissible) return execute(input, toolOptions);

      const index = batch.verdicts.findIndex((verdict) => !verdict.allowed);
      const refusal = batch.verdicts[index]!;
      if (refusal.allowed) throw new Error("non-admissible batch had no refusal verdict");
      throw refusalFor(refusal, contractCalls[index] ?? contractCalls[0]!);
    },
  };
}

/** Throw the documented error for a non-admissible verdict. */
function refusalFor(
  decision: PreFlightDecision & { allowed: false },
  contractCall: ContractCall,
): Error {
  if (decision.kind === "blocked") {
    return new GuardBlockedError({
      reason: decision.reason,
      stage: "preflight",
      detail: decision.detail,
      call: contractCall,
      rawEvent: decision.diagnosticEvents?.[0],
    });
  }
  return new PreFlightUndeterminedError(decision.detail, { cause: decision.error });
}

/**
 * Build a guard wrapper in the same options shape as the other adapters.
 *
 * The returned function is a drop-in for the AI SDK's documented
 * "wrap the tool function itself" pattern — use it wherever the SDK hands you a
 * tool before execution: `wrapLanguageModel`'s `wrapTool` middleware hook, a
 * `dynamicTool` factory, or plain tool construction.
 */
export function createVercelAIGuard(options: VercelAIGuardOptions) {
  return function guard<T extends VercelAIToolLike>(toolName: string, tool: T): T {
    return wrapToolWithGuard(tool, options, { toolName, input: undefined });
  };
}
