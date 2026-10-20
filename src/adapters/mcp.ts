/**
 * MCP adapter — guard a Model Context Protocol tool call at the boundary.
 *
 * Model Context Protocol tool calls (Claude Desktop and other MCP hosts) are
 * another surface where agent-driven contract actions originate. The spike for
 * this adapter (issue #45) checked the two published generations of the
 * TypeScript SDK and found a genuine **pre-execution** point in both:
 *
 * - v2 (`@modelcontextprotocol/server`, spec `2026-07-28`) registers a tool with
 *   `server.registerTool(name, config, handler)`; the handler is `async (args,
 *   extra) => CallToolResult` and runs only after the host sends `tools/call`.
 * - v1 (`@modelcontextprotocol/sdk` 1.30.x) exposes the same handler shape via
 *   `server.tool(name, schema, handler)` and, at the low level, via
 *   `server.setRequestHandler(CallToolRequestSchema, handler)`.
 *
 * There is no "post-hoc only" problem to document here: returning a refusal
 * **without invoking the wrapped handler** means the tool body — the code that
 * signs and broadcasts a transaction — never runs. `guardMcpToolHandler` wraps
 * that handler. `guardMcpCallTool` covers the other side of the same boundary,
 * a client wrapping its own `callTool` before the request leaves the process.
 *
 * Written structurally, so neither `@modelcontextprotocol/sdk` nor
 * `@modelcontextprotocol/server` becomes a dependency of this package. The
 * pinned revisions and the hook search are recorded in
 * `docs/integration-hooks.md` §4.
 */
import type { InvokeStepEvent } from "../invoke.ts";
import type { PreFlightDecision, PreFlightInterceptor } from "../preflight.ts";
import type { ContractCall } from "../tx.ts";
import {
  blockedInfoFor,
  blockedInfoForBatch,
  checkOptionsFor,
  hostAbortSignal,
  mapContractCalls,
  mappingFailureFor,
  runBlockedHook,
  runDecisionHook,
  type BlockedHookLogger,
  type GuardBlockedHook,
} from "./shared.ts";

/** The one field of a tool call this adapter reads. */
export interface McpToolCallRequest {
  /** The tool name the model asked for. */
  name: string;
  /** The tool's arguments, as the host delivered them. */
  arguments: Record<string, unknown>;
}

/**
 * The subset of MCP's `CallToolResult` this adapter produces. Kept loose so a
 * host's own richer result type (structured content, image blocks) still
 * satisfies it without this package depending on the SDK's types.
 */
export interface McpToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** A registered MCP tool handler: `(args, extra) => CallToolResult`. */
export type McpToolHandler<T extends McpToolResult = McpToolResult> = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<T>;

/** A client's `callTool`: `(request) => CallToolResult`. */
export type McpCallTool<T extends McpToolResult = McpToolResult> = (
  request: McpToolCallRequest,
) => Promise<T>;

