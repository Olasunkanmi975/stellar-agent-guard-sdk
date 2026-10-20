# Guard event schema — verified against the live chain

Phase 2.2 exists because the contract's event schema had only ever been read from
documentation. This document records what the chain actually emits, captured from
the live Phase 2 instance, and reconciles it with the contracts repo's source.

## Compatibility contract: what a consumer may rely on

This document is the SDK's de-facto API contract for anything that parses guard
events outside this package — the dashboard's telemetry feed, an indexer, an
alerting rule. Every field in the reference table below carries one of four
stability tiers, and the tier is a promise about **minor releases of
`stellar-agent-guard-sdk`**. It is not a promise about the deployed contract,
which only moves when it is redeployed, and it is not a promise about the RPC,
which the SDK does not control.

| Tier | May change in a minor release | May not change |
| --- | --- | --- |
| **Stable** | Nothing without a documented breaking change and a migration note | The field's name, presence, type, and meaning |
| **Append-only** | New symbols or variants may appear | An existing symbol being re-spelled, re-meaning, or reused for a different case |
| **Best-effort** | Anything — the value is supplied by the host or the RPC, not by the SDK | (nothing: always keep a fallback) |
| **Internal** | Anything, without a release note | (nothing: not part of the surface; may be renamed or removed) |

Three rules follow from the tiers, and all three are already how this SDK
behaves:

1. **Tolerate unknown values of every append-only field.** Switch on them with a
   default. The listener applies the same rule one level down: an event whose
   name topic it does not recognise is dropped rather than guessed at
   (`interpret()` in `src/telemetry.ts` returns `null` for an unknown topic), so
   a new contract event does not surface to consumers until this SDK learns it.
2. **`null` is a real value on stream-dependent fields.** `ledger`,
   `ledgerClosedAt` and `transactionHash` are always `null` on the diagnostic
   stream, because a refusal never becomes a transaction — that is the
   pre-broadcast guarantee, not a missing value.
3. **Decode through the SDK, not by hand.** Raw topic lists arrive as XDR or as
   host-shaped objects and are Best-effort; the decoded `GuardEvent` is what the
   tiers below describe.

### Field reference

