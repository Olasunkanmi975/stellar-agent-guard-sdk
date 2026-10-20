# Threat Model — SDK Layer

Contract-side threats are modeled in Contracts SPEC §10. This document covers the
SDK's own surface: pre-flight policy enforcement, verdict integrity, and the
trust chain between the agent, the SDK, and the guard contract.

Audit lens: every row below names the asset, the threat, how the SDK mitigates
it (citing the implementing code and a test), the residual risk, and the
on-chain backstop that the SDK cannot bypass.

---

## Trust chain

What a malicious RPC can do:

1. **Pre-flight lies are possible.** The SDK relays RPC-simulated results into
   `PreFlightInterceptor.check()` (call `preFlightCheck` in `src/preflight.ts`);
   an RPC that fabricates an `admissible` simulation is the only thing that can
   turn a `blocked` policy into `admissible`. The pre-flight verdict is a
   *prediction* of the chain's decision, not the decision itself.

2. **Pre-flight lies cannot forge the agent's signature or pass `__check_auth`.**
   The same chain that would grant the call also runs the enforced
   simulation (`enforcedCall` in `src/invoke.ts`); it re-verifies the agent's
   `SorobanAuthorizationEntry` against the registered key via
   `verifyAgentSignature` (`src/tx.ts`) and the guard's own `event_auth_checked
   / allowed` event. Whatever the pre-flight predicted, the contract's
   enforcement is the backstop: the broadcast path carries the signed authority
   the agent actually produced.

What a malicious RPC **cannot** do through the SDK:

- Forge the agent signature (only the agent key can produce a valid
  `BytesN<64>` signature over the 32-byte auth digest, and the host re-checks
  it).
- Pass `__check_auth` (the contract's enforcement runs regardless of the
  pre-flight result; a block there is the SDK's *blocked* outcome, not
  `undetermined`).
- Forge the guard's own decision event (`event_auth_checked/blocked/<reason>`
  is signed by the contract; `src/events.ts` decodes it from diagnostics).

The trust chain, in one line: RPC simulates → SDK reports pre-flight verdict →
guard `__check_auth` enforces on broadcast. Pre-flight shortcuts the network by
returning before broadcast; it does not remove the on-chain check.

---

## Threat table

| Asset | Threat | SDK mitigation | Residual risk | On-chain backstop |
|---|---|---|---|---|
| Funds (SAC) | **Verdict inversion / fail-open regression** — code drifts so `admissible` papers over a `blocked` policy | Fail-closed defaults everywhere: `check()` yields `undetermined` (not `admissible`) on simulation failure, missing/invalid fee, or invalid input; no branch ever returns `admissible` from an error or `blocked` path | A single mislabeled branch could admit a refused call pre-broadcast (free, caught at enforcement) | `enforceCall` → `__check_auth` re-evaluates each broadcast; a block at enforcement is a real chain refusal |
| Funds | **Stale cache verdict** — cached `admissible` outlives a changed policy | Cache keyed on policy revision + ledger seq; expires on ledger advance, TTL, or explicit `invalidate()`; a revision read failure bypasses the cache | A stale-verdict read of a policy change between TTLs is possible | – |
| Funds | **Compromised agent runtime bypasses middleware entirely** — SDK is advisory at runtime; enforcement lives on-chain | `PreFlightInterceptor` is **zero-broadcast**: it refuses *before* broadcast (no hash, no state move) so skipping it only wastes the agent run; the guard account itself enforces `__check_auth` at broadcast for every authorized call | A malicious runtime that never calls the SDK at all can still act; the SDK cannot enforce against itself | On-chain `__check_auth` is the last predicate on every broadcast |
| Liveness | **Malicious RPC feeds fake simulation results** — RPC simulates an `admissible` that the contract would deny | `invoke()` runs an **enforced simulation** (`enforcedCall` in `src/invoke.ts`) with the real signed auth entries; the contract's `event_auth_checked` is the emitted, contract-signed verdict | RPC could simulate an `admissible` that the contract also approves (no fix needed); a fabricated *positive* simulation still gets re-checked by `__check_auth` at broadcast | Contract `event_auth_checked` + `__check_auth` is authoritative |
| Trust (agent identity) | **Malicious RPC / host feeds fake agent signatures** — RPC returns an auth entry attributed to a different key | `verifyAgentSignature` (`src/tx.ts`) verifies the 32-byte digest with Ed25519; only the registered agent key can satisfy it, and the host validates the same digest on broadcast | A compromised RPC can present a *valid* signature for a key the operator actually owns; nothing stops that operator's own reported key from being the attacker's subkey | Contract `event_auth_checked` + `Signature` type from `BytesN<64>` |
| Supply chain | **Single dependency** (`@stellar/stellar-sdk`) — a supply-chain compromise of the SDK itself or its sole dep breaks the guard | The SDK is a deliberately thin adapter layer with no network, no secrets, and no console/telemetry to a third party; dependency pinning and published verification (`verifyGuardWasm` in `src/wasm.ts`) constrain what runs | A supply-chain takeover of the sole dep is not mitigated by this SDK layer — out of scope, tracked elsewhere | Contracts repo + on-chain WASM hash (`GUARD_WASM_HASH`) catch a changed bytecode |

---

## Verification (tests)

Fail-closed tiers are pinned by unit tests so a future regression is caught
before CI. Representative names (in `tests/unit/`):

- Fail-closed on invalid simulation fees and missing refund limits:
  `tests/unit/invoke-dry-run.test.ts` (`fails closed when the enforced
  simulation fee is missing, negative, or malformed`; `keeps preflight and
  cost checks fail-closed on invalid simulation fees`).
- Verdict integrity, per asset/threat:
  `tests/unit/preflight.test.ts` (`policy refusal (blocked) returns a verdict
  without throwing`), `tests/unit/invoke-dry-run.test.ts`
  (`preserves a post-inclusion guard block as a charged blocked outcome`),
  `tests/unit/tx.test.ts` (`does NOT treat a guard block as retryable`).
- Trust chain (agent signature verified, not relayed): contract-side checks in
  `tests/unit/tx.test.ts` (payload/signature pairing, one-bit mutation, empty
  or oversized signatures).
- Supply chain: `tests/unit/wasm.test.ts` (verifies real contract artifact vs.
  a pin), `src/wasm.ts` (`verifyGuardWasm`).

Every mitigation claim above corresponds to a named test; a change that removes
a fail-closed branch is visible in CI as a dropped test name.

## Diagnostics and redaction

SDK diagnostics are not a safe-to-forward copy of an application request. The
default logger is silent, and an injected logger receives a copied metadata
object with sensitive-looking fields removed. The redaction is logger-only: it
does not mutate errors, adapter callbacks, or telemetry records.

| Surface | May contain application data | Safe default | Redaction point |
|---|---|---|---|
| `GuardError` fields | `SimulationError.diagnosticEvents`, `BroadcastError.failure.resultXdr` and diagnostic events, plus the original `cause` | Keep local; forward only the error class, `stage`, `path`, and a reviewed message | Error boundary in the integrator |
| Adapter `onDecision` / framework requests | Tool names, caller arguments, and framework request objects | Do not serialize the request without an application-specific allowlist | The callback supplied by the integrator |
| Adapter `onBlocked` | `call`, including Soroban arguments | Forward only `adapter`, `kind`, `reason`, and `explanation` unless the destination is trusted | The `onBlocked` sink |
| Telemetry with `includeRaw: false` (default) | Decoded event data only | Suitable for normal event handling, subject to the contract data policy | `diagnosticsToEvents` / listener decode |
| Telemetry with `includeRaw: true` | RPC/XDR source payloads, including raw diagnostic event data | Debugging only; keep short-lived and redact before incident sharing | The consumer's telemetry export |
| Injected logger metadata | SDK status fields and counters | Safe by default; private/secret/signer/signature/raw/diagnostic/payload/argument fields are omitted | `resolveLogger` / `redactLogMeta` |

The SDK never logs private keys or signer output. It also does not place caller
arguments or raw RPC payloads in its own logger metadata. The logger test pins
both field removal and non-mutation; `includeRaw` tests pin that an explicitly
requested public payload remains available to its caller.

---

## README link

This document now describes what pre-flight does and cannot stop. Link from the
README's "What it does" block (pre-flight handles interception only) under a
new "Trust & limitations" paragraph, and point auditors at `docs/threat-model.md`.
