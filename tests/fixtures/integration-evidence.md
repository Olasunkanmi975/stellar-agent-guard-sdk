# Live integration evidence — Phase 2

Record of the enforcement suite running against the real Phase 2 testnet
instance. Reproduce with `npm run test:integration` (requires `.env.phase2`).

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

The SDK fix is a single bounded retry, gated on this specific failure
(`isStaleLedgerResourceFailure`). It is safe because a transaction rejected for
exceeding a resource limit applies nothing, and inclusion proves the ledger has
since advanced. It is deliberately *not* applied to `Auth` failures — those are
the guard refusing, and retrying a block would be wrong. Re-running the same six
transfers returned 6 of 6 allowed with no waits.

This is worth stating plainly rather than burying: it is a client-side resource
pricing issue, not a guard defect, and it did not let any transaction through that
policy forbade.

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