| Field | Produced by | Stability | Notes |
| --- | --- | --- | --- |
| `topic` (= topics[0]) | contract | **Stable** | Pinned to the chain-confirmed symbol (`event_auth_checked`, …), not to the SPEC's spelling — see the cross-check below. |
| topics[1] — decision result | contract | **Stable** | Closed set `allowed` \| `blocked`. |
| topics[2] — reason symbol | contract | **Append-only** | Empty symbol on an allowed decision; `decodeAuthDecision` normalises it to `null`. New reasons may be added; existing symbols keep their meaning. |
| `kind` | SDK | **Append-only** | New event kinds may appear. Unknown name topics never reach a consumer (rule 1). |
| `decision.result` | SDK (from topics[1]) | **Stable** | |
| `decision.reason` | SDK (from topics[2]) | **Append-only** | `string \| null`. Never re-spelled for the same condition. |
| `decision.source` | SDK | **Stable** | Closed set `ledger` \| `diagnostic`. |
| `source` | SDK | **Stable** | Same closed set as `decision.source`. |
| `stream` | SDK | **Stable** | `committed` \| `diagnostic`. Derived from `source`; present on every event. Additive (issue #67). |
| `contractId` | stream | **Best-effort** | May be `null`; the diagnostic stream only carries the contract the SDK was pointed at. |
| `ledger` | stream | **Best-effort** | `null` on the diagnostic stream; present only for committed events. |
| `ledgerClosedAt` | stream | **Best-effort** | Host-formatted timestamp; `null` on the diagnostic stream. |
| `observedAt` | SDK (unified stream) | **Best-effort** | ISO-8601 time `watchAll()` observed a diagnostic batch; `null` on the committed stream. Additive (issue #67). |
| `transactionHash` | stream | **Best-effort** | Always `null` on the diagnostic stream — a refusal has no transaction. |
| `data.at` (heartbeat) | contract payload | **Stable** | Unix seconds. Delivered as a string in JSON, normalised to `bigint` by the SDK to prevent >2^53 precision loss. |
| `data.by` (admin events) | contract payload | **Stable** | The acting admin address, for `event_initialized` / `event_frozen` / `event_unfrozen` / `event_policy_set` / `event_policy_revoked`. |
| `data` — any other key | contract / host | **Best-effort** | Not under SDK control. Left exactly as delivered: normalisation is schema-driven, so only the documented u64 fields below are converted (issue #276). |
| `raw` | SDK (opt-in) | **Best-effort** | The undecoded source event, attached only when the decode was asked for it (`includeRaw: true`, issue #94). Committed → the `rpc.Api.EventResponse` object from `getEvents`; diagnostic → the host-shaped object the RPC returned. **Absent** (undefined) otherwise, so the default path retains nothing. Its exact shape is host-supplied and may change in any release; decode the event, use `raw` only as bug-report evidence. |
| Raw topic list (undecoded XDR / `ScVal` objects) | RPC | **Best-effort** | Host-shaped. Decode with `topicSymbols()` / `decodeAuthDecision()`. |
| `contractEventsXdr` grouping | RPC | **Best-effort** | An array of *groups*, one per contract — reading it as a flat list silently loses events (see "The capture"). |
| `GUARD_EVENT_TOPICS` values | contract | **Stable** | The name-topic vocabulary. |
| `GUARD_REASON_CODES` numbers | contract | **Append-only** | Numeric codes are never renumbered and never reused; removed variants keep their number. |
| `describeGuardEvent()` text | SDK | **Internal** | A log line, not a format. Parse `GuardEvent`, not this string. |
| `poll()` `cursor` / `latestLedger` | RPC | **Best-effort** | Pagination is host-defined; treat as opaque. |
| `poll().unknownTopics` | SDK summary of contract topics | **Best-effort** | `{ topic: string; count: number }[]`, sorted by topic, for events the SDK did not recognise. No raw XDR or source payload. Additive (issue #287). |
| `serializeEvent()` output | SDK | **Stable** | Canonical JSON line. Fixed key order and normalization policy — see below. Unversioned; legacy records are v0. |
| `serializeEventRecord()` output | SDK | **Stable within `v: 1`** | Versioned envelope `{ "v": 1, "event": { … } }`. A new envelope version is a documented change; readers must branch on `v`, not assume the current one. |
| `PollResult.dropped` | SDK | **Append-only** | Per-page rejection counts: `unknownTopic`, `foreignContract`, `missingContractId`, `malformedContractId`. New reasons may be added. |

### Event data normalisation — by field, not by string shape (issue #276)

Only **documented u64 fields of a known event kind** are converted from their
JSON string form to `bigint`. The rule is a fixed schema lookup, never a
recursive "this string is all digits, so it must be a number" heuristic:

| event kind | documented u64 field | effect |
|---|---|---|
| `heartbeat` | `data.at` | `"1789393232"` → `1789393232n` |
| every other known kind | — | no conversions |
| `unknown` | — | payload returned untouched |

Consequences a consumer may rely on:

- A nested value is **not** normalised, even if its field name matches a
documented one. Only the documented top-level field is converted.
- A numeric-looking identifier on any other kind (for example a textual id of
`"12345"`) stays a string, so the public event shape no longer depends on the
payload's contents.
- The input payload is never mutated; `normalizeEventData()` returns a shallow
copy when a conversion applies and the original value otherwise.
- Already-`bigint` values are returned as they are, so a payload that arrived
through `scValToNative` is unaffected.

### Canonical JSON serialization — `serializeEvent()`

`serializeEvent(event: GuardEvent): string` renders one event as a single-line
canonical JSON string, for shipping to a log sink as JSON-lines:

```ts
logger.info(serializeEvent(event)); // one line per event
```

The rendering is deterministic: the same event always serializes byte-for-byte
the same, so a stored line can be diffed and a golden-string test can pin it
(`tests/unit/serialize-event.test.ts`). The projection is **explicit**, not an
object spread, so adding a field to `GuardEvent` cannot silently change the
serialized shape.

**Key order** — identity, then stream facts, then the decoded decision and data,
matching the field reference above:

```
id → kind → topic → source → stream → contractId → ledger → ledgerClosedAt
   → observedAt → transactionHash → decision → data
```

and, nested inside `decision` (which is `null` when the event carries no
decision):

```
result → reason → source
```

**Empty/absent fields — the drop-`undefined` policy:**
- A field whose value is `undefined` is **omitted** from the output. Absence is
  expressed by the key not being present.
- `null` is **kept**. It is a real value on the stream-dependent fields
  (`ledger`, `ledgerClosedAt`, `transactionHash`, `observedAt`, `decision`), not
  a missing value, so a consumer can still distinguish "no transaction" from "not
  serialized".
- Inside an **array**, an `undefined` element is rendered as `null`, so indices
  stay stable.

**Non-JSON-safe values** are normalized per this repo's policy (the same rules
`normalizeEventData` + `stableStringify` use for event identity):
- **`bigint` → decimal string.** `JSON.stringify` throws on a bigint, and the
  decoded `data.at` u64 arrives as one. Decimal (not the hashing form `…n`) is
  used so `JSON.parse` reads back an ordinary string.
- **`Uint8Array`/`Buffer` → `bytes:<hex>`**, the rendering `stableStringify`
  already uses.

**Round-trip:** `JSON.parse(serializeEvent(event))` is shape-equal to the input
modulo those normalizations — `bigint` becomes a decimal string, bytes become
`bytes:<hex>`, and `undefined` keys are absent.

`serializeEvent()` is a format; `describeGuardEvent()` remains **Internal** (a
log line, not a format), and the two are independent.

### Versioned event records — `serializeEventRecord()` (issue #323)

`serializeEvent()` is deliberately left byte-identical: its output is a
**Stable** contract, so adding a version field in place would silently change
what every existing JSON-lines consumer parses. Persisted records opt in to an
explicitly versioned envelope instead:

```ts
import { serializeEventRecord, parseEventRecord } from "stellar-agent-guard-sdk";

const line = serializeEventRecord(event);
// {"v":1,"event":{"id":"ledger:…","kind":"auth_checked",…}}

const { version, event } = parseEventRecord(line);
// version === 1; `event` is the same projection serializeEvent() emits.
```

- **Envelope:** `{ "v": <positive integer>, "event": <canonical event> }`, `v`
  first. `TELEMETRY_EVENT_RECORD_VERSION` is the current version (`1`).
- **Bare `serializeEvent()` output is legacy v0.** It has no top-level `v` key,
  so `parseEventRecord()` reports `version: 0` and returns the event unchanged.
  Older records therefore remain identifiable without rewriting them.
- **No silent break:** the `event` member is exactly the historical projection —
  same key order, same drop-`undefined`/keep-`null` policy, same `bigint` and
  byte normalization. A consumer can keep using its existing field parser on
  `record.event`.
- **JSON-safe:** the envelope is rendered through the same `toJsonSafe()` path
  as `serializeEvent()`, so a heartbeat's `bigint` `data.at` is a decimal string
  and `JSON.parse` reads the line back.
- **Newer records are surfaced, not guessed at:** `parseEventRecord()` returns a
  `v` newer than `TELEMETRY_EVENT_RECORD_VERSION` as-is so a caller can detect
  and route it; it does not reinterpret it. Malformed envelopes throw.

**Golden fixture:** `tests/fixtures/telemetry/event-record-v1.golden.json` pins
one complete v1 record; `tests/unit/serialize-event.test.ts` asserts the writer
matches it byte-for-byte. Bumping the envelope is a deliberate diff in that
fixture plus a migration note — not an incidental change.

**Migration note (v0 → v1):** no action is required for existing logs. A stored
bare line parses as `version: 0`; a new v1 line carries `v: 1` and the same
event fields under `event`. Readers that only understand bare records can keep
reading historical data; to read new data they should switch to
`parseEventRecord()` (or unwrap `event` after checking `v`).

### Emitting-identity validation before decode (issue #322)

`poll()` filters by contract at the RPC, but does **not** trust that filter. An
event is decoded only when it reports an emitting contract and that contract
canonicalises to the configured guard; otherwise it is dropped *before* the
topic vocabulary is examined. This is what stops a faulty or proxying RPC from
injecting another contract's guard-shaped topic into the guard's telemetry and
having it reported as a decision.

Handling is fail-closed and visible:

| RPC `contractId` | Handling | `PollResult.dropped` bucket |
| --- | --- | --- |
| A contract address equal to the guard | Decode | — |
| A contract address other than the guard | Drop | `foreignContract` |
| Missing / `null` / empty | Drop (identity unverifiable) | `missingContractId` |
| Present but not a contract address | Drop | `malformedContractId` |
| Recognised identity, unknown name topic | Drop (normal rule 1 above) | `unknownTopic` |

All four counters are zero on a fully attributable page, and the total is also
logged (`dropped`, with the breakdown in `droppedByReason`). The diagnostic and
failed-transaction streams already attributed only the configured guard's
events (`emittedByGuard`); this closes the same gap on the committed stream.

## How it was captured

`scripts/capture-event.ts` drives two real calls on the live Phase 2 instance
(`CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44`) and decodes every
event attributed to the guard:

1. an allowed `heartbeat()` — its events are committed ledger events, retrieved
   from `getTransaction(hash)`, which is the same stream a telemetry listener
   tails;
2. a per-tx-cap violation (`transfer` of 1100 against a 1000 cap) — a refused
   call never becomes a transaction, so its decision only exists as a
   *diagnostic* event on the failed enforced simulation.

Run: `node scripts/capture-event.ts`

## The capture

Real output, 2026-09-14, heartbeat tx
`74751b83d9ffdba3d9aea6b0c24cae866b536a802724085bb88bbeaa72f8d970`, ledger
`4673929`:

```json
[
  {
    "source": "ledger",
    "contract": "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
    "topics": ["event_auth_checked", "allowed", ""],
    "data": {}
  },
  {
    "source": "ledger",
    "contract": "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
    "topics": ["event_heartbeat"],
    "data": { "at": "1789393232" }
  },
  {
    "source": "diagnostic",
    "contract": "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
    "topics": ["event_auth_checked", "blocked", "per_tx_cap_exceeded"],
    "data": {}
  }
]
```

## Worked example — decoding real events end-to-end

This is the on-ramp the field reference above assumes you have already crossed: a
raw `getEvents` / simulation payload in, a decoded `GuardEvent` out, the reason
turned into an operator sentence. Two examples, because the guard emits into two
streams and only one of them is the ledger — see
[Consequence for the telemetry listener](#consequence-for-the-telemetry-listener).

### Example 1 — an allowed decision, committed to the ledger

**Raw payload.** A `getEvents` response for the guard, sliced to the two events a
single `heartbeat()` transaction emitted. Topic and value fields are the RPC's
base64 `ScVal`-XDR form, not decoded JSON.

- **Provenance:** transaction
  `74751b83d9ffdba3d9aea6b0c24cae866b536a802724085bb88bbeaa72f8d970`, ledger
  `4673929`, captured 2026-09-14 (the live capture recorded above). The topic XDR
  is the committed golden vocabulary for those symbols in
  [`tests/fixtures/contract-fixtures.json`](../tests/fixtures/contract-fixtures.json)
  (`allowed` → `AAAADwAAAAdhbGxvd2VkAA==`).

```json
{
  "events": [
    {
      "type": "contract",
      "ledger": 4673929,
      "ledgerClosedAt": "2026-09-14T18:20:32Z",
      "contractId": "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
      "txHash": "74751b83d9ffdba3d9aea6b0c24cae866b536a802724085bb88bbeaa72f8d970",
      "topic": [
        "AAAADwAAABJldmVudF9hdXRoX2NoZWNrZWQAAA==",
        "AAAADwAAAAdhbGxvd2VkAA==",
        "AAAADwAAAAA="
      ],
      "value": "AAAAEQAAAAEAAAAA"
    },
    {
      "type": "contract",
      "ledger": 4673929,
      "ledgerClosedAt": "2026-09-14T18:20:32Z",
      "contractId": "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
      "txHash": "74751b83d9ffdba3d9aea6b0c24cae866b536a802724085bb88bbeaa72f8d970",
      "topic": ["AAAADwAAAA9ldmVudF9oZWFydGJlYXQA"],
      "value": "AAAAEQAAAAEAAAABAAAADwAAAAJhdAAAAAAABQAAAABqp/lQ"
    }
  ],
  "cursor": "...",
  "latestLedger": 4673930,
  "oldestLedger": 4590000
}
```

**The call.** One page of the listener's loop decodes both events; you never
hand-parse the topics.

```ts
import { GuardTelemetryListener } from "stellar-agent-guard-sdk";

const listener = new GuardTelemetryListener({ server, guard: GUARD });
const page = await listener.poll({ startLedger: 4_673_929 });
const [decision, heartbeat] = page.events; // GuardEvent[]
```

**The decoded `GuardEvent`s.** Comments mark the fields that carry the stream's
meaning; the full field list with stability tiers is the reference table above.

```ts
decision;
// {
//   id: "ledger:74751b83…:event_auth_checked",   // stable id — see “Event identity”
//   kind: "auth_checked",
//   topic: "event_auth_checked",
//   source: "ledger",                  // stream discriminator: this event committed
//   contractId: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
//   ledger: 4673929,
//   ledgerClosedAt: "2026-09-14T18:20:32Z",
//   transactionHash: "74751b83d9ff…",
//   decision: { result: "allowed", reason: null, source: "ledger" },
//   data: {}
// }

heartbeat;
// {
//   id: "ledger:74751b83…:event_heartbeat",
//   kind: "heartbeat",
//   topic: "event_heartbeat",
//   source: "ledger",
//   ledger: 4673929,
//   decision: null,                     // only auth_checked carries a decision
//   data: { at: 1789393232n }           // unix seconds, from event data — not a topic
// }
```

The reason on that decision is `null`, not `""`: the chain sends the empty symbol
as topics[2] and the SDK normalises it (see "An allowed decision carries an empty
reason symbol" below). There is no explanation to look up for an allowed event —
`reason` is only meaningful on a block.

**Operator interpretation.** "The agent's heartbeat was authorised at ledger
4673929; the guard permitted it, so nothing was blocked and nothing was spent."

### Example 2 — a blocked decision, on the diagnostic stream

A refusal is never committed: the guard returns `Err`, the host rolls the event
back, so it is observable only as a diagnostic event on the failed enforced
simulation. That is why both streams matter.

**Raw payload.** A diagnostic event as the RPC attaches it to a failed
simulation — `event.body.v0.topics` is an array of `ScVal`s, and `event.body.v0.data`
is the (empty) data map.

- **Provenance:** the per-tx-cap violation (a `transfer` of 1100 against a 1000
  cap) from the live capture recorded above; the same topic XDR is committed in
  [`tests/fixtures/contract-fixtures.json`](../tests/fixtures/contract-fixtures.json)
  (`blocked_per_tx_cap_exceeded`).

```json
{
  "event": {
    "contractId": "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
    "type": "contract",
    "body": {
      "v0": {
        "topics": [
          "AAAADwAAABJldmVudF9hdXRoX2NoZWNrZWQAAA==",
          "AAAADwAAAAdibG9ja2VkAA==",
          "AAAADwAAABNwZXJfdHhfY2FwX2V4Y2VlZGVkAA=="
        ],
        "data": "AAAAEQAAAAEAAAAA"
      }
    }
  }
}
```

**The call.** `guardEventsFromDiagnostics` is the canonical entry point; it is
also what `telemetryFromDecision()` calls for you when you already hold a blocked
`PreFlightDecision`. Pass the guard address so the diagnostic `id` is scoped to
the right contract.

```ts
import { guardEventsFromDiagnostics, explainReason } from "stellar-agent-guard-sdk";

const [blocked] = guardEventsFromDiagnostics([diagnosticEvent], GUARD);
```

**The decoded `GuardEvent`.**

```ts
blocked;
// {
//   id: "diag:1f0c…",                // sha256 of the content — a block has no tx to anchor on
//   kind: "auth_checked",
//   topic: "event_auth_checked",
//   source: "diagnostic",            // stream discriminator: pre-broadcast, never committed
//   contractId: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
//   ledger: null,                    // a refusal has no ledger — this is a fact, not a gap
//   ledgerClosedAt: null,
//   transactionHash: null,
//   decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
//   data: {}
// }
```

**Explanation lookup and operator interpretation.**

```ts
explainReason(blocked.decision!.reason ?? "");
// "The transfer amount exceeds the policy's per-transaction cap."
```

"This means the transfer was blocked on the pre-tx cap at the moment of the
enforced simulation: a 1100-unit transfer against a 1000-unit cap. Nothing was
broadcast, so there is no ledger or transaction hash to point at (the `null`s
above), and the attempt is identified by its content hash, not a tx hash."

### Reading the stream discriminator

Both `event.source` and `event.decision.source` are the same closed set —
`"ledger" | "diagnostic"` (tier: **Stable**) — and they are the field to branch
on. Do not infer the stream from `ledger === null`: a committed event whose RPC
response omitted the retention fields is still `source: "ledger"`. This SDK has
not merged the two streams into one shape with a distinct `stream` field; the
discriminator today is `source` (the unified-stream follow-up is tracked in
[Event identity](#event-identity--guardeventid)'s scope note). The `id` prefix
agrees with it: `ledger:` for committed events, `diag:` for pre-broadcast ones.

## What this changed

The capture caught a real drift between the documentation and the chain, and a
real bug it had already caused in the SDK.

### 1. The decision topic is `event_auth_checked`, not `auth_checked`

`SPEC.md` §9 and `tests/fixtures/README.md` line 86 of the contracts repo describe
the decision event as `auth_checked`. The chain emits **`event_auth_checked`**,
because Soroban's `#[contractevent]` macro prepends `event_` to the struct name.
The contracts repo already records the real name elsewhere — its own fixture log
at `tests/fixtures/README.md` line 105 reads
`[Contract Event] topics: [event_auth_checked, blocked, per_tx_cap_exceeded]` —
so the two spellings coexist in that repo's own docs.

This was not cosmetic. `src/invoke.ts` matched `topics[0] === "auth_checked"`, so
it failed to recognise a genuine refusal and reported a real policy block as
`{ kind: "error" }` instead of `{ kind: "blocked", reason: "per_tx_cap_exceeded" }`.
The classifier was fixed to match the confirmed symbol; the vocabulary now lives
in one place, `src/events.ts`.

### 2. An allowed decision carries an empty reason symbol

On `allowed`, topic 2 is present and is the **empty symbol** `""` — not omitted.
`decodeAuthDecision` normalises it to `null` so an operator never sees `""` as a
reason.

### 3. A heartbeat's timestamp is event data, not a topic

`event_heartbeat` has exactly one topic (its name). The unix-second timestamp
arrives as event data: `data = { at: u64 }`, matching
`struct EventHeartbeat { at: u64 }` in `src/lib.rs`. Only the `EventAuthChecked`
struct marks its fields `#[topic]`.

### 4. Ledger events are grouped, and their contract id is raw

`tx.events.contractEventsXdr` is an array of **groups**, one per invoked contract,
and each group is itself an array of events. Reading it as a flat event list
yields one element that is an array and decodes to nothing — which is how the
first capture run silently lost the heartbeat. Each ledger event's `contractId` is
a bare `ContractId` (an opaque 32-byte hash whose `toString()` is not a strkey),
so it must be converted with `StrKey.encodeContract`.

## Confirmed against source

`stellar-agent-guard-contracts/src/lib.rs` defines the events with
`#[contractevent]`, which is why every emitted name carries the `event_` prefix:

| Struct                 | Emitted topic[0]       | Data            |
| ---------------------- | ---------------------- | --------------- |
| `EventAuthChecked`     | `event_auth_checked`   | `{ contract: Option<Address>, fn_name: Option<Symbol>, context_index: u32, revision: u64 }` |
| `EventHeartbeat`       | `event_heartbeat`      | `{ at: u64 }`   |
| `EventInitialized`     | `event_initialized`    | `{ by: Address }` |
| `EventFrozen`          | `event_frozen`         | `{ by: Address }` |
| `EventUnfrozen`        | `event_unfrozen`       | `{ by: Address }` |
| `EventPolicySet`       | `event_policy_set`     | `{ by: Address }` |
| `EventPolicyRevoked`   | `event_policy_revoked` | `{ by: Address }` |

The decision event's layout is `[event_auth_checked, <allowed|blocked>, <reason>]`
(`result` and `reason` are the struct's `#[topic]` fields). The reason vocabulary
is the same set of symbols `src/reasons.ts` mirrors from the contract's `Error`
enum.

Both the topic layout and the data payload are defined by the contracts repo's
own vocabulary fixture,
`stellar-agent-guard-contracts/tests/fixtures/auth-checked-vocabulary.json`
(contracts issue #42), which this SDK vendors at
`tests/fixtures/vendor/auth-checked-vocabulary.json` and asserts against in
`tests/unit/auth-checked-vocabulary.test.ts` — so the matrix is read from one
place rather than copied into this repository, and an outcome the contract adds
fails a test until the SDK's decoder knows about it.

The Phase 2 instance recorded in `tests/fixtures/integration-evidence.md`
predates that data payload and emits `{}` for the decision event. The SDK
decodes whatever the host carries, so both shapes are read correctly; the
table above describes the current contract source.

## Consequence for the telemetry listener

The listener (Phase 2.4) re-checks the emitting contract id before decoding
(see "Emitting-identity validation before decode") and then filters on
`event_auth_checked` and reads the decision
from topics, requiring no payload decoding. It must consume **both** streams:
committed ledger events for allowed decisions and administrative actions, and
enforced-simulation diagnostic events for blocked ones — because a refusal is
never committed, and a listener that only tails the ledger would see a guard that
appears to never block anything. `watchAll()` (see "Merged stream" below)
delivers exactly that union as one ordered iterator.

## Unknown event topics — observability without payloads

Unknown name topics are still **dropped, not guessed**: they never become a
`GuardEvent`, never enter the listener's buffer, and do not change delivery. But
silence should not be indistinguishable from a contract vocabulary change, and a
host may not have configured a logger to read the debug count. The listener
therefore exposes the decoded names and per-page counts as optional observability:

```ts
const page = await listener.poll({ startLedger });
for (const { topic, count } of page.unknownTopics) {
  alerting.unknownTopic(topic, count);
}

for await (const events of listener.watch({
  onUnknownTopics(unknownTopics) {
    // Called once per page that contains at least one unknown topic.
    for (const { topic, count } of unknownTopics) alerting.unknownTopic(topic, count);
  },
})) {
  // Known events only, exactly as before.
}
```

`unknownTopics` is sorted by topic and is empty when every event decoded. The
callback receives the same shape and is isolated: a throwing observability sink
cannot stop the stream, matching `onGap`. The summary contains only the decoded
name topic and its count — never the source event, its XDR, transaction hash, or
payload. This is additive; the default polling path and `GuardEvent` shape are
unchanged.

## Event identity — `GuardEvent.id`

Every `GuardEvent` the SDK decodes, on **both** streams, carries a non-null,
stable `id`. The two streams need different schemes, because they fail identity
in opposite ways: a committed event has a transaction to point at, while a
blocked one was rolled back before broadcast and has nothing on-chain to point
at.

| Source | Format | Anchor |
|---|---|---|
| `ledger` | `ledger:<txHash>:<topic>` | the transaction that emitted it, plus its name topic |
| `diagnostic` | `diag:<sha256-hex>` | the event's own content (see below) |

**Committed events keep a txHash-based id.** A heartbeat transaction emits
*two* guard events — `event_auth_checked` and `event_heartbeat`, as the live
capture above shows — so `ledger:<txHash>` alone is not unique and the name
topic disambiguates. The id deliberately does **not** include the event's
position within a `getEvents` page: a page boundary (a different `limit`, a
resume from a cursor) would otherwise renumber an event that has not changed.
If an RPC response ever omits the hash, the ledger sequence anchors instead, so
an id is always produced.

**Diagnostic events are hashed**, from exactly this input, in this order:

```
"diagnostic" | <contractId> | <simulationIndex> | <topic>… | <stable-data>
```

- `contractId` — the guard, so two guards cannot share an id for the same event;
- `simulationIndex` — the event's position within its diagnostic batch, which is
  what keeps **two distinct blocks in one simulation distinct** after both have
  been rolled back and neither has a transaction;
- the decoded topic symbols, separator-escaped, so two different topic lists can
  never flatten to the same string;
- the decoded data, rendered canonically (object keys sorted, `bigint` and byte
  arrays rendered explicitly) so re-encoding the same value always hashes the
  same.

### Collision notes

- **Same event, re-parsed → same id.** The hash is a pure function of the inputs
- **Two separate simulations, identical event → same id.** If the same guard is
  blocked for the same reason by two different attempts of the same call, both
  events hash identically. That is intentional: the content is the same
  decision. A consumer that needs per-attempt identity should combine `id` with
  its own attempt counter rather than expecting a unique key per refusal.
- **Within one batch, collisions are not a practical concern.** SHA-256 plus the
  distinct batch positions make two events sharing an id a cryptographic accident
  rather than a structural one.
- **Cross-stream ids never collide**: the prefixes differ, and a diagnostic id is
  hashed from the `diagnostic` stream name regardless of how the event was
  observed.

Part of #7 (stable ids + unified stream). The `id` field was the first slice;
the unified stream below (`watchAll()`, issue #67) is the second. Persistence for
the dashboard remains out of scope.

## Merged stream — `watchAll()`

`GuardTelemetryListener.watch()` tails committed ledger events only. That is a
trap for a telemetry consumer: a blocked decision is rolled back before
broadcast and never reaches a ledger, so a guard read through `watch()` alone
appears to approve everything (the motivating failure in #7).

`watchAll()` follows both streams as one iterator of `GuardEvent`:

```ts
for await (const event of listener.watchAll({
  startLedger,
  // Batches of guardEventsFromDiagnostics(...) / telemetryFromDecision(...),
  // in observation order.
  diagnostics: diagnosticBatches,
})) {
  if (event.stream === "diagnostic" && event.decision?.result === "blocked") {
    alerting.blocked(event.decision.reason);
  }
}
```

Every event carries a `stream` discriminator — `committed` for a ledger event,
`diagnostic` for a pre-broadcast one — so the loop above needs no knowledge of
the SDK's two-channel model. `source` remains and is unchanged; `stream` is its
alias in the merged vocabulary, and both are additive (`watch()` output gains the
fields, and nothing else about it moves).

### Ordering rule

- **Committed events are emitted in ledger order.** A page is sorted by `ledger`
  ascending before it is yielded (a missing ledger sorts last), and pages arrive
  in cursor order, so no committed event overtakes an earlier-ledger one.
- **Events on the same ledger use a stable tie-breaker.** They sort by
  transaction hash, then topic, then stable `id`, each ascending with a missing
  value last. Two entries that are still indistinguishable keep their input
  order. The same comparator is applied by `poll()`, `watch()` and `watchAll()`,
  so switching APIs cannot change committed-event order.
- **Diagnostic events are emitted when the batch carrying them is observed**,
  tagged with `observedAt` (ISO-8601; defaults to the merge time). A refusal has
  no ledger — it was rolled back before broadcast — so it is positioned at its
  point of observation relative to the committed events already drained, not by a
  ledger. A decision observed at time T appears after the committed events
  drained at or before T. Diagnostic batches are never re-sorted; their
  observation order is preserved exactly as supplied.

### De-duplication rule

`GuardEvent.id` (above) is the SDK's delivery key, and the merged stream emits
each id **at most once** — first observation wins. A guard decision is
single-homed: a blocked decision is rolled back and never committed, and an
allowed decision has no diagnostic, so one decision cannot arrive under two ids.
The duplicate the merge actually guards against is the *same id* delivered twice
— a re-fed diagnostic batch, or an overlapping committed page — which the
emitted-id set suppresses.

### `observedAt`

| Field | Type | Stability | Meaning |
| --- | --- | --- | --- |
| `observedAt` | `string \| null` | **Best-effort** | ISO-8601 time the unified stream observed a diagnostic batch. `null` on the committed stream, which carries `ledgerClosedAt` instead. |

## Coverage gaps — `GuardTelemetryGap`

A cursor is opaque, and Soroban RPC retains events for a bounded window, so a
listener that resumes after being offline may find the ledgers it needed have
been pruned. Silently skipping that range is the one failure a security monitor
must never have: an announced gap is operationally honest, an unnoticed one is
not.

### The rule (read from the RPC response, not inferred)

`getEvents` returns its retention window on **every** response — `oldestLedger`
and `latestLedger` (`Api.RetentionState` in `@stellar/stellar-sdk`). Coverage is
broken precisely when:

```
earliestLedgerTheListenerStillNeeds  <  response.oldestLedger
```

- On a fresh ledger range the earliest ledger needed is `startLedger`.
- Resuming from a stored cursor, it is `resumeLedger + 1`, where `resumeLedger`
  is the last ledger already consumed. A cursor is opaque, so the listener cannot
  derive that from the cursor itself — pass it explicitly. Without it no gap can
  be proven and none is reported.
- After each page, coverage advances to `latestLedger + 1` (or to one past the
  last event on a full, partial page), so a gap is reported once per
  discontinuity, never once per poll.

The rule is about the retention boundary, not event density. An empty page inside
the window is silence, not loss, so a sparse but fully-retained history raises no
false notice; and no event is ever fabricated for a pruned range — the range is
reported as a gap and the stream continues with real events only.

### Gap notice shape

| Field | Type | Stability | Meaning |
| --- | --- | --- | --- |
| `fromLedger` | `number` | **Stable** | First ledger that can no longer be retrieved (inclusive). |
| `toLedger` | `number` | **Stable** | Last ledger that can no longer be retrieved (inclusive). |
| `reason` | `"history_pruned"` | **Append-only** | Why coverage broke. New reasons may be added; switch with a default. |
| `retainedFromLedger` | `number` | **Best-effort** | `oldestLedger` of the response that detected the gap. |
| `retainedToLedger` | `number` | **Best-effort** | `latestLedger` of that same response. |

Delivery is the optional `watch({ onGap })` callback. Without it, behaviour is
unchanged and the listener stays silent. A throwing `onGap` is isolated — it
cannot break the stream (the same contract as `invoke()`'s `onStep`).

```ts
for await (const events of listener.watch({
  cursor: saved.cursor,
  resumeLedger: saved.ledger, // the last ledger already consumed
  onGap(gap) {
    alerting.coverageGap(gap.fromLedger, gap.toLedger, gap.reason);
  },
})) {
  /* ... */
}
```

### Consumer guidance

1. **Treat a gap as a fact, not a warning.** The `fromLedger..toLedger` range is
   unrecoverable *from this RPC* — it is no longer in its window.
2. **Alert an operator.** An unobserved range in a spend-policy monitor means
   decisions were made outside the monitor's view.
3. **Replay only from a durable checkpoint.** If you persist events (or a cursor)
   downstream, reconcile the gap against that store. If you do not, there is
   nothing to replay from — record the gap and move on rather than inventing the
   missing events.
4. **Do not read a gap as an authorization event.** It says "this range could not
   be observed", not "the guard allowed or blocked anything here".

## Cross-check: do the classifications match the code?

A stability table is only worth something if it describes what the code actually
does. This is the audit pass that produced the rows above, with what was checked
and what was found:

1. **Symbol drift found — one case, on the topic name.** `SPEC.md` §9 and
   `tests/fixtures/README.md` line 86 of the contracts repo name the decision
   event `auth_checked`; the chain emits **`event_auth_checked`**. The SDK's
   practice is to pin the *chain* spelling and deliberately reject the SPEC's
   (`decodeAuthDecision` matches `topics[0] === "event_auth_checked"` and
   returns `null` otherwise, so the un-prefixed spelling is never silently
   accepted). The table therefore classifies the chain symbol as Stable and
   treats the SPEC as the defect — reconciliation of that doc is tracked above as
   a follow-up for the contracts repo, and the same stale spelling survives in
   one code comment in `src/reasons.ts` (corrected in this change).
2. **No reason symbol has changed for the same numeric code.** Verified against
   `GUARD_REASON_CODES` in `src/reasons.ts`: the map is one code to one symbol,
   with no aliases and no normalisation of spellings anywhere in the decode path
   (`decodeAuthDecision` and `topicSymbols` compare exact strings, so a re-spelled
   symbol would surface as an unclassified event rather than as a quiet hit).
   The gaps in the numbering — there is no 6–9 and no 15–19 — are absent entries,
   i.e. numbers are vacated rather than reassigned, which is what "append-only"
   in the table is asserting.
3. **One SDK-level normalisation, documented rather than hidden.** On an allowed
   decision the contract emits the empty symbol `""` as topics[2];
   `decodeAuthDecision` maps it to `null`. That is an SDK guarantee (callers see
   `string | null`), not a contract change, and it is why `decision.reason` is
   typed that way in the table.
4. **Stream-dependent nulls are real, not bugs.** `diagnosticsToEvents()` sets
   `ledger`, `ledgerClosedAt` and `transactionHash` to `null` for every
   diagnostic event, because a refused call has no ledger and no transaction.
   The table classifies them Best-effort so a consumer never treats the absence
   as an error.
5. **Unknown topics are dropped, not guessed.** `interpret()` returns `null`
   when `topics[0]` is not in `KNOWN_TOPICS`, so a contract that starts emitting
   a new event produces *no* consumer-visible event until the SDK learns the
   symbol. This is the behaviour rule 1 above asks consumers to mirror.

## Follow-up for the contracts repo (maintainer)

The contracts repo's own documentation is internally inconsistent on this topic
name (`auth_checked` in `SPEC.md` §9 and `tests/fixtures/README.md` line 86,
`event_auth_checked` in its fixture logs and `docs/verification.md`). It is out of
scope for this repo to edit, but it should be reconciled there — the SPEC is the
document a third-party integrator reads first.

## Failed-transaction diagnostics (`stream: "failed_tx"`, issue #58)

### Spike result: the capability exists in the pinned SDK

A transaction can pass enforced pre-flight and still fail after inclusion — a
stale-ledger resource pricing race did exactly that (see
`tests/fixtures/integration-evidence.md`). Its Soroban auth events roll back
like a blocked simulation's, so `getEvents` never returns them, but unlike the
simulation path the RPC preserves them on the transaction itself. The spike
(inspected 2026-09-27) confirms the pinned SDK exposes this publicly, so issue
#58 was implemented as **Path A**, with no casts, no private internals, and no
new network client:

- **Pinned version:** `@stellar/stellar-sdk` **17.0.1**
  (`package.json`: `"^17.0.1"`; `package-lock.json` resolves exactly
  `17.0.1`, and the installed `node_modules` copy is `17.0.1`).
- **Public response type:** `Api.GetFailedTransactionResponse` declares
  `diagnosticEventsXdr?: DiagnosticEvent[]` —
  `node_modules/@stellar/stellar-sdk/lib/esm/rpc/api.d.ts:61`. The same field
  appears on `Api.TransactionInfo` (api.d.ts:154), which
  `Api.GetTransactionsResponse.transactions` carries. The element type is the
  public `xdr.DiagnosticEvent`
  (`lib/esm/xdr/generated/diagnostic-event.d.ts`), whose `event` is a
  `ContractEvent` with `body.v0.{topics,data}` as `ScVal`s.
- **Populated at runtime, not just declared:** `parseTransactionInfo` maps each
  base64 entry with `DiagnosticEvent.fromXdr(e, "base64")` for every
  `getTransaction`/`getTransactions` response that carries the field
  (`lib/esm/rpc/parsers.js:74`). `Api.RawGetTransactionResponse`
  (api.d.ts:106) documents the same field in its raw form.
- **The issue's spelling was wrong:** the field is `diagnosticEventsXdr`, not
  `diagnosicEvents` or `diagnosticEvents` — worth pinning here because a
  future reader will look for the issue's spelling first.
- **Discovery mechanism:** `rpc.Server.getTransactions` is public in 17.0.1
  (`lib/esm/rpc/server.d.ts:553`), with its own `cursor` returned in
  `Api.GetTransactionsResponse` (api.d.ts:147) and requested via
  `pagination: { cursor }` (`Api.GetTransactionsRequest`, api.d.ts:167).

### Semantics

A `failed_tx` GuardEvent is a diagnostic that **was** attached to a transaction:

- `stream: "failed_tx"`, `source: "diagnostic"` — it rolled back, so it is not
  a committed contract event. Existing `source` values and the events emitted
  by the pre-existing streams are unchanged; `stream` is purely additive.
- `transactionHash` and `ledger` are filled from the failed transaction (this
  is the only diagnostic stream that knows both); `ledgerClosedAt` stays null
  because the RPC returns `createdAt` as unix seconds here, not the ISO close
  time the field carries elsewhere.
- Decoding reuses the canonical engine (`interpret` + the `event_auth_checked`
  topic rules of `src/events.ts`); no separate decoder exists.

### How failed transactions are discovered, and cursor interaction

`GuardTelemetryListener` gains an **opt-in** `failedTx: boolean` (default
off — existing polling cadence, yields, and cursor behavior are untouched).
When enabled, each `watch` cycle runs a second, independent scan alongside the
committed `getEvents` poll:

- **Discovery:** `server.getTransactions` pages through *all* transactions by
  ledger, using its own cursor.
- **When `getTransaction`-class diagnostics are read:** for every page entry
  with `status: FAILED`, the listener reads `diagnosticEventsXdr`, keeps only
  diagnostics whose emitter contract equals the guard (XDR `ContractId` bytes
  → `StrKey.encodeContract`, the conversion `scripts/capture-event.ts`
  documents), and drops every other topic via the same `KNOWN_TOPICS` filter
  the other streams use — host `fn_call`/`core_metrics` noise is not surfaced.
- **Cursor interaction:** the two cursors are never exchanged. The committed
  `getEvents` cursor advances only from `getEvents` responses, exactly as
  before; the `getTransactions` cursor advances only from `getTransactions`
  responses. A failed_tx diagnostic therefore **cannot** be skipped because
  the events cursor moved: the tx stream is a different RPC method with a
  longer retention window, so a listener that was down or slow resumes from
  its own tx cursor and still retrieves the diagnostics. The committed cursor
  is never advanced by failed_tx processing.
- **Deduplication:** the transaction hash is the checkpoint identifier. A
  process-local set (trimmed oldest-first past 1,000 entries) suppresses
  re-emission when a page is re-read after an error mid-page, or when the
  scan resumes before the cursor moves. Across a listener restart the set is
  empty and the tx scan resumes from its cursor — an at-least-once delivery
  semantic, the same one the committed stream has when no cursor was
  persisted.
- **Durable cursor (issue #279):** the failed-tx scan has its own
  `failedTxCursorStore`, persisted independently of the committed stream's
  `cursorStore`. A restart resumes each stream from its own last confirmed
  page; one stream advancing (or failing) never moves the other's cursor.
  The two stores are never used as fallbacks for each other.

#### Retention and replay when no store is present

With no `failedTxCursorStore` (the default), the scan keeps its cursor in
process-local memory only for the lifetime of the listener object. A fresh
listener starts the scan at the **current RPC head**, so failed transactions
that occurred while the process was down are not replayed — they fall outside
the scan entirely. Once the scan has started, re-invoking `watch()` on the same
listener resumes from the in-memory cursor. A restart therefore has the same
at-least-once/lossy character the committed stream has without a
`cursorStore`: nothing is fabricated for the downtime, and a failure still
inside the RPC's `getTransactions` retention window is re-surfaced at most once
because the dedup set starts empty. Persist `failedTxCursorStore` when
downtime coverage matters.
- **Error handling:** a malformed diagnostic is skipped, not propagated; a
  failed `getTransactions` call leaves the tx cursor untouched so the page is
  retried, and never corrupts the committed stream (the scan runs inside its
  own try/catch in `watch`, matching `poll`'s skip-not-throw convention).

### Limitations

- **At-least-once, process-local dedup.** After a restart, a failed
  transaction still inside the tx stream's retention window may be re-surfaced
  once. Persisting `failedTxCursorStore` bounds the replay window to the last
  saved page; deduplication itself remains process-local, so exactly-once
  delivery is still not promised.
- **No Soroban ↔ in-ledger retention guarantee.** Soroban RPC prunes
  `getTransactions` history on its own schedule; a listener that is offline
  longer than that window will not see older failures.
- **Emission requires the emitter attribution.** A guard event whose emitter
  bytes cannot be attributed to the guard is not surfaced from the tx stream
  (the committed and simulation streams, which the RPC already scopes, are
  unaffected).
- **Test fixtures are typed reconstructions**, not live captures: built with
  the public `xdr.DiagnosticEvent`/`ContractEvent` constructors of 17.0.1 in
  the documented response shape, carrying the live-verified topic vocabulary.
  No real failed-auth transaction hash was available as evidence at
  implementation time (the live suite's blocks are all pre-broadcast, so they
  have no hash), and none is claimed.
