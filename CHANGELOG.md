# Changelog

All notable changes to `stellar-agent-guard-sdk` are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with
the 0.x interpretation documented in [`docs/releasing.md`](docs/releasing.md): during
0.x the **minor** version is the compatibility boundary, and within any `0.1.x` series
the SDK is additive-only.

User-facing changes need an **Unreleased** row here, added in the same pull request
as the change — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## [Unreleased]

### Added

- In-flight coalescing on `PreFlightInterceptor.check()`: concurrent checks for the same call and config share one discovery/enforcement run, removing duplicate RPCs without retaining a durable cache. The entry is removed as soon as it settles, including on failure and `undetermined`, each caller keeps its own `signal`/`timeoutMs` bound, and `coalesceInFlight: false` opts out (#334).
- `signal` and `deadlineMs` on `checkBatch()`: a batch can now be cancelled as a whole or bounded by one overall time budget. Once either fires, no further call is started and every unfinished call is reported as a fail-closed `undetermined` verdict; `timeoutMs` remains a per-call bound (#335).
- `signal` and `timeoutMs` on `check()`, `invoke()` and `CostPreChecker.check()`, plus `RpcTimeoutError` and `DEFAULT_RPC_TIMEOUT_MS`: a hung Soroban RPC can no longer leave a guardrail call pending forever. `check()`/`cost()` report a fired bound as a fail-closed `undetermined` verdict carrying the typed `RpcTimeoutError`; `invoke()` surfaces the same error through its `error` outcome (#114).
- `dmsUrgency()` and `DMS_WARN_RATIO_DEFAULT`: client-side `'ok' | 'warn' | 'expired' | 'unknown'` dead-man countdown urgency, with the same edge semantics as `deadManRemaining` (#132).
- `policyDiff()` and the `PolicyChange` type: set-aware structured diff between two policies for operator display (#131).
- Bounded retry and backoff for a failed heartbeat submission: `retry: { maxAttempts, baseDelayMs, maxDelayMs, random }` on `startHeartbeat()`, plus `DEFAULT_HEARTBEAT_RETRY_OPTIONS`, the `HeartbeatRetryOptions` type, the typed `HeartbeatBlockedError`, and `isRetryableHeartbeatFailure()`. Only a transport failure is retried — a policy block is never retried — and the attempt that failed plus the delay before the next one are announced through `onWarning` while the final failure is reported once through `onError` (#340).
- `describePolicy(policy, options?)` now reports the advanced constraints — the blocked recipients, the per-recipient window caps, and the active window with its state — with a `DescribePolicyOptions` type (`detail`, `nowSecs`) and an `ActiveWindowState` type. Recipient lists are reported as counts unless `detail: true` asks for the addresses, and the output is stable across policies that store the same lists in a different order (#343).
- `onBeat` receives the number of attempts a beat took in its new `attempt` field (#340).
- `validateGuardEventXdr()`: strict offline validation for captured event XDR, reporting every failure with its input index, stable path, pipeline stage, and code, while leaving the resilient live decoders unchanged (#290).
- Unknown committed-event topics are now observable without a logger: `poll()` returns `unknownTopics` (`{ topic, count }[]`) and `watch()`/`watchAll()` accept `onUnknownTopics`, exposing decoded names and per-page counts only — never raw XDR or source payloads. Unknown topics still stay out of `GuardEvent` and the listener buffer (#287).
- `validateAgentPublicKey()` and `isValidAgentPublicKey()`: agent signer identities are checked at construction and before signing. Supported forms are a checksum-valid `G…` StrKey and the raw 32-byte key as 64 hex characters; secret seeds and malformed values are rejected with a `SigningError` naming `signer.publicKey` (#295).
- Structured retry metadata on every terminal `invoke()` outcome, `InvokeRetryError` and fee-bump-exhausted `BroadcastError`: `retry.attempts`, `maxAttempts`, `retried`, `exhausted`, `totalDelayMs`, the per-class `retries` list and the terminal failure. It contains no secrets, signatures, diagnostic payloads, hashes or XDR (#297).
- `deadlineMs` and `clock` on `invoke()`: one overall time budget shared by discovery, signing, retries, broadcast and polling, with expiry reported as a fail-closed `RpcTimeoutError` carrying `deadline: true` (#298).
- `signal` and `timeoutMs` on every framework adapter, forwarded to the pre-flight `check()`/`checkBatch()` — with a host invocation signal taking precedence where the hook exposes one (`guardMcpToolHandler`, the LangChain middleware, the Vercel AI tool wrapper) — plus the `AdapterMappingError` type describing a failed `toContractCall`/`toContractCalls` (#315).

### Changed

- Committed telemetry pages now share one ordering rule across `poll()`, `watch()`, and `watchAll()`: ledger ascending, then transaction hash, topic, and stable id as tie-breakers for same-ledger events. Diagnostic observation order is unchanged (#289).
- `GuardTelemetryListener` now rejects a concurrent `watch()`/`watchAll()` stream with `ConcurrentTelemetryStreamError` instead of letting two iterators race shared cursor, counter, and buffer state (#291).
- RPC calls are now bounded by default: `timeoutMs` defaults to `DEFAULT_RPC_TIMEOUT_MS` (30s) instead of waiting indefinitely. Pass `timeoutMs: 0` to restore the previous unbounded behaviour, or `signal` to cancel from your own runtime (#114).
- `recent()` on the telemetry listener and on `GuardEventRingBuffer` returns **detached snapshots**: the array, the events, their decoded `data`/`decision` and the opt-in `raw` payload are copies, so a consumer can no longer change the retained state by editing what it was handed (#344).
- A heartbeat that the guard **refuses** is now reported as a failed beat (a typed `HeartbeatBlockedError` through `onError`) instead of being counted as an accepted beat (#340).
- `invoke()` validates `retry`, `maxRetries`, `feeBump`, `pollAttempts`/`pollIntervalMs`, `timeoutMs` and `deadlineMs` before signing or any RPC, and rejects contradictory aliases with field-specific `RangeError`s. `maxRetries` now bounds the total attempts for every retryable class, not only fee bumps; a jitter sample outside `[0, 1)` is rejected instead of clamped (#296).
- `PreFlightInterceptor.checkBatch()` now fails closed when a required policy or committed-window read fails: positive SAC transfers whose staging state is unavailable are reported `undetermined` (batch `kind: "undetermined"`) instead of being staged against an assumed zero. An explicit `initialWindowSpent` (including `0n`) remains a trusted caller snapshot, and an absent `Window` entry still means zero committed spend (#336).
- `startHeartbeat()` skips stale cadence slots after a submission runs longer than one interval instead of firing the overdue backlog; each skipped slot is counted once in `missedBeats`, and the next beat waits for the next future deadline (#339).

### Deprecated

None.

### Removed

None.

### Fixed

- Framework adapters fail closed when `toContractCall`/`toContractCalls` throws or returns a malformed call: the handler never runs and the halt is reported as an `undetermined` decision with `AdapterMappingError` as the cause. Returning `null` (or an empty array) still means "not fund-moving" and passes the action through untouched (#316).
- Adapter observer hooks (`onDecision`, `onBlocked`) are isolated from their failures: a synchronous throw or a rejected promise is swallowed — reported to `blockedHookLogger` when one is supplied — so a failing sink can never resume a halted action, turn a pass into a refusal, or surface as an unhandled rejection (#313).
- `startHeartbeat()` now validates its inputs before the scheduler exists: a negative or non-finite `maxSkewMs`, a grace window that is not a non-negative safe integer or bigint, a callback that is not callable, and an unusable retry budget are all rejected with an error naming the field — before the first beat, and before the grace window is read from the chain (#341).
- `HeartbeatHandle.stop()` now requests cancellation of an in-flight submission through its context signal and can be bounded with `stop({ timeoutMs })` / `stopTimeoutMs`, so a custom transport that never settles can no longer hang shutdown indefinitely (#338).
- `PreFlightInterceptor.checkBatch()` no longer swallows a failed policy/window read and continue staging with zero spend; a required unavailable snapshot now yields an `undetermined` batch verdict (#336).

### Security

None.

## [0.1.0] - 2026-09-16

> **Pre-0.1.1 history is reconstructed.** This file did not exist when `0.1.0`
> shipped, so the entry below is the *publish record* — assembled from
> [`docs/publishing-history.md`](docs/publishing-history.md) and
> `npm view stellar-agent-guard-sdk` — not a per-change log. Per-change history
> starts with entries added under [Unreleased].

### Added

- Initial publication of `stellar-agent-guard-sdk` to the npm registry: pre-flight
  policy interception and guardrails for AI agents on Stellar Soroban smart accounts
  (registry package description).

### Changed

None.

### Deprecated

None.

### Removed

None.

### Fixed

None.

### Security

None.

> **Two facts about `0.1.0`, recorded rather than smoothed over:**
>
> 1. It was published **manually by the maintainer, outside the tag-triggered
>    `publish.yml` workflow** — no release tag or `publish` workflow run exists for
>    `0.1.0`. Known one-time deviation; see
>    [`docs/publishing-history.md`](docs/publishing-history.md).
> 2. `package.json` declares `0.1.1`, but when this entry was written the registry
>    reported `0.1.0` as the only published version (`latest` dist-tag), verified with
>    `npm view stellar-agent-guard-sdk versions time`. This changelog records what is
>    **actually on the registry**: `0.1.0`, on the date above. No `0.1.1` entry is
>    written until `0.1.1` is published.

[unreleased]: https://github.com/stellar-agent-guard/stellar-agent-guard-sdk/commits/main
[0.1.0]: https://www.npmjs.com/package/stellar-agent-guard-sdk/v/0.1.0
