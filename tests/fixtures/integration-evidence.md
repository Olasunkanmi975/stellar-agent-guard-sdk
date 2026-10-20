# Live integration evidence — Phase 2

Record of the enforcement suite running against the real Phase 2 testnet
instance. Reproduce with `npm run test:integration` (requires `.env.phase2`).

**Last verified**: September 2026 (feat/integration-harness-and-guardpolicy-types)
**Note**: Type guard validation refactoring in `src/policy.ts` does not change enforcement behavior; evidence remains valid.
**Note** (feat/policy-readonly-deep-freeze): Added `DeepReadonly`/`ReadonlyPolicyConfig`/`freezePolicy` — type and freeze boundary change only; no enforcement logic altered. Evidence remains valid.
**Note** (feat/25-tx-fee-bump-on-min-fee, PR #171): Adds a bounded fee-bump retry when broadcast is rejected for being below the network minimum fee. The retry re-prepares the transaction and re-runs the enforced simulation (including the guard's `__check_auth` and policy verdict) before any re-broadcast, so a block can never be relaxed by it; it only affects the post-verdict broadcast path. The scenarios recorded below (allowed, `per_tx_cap_exceeded`, rolling-window cap) do not depend on the min-fee retry path. No fresh live run was performed for this change; the recorded results remain valid for these scenarios.

**Note** (feat/issue-39-feat-policy-decodecheckresult-exhaustive-tests, PR #229): `decodeCheckResult` is now total and fail-closed — an unknown enum tag, a `Blocked` reason the contract does not define, a malformed `ScVec`, or a non-`ScVal` input resolves to the typed `undetermined` verdict instead of throwing `ContractResponseError`. The scenarios recorded below all return well-formed `Allowed`/`Blocked` payloads whose reasons are part of the contract's own vocabulary, and their verdicts are unchanged; the new fail-closed path is covered by unit tests in `tests/unit/policy.test.ts` and `tests/unit/errors.test.ts`. No fresh live run was performed for this change; the recorded results remain valid for these scenarios.

**Note** (feat/issue-114-feat-tx-abortsignal-timeout-support-for-check, PR #235): Adds caller-owned cancellation to the enforcement pipeline: an optional `signal`/`timeoutMs` on `check()`, `invoke()` and `CostPreChecker.check()`, plus a bounded `DEFAULT_RPC_TIMEOUT_MS` (30s) default so a black-holed RPC can no longer leave a guardrail call pending forever. An already-aborted signal short-circuits before any RPC call; a mid-flight abort or a fired timeout is reported as the check's fail-closed `undetermined` verdict (`invoke()` reports the same typed `RpcTimeoutError` through its own `error` outcome). The bound is strictly fail-closed: it can only stop the SDK from waiting, never relax a verdict — how the authorization entry is built and signed, how the enforced simulation runs, and every cap/block decision are untouched, and an un-aborted call with `timeoutMs: 0` behaves exactly as before. The scenarios recorded below are un-cancelled calls whose verdicts are unchanged; the new abort/timeout paths are covered by unit tests in `tests/unit/invoke.test.ts` and `tests/unit/preflight.test.ts`. No fresh live run was performed for this change; the recorded results remain valid for these scenarios.

**Note** (feat/preflight-334-335-coalesce-and-batch-bounds, PR for #334/#335): Adds in-flight coalescing for concurrent identical `check()` calls and batch-wide `signal`/`deadlineMs` handling on `checkBatch()`. Neither changes how the guard authorization entry is built or signed, how the enforced simulation runs `__check_auth`, or how a policy verdict is classified: coalescing only reuses one identical in-flight run and is removed on settle (never a durable cache), and a fired batch bound can only produce fail-closed `undetermined` verdicts for unfinished calls — it can never turn a refusal or an error into `allowed`. The five scenarios recorded below are sequential, un-cancelled calls whose verdicts and state transitions are unchanged; coalescing, cancellation, deadline and cleanup paths are covered by unit tests in `tests/unit/preflight.test.ts`. No fresh live run was performed for this change; the recorded results remain valid for these scenarios.

**Note** (feat/sdk-295-298-signer-identity-retry-metadata-deadline, PR for #295/#296/#297/#298): Adds signer-identity validation at the `AgentSigner` boundary, public-boundary validation of retry/fee-bump/poll options, structured retry metadata on terminal outcomes, and an optional overall `deadlineMs` shared by retries and polling. None of these changes alter how the guard authorization entry is built or signed, how the enforced simulation runs `__check_auth`, or how a policy verdict is classified: invalid *configuration* is rejected before the pipeline starts, retry metadata is descriptive only, and a spent deadline is reported as a fail-closed timeout (never `allowed`). The five scenarios recorded below are un-cancelled calls with valid options, so their verdicts and state transitions are unchanged; the new validation, metadata and deadline paths are covered by unit tests in `tests/unit/tx.test.ts` and `tests/unit/invoke.test.ts`. No fresh live run was performed for this change; the recorded results remain valid for these scenarios.

**Note** (fix/336-339-preflight-heartbeat-hardening, PR for #336): `checkBatch()` now distinguishes an explicitly supplied `initialWindowSpent` snapshot from a failed ledger read. When a positive SAC transfer needs policy or committed-window state that could not be read, the affected verdicts are `undetermined` and the batch is not reported admissible instead of staging against an assumed zero. This changes only the off-chain batch-staging approximation; an individual `check()` still runs the same probe → sign → enforced `__check_auth` simulation, and the on-chain guard remains authoritative. The five scenarios recorded below use single-call enforcement and are unchanged; the new fail-closed staging paths are covered by mocked-RPC tests in `tests/unit/preflight.test.ts`. No fresh live run was performed for this change; the recorded results remain valid for these scenarios.

## Instance under test

| | |
| --- | --- |
| Guard (custom account) | `CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44` |
| Token (SAC) | `CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB` |
| Network | Test SDF Network ; September 2015 |
| Deployed WASM SHA-256 | `f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63` |
| Same artifact as Phase 1 | yes — verified against the ledger's `ContractExecutable` and the SHA-256 of the fetched bytecode |

This is **not** the Phase 1 instance. Phase 1's guard (`CAYJZT4X…`) is left frozen
by its own dead-man switch as Phase 1's evidence, and is never touched by this
suite. See `phase2-instance.json` for the deployment record.

Live policy the suite runs against and asserts on:

```
per_tx_cap 1000, window_cap 150, window_secs 60,
assets [token], recipients [allowlisted recipient], allow_any_recipient false,
protocols [], paused false, dms_grace_secs 0
```

## What counts as evidence for a block

A guard block happens in enforced pre-simulation, **before broadcast**. It
therefore cannot have a transaction hash — that is the entire point of the
pre-flight path, so demanding a hash for a blocked action would be a demand for
fabricated evidence. The evidence for a block is:

1. the contract's own `event_auth_checked, blocked, <reason>` event, taken from
   the failed enforced simulation's diagnostics — signed by the contract, not
   inferred from a generic failure;
2. the specific `BlockReason` from `src/reasons.ts`;
3. no submission at all (the result carries no hash), and
4. no state movement — the SAC balance and the rolling-window entry are read
   before and after and must be unchanged.

Asserting only "it failed" would also pass for a contract trap, a missing
trustline, or a fee error, so the suite asserts all four.

## Run output

```
[live] guard CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44
[live] per-tx cap 1000, rolling window 150/60s, 1 allowlisted recipient(s)
[allowed] tx f8f5b3c51b85c8777c956d71330d015fcf72fa57548077d8b32969f8ba9c762e at ledger 4704849
  ✔ allows a transfer inside both caps, with a real on-chain hash (12192.988915ms)
[blocked] per_tx_cap_exceeded (1001 > 1000)
  ✔ blocks a per-transaction-cap violation, pre-broadcast (8519.903622ms)
[rolling] 76 + 76 = 152 > window_cap 150
  ✔ blocks a rolling-window-cap violation that only accumulation can explain (12667.333992ms)
[blocked] recipient_not_allowed (GDZOKF3HGA6XSKIEEPJC5ANON3IJ5OGZMCX7GEGJLZN7JFRKOO4N2HXM)
  ✔ blocks a recipient-allowlist violation (5238.482785ms)
[blocked] paused (account-state refusal)
  ✔ distinguishes an account-state refusal from a policy refusal (9390.520814ms)
✔ live enforcement: SAC transfer (48594.535501ms)
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

## Scenario by scenario

### 1. Allowed transfer

`transfer` of 50 from the guarded account to the allowlisted recipient, authorized
by the agent key through `__check_auth`.

- real transaction `f8f5b3c51b85c8777c956d71330d015fcf72fa57548077d8b32969f8ba9c762e`
- landed in ledger `4704849`, re-read from the RPC and confirmed `SUCCESS`
- the guarded account's SAC balance decreased by exactly 50
- the rolling window recorded exactly 50

### 2. Per-transaction-cap violation

`transfer` of **1001** against a `per_tx_cap` of 1000.

- outcome: `blocked`, reason `per_tx_cap_exceeded`
- no transaction hash exists (nothing was broadcast)
- the contract emitted, in the failed enforced simulation:

```
[Failed Contract Event (not emitted)] contract:CAPADGEK…,
  topics:[event_auth_checked, blocked, per_tx_cap_exceeded], data:{}
```

- balance and window unchanged

### 3. Rolling-window-cap violation

Two `transfer` calls of **76** each, each individually admissible (below both the
1000 per-tx cap and the 150 window cap). Their sum, 152, exceeds the window cap of
150 — so the block can only be explained by genuine accumulation.

- first transfer: allowed; window went from 0 to 76
- second transfer: `blocked`, reason `window_cap_exceeded`
- emitted `topics:[event_auth_checked, blocked, window_cap_exceeded]`
- balance and window remained at the post-first-transfer values

The amounts are derived from the live policy (`window_cap / 2 + 1`) rather than
hardcoded, and the test asserts each is individually admissible — otherwise it
could pass by tripping the per-tx cap instead.

### 4. Recipient-allowlist violation

`transfer` of 10 to an address not in the policy's `recipients` list, with
`allow_any_recipient: false`.

- outcome: `blocked`, reason `recipient_not_allowed`
- emitted `topics:[event_auth_checked, blocked, recipient_not_allowed]`
- balance unchanged

### 5. Account-state refusal is distinguishable

With `paused: true`, a transfer is refused with `paused` — an account-state
reason, not a spend violation. This matters because the two need different
responses: a spend violation is the guardrail working, a pause is the operator
speaking. The test restores the policy afterwards and asserts it was restored.

## A stale-ledger failure this suite found

The first runs of scenario 3 failed intermittently, and not because of policy: a
transfer passed enforcement, was **included**, and was then rejected by core with:

```
error, scecExceededLimit
data: ["operation byte-write resources exceeds amount specified", "724", "652"]
```

Six back-to-back transfers in a closed window produced:

| window entries before | simulation declared `write_bytes` | ledger charged | outcome |
| --- | --- | --- | --- |
| 0 | 652 | 652 | allowed |
| 1 | 652 | 724 | **error** |
| 1 | 724 | 724 | allowed |
| 2 | 724 | 796 | **error** |
| 2 | 796 | 796 | allowed |
| 3 | 796 | 868 | **error** |

Every declared value is exactly one rolling-window entry (72 bytes) short
whenever the simulation observed state from before the previous transfer's commit.
Waiting for the ledger to advance past the previous write fixed 6 of 6 runs,
confirming the cause: the enforced simulation priced the transaction against a
ledger snapshot that predated the write the SDK had just made.

At the time of this recorded run, the SDK fix was a single bounded retry, gated
on this specific failure (`isStaleLedgerResourceFailure`). It is safe because a
transaction rejected for exceeding a resource limit applies nothing, and
inclusion proves the ledger has since advanced. It is deliberately *not* applied
to `Auth` failures — those are the guard refusing, and retrying a block would be
wrong. Re-running the same six transfers returned 6 of 6 allowed with no waits.
The retry-hardening change in this branch preserves that safety boundary while
making the retry budget and backoff explicit.

This is worth stating plainly rather than burying: it is a client-side resource
pricing issue, not a guard defect, and it did not let any transaction through that
policy forbade.

## Addendum — 2026-09-24 (maintenance PR: #33, #29, #46)

This PR touches the enforcement path (`src/tx.ts`, `src/invoke.ts`,
`src/policy.ts`, `src/preflight.ts`), so per `CONTRIBUTING.md` it is recorded
here. **It is not accompanied by a fresh live-testnet run**: the contributor
environment has no funded Phase 2 testnet credentials, so the live suite was
not re-executed. What that means for review, stated plainly:

- **The enforcement *behaviour* on-chain is unchanged by this diff.** The four
  files were touched only as follows: `src/tx.ts` extracts an `AgentSigner`
  interface for digest signing (the single-`Keypair` path is identical);
  `src/invoke.ts`/`src/preflight.ts` widen a config *type* (`AgentSigner |
  Keypair`) and `await` the now-async entry builder; `src/policy.ts` documents
  and guards the `LastHeartbeat = 0` ("never") case in the dead-man helpers.
  The authorization preimage, nonce policy, credential types, policy encoding,
  footprint assembly and block classification are all untouched, so the five
  scenarios above must still hold — but that is an argument, not a measurement.
- **A maintainer with `.env.phase2` should run `npm run test:integration` against
  this branch before merge** and replace this addendum with the fresh run
  output, per the rule the gate exists to enforce. The CI gate only verifies
  that this file was touched; it cannot verify the numbers, and this addendum
  does not pretend otherwise.

## Pre-flight Input Validation Verification

Pre-flight interceptor input validation checks execute prior to RPC simulation dispatch:
- Programmatic validation (`validateContractCall`) synchronously rejects invalid StrKey addresses, invalid symbols, non-array arguments, and non-i128 amounts with typed `InvalidInputError`.
- Valid calls continue through the enforcement pipeline and retain parity with on-chain policy enforcement outcomes.

## Pre-flight cache validation (2026-09-25)

The opt-in cache behavior is covered without network access in
`tests/unit/preflight.test.ts` using a mocked RPC and the real
probe/enforced-simulation path. The tests verify default opt-out, cache hits,
ledger-based configuration, TTL expiry, full and call-specific invalidation,
ledger advance invalidation, policy-revision invalidation, argument-sensitive
keys, and non-caching of transient undetermined results.

Local checks completed successfully:

```text
npm run typecheck
npm run lint
npm test                 # 89 passing unit tests
npm run build
```

A fresh live-testnet run was not claimed for this change: `.env.phase2` is
absent from this checkout, and the available runtime is Node 22 while the
package requires Node 24 for the documented live workflow. The cache tests are
fully mocked and reproducible without credentials; a maintainer can rerun the
live suite with the repository's documented testnet credentials before merge.

## Paired pre-flight fidelity: verdict vs on-chain outcome, delay = 0 (2026-09-26)

`tests/integration/enforcement.test.ts` now carries a paired test: the *same*
transfer is sent through `PreFlightInterceptor.check()` and then, with no delay
in between, through the full `invoke()` pipeline, and the two results are
compared. Both paths call the same `enforceCall()`, so the comparison is two
independent observations of one state — a verdict, and the outcome it predicted.

**Allow case.** Pre-flight reports `admissible`, `invoke()` reports `allowed`,
and the transaction is then re-read from the RPC and asserted `SUCCESS`, with the
guarded account's balance down by exactly the transfer amount and the rolling
window recording it. The evidence is a transaction hash, not a claim.

**Block case.** Pre-flight reports `blocked, per_tx_cap_exceeded` for an
over-cap transfer, and the immediately following `invoke()` attempt reports the
*identical* reason symbol. The reason is additionally decoded from the
`event_auth_checked` diagnostic carried by each refusal, so the paired assertion
is between two decisions the contract itself made.

Why the block case stops at the enforced-simulation refusal rather than forcing a
broadcast: the block happens in enforced simulation, before broadcast, so no
transaction exists to look up — that is the pre-flight guarantee, and demanding a
hash for it would be demanding fabricated evidence (see "What counts as evidence
for a block" above). Broadcasting past that gate would require hand-assembling an
envelope that bypasses this SDK's enforcement, a path the SDK deliberately does
not provide, and it would add nothing the contract has not already stated: the
reason asserted here comes from `__check_auth`'s own diagnostic event. This is
the honest variant the issue permits, and the reason for choosing it.

**Not run live in this checkout.** `.env.phase2` is absent, so
`npm run test:integration` cannot execute here, and no fresh transaction hash is
claimed for this section — unlike the scenario run above, which was recorded from
a real run. What did run locally, on Node 25:

```text
npm run typecheck
npm run lint
npm test                 # 131 passing unit tests
npm run build
npm run test:smoke
```

The paired test compiles and type-checks against the same harness the live
scenarios use. A maintainer with `.env.phase2` can reproduce it with
`npm run test:integration` before merge; it needs no new credentials, no new
deployment, and no policy change beyond the `installPolicy()` call every scenario
already makes.

## Addendum — 2026-09-26 (PR: structured pipeline step timing for observability hooks)

Recorded because this PR touches the enforcement path (`src/invoke.ts`,
`src/preflight.ts`) and CI's `enforcement-path evidence gate` therefore requires
this file in the diff.

**It is not accompanied by a fresh live-testnet run**: `.env.phase2` is absent
from this checkout, so `npm run test:integration` cannot execute here. As with
the addenda above, this is stated rather than glossed, and the CI gate verifies
only that this file was touched — not the numbers.

### What the PR changes on the enforcement path

The diff is observability plumbing only. It adds an optional `onStep` hook to
`invoke()`/`enforceCall()`, an `InvokeStepEvent` shape (name, status, durationMs,
attempt) over the existing `TraceStepName` vocabulary, and a `withStepTiming`
wrapper around the pipeline's existing stages: `probe` (discovery simulation),
`sign` (all entries, one stage per attempt), `simulate` (enforced simulation) and
`broadcast`. The stale-ledger retry threads an `attempt` index (0/1) through
those events. A throwing callback is swallowed; with no hook supplied, each
stage runs directly — no timers, no events, no added work.

Unchanged, deliberately: the authorization preimage and nonce policy, credential
kinds answered, the probe → sign → enforced-simulation ordering, resource
assembly, submission, block classification and every outcome value and detail
string. The one behavioural nuance is internal only: signing-shape refusals are
raised as an internal `SigningStageError` so the `sign` stage emits a real `fail`
event, and `enforceCall` converts it straight back into the same `error` outcome
text the pipeline has always returned. The enforcement *decisions* the five
scenarios above assert on are produced by the contract during enforced
simulation, which this diff does not touch.

### What did run locally (Node 24.21.0, matching the package's engine)

```text
npm run typecheck                        # clean
npm run lint                             # clean
npm test                                 # 171 unit tests passing, 0 fail
npm run build                            # clean
npm run test:smoke                       # 44 exports resolve via the ESM export map
```

The unit suite includes `tests/unit/invoke.test.ts`, which drives the real
pipeline against a mocked RPC and asserts the enforcement outcomes this file's
live scenarios exercise — allowed, blocked (with the contract's reason decoded
from `event_auth_checked` diagnostics), error, and the stale-ledger retry's
two-attempt event stream — plus `PreFlightInterceptor` validation and cache
behavior in `tests/unit/preflight.test.ts`. Those cover the classification and
plumbing this PR touched, but they are mocks: they cannot substitute for the
live run, and this addendum does not claim otherwise.

**A maintainer with `.env.phase2` should run `npm run test:integration` against
this branch before merge** and replace this addendum with the fresh run output.
No credentials, deployment or policy change are needed beyond what the suite
already does.

## Addendum — 2026-09-26 (PR #182: Admin operations, SDK jitter, adapter examples, AgentSigner type fixes)

Recorded because this PR touches the enforcement path (`src/tx.ts`, `src/invoke.ts`)
and CI's `enforcement-path evidence gate` therefore requires this file in the diff.

**It is not accompanied by a fresh live-testnet run**: `.env.phase2` is absent from
this checkout, so `npm run test:integration` cannot execute here. The on-chain
enforcement behaviour is unchanged by this diff.

### Summary of changes to the enforcement path

- `src/tx.ts`: Deduplicated `GuardCredentialType` and unified `AgentSigner` to the clean `readonly publicKey: string` / `signDigest` definition; updated `submitAndPoll` options parameter types for compatibility with `exactOptionalPropertyTypes`.
- `src/invoke.ts`: Imported `AdminSigner`, added `pollAttempts` and `pollIntervalMs` to `InvokeParams` and forwarded them to `submitAndPoll`, and updated `enforceCall` to `await` `publicKey()` across `accountSigners` so asynchronous custom admin signers (e.g., Freighter) match correctly.

### What did run locally

```text
npm run typecheck                        # clean
npm run lint                             # clean
npm test                                 # 191 unit tests passing, 0 fail
npm run build                            # clean
npm run test:smoke                       # 64 exports resolve via the ESM export map
```

**A maintainer with `.env.phase2` should run `npm run test:integration` against this branch before merge** and replace this addendum with the fresh run output.

## Addendum — 2026-09-26 (PR #184: GuardBlockedError decision payload and differential fixture test table #63, #70)

Recorded because this PR touches the enforcement path (`src/preflight.ts`) and CI's `enforcement-path evidence gate` therefore requires this file in the diff.

**It is not accompanied by a fresh live-testnet run**: `.env.phase2` is absent from this checkout, so `npm run test:integration` cannot execute here. The on-chain enforcement behaviour is unchanged by this diff.

### Summary of changes to the enforcement path

- `src/preflight.ts`: Updated `assertAllowed()` in `PreFlightInterceptor` to pass the offending `call` and `rawEvent` (the contract's first diagnostic event) into `GuardBlockedError` when rejecting blocked invocations.
- `src/reasons.ts`: Extended `GuardBlockedErrorOptions` and `GuardBlockedError` to carry `call?: ContractCall` and `rawEvent?: DiagnosticEvent`, along with a structured `toJSON()` serialization method for observability and logging.
- `scripts/sync-contract-fixtures.ts` & `tests/fixtures/contract-fixtures.json`: Added differential fixture tables and synchronization tooling asserting parity between contract diagnostics and SDK preflight reasoning.

### What did run locally (Node 24)

```text
npm run typecheck                        # clean
npm run lint                             # clean
npm test                                 # 215 unit tests passing, 0 fail
npm run build                            # clean
npm run test:smoke                       # 64 exports resolve via the ESM export map
```

**A maintainer with `.env.phase2` should run `npm run test:integration` against this branch before merge** and replace this addendum with the fresh run output if needed.

## Addendum — 2026-09-27 (PR #170: batched pre-flight `checkBatch`)

Recorded because this PR touches the enforcement path (`src/preflight.ts`,
`src/policy.ts`) and CI's `enforcement-path evidence gate` therefore requires
this file in the diff.

**It is not accompanied by a fresh live-testnet run**: `.env.phase2` is absent from
this checkout, so `npm run test:integration` cannot execute here. The five
scenarios recorded above remain the live evidence for the single-call path.

### What the PR changes on the enforcement path

- `src/preflight.ts`: adds `checkBatch()`, `assertBatchAllowed()` and the
  `preflightBatch()` one-shot form. `checkBatch` evaluates each call in order
  through the existing `check()`, then *stages* the cumulative window spend of
  SAC transfers in memory. A call that passes enforced simulation in isolation
  but would push the staged total past `window_cap` is returned as `blocked` with
  `window_cap_exceeded`. The batch is admissible only when every call is.
- `src/preflight.ts`: `PreFlightConfig.policy` is a new optional field so a caller
  can supply the policy for staging without an extra ledger read.
- `src/policy.ts`: adds `extractTransferAmount()` (the SAC `transfer` /
  `transfer_from` amount argument), `readPersistentEntry()`, and
  `fetchGuardPolicyAndWindow()` for the "no policy supplied" path.

### What this is, and what it is not

`checkBatch` is an **off-chain approximation** of the contract's atomic auth-batch
evaluation, and the code says so at the call site. The three known divergences,
restated here because they bear on how much weight the evidence can carry:

- state mutations between calls are not observed, because each call is simulated
  independently;
- the window is staged against the initial snapshot, with no modelling of
  intra-batch time expiration;
- `totalEstimatedResourceFee` is the sum of per-call estimates, not the resource
  fee of a single batched envelope.

The synthetic `window_cap_exceeded` verdict is the part that most needs review: it
is produced by this SDK rather than by the contract, so on its own it is an
argument and not a measurement. The single-call path it is layered on top of is
unchanged — `check()`, `assertAllowed()` and `preflight()` are untouched, and a
`blocked` or `undetermined` verdict from the contract is propagated verbatim
rather than re-derived.

### What did run locally (Node 24.16.0)

```text
npm run typecheck                        # clean
npm run lint                             # clean
npm test                                 # 247 unit tests passing, 0 fail
npm run build                            # clean
npm run test:smoke                       # 69 exports resolve via the ESM export map
```

`tests/unit/preflight.test.ts` gains a `PreFlightInterceptor.checkBatch()` suite
against a mocked RPC, covering:

- the empty batch (admissible, no verdicts, zero fee, zero simulations);
- one verdict per call in input order, with per-call fees summed;
- a call that passes alone but breaches the staged cap, asserting the
  `window_cap_exceeded` reason and the `120 > window_cap 100` arithmetic, and that
  a staged-out call is excluded from the fee total;
- the already-committed window spend counting against the cap;
- a contract refusal propagating its own decoded reason (`per_tx_cap_exceeded`)
  and making the batch inadmissible;
- a `null` cap meaning "no objection" rather than "refuse everything";
- a missing `getLedgerEntries` degrading to a zero committed spend instead of
  failing closed; and
- `assertBatchAllowed` returning the batch when admissible, throwing
  `GuardBlockedError` on the first refusal, and throwing
  `PreFlightUndeterminedError` — never a block — on a host rejection.

What these tests do **not** establish: that staged in-memory accumulation matches
the contract's own batch accounting under real concurrency. That needs the live
suite, and it needs the contract-side `check_batch` entrypoint to compare against.

**A maintainer with `.env.phase2` should run `npm run test:integration` against this branch before merge** and replace this addendum with the fresh run output.

## Addendum — 2026-09-27 (PR #177: simulation resource breakdown on `CostPreChecker`)

Recorded because this PR touches the enforcement path (`src/preflight.ts`) and CI's
`enforcement-path evidence gate` therefore requires this file in the diff.

**It is not accompanied by a fresh live-testnet run**: `.env.phase2` is absent from
this checkout, so `npm run test:integration` cannot execute here.

### Summary of changes to the enforcement path

- `src/preflight.ts`: an admissible decision now carries an optional
  `resourceBreakdown`, parsed from the *same* enforced simulation that already
  produced `estimatedResourceFee`. `footprintKeys` prefers
  `breakdown.storageEntries` when the payload exposes a complete resource block and
  otherwise falls back to the existing `getReadOnly()`/`getReadWrite()` count, so
  the reported key count is unchanged wherever the parse does not succeed.
- `src/cost.ts`: adds `ResourceBreakdown` and `resourceBreakdownFromSimulation()`,
  which reads the actual `SorobanResources` fields (`instructions`,
  `diskReadBytes`, `writeBytes`) and the footprint array lengths. A missing or
  malformed field yields `undefined` for the whole breakdown — no zero-filling. The
  parsed value is surfaced on priced `within_budget`/`over_budget` results as
  `breakdown`.

Unchanged, deliberately: the authorization preimage and nonce policy, credential
kinds answered, the probe → sign → enforced-simulation ordering, resource
assembly, submission, block classification, and every existing outcome value. The
breakdown is read *out of* the simulation the guard already runs; it does not add
an RPC call, does not alter what is signed, and cannot change a verdict.

This diff sits alongside two already-merged changes that touch the same file: the
batched pre-flight staging above (`src/preflight.ts`, `src/policy.ts`) and the
bounded stale-ledger retry (`src/invoke.ts`). They are independent —
`checkBatch` consumes only a verdict's `kind`, and this change only adds a field to
the `admissible` arm — but the merged tree type-checks and the full suite runs on
all three together, which is the state the numbers below describe.

### What did run locally (Node 24.16.0)

```text
npm run typecheck                        # clean
npm run lint                             # clean
npm test                                 # 257 unit tests passing, 0 fail
npm run build                            # clean
npm run test:smoke                       # 73 exports resolve via the ESM export map
```

The new coverage for this change is `tests/unit/cost.test.ts` against the committed
recorded payload fixture `tests/fixtures/simulation-resource-payload.json`: the
wire-shape `SorobanResources` object, the parsed `SorobanDataBuilder` value, the
raw base64 form, incomplete-payload handling (whole result `undefined`), and
propagation through `CostPreChecker`. No network, no credentials.

**A maintainer with `.env.phase2` should run `npm run test:integration` against this branch before merge** and replace this addendum with the fresh run output.



## 2026-09-28 — merge of `main` into the policy/dry-run/auth branch, and its re-validation

This branch was merged with `main` (merge commit `d7ffb89`) so it could sit on the
current base. That merge was resolved incorrectly: the conflict resolution kept *both*
sides of several hunks rather than integrating them, so the tree did not compile. The
failures were not confined to the compiler — the resolution also silently dropped
committed work, which is why this section records what was recovered and not just that
the build went green.

### What the broken resolution had dropped

- `tests/unit/invoke.test.ts` reverted wholesale to `main`'s version, discarding all
  eleven dry-run and typed-failure tests for #22 and #23. They are restored, unchanged
  in substance, in a new `tests/unit/invoke-dry-run.test.ts` rather than merged back
  into `invoke.test.ts`: the two files drive the same pipeline through two different
  harnesses (a recorder for `onStep`, an RPC-boundary fake for the dry-run trace), and
  reconciling the duplicate helpers would have produced a third, worse file.
- The `src/errors.ts` import was missing from `src/policy.ts` and `src/preflight.ts`.
- The fail-closed resource-fee check in `PreFlightInterceptor.check()` had been moved
  into `checkBatch()`, where it referenced an out-of-scope `outcome` and returned a
  single `PreFlightDecision` from a function typed to return a batch decision. It is
  back in `check()`, where the fee is actually computed.
- `verifyAgentSignature`, `InvokeDryRunResult`, `InvokeDryRunVerdict`, and
  `requiredAuthorizationEntries` were absent, and the `SigningError` wrappers in
  `buildGuardAuthEntry` / `signAccountAuthEntry` had been reverted. The public-root
  export list in `src/index.ts` had lost `verifyAgentSignature` and the dry-run types,
  so a consumer importing them from the package root would have broken with no compile
  error anywhere in this repository. `tests/unit/exports.test.ts` now pins the whole
  published surface of this branch so the next merge cannot drop one quietly again.
- `invokePipeline` had two copies of the assembly step, and `enforceCall` had two copies
  of the probe and of the signing loop. Only one copy of each survived the cleanup.

### One deliberate behaviour decision, recorded because it changes `main`'s tests

`main` (#186) pins that a pipeline stage which throws propagates out of `invoke()`.
This branch (#22) pins that `invoke()` is result-oriented: a stage that throws becomes
`kind: "error"` with a typed `error` whose `cause` is the original object. The two
cannot both hold. This branch's contract wins, because a guardrail that failed to
reach a verdict has no business throwing at its caller, and the original error object
is still reachable as `cause`. The invariant #186 was actually protecting — the
pipeline's own error survives, and a throwing consumer `onStep` callback never replaces
it with its own — is now asserted in that form. Three assertions in `invoke.test.ts`
were rewritten accordingly, and one dry-run assertion was updated from the old
`kind: "error"` sentinel to `kind: "dry_run"`. No test was deleted.

### Re-validation on the merged tree

Run locally in this checkout, on Node `v22.22.1` (below the declared `>=24` engine
range; CI runs Node 24 and is the authority for that runtime):

```text
npm run typecheck   # pass
npm run lint        # pass
npm test            # 289 tests, 289 pass, 0 fail
npm run build       # pass
npm run test:smoke  # pass; 80 named exports resolved from the built ESM entry
node --import tsx scripts/check-enforcement-evidence.ts origin/main HEAD
                    # pass; evidence file detected as updated
```

The test count is now 289 rather than the 112 recorded above: `main` added its own
suite (`onStep` observability, retry, preflight, telemetry, admin, cost, and fixture
tests), and the eleven restored dry-run/typed-failure tests bring the branch's own
back. The 112 figure remains accurate for the pre-merge commit it was written against.

The eleven restored tests are the branch's core evidence and all pass unmodified
against the merged implementation, which is the strongest available signal that the
integration is semantically right rather than merely type-correct: the exact five-stage
dry-run trace and step ordering, a real 64-byte guard agent signature inside the
enforced simulation with zero send/poll calls, fail-closed fee handling in dry run,
preflight, and cost pre-check, `ContractResponseError` on malformed `result.auth`,
`SigningError` with the required address, `BroadcastError` preserving the transport
error as `cause`, and a post-inclusion guard refusal staying `blocked` with a real
hash and `charged: true`.

### Live enforcement-suite limitation — still not claimed as passing

Unchanged from the section above and still true: this checkout has no `.env.phase2`
credential file, so `npm run test:integration` cannot begin its scenarios and no fresh
Phase-2 transcript is claimed. The merged tree adds `onStep` observability and a
bounded jittered retry to the same path the live suite exercises, so the five recorded
scenarios above should be re-run by a maintainer holding credentials before merge.
That is an argument, not a measurement, and this section does not present it as one.

## Addendum — 2026-09-29 (PR #169: per-account invoke queue and sequence reservation)

Recorded because this PR touches the enforcement path (`src/tx.ts`, `src/invoke.ts`)
and CI's `enforcement-path evidence gate` therefore requires this file in the diff.

**It is not accompanied by a fresh live-testnet run**: this checkout has no
`.env.phase2` credentials, so `npm run test:integration` cannot begin its
scenarios. No fresh Phase-2 transcript is claimed below. The CI gate verifies
only that this file was touched, not the numbers, and the same limitation stated
in every addendum above applies here unchanged.

### What the PR changes on the enforcement path

This PR makes concurrent `invoke()` calls safe for one source account, and
nothing else on that path moves.

- `src/tx.ts`: adds `isSequenceNumberFailure()`, a deliberately narrow classifier
  for a submission rejected for a stale/duplicate account sequence (`tx_bad_seq`
  and its prose variants). It sits next to `isStaleLedgerResourceFailure()` and
  follows the same shape. No existing function is modified, so the stale-ledger
  classifier the five scenarios above depend on is byte-identical.
- `src/invoke.ts`: adds a per-(server, account) serialization queue, so a whole
  invocation — fetch, build, simulate, **and submit** — runs one at a time per
  source account, plus a monotonic sequence reservation that advances past an
  RPC snapshot which has not yet observed the preceding submission. A
  `tx_bad_seq` outcome is classified as `retryable: "sequence_number_collision"`
  and re-runs the full pipeline against a refreshed account snapshot.
- `src/index.ts`: exports `isSequenceNumberFailure` and the
  `RetryableInvokeFailure` type.

Unchanged, deliberately: the authorization preimage and nonce policy, credential
kinds answered, the probe → sign → enforced-simulation ordering, resource
assembly, submission, block classification, and every outcome value and detail
string. The queue releases in `finally`, so a failed transaction cannot strand
later calls, and the reservation is scoped to the RPC server object as well as
the account key so the same account on two networks does not share state.

### The one behavioural change a reviewer should actually weigh

The retry predicate widened. Before this PR only `stale_ledger_resource_limit`
was retryable; now any outcome carrying a `retryable` tag is, which adds
`sequence_number_collision`. A transaction rejected for a bad sequence applies
nothing, so retrying it is safe on the same grounds as the stale-ledger case
argued above. It is deliberately **not** extended to `Auth` failures — those are
the guard refusing, and retrying a block would be wrong. Both directions are
pinned in `tests/unit/tx.test.ts`: `tx_bad_seq` and prose mismatches classify as
sequence failures, and an unrelated `tx_insufficient_fee` does not.

The one case this cannot fully settle offline: when a sequence collision is
caused by *another process* broadcasting for the same account, the reservation
keeps advancing and each retry re-fetches. The unit test for this asserts the
observable contract — two serialized envelopes, sequences 8 and 9, from a mock
whose `getAccount` never advances — but whether that holds against real
concurrent writers needs the live suite.

### What did run locally

```text
npm run typecheck                        # clean
npm run lint                             # clean
npm test                                 # 294 unit tests passing, 0 fail
npm run build                            # clean
npm run test:smoke                       # 82 exports resolve via the ESM export map
node --import tsx scripts/check-enforcement-evidence.ts upstream/main HEAD
                                        # pass; evidence file detected as updated
```

`tests/unit/invoke.test.ts` gains a "invoke sequence reservation" suite driving
the real pipeline against a mocked RPC: a `tx_bad_seq` first send followed by a
successful retry, and two concurrent invocations proven serialized with distinct
envelope sequences. These are mocks. They pin the client-side ordering
guarantee; they cannot substitute for the live run, and this addendum does not
claim they do.

**A maintainer with `.env.phase2` should run `npm run test:integration` against
this branch before merge** and replace this addendum with the fresh run output.
No credentials, deployment or policy change are needed beyond what the suite
already does.

## Addendum — 2026-09-29 (PR #206 / Issue #161: `validateGuardPolicy` structured failures aligned to SPEC §8)

Recorded because this PR touches the enforcement path (`src/policy.ts`) and CI's
`enforcement-path evidence gate` therefore requires this file in the diff.

**It is not accompanied by a fresh live-testnet run**: `.env.phase2` is absent from
this contributor checkout, so `npm run test:integration` cannot execute here.

### Summary of changes to the enforcement path

- `src/policy.ts`: adds `validateGuardPolicy(policy: unknown, options?: ValidatePolicyOptions | string): PolicyFailure[]`
  providing client-side policy validation against all 10 bullets of SPEC §8 rules prior to encoding or broadcast.
- Accumulates all failures at once (`PolicyFailure[]`) for form UX rather than failing fast on the first error.
- Defines and exports `POLICY_RULE_IDS` (21 rule identifiers covering type guards, non-negative bounds, window constraints,
  duplicate vectors, self-address collisions, and recipient conflicts), verified for parity against vendored fixture `tests/fixtures/policy-rule-ids.json`.

Unchanged, deliberately: the existing policy encode/decode functions (`policyToScVal`, `decodePolicy`, `policyFromScVal`),
`__check_auth` signing, pre-flight simulation, transaction submission, and all on-chain enforcement logic. `validateGuardPolicy`
is pure client-side validation additive to the policy lifecycle.

### What did run locally

```text
npm run typecheck                        # clean
npm run lint                             # clean
npm test                                 # 362 unit tests passing, 0 fail
npm run build                            # clean
npm run test:smoke                       # passes
npm run test:exports                     # all 88 exports resolve via the ESM export map
node scripts/check-enforcement-evidence.ts main HEAD
                                         # pass; evidence file detected as updated and structure valid
```

The new coverage for this change is `tests/unit/policy.test.ts` with 37 tests covering non-object inputs, invalid field types,
invalid addresses, all SPEC §8 rules (bullets 1–10), duplicate detection, self-address rejection, and multiple failure accumulation.
No network, no credentials.

**A maintainer with `.env.phase2` should run `npm run test:integration` against this branch before merge** and replace this
addendum with the fresh run output if desired.

## Addendum — 2026-10-04 (PR #195 / Issue #121: remove library-side console output, add optional logger injection)

Recorded because this PR touches the enforcement path (`src/invoke.ts`,
`src/preflight.ts`) and CI's `enforcement-path evidence gate` therefore requires
this file in the diff.

**It is not accompanied by a fresh live-testnet run**: `.env.phase2` is absent
from this checkout, so `npm run test:integration` cannot execute here. No fresh
Phase-2 transcript is claimed below, and the gate verifies only that this file
was touched — not the numbers.

### What the PR changes on the enforcement path

The change is output plumbing, not enforcement logic. The SDK previously wrote
one environment-gated `console.*` line from `src/invoke.ts`
(`SAG_DEBUG_RESOURCES=1`). Every such write is removed: a silent-by-default
`GuardLogger` (`src/logger.ts`) is now threaded through `invoke`,
`PreFlightInterceptor`, `CostPreChecker` and `GuardTelemetryListener` as an
optional, injectable sink. With no logger supplied every config resolves to the
shared `SILENT_LOGGER`, so the library prints nothing; with one supplied, each
decision point (verdicts, cache hits/stores/invalidations, telemetry pages and
gaps, cost overruns, retries) is reported through it.

Unchanged, deliberately: the authorization preimage and nonce policy, credential
kinds answered, the probe → sign → enforced-simulation ordering, resource
assembly, submission, block classification, and every outcome value and detail
string. A logger is advisory only — a throwing sink is isolated and cannot
change an outcome, the same guarantee `onStep` and `onGap` already carry. The
five scenarios recorded above are produced by the contract during enforced
simulation, which this diff does not touch.

### What did run locally (post-merge with `main`)

```text
npm run typecheck                        # clean
npm run check:strict-ratchet             # ok
npm run lint                             # clean
npm test                                 # 606 tests passing, 0 fail, 1 skipped
npm run build                            # clean
npm run test:smoke                       # 122 named exports resolve via the ESM export map
npm run test:exports                     # every declared subpath resolves; undeclared paths refused
npm run check:bundle-size                # within budget
node scripts/check-enforcement-evidence.ts --check-structure   # ok
```

`tests/unit/logger.test.ts` covers the change with no network: silence by
default across a full `check → blocked` cycle (console methods and both stdout
and stderr writes are recorded, and none may occur), delivery to an injected
sink with the host's own `this` preserved, level-dropping for partial loggers,
isolation of a throwing sink on every level, and an exhaustive source-tree audit
that fails `npm test` if any `src/` file ever calls `console.*` or writes to
stdout/stderr. These are mocks and a static audit; they cannot substitute for
the live run, and this addendum does not claim otherwise. The merge with `main`
also re-validated the enforcement path against `main`'s newer unit suites
(606 passing), which exercise the same classification and plumbing.

**A maintainer with `.env.phase2` should run `npm run test:integration` against
this branch before merge** and replace this addendum with the fresh run output.
No credentials, deployment or policy change are needed beyond what the suite
already does.

## Addendum — 2026-10-05 (PR #172: policy context on the cost pre-check)

This PR reaches the enforcement-path file list through `src/policy.ts` by exactly
one addition: the type alias `export type GuardPolicy = PolicyConfig`, plus its
re-export from `src/index.ts`. It introduces no value, no runtime statement and
no new branch — the alias is erased at compile time, so policy encoding,
validation and block classification are byte-for-byte what the run above
exercised.

Everything else in the PR is additive and sits *after* the verdict it reports
on: `policyContext` is computed in `src/cost.ts` from the decision the
interceptor already returned plus the caller's own opt-in policy source, and is
attached to the returned cost decision. It is never read by, and cannot feed
back into, the authorization path. The `logger` field on `CostPreCheckConfig`
restored by this PR is advisory only, under the same guarantee the PR #195
addendum above states: a logger cannot change an outcome.

No fresh live run was performed for this change, and this addendum does not
claim one. The five scenarios recorded above are produced by the guard contract
during enforced simulation; no line this PR touches participates in that, so the
recorded results remain valid for them.

## Addendum — 2026-10-19 (PR: issues #340, #341, #343, #344 — heartbeat retry and validation, richer policy summary, detached telemetry snapshots)

Recorded because this PR reaches the enforcement-path file list through
`src/policy.ts` (issue #343, `describePolicy`) and CI's `enforcement-path
evidence gate` therefore requires this file in the diff.

**It is not accompanied by a fresh live-testnet run**: `.env.phase2` is absent
from this contributor checkout, so `npm run test:integration` cannot begin its
scenarios. No fresh Phase-2 transcript is claimed below. The CI gate verifies
only that this file was touched — not the numbers — and the same limitation
stated in every addendum above applies here unchanged.

### What the PR changes on the enforcement path

Exactly one function in `src/policy.ts`, and it is a rendering helper, not a
decision:

- `src/policy.ts`: `describePolicy()` — the operator-facing, log-friendly
  summary of a policy — now also reports the constraints it previously omitted:
  the blocked recipients (`blocked_recipients`), the per-recipient window caps
  (`recipient_window_caps`), and the active window (`active_from` /
  `active_until`) with its state at a given moment. Recipient lists are
  reported as counts unless the new `detail: true` option asks for the
  addresses, the lists are sorted so the output is stable, and the new
  `nowSecs` option pins the moment the window is judged against. A new
  `DescribePolicyOptions` type and an `ActiveWindowState` type are exported
  alongside it.

Unchanged, deliberately: `policyToScVal`, `decodePolicy`, `policyFromScVal`,
`validateGuardPolicy`, `POLICY_RULE_IDS`, the address type guards, the
`ReadonlyPolicyConfig` / `freezePolicy` boundary, the dead-man helpers
(`isDeadManFrozen`, `deadManRemaining`), `extractTransferAmount`,
`readPersistentEntry` and `fetchGuardPolicyAndWindow`. None of them reads or
writes the summary, and the summary reads only fields the policy already
carried — it produces a string for a human and is never consulted by the
authorization path, the policy encoding, the pre-flight simulation or the
block classification. The five scenarios recorded above are produced by the
guard contract during enforced simulation; no line this PR touches participates
in that, so the recorded results remain valid for them.

The rest of the PR is outside the enforcement path entirely: the bounded
heartbeat retry and its input validation (`src/heartbeat.ts`) and the detached
telemetry snapshots (`src/telemetry.ts`) are operator-side plumbing that cannot
reach a verdict.

### What did run locally (Node v24.21.0, matching the package's engine)

```text
npm run typecheck                        # clean
npm run check:strict-ratchet             # ok
npm run lint                             # clean
npm run build                            # clean
node --import tsx scripts/check-doc-links.ts   # 36 files, 193 links, no broken links or anchors
npm scripts/check-bundle-size.mjs        # within budget (raw 888,474 B / gzip 202,167 B)
```

The unit suite covers the new behaviour with no network and no credentials:
`tests/unit/policy.test.ts` pins the summary's contents (counts by default, the
address lists on request, the sorted/stable output, and the four active-window
states including the `nowSecs` boundary cases), `tests/unit/heartbeat.test.ts`
pins the retry budget, the deterministic backoff, the abort, the exhaustion
path and the "a policy block is never retried" rule as well as every rejected
scheduler input, and `tests/unit/telemetry.test.ts` pins the detached snapshot
contract at the top level, in the nested decoded data and in the opt-in raw
payload.

**A maintainer with `.env.phase2` should run `npm run test:integration` against
this branch before merge** and replace this addendum with the fresh run output.
No credentials, deployment or policy change are needed beyond what the suite
already does.

## Addendum — 2026-10-19 (PR #352: adapter call batches, silent hook failures, browser-safe hashing, packed-type smoke test)

Recorded because this PR touches the enforcement path (`src/tx.ts`,
`src/preflight.ts`) and CI's `enforcement-path evidence gate` therefore requires
this file in the diff.

**It is not accompanied by a fresh live-testnet run**: `.env.phase2` is absent
from this checkout, so `npm run test:integration` cannot begin its scenarios. No
fresh Phase-2 transcript is claimed below. The CI gate verifies only that this
file was touched — not the numbers — and the same limitation stated in every
addendum above applies here unchanged.

### What the PR changes on the enforcement path

- `src/tx.ts`: removes `node:crypto`. `networkId` and the auth-preimage digest
  now come from `sha256()` in the new `src/hash.ts` (the Stellar SDK's own
  browser-compatible SHA-256) instead of `createHash("sha256")`; `agent.sign()`
  takes the digest `Uint8Array` directly instead of a `Buffer` copy;
  `ledgerKeyId()` renders the same XDR bytes as lower-case hex instead of
  base64 — an in-call de-duplication key for footprint entries, the same bytes
  in a different encoding, never persisted and never compared across runs; and
  `toPlain` renders bytes through `bytesToHex` instead of `Buffer.toString`.
- `src/preflight.ts`: the cache-key fingerprints (`callFingerprint`,
  `configFingerprint`) move from `node:crypto` to the same `hash.ts` helpers,
  keeping the existing 4-byte big-endian length framing — the length prefix is
  now written through a `DataView` instead of `Buffer.writeUInt32BE`, so every
  framed part hashes to the same bytes in the same order. `CheckBatchOptions`
  additionally gains optional `onStep`, `signal` and `timeoutMs`, forwarded
  unchanged to each call's `check()`; that is option plumbing, not verdict logic.

Unchanged, deliberately: the authorization preimage layout and nonce policy,
the credential kinds answered, probe → sign → enforced-simulation ordering,
footprint assembly, submission, and block classification. SHA-256 is SHA-256:
the digest inputs are the same bytes in the same order, so the signature the
contract verifies is byte-identical. The five scenarios recorded above are
produced by the contract during enforced simulation; no line this PR touches
changes what the contract decides.

Also fixed on this branch while repairing CI after the merge of `main`: the
merge left `src/telemetry.ts` using `sha256Hex`, `utf8Length` and `bytesToHex`
without importing them, after `node:crypto` was removed from the file — the
missing `./hash.ts` import was the `typecheck` failure, and it is now in place.

### What did run locally (Node v24.21.0, matching the package's engine)

```text
npm run typecheck                        # clean
npm run check:strict-ratchet             # ok
npm run lint                             # clean
npm test                                 # 821 tests, 820 pass, 0 fail, 1 skipped
npm run test:coverage:floor              # ok — 96.92% statements on the enforcement path
npm run build                            # clean
npm run test:browser                     # ok — root entry bundles with no node:* imports
npm run test:types:packed                # ok — consumer compiles against the packed tarball
npm run test:smoke                       # ok — 154 exports resolve via the ESM export map
npm run test:exports                     # ok — every declared subpath resolves
npm run check:bundle-size                # within budget
node scripts/check-enforcement-evidence.ts upstream/main HEAD
                                        # pass; evidence file detected as updated
```

The touched paths are covered without network by `tests/unit/tx.test.ts` and
`tests/unit/preflight.test.ts` against mocks and recorded fixtures, and
`npm run test:browser` proves the root entry still bundles with no `node:*`
imports. Those are mocks and a static bundle check; they cannot substitute for
the live run, and this addendum does not claim otherwise.

**A maintainer with `.env.phase2` should run `npm run test:integration` against
this branch before merge** and replace this addendum with the fresh run output.
No credentials, deployment or policy change are needed beyond what the suite
already does.

## Addendum — 2026-10-20 (PR: tx hash before confirmation polling, typed simulation-fee failures, admin cancellation, contracts vocabulary fixture)

Recorded because this PR touches the enforcement path (`src/tx.ts`,
`src/invoke.ts`, `src/preflight.ts`) and CI's `enforcement-path evidence gate`
therefore requires this file in the diff.

**It is not accompanied by a fresh live-testnet run**: `.env.phase2` is absent
from this contributor checkout, so `npm run test:integration` cannot begin its
scenarios. No fresh Phase-2 transcript is claimed below. The CI gate verifies
only that this file was touched — not the numbers — and the same limitation
stated in every addendum above applies here unchanged.

### What the PR changes on the enforcement path

- `src/tx.ts`: the transaction hash is published through an optional
  `onSubmitted` hook, delivered once, immediately after `sendTransaction`
  resolves and **before** any status polling. An ambiguous broadcast response —
  the server answered but named no transaction — is reported as `hash: null`
  and fails closed with a typed `BroadcastError` instead of being polled for.
  Separately, the simulation's resource fee is read through the shared exact-u64
  parser instead of a bare `BigInt(...)`, so a malformed fee is rejected with
  the SDK's typed `ContractResponseError` rather than a native conversion error.
- `src/invoke.ts`: `invoke()` accepts the `onSubmitted` hook and forwards it to
  the broadcast; every outcome that happened after a broadcast carries the hash
  as `transactionHash`, and an `RpcTimeoutError` raised while polling travels
  with it. A malformed simulation fee keeps its typed `ContractResponseError`
  (field `minResourceFee`, stage `assemble`) instead of being flattened into a
  generic simulation failure.
- `src/preflight.ts`: the fee parser carries the `preflight` stage, so the
  fail-closed `undetermined` verdict names where the bad value was read.

Unchanged, deliberately: the authorization preimage and nonce policy, credential
kinds answered, the probe → sign → enforced-simulation ordering, resource
assembly for a *well-formed* simulation, submission, block classification, and
every existing outcome value and detail string. The hash is published *after*
the broadcast decision the guard already made; the fee parser rejects exactly
the values the bare `BigInt` conversion rejected anyway, with a typed error
instead of a native one. The five scenarios recorded above are produced by the
guard contract during enforced simulation; no line this PR touches participates
in that, so the recorded results remain valid for them.

The rest of the PR is outside the enforcement path: the administrative helpers
now forward `signal`/`timeoutMs` (`src/admin.ts`), and the SDK's decoder tests
read the contracts repo's own `auth_checked` vocabulary fixture instead of a
copy of the matrix (`src/reasons.ts` gains the contract's newer reason
symbols). Neither can reach a verdict.

### What did run locally (Node v24.21.0, matching the package's engine)

```text
npm run typecheck                        # clean
npm run check:strict-ratchet             # ok
npm run lint                             # clean
npm test                                 # 994 tests, 993 pass, 0 fail, 1 skipped
npm run test:coverage:floor              # ok — invoke.ts 95.95% lines / 87.87% branch / 95.83% funcs
npm run build                            # clean
npm run test:smoke                       # 172 named exports resolve via the ESM export map
npm run test:exports                     # every declared subpath resolves; undeclared paths refused
npm run check:bundle-size                # within budget
node --import tsx scripts/check-doc-links.ts   # 38 files, 217 links, no broken links or anchors
```

The unit suite covers the new behaviour with no network and no credentials:
`tests/unit/invoke.test.ts` pins the hash being published before the first
poll, the hash surviving a failed poll, a spent deadline and an ambiguous
broadcast response, and the typed classification of a malformed fee;
`tests/unit/tx.test.ts` pins the submission event and the fee parser;
`tests/unit/preflight.test.ts` pins the fail-closed fee handling;
`tests/unit/admin.test.ts` pins the forwarded cancellation and timeout options;
`tests/unit/auth-checked-vocabulary.test.ts` decodes the contracts fixture.

These are mocks and a vendored fixture. They cannot substitute for the live
run, and this addendum does not claim they do.

**A maintainer with `.env.phase2` should run `npm run test:integration` against
this branch before merge** and replace this addendum with the fresh run output.
No credentials, deployment or policy change are needed beyond what the suite
already does.

## Addendum — 2026-10-20 (cost ceilings, fee formatting, ledger provenance, observer isolation)

Recorded because this PR touches the enforcement path (`src/preflight.ts`) and
CI's `enforcement-path evidence gate` therefore requires this file in the diff.

**It is not accompanied by a fresh live-testnet run**: `.env.phase2` is absent
from this contributor checkout, so `npm run test:integration` cannot begin its
scenarios. No fresh Phase-2 transcript is claimed below. The CI gate verifies
only that this file was touched — not the numbers — and the same limitation
stated in every addendum above applies here unchanged.

### What the PR changes on the enforcement path

- `src/preflight.ts`: an admissible verdict now carries an optional
  `provenance: { ledger }`, read from the **same** successful enforced
  simulation's `latestLedger`. It is informational metadata only. A missing,
  fractional, negative, non-numeric or unsafe marker is omitted rather than
  fabricated, and no additional ledger RPC is made to label the quote.
- `src/cost.ts`: the fee ceiling is validated as a non-negative `bigint` at
  construction and before a per-call override is used, `formatFee()` rejects
  negative fees, and `CostDecision` exposes the same provenance (or `null` on
  blocked/undetermined arms).
- `src/errors.ts`: `InvalidInputError` is shared from here, and the new
  `InvalidFeeCeilingError` extends it. Invalid input remains a `TypeError` and
  is still re-exported from `src/preflight.ts` for existing import paths.

Unchanged, deliberately: the authorization preimage and nonce policy, the
probe → sign → enforced-simulation ordering, resource assembly, block
classification, and every existing verdict or outcome value. Provenance is
copied out of the simulation response after the guard has already decided;
validation rejects only malformed configuration before any RPC. The five
scenarios recorded above are produced by the guard contract during enforced
simulation, so the recorded results remain valid for them.

### What did run locally (Node v24.21.0, matching the package's engine)

```text
npm run typecheck                        # clean
npm run check:strict-ratchet             # ok
npm run lint                             # clean
npm test                                 # 1017 tests, 1016 pass, 0 fail, 1 skipped
npm run test:coverage:floor              # ok — preflight.ts 95.84% lines / 84.51% branch / 100% funcs
npm run build                            # clean
npm run test:smoke                       # 173 named exports resolve via the ESM export map
npm run test:exports                     # every declared subpath resolves; undeclared paths refused
```

The new behaviour is covered offline with mocks: `tests/unit/cost.test.ts`
pins ceiling validation (negative, zero, omitted, per-call, large), negative
`formatFee` rejection, and provenance mapping/serialization;
`tests/unit/preflight.test.ts` pins provenance coming from the pricing
simulation and its omission when unavailable; and
`tests/unit/adapter-conformance.test.ts` proves across all four adapters that a
throwing or rejecting `onDecision` cannot stop an admissible handler (while the
existing blocked/undetermined assertions prove it cannot resume a refusal).

These are mocks. They cannot substitute for the live run, and this addendum does
not claim they do.

**A maintainer with `.env.phase2` should run `npm run test:integration` against
this branch before merge** and replace this addendum with the fresh run output.
No credentials, deployment or policy change are needed beyond what the suite
already does.


