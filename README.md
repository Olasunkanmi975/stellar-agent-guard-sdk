<!-- npm keywords: stellar, soroban, ai-agents, guardrails, stellar-sdk, policy, firewall, langchain, elizaos, non-custodial, smart-account, custom-account-abstraction, spend-limits, allowlist, telemetry, typescript, web3, blockchain-security -->
<p align="center">
<img src="Gemini_Generated_Image_mvimg2mvimg2mvim.jpeg" alt="Stellar Agent Guard" width="700"/>
</p>
<p align="center">
<a href="https://github.com/aigbagbobila/stellar-agent-guard-sdk/actions/workflows/ci.yml">
<img src="https://github.com/aigbagbobila/stellar-agent-guard-sdk/actions/workflows/ci.yml/badge.svg" alt="CI"/>
</a>
<a href="LICENSE">
<img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"/>
</a>
<a href="https://nodejs.org/">
<img src="https://img.shields.io/badge/node-24%2B-blue" alt="Node 24+"/>
</a>
<!-- docs: <a href="#"><img src="https://img.shields.io/badge/docs-GitBook-blue" alt="Documentation"/></a> (added in P2 once GitBook URL is confirmed live) -->
</p>

# Stellar Agent Guard — SDK

<!-- 📚 **[Documentation](...)** (added in P2 once GitBook URL is confirmed live) -->

**Non-custodial TypeScript SDK and pre-flight policy interception firewall for AI agents on Stellar.**

An autonomous agent holding a wallet has a single point of failure: one prompt-injection or one buggy loop can drain it. Stellar Agent Guard makes that impossible on-chain — the agent's funds stay in its own smart account, and *every* transaction the account must authorize is intercepted by the contract's  and rejected pre-broadcast unless it satisfies the operator's installed policy: per-transaction spend caps, a rolling-window spend limit, recipient/asset allowlists, protocol allowlists, a pause switch, and a dead-man switch. This SDK provides the integration layer: pre-flight simulation interception, zero-broadcast fee estimation, agent-auth transaction signing, and dual-stream event telemetry for AI agent frameworks (LangChain, ElizaOS).

