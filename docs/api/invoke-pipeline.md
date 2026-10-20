# Invoke Pipeline API

## `invoke(params: InvokeParams): Promise<InvokeOutcome>`

Executes an end-to-end transaction through the guard:
1. Runs probe simulation to collect required authorization entries.
2. Signs authorization entries with the agent signer (`GuardAuthorization.agent`:
   an `AgentSigner`, or a plain Ed25519 `Keypair` for the single-key default).
3. Runs enforced simulation through `__check_auth`.
4. Assembles transaction envelope and submits to Soroban RPC.
5. Handles transient `scecExceededLimit` ledger resource errors with bounded retry.
6. Handles minimum-fee broadcast rejections (`tx_insufficient_fee` / "tx too cheap") with bounded fee-bump retry.

Returns discriminated union: `{ kind: "allowed", submission, ... }`, `{ kind: "blocked", reason, ... }`, or `{ kind: "error", detail, ... }` (or throws/returns `BroadcastError` on retry exhaustion).

### Fee-Bump Configuration (`feeBump`)

When network fee conditions change between prepare-time and broadcast, core may reject a transaction with a minimum-fee failure. The pipeline can automatically retry with an increased fee:

```typescript
const outcome = await invoke({
  server,
  source,
  call,
  networkPassphrase,
  feeBump: {
    maxAttempts: 3,        // Maximum attempts before returning BroadcastError (default: 3)
    feeMultiplier: 2,      // Multiplier applied to inclusion fee per retry (default: 2)
    initialInclusionFee: 100n, // Base inclusion fee in stroops (default: 100 stroops)
  },
});
```

* **What it controls**: Controls bounded fee-increase retries when broadcast fails due to minimum-fee / "tx too cheap" rejections (`tx_insufficient_fee`).
* **Default behavior**: Enabled by default with up to 3 attempts, a 2x fee multiplier, and base inclusion fee of 100 stroops.
* **How attempts are bounded**: Configured via `maxAttempts` (default: 3) or overall `maxRetries`. When both are supplied the tighter bound wins. When exhausted, returns a typed `BroadcastError` containing attempt count, the last attempted fee, and structured retry metadata.
* **How the fee multiplier works**: On each retry, the inclusion fee is scaled by `feeMultiplier` (e.g. 100 stroops → 200 stroops → 400 stroops) and re-added to the simulated resource fee. The multiplier must be a finite number greater than `1`.
* **Guard and Simulation Invariant**: **Every fee-bump attempt is re-prepared, re-simulated, and re-evaluated by the guard policy.** A fee bump NEVER bypasses simulation or guard enforcement. If re-simulation causes a policy block, the policy block is immediately surfaced and the transaction is never broadcast.

### The transaction hash, as soon as the server accepts the submission

The transaction hash is the operator's recovery handle after the broadcast:
it is what makes a transaction findable on an explorer when the SDK's own
confirmation polling is slow, times out, or fails. `invoke()` therefore
publishes it the moment the network answers, rather than only on the final
outcome.

```ts
const outcome = await invoke({
  server,
  source,
  call,
  networkPassphrase,
  onSubmitted: (event) => {
    // `event.hash` is the hash the network assigned; `event.status` is the
    // RPC's own status for the submission.
    recordTransactionHash(event.hash);
  },
});
```

The hook is called exactly once, immediately after `sendTransaction` resolves
and **before** any status polling, so a caller that records the hash keeps it
whatever happens afterwards. A throwing hook is isolated: it cannot change the
outcome, exactly like `onStep`.

**The ambiguous case.** A broadcast response that names no transaction is
reported as `hash: null` and **fails closed**: the SDK cannot poll for a
transaction it cannot name, so the invocation returns its `error` outcome with
a typed `BroadcastError` instead of claiming an untrackable transaction is on
its way. `hash: null` is the honest answer — "accepted, but not trackable".

**Keeping the hash on failure.** Every outcome that happened *after* a
broadcast carries the hash, so a caller never has to scrape it out of an error
string or a log line:

| Outcome | Where the hash is |
| --- | --- |
| `allowed` | `outcome.submission.hash` |
| `blocked` (post-broadcast refusal) | `outcome.transactionHash` |
| `error` (failed poll, rejected transaction) | `outcome.transactionHash` |
| `error` (deadline spent while polling) | `outcome.transactionHash` |
| `InvokeRetryError` (retry budget exhausted) | `outcome.transactionHash` |

A `deadline` that fires while the pipeline is waiting for an inclusion does
not un-send the transaction: it may still land. The hash travels with the
`RpcTimeoutError` for exactly that reason.

### Malformed simulation data