export interface McpGuardOptions {
  interceptor: PreFlightInterceptor;
  /**
   * Turn a tool call into the guarded contract call it would make, or `null` if
   * this tool moves no funds and should not be intercepted at all.
   */
  toContractCall?: (request: McpToolCallRequest) => ContractCall | null;
  /**
   * Additive batch mapping (issue #318): the ordered calls this tool performs.
   * Takes precedence over `toContractCall`; the whole batch is checked before
   * the handler runs (all-or-nothing). `null` or an empty array means the tool
   * is not fund-moving.
   */
  toContractCalls?: (request: McpToolCallRequest) => readonly ContractCall[] | null;
  /** Observe every decision — the place to wire telemetry. */
  onDecision?: (request: McpToolCallRequest, decision: PreFlightDecision) => void;
  /**
   * Operator alerting on every halt, on the same shared payload as the other
   * adapters (`{ adapter: "mcp", kind, reason, call, explanation }`). A throwing
   * callback is logged and swallowed; omit it for the pre-existing behavior.
   */
  onBlocked?: GuardBlockedHook;
  /**
   * Explicit sink for a swallowed `onBlocked` failure. Omitted (the default),
   * a throwing hook is silent (issue #314).
   */
  blockedHookLogger?: BlockedHookLogger;
  /**
   * Optional per-call observability, forwarded to the interceptor's `check()`:
   * one event per enforcement-stage attempt (probe → sign → simulate). The
   * adapter never broadcasts, so no `broadcast` events can appear here.
   */
  onStep?: (step: InvokeStepEvent) => void;
  /**
   * Caller-owned cancellation, forwarded to every pre-flight `check()`
   * (issue #315). For `guardMcpToolHandler` the host's invocation signal
   * (`extra.signal`) takes precedence when the SDK provides one.
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
 * The shared decision path for both boundaries: ask the guard once, hand an
 * allowed call to `proceed`, and turn any halt into an MCP error result.
 *
 * Failing closed on `undetermined` matters here more than anywhere: an MCP host
 * surfaces a returned `isError: true` result to the model, so a guardrail that
 * let an undetermined call through would let the model believe the action ran.
 */
async function guardMcpRequest<T extends McpToolResult>(
  request: McpToolCallRequest,
  proceed: () => Promise<T>,
  options: McpGuardOptions,
  hostSignal?: AbortSignal | undefined,
): Promise<T | McpToolResult> {
  let calls: ContractCall[];
  try {
    calls = mapContractCalls(request, options);
  } catch (error) {
    // Fail closed on a mapper failure (issue #316): the tool body never runs and
    // the halt is reported as undetermined, without a mapped `call`.
    const failure = mappingFailureFor("mcp", error);
    runBlockedHook(options.onBlocked, failure.info, options.blockedHookLogger);
    return {
      content: [{ type: "text", text: describeMcpRefusal(failure.decision, request.name) }],
      isError: true,
    };
  }
  if (calls.length === 0) return proceed();

  const checkOptions = checkOptionsFor(options, hostSignal);

  if (calls.length === 1) {
    const decision = await options.interceptor.check(calls[0]!, checkOptions);
    runDecisionHook(options.onDecision, [request, decision], "mcp", options.blockedHookLogger);
    if (decision.allowed) return proceed();

    runBlockedHook(
      options.onBlocked,
      blockedInfoFor("mcp", calls[0]!, decision),
      options.blockedHookLogger,
    );
    return {
      content: [{ type: "text", text: describeMcpRefusal(decision, request.name) }],
      isError: true,
    };
  }

  // Batch mapping: report every per-call verdict, and refuse the whole action if
  // any call is blocked or undetermined (all-or-nothing).
  const batch = await options.interceptor.checkBatch(calls, checkOptions);
  for (const verdict of batch.verdicts) {
    runDecisionHook(options.onDecision, [request, verdict], "mcp", options.blockedHookLogger);
  }
  if (batch.admissible) return proceed();

  runBlockedHook(
    options.onBlocked,
    blockedInfoForBatch("mcp", calls, batch.verdicts),
    options.blockedHookLogger,
  );
  const refusal = batch.verdicts.find((verdict) => !verdict.allowed)!;
  return {
    content: [{ type: "text", text: describeMcpRefusal(refusal, request.name) }],
    isError: true,
  };
}

/**
 * Wrap a registered MCP tool handler so the guard decides before its body runs.
 *
 * The tool name is passed explicitly because MCP invokes a handler with the
 * tool's *arguments*, not with the `{ name, arguments }` request the low-level
 * handler sees; without it `toContractCall` would have no way to tell which
 * tool the model called when one handler serves several names.
 */
export function guardMcpToolHandler<T extends McpToolResult>(
  toolName: string,
  handler: McpToolHandler<T>,
  options: McpGuardOptions,
): McpToolHandler<T | McpToolResult> {
  return (args, extra) =>
    guardMcpRequest(
      { name: toolName, arguments: args },
      () => handler(args, extra),
      options,
      // The MCP SDK passes the invocation's AbortSignal through `extra`.
      hostAbortSignal((extra as { signal?: unknown } | undefined)?.signal),
    );
}

/**
 * Wrap a client's `callTool` so the guard decides before the request is sent.
 *
 * This is the same boundary read from the other side: an MCP client that owns
 * the tool-call egress can refuse locally and never put the request on the
 * wire. A non-fund-moving tool passes straight through.
 */
export function guardMcpCallTool<T extends McpToolResult>(
  callTool: McpCallTool<T>,
  options: McpGuardOptions,
): McpCallTool<T | McpToolResult> {
  return (request) => guardMcpRequest(request, () => callTool(request), options);
}

/**
 * Human- and model-readable refusal text. MCP results are model-visible, so the
 * wording mirrors the other adapters': name the tool, quote the contract reason
 * and its explanation, and state that nothing was submitted.
 */
function describeMcpRefusal(
  decision: PreFlightDecision & { allowed: false },
  toolName: string,
): string {
  if (decision.kind === "blocked") {
    return (
      `stellar-agent-guard blocked '${toolName}': ${decision.reason} — ${decision.explanation}\n` +
      `No transaction was submitted, so nothing was spent and no fee was paid.`
    );
  }
  return (
    `stellar-agent-guard could not determine whether '${toolName}' is permitted; ` +
    `it was not executed.\n${decision.detail}`
  );
}