**Status: Phase 2 complete — and the package is published.** [`stellar-agent-guard-sdk@0.1.1`](https://www.npmjs.com/package/stellar-agent-guard-sdk) is live on the npm registry (`npm install stellar-agent-guard-sdk`). All five enforcement scenarios were proven against live Stellar testnet (protocol 28) with real contract IDs, transaction hashes, and diagnostic events — evidence is recorded in [`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md). Phase 2 code is merged into `main` with green CI (`ci` status check). For historical release notes and publish pipeline reconciliation, see [`docs/publishing-history.md`](docs/publishing-history.md).

## 🎯 What makes this different

Enforcement happens **inside the account itself**, via Soroban's native Custom Account Abstraction — not in a wrapper contract in front of funds, and not in an off-chain service.

- **Pre-flight simulation without broadcast**: The SDK evaluates guard approval against Soroban RPC before a single byte hits the network. If the transaction violates policy, it is rejected client-side with the contract's own reason code, incurring zero network fees.
- **Dual-stream telemetry**: Blocked decisions never commit to the ledger because Soroban rolls back failed authorizations. A listener that only tails committed ledger events sees a guard that appears to approve everything. The SDK extracts `event_auth_checked` from simulation diagnostics as well as committed blocks.
- **In-process simulation pricing**: `CostPreChecker` computes network resource and inclusion fees directly from the enforced simulation, avoiding dependencies on external profiling tools.
- **Framework middleware**: Plug-and-play middleware for LangChain and validators for ElizaOS halt execution before external tool calls run.

> ⚠️ **Disclaimer:** This is unaudited security tooling that gates real fund access. Do not deploy to mainnet without an independent audit. See the contracts repo's [SECURITY.md](https://github.com/aigbagbobila/stellar-agent-guard-contracts/blob/main/SECURITY.md).

## What it does

- **Pre-flight policy interception (`PreFlightInterceptor`)**: Intercepts contract calls before broadcast, simulates auth authorization, and returns a discriminated `admissible`, `blocked`, or `undetermined` verdict. Never throws on policy refusal; an opt-in short-lived cache can reduce repeated simulation RPC calls within the current ledger.
- **In-process cost pre-checking (`CostPreChecker`)**: Prices transaction execution from simulation results, reporting resource fees, inclusion fees, and total fees against an optional ceiling.
- **Autonomous transaction execution (`invoke()`)**: Executes the full Soroban lifecycle: probe simulation, auth signing for custom accounts, enforced simulation, and broadcast with bounded retry for stale ledger resource limits (`scecExceededLimit`) and minimum-fee rejections (`tx_insufficient_fee`).
- **Framework adapters**:
  - `createLangChainGuardMiddleware`: Halts tool execution if the interceptor blocks the planned action.
  - `createGuardValidator`: ElizaOS action validator returning boolean verdicts before actions run.
  - `createVercelAIGuard`: Vercel AI SDK tool wrapper asking the guard before a tool's `execute` runs.
- **Telemetry listener (`GuardTelemetryListener`)**: Tails both committed events and diagnostic streams, decoding contract topics and reason codes. Opt-in sliding-window counters expose agent self-monitoring via `stats()`.

> ⚠️ **Trust & limitations:** pre-flight is an **advisory**, zero-broadcast
> guardrail — it reports what the simulation predicts the guard will do, and it
> can be wrong if the RPC lies. It does **not** replace the contract: every
> authorized call is enforced on broadcast by `__check_auth`, and a malicious
> RPC can feed a fake pre-flight verdict but cannot forge the agent's signature
> or the guard's own decision event. See
> [`docs/threat-model.md`](docs/threat-model.md) for the full threat model
> (verdict-inversion, stale-cache verdicts, compromised runtime, fake-RPC
> simulation, single-dependency supply chain).

## Quick Start

> **A verdict is a prediction, not a settlement guarantee.** Before relying on a
> pre-flight approval, read [Fidelity & limits](#fidelity--limits) — the four
> known gaps in simulation fidelity, and what the SDK does about each.

### Installation

```bash
npm install stellar-agent-guard-sdk
```

> **Module Format & Environment Note:**
> `stellar-agent-guard-sdk` is published strictly as **pure ESM** (`"type": "module"`) targeting **Node.js >= 24.0.0** (declared in `engines`).
>
> If your project or toolchain runs in CommonJS (e.g. legacy LangChain setups, Jest configs, or `.cjs` scripts), load the SDK using the dynamic `await import()` pattern:
>
> ```javascript
> // CommonJS (.cjs or package without "type": "module")
> async function run() {
>   const { PreFlightInterceptor, CostPreChecker } = await import("stellar-agent-guard-sdk");
>   // use interceptor, cost pre-checker, etc.
> }
> ```
>

The full tested matrix — Node version, ESM/CJS behaviour, browser and bundler
targets, plus the environments that are explicitly unsupported — is in
[`docs/runtime-support.md`](docs/runtime-support.md).

*(Or build locally from source with Node 24+)*

```bash
git clone https://github.com/aigbagbobila/stellar-agent-guard-sdk.git
cd stellar-agent-guard-sdk
npm ci
npm run build
```

### Live testnet suite (`.env.phase2`)

The unit suite needs no credentials. The **live** suite (`npm run test:integration`)
runs real transactions against the deployed Phase 2 testnet instance and reads
its signing keys from a gitignored `.env.phase2`. Start from the committed
template, which documents every key and what each one unlocks without carrying a
value:

```bash
cp .env.phase2.example .env.phase2   # then fill in the values
npm run deploy:phase2                # or provision a fresh instance and write it for you
npm run test:integration
```

`tests/integration/harness.ts` validates the file up front. When it is
incomplete it fails once with **every** missing key named — not one key per run,
which would make setup a guessing game of five round trips:

```
.env.phase2 is incomplete: 3 required key(s) are missing:
  - PHASE2_ADMIN_SECRET
  - PHASE2_RECIPIENT_SECRET
  - PHASE2_OUTSIDER_SECRET

Copy the documented template and fill it in:  cp .env.phase2.example .env.phase2
Or provision a fresh instance (writes the file, including PHASE2_ISSUER_SECRET):  npm run deploy:phase2
```

The required keys are `PHASE2_GUARD`, `PHASE2_TOKEN`, `PHASE2_ADMIN_SECRET`,
`PHASE2_AGENT_SECRET`, `PHASE2_RECIPIENT_SECRET` and
`PHASE2_OUTSIDER_SECRET`, plus optionally `PHASE2_RPC_URL`;
`PHASE2_ISSUER_SECRET` is additionally required to (re)deploy. `.env.phase2` is
gitignored (as are all `.env.*` values files — only `*.example` templates are
committable); never commit the filled-in copy.

### Pre-flight Policy Interception

```ts
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { PreFlightInterceptor, isContractAddress, type ContractAddress } from "stellar-agent-guard-sdk";

// Validate contract address from environment
const guardAddress = process.env.GUARD_ADDRESS;
if (!isContractAddress(guardAddress)) {
  throw new Error(`Invalid guard contract address: ${guardAddress}`);
}

// For known hardcoded addresses, use type assertion
const contractAddress = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB" as ContractAddress;

const interceptor = new PreFlightInterceptor({
  server: new rpc.Server("https://soroban-testnet.stellar.org"),
  networkPassphrase: "Test SDF Network ; September 2015",
  guard: guardAddress, // Type-safe: validated as ContractAddress
  agent: Keypair.fromSecret(process.env.AGENT_SECRET!),
  source: Keypair.fromSecret(process.env.SOURCE_SECRET!),
});

const decision = await interceptor.check({
  contract: contractAddress,
  fn: "transfer",
  args: [/* from, to, amount */],
});

if (decision.kind === "admissible") {
  console.log("Allowed! Resource fee:", decision.estimatedResourceFee);
} else if (decision.kind === "blocked") {
  console.log("Blocked by guard:", decision.reason);
} else {
  console.log("Undetermined (fails closed)");
}
```
#### Adapter verdict handling

Both framework adapters wrap the same `PreFlightInterceptor` but expose different contracts, so the same verdict maps to different observable behavior per adapter. The table below is the source of truth enforced by the shared adapter test harness (`tests/integration/adapters.test.ts`); each row is one adapter × one verdict, and the expected-behavior columns differ only where the adapter contracts say they differ.

| Verdict | LangChain (`createLangChainGuardMiddleware`) | ElizaOS (`createGuardValidator`) |
|---|---|---|
| `admissible` | Passes through; the wrapped tool handler runs. | Returns `true`; the action is a candidate for execution. |
| `blocked(reason)` | Halts the tool call and returns a `ToolMessage` carrying the contract `reason` and explanation; the tool handler never runs. | Returns `false`; the action is excluded from candidate execution. |
| `undetermined(cause)` | Halts the tool call with a formatted `ToolMessage` (fails closed); the tool handler never runs. | Returns `false` (fails closed); the action is excluded from candidate execution. |
| Mapping failure (`toContractCall`/`toContractCalls` throws or returns a malformed call) | Halts with an error `ToolMessage` describing the mapping failure (reported to `onBlocked` as `undetermined`); the tool handler never runs. | Returns `false`; the action is excluded from candidate execution. |
| Not fund-moving (`toContractCall` returns `null`) | Passes through untouched: `null` means "no funds move", not "allowed", so no verdict is invented. | Returns `true` for the same reason; the guard has no opinion. |

Adapter callbacks (`onDecision`, `onBlocked`) are never awaited. A callback that throws, or returns a promise that rejects, is isolated — it is reported to the optional `blockedHookLogger` and can never resume a halted action or become an unhandled rejection (issue #313). Every adapter also accepts `signal` and `timeoutMs`, which are forwarded to the pre-flight check; an abort or a fired timeout yields the same fail-closed `undetermined` halt as any other enforcement failure (issue #315).


#### Branded Address Types (v0.2.0+)

This version introduces **branded types** to distinguish contract addresses (C...) from account addresses (G...) at compile time, preventing a common source of bugs where an address is used in the wrong context.

**Type Guards:**

```ts
import { 
  isContractAddress,    // Validates C... addresses
  isAccountAddress,     // Validates G... addresses
  isStrKeyAddress,      // Validates any StrKey (C... or G...)
  isPublicKeyHex,       // Validates 64-char hex public keys
} from "stellar-agent-guard-sdk";

// Runtime validation before use
if (!isContractAddress(userInput)) {
  throw new Error("Expected contract address (C...)");
}
```

**Migration:** If upgrading from an earlier version, see [MIGRATION.md](./MIGRATION.md) for guidance on updating your code to use typed addresses.

#### Branded Address Types (v0.2.0+)

This version introduces **branded types** to distinguish contract addresses (C...) from account addresses (G...) at compile time, preventing a common source of bugs where an address is used in the wrong context.

**Type Guards:**

```ts
import { 
  isContractAddress,    // Validates C... addresses
  isAccountAddress,     // Validates G... addresses
  isStrKeyAddress,      // Validates any StrKey (C... or G...)
  isPublicKeyHex,       // Validates 64-char hex public keys
} from "stellar-agent-guard-sdk";

// Runtime validation before use
if (!isContractAddress(userInput)) {
  throw new Error("Expected contract address (C...)");
}
```

**Migration:** If upgrading from an earlier version, see [MIGRATION.md](./MIGRATION.md) for guidance on updating your code to use typed addresses.

#### Throw vs. Verdict Contract

The same doctrine extends to adapter construction: **misconfiguration throws at construction; blocked actions return/throw as documented.** Adapter factories (`createLangChainGuardMiddleware`, `createGuardValidator`) validate their options synchronously before returning, so a missing `toContractCall`, an interceptor lacking a `check` method, or an empty options object fails fast at setup — never mid-loop on the first live tool call. See [Adapter options validation](#adapter-options-validation-fail-fast-at-construction) below.

Pre-flight policy interception makes an intentional asymmetric distinction between programmer errors and policy outcomes:

- **Input validation throws `InvalidInputError` (synchronous)**: If a `ContractCall` is malformed (invalid StrKey contract ID, missing or non-symbol-shaped function name, invalid arguments array, or non-`i128` amount), `interceptor.check()` throws `InvalidInputError` synchronously without dispatching any network RPC request.
- **Policy refusals return a verdict (`kind: "blocked"`)**: When input is valid but policy disallows the action (spend cap exceeded, recipient not allowlisted, account paused), this represents expected guardrail operation. `check()` returns `{ allowed: false, kind: "blocked", reason, explanation, ... }` instead of throwing.
- Callers requiring a throw-on-refusal flow can use `interceptor.assertAllowed(call)`, which throws `GuardBlockedError` on `blocked` and `PreFlightUndeterminedError` on `undetermined`.

### Adapter options validation (fail-fast at construction)

Adapter factories validate their options **synchronously at construction time**, before any action runs. A misconfigured adapter throws a typed `GuardError` (subclass `AdapterConfigError`) naming the offending field and its expected shape — it never surfaces as a mid-loop failure on the first production tool call.

### Fidelity & limits

Pre-flight simulation is a prediction made against one ledger snapshot, not a settlement guarantee. These are the four known limitations of that prediction, each with the mitigation the SDK applies and the residual risk that remains. Every claim is pinned to the function that implements it so a reviewer can check it rather than trust it.

1. **Window state can move between `check` and broadcast (concurrent spenders).**
   - *Mitigation:* `PreFlightInterceptor.check()` never broadcasts; it calls `enforceCall()` (`src/invoke.ts`) to run the guard's real `__check_auth` against live ledger state, which is what makes a refusal free. Under `invoke()`, `withAccountQueue()` (`src/invoke.ts`) serializes fetch → build → submit per source account, and the committed contract re-evaluates the rolling window atomically. If the window moved anyway, the post-inclusion refusal is still reported as `blocked` with `charged: true` (`src/invoke.ts`).
   - *Residual risk:* a spender that does not route through this SDK's queue, or that uses a different source account, can consume the window after an `admissible` verdict; the transfer can then be refused on-chain and, when it reaches inclusion, charged. The optional cache reuses verdicts within one ledger, so a cached `admissible` can be staler than one admitted transfer (`src/preflight.ts`).

2. **The fee market can move (fee-bump).**
   - *Mitigation:* `CostPreChecker.checkWithCost()` and `costOf()` (`src/cost.ts`) derive the quote from the same enforced simulation that produced the verdict, so price and verdict never describe two snapshots, and `feeBreakdown()` uses the same `INCLUSION_FEE` the submitted envelope declares (`src/tx.ts`).
   - *Residual risk:* Soroban fees are dynamic and the SDK does not implement fee-bump handling. A fee-bump or an inclusion/base-fee change between simulation and broadcast can move the real price. `maxFeeStroops` in `CostPreChecker` is a pre-flight ceiling, not a network guarantee.

3. **Simulation does not execute — return-value-dependent effects are invisible.**
   - *Mitigation:* the enforced simulation runs the real `__check_auth` (Step 3 of `enforceCall()`, `src/invoke.ts`), and refusals are recovered from simulation diagnostics by `reasonFromDiagnosticEvents()` (`src/invoke.ts`) and `decodeAuthDecision()` (`src/events.ts`) even though a rolled-back block never commits to a ledger.
   - *Residual risk:* simulation rolls back its writes; it cannot reveal effects that depend on a return value or on state another call would produce (an oracle price, a swap quote, a balance read mid-transaction). Such a call can be `admissible` pre-flight and still behave differently on-chain. Telemetry `telemetryFromDecision()` (`src/telemetry.ts`) observes the decision event, not the call's return value.

4. **Multi-context batch semantics are approximated (batch).**
   - *Mitigation:* `PreFlightInterceptor.checkBatch()` and `preflightBatch()` (`src/preflight.ts`) simulate each call in sequence with staged window accounting, so a call that passes in isolation but pushes cumulative spend past `window_cap` is reported `blocked` with `window_cap_exceeded`.
   - *Residual risk:* it is sequential single-call simulation, not atomic batch simulation. State mutations between calls other than guard window spend are not observed, intra-batch window expiry is not modelled, and `totalEstimatedResourceFee` is the sum of per-call estimates rather than one envelope's fee (`src/preflight.ts:571`). The intended fix is to route to a contract-side `check_batch` once it lands, keeping this sequential staging as the fallback.

### Optional simulation-result cache

`PreFlightInterceptor` always performs a fresh simulation by default. For agent
loops that repeatedly check the same call, caching can be enabled explicitly:

```ts
const interceptor = new PreFlightInterceptor({
  server,
  networkPassphrase,
  guard,
  agent,
  source,
  cache: {
    ttlLedgers: 1, // maximum one approximate five-second ledger window
    policyRevision: () => readPolicyRevision(),
  },
});

const first = await interceptor.check(call);
const second = await interceptor.check(call); // may reuse the first verdict
interceptor.invalidate();                       // clear all entries
interceptor.invalidate(call);                  // clear one call's entries
```

The cache is **disabled unless `cache` is supplied**. It stores only actual
`admissible` and `blocked` decisions; transient `undetermined` results are not
cached. A cache key includes the contract, function, canonical XDR argument
fingerprint, interceptor identity, and the supplied policy revision. The cache
is discarded when the observed ledger advances, when the TTL expires, or when
`invalidate()` is called. `ttlMs` and `ttlLedgers` are both capped at one
approximate ledger-close interval; if both are supplied, `ttlMs` takes
precedence.

A **cached verdict can be staler than one admitted transfer**. The rolling spend
window can change after a simulation while a cached result is still being
reused, so callers that cannot tolerate that tradeoff should leave caching off,
use a shorter TTL, provide a policy revision, and invalidate after policy or
account-state changes.

### Cost Pre-Checking with Policy Context

```ts
import { CostPreChecker } from "stellar-agent-guard-sdk";

const checker = new CostPreChecker({
  interceptor,
  maxFeeStroops: 50_000n,
  policySource: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44", // opt-in policy source
});

const result = await checker.check({
  contract: "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB",
  fn: "transfer",
  args: [/* from, to, amount */],
});

console.log("Cost verdict:", result.kind); // within_budget | over_budget | blocked | undetermined
console.log("Policy context:", result.policyContext);
```

#### Policy Context Semantics

When an opt-in `policySource` (contract address or `GuardPolicy`/`PolicyConfig`) is configured in options, `CostPreCheckResult` exposes additive `policyContext`:

- `perTxCapOk`: Whether the transaction fits within the policy's per-transaction cap (`true` if within cap, `false` if `per_tx_cap_exceeded`, or `null` if not determinable).
- `windowRemainingEstimate`: Estimated remaining budget in the current rolling window. **Always `null` when the contract does not expose sufficient window state.**
  > `null` means "not available / cannot be determined from the current contract state", not "zero remaining budget". The SDK never fabricates a zero budget.
- `reason`: The contract's policy block reason (e.g. `"window_cap_exceeded"` or `"per_tx_cap_exceeded"`), or `null` when allowed.
- When no policy source is configured in options, `policyContext` is `null` (no policy call is made).

### Deterministic time control in tests (Clock injection)

Time-dependent operations (cache TTL, transaction polling) support optional `Clock` injection for deterministic testing without real delays.

**For tests**, use `FakeClock` to control time:

```ts
import { FakeClock, PreFlightInterceptor } from "stellar-agent-guard-sdk";

test("cache entry expires", async () => {
  const clock = new FakeClock(0);
  const interceptor = new PreFlightInterceptor({
    server,
    guard,
    agent,
    source,
    cache: { ttlMs: 5000 },
    clock, // Inject the fake clock
  });

  const decision1 = await interceptor.check(call);

  // Advance clock without real delays
  clock.advance(6000); // Skip to t=6000ms (past the 5000ms TTL)

  const decision2 = await interceptor.check(call); // Cache expired, fresh lookup
});
```

**For production**, no action is needed: modules default to the system clock. The `Clock` interface is purely optional and for testing.

Key methods on `FakeClock`:

- `now()` — returns current time in milliseconds
- `sleep(ms)` — returns a promise (resolves instantly when time allows)
- `advance(ms)` — move the clock forward deterministically
- `setTime(ms)` — set clock to an absolute time

Time-dependent modules (preflight cache, transaction polling) accept an optional `clock` parameter. When omitted, they use the system clock (`Date.now()`, real `setTimeout`). Tests pass a `FakeClock` to eliminate real waits and make timing deterministic. For full guidance, see [CONTRIBUTING.md](CONTRIBUTING.md) under "Deterministic time control in tests".

### Pipeline step observability (`onStep`)

`invoke()` accepts an **optional** `onStep` callback. When omitted, behavior is
exactly as before — the hook is pure observability and writes nothing itself
(what you do with the events is up to you; for the SDK's own diagnostics see
[Optional logging](#optional-logging-the-sdk-is-silent-unless-you-ask)):

```ts
const outcome = await invoke({
  server,
  source,
  call,
  networkPassphrase,
  guardAuth,
  onStep(step) {
    // consumer decides how to display/log the event
    console.log(`[${step.attempt}] ${step.name} ${step.status} in ${step.durationMs}ms`);
  },
});
```

Event shape (`InvokeStepEvent`):

| Field | Meaning |
|---|---|
| `name` | Pipeline stage: `probe` → `sign` → `simulate` → `broadcast` (the shared `TRACE_STEP_NAMES` vocabulary). |
| `status` | `start` (emitted immediately before the stage runs), then `ok` or `fail`. |
| `durationMs` | Elapsed time of **this stage attempt** in milliseconds — not the total `invoke()` duration. Always `0` on `start`. |
| `attempt` | 0-based retry index. `0` for the first pass; `1` on the built-in stale-ledger re-run. Always present. |

The callback is optional, receives every stage attempt (a retried invoke emits
a full `probe → sign → simulate → broadcast` sequence per attempt, each tagged
with its `attempt` index), and **callback exceptions are isolated**: a throwing
`onStep` never breaks the pipeline, never turns a successful invoke into a
failure, and never masks the original pipeline error — callback errors are
swallowed silently, because the callback is the caller's own code and not the
SDK's sink to report through. Step names come from the same shared vocabulary
the dry-run trace uses (`TRACE_STEP_NAMES`), so consumers of either see
identical stage names.

The LangChain adapter exposes the same capability:

```ts
const middleware = createLangChainGuardMiddleware({
  interceptor,
  toContractCall: (request) => (/* ... */),
  onStep(step) {
    // enforcement-stage events (probe → sign → simulate; never broadcast)
  },
});
```

### Optional logging: the SDK is silent unless you ask

A library that prints pollutes its host's logging pipeline — structured logs,
level filtering, redirection — so **the SDK writes nothing by default.** The
audit behind that claim, run for this change: `src/` contained exactly one
`console.*` call, an env-gated debug dump in the invoke pipeline
(`SAG_DEBUG_RESOURCES=1`). It is gone, and its description now goes to an
injected logger, or nowhere. A unit test scans `src/` for console calls and
direct stdout/stderr writes, so a new one fails `npm test` rather than quietly
appearing in a host's output.

What the SDK knows is still available, through an optional `logger` on every
config that has a decision point — `PreFlightInterceptor`, `CostPreChecker`,
`GuardTelemetryListener` and `invoke()`. Pass any object with the four levels;
`console` itself satisfies the interface, as does a pino or winston child
logger. Each call gets a complete message plus optional structured detail, so a
logger that ignores the detail still reads well:

```ts
import { PreFlightInterceptor } from "stellar-agent-guard-sdk";

const interceptor = new PreFlightInterceptor({
  server,
  networkPassphrase,
  guard,
  agent,
  source,
  logger: {
    debug: (message, meta) => log.debug({ ...meta }, message), // stages, cache hits, retries
    info: (message, meta) => log.info({ ...meta }, message), // a guard refusal
    warn: (message, meta) => log.warn({ ...meta }, message), // undetermined, fee ceiling, coverage gap
  },
});

const decision = await interceptor.check(call); // same verdict, same fees — now audible
```

A level the host omits is dropped rather than routed elsewhere, and a level that
throws is isolated: a broken sink cannot turn an admissible verdict into an
error, change a retry count, or fail a broadcast. Logging is observability, and
observability never decides whether a transaction runs. `logger: console` is
the one-liner that restores the removed `SAG_DEBUG_RESOURCES=1` behaviour
deliberately, instead of a library making that choice for its host.

### Framework Middleware (LangChain & ElizaOS)

When deploying fleets of hundreds or thousands of autonomous agents derived from identical templates or scheduled loops, fixed poll intervals (e.g. exactly every 5s) cause all instances to poll RPC nodes in lockstep phase. This creates synchronized traffic spikes (thundering herds) against public Soroban RPC endpoints, triggering aggressive HTTP 429 rate limits and cascade backpressure errors.

`GuardTelemetryListener.watch()` defaults to `jitter: 'full'`, which uniformly randomizes each poll delay in `[intervalMs * (1 - j), intervalMs]` with `j = 0.2` (a 20% variance window). This breaks lockstep fleet synchronization while keeping polling responsive and bounded. Deterministic fixed interval cadence can be restored when needed by specifying `jitter: 'none'`.

```ts
// Follow event telemetry with full jitter (default)
for await (const events of listener.watch({
  pollIntervalMs: 5_000,
  jitter: "full", // uniformly distributed in [4000ms, 5000ms]
})) {
  console.log(`Received ${events.length} guard event(s)`);
}
```

### Aborting a watch: what cancellation does and does not cover

`watch({ signal })` ends the stream — aborting is a normal exit, never a throw.
Abort is honoured at **loop boundaries**: before the first request (an
already-aborted listener issues no RPC call at all, not even the
`getLatestLedger` probe that resolves a default `startLedger`), before each
poll, and during the delay between polls. The default delay's timer is cleared
on abort, so a stopped listener leaves no open handle behind for a Node process
or a test suite to hang on.

```ts
const controller = new AbortController();
for await (const events of listener.watch({ signal: controller.signal })) {
  handle(events);
}
// Runtime teardown, a new tool call, or a shutdown hook:
controller.abort(); // the loop ends, and no further getEvents is issued
```

**One limitation, stated rather than papered over: a request already in flight
is not cancelled.** `@stellar/stellar-sdk` ^17 (the version this package
depends on, `dependencies` in `package.json`) declares
`getEvents(request: Api.GetEventsRequest)` with no `AbortSignal` parameter, and
its internal JSON-RPC `postObject` helper takes no per-request config, so there
is no supported way to plumb a signal through to the socket. The listener
consequently stops *issuing* requests immediately but cannot cancel one already
sent: the worst case between `signal.abort()` and the iterator ending is **one
request duration** — never a whole poll interval. The rejection of that
in-flight request (or of an abort-aware `sleep`) is swallowed as teardown, so an
aborted watch ends quietly in a `for await` loop instead of surfacing an
`AbortError` or an unhandled rejection.

Revisit this when the SDK adds per-request signals to `getEvents`; until then,
read `signal` as *stop soon and stop asking*, not *cancel the socket*.

### Bounding a check or an invoke (`signal` and `timeoutMs`)

`check()`, `checkBatch()`, `CostPreChecker.check()` and `invoke()` each accept
two optional caller-owned bounds on the RPC calls they make:

- `signal?: AbortSignal` — your runtime's cancellation (a tool-loop deadline, a
  shutdown hook, a user's "stop"). An **already-aborted** signal returns before
  any RPC call is issued. On a batch it stops the batch: no further call is
  started, and every unfinished call is reported as fail-closed `undetermined`.
- `timeoutMs?: number` — a per-RPC-call budget in milliseconds. It defaults to
  `DEFAULT_RPC_TIMEOUT_MS` (**30s**), because a network partition that leaves a
  guardrail call pending forever is a hang, not a fail-closed decision. Pass
  `timeoutMs: 0` to opt out and rely on `signal` alone.
- `deadlineMs?: number` — **`invoke()` and `checkBatch()`**: one overall budget
  for the whole action (for a batch: policy read plus every staged call). Expiry
  is fail-closed and reported as an `RpcTimeoutError` with `deadline: true`; it
  can never become an `allowed` outcome. On a batch, calls that never started are
  `undetermined` rather than skipped. Pass `clock` to make the accounting
  deterministic in tests. See `docs/api/invoke-pipeline.md`.

**Concurrent identical checks are coalesced.** `PreFlightInterceptor` shares one
in-flight discovery/enforcement run when the same call and config are checked at
the same time, so an agent framework issuing duplicate tool checks in one
planning turn does not pay for duplicate RPCs. This is not a cache: the entry is
removed as soon as the run settles, including on failure or `undetermined`. Each
waiter still applies its own `signal`/`timeoutMs` — one caller giving up never
cancels a result another waiter is entitled to — while the shared run itself
keeps the pipeline's default `DEFAULT_RPC_TIMEOUT_MS` bound. Checks that supply
`onStep` keep their own run so each trace sees every event, and
`coalesceInFlight: false` disables coalescing entirely.

**The typed error is the same; where it surfaces is deliberately not.** A bound
that fires raises one class, `RpcTimeoutError` (carrying `stage` and whether it
was an `aborted` signal or a timeout), but the entry points answer different
questions:

| Call | Fired bound |
| --- | --- |
| `check()` / `CostPreChecker.check()` | the fail-closed `undetermined` **verdict** (`decision.error instanceof RpcTimeoutError`) — the guard reached no decision, which is what `undetermined` already means |
| `checkBatch()` | `undetermined` verdicts for the call in flight and for every call that never started; the completed verdicts keep their own kind |
| `invoke()` | `invoke`'s `error` **outcome** (`outcome.error instanceof RpcTimeoutError`) — the pipeline never reached broadcast |

```ts
const decision = await interceptor.check(call, { timeoutMs: 5_000 });
if (decision.kind === "undetermined" && decision.error instanceof RpcTimeoutError) {
  // Fail closed: the guard could not be reached in time.
}
```

Branch on the class, never on `detail`.

**One limitation, stated rather than papered over: the request itself is never
cancelled.** `@stellar/stellar-sdk` ^17's `Server` methods take no
`AbortSignal`, so the SDK races the in-flight promise against your signal and
the timeout. The HTTP request therefore continues server-side until it completes
or the connection drops; the bound cancels *your wait*, not the socket. What it
changes is bounded: a fired bound can only stop the SDK from waiting — it can
never relax a verdict, a cap or a block reason, and a call that is neither
aborted nor timed out behaves exactly as it did before.

### Framework Middleware (LangChain & ElizaOS)

Plug-and-play middleware intercepts agent actions before tools are executed:

- **Framework adapters**:
  - LangChain: [`createLangChainGuardMiddleware`](docs/examples/langchain.md) wraps tool calls using `AgentMiddleware.wrap_tool_call`. If the guard refuses (`blocked`) or the verdict is `undetermined`, execution is halted client-side with a formatted `ToolMessage` carrying the contract reason code and explanation (fails closed). The tool handler never runs, avoiding network submission fees. See the [full runnable LangChain example](docs/examples/langchain.md) ([`examples/langchain.ts`](examples/langchain.ts)).
  - ElizaOS: [`createGuardValidator`](docs/examples/elizaos.md) and [`guardAction`](docs/examples/elizaos.md) compose pre-flight simulation into `Action.validate`. Refused (`blocked`) and `undetermined` actions both return boolean `false` (fails closed), excluding them from candidate execution. See the [full runnable ElizaOS example](docs/examples/elizaos.md) ([`examples/elizaos.ts`](examples/elizaos.ts)).
  - MCP: [`guardMcpToolHandler`](docs/examples/mcp.md) wraps a Model Context Protocol tool handler (`registerTool` / `tool` / `setRequestHandler(CallToolRequestSchema)`), and [`guardMcpCallTool`](docs/examples/mcp.md) wraps a client's `callTool` before the request leaves the process. A refusal is returned as an `isError: true` result and the tool body never runs. See [the MCP integration example](docs/examples/mcp.md).
  - Vercel AI SDK: [`createVercelAIGuard`](docs/api/framework-adapters.md) wraps a tool's own `execute` function — the earliest pre-execution point the `ai` package exposes. `admissible` → the tool runs; `blocked` → `GuardBlockedError` thrown before `execute`; `undetermined` → `PreFlightUndeterminedError` thrown before `execute` (fail-closed, matching the other adapters' refusal behavior). Written structurally against the `Tool` shape, so `ai` stays an optional peer, not a dependency.

#### Operator alerting on every halt (`onBlocked`)

A refusal is visible to the agent (its tool result says so), but not to the human watching dashboards — telemetry is a separate opt-in. Every adapter takes an optional `onBlocked` callback that fires once per halt, so a refusal can be wired to a webhook, log, or alert channel:

```ts
const middleware = createLangChainGuardMiddleware({
  interceptor,
  toContractCall,
  onBlocked: ({ adapter, kind, reason, call, explanation }) => {
    console.warn(`[${adapter}] ${kind}: ${reason ?? "undetermined"} on ${call.fn} — ${explanation}`);
  },
});
```

The payload is the same on every adapter (`{ adapter, kind, reason, call, explanation }`): `kind` is `"blocked"` when the guard refused and `"undetermined"` when enforcement could not decide (in which case `reason` is `null` and `explanation` carries the failure detail — the halt still happens, because the adapter fails closed). The callback is called *after* the halt is decided and its errors are swallowed, so a broken alerting sink can never turn a refusal into an executed action or a thrown error. A swallowed hook failure is silent by default; pass `blockedHookLogger: { error(...) }` when you want that diagnostic. Omit `onBlocked` for exactly the pre-existing behavior.

#### Ordered call batches (`toContractCalls`)

A tool that performs several guarded contract calls can map the whole action with the additive `toContractCalls` mapper instead of `toContractCall`. The complete ordered batch is checked before the handler runs; if any call is blocked or undetermined, the action is refused and no handler side effect occurs (all-or-nothing). `onDecision` receives every per-call verdict in order, and a batch halt's `onBlocked` payload also carries `calls` and `verdicts`:

```ts
const middleware = createLangChainGuardMiddleware({
  interceptor,
  toContractCalls: (request) => [approveCall, swapCall],
  onDecision: (_request, verdict) => report(verdict.kind),
  onBlocked: ({ calls, verdicts }) => alert(`${verdicts.length} calls checked; refused`),
});
```

`toContractCalls` returns `null` or `[]` for a tool that moves no funds, and takes precedence over `toContractCall` when both are supplied.

> **ElizaOS note (0.2.x):** the ElizaOS adapter previously passed the raw `PreFlightDecision` to `onBlocked`; it now receives this structured payload, matching LangChain and MCP. Read `info.reason` / `info.explanation` (or `info.kind`) instead of `decision.reason` / `decision.explanation`.

### Policy validation before broadcast (validateGuardPolicy)

Before encoding and submitting a policy on-chain, validate it client-side with `validateGuardPolicy`.
This provides a **fail-before-broadcast** safety rail that catches configuration errors before burning transaction fees or facing on-chain contract rejections.

Unlike fail-fast validators, `validateGuardPolicy` returns **all** failures at once (`PolicyFailure[]`), which is critical for dashboard form UX where an operator needs to see all field-level issues simultaneously. The failure `rule` identifiers align with SPEC §8 rules:

```ts
import {
  validateGuardPolicy,
  type PolicyConfig,
  type PolicyFailure,
} from "stellar-agent-guard-sdk";

const draftPolicy: PolicyConfig = {
  per_tx_cap: 10_000n,
  window_secs: 0n,         // Incompatible with window_cap > 0
  window_cap: 50_000n,
  assets: [],              // Empty assets vector is a no-op
  protocols: [],
  recipients: ["GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH"],
  allow_any_recipient: false,
  active_from: 1000n,
  active_until: 500n,      // Inverted active window (active_until <= active_from)
  paused: false,
  dms_grace_secs: 0n,
};

const failures: PolicyFailure[] = validateGuardPolicy(draftPolicy, {
  guardAddress: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[${failure.rule}] at ${failure.field}: ${failure.message}`);
  }
  // Safe-exit before encode or broadcast
} else {
  // Proceed with policyToScVal(draftPolicy) and broadcast
}
```

### Policy encode/decode round trip

`decodePolicy` is the canonical read-side counterpart to `policyToScVal`. It returns
`bigint` for every integer field, keeps `ProtocolRule.fns: null` distinct from an empty
array, normalizes Stellar addresses, and rejects missing, duplicate, unknown, unsorted, or
wrongly typed fields with a path-bearing `PolicyDecodeError`.

```ts
import {
  decodePolicy,
  policyToScVal,
  type PolicyConfig,
} from "stellar-agent-guard-sdk";

const policy: PolicyConfig = {
  per_tx_cap: 1_000n,
  window_secs: 60n,
  window_cap: 150n,
  assets: ["CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"],
  protocols: [
    {
      contract: "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB",
      fns: ["transfer"],
    },
  ],
  recipients: ["GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH"],
  allow_any_recipient: false,
  active_from: 0n,
  active_until: 0n,
  paused: false,
  dms_grace_secs: 0n,
};

const encoded = policyToScVal(policy);
const decoded = decodePolicy(encoded); // exactly equal to policy
```

The decoder accepts the direct `ScVal::Map` returned by the deployed `policy()` read and
also the one-element `Vec` representation used by some RPC/host surfaces for
`Some(PolicyConfig)`. `ScVal::Void` means no policy is installed and therefore throws
rather than fabricating a default-deny config. Canonical u64/i128 variants are range
checked exactly; base-10 `ScVal::String` integers are accepted as a deliberate
compatibility path for stringly-typed RPC/telemetry payloads and normalized to `bigint`.

### Debug a blocked transfer with `invoke({ dryRun: true })`

Dry run executes the real probe, authorization signing, and enforced-simulation path,
then returns the verdict, diagnostics, network-derived fees, and per-stage timings. It
stops before final transaction assembly and cannot call `sendTransaction`, so its result
has no transaction hash or submission object.

```ts
import { invoke } from "stellar-agent-guard-sdk";

const debug = await invoke({
  server,
  source,
  call: blockedTransferCall,
  networkPassphrase,
  guardAuth: { guard, agent },
  dryRun: true,
});

if (debug.kind === "dry_run") {
  console.log({
    admissible: debug.admissible,
    verdict: debug.verdict,
    reason: debug.reason,
    fees: debug.fees,
  });
  console.table(debug.steps);
}
```

A blocked or undetermined dry run reports an explicit all-zero **charged** fee breakdown;
an admissible dry run reports the simulation's resource fee plus the SDK's 100-stroop
inclusion floor. Missing, negative, malformed, unsafe-number, or out-of-u64-range fee
payloads are `ContractResponseError` failures and remain undetermined—never free.
`steps[].ok` describes whether a stage completed, not whether policy approved the call;
the separate `verdict` field is the policy answer. The `probe → sign → simulate` stages
are measured through the same `onStep` hook a live invocation uses, so a dry-run trace
and an `onStep` trace are the same measurement of the same code.

### Troubleshooting agent authentication

`verifyAgentSignature` lets an agent runtime check that a signature belongs to the key it
believes is registered before entering an agent loop. The helper is verify-only: it never
accepts, signs with, stores, or derives a private key. Other SDK APIs continue to accept
caller-created `Keypair` objects for transaction/authorization signing as before.

```ts
import { verifyAgentSignature } from "stellar-agent-guard-sdk";

function signerMatches(
  registeredPublicKey: string | Uint8Array,
  hostSignaturePayload: Uint8Array,
  signature: Uint8Array,
): boolean {
  return verifyAgentSignature(
    registeredPublicKey,
    hostSignaturePayload,
    signature,
  );
}
```

`hostSignaturePayload` must be the exact 32-byte host digest covered by the signature;
the helper verifies those bytes without re-hashing and is not SEP-53 message signing. A
successful result proves only the key/payload/signature relationship—it does not validate
network ID, invocation, nonce, expiration ledger, or transaction freshness.

### Typed errors and 0.1.x migration

All operational SDK errors share a `GuardError` base. Invalid caller input is the
deliberate exception: `InvalidInputError` (and `InvalidFeeCeilingError`) extend
`TypeError`, keeping programmer errors distinct from transport, signing and policy
failures. `invoke()` remains result-oriented: inspect `outcome.error` with `instanceof`
when `outcome.kind === "error"`.

```ts
import {
  BroadcastError,
  GuardError,
  SigningError,
  SimulationError,
} from "stellar-agent-guard-sdk";

if (outcome.kind === "error") {
  if (outcome.error instanceof SigningError) {
    console.error("agent signer is wrong or unavailable");
  } else if (outcome.error instanceof SimulationError) {
    console.error("enforcement could not be determined");
  } else if (outcome.error instanceof BroadcastError) {
    console.error("submission failed", outcome.error.transactionHash);
  } else if (outcome.error instanceof GuardError) {
    console.error(outcome.error.message);
  }
}
```

A pipeline stage that throws — a dropped RPC connection, say — is reported the same way:
as `kind: "error"` carrying the original error as the typed error's `cause`, never as a
rejection. A guardrail that could not reach a verdict has no business throwing at its
caller, and the original error object stays reachable for diagnostics.

If ledger state changes after enforced simulation and the included transaction is then
refused by the guard, `invoke()` still returns `kind: "blocked"` with the contract reason
and diagnostics. That charged outcome additionally carries `transactionHash` and
`charged: true`; it is not flattened into a technical `BroadcastError`.

`GuardBlockedError` keeps its published name, message, fields, and `instanceof` behavior
and now extends `GuardError`; `PreFlightUndeterminedError` extends `SimulationError`.
The hierarchy, `decodePolicy`, and `verifyAgentSignature` are additive to 0.1.x callers.
The one intentional behavior change is for callers already using `dryRun: true`: the old
success sentinel (`kind: "error"`) is replaced by the structured `kind: "dry_run"` result
documented above. Non-dry-run callers keep their existing outcome shapes.

### Keep the dead-man switch alive (`startHeartbeat`)

An agent that stops heartbeating freezes. `startHeartbeat` schedules the `heartbeat()` calls and makes the failure modes visible instead of silent — an ad-hoc `setTimeout` loop drops a beat on an event-loop stall and turns an RPC blip into an unhandled rejection.

```ts
import { startHeartbeat } from "stellar-agent-guard-sdk";

const hb = await startHeartbeat({
  server,
  guard: GUARD_ID,
  signer: agentKeypair,        // Keypair or AgentSigner
  intervalMs: 30_000,
  maxSkewMs: 2_000,            // tolerated drift before a beat counts as missed
  onBeat: ({ lateMs }) => { if (lateMs > 2_000) alert("heartbeat late"); },
  onError: (error) => logger.error("heartbeat failed", error),
  graceSecs: 150,              // optional pre-read: validated as interval <= grace/3
});

// on shutdown: request cancellation, wait up to 5s for the in-flight beat
const stop = await hb.stop({ timeoutMs: 5_000 });
if (!stop.settled) logger.warn(`heartbeat stop ${stop.reason}`);
```

- The first beat fires immediately, then every `intervalMs` on a fixed cadence — a slow beat surfaces as lateness on the next one instead of pushing the whole schedule. A submission that outlives several slots skips the stale ones instead of firing a catch-up burst.
- A beat later than `maxSkewMs` increments `hb.missedBeats` and is reported as `lateMs` in `onBeat`; each cadence slot skipped while a submission was in flight is counted too. Alert on lateness, not only on failure. `hb.lastBeatAt` is the epoch ms of the last successful beat.
- Every submission rejection goes to `onError`; nothing escapes as an unhandled rejection.
- `stop()` (or the `signal`) tears down cleanly: no beat is sent after it, and by default it resolves once an in-flight beat has settled. `stop()` first aborts the submission context's `signal`; pass `stop({ timeoutMs })` or set `stopTimeoutMs` when a custom transport might not settle, and inspect `{ reason, settled }` on the result.
- When the grace window is readable (`graceSecs`, or a `readPolicy` read), an interval longer than `grace / 3` throws `HeartbeatIntervalError` **before** the first beat; an unreadable policy warns via `onWarning` and starts anyway.
- A beat that would fall in the same wall-clock second as the previous accepted one is skipped client-side; the contract deduplicates independently.
- Every input is validated **before** the scheduler starts: a negative or non-finite `maxSkewMs`, a negative or non-finite `stopTimeoutMs`, a grace window that is not a non-negative safe integer or bigint, a callback that is not callable, or an unusable retry budget is rejected with an error naming the field — before the first beat, and before the grace window is even read from the chain.

#### Bounded retry for a transient outage

A failed heartbeat used to wait for the next fixed interval, so an RPC outage that landed near the grace boundary could freeze the account even after connectivity returned. `retry` adds a bounded, jittered recovery:

```ts
const hb = await startHeartbeat({
  server,
  guard: GUARD_ID,
  signer: agentKeypair,
  intervalMs: 30_000,
  retry: { maxAttempts: 3 },   // opt-in — the default is one attempt per beat
  onWarning: (message) => logger.warn(message),
  onError: (error) => logger.error("heartbeat failed", error),
});
```

- Only a **transport** failure is retried (a `BroadcastError`, an `RpcTimeoutError`, a `SimulationError`). A **policy block is never retried**: the guard made a decision, and hammering a call it has already refused only adds load. An error the SDK cannot classify is reported, not retried.
- The delay before the next attempt is a full-jitter sample of a bounded window, so agents that hit the same outage do not retry in a synchronized herd.
- The attempt that failed and the delay before the next one are announced through `onWarning`; the failure that ends the beat is reported once through `onError`, with the original error. A successful beat reports how many attempts it took in `onBeat`'s `attempt`.

#### Stopping with an in-flight submission

A custom `submit(beat, { signal })` receives an `AbortSignal` that `stop()` aborts before waiting. The default is still graceful: `stop()` waits for the submission promise to settle, so a transport that honours the signal shuts down promptly. If the transport may never settle, bound the wait with `stop({ timeoutMs })` (or `stopTimeoutMs` on `startHeartbeat`); a fired bound returns `{ reason: "timeout", settled: false }`, while a graceful settle returns the in-flight submission's value or terminal error. No deadline is applied unless you ask for one.

The combined heartbeat-loop + pre-flight pattern is tracked as an integration guide in [#74](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-sdk/issues/74).

## API Reference

> **0.x API Policy & Deprecations:** During `0.x`, this package adheres to an **additive-only within minor** policy (`0.1.x` releases are additive and fixes only; breaking changes and deprecation removals occur only at minor boundaries like `0.2.0`). For full policy details, deprecation mechanics, and the tracking table, see [`docs/deprecations.md`](docs/deprecations.md). Release process and versioning checklist: [`docs/releasing.md`](docs/releasing.md).

### Interception & Execution

- `PreFlightInterceptor`
  - `constructor(options: PreFlightInterceptorOptions)` — Pass `cache: { ttlMs }` or `cache: { ttlLedgers }` to opt into the short-lived cache; omit it for fresh simulations. Concurrent identical `check()` calls share one in-flight run by default; pass `coalesceInFlight: false` to disable that.
  - `check(call: ContractCall, options?: PreFlightCheckOptions): Promise<PreFlightDecision>` — Returns `admissible | blocked | undetermined` without throwing or broadcasting. `options.signal` / `options.timeoutMs` bound the RPC calls it makes; a fired bound returns the fail-closed `undetermined` verdict carrying a typed `RpcTimeoutError` — see [Bounding a check or an invoke](#bounding-a-check-or-an-invoke-signal-and-timeoutms).
  - `checkBatch(calls: ContractCall[], options?: CheckBatchOptions): Promise<PreFlightBatchDecision>` — Returns one verdict per call with all-or-nothing `admissible` semantics. `options.signal` bounds the whole batch, `options.deadlineMs` sets one overall budget, and `options.timeoutMs` stays per-call. A cancelled or over-budget batch stops before the next call and reports every unfinished call as `undetermined`.
  - `assertAllowed(call: ContractCall): Promise<AdmissibleDecision>` — Asserts allowed or throws `GuardBlockedError`.
  - `checkBatch(calls, options?): Promise<PreFlightBatchDecision>` — Stages SAC transfer amounts against the rolling window and returns an `undetermined` batch verdict when a required policy/window read fails instead of assuming zero spend. `assertBatchAllowed()` is the throw-on-refusal form.
  - `invalidate(call?: ContractCall): void` — Clears all cached decisions or only entries for one call.
- `CostPreChecker`
  - `constructor(config: CostPreCheckConfig)` — Accepts `interceptor`, optional `maxFeeStroops`, and optional `policySource` (contract address or `GuardPolicy`).
  - `check(call: ContractCall, options?: CostPreCheckOptions): Promise<CostPreCheckResult>` — Returns `within_budget | over_budget | blocked | undetermined` with additive `policyContext`.
  - `checkWithCost(call: ContractCall): Promise<{ decision, cost }>` — Returns the interceptor verdict and the cost of the **same** single simulation. Prefer this over calling `check()` on both classes.  - `invoke(options: InvokeOptions): Promise<InvokeResult>` — End-to-end pipeline: probe, sign auth, simulate, and broadcast. Accepts an optional `onStep(step: InvokeStepEvent)` hook reporting per-stage `start`/`ok`/`fail` timing events with a 0-based retry `attempt` index; callback exceptions are isolated and omitting the hook changes nothing. `options.signal` / `options.timeoutMs` stop a stalled run; `options.deadlineMs` bounds the whole action including retries and polling. Either bound is reported through `invoke`'s `error` outcome as a typed `RpcTimeoutError`. Terminal outcomes also carry additive `retry` metadata (attempt count, retryable classes, delays and exhaustion) with no payloads or XDR.
- `startHeartbeat(options): Promise<HeartbeatHandle>` — Drift-aware dead-man keep-alive. Fires `heartbeat()` on an interval, reports lateness (`handle.missedBeats`, `onBeat`'s `lateMs`), routes every failure to `onError`, validates `interval <= grace/3` before the first beat when the grace window is readable, and stops cleanly (`await handle.stop()`). See “Keep the dead-man switch alive”.
- `submitHeartbeat(params): Promise<HeartbeatSubmission>` — Signs and submits a single `heartbeat()` with the agent's guard authorization; the default submission `startHeartbeat` uses.
- `HeartbeatBlockedError` / `isRetryableHeartbeatFailure(error)` — The typed refusal of a blocked heartbeat, and the classifier that decides whether a failure is a transport failure (retryable) or a decision (never retried). See [Bounded retry for a transient outage](#bounded-retry-for-a-transient-outage).

#### Fee units: stroops and XLM

`CostPreChecker` reports fees as exact integer stroops — the raw value is the
source of truth, and it is what a `maxFeeStroops` ceiling is compared against.
`formatFee()` renders the same number in XLM, the unit operators think in, using
**integer math only** (XLM has 7 decimal places; float rounding on
money-adjacent output in a security tool is not acceptable) and with no trailing
zeros:

```ts
import { startHeartbeat } from "stellar-agent-guard-sdk";

const hb = await startHeartbeat({
  server,
  guard: GUARD_ID,
  signer: agentKeypair,        // Keypair or AgentSigner
  intervalMs: 30_000,
  maxSkewMs: 2_000,            // tolerated drift before a beat counts as missed
  onBeat: ({ lateMs }) => { if (lateMs > 2_000) alert("heartbeat late"); },
  onError: (error) => logger.error("heartbeat failed", error),
  graceSecs: 150,              // optional pre-read: validated as interval <= grace/3
});

// on shutdown: request cancellation, wait up to 5s for the in-flight beat
const stop = await hb.stop({ timeoutMs: 5_000 });
if (!stop.settled) logger.warn(`heartbeat stop ${stop.reason}`);
```

- The first beat fires immediately, then every `intervalMs` on a fixed cadence — a slow beat surfaces as lateness on the next one instead of pushing the whole schedule. A submission that outlives several slots skips the stale ones instead of firing a catch-up burst.
- A beat later than `maxSkewMs` increments `hb.missedBeats` and is reported as `lateMs` in `onBeat`; each cadence slot skipped while a submission was in flight is counted too. Alert on lateness, not only on failure. `hb.lastBeatAt` is the epoch ms of the last successful beat.
- Every submission rejection goes to `onError`; nothing escapes as an unhandled rejection.
- `stop()` (or the `signal`) tears down cleanly: no beat is sent after it, and by default it resolves once an in-flight beat has settled. `stop()` first aborts the submission context's `signal`; pass `stop({ timeoutMs })` or set `stopTimeoutMs` when a custom transport might not settle, and inspect `{ reason, settled }` on the result.
- When the grace window is readable (`graceSecs`, or a `readPolicy` read), an interval longer than `grace / 3` throws `HeartbeatIntervalError` **before** the first beat; an unreadable policy warns via `onWarning` and starts anyway.
- A beat that would fall in the same wall-clock second as the previous accepted one is skipped client-side; the contract deduplicates independently.
- Every input is validated **before** the scheduler starts: a negative or non-finite `maxSkewMs`, a negative or non-finite `stopTimeoutMs`, a grace window that is not a non-negative safe integer or bigint, a callback that is not callable, or an unusable retry budget is rejected with an error naming the field — before the first beat, and before the grace window is even read from the chain.

#### Bounded retry for a transient outage

A failed heartbeat used to wait for the next fixed interval, so an RPC outage that landed near the grace boundary could freeze the account even after connectivity returned. `retry` adds a bounded, jittered recovery:

```ts
const hb = await startHeartbeat({
  server,
  guard: GUARD_ID,
  signer: agentKeypair,
  intervalMs: 30_000,
  retry: { maxAttempts: 3 },   // opt-in — the default is one attempt per beat
  onWarning: (message) => logger.warn(message),
  onError: (error) => logger.error("heartbeat failed", error),
});
```

- Only a **transport** failure is retried (a `BroadcastError`, an `RpcTimeoutError`, a `SimulationError`). A **policy block is never retried**: the guard made a decision, and hammering a call it has already refused only adds load. An error the SDK cannot classify is reported, not retried.
- The delay before the next attempt is a full-jitter sample of a bounded window, so agents that hit the same outage do not retry in a synchronized herd.
- The attempt that failed and the delay before the next one are announced through `onWarning`; the failure that ends the beat is reported once through `onError`, with the original error. A successful beat reports how many attempts it took in `onBeat`'s `attempt`.

#### Stopping with an in-flight submission

A custom `submit(beat, { signal })` receives an `AbortSignal` that `stop()` aborts before waiting. The default is still graceful: `stop()` waits for the submission promise to settle, so a transport that honours the signal shuts down promptly. If the transport may never settle, bound the wait with `stop({ timeoutMs })` (or `stopTimeoutMs` on `startHeartbeat`); a fired bound returns `{ reason: "timeout", settled: false }`, while a graceful settle returns the in-flight submission's value or terminal error. No deadline is applied unless you ask for one.

The combined heartbeat-loop + pre-flight pattern is tracked as an integration guide in [#74](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-sdk/issues/74).

## API Reference

The complete SDK API reference lives in [`docs/api-reference.md`](docs/api-reference.md) — method signatures, options, return shapes and examples for `PreFlightInterceptor`, `CostPreChecker`, `GuardTelemetryListener`, `validateGuardPolicy`, the framework adapters and the `invoke()` pipeline. The README keeps this stub so the npm landing page stays readable; the reference itself grows alongside the other `docs/` guides.

Prefer this over calling `interceptor.check(call)` and `costChecker.check(call)`
in sequence. That two-call pattern still works and its types are unchanged, but
it carries the fee-drift caveat above. `precheckCostWithDecision()` is the
one-shot form.

### Telemetry & Helpers

- [`docs/event-schema.md`](docs/event-schema.md) — every telemetry event and field, each labelled with its stability tier: **Stable** (relied on), **Append-only** (new values may appear, existing ones will not be removed or renamed), **Best-effort** (may change in any release), **Internal** (implementation detail, not a contract).
- `GuardTelemetryListener`
  - `constructor(options: GuardTelemetryListenerOptions)`
  - `watch(params?: GuardTelemetryWatchParams): AsyncIterable<GuardEventPage>` — Tails on-chain and uncommitted events. `params.signal` aborts at loop boundaries: no RPC call before the first pull, no poll after an abort, and the delay between polls is cut short. A request already in flight cannot be cancelled — see [Aborting a watch](#aborting-a-watch-what-cancellation-does-and-does-not-cover).
  - `watchAll(params?: GuardTelemetryUnifiedParams): AsyncIterable<GuardEvent>` — Merges the committed ledger stream with the `diagnostics` batches you feed it into **one ordered, de-duplicated stream**, so a single loop sees blocked decisions too. Each event carries `stream: 'committed' | 'diagnostic'` and, for diagnostics, `observedAt`. Ordering and de-duplication rules: [`docs/event-schema.md`](docs/event-schema.md).
  - `health(): GuardTelemetryHealthSnapshot` — Read-only operational snapshot: stream state (`idle`/`running`/`recovering`/`stopped`/`aborted`/`failed`), last successful poll, consecutive failures, per-stream cursors, failed-tx degradation, and known coverage gaps. Every field is a copy. Contract: [`docs/api/telemetry-listener.md`](docs/api/telemetry-listener.md#health-guardtelemetryhealthsnapshot).
  - `serializeEvent(event: GuardEvent): string` — Canonical single-line JSON for deterministic JSON-lines log shipping. Fixed key order, drops `undefined`, keeps `null`, renders `bigint` as a decimal string. Contract: [`docs/event-schema.md`](docs/event-schema.md#canonical-json-serialization--serializeevent).
- `validateGuardPolicy(policy: unknown, options?: ValidatePolicyOptions | string): PolicyFailure[]` — Validates policy configuration against SPEC §8 rules prior to broadcast, accumulating all failures for complete form UX.
- `POLICY_RULE_IDS` — Canonical array of SPEC §8 validation rule identifiers.
- `policyToScVal(policy: PolicyConfig): xdr.ScVal` — Encodes a policy as the contract's canonical sorted ScVal struct.
- `decodePolicy(scVal: xdr.ScVal): PolicyConfig` — Strictly decodes `policy()`/set-policy ScVal data, including Option/Vec and numeric normalization.
- `policyFromScVal(scVal)` — Alias for callers using the issue's original function name.
- `describePolicy(policy: PolicyConfig | null, options?: DescribePolicyOptions): string` — A compact, log-friendly rendering of the policy in force, including the recipient caps, the blocklist and the active window with its state. Recipient lists are reported as counts unless `detail: true` asks for the addresses.
- `invoke(options)` / `invoke({ ...options, dryRun: true })` — Broadcasts an admissible result, or returns the full pre-broadcast dry-run trace.
- `verifyAgentSignature(publicKey, payload, signature): boolean` — Verify-only Ed25519 check against a strkey or raw 32-byte key.
- `GuardError`, `SimulationError`, `SigningError`, `BroadcastError`, `PolicyDecodeError`, and `ContractResponseError` — Typed failure hierarchy.
- `decodeCheckResult(raw): CheckResult` — Decodes `Allowed` or `Blocked(reason)`.
- `decodeAuthDecision(event: SorobanRpc.Api.GetEventsResponse.Event): AuthDecisionEvent | null`
- `decodeGuardEventXdr(xdrBase64: string, source?: 'ledger' | 'diagnostic'): GuardAuthDecision | null` — Offline decode of a raw base64 event XDR. Accepts either a `DiagnosticEvent` (what `getEvents()` and a simulation error carry) or a `ContractEvent` (what a block explorer exposes) and returns the same decision the object-path decode produces. Malformed base64, an XDR that is not a contract event, and an event that is not an `event_auth_checked` decision all return `null` — it never throws, so fixture checks and operator copy-paste cannot crash a long-running process.
- `guardEventsFromDiagnostics(events: xdr.DiagnosticEvent[]): GuardEvent[]` — Each decoded `GuardEvent` carries a stable `id`: `ledger:<txHash>:<topic>` for committed events, `diag:<sha256>` for blocked ones (which are rolled back and have no hash to anchor on). Same event re-parsed → same id; two different blocks in one simulation → different ids. Format and collision notes: [`docs/event-schema.md`](docs/event-schema.md).
- `GuardLogger`, `GuardLoggerInput`, `GuardLogMeta`, `GUARD_LOG_LEVELS` — the optional, structurally-typed log sink shared by every config above; `SILENT_LOGGER` is what a config resolves to when none is supplied. See [Optional logging](#optional-logging-the-sdk-is-silent-unless-you-ask).
- `explainReason(reason: string | number, locale?, overrides?): string` — Human-readable explanation of contract reason codes. The default call is unchanged; the optional `locale` catalog and per-reason `overrides` localise or reword a refusal without an i18n dependency. Reason keys, titles and remediation text: [`reasonMessages` / `reasonMessagesEn`](#reason-messages-issue-96).
- `isDeadManFrozen(status: GuardStatus): boolean`
- `deadManRemaining(status: GuardStatus, policy: PolicyConfig | null): bigint | null`
- `dmsUrgency(status: GuardStatus, policy: PolicyConfig | null, nowSecs?: bigint, warnRatio = DMS_WARN_RATIO_DEFAULT): 'ok' | 'warn' | 'expired' | 'unknown'` — Dead-man countdown urgency for dashboards: `warn` from `warnRatio` (default `DMS_WARN_RATIO_DEFAULT` = 0.8) of the grace period, `expired` once the grace has elapsed. `unknown` exactly where `deadManRemaining` is `null` (no policy, switch disabled, never heartbeated — never ≠ expired).
- `policyDiff(a: PolicyConfig, b: PolicyConfig): PolicyChange[]` — Structured change list between two policies for operator display (e.g. when the policy revision bumps; dashboard change-history feed: stellar-agent-guard-dashboard#17). Lists compare as sets, so a pure reorder is no change; protocols match by contract and report `fns` changes at paths like `protocols[0].fns[1]`.

#### Dashboard-style snapshot (issue #68)

A consumer that wants "the last N decisions, right now" — a dashboard panel, an agent status endpoint — can opt into a bounded in-memory window instead of maintaining its own store:

```ts
import { GuardTelemetryListener } from "stellar-agent-guard-sdk";

const listener = new GuardTelemetryListener({
  server,
  guard: GUARD_ID,
  buffer: { max: 200 }, // opt-in; omitted → no buffer is allocated
});

// ...drive it with listener.watch() or listener.watchAll(), then read on demand:
const lastBlocked = listener.recent({ stream: "diagnostic" });
const capRefusals = listener.recent({ reason: "per_tx_cap_exceeded" });
const recentWindow = listener.recent({ fromLedger: 4_700_000 });
```

`recent(filter?)` returns the retained events oldest-first, filtered by any of `stream`, `reason`, `fromLedger`, `toLedger`. The buffer is FIFO and non-durable: it holds only what this listener decoded in this process, and a restart empties it. Persistence across restarts is a cursor store (tracked separately), not something this buffer pretends to provide.

What it returns is a **detached snapshot**: the array, the events in it, their decoded `data`/`decision` and the opt-in `raw` payload are all copies, so editing a returned event cannot change what the listener still retains. A listener with no `buffer` configured copies nothing — `recent()` returns `[]`.

`recentJsonLines(filter?)` returns the same bounded window as **JSON Lines** (issue #324) — one `serializeEventRecord()` line per event, oldest first, `filter` applied identically. It returns a string and never touches the filesystem; `bigint` values are decimal strings and byte arrays are `bytes:<hex>`, so the export parses without the SDK. The opt-in `raw` payload is never included: the projection is a fixed field list, so an incident bundle cannot leak a retained debug payload.

#### Raw events for bug reports (issue #94)

When a decoded verdict looks wrong, attach the **undecoded source event** to the SDK bug report. Decoding discards it by default — the raw payload carries XDR `ScVal`s and host-shaped objects, and retaining one per event is a memory decision — so it is opt-in:

```ts
// Committed feed: opt in on the listener.
const listener = new GuardTelemetryListener({ server, guard: GUARD_ID, includeRaw: true });

// Diagnostic feed: opt in at the decode site.
const events = guardEventsFromDiagnostics(diagnosticEvents, GUARD_ID, { includeRaw: true });

// Every event then carries `raw`: the `rpc.Api.EventResponse` for a committed
// event, or the host-shaped diagnostic object for a blocked one.
const event = (await listener.poll({ startLedger })).events[0];
console.error(JSON.stringify(event.raw, (_key, value) =>
  typeof value === "bigint" ? value.toString() : value));
```

When `includeRaw` is not set, `raw` is **absent** (undefined) — nothing is retained. Leave it off in a long-running fleet; turn it on for the debugging session or the bug-report window. The `id` field stays stable either way, so a raw event can be correlated with the decoded event it produced.

#### Reason messages (issue #96)

`reasonMessages` exposes each reason's numeric code and its stable title/body/remediation keys, and `reasonMessagesEn` holds the built-in English text — so a dashboard can render a table, and a consumer can key its own translations, without the SDK taking an i18n dependency:

```ts
import { reasonMessages, reasonMessagesEn, explainReason } from "stellar-agent-guard-sdk";

for (const [reason, { code, titleKey, remediationKey }] of Object.entries(reasonMessages)) {
  console.log(code, reasonMessagesEn[reason as keyof typeof reasonMessagesEn].title, remediationKey);
}

// Localise one reason; a missing key falls back to English.
explainReason("per_tx_cap_exceeded", {
  [reasonMessages.per_tx_cap_exceeded.bodyKey]: "Le montant dépasse le plafond par transaction.",
});

// Or override individual reasons outright.
explainReason("paused", undefined, { paused: "Agent paused by the operator." });
```

#### Ship events to your logger

`serializeEvent(event)` gives you one canonical JSON line per event, so a log pipeline gets a stable, diffable record with no logger dependency in the SDK:

```ts
import { serializeEvent } from "stellar-agent-guard-sdk";

for await (const event of listener.watchAll({ diagnostics })) {
  logger.info(serializeEvent(event)); // one deterministic JSON line per event
}
```

Key order, the drop-`undefined`/keep-`null` policy, and the `bigint`-to-decimal-string normalization are documented in [`docs/event-schema.md`](docs/event-schema.md#canonical-json-serialization--serializeevent).

## Architecture

Stellar Agent Guard operates across three dedicated repositories:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Operator (Browser / Freighter)                     │
│                                     │                                   │
│                                     ▼                                   │
│              stellar-agent-guard-dashboard (Next.js / UI)               │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   AI Agent Runtime (LangChain / ElizaOS)                │
│                                     │                                   │
│                                     ▼                                   │
│                stellar-agent-guard-sdk (TypeScript / RPC)               │
│               • Pre-flight policy check  • Cost pre-checks              │
│               • Agent-auth tx signing    • Event telemetry              │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼ Soroban RPC
┌─────────────────────────────────────────────────────────────────────────┐
│               stellar-agent-guard-contracts (Soroban / Rust)             │
│            • CustomAccount interface (`__check_auth`)                   │
│            • Spend caps, rolling window, allowlists, dead-man switch    │
└─────────────────────────────────────────────────────────────────────────┘
```

| Repository | Role | Documentation |
|---|---|---|
| [**stellar-agent-guard-contracts**](https://github.com/aigbagbobila/stellar-agent-guard-contracts) | Soroban smart contracts implementing Custom Account Abstraction and spending policy firewall | [GitBook Docs](https://soroban-cost-estimator.gitbook.io/stellar-agent-guard-contracts/) |
| [**stellar-agent-guard-sdk**](https://github.com/aigbagbobila/stellar-agent-guard-sdk) (this repo) | TypeScript SDK for pre-flight interception, simulation pricing, and AI agent framework integration | [GitHub](https://github.com/aigbagbobila/stellar-agent-guard-sdk) |
| [**stellar-agent-guard-dashboard**](https://github.com/aigbagbobila/stellar-agent-guard-dashboard) | Client-side operator dashboard for policy deployment, inspection, and emergency panic-button freeze | [GitHub](https://github.com/aigbagbobila/stellar-agent-guard-dashboard) |

## ✅ Verified against live testnet

Proven against a real deployed instance on Stellar testnet (protocol 28, `Test SDF Network ; September 2015`):

- **Guard (custom account)**: `CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44`
- **SAC Token**: `CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB`
- **WASM bytecode hash**: `f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63` (identical to Phase 1 artifact)

Verify a downloaded artifact against the pinned hash before deploying — the same constant the dashboard checks, so there is one source of truth rather than a copy per consumer:

```ts
import { readFileSync } from "node:fs";
import { verifyGuardWasm } from "stellar-agent-guard-sdk";

const result = await verifyGuardWasm(readFileSync("guard.wasm"));
if (!result.ok) {
  throw new Error(`WASM mismatch: got ${result.actual}, expected ${result.expected}`);
}
```

`verifyGuardWasm` hashes with WebCrypto (`crypto.subtle`), so the identical call runs in Node and in the browser and needs no extra dependency. It is async, because `crypto.subtle.digest` is. `GUARD_WASM_HASH` is exported if you need the constant on its own.

### 5/5 Live Enforcement Scenarios

| Scenario | Condition | Result | Evidence |
|---|---|---|---|
| 1. Within caps | Transfer 100 within caps (cap: 1000, window: 150) | **Allowed** | Tx hash `f8f5b3c51b85c8777c956d71330d015fcf72fa57548077d8b32969f8ba9c762e` at ledger `4704849` |
| 2. Per-tx cap | Transfer 1001 > 1000 cap | **Blocked** (`per_tx_cap_exceeded`) | Diagnostic event `event_auth_checked, blocked, per_tx_cap_exceeded`, pre-broadcast, 0 fees |
| 3. Rolling window | Transfer 76 + 76 = 152 > 150 window cap | **Blocked** (`window_cap_exceeded`) | Rolling window accumulation refusal, balances untouched |
| 4. Recipient allowlist | Transfer to unlisted recipient | **Blocked** (`recipient_not_allowed`) | Default-deny address check refusal |
| 5. Account paused | Call while `paused = true` | **Blocked** (`paused`) | Account-state refusal cleanly distinguished from policy caps |

Complete run output and assertion logs are preserved in [`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md).

## Honest limitations

- **Enforcement boundary for arbitrary calls**: Full amount/recipient limits are native to SAC token transfers. Arbitrary Soroban contract calls are enforced via protocol/function allowlists, active window, pause, and dead-man switches; per-call amount limits are not available generically from host auth contexts (tracked as v2).
- **Single-key agent signing today, multi-key prepared**: A guard account registers one Ed25519 agent key, and `buildGuardAuthEntry` signs the authorization digest with it. The signing path is now a seam (`AgentSigner`: sign a 32-byte digest, return signature bytes) and every public config accepts either an `AgentSigner` or a plain `Keypair` — so the current single-key behaviour is unchanged, and threshold/multi-key agent signing lands behind the same interface when the contracts repo's v2 decision does. Research, the recommended wire shape, and the revisit trigger: [`docs/concepts/multi-key-agent-signing.md`](docs/concepts/multi-key-agent-signing.md).
- **AutoGPT integration**: AutoGPT lacks an extensible pre-execution interceptor hook at the surveyed revision; findings and future integration paths are documented in [`docs/integration-hooks.md`](docs/integration-hooks.md).
- **Testnet signing credentials**: Running `npm run test:integration` requires `.env.phase2` populated with funded testnet keypairs. The live suite is **not run on every PR**: it is (a) required locally before any PR that touches the enforcement path (`src/tx.ts`, `src/invoke.ts`, `src/policy.ts`, `src/preflight.ts`), with fresh evidence committed to [`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md) and CI-verified as present, and (b) run automatically on a weekly schedule ([`.github/workflows/live-suite.yml`](.github/workflows/live-suite.yml)) to catch host/testnet drift. A green `ci` therefore means the required checks ran — not that the live suite ran against this change.
- **Pre-flight is a prediction, not a settlement guarantee**: the four known pre-flight fidelity limits (moving window state, a moving fee market, simulation not executing, approximated batch semantics) are enumerated with their mitigations, residual risks, and code citations in [Fidelity & limits](#fidelity--limits).

## Enforcement scope — read this before relying on the caps

Full recipient/amount enforcement — spend caps, allowlists, per-transaction limits — is native and automatic for SAC token transfers (`transfer`/`transfer_from`), since these are the calls whose arguments the Soroban auth context exposes for inspection. For other Soroban contract calls made by the guarded account (arbitrary DEX/lending/protocol calls), the policy engine still enforces window and pause state, but per-call amount/recipient limits are not yet enforced — extending fine-grained enforcement to arbitrary calls is tracked as a v2 item, not implied as already covered.

This boundary is an inherent property of the platform (the auth context does not expose arbitrary call arguments generically), not a gap this project hides or overclaims. The classification that produces this boundary (`AssetTransfer` vs `Protocol` vs `Unknown` default-deny) is spelled out in SPEC §6.

## Topics

`stellar`, `soroban`, `ai-agents`, `guardrails`, `custom-account`, `pre-flight`,
`spend-limits`, `cost-estimation`, `langchain`, `elizaos`, `mcp`, `telemetry`, `typescript`

## Maintainers

| Name | GitHub | Telegram |
|---|---|---|
| Hybrid | [@aigbagbobila](https://github.com/aigbagbobila) | [@aigbagbobila](https://t.me/+EzSusj-2vVhhNmI0) |

## Socials

- [Telegram](https://t.me/+EzSusj-2vVhhNmI0)
- [Discord](https://discord.gg/Z766vsgjg)

## Contact

- GitHub issues: <https://github.com/aigbagbobila/stellar-agent-guard-sdk/issues>
- Maintainer (GitHub): [@aigbagbobila](https://github.com/aigbagbobila)
- Security disclosures: see the local [SECURITY.md](SECURITY.md) for SDK issues; contract/protocol issues and deployed-instance incidents go to the contracts repo's [SECURITY.md](https://github.com/aigbagbobila/stellar-agent-guard-contracts/blob/main/SECURITY.md)
- Security review: [`docs/attack-surface.md`](docs/attack-surface.md) maps where untrusted data enters and leaves the SDK, and [`docs/threat-model.md`](docs/threat-model.md) states what can go wrong

## License

Licensed under [MIT](LICENSE). This is unaudited security tooling that gates real fund access — see the contracts repo's [SECURITY.md](https://github.com/aigbagbobila/stellar-agent-guard-contracts/blob/main/SECURITY.md) before considering mainnet use.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for details on coding standards, PR process, and
project structure — including the strict one-commit-per-logical-unit rule and the
[TypeScript strictness ratchet](CONTRIBUTING.md#typescript-strictness-ratchet)
(`npm run check:strict-ratchet`).

Before changing the public surface, the dependency set, or the runtime the SDK runs
in, read [`docs/design-principles.md`](docs/design-principles.md): fail-closed
verdicts, no secret handling, one runtime dependency, additive-only 0.x surface,
a browser-safe core, and logger-optional silence. Departures are maintainer
decisions (`tier:maintainer-decision`), not silent exceptions.

Looking for something to work on? The
[issue backlog](https://github.com/aigbagbobila/stellar-agent-guard-sdk/issues)
holds scoped issues with Summary / Acceptance Criteria / Tech Stack — good first tasks for
the Drips Stellar Wave contributor sprints.

![Contributors](https://contrib.rocks/image?repo=aigbagbobila/stellar-agent-guard-sdk)
