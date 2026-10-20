# Framework Adapters API

The SDK provides plug-and-play middleware for AI agent orchestration frameworks.

## LangChain

```ts
import { createLangChainGuardMiddleware } from "stellar-agent-guard-sdk";

const middleware = createLangChainGuardMiddleware({
  interceptor,
  toContractCall: (request) => ({
    contractId: request.args.contractId,
    method: request.args.method,
    args: request.args.args,
  }),
});
```

Halts execution by returning without calling `handler(request)` if the interceptor blocks the planned action.

When the interceptor returns an `undetermined` verdict, the LangChain middleware returns an error `ToolMessage` (as it does for `blocked`) whose content carries the verdict's `detail`, and the tool body is never entered. It never throws for a guard verdict.

## ElizaOS

```ts
import { createGuardValidator } from "stellar-agent-guard-sdk";

const validate = createGuardValidator({
  interceptor,
  toContractCall: (message) => ({
    contractId: message.content.contractId,
    method: message.content.method,
    args: message.content.args,
  }),
});
```

Returns `false` from the action validator if the interceptor refuses the call, filtering the action out before execution.
When the interceptor returns an `undetermined` verdict, the ElizaOS validator returns `false` (fail-closed) and emits the verdict's `cause` through the validator's context so the runtime can surface it.

## Verdict handling parity

Both adapters consume the same interceptor verdicts but map them to different return shapes. The shared test harness in `tests/integration/adapters.test.ts` drives a single verdict-fixture table through both adapters and asserts the documented behavior below.

| Verdict                         | LangChain middleware                                                                           | ElizaOS validator                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `admissible`                      | Calls `handler(request)` and returns its result (pass).                                                  | Returns `true` and the action proceeds to execution (pass).                                                  |
| `blocked(reason)`                 | Returns without calling `handler(request)`; the block message carries the verdict's `reason` (halt-with-message). | Returns `false`; the action is filtered out and the validator context carries the verdict's `reason` (halt-with-message).  |
| `undetermined(cause)`              | Returns an error `ToolMessage` carrying the verdict's `detail`; the tool body never runs (halt-with-message).            | Returns `false` (fail-closed); `onBlocked` surfaces `undetermined` (halt-with-message). |

## Call mapping and mapping failures

`toContractCall`/`toContractCalls` is application code, and the adapters pin one
contract for what it may return:

| Mapper result | Adapter behavior |
| --- | --- |
| A valid `ContractCall` (or ordered array) | The call(s) are checked before the handler runs. |
| `null` / empty array | Not fund-moving: the action is passed through untouched, with no invented verdict. |
| Throws, or returns a malformed value | **Fail-closed halt.** The handler never runs and the failure is reported as an `undetermined` halt (`AdapterMappingError` is the cause). LangChain returns an error `ToolMessage`, ElizaOS returns `false`, MCP returns `isError: true`, and the Vercel AI adapter throws `PreFlightUndeterminedError`. |

A malformed value is anything that is not `{ contract, fn, args }` with a
non-empty `contract` and `fn` and an array of `args`. Because the mapping failed
before any call existed, the `onBlocked` payload for this halt has
`kind: "undetermined"`, `reason: null` and no `call` field.

```ts
createLangChainGuardMiddleware({
  interceptor,
  toContractCall: (request) => {
    if (!request.toolCall.name.startsWith("stellar_")) return null; // not fund-moving
    return toContractCall(request.toolCall.args); // must be valid or throw
  },
  onBlocked: (info) => {
    // info.kind is "blocked" for a refusal and "undetermined" for a
    // mapping failure or a failed enforcement run.
    alert(info.explanation);
  },
});
```

## Observer hooks: never awaited, never unhandled

`onDecision` and `onBlocked` are advisory. The adapters call them with a
try/catch **and** attach a rejection handler when the callback returns a
thenable, so an `async` sink is safe:

- a synchronous throw or a rejected promise is swallowed (and reported to
  `blockedHookLogger` when supplied);
- the hook is not awaited, so a slow sink cannot delay the guard or the handler;
- an observer failure can never turn a halt into an executed action, nor a pass
  into a refusal.

```ts
createLangChainGuardMiddleware({
  interceptor,
  toContractCall,
  onBlocked: async (info) => {
    await fetch(WEBHOOK_URL, { method: "POST", body: JSON.stringify(info) });
  }, // a rejection here is isolated; it cannot un-block the action
  blockedHookLogger: logger, // optional: where the swallowed failure is reported
});
```

Without `blockedHookLogger` the SDK stays silent, exactly as before issue #314.

## Cancellation and timeouts

Every adapter forwards `signal` and `timeoutMs` to the interceptor's
`check()`/`checkBatch()`, with no framework dependency:

```ts
const controller = new AbortController();
const validate = createGuardValidator({
  interceptor,
  toContractCall,
  signal: controller.signal, // abort when the agent run is cancelled
  timeoutMs: 2_000, // bound each RPC call the check makes (0 disables)
});
```

Where the host hook exposes an invocation signal, it takes precedence over the
adapter-level default: `guardMcpToolHandler` forwards `extra.signal` from the MCP
SDK, and the LangChain middleware forwards a `signal` on the tool-call request
(or on `request.runtime`). ElizaOS's `validate` hook exposes no invocation
signal, so use the option-level `signal` there. A pre-aborted signal or a fired
timeout produces an `undetermined` verdict, which every adapter fails closed on —
it never becomes a silent pass. The forwarding itself is pinned by
`tests/unit/adapter-conformance.test.ts`.

## Vercel AI SDK

The AI SDK's language-model middleware sees tool calls only after the model has
already emitted them, so this adapter guards at the earliest pre-execution point
the SDK owns: the tool's own `execute` function (`ai` ≥ 4.1 / 5.x document
exactly this "wrap the tool function" pattern; tested against that structural
`Tool` shape).

```ts
import { createVercelAIGuard } from "stellar-agent-guard-sdk";

const guard = createVercelAIGuard({
  interceptor,
  toContractCall: ({ toolName, input }) =>
    toolName === "send_payment" ? toTransferCall(input) : null,
});

const sendPayment = guard("send_payment", {
  description: "Send SAC tokens from the guarded account",
  execute: async (input) => /* submit and return a result */ { ... },
});

// Pass `sendPayment` to generateText / streamText tools, or wrap it inside
// wrapLanguageModel's tool-wrapping hook — the guard verdict is decided before
// execute ever runs, in both placements.
```

Verdict → halt semantics, shared across all three adapters:

| Verdict | LangChain | ElizaOS | Vercel AI SDK |
|---|---|---|---|
| `admissible` | tool runs | validate returns `true` | tool `execute` runs |
| `blocked` | error `ToolMessage`, tool never entered | validate returns `false` | throws `GuardBlockedError` before `execute` |
| `undetermined` | error `ToolMessage`, tool never entered | validate returns `false` (fails closed) | throws `PreFlightUndeterminedError` before `execute` |
| mapping failure (throws/malformed) | error `ToolMessage` naming the mapping failure | validate returns `false` | throws `PreFlightUndeterminedError` with the `AdapterMappingError` cause |

Throwing on refusal is deliberate here: the AI SDK renders a thrown tool error
into its error stream, and a blocked call must not produce a tool *result* the
model could read as success. `ai` is an optional peer capability — the adapter
is written structurally, so the SDK takes no dependency on the `ai` package.
