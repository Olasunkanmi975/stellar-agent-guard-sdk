# Live integration evidence — Phase 2

Record of the enforcement suite running against the real Phase 2 testnet
instance. Reproduce with `npm run test:integration` (requires `.env.phase2`).

**Last verified**: September 2026 (feat/integration-harness-and-guardpolicy-types)
**Note**: Type guard validation refactoring in `src/policy.ts` does not change enforcement behavior; evidence remains valid.
**Note** (feat/policy-readonly-deep-freeze): Added `DeepReadonly`/`ReadonlyPolicyConfig`/`freezePolicy` — type and freeze boundary change only; no enforcement logic altered. Evidence remains valid.
**Note** (feat/preflight-334-335-coalesce-and-batch-bounds, PR for #334/#335): Adds in-flight coalescing for concurrent identical `check()` calls and batch-wide `signal`/`deadlineMs` handling on `checkBatch()`. Neither changes how the guard authorization entry is built or signed, how the enforced simulation runs `__check_auth`, or how a policy verdict is classified: coalescing only reuses one identical in-flight run and is removed on settle (never a durable cache), and a fired batch bound can only produce fail-closed `undetermined` verdicts for unfinished calls — it can never turn a refusal or an error into `allowed`. The five scenarios recorded below are sequential, un-cancelled calls whose verdicts and state transitions are unchanged; coalescing, cancellation, deadline and cleanup paths are covered by unit tests in `tests/unit/preflight.test.ts`. No fresh live run was performed for this change; the recorded results remain valid for these scenarios.

**Note** (feat/sdk-295-298-signer-identity-retry-metadata-deadline, PR for #295/#296/#297/#298): Adds signer-identity validation at the `AgentSigner` boundary, public-boundary validation of retry/fee-bump/poll options, structured retry metadata on terminal outcomes, and an optional overall `deadlineMs` shared by retries and polling. None of these changes alter how the guard authorization entry is built or signed, how the enforced simulation runs `__check_auth`, or how a policy verdict is classified: invalid *configuration* is rejected before the pipeline starts, retry metadata is descriptive only, and a spent deadline is reported as a fail-closed timeout (never `allowed`). The five scenarios recorded below are un-cancelled calls with valid options, so their verdicts and state transitions are unchanged; the new validation, metadata and deadline paths are covered by unit tests in `tests/unit/tx.test.ts` and `tests/unit/invoke.test.ts`. No fresh live run was performed for this change; the recorded results remain valid for these scenarios.

**Note** (fix/336-339-preflight-heartbeat-hardening, PR for #336): `checkBatch()` now distinguishes an explicitly supplied `initialWindowSpent` snapshot from a failed ledger read. When a positive SAC transfer needs policy or committed-window state that could not be read, the affected verdicts are `undetermined` and the batch is not reported admissible instead of staging against an assumed zero. This changes only the off-chain batch-staging approximation; an individual `check()` still runs the same probe → sign → enforced `__check_auth` simulation, and the on-chain guard remains authoritative. The five scenarios recorded below use single-call enforcement and are unchanged; the new fail-closed staging paths are covered by mocked-RPC tests in `tests/unit/preflight.test.ts`. No fresh live run was performed for this change; the recorded results remain valid for these scenarios.

**Note** (feat/25-tx-fee-bump-on-min-fee, PR #171): Adds a bounded fee-bump retry when broadcast is rejected for being below the network minimum fee. The retry re-prepares the transaction and re-runs the same safety checks.

**Note** (feat/issue-39-feat-policy-decodecheckresult-exhaustive-tests, PR #229): `decodeCheckResult` is now total and fail-closed — an unknown enum tag, a `Blocked` reason the contract does not define, or a malformed payload yields a typed refusal rather than a crash.

**Note** (feat/issue-114-feat-tx-abortsignal-timeout-support-for-check, PR #235): Adds caller-owned cancellation to the enforcement pipeline: an optional `signal`/`timeoutMs` on `check()`, `invoke()` and `submitAndPoll()`, plus a bounded retry envelope for the stale-ledger case.

**Note** (feat/sdk-295-298-signer-identity-retry-metadata-deadline, PR for #295/#296/#297/#298): Adds signer-identity validation at the `AgentSigner` boundary, public-boundary validation of retry metadata/deadlines, and an explicit `cause` on retryable errors.

**Note** (fix/336-339-preflight-heartbeat-hardening, PR for #336): `checkBatch()` now distinguishes an explicitly supplied `initialWindowSpent` snapshot from a failed ledger read. When a positive window is provided, the staged state remains authoritative instead of being discarded as a failed read.

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

## Addendum — 2026-10-20 (PR #360: cache stats snapshot + operator runbook)

Recorded because this PR touches the enforcement path (`src/preflight.ts`) and CI's
`enforcement-path evidence gate` therefore requires this file in the diff.

**It is not accompanied by a fresh live-testnet run**: `.env.phase2` is absent from
this contributor checkout, so `npm run test:integration` cannot execute here. No
fresh Phase-2 transcript is claimed below. The CI gate verifies only that this file
was touched — not the numbers — and the same limitation stated in the addenda
above applies here unchanged.

### What the PR changes on the enforcement path

This PR adds a read-only snapshot of cache statistics to `PreFlightInterceptor`, plus
operator documentation for agent key rotation and recovery. The logic change is in
`src/preflight.ts` only and is intentionally narrow:

- `PreFlightInterceptor` now tracks cache hits, misses, invalidations and current
  entry count, exposed through a read-only snapshot (`getCacheStats()`), without
  changing the enforcement verdicts or cache selection behaviour.
- The implementation is observational and additive: it does not alter the policy,
  the auth preimage, the pre-flight decision itself, or the live enforcement path.
- The rest of the PR is documentation (`docs/concepts/custom-account-signing.md`,
  docs/api-reference.md, docs/troubleshooting.md) and does not influence runtime
  policy enforcement.

This is therefore a non-decision change. The guard contract's live enforcement
scenarios recorded above remain the valid proof for the on-chain decision path; no
line in this PR participates in the contract-side block decision itself.

### What did run locally

This checkout does not claim a fresh live run. The local checks that are relevant to
this PR are the same no-network verification used throughout the evidence file:

```text
npm run typecheck
npm run lint
npm test
npm run build
npm run test:smoke
npm run test:exports
```

Those checks cover the repo's guardrail logic, the export surface, and the packaged
consumer path; they are valuable, but they are not a substitute for the Phase-2
live suite. A maintainer with `.env.phase2` should run `npm run test:integration`
against this branch before merge and replace this addendum with the fresh run
output if desired.

No credentials, deployment, or policy change are needed beyond what the suite
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
