# CostPreChecker API

`CostPreChecker` evaluates expected transaction fees against an optional ceiling before broadcast, and optionally exposes additive policy-relative context (`policyContext`).

## Constructor

```ts
constructor(options: CostPreCheckConfig)
```

### Options

- `interceptor: Pick<PreFlightInterceptor, "check">` — Configured interceptor instance whose simulation prices execution
- `maxFeeStroops?: bigint` — Maximum allowable total fee in stroops (omitted means price it, never object). Must be a non-negative `bigint`; a negative value or any non-`bigint` throws `InvalidFeeCeilingError` at construction. `0n` is a real ceiling, not the same as omission.
- `policySource?: string | PolicyConfig | null` — Opt-in policy source (contract address or `GuardPolicy`/`PolicyConfig`) enabling additive `policyContext`
- `policy?: string | PolicyConfig | null` — Alias for `policySource`

Malformed ceilings are rejected before the interceptor runs, so a bad budget policy cannot spend an RPC call or be hidden behind a guard verdict. `InvalidFeeCeilingError` extends `InvalidInputError` (itself a `TypeError`) and exposes `field`, `rule: "non_negative_bigint"` and the rejected `value`.

## Methods

### `check(call: ContractCall, options?: { policySource?: string | PolicyConfig | null; maxFeeStroops?: bigint }): Promise<CostPreCheckResult>`

Returns `CostPreCheckResult` (`CostDecision`), a discriminated union:
- `{ kind: "within_budget", allowed: true, totalFeeStroops, resourceFeeStroops, inclusionFeeStroops, footprintKeys, feeCeilingStroops, policyContext, provenance }`
- `{ kind: "over_budget", allowed: false, totalFeeStroops, resourceFeeStroops, inclusionFeeStroops, footprintKeys, feeCeilingStroops, policyContext, provenance }`
- `{ kind: "blocked", allowed: false, reason, explanation, detail, totalFeeStroops: 0n, resourceFeeStroops: 0n, inclusionFeeStroops: 0n, policyContext, provenance: null }`
- `{ kind: "undetermined", allowed: false, detail, totalFeeStroops: 0n, resourceFeeStroops: 0n, inclusionFeeStroops: 0n, policyContext, provenance: null }`

### Ledger Provenance (`provenance`)

Priced decisions carry the ledger marker of the simulation that produced the quote:

```ts
provenance: { ledger: number } | null
```

- `ledger` is `latestLedger` read from the **same** enforced simulation, not from a second `getLatestLedger()` call that could race ahead of the state actually priced.
- `null` means the simulation did not establish a usable ledger (absent, non-numeric, fractional, negative or unsafe integer). The SDK never fabricates a ledger number.
- This is **informational only**: it identifies the snapshot a quote describes. It is not a promise that a transaction will land in that ledger, and a quote may be stale by submission time.
- `blocked` and `undetermined` decisions are not simulation-priced, so their `provenance` is always `null`.

### Policy Context (`policyContext`)

When an opt-in policy source is configured, `policyContext` exposes additive policy context derived from the live `check()` call:

```ts
policyContext: {
  perTxCapOk: boolean | null;
  windowRemainingEstimate: number | null;
  reason: string | null;
} | null
```

- `perTxCapOk`: Whether the transaction fits the policy's per-transaction limit (`true` if within cap, `false` if per-tx cap exceeded, or `null` if not determinable).
- `windowRemainingEstimate`: Estimated remaining headroom in the current rolling window. **Always `null` when the contract does not expose sufficient window state.** Note that `null` means "not available / cannot be determined from the current contract state", **not** a zero remaining budget. The SDK never fabricates a zero budget.
- `reason`: The contract's policy block reason if blocked (e.g. `"window_cap_exceeded"` or `"per_tx_cap_exceeded"`), or `null` when allowed.
- When no policy source is configured, `policyContext` is `null`.