A simulation response the SDK cannot trust is reported with the SDK's typed
`ContractResponseError`, naming the field that was wrong and the stage that
read it — never a native conversion error.

```ts
const outcome = await invoke({ server, source, call, networkPassphrase });
if (outcome.kind === "error" && outcome.error instanceof ContractResponseError) {
  outcome.error.field;  // e.g. "minResourceFee"
  outcome.error.stage;  // e.g. "assemble" | "simulate" | "preflight"
}
```

The resource fee is the case in point: it is read through the shared exact-u64
parser, so a missing, malformed, negative or out-of-range fee is rejected
instead of being converted. The pipeline stops before the broadcast, and a dry
run reports `undetermined` rather than an admissible verdict with a fabricated
price.

### Option validation

Every caller-controlled option is checked at the public `invoke()` boundary,
before the account queue, signing or any RPC request. Invalid values are a
field-specific `RangeError` naming the offending option (for example
`retry.maxAttempts must be an integer >= 1 (received 0)`), and no RPC method is
called. The validated fields are:

| Option | Requirement |
| --- | --- |
| `retry.maxAttempts` | integer `>= 1` |
| `retry.baseDelayMs` / `retry.initialDelayMs` | finite `>= 0`; the aliases must agree when both are supplied |
| `retry.maxDelayMs` | finite `>= 0` and `>= baseDelayMs` |
| `retry.random` / `retry.jitter` | at most one function; it must return a finite sample in `[0, 1)` |
| `maxRetries` | integer `>= 0`; `0` means one attempt |
| `feeBump.maxAttempts` | integer `>= 1` |
| `feeBump.feeMultiplier` | finite `> 1` |
| `feeBump.initialInclusionFee` | positive `bigint` stroops |
| `pollAttempts` | integer `>= 1` |
| `pollIntervalMs` | finite `>= 0` |
| `pollOptions.*` | same rules; nested and top-level values must agree when both are supplied |
| `timeoutMs` | finite `>= 0` (`0` disables the per-call bound) |
| `deadlineMs` | finite `> 0` |
| `clock` | object with `now()` and `sleep()` |

A jitter source that returns `NaN`, `Infinity`, a negative value, or `1` or above
is rejected with `retry.random must return a finite value in [0, 1)` the first
time it is sampled — before the retry sleeps or any further RPC is made.

### Overall deadline

`timeoutMs` bounds an RPC call (and defaults to 30s). `deadlineMs` bounds the
**whole invocation** from the moment `invoke()` starts: discovery, signing,
enforced simulation, retry backoff, assembly, broadcast and post-submit polling
all consume the same remaining budget. Pass `clock` (for example a `FakeClock`)
to make deadline accounting deterministic in tests.

```ts
const outcome = await invoke({
  server,
  source,
  call,
  networkPassphrase,
  timeoutMs: 30_000, // per-RPC bound
  deadlineMs: 45_000, // whole action, including retries and polling
  pollOptions: { pollAttempts: 10, pollIntervalMs: 2_000 },
});
```

Expiry is fail-closed. The pipeline returns its `error` outcome carrying an
`RpcTimeoutError` with `deadline: true` (and the stage that was in flight). It
never returns `allowed`, never publishes a `blocked` verdict it did not receive,
and never turns a guard approval that arrived after the budget into an
admissible result. A dry run reports `kind: "dry_run"` with
`verdict: "undetermined"` and `admissible: false`. A transaction already sent
when the deadline expires may still be included; the caller still gets the
timeout outcome and must reconcile it out of band.

### Retry metadata

Terminal outcomes carry additive `retry` metadata: `allowed` and `blocked`
outcomes, the `error` outcome, `InvokeRetryError`, and a fee-bump-exhausted
`BroadcastError`.

```ts
export interface InvokeRetryMetadata {
  attempts: number; // actual pipeline attempts, including the first
  maxAttempts: number; // budget for the terminal failure class
  retried: boolean;
  exhausted: boolean;
  totalDelayMs: number;
  retries: Array<{
    attempt: number; // 1-based attempt that failed
    failure: "stale_ledger_resource_limit" | "sequence_number_collision" | "min_fee";
    cause: "undetermined" | "stale_ledger_resource_limit" | "sequence_number_collision";
    delayMs: number; // 0 for an immediate fee-bump retry
  }>;
  terminalFailure: RetryableInvokeFailure | null;
  terminalCause: InvokeErrorCause | null;
  outcome: "allowed" | "blocked" | "error";
}
```

`retries` records failures that led to another attempt; a failure that exhausted
the budget is reported once in `terminalFailure`/`terminalCause` and
`exhausted: true`. The record contains no secrets, signatures, diagnostic
payloads, transaction hashes or XDR, so it is safe to log.
