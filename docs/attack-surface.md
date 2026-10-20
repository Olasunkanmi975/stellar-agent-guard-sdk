# SDK attack-surface inventory

A map of where untrusted data enters this SDK, what leaves it, and which test
keeps the boundary honest. The goal is a security review that starts from this
page instead of re-discovering the entry points from the source tree.

This document is an **inventory, not a threat model**: what can go wrong, the
residual risk, and the on-chain backstop stay in
[`threat-model.md`](./threat-model.md). Read that for *why* a boundary is
trusted; read this for *where* it is and *what proves it*.

Every row cites the implementing file and the test that enforces the stated
behaviour. `tests/unit/attack-surface.test.ts` fails if a cited path stops
existing, so this inventory cannot silently rot.

## Summary

| Boundary | Untrusted input | Direction |
| --- | --- | --- |
| [Signer callbacks](#signer-callbacks) | operator-supplied functions and key material | inbound (call) |
| [Agent signing and auth digests](#agent-signing-and-auth-digests) | key forms, signatures, auth entries | in + out |
| [Simulation and pre-flight verdicts](#simulation-and-pre-flight-verdicts) | RPC simulation results, transaction envelopes | inbound |
| [Policy validation and decoding](#policy-validation-and-decoding) | on-chain `ScVal`, JSON policy files, schema | inbound |
| [RPC event data](#rpc-event-data) | `getEvents` / `getTransaction` / diagnostic payloads | inbound |
| [Telemetry outputs](#telemetry-outputs) | decoded events, counters, exports | outbound |
| [Logs](#logs) | host-supplied metadata | outbound |
| [Framework adapters](#framework-adapters) | agent tool calls, contract mappings, hooks | in + out |
| [Supply chain](#supply-chain) | dependency, published artifact, WASM hash | inbound |

## Signer callbacks

Agent signers are **host-supplied callbacks**: an operator hands the SDK a
function that signs a digest, and the SDK never holds the private key. Callbacks
are invoked by `invoke()`/`tx.ts`, and their failures surface as `SigningError`
rather than as an unsigned transaction.

| Field | Value |
| --- | --- |
| Implementing code | `src/tx.ts`, `src/invoke.ts` |
| Untrusted input | the signer callback, `signer.publicKey`, the digest passed to it |
| Public output | a signed `SorobanAuthorizationEntry` / transaction envelope |
| Fail-closed behaviour | a signer that throws or returns a bad signature aborts the pipeline before broadcast; an invalid `publicKey` throws `SigningError` at construction |
| Secret rule | the SDK never accepts or stores an `S...` secret seed as a signer identity — `validateAgentPublicKey()` rejects it with an explicit message. Private key material stays in the host's callback |
| Tests | `tests/unit/tx.test.ts`, `tests/unit/invoke.test.ts` |

## Agent signing and auth digests

The auth digest is the value the agent key actually authorises: a SHA-256 over
the Soroban authorization payload. `verifyAgentSignature()` re-derives it and
checks the Ed25519 signature before the SDK treats an auth entry as valid, so a
forged entry is rejected locally as well as by the host.

| Field | Value |
| --- | --- |
| Implementing code | `src/tx.ts` |
| Untrusted input | an auth entry, its signature (`BytesN<64>`), the claimed agent key |
| Public output | `true`/`false` from verification; the assembled envelope |
| Fail-closed behaviour | an unverifiable signature fails verification (no exception swallowed into "valid"); `assembleFromSimulation()` refuses to build an envelope from a failed simulation |
| Secret rule | only public key forms (`G...`/hex) are accepted; the digest is not logged |
| Tests | `tests/unit/tx.test.ts` |

## Simulation and pre-flight verdicts

`PreFlightInterceptor.check()` and `invoke()` convert an RPC simulation into a
verdict. The verdict is a **prediction**, so the SDK treats a failed or
unparseable simulation as `undetermined`/`blocked`, never as `admissible`.

| Field | Value |
| --- | --- |
| Implementing code | `src/preflight.ts`, `src/invoke.ts`, `src/cost.ts` |
| Untrusted input | `simulateTransaction` results, transaction XDR, resource/fee numbers, the RPC itself |
| Public output | `PreFlightDecision`, `InvokeOutcome`, fee estimates |
| Fail-closed behaviour | missing policy, unparseable check result, RPC error, or invalid call input yields `undetermined`/`blocked` — no error branch returns `admissible`. Call arguments are validated first (`validateContractCall()`) |
| Secret rule | no key material is read or logged; the enforced simulation carries the caller's signed auth entries but the SDK never inspects the private key |
| Tests | `tests/unit/preflight.test.ts`, `tests/unit/invoke.test.ts`, `tests/unit/cost.test.ts` |

## Policy validation and decoding

Policy data arrives from three places: the chain (`ScVal` read from the guard
account), a JSON file, and the schema. Each has its own decoder, and each
rejects what it cannot fully understand instead of filling in defaults.

| Field | Value |
| --- | --- |
| Implementing code | `src/policy.ts`, `src/policy-json.ts`, `src/policy-schema.ts` |
| Untrusted input | `ScVal` policy maps, policy JSON, schema annotations |
| Public output | `GuardPolicy`/`PolicyConfig`, validation failures |
| Fail-closed behaviour | a missing/extra/mistyped field throws `PolicyDecodeError`; integer fields are range-checked (`i128`/`u64` bounds); schema validation reports failures rather than coercing. A revision read failure bypasses the pre-flight cache instead of reusing a stale verdict |
| Secret rule | policies are public configuration — no secrets belong in them, and none are copied into telemetry |
| Tests | `tests/unit/policy.test.ts`, `tests/unit/policy-schema.test.ts` |

## RPC event data

Committed events, simulation diagnostics, and failed-transaction diagnostics all
become `GuardEvent`s. The RPC is not trusted to identify the emitter: identity
is re-checked before decoding, and unknown topics are dropped.

| Field | Value |
| --- | --- |
| Implementing code | `src/telemetry.ts`, `src/events.ts` |
| Untrusted input | `getEvents` pages, `diagnosticEventsXdr` on failed transactions, raw topic/data `ScVal`s |
| Public output | `GuardEvent`s, `PollResult.dropped` counts, `unknownTopics` summaries, coverage gaps |
| Fail-closed behaviour | a foreign or missing `contractId` is dropped before decode (`foreignContract`/`missingContractId`/`malformedContractId`); an unknown topic is dropped, not guessed; a single malformed diagnostic is skipped, never crashing the poll; the committed page is sorted deterministically |
| Secret rule | retrieval exposes only decoded topics and counts for unknown events — never raw XDR or the payload. `raw` retention is opt-in (`includeRaw`) and off by default |
| Tests | `tests/unit/telemetry.test.ts`, `tests/unit/telemetry-watch.test.ts`, `tests/unit/events.test.ts` |

## Telemetry outputs

| Field | Value |
| --- | --- |
| Implementing code | `src/telemetry.ts`, `src/index.ts` |
| Untrusted input | decoded events, plus anything a host put in an opt-in `raw` payload |
| Public output | `stats()`, `recent()`, `recentJsonLines()`, `health()`, `serializeEvent()` |
| Fail-closed behaviour | counters report `coverage.status` so a zero blocked count is distinguishable from "never observed"; snapshots are detached copies, so a consumer cannot mutate retained state; `counters`/`buffer` allocate nothing unless opted into |
| Secret rule | serialization uses a fixed field list, so an opt-in `raw` payload is never written to JSON Lines; log metadata is sanitized (binary payloads redacted, depth and cycles bounded) |
| Tests | `tests/unit/serialize-event.test.ts`, `tests/unit/telemetry-jsonlines.test.ts` |

## Logs

| Field | Value |
| --- | --- |
| Implementing code | `src/logger.ts` |
| Untrusted input | host-supplied logger and metadata objects |
| Public output | whatever the host logger writes |
| Fail-closed behaviour | `SILENT_LOGGER` is the default: nothing is written unless a logger is supplied. Metadata is sanitized before it reaches the sink |
| Secret rule | `Uint8Array`/`Buffer` values become `[redacted: binary payload]`; functions are dropped; depth and circular references are bounded, so an error object cannot leak a key or a whole envelope |
| Tests | `tests/unit/logger.test.ts` |

## Framework adapters

Adapters sit between an agent framework and the interceptor: LangChain
middleware, ElizaOS validators, a Vercel AI tool wrapper, and an MCP handler.
The framework's tool call is the untrusted input; the trusted output is a
decision or a blocked hook payload.

| Field | Value |
| --- | --- |
| Implementing code | `src/adapters/*.ts` |
| Untrusted input | tool-call arguments, host-supplied contract mappings, `onBlocked` hooks |
| Public output | allow/deny decisions, `GuardBlockedError`, hook payloads |
| Fail-closed behaviour | options are validated at construction (`AdapterConfigError` before the first call); an unmappable contract call fails closed instead of being passed through; a throwing observer hook is isolated so it cannot turn a block into an allow |
| Secret rule | blocked-hook payloads carry the decision, not the signed transaction or key material |
| Tests | `tests/unit/adapters.test.ts`, `tests/unit/adapter-conformance.test.ts`, `tests/unit/vercelai-adapter.test.ts` |

## Supply chain

| Field | Value |
| --- | --- |
| Implementing code | `package.json`, `src/wasm.ts` |
| Untrusted input | the single runtime dependency (`@stellar/stellar-sdk`), the published tarball, a deployed WASM hash |
| Public output | the published file set, `verifyGuardWasm()` result |
| Fail-closed behaviour | the published surface is a checked file set (`scripts/check-pack-contents.ts`) and the export map is exercised through a real resolver; a WASM hash mismatch fails verification |
| Secret rule | the package holds no credentials, reads no env vars at import time, and reaches no third-party telemetry endpoint |
| Tests | `tests/unit/wasm.test.ts`, `tests/unit/exports.test.ts` |

## Review and update procedure

This inventory is a **map of entry points**, so it changes when an entry point
changes — not on a schedule.

1. **When a PR adds or changes a public input or output** (a new option, a new
   RPC call, a new adapter hook, a new export), update the affected row in the
   same PR: implementing code, untrusted input, fail-closed behaviour, secret
   rule, and the test that covers it.
2. **When a boundary is removed**, delete the row. A stale row is worse than a
   missing one: it tells a reviewer a control exists after it stopped existing.
3. **When a test is renamed or moved**, update the citation. The unit test
   (`tests/unit/attack-surface.test.ts`) fails on a dangling path, so this is
   enforced rather than remembered.
4. **Before a release**, read the summary table top to bottom and confirm each
   row still names a live entry point. That is the whole review: do not
   re-derive threat scenarios here — that is `threat-model.md`'s job, and
   duplicating it is how the two documents drift apart.
5. **When `threat-model.md` gains a threat**, check whether it introduces a new
   boundary; if it does, add a row here and link the two.

The pass should take minutes, not hours. If it takes longer, the inventory has
fallen behind and the fix is to bring it current, not to write a longer
procedure.
