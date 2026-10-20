/**
 * Telemetry for the guard contract's events.
 *
 * The listener consumes **two** streams (plus an opt-in third, added in #58),
 * and this is the part that is easy to get wrong: a blocked decision never
 * reaches the ledger. The guard returns `Err`, which rolls the event back, so
 * a listener that only tails committed ledger events sees a contract that
 * appears to approve everything. The streams are:
 *
 *   1. **ledger events** — `server.getEvents`, filtered to the guard contract.
 *      Carries allowed decisions, heartbeats, and the admin lifecycle events.
 *   2. **simulation diagnostics** — attached to a failed *enforced simulation*.
 *      Carries blocked decisions, which by construction have no transaction.
 *   3. **failed-transaction diagnostics** (opt-in, `failedTx` option) —
 *      attached to a transaction that *was* broadcast, included in a ledger,
 *      and then failed on-chain. Its events roll back exactly like a blocked
 *      simulation's, but the RPC preserves them on the `getTransaction` /
 *      `getTransactions` response (`diagnosticEventsXdr`, public and typed in
 *      the pinned stellar-sdk 17.0.1 — see docs/event-schema.md for the spike
 *      evidence).
 *
 * The topic vocabulary is the one verified against the live chain in
 * `docs/event-schema.md`, not the one the contracts documentation describes.
 *
 * ## Stable ids (issue #33)
 *
 * Every decoded `GuardEvent` carries a non-null, stable `id`, because the two
 * streams fail identity in opposite ways: a committed event is anchored on a
 * transaction hash, while a blocked one has no ledger anchor at all (it was
 * rolled back before broadcast) and needs a synthetic id derived from its own
 * content. The format and the collision notes are documented in
 * `docs/event-schema.md` and implemented by `guardEventId` below.
 */
import { rpc, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { GuardError } from "./errors.ts";
import { GUARD_AUTH_RESULTS, GUARD_EVENT_TOPICS, decodeAuthDecision, normalizeEventData, type GuardAuthDecision } from "./events.ts";
import { bytesToHex, sha256Hex, utf8Length } from "./hash.ts";
import { topicSymbols } from "./invoke.ts";
import { resolveLogger, type GuardLogger, type GuardLoggerInput } from "./logger.ts";

/** The event name topics this SDK knows how to interpret. */
const KNOWN_TOPICS = new Set<string>(Object.values(GUARD_EVENT_TOPICS));

export type GuardEventKind =
  | "auth_checked"
  | "heartbeat"
  | "initialized"
  | "frozen"
  | "unfrozen"
  | "policy_set"
  | "policy_revoked"
  | "unknown";

const KIND_BY_TOPIC: Record<string, GuardEventKind> = {
  [GUARD_EVENT_TOPICS.authChecked]: "auth_checked",
  [GUARD_EVENT_TOPICS.heartbeat]: "heartbeat",
  [GUARD_EVENT_TOPICS.initialized]: "initialized",
  [GUARD_EVENT_TOPICS.frozen]: "frozen",
  [GUARD_EVENT_TOPICS.unfrozen]: "unfrozen",
  [GUARD_EVENT_TOPICS.policySet]: "policy_set",
  [GUARD_EVENT_TOPICS.policyRevoked]: "policy_revoked",
};

/** Where an event was observed. A blocked decision can only be `diagnostic`. */
export type GuardEventSource = "ledger" | "diagnostic";

/**
 * The stream discriminator on a `GuardEvent` (issue #67).
 *
 * `source` records the observation channel (`ledger` vs `diagnostic`); this
 * field states the same fact in the vocabulary a consumer of the **unified**
 * stream reads, so one `for await (const event of listener.watchAll())` loop can
 * tell a committed event from a pre-broadcast one without knowing the SDK's
 * two-channel model.
 */
export type GuardEventStream = "committed" | "diagnostic" | "failed_tx";

export interface GuardEvent {
  /**
   * Stable identity for this event, non-null on both streams.
   *
   * `ledger:<txHash>:<topic>` for a committed event; `diag:<sha256>` for a
   * diagnostic one, which has no transaction to anchor on. Derived by
   * `guardEventId`; see `docs/event-schema.md` for the format and collisions.
   */
  id: string;
  kind: GuardEventKind;
  /** The event's name topic, e.g. `event_auth_checked`. */
  topic: string;
  source: GuardEventSource;
  /**
   * Which of the listener's two streams produced this event, derived from
   * `source`: `ledger` → `committed`, `diagnostic` → `diagnostic`. Present on
   * every `GuardEvent` the SDK emits, including from `watch()`. Additive
   * (issue #67).
   */
  stream: GuardEventStream;
  /** The contract that emitted it, when the stream identifies one. */
  contractId: string | null;
  /** Ledger sequence, when the event was committed. */
  ledger: number | null;
  ledgerClosedAt: string | null;
  /**
   * When a diagnostic event was observed, ISO-8601. `null` on the committed
   * stream (which carries `ledgerClosedAt` instead) and on diagnostics read
   * straight off `diagnosticsToEvents`; `watchAll()` stamps it at the moment
   * the batch is merged in. Additive (issue #67).
   */
  observedAt: string | null;
  transactionHash: string | null;
  /** Present only for `auth_checked`. */
  decision: GuardAuthDecision | null;
  /** Decoded event data: `{ at }` for a heartbeat, `{ by }` for admin events. */
  data: unknown;
  /**
   * The undecoded source event, present only when the decode was asked for it
   * with `includeRaw: true` (issue #94). Absent — not merely `null` — otherwise,
   * so a runtime that does not want the payload does not retain it.
   *
   * The value is what was available at the decode site, which differs per
   * stream: a **diagnostic** keeps the host-shaped event object the RPC
   * returned (`{ event: { contractId, body: { v0: { topics: ScVal[], data } } }
   * }`), and a **ledger** event keeps the `rpc.Api.EventResponse` object from
   * `getEvents` (`topic: ScVal[]`, `value: ScVal`, `txHash`, …). Neither is a
   * base64 blob — the SDK never re-serialises it, so what a consumer files in a
   * bug report is the object the SDK actually saw.
   *
   * **Memory:** this holds a reference to the source payload (including its
   * `xdr.ScVal`s) for as long as the `GuardEvent` lives, and, when the listener's
   * ring buffer is enabled, for as long as that buffer retains the event. That is
   * why it is opt-in and off by default; turn it on for the debugging session or
   * the bug-report window, not for a long-running fleet.
   *
   * A snapshot handed out by `recent()` carries a **copy** of this payload
   * (issue #344), so editing the copy cannot corrupt the retained record. The
   * copy keeps the XDR values' prototypes, so `raw` still behaves like the
   * object the SDK actually saw.
   */
  raw?: unknown;
}

/**
 * Decode-time options shared by every entry point that produces `GuardEvent`s.
 */
export interface GuardEventDecodeOptions {
  /**
   * Opt-in retention of the undecoded source event on each decoded event's
   * `raw` field (issue #94). Default `false`: the raw payload is discarded as
   * soon as it has been decoded, which is the memory discipline the default
   * path has always had. When `false`, `raw` is absent (undefined) rather than
   * a copy of anything.
   *
   * Intended as a debugging affordance: when a decoded verdict looks wrong, the
   * raw event is what you attach to an SDK bug report. Pair it with
   * `guardEventsFromDiagnostics(events, guard, { includeRaw: true })` for offline
   * analysis of a captured simulation.
   */
  includeRaw?: boolean;
}

function decodeData(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  try {
    return scValToNative(value as xdr.ScVal) as unknown;
  } catch {
    return String(value);
  }
}

/** The stream facts an event's `id` is derived from. */
export interface GuardEventIdentityInput {
  source: GuardEventSource;
  /** Name topics in order, as decoded from the event. */
  topics: readonly string[];
  /** Decoded event data, exactly as it lands in `GuardEvent.data`. */
  data: unknown;
  /** The emitting guard, when the stream identifies one. */
  contractId: string | null;
  /** Ledger sequence, when committed; null on the diagnostic stream. */
  ledger: number | null;
  transactionHash: string | null;
  /**
   * Position of this event within the diagnostic batch it arrived in, or null
   * on the ledger stream. This is the component that keeps two *distinct*
   * blocks within one simulation from colliding.
   */
  simulationIndex: number | null;
}

/**
 * Stable identity for a guard event, usable as a delivery / de-duplication key.
 *
 * One format per stream, because the two fail identity in opposite ways:
 *
 * - `ledger:<txHash>:<topic>` — a committed event is anchored on the
 *   transaction that emitted it, plus its name topic. The topic is part of the
 *   id because a single transaction emits several guard events: a `heartbeat`
 *   call commits both `event_auth_checked` and `event_heartbeat` (see the live
 *   capture in `docs/event-schema.md`), so `ledger:<txHash>` alone is not
 *   unique. If an RPC response ever omits the hash, the ledger sequence
 *   anchors instead — an id is always produced.
 *
 * - `diag:<sha256>` — a blocked decision never reaches a ledger (the guard
 *   returns `Err`, the host rolls the event back), so there is nothing to
 *   anchor on and the id is derived from the event's own content: a SHA-256
 *   over the stream name, the guard address, the event's position within its
 *   diagnostic batch, the decoded topics and the decoded data. Re-parsing the
 *   same simulation therefore yields the same id, while two different blocks in
 *   one simulation get different ids because their positions differ.
 *
 * Collision notes: two *separate* simulations that produce an identical
 * diagnostic event for the same guard share an id. That is deliberate — the
 * content is the same decision — so a consumer needing per-attempt identity
 * should combine `id` with its own attempt counter instead of expecting a
 * unique key per refusal. Within one batch, SHA-256 plus the position makes
 * accidental collisions impossible in practice.
 */
export function guardEventId(event: GuardEventIdentityInput): string {
  if (event.source === "ledger") {
    const anchor =
      event.transactionHash ?? (event.ledger !== null ? String(event.ledger) : "unknown");
    return `ledger:${anchor}:${event.topics[0] ?? ""}`;
  }
  return `diag:${sha256Hex(diagnosticIdMaterial(event))}`;
}

/**
 * The exact string hashed into a diagnostic id, in a fixed order: stream, guard
 * address, position in batch, topics, data.
 *
 * Parts are length-prefixed rather than merely separated: a topic or a decoded
 * value that itself contains the separator must not be able to shift the field
 * boundaries and alias two different events onto one id. With framing, the
 * rendering is unambiguous for any input.
 */
function diagnosticIdMaterial(event: GuardEventIdentityInput): string {
  const parts = [
    "diagnostic",
    event.contractId ?? "",
    String(event.simulationIndex ?? -1),
    ...event.topics,
    stableStringify(event.data),
  ];
  return parts
    .map((part) => `${utf8Length(part)}:${part}`)
    .join("");
}

/**
 * A canonical rendering of decoded event data for hashing: object keys sorted
 * so key order cannot change an id, `bigint` and byte arrays rendered
 * explicitly (`scValToNative` yields `bigint` for u64, which `JSON.stringify`
 * throws on), and a depth cap so a pathological payload cannot build an
 * unbounded string.
 */
function stableStringify(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value instanceof Uint8Array) return `bytes:${bytesToHex(value)}`;
  if (depth >= 8) return "depth";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, depth + 1)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item, depth + 1)}`)
    .join(",")}}`;
}

/**
 * The stream facts known at decode time, before the event's `id` is derived
 * from them.
 */
export type GuardEventContext = Omit<
  GuardEvent,
  "kind" | "topic" | "id" | "decision" | "data" | "observedAt"
> & {
  /** Position within the diagnostic batch; null on the ledger stream. */
  simulationIndex: number | null;
  /**
   * Observation time for a diagnostic event; omitted (→ `null`) on the
   * committed stream, which anchors on `ledgerClosedAt` instead.
   */
  observedAt?: string | null;
};

/** Interpret an already-decoded topic list plus data as a `GuardEvent`. */
function interpret(
  topics: string[],
  data: unknown,
  context: GuardEventContext,
): GuardEvent | null {
  const topic = topics[0];
  if (!topic || !KNOWN_TOPICS.has(topic)) return null;
  const { simulationIndex, observedAt, ...streamFacts } = context;
  const kind = KIND_BY_TOPIC[topic] ?? "unknown";
  return {
    kind,
    topic,
    id: guardEventId({
      source: streamFacts.source,
      contractId: streamFacts.contractId,
      ledger: streamFacts.ledger,
      transactionHash: streamFacts.transactionHash,
      topics,
      data,
      simulationIndex,
    }),
    ...streamFacts,
    stream: streamFacts.stream,
    observedAt: observedAt ?? null,
    decision: decodeAuthDecision(topics, context.source),
    // Normalisation is schema-driven (#276): only the documented u64 fields of
    // this kind are converted, so a numeric-looking identifier stays a string.
    data: normalizeEventData(data, kind),
  };
}

/**
 * Canonical converter from raw simulation diagnostic events to GuardEvents.
 *
 * Both `guardEventsFromDiagnostics` and `telemetryFromDecision` delegate to this
 * canonical decode engine to ensure unified field extraction and prevent divergence.
 */
export function diagnosticsToEvents(
  diagnosticEvents: readonly unknown[],
  guard?: string,
  options?: GuardEventDecodeOptions,
): GuardEvent[] {
  const includeRaw = options?.includeRaw === true;
  const out: GuardEvent[] = [];
  for (const [index, raw] of diagnosticEvents.entries()) {
    const bare = (raw as { event?: unknown }).event ?? raw;
    const topics = topicSymbols(bare);
    if (topics.length === 0) continue;
    const decoded = interpret(topics, decodeData(dataOf(bare)), {
      source: "diagnostic",
      stream: "diagnostic",
      contractId: guard ?? null,
      ledger: null,
      ledgerClosedAt: null,
      transactionHash: null,
      // The position within this batch is what keeps two blocked decisions from
      // one simulation apart once both are rolled back and neither has a hash.
      simulationIndex: index,
      // The host-shaped wrapper is the source object here, not `bare`: it is
      // exactly what the RPC returned and what a bug report needs to include.
      ...(includeRaw ? { raw } : {}),
    });
    if (decoded) out.push(decoded);
  }
  return out;
}

/**
 * Normalise the contract events attached to a failed enforced simulation.
 *
 * This accepts raw diagnostic events (e.g. from an RPC simulation failure) and
 * converts them to GuardEvents via canonical `diagnosticsToEvents`.
 *
 * This is the only place a *blocked* decision is observable, and it is reached
 * by passing a `PreFlightDecision`'s or an `invoke()` block's diagnostic events
 * through: no ledger query can return them.
 */
export function guardEventsFromDiagnostics(
  diagnosticEvents: readonly unknown[],
  guard?: string,
  options?: GuardEventDecodeOptions,
): GuardEvent[] {
  return diagnosticsToEvents(diagnosticEvents, guard, options);
}

/**
 * Decode the guard events carried by a failed on-chain transaction.
 *
 * A transaction can pass enforced pre-flight and still fail after inclusion
 * (stale resource pricing, a race the simulation could not see). Its Soroban
 * auth events roll back exactly like a blocked simulation's — but unlike the
 * simulation path, the RPC preserves the diagnostics: `getTransaction` and
 * `getTransactions` attach `diagnosticEventsXdr` to a FAILED response. That is
 * a public, typed field of the pinned stellar-sdk 17.0.1
 * (`Api.GetFailedTransactionResponse` — spike evidence in
 * `docs/event-schema.md`); nothing here reaches into SDK internals.
 *
 * The `auth_checked` decoding is deliberately the *same* one the simulation
 * path uses (this delegates to the canonical `interpret` engine): the contract
 * emits the identical event schema in both contexts. Only the markers differ —
 * the event keeps `source: "diagnostic"` (it rolled back; it is not a
 * committed contract event) and gains `stream: "failed_tx"` plus the failed
 * transaction's hash and ledger. `ledgerClosedAt` stays null: the RPC returns
 * `createdAt` as unix seconds here, not the ISO close time this field carries
 * elsewhere, and re-formatting it is this module's business only once there is
 * a consumer that needs it.
 *
 * Accepts the structural subset of either response type (`GetFailedTransactionResponse`
 * from `getTransaction`, `TransactionInfo` from `getTransactions`), so the
 * listener and direct callers share one decoder.
 */
export function guardEventsFromFailedTransaction(
  tx: Pick<
    rpc.Api.GetFailedTransactionResponse,
    "txHash" | "ledger" | "createdAt" | "diagnosticEventsXdr"
  >,
  guard?: string,
): GuardEvent[] {
  const out: GuardEvent[] = [];
  for (const [index, raw] of (tx.diagnosticEventsXdr ?? []).entries()) {
    const bare = (raw as { event?: unknown }).event ?? raw;
    const topics = topicSymbols(bare);
    if (topics.length === 0) continue;
    const decoded = interpret(topics, decodeData(dataOf(bare)), {
      source: "diagnostic",
      stream: "failed_tx",
      contractId: guard ?? null,
      ledger: tx.ledger,
      ledgerClosedAt: null,
      transactionHash: tx.txHash,
      // Position within this transaction's diagnostic batch, so two identical
      // events in one failed transaction cannot share a content-derived id.
      simulationIndex: index,
    });
    if (decoded) out.push(decoded);
  }
  return out;
}

function dataOf(raw: unknown): unknown {
  const candidate = raw as {
    body?: unknown;
    event?: { body?: unknown };
  };
  const body = (candidate.event?.body ?? candidate.body) as
    | { v0?: { data?: unknown }; value?: { v0?: { data?: unknown } } }
    | undefined;
  return body?.v0?.data ?? body?.value?.v0?.data;
}

/**
 * Canonicalise a contract address supplied by the RPC, or return null when it is
 * absent/malformed.
 *
 * Identity is compared in canonical `C...` form rather than as an opaque
 * string: an RPC that upper/lower-cases or pads the field must not be able to
 * slip a foreign event past the check, and a value that is not a contract
 * strkey at all is not something this SDK can attribute to a guard (#322).
 */
function canonicalContractId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    return StrKey.encodeContract(StrKey.decodeContract(trimmed));
  } catch {
    return null;
  }
}

/** True only when the diagnostic's emitting contract is this guard. */
function emittedByGuard(raw: unknown, guard: string): boolean {
  const bare = (raw as { event?: unknown }).event ?? raw;
  const contractId = (bare as { contractId?: xdr.ContractId | null }).contractId;
  if (!contractId) return false;
  try {
    return StrKey.encodeContract(contractId.toBytes()) === guard;
  } catch {
    return false;
  }
}

/**
 * Opt-in retention of the most recent events, so a consumer can answer "what
 * did the guard decide just now?" without standing up its own store (issue #68).
 *
 * Off by default: an embedded agent runtime should not pay for a buffer it never
 * reads. Non-durable by construction — the buffer lives in process memory, so a
 * restart empties it. Persistence, if needed, is a cursor store (its own issue),
 * not something this buffer pretends to provide.
 */
export interface GuardEventBufferOptions {
  /** How many of the most recent events to keep. Must be a positive integer. */
  max: number;
}

/**
 * The filter surface of `recent()`, deliberately small.
 *
 * `stream` and `reason` are the useful selectors ("show me blocked decisions",
 * "show me refusals for this reason"); `fromLedger`/`toLedger` narrow to a
 * ledger range. Kept to these four so the accessor stays a snapshot, not a
 * query engine: a consumer that needs more should keep its own store with the
 * full event stream.
 */
export interface RecentEventFilter {
  /** Only events observed on this stream. */
  stream?: GuardEventStream;
  /** Only events whose decoded decision reason equals this code. */
  reason?: string;
  /** Only events at or after this ledger (committed events only). */
  fromLedger?: number;
  /** Only events at or before this ledger (committed events only). */
  toLedger?: number;
}

/** True when an event satisfies every field set in `filter`. */
function matchesRecentFilter(event: GuardEvent, filter: RecentEventFilter): boolean {
  if (filter.stream !== undefined && event.stream !== filter.stream) return false;
  if (filter.reason !== undefined && event.decision?.reason !== filter.reason) return false;
  // A diagnostic event has no ledger; a ledger bound therefore excludes it,
  // rather than silently treating `null` as "inside the range".
  if (filter.fromLedger !== undefined && (event.ledger === null || event.ledger < filter.fromLedger)) {
    return false;
  }
  if (filter.toLedger !== undefined && (event.ledger === null || event.ledger > filter.toLedger)) {
    return false;
  }
  return true;
}

/**
 * Deep-copy one value so a snapshot cannot be mutated through the copy
 * (issue #344).
 *
 * The copy is *structural*, not a re-serialisation:
 *
 * - objects and arrays are rebuilt, so a nested field cannot be reached
 *   through the copy and written back into the retained event;
 * - byte arrays are copied, so a byte written into the copy does not land in
 *   the source buffer;
 * - a class instance keeps its prototype, so an XDR value inside an opt-in
 *   `raw` payload still answers `value`/`toXdr()` like the value it was;
 * - cycles are handled through `seen`, because a `raw` payload is
 *   host-supplied and this function must not hang on a self-referential one.
 *
 * Primitives (including `bigint`) are returned as they are: there is nothing
 * to detach, and the decoded data of most events is exactly that.
 */
function detachValue<T>(value: T, seen: WeakMap<object, unknown>): T {
  if (value === null || typeof value !== "object") return value;
  const source = value as unknown as object;
  const existing = seen.get(source);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(source, copy);
    for (const item of value) copy.push(detachValue(item, seen));
    return copy as unknown as T;
  }
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    seen.set(source, copy);
    return copy as unknown as T;
  }
  if (value instanceof Uint8Array) {
    // `new Uint8Array(view)` copies the bytes; it does not alias the source.
    const copy = new Uint8Array(value);
    seen.set(source, copy);
    return copy as unknown as T;
  }
  if (value instanceof ArrayBuffer) {
    const copy = value.slice(0);
    seen.set(source, copy);
    return copy as unknown as T;
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    seen.set(source, copy);
    for (const [key, item] of value) {
      copy.set(detachValue(key, seen), detachValue(item, seen));
    }
    return copy as unknown as T;
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>();
    seen.set(source, copy);
    for (const item of value) copy.add(detachValue(item, seen));
    return copy as unknown as T;
  }
  // A plain object or a class instance: rebuild it with the same prototype, so
  // an XDR value keeps its methods instead of degrading into a bare object.
  const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  seen.set(source, copy);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = detachValue(item, seen);
  }
  return copy as unknown as T;
}

/**
 * A detached snapshot of one event (issue #344).
 *
 * The event object, its decoded `decision`, its decoded `data` and the opt-in
 * `raw` payload are all copied, so a consumer that mutates what `recent()`
 * handed it cannot reach the event the buffer still retains.
 *
 * `seen` is shared by every event of one snapshot, so a value two events point
 * at stays one value in the snapshot too — the copy mirrors the retained
 * structure instead of quietly splitting it.
 */
function detachEvent(event: GuardEvent, seen: WeakMap<object, unknown>): GuardEvent {
  const copy: GuardEvent = {
    ...event,
    decision: event.decision === null ? null : detachValue(event.decision, seen),
    data: detachValue(event.data, seen),
  };
  // `raw` is absent — not `null` — unless the decode asked for it, and that
  // distinction is part of the documented contract.
  if (event.raw !== undefined) copy.raw = detachValue(event.raw, seen);
  return copy;
}

/**
 * A fixed-capacity FIFO ring of the most recent `GuardEvent`s (issue #68).
 *
 * O(1) push with no allocation after construction: the backing array is
 * allocated once at `max` and reused, so a long-running agent does not grow the
 * heap with telemetry it already decided to keep only a window of. Once full,
 * each push overwrites the oldest slot; `recent()` always returns events in
 * observation order (oldest first).
 */
export class GuardEventRingBuffer {
  readonly max: number;
  private readonly slots: GuardEvent[];
  /** Index of the oldest retained event. */
  private start = 0;
  /** Number of live slots, `0..max`. */
  private count = 0;

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`buffer.max must be a positive integer, received ${max}`);
    }
    this.max = max;
    this.slots = new Array<GuardEvent>(max);
  }

  /** Append an event, evicting the oldest once `max` is reached. */
  push(event: GuardEvent): void {
    const index = (this.start + this.count) % this.max;
    this.slots[index] = event;
    if (this.count < this.max) {
      this.count += 1;
    } else {
      // Full: the write above landed on the oldest slot, so advance past it.
      this.start = (this.start + 1) % this.max;
    }
  }

  /** True when no events are retained (e.g. nothing observed yet). */
  get size(): number {
    return this.count;
  }

  /**
   * The retained events in observation order, optionally narrowed by `filter`.
   *
   * Returns **detached snapshots** (issue #344): a fresh array, and a fresh
   * copy of every event in it — including the nested decoded `data`, the
   * decoded `decision`, and the opt-in `raw` payload. Mutating what this
   * returns can therefore never change what the ring still retains, and a
   * later `recent()` reports the retained event, not the consumer's edit.
   *
   * The copy is per call, not per event: the ring itself keeps the original
   * event objects, so the cost is paid only by a caller that actually reads a
   * snapshot — and a listener with no buffer configured never allocates one at
   * all.
   */
  recent(filter?: RecentEventFilter): GuardEvent[] {
    const out: GuardEvent[] = [];
    const seen = new WeakMap<object, unknown>();
    for (let i = 0; i < this.count; i += 1) {
      const event = this.slots[(this.start + i) % this.max]!;
      if (!filter || matchesRecentFilter(event, filter)) out.push(detachEvent(event, seen));
    }
    return out;
  }
}

export interface GuardTelemetryConfig {
  server: rpc.Server;
  /** The guard contract to follow. */
  guard: string;
  /** Opt in to scanning failed transaction diagnostics as a third stream. */
  failedTx?: boolean;
  /** RPC URL, only used for error messages. */
  rpcUrl?: string;
  /**
   * Optional log sink for this listener's diagnostics: a summary of every page
   * received (with how many events were dropped as unrecognised), a coverage
   * gap, and a poll that failed or was aborted.
   *
   * Omitted — the default — the listener says nothing at all.
   */
  logger?: GuardLoggerInput | undefined;
  /**
   * Opt-in sliding-window counters over allowed/blocked decisions (issue #68).
   * Omitted → no counter state is allocated and `stats()` returns `null`.
   */
  counters?: GuardTelemetryCountersOptions;
  /**
   * Clock the counters consult for `windowMs` eviction. Defaults to
   * `Date.now`; injectable so tests need no wall-clock waits.
   */
  clock?: (() => number) | undefined;
  /**
   * Opt-in: retain the most recent events for `recent()` snapshots (issue #68).
   * Omitted → no buffer is allocated and `recent()` always returns `[]`.
   */
  buffer?: GuardEventBufferOptions;
  /**
   * Opt-in: attach the raw `rpc.Api.EventResponse` to every committed event
   * decoded by `poll()`/`watch()`/`watchAll()` (issue #94). Default `false`.
   *
   * Diagnostic events decoded by the caller (`guardEventsFromDiagnostics` /
   * `telemetryFromDecision`) take their own `includeRaw` option, so the two
   * halves of the unified stream are independent: a consumer can retain the raw
   * payload for the committed feed, the diagnostic feed, or both.
   *
   * Memory: see `GuardEvent.raw`.
   */
  includeRaw?: boolean;
  /**
   * Opt-in: a cursor store adapter that persists the watch cursor across
   * listener restarts. Without one, a restart resumes from the head (skipping
   * events emitted while the process was dead) or replays history (if
   * `startLedger` is used).
   */
  cursorStore?: CursorStore;
  /**
   * Opt-in: a **separate** cursor store for the failed-transaction scan
   * (issue #279). The two streams are persisted independently, so a restart
   * resumes each from its own last confirmed page and neither can skip the
   * other's progress.
   *
   * Omitted → the failed-tx scan uses its own process-local
   * `InMemoryCursorStore`, which preserves the cursor while the listener object
   * lives but not across a restart. `cursorStore` is never used as a fallback:
   * mixing the two streams' cursors would replay or skip failed transactions.
   */
  failedTxCursorStore?: CursorStore;
}

/**
 * Per-page count of events the listener refused to decode (#322).
 *
 * Identity is checked *before* decoding: an event is only interpreted when the
 * RPC reports an emitting contract and that contract is the configured guard.
 * A page from a faulty or proxying RPC therefore cannot inject another
 * contract's guard-shaped topic into this guard's telemetry. The split exists
 * so "the guard was quiet" is distinguishable from each rejection reason.
 */
export interface GuardEventDropCounts {
  /** Events whose name topic this SDK version does not know. */
  unknownTopic: number;
  /** Events emitted by a contract other than the configured guard. */
  foreignContract: number;
  /** Events whose `contractId` the RPC omitted — identity cannot be verified. */
  missingContractId: number;
  /** Events whose `contractId` was present but is not a contract address. */
  malformedContractId: number;
}

/**
 * One name topic on a committed page that this SDK version does not recognise.
 *
 * Only the decoded topic text and its count are exposed. The source event, its
 * raw XDR, and its payload are deliberately not retained or reported.
 */
export interface GuardUnknownTopic {
  /** The event's name topic as decoded text; empty when the event carried none. */
  topic: string;
  /** How many events on this page carried that name topic. */
  count: number;
}

export interface PollResult {
  events: GuardEvent[];
  /** Cursor to resume from, as returned by the RPC. */
  cursor: string;
  latestLedger: number;
  /**
   * Why this page's events were dropped, by reason (#322). All four counts are
   * zero on a page where every event was attributable to the guard.
   */
  dropped: GuardEventDropCounts;
  /**
   * Oldest ledger the RPC still retains, from the same response
   * (`Api.RetentionState.oldestLedger`).
   *
   * `null` when the host did not report it. Gap detection is skipped in that
   * case rather than guessed at: a proof needs the boundary.
   */
  oldestLedger: number | null;
  /**
   * Unknown name topics on this page, sorted by topic, with per-page counts.
   *
   * Empty when every event decoded. These events stay out of `events` and are
   * never added to the listener's buffer; this summary contains no raw XDR or
   * event payload. Additive (issue #287).
   */
  unknownTopics: GuardUnknownTopic[];
}

/**
 * Why event coverage is known to have broken.
 *
 * Only one reason is produced today, and it is deliberately the *provable* one:
 * the RPC's own retention window moved past the listener, so the missing ledgers
 * can no longer be retrieved from it. See `docs/event-schema.md` for the rule.
 */
export type GuardTelemetryGapReason = "history_pruned";

/**
 * A provable gap in event coverage: a ledger range whose events are gone.
 *
 * `fromLedger..toLedger` (inclusive) is unrecoverable from the RPC that reported
 * it. The listener never fabricates events for the range — it announces the hole
 * and keeps streaming real events, because a silent gap in a security monitor is
 * worse than an announced one.
 */
export interface GuardTelemetryGap {
  /** First ledger that can no longer be retrieved (inclusive). */
  fromLedger: number;
  /** Last ledger that can no longer be retrieved (inclusive). */
  toLedger: number;
  reason: GuardTelemetryGapReason;
  /** `oldestLedger` of the response that detected the gap. */
  retainedFromLedger: number;
  /** `latestLedger` of that same response. */
  retainedToLedger: number;
}

/**
 * The state of the listener's committed-event stream, as reported by
 * `health()` (issue #286).
 *
 * - `idle` — no `watch()`/`watchAll()` has run yet.
 * - `running` — the last poll succeeded and the stream is advancing.
 * - `recovering` — a poll failed and the bounded retry envelope is in progress.
 * - `stopped` — the stream completed without an abort or a terminal failure.
 * - `aborted` — the caller's `signal` ended the stream.
 * - `failed` — the retry envelope was exhausted; `lastError` is set.
 */
export type GuardTelemetryStreamState =
  | "idle"
  | "running"
  | "recovering"
  | "stopped"
  | "aborted"
  | "failed";

/** A point-in-time, read-only snapshot of listener health (issue #286). */
export interface GuardTelemetryHealthSnapshot {
  /** The committed stream's state. */
  state: GuardTelemetryStreamState;
  /** Which entry point drove the last stream, if any. */
  stream: "watch" | "watchAll" | null;
  /** When the last stream started, ISO-8601; null before the first run. */
  startedAt: string | null;
  /** When the last committed poll succeeded, ISO-8601; null before the first. */
  lastSuccessfulPollAt: string | null;
  /** `latestLedger` of the last successful committed poll, or null. */
  lastSuccessfulPollLedger: number | null;
  /** Failed committed polls since the last success (0 while healthy). */
  consecutiveFailures: number;
  /**
   * The terminal error that ended the most recent stream, rendered as a
   * message plus the time it was recorded. A copy: the listener's own error is
   * not reachable through this snapshot (use `getLastError()` for the value).
   */
  lastError: { message: string; at: string } | null;
  /** The cursor each stream has confirmed, so progress is inspectable. */
  cursors: { committed: string | null; failedTx: string | null };
  /** Health of the optional failed-transaction stream. */
  failedTx: {
    /** Whether `failedTx` was enabled for this listener. */
    enabled: boolean;
    /** True after a failed scan; cleared by the next successful one. */
    degraded: boolean;
    /** Consecutive failed scans (the committed stream is unaffected). */
    consecutiveFailures: number;
    /** When the last failed-tx page was read successfully, ISO-8601. */
    lastSuccessfulPollAt: string | null;
    /** The failed-tx cursor last confirmed, or null. */
    cursor: string | null;
  };
  /**
   * Provable coverage gaps observed by this listener, oldest first, capped at
   * the most recent 100. Each entry is a copy, so editing the snapshot cannot
   * change what the listener records.
   */
  gaps: GuardTelemetryGap[];
}

/**
 * One page of the failed-transaction scan. Shape-matched to `PollResult` but
 * without `latestLedger`: the scan's only cursor obligation is to round-trip
 * the value the caller handed back, and the two streams' cursors are never
 * exchanged (see `pollFailedTransactions`).
 */
export interface FailedTxPollResult {
  events: GuardEvent[];
  /** Cursor to resume the failed-transaction scan from. */
  cursor: string;
}

/**
 * Cap on failed-transaction hashes tracked for per-process dedup, trimmed
 * oldest-first past the cap (`docs/event-schema.md`, "Deduplication"). A page
 * only ever re-reads one page back after an error, so the cap just has to
 * cover what a retention window can still resurface.
 */
const MAX_TRACKED_FAILED_TX = 1_000;

/** Cap on the coverage gaps `health()` retains, oldest evicted first. */
const MAX_RECORDED_GAPS = 100;

export type TelemetryJitter = "none" | "full";

export const DEFAULT_JITTER_FRACTION = 0.2;

/**
 * Compute the sleep delay for telemetry polling with optional uniform jitter.
 *
 * When `jitter` is `'full'` (the good-citizen default), delays are uniformly
 * distributed in `[intervalMs * (1 - j), intervalMs]` with `j = 0.2`. This
 * prevents fleet-level thundering herds against public RPCs when multiple agents
 * start at the same time.
 */
export function computePollDelay(
  intervalMs: number,
  jitter: TelemetryJitter = "full",
  rng: () => number = Math.random,
  jitterFraction: number = DEFAULT_JITTER_FRACTION,
): number {
  if (jitter === "none") return intervalMs;
  const j = Math.max(0, Math.min(1, jitterFraction));
  const factor = 1 - j + rng() * j;
  return Math.round(intervalMs * factor);
}

/**
 * The sleep used between polls: waits `ms`, or until `signal` aborts.
 *
 * The signal argument is optional, so a caller can inject a plain
 * `(ms) => Promise<void>` exactly as before; the watch loop cuts that short
 * itself (`raceAbort`) rather than requiring the hook to be abort-aware.
 */
export type PollSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * The default poll delay: a `setTimeout` an abort cancels outright.
 *
 * Clearing the timer rather than merely abandoning it is what makes abort
 * usable during teardown: a listener stopped mid-interval must not leave an
 * open handle behind, or a Node process — a test suite most visibly — stays
 * alive until the timer would have fired.
 */
function defaultPollSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wait out a poll delay, ending as soon as `signal` aborts.
 *
 * A caller-supplied sleep cannot be cancelled from the outside, so the wait is
 * *raced* against the abort event instead: aborting resolves this promise
 * immediately and whatever the abandoned sleep does later is ignored. A sleep
 * that rejects after the abort is likewise swallowed — a stop request is
 * teardown, not a telemetry failure — while a sleep that rejects without an
 * abort still surfaces to the caller exactly as it did before.
 */
function raceAbort(signal: AbortSignal | undefined, wait: () => Promise<void>): Promise<void> {
  if (!signal) return wait();
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    wait().then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) resolve();
        else reject(error);
      },
    );
  });
}

export interface GuardTelemetryWatchParams {
  startLedger?: number;
  pollIntervalMs?: number;
  limit?: number;
  /**
   * Stop the stream. Abort is honoured at **loop boundaries**: before the first
   * request, before each poll, and during the delay between polls (the default
   * delay's timer is cleared, so no handle is left open). It is deliberately
   * *not* honoured inside a request that is already in flight — see the
   * cancellation note in the README for why, and for the one-request bound that
   * implies.
   */
  signal?: AbortSignal;
  /**
   * Jitter mode for poll interval delays.
   * - `'full'` (default): uniformly randomizes each delay in `[interval*(1-j), interval]` (j=0.2)
   *   to avoid synchronized polling thundering herds across agent fleets.
   * - `'none'`: exact fixed interval cadence.
   */
  jitter?: TelemetryJitter;
  /** Optional RNG injector for deterministic unit testing (defaults to Math.random). */
  rng?: () => number;
  /**
   * Optional sleep handler, for testing without wall-clock delays.
   *
   * It receives the watch signal as a second argument so it can end early on
   * abort; one that ignores the argument is still cut short by the loop.
   */
  sleep?: PollSleep;
  /**
   * Resume from a previously stored RPC cursor instead of a ledger range.
   * Cursors are opaque, so pair this with `resumeLedger` — the last ledger the
   * stored cursor had already consumed — to make a gap that opened while the
   * listener was offline detectable.
   */
  cursor?: string;
  /**
   * The ledger a supplied `cursor` points at. Without it the resume point cannot
   * be reconstructed from the cursor, so no gap can be proven and none is
   * reported (an announced unknown is not better than a silent guess).
   */
  resumeLedger?: number;
  /**
   * Called when coverage provably broke: the RPC's retention window now starts
   * after the earliest ledger the listener still needed.
   *
   * Fires at most once per discontinuity — never once per poll — and is never
   * called with a fabricated event. A throwing callback is isolated (it cannot
   * break the watch loop), matching `invoke()`'s `onStep` contract.
   */
  onGap?: (gap: GuardTelemetryGap) => void;
  /**
   * Called once for each successful page that contains at least one event whose
   * name topic this SDK version does not recognise.
   *
   * The callback receives decoded topic names and per-page counts only — never
   * raw XDR or the source event payload. A throwing callback is isolated so an
   * observability sink cannot stop the stream. `poll()` exposes the same
   * summary as `PollResult.unknownTopics`. Additive (issue #287).
   */
  onUnknownTopics?: (unknownTopics: readonly GuardUnknownTopic[]) => void;
  /**
   * Called once when the committed stream ends because of a terminal RPC
   * failure — after the bounded retry envelope is exhausted. Fail-visible
   * telemetry: a silent stream death is an incident blind spot.
   *
   * The callback receives the final error. A callback that throws propagates
   * out of the `for await` loop: the consumer asked for it. When omitted, the
   * stream still retries-then-ends, and the terminal error is retrievable via
   * `lastError` on the listener.
   */
  onStreamError?: (error: unknown) => void;
}

/**
 * Sliding-window counters for allowed/blocked decisions (issue #68).
 *
 * Opt-in via `GuardTelemetryListenerOptions.counters`. When absent, no counter
 * state is allocated at all and `stats()` returns `null` — memory discipline
 * matters for a listener that may run for the lifetime of an agent.
 *
 * Exactly one of `windowEvents` / `windowMs` selects the eviction rule:
 *
 * - `windowEvents` (preferred): the window holds the last N decisions. No
 *   clock is consulted, so the counters are deterministic under test and
 *   unaffected by wall-clock skew.
 * - `windowMs`: time-based eviction, using the injected `clock`. Time-based
 *   windows are a follow-up to the count-based form; the count form is the
 *   one the acceptance criteria exercise.
 */
export interface GuardTelemetryCountersOptions {
  /** Keep the last N decisions. Mutually exclusive with `windowMs`. */
  windowEvents?: number;
  /** Keep decisions observed within the last `windowMs` milliseconds. */
  windowMs?: number;
  /**
   * Clock used for `windowMs` eviction and for `windowStart`. Defaults to
   * `Date.now`. Injected so tests need no wall-clock waits.
   */
  clock?: () => number;
}

/**
 * How complete the counters' view of the guard's decisions is (#321).
 *
 * - `none` — no decision has reached the counters, so every count is zero for
 *   lack of input rather than because the guard decided nothing.
 * - `incomplete` — decisions were counted, but at least one decision-bearing
 *   stream has never been fed. A zero `blocked` count on this status means
 *   "no refusal was observed on the stream(s) in `seen`", not "nothing was
 *   refused".
 * - `complete` — both the committed stream and the diagnostic stream have fed
 *   at least one decision, so the counters cover the whole decision surface a
 *   `watchAll()` consumer sees.
 */
export type GuardTelemetryCoverageStatus = "none" | "incomplete" | "complete";

/**
 * What the counters have actually observed, as opposed to what they counted.
 *
 * `stats()` alone cannot answer "was nothing blocked?" — a listener that only
 * tailed committed ledger events never sees a blocked decision at all, because
 * the guard's `Err` rolls that event back before broadcast. This metadata makes
 * the difference explicit instead of leaving a zero to be misread.
 *
 * Counts here are **cumulative since construction or the last
 * `resetStats()`**, not windowed: coverage is a fact about what was wired up,
 * which eviction must not erase.
 */
export interface GuardTelemetryCoverage {
  /** Decisions fed to the counters since construction or the last reset. */
  observed: number;
  /** Per-stream decision counts since construction or the last reset. */
  streams: Record<GuardEventStream, number>;
  /**
   * Streams that have fed at least one decision, in stable order
   * (`committed`, `diagnostic`, `failed_tx`).
   */
  seen: GuardEventStream[];
  /**
   * Streams still required for `complete`, in stable order. Empty when the
   * status is `complete`; both decision-bearing streams when it is `none`.
   *
   * `failed_tx` is *not* required: it carries the same blocked decisions the
   * diagnostic stream does, so observing it alone cannot make the counters
   * claim complete coverage of the committed side.
   */
  missing: GuardEventStream[];
  status: GuardTelemetryCoverageStatus;
}

/** A snapshot of the sliding-window counters. Never mutated by callers. */
export interface GuardTelemetryStats {
  /** Decisions observed in the window whose verdict was `allowed`. */
  allowed: number;
  /** Decisions observed in the window whose verdict was `blocked`. */
  blocked: number;
  /** Blocked decisions in the window, keyed by reason. */
  byReason: Record<string, number>;
  /**
   * Timestamp of the oldest decision in the window, on the counter's monotonic
   * timeline (#320). It is the observation time clamped to never move backwards:
   * after a wall-clock rollback it holds the previous high-water mark rather
   * than a value in the past, and when the window is empty it is the current
   * monotonic time. It is **not** a wall-clock reading to compare with
   * `Date.now()`; treat it as the start of the retained interval.
   */
  windowStart: number;
  /**
   * Which streams fed these counters (#321). Additive; a consumer that only
   * reads the counts above is unaffected. Read `coverage.status` before
   * treating a zero `blocked` count as evidence that nothing was refused.
   */
  coverage: GuardTelemetryCoverage;
}

/** One decision recorded in the window, retained for eviction. */
interface CounterEntry {
  verdict: "allowed" | "blocked";
  reason: string | null;
  at: number;
}

/**
 * Sliding-window counters over guard decisions.
 *
 * Fed one event at a time by the listener; `stats()` returns a fresh snapshot
 * object each call so a caller cannot mutate internal state by holding onto it.
 */
export class GuardDecisionCounters {
  private readonly windowEvents: number | null;
  private readonly windowMs: number | null;
  private readonly clock: () => number;
  private readonly entries: CounterEntry[] = [];
  private allowed = 0;
  private blocked = 0;
  private readonly byReason = new Map<string, number>();
  /** Decisions fed to the counters since construction or the last reset. */
  private observations = 0;

  /**
   * Per-stream decision counts since construction or the last reset (#321).
   * Not windowed: coverage records which streams were ever wired up, a fact
   * eviction must not erase.
   */
  private readonly streamCounts: Record<GuardEventStream, number> = {
    committed: 0,
    diagnostic: 0,
    failed_tx: 0,
  };

  /**
   * High-water mark of the injected clock (#320).
   *
   * Eviction runs on a **monotonic** timeline: every observation is clamped to
   * `Math.max(now, lastObservedAt)`. A wall-clock rollback (NTP correction, a
   * container moved between hosts, a date set backwards) therefore cannot push
   * the eviction cutoff backwards and leave entries retained past the
   * advertised window. Forward jumps are honoured immediately, so a clock that
   * leaps ahead still expires stale entries. `null` until the first observation.
   */
  private lastObservedAt: number | null = null;

  constructor(options: GuardTelemetryCountersOptions) {
    const { windowEvents, windowMs } = options;
    if (windowEvents !== undefined && windowMs !== undefined) {
      throw new Error("counters: specify windowEvents or windowMs, not both");
    }
    if (windowEvents === undefined && windowMs === undefined) {
      throw new Error("counters: windowEvents or windowMs is required");
    }
    if (windowEvents !== undefined && (!Number.isInteger(windowEvents) || windowEvents <= 0)) {
      throw new Error("counters: windowEvents must be a positive integer");
    }
    if (windowMs !== undefined && (!Number.isFinite(windowMs) || windowMs <= 0)) {
      throw new Error("counters: windowMs must be a positive number");
    }
    this.windowEvents = windowEvents ?? null;
    this.windowMs = windowMs ?? null;
    this.clock = options.clock ?? Date.now;
  }

  /** Record one decision. Non-decision events are ignored by the caller. */
  record(event: GuardEvent): void {
    if (event.kind !== "auth_checked" || event.decision === null) return;
    const verdict = isAllowedDecision(event.decision) ? "allowed" : "blocked";
    const reason = event.decision.reason ?? null;
    const at = this.monotonicNow();
    this.observations += 1;
    this.streamCounts[event.stream] += 1;
    this.entries.push({ verdict, reason, at });
    if (verdict === "allowed") this.allowed += 1;
    else {
      this.blocked += 1;
      if (reason !== null) this.byReason.set(reason, (this.byReason.get(reason) ?? 0) + 1);
    }
    this.evict();
  }

  /**
   * Current time on the counter's monotonic timeline.
   *
   * The first observation establishes the epoch. From then on the clock may
   * only move forward: a backward step reads as the high-water mark, and a
   * forward step advances it. `stats()` may be the first caller, which is fine
   * — with no entries there is nothing to retain.
   */
  private monotonicNow(): number {
    const observed = this.clock();
    if (this.lastObservedAt === null || observed > this.lastObservedAt) {
      this.lastObservedAt = observed;
    }
    return this.lastObservedAt;
  }

  /** Drop entries that have aged out of the window. */
  private evict(): void {
    if (this.windowEvents !== null) {
      while (this.entries.length > this.windowEvents) {
        this.remove(this.entries.shift()!);
      }
      return;
    }
    const cutoff = this.monotonicNow() - (this.windowMs ?? 0);
    while (this.entries.length > 0 && this.entries[0]!.at < cutoff) {
      this.remove(this.entries.shift()!);
    }
  }

  private remove(entry: CounterEntry): void {
    if (entry.verdict === "allowed") {
      this.allowed -= 1;
      return;
    }
    this.blocked -= 1;
    if (entry.reason !== null) {
      const next = (this.byReason.get(entry.reason) ?? 0) - 1;
      if (next <= 0) this.byReason.delete(entry.reason);
      else this.byReason.set(entry.reason, next);
    }
  }

  /**
   * Which decision streams have fed these counters (#321), as a fresh copy.
   *
   * Status is `none` until a decision arrives, `complete` only when both the
   * committed and the diagnostic streams have delivered one, and `incomplete`
   * in between. A listener fed only by `watch()` — or only by simulation
   * diagnostics — therefore reports `incomplete` and names the missing stream,
   * instead of presenting a one-sided count as the whole picture.
   */
  coverage(): GuardTelemetryCoverage {
    const order: readonly GuardEventStream[] = ["committed", "diagnostic", "failed_tx"];
    const seen = order.filter((stream) => this.streamCounts[stream] > 0);
    const required: readonly GuardEventStream[] = ["committed", "diagnostic"];
    const missing = required.filter((stream) => this.streamCounts[stream] === 0);
    const status: GuardTelemetryCoverageStatus =
      this.observations === 0 ? "none" : missing.length === 0 ? "complete" : "incomplete";
    return {
      observed: this.observations,
      streams: { ...this.streamCounts },
      seen,
      missing: [...missing],
      status,
    };
  }

  /**
   * Clear the window, the counts, and the coverage record (#321).
   *
   * Reset is total on purpose: leaving coverage behind would let a caller
   * clear the counts and then read `complete` over an empty window, which is
   * exactly the confusion the coverage metadata exists to prevent. The
   * monotonic clock high-water mark is dropped too, so the next observation
   * establishes a fresh epoch rather than inheriting the old one.
   */
  reset(): void {
    this.entries.length = 0;
    this.allowed = 0;
    this.blocked = 0;
    this.byReason.clear();
    this.observations = 0;
    this.streamCounts.committed = 0;
    this.streamCounts.diagnostic = 0;
    this.streamCounts.failed_tx = 0;
    this.lastObservedAt = null;
  }

  /** A fresh snapshot; callers may mutate it freely. */
  stats(): GuardTelemetryStats {
    this.evict();
    return {
      allowed: this.allowed,
      blocked: this.blocked,
      byReason: Object.fromEntries(this.byReason),
      windowStart: this.entries.length > 0 ? this.entries[0]!.at : this.monotonicNow(),
      coverage: this.coverage(),
    };
  }
}

/**
 * A batch of already-decoded diagnostic events, with the time they were
 * observed. This is the second source the unified stream (`watchAll()`) merges
 * with the committed ledger feed — see `docs/event-schema.md`.
 */
export interface GuardDiagnosticBatch {
  /** Decoded guard events, in the order they were observed. */
  events: readonly GuardEvent[];
  /**
   * ISO-8601 time the batch was observed. Defaults to `new Date().toISOString()`
   * when omitted, so a merged diagnostic always carries an `observedAt`.
   */
  observedAt?: string;
}

/**
 * `watchAll()` parameters: the committed-stream options plus the diagnostic
 * source to interleave with them.
 */
export interface GuardTelemetryUnifiedParams extends GuardTelemetryWatchParams {
  /**
   * The diagnostic half of the unified stream: batches of decoded events from
   * `guardEventsFromDiagnostics()` / `telemetryFromDecision()`, in observation
   * order. Absent → `watchAll()` degenerates cleanly to the committed stream.
   */
  diagnostics?: AsyncIterable<GuardDiagnosticBatch> | Iterable<GuardDiagnosticBatch>;
}

/** Render an unknown thrown value as a message, for the health snapshot. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Plain code-unit string comparison, independent of the host locale. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Ascending string order, with a missing value sorting last. */
function compareNullableStrings(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareStrings(a, b);
}

/** Render one page's unknown-topic counts in a stable, payload-free shape. */
function unknownTopicSummary(counts: ReadonlyMap<string, number>): GuardUnknownTopic[] {
  return [...counts.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => compareStrings(a.topic, b.topic));
}

/**
 * The committed-page ordering rule: ledger ascending, then a stable
 * tie-breaker for events that share a ledger.
 *
 * A missing ledger sorts last. Within one ledger the tie-breaker is the
 * transaction hash, then the event topic, then the stable event id, each
 * ascending and each placing a missing value last. The final id component
 * makes the comparison total for every event this SDK produces; when two
 * entries are indistinguishable the caller's input order is preserved by the
 * stable `Array#sort`. `poll()`, `watch()` and `watchAll()` all apply this same
 * rule, so switching APIs cannot change committed-event order.
 */
export function compareCommittedEvents(a: GuardEvent, b: GuardEvent): number {
  const ledgerA = a.ledger ?? Number.MAX_SAFE_INTEGER;
  const ledgerB = b.ledger ?? Number.MAX_SAFE_INTEGER;
  if (ledgerA !== ledgerB) return ledgerA - ledgerB;
  const byHash = compareNullableStrings(a.transactionHash, b.transactionHash);
  if (byHash !== 0) return byHash;
  const byTopic = compareStrings(a.topic, b.topic);
  if (byTopic !== 0) return byTopic;
  return compareStrings(a.id, b.id);
}

/** Sort one committed page in place, leaving every other stream untouched. */
function sortCommittedPage(events: GuardEvent[]): GuardEvent[] {
  return events.sort(compareCommittedEvents);
}

/** Adapt a sync or async iterable to an async iterator, so both arms can be armed. */
function asAsyncIterator<T>(source: AsyncIterable<T> | Iterable<T>): AsyncIterator<T> {
  const asyncSource = source as AsyncIterable<T>;
  if (typeof asyncSource[Symbol.asyncIterator] === "function") {
    return asyncSource[Symbol.asyncIterator]();
  }
  const syncIterator = (source as Iterable<T>)[Symbol.iterator]();
  return {
    next: () => Promise.resolve(syncIterator.next()),
    return: (value?: unknown) =>
      Promise.resolve(
        syncIterator.return ? syncIterator.return(value) : { value: value as T, done: true },
      ),
  };
}

/** One settled arm of the merge: a committed page, a diagnostic batch, or abort. */
type MergePull =
  | { source: "committed"; result: IteratorResult<GuardEvent[]> }
  | { source: "diagnostic"; result: IteratorResult<GuardDiagnosticBatch> }
  | { source: "abort" };

/**
 * Merge the committed and diagnostic streams into one ordered, de-duplicated
 * stream of `GuardEvent`s (issue #67).
 *
 * ## Ordering rule
 *
 * - **Committed events are emitted in ledger order.** Each page is sorted with
 *   `compareCommittedEvents()` before it is yielded: `ledger` ascending (missing
 *   last), then transaction hash, topic and stable id as tie-breakers for events
 *   that share a ledger. Pages arrive in cursor order, so no committed event
 *   overtakes an earlier-ledger one.
 * - **Diagnostic events are emitted when the batch carrying them is observed**,
 *   tagged with `observedAt`. A refusal was rolled back before broadcast, so it
 *   has no ledger to sort on; its position is the point of observation relative
 *   to the committed frontier already drained, not a ledger. That is the rule a
 *   consumer relies on: a decision observed at time T appears after the
 *   committed events drained at or before T.
 *
 * ## De-duplication rule
 *
 * `GuardEvent.id` is the SDK's delivery key, and the merge emits each id **at
 * most once** — first observation wins. A guard decision is single-homed (a
 * blocked decision is rolled back and never committed; an allowed decision has
 * no diagnostic), so the same decision cannot arrive under two ids. The
 * duplicate the merge actually guards against is the *same id* delivered twice
 * — a re-fed diagnostic batch, or an overlapping committed page — which the
 * emitted-id set suppresses.
 */
export async function* mergeGuardEventStreams(
  committedSource: AsyncIterable<GuardEvent[]> | Iterable<GuardEvent[]>,
  diagnosticSource?: AsyncIterable<GuardDiagnosticBatch> | Iterable<GuardDiagnosticBatch>,
  signal?: AbortSignal,
): AsyncGenerator<GuardEvent, void, undefined> {
  const committed = asAsyncIterator(committedSource);
  const diagnostics = diagnosticSource ? asAsyncIterator(diagnosticSource) : null;
  const emitted = new Set<string>();

  let onAbort: (() => void) | null = null;
  const abortArm = signal
    ? new Promise<MergePull>((resolve) => {
        onAbort = () => resolve({ source: "abort" });
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort);
      })
    : null;

  let committedPull: Promise<MergePull> | null = committed
    .next()
    .then((result) => ({ source: "committed" as const, result }));
  let diagnosticPull: Promise<MergePull> | null = diagnostics
    ? diagnostics.next().then((result) => ({ source: "diagnostic" as const, result }))
    : null;

  try {
    while (committedPull !== null || diagnosticPull !== null) {
      const pending = [committedPull, diagnosticPull].filter(
        (pull): pull is Promise<MergePull> => pull !== null,
      );
      if (abortArm) pending.push(abortArm);
      const settled = await (pending.length === 1 ? pending[0]! : Promise.race(pending));

      if (settled.source === "abort") return;

      if (settled.source === "committed") {
        committedPull = null;
        if (settled.result.done) continue;
        const page = settled.result.value;
        const orderedCommitted = sortCommittedPage(
          page.filter((event) => event.stream === "committed"),
        );
        let nextCommitted = 0;
        for (const event of page) {
          const ordered =
            event.stream === "committed" ? orderedCommitted[nextCommitted++]! : event;
          if (emitted.has(ordered.id)) continue;
          emitted.add(ordered.id);
          yield ordered;
        }
        committedPull = committed
          .next()
          .then((result) => ({ source: "committed" as const, result }));
      } else {
        diagnosticPull = null;
        if (settled.result.done) continue;
        const observedAt = settled.result.value.observedAt ?? new Date().toISOString();
        for (const event of settled.result.value.events) {
          const tagged: GuardEvent = { ...event, stream: "diagnostic", observedAt };
          if (emitted.has(tagged.id)) continue;
          emitted.add(tagged.id);
          yield tagged;
        }
        diagnosticPull = diagnostics!
          .next()
          .then((result) => ({ source: "diagnostic" as const, result }));
      }
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    await committed.return?.();
    if (diagnostics) await diagnostics.return?.();
  }
}

export interface CursorStore {
  save(cursor: string): Promise<void>;
  load(): Promise<string | null>;
}

export class InMemoryCursorStore implements CursorStore {
  private cursor: string | null = null;
  async save(cursor: string): Promise<void> {
    this.cursor = cursor;
  }
  async load(): Promise<string | null> {
    return this.cursor;
  }
}

/**
 * Config for a listener used purely for local state (counters, `recent()`),
 * with no RPC transport. A host that only wants `observe()`/`stats()` does not
 * need a `server` and should not have to fabricate one.
 */
export interface GuardTelemetryLocalConfig {
  /** Opt-in sliding-window counters over allowed/blocked decisions. */
  counters?: GuardTelemetryCountersOptions;
  /** Clock the counters consult for `windowMs` eviction. */
  clock?: (() => number) | undefined;
  /** Optional log sink. */
  logger?: GuardLoggerInput | undefined;
}

/**
 * Thrown when a second `watch()`/`watchAll()` stream is started on a listener
 * that already has one active.
 *
 * A listener owns shared cursor, failed-transaction de-duplication, counter,
 * and buffer state. Rather than let two iterators race those structures, the
 * listener supports **one active stream at a time**: a second stream is
 * rejected before it issues an RPC request or advances any cursor. Start a
 * second listener (with its own options) when you need independent streams.
 */
export class ConcurrentTelemetryStreamError extends GuardError {
  /** Stable code for consumers that branch on the failure. */
  readonly code = "telemetry.concurrent_stream";
  /** The stream kind that was rejected. */
  readonly requested: "watch" | "watchAll";

  constructor(requested: "watch" | "watchAll") {
    super(
      `GuardTelemetryListener already has an active watch()/watchAll() stream; ${requested}() cannot start concurrently. Use one listener per stream.`,
    );
    this.requested = requested;
  }
}

export class GuardTelemetryListener {
  private readonly config: GuardTelemetryConfig;
  private readonly logger: GuardLogger;
  /** The configured guard in canonical `C...` form, for identity comparison. */
  private readonly guardContractId: string;

  /** Lease for the one stream currently allowed to mutate listener state. */
  private activeStreamLease: symbol | null = null;

  /** The persistence adapter this listener is using (defaults to in-memory). */
  readonly activeCursorStore: CursorStore;

  /**
   * The persistence adapter for the **failed-transaction** cursor, kept
   * deliberately separate from `activeCursorStore` (issue #279).
   */
  readonly activeFailedTxCursorStore: CursorStore;

  /**
   * Null unless `config.buffer` is set: with no buffer requested, there is no
   * structure to allocate and every `recent()` call short-circuits (issue #68).
   */
  private readonly buffer: GuardEventRingBuffer | null;

  /**
   * The terminal error that ended the most recent `watch()` stream, or `null`
   * when the stream ended normally (abort or completion). Set when the bounded
   * retry envelope is exhausted; cleared at the start of each `watch()`.
   */
  private lastError: unknown = null;

  /** The terminal error that ended the most recent `watch()` stream, if any. */
  getLastError(): unknown {
    return this.lastError;
  }

  // ── Health state (issue #286) ────────────────────────────────────────────
  /** Committed stream state, surfaced by `health()`. */
  private healthState: GuardTelemetryStreamState = "idle";
  /** Entry point that drove the last stream. */
  private healthStream: "watch" | "watchAll" | null = null;
  /** ISO-8601 start of the last stream. */
  private healthStartedAt: string | null = null;
  /** ISO-8601 time of the last successful committed poll. */
  private lastSuccessfulPollAt: string | null = null;
  /** `latestLedger` of the last successful committed poll. */
  private lastSuccessfulPollLedger: number | null = null;
  /** Failed committed polls since the last success. */
  private consecutiveFailures = 0;
  /** When `lastError` was recorded, ISO-8601. */
  private lastErrorAt: string | null = null;
  /** The committed cursor last confirmed by a poll. */
  private committedCursor: string | null = null;
  /** The failed-tx cursor last confirmed by a scan. */
  private failedTxCursorState: string | null = null;
  /** Whether the optional failed-tx stream is currently degraded. */
  private failedTxDegraded = false;
  /** Failed failed-tx scans since the last success. */
  private failedTxConsecutiveFailures = 0;
  /** True when the most recent failed-tx scan failed (cursor must not advance). */
  private failedTxScanFailed = false;
  /** ISO-8601 time of the last successful failed-tx scan. */
  private failedTxLastSuccessfulPollAt: string | null = null;
  /** Provable coverage gaps observed by this listener, oldest first. */
  private readonly recordedGaps: GuardTelemetryGap[] = [];

  /**
   * A read-only snapshot of listener health (issue #286).
   *
   * Answers the operational questions the event stream alone cannot: is the
   * committed stream advancing, when did it last poll successfully, how many
   * consecutive failures has it seen, has coverage broken, and is the optional
   * failed-transaction stream degraded. Nothing here mutates the listener, and
   * the returned object — including `cursors`, `failedTx`, and every gap — is a
   * fresh copy, so a caller cannot alter listener internals through it.
   *
   * `lastError` deliberately carries the error's message, not the error object
   * itself: the live error value remains available through `getLastError()`.
   */
  health(): GuardTelemetryHealthSnapshot {
    return {
      state: this.healthState,
      stream: this.healthStream,
      startedAt: this.healthStartedAt,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      lastSuccessfulPollLedger: this.lastSuccessfulPollLedger,
      consecutiveFailures: this.consecutiveFailures,
      lastError:
        this.lastError === null
          ? null
          : {
              message: errorMessage(this.lastError),
              at: this.lastErrorAt ?? this.nowIso(),
            },
      cursors: {
        committed: this.committedCursor,
        failedTx: this.failedTxCursorState,
      },
      failedTx: {
        enabled: this.config.failedTx === true,
        degraded: this.failedTxDegraded,
        consecutiveFailures: this.failedTxConsecutiveFailures,
        lastSuccessfulPollAt: this.failedTxLastSuccessfulPollAt,
        cursor: this.failedTxCursorState,
      },
      gaps: this.recordedGaps.map((gap) => ({ ...gap })),
    };
  }

  /** Current time on the listener's injectable clock, as ISO-8601. */
  private nowIso(): string {
    return new Date(this.config.clock?.() ?? Date.now()).toISOString();
  }

  /** Record a successful committed poll (#286). */
  private recordHealthyPoll(page: PollResult): void {
    this.lastSuccessfulPollAt = this.nowIso();
    this.lastSuccessfulPollLedger = page.latestLedger;
    this.consecutiveFailures = 0;
    this.committedCursor = page.cursor;
    this.healthState = "running";
  }

  /** Record one failed committed poll attempt (#286). */
  private recordFailedPoll(): void {
    this.consecutiveFailures += 1;
    this.healthState = "recovering";
  }

  /**
   * Failed-transaction hashes already surfaced, so a re-encountered page (the
   * `getTransactions` cursor is not advanced on a mid-page error) or a retry
   * never emits the same failed_tx event twice.
   *
   * This is process-local checkpoint state, not a substitute for the cursors:
   * across a listener restart the streams resume from their cursors and this
   * set starts empty, so a failed transaction still inside the retention
   * window may be re-surfaced once — the same at-least-once behavior the
   * committed stream has when no cursor was persisted.
   */
  private readonly processedFailedTx = new Set<string>();

  /**
   * Null unless `config.counters` is set: with no counters requested, no
   * sliding-window state is allocated and `stats()` returns `null`.
   */
  private readonly counters: GuardDecisionCounters | null;

  constructor(config: GuardTelemetryConfig | GuardTelemetryLocalConfig = {}) {
    const resolved = config as GuardTelemetryConfig;
    this.config = resolved;
    this.guardContractId = canonicalContractId(resolved.guard) ?? resolved.guard ?? "";
    this.logger = resolveLogger(resolved.logger);
    this.buffer = resolved.buffer ? new GuardEventRingBuffer(resolved.buffer.max) : null;
    this.activeCursorStore = resolved.cursorStore ?? new InMemoryCursorStore();
    // A distinct store even when the caller supplied only `cursorStore`: the
    // two streams must never share cursor state (issue #279).
    this.activeFailedTxCursorStore = resolved.failedTxCursorStore ?? new InMemoryCursorStore();
    this.counters = resolved.counters
      ? new GuardDecisionCounters({
          ...resolved.counters,
          ...(resolved.clock ? { clock: resolved.clock } : {}),
        })
      : null;
  }

  /**
   * Feed one decoded event through the listener's opt-in state (currently the
   * sliding-window decision counters). Public so a host that decodes events
   * itself — e.g. from its own simulation diagnostics — can include them in
   * `stats()` without standing up a `watchAll()` stream.
   */
  observe(event: GuardEvent): void {
    this.counters?.record(event);
  }

  /**
   * Snapshot of the sliding-window decision counters, or `null` when counters
   * were not opted into. The returned object is a copy: mutating it does not
   * affect the listener.
   */
  stats(): GuardTelemetryStats | null {
    return this.counters ? this.counters.stats() : null;
  }

  /**
   * Clear the sliding-window counters, including their coverage record
   * (#321). A no-op when counters were not opted into.
   *
   * The listener's own state — cursors, buffer, health — is untouched: this
   * resets the counter view, not the stream. Events already retained by
   * `recent()` are not re-counted after a reset, so a subsequent `watchAll()`
   * counts only decisions observed from that point on.
   */
  resetStats(): void {
    this.counters?.reset();
  }

  /**
   * The most recent events the listener has observed, oldest first, optionally
   * narrowed by `filter` (issue #68). Empty when no `buffer` was configured.
   *
   * Only events this listener decoded are retained: committed events from
   * `poll()`/`watch()`, and diagnostic events merged in by `watchAll()`. A
   * consumer that never calls `watchAll()` sees no diagnostic half — the same
   * two-stream distinction the rest of the telemetry API makes.
   *
   * The buffer is in-process and non-durable; a restart empties it.
   *
   * **Snapshot semantics (issue #344):** what this returns is a *detached
   * snapshot*. The array, the events in it, their decoded `data`/`decision` and
   * the opt-in `raw` payload are all copies, so mutating them cannot change
   * what the listener still retains, and the next `recent()` reports the
   * retained event rather than the consumer's edit. With no buffer configured
   * there is nothing to copy: the call returns `[]` and allocates nothing.
   */
  recent(filter?: RecentEventFilter): GuardEvent[] {
    return this.buffer ? this.buffer.recent(filter) : [];
  }

  /**
   * The retained window as bounded JSON Lines (#324): one
   * `serializeEventRecord()` line per event, oldest first, `filter` applied
   * exactly as `recent()` applies it.
   *
   * The export is a string, never a file: where (or whether) to persist it is
   * the caller's decision, so the SDK keeps its no-filesystem-access
   * discipline. With no `buffer` configured the result is `''`.
   *
   * The boundedness is the buffer's: this returns at most `buffer.max` lines,
   * so an incident handoff is a snapshot of the configured window, not an
   * unbounded dump. Each line is JSON-safe (a `bigint` is a decimal string, a
   * byte array is `bytes:<hex>`), and the opt-in `raw` payload is **never**
   * serialized — the projection has a fixed field list that does not include
   * it, so exporting cannot leak a host payload that `includeRaw` retained for
   * debugging.
   */
  recentJsonLines(filter?: RecentEventFilter): string {
    return serializeEventLines(this.recent(filter));
  }

  /** Record decoded events into the opt-in buffer, if one is configured. */
  private record(events: readonly GuardEvent[]): void {
    if (!this.buffer) return;
    for (const event of events) this.buffer.push(event);
  }

  /** Record a hash as processed, trimming the oldest entry past the cap. */
  private rememberFailedTx(hash: string): void {
    this.processedFailedTx.add(hash);
    if (this.processedFailedTx.size > MAX_TRACKED_FAILED_TX) {
      const oldest = this.processedFailedTx.values().next().value;
      if (oldest !== undefined) this.processedFailedTx.delete(oldest);
    }
  }

  /**
   * Decode one failed transaction's diagnostics into GuardEvents.
   *
   * Diagnostics attributed to the guard contract go through the canonical
   * `interpret` engine — the same topic filter and decision decoder every
   * other stream uses — so an unknown topic (host noise, another contract's
   * event) is dropped, never guessed at, and a malformed event that throws
   * while decoding is skipped rather than crashing the poll.
   */
  private decodeFailedTransaction(tx: rpc.Api.TransactionInfo): GuardEvent[] {
    const out: GuardEvent[] = [];
    for (const [index, raw] of (tx.diagnosticEventsXdr ?? []).entries()) {
      try {
        const bare = (raw as { event?: unknown }).event ?? raw;
        const topics = topicSymbols(bare);
        if (topics.length === 0) continue;
        if (!emittedByGuard(raw, this.config.guard)) continue;
        const decoded = interpret(topics, decodeData(dataOf(bare)), {
          source: "diagnostic",
          stream: "failed_tx",
          contractId: this.config.guard,
          ledger: tx.ledger,
          ledgerClosedAt: null,
          transactionHash: tx.txHash,
          // Position within this transaction's diagnostic batch, so two identical
          // events in one failed transaction cannot share a content-derived id.
          simulationIndex: index,
        });
        if (decoded) out.push(decoded);
      } catch {
        // A single malformed diagnostic must not take down the poll; the
        // transaction's other events, and the page, continue.
      }
    }
    return out;
  }

  /** Record a successful failed-transaction scan (#279, #286). */
  private recordHealthyFailedTxPoll(cursor: string): void {
    this.failedTxLastSuccessfulPollAt = this.nowIso();
    this.failedTxCursorState = cursor;
    this.failedTxDegraded = false;
    this.failedTxConsecutiveFailures = 0;
    this.failedTxScanFailed = false;
  }

  /** Record a failed failed-transaction scan; the committed stream is unaffected. */
  private recordFailedTxPoll(): void {
    this.failedTxDegraded = true;
    this.failedTxConsecutiveFailures += 1;
    this.failedTxScanFailed = true;
  }

  /**
   * Read one page of failed transactions independently from the event cursor.
   * Without a cursor, start at the current head so existing failures are not
   * replayed retroactively.
   */
  async pollFailedTransactions(
    params: { cursor?: string; startLedger?: number; limit?: number } = {},
  ): Promise<FailedTxPollResult> {
    if (params.cursor === undefined && params.startLedger === undefined) {
      const latest = await this.config.server.getLatestLedger();
      const cursor = String(latest.sequence);
      this.recordHealthyFailedTxPoll(cursor);
      return { events: [], cursor };
    }

    const request: rpc.Api.GetTransactionsRequest = params.cursor !== undefined
      ? {
          pagination: {
            cursor: params.cursor,
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
          },
        }
      : {
          startLedger: params.startLedger!,
          ...(params.limit !== undefined ? { pagination: { limit: params.limit } } : {}),
        };

    try {
      const response = await this.config.server.getTransactions(request);
      const events: GuardEvent[] = [];
      for (const tx of response.transactions) {
        if (tx.status !== rpc.Api.GetTransactionStatus.FAILED) continue;
        if (this.processedFailedTx.has(tx.txHash)) continue;
        this.rememberFailedTx(tx.txHash);
        events.push(...this.decodeFailedTransaction(tx));
      }
      this.record(events);
      this.recordHealthyFailedTxPoll(response.cursor);
      return { events, cursor: response.cursor };
    } catch {
      this.recordFailedTxPoll();
      return { events: [], cursor: params.cursor ?? String(params.startLedger) };
    }
  }

  /**
   * One page of committed guard events at or after `startLedger`.
   *
   * Filters server-side by contract id, but does not trust that filter: the
   * emitting contract is re-checked client-side before any event is decoded
   * (#322). A faulty or proxying RPC that returns a foreign contract's
   * guard-shaped topic is dropped, never reported as this guard's decision.
   * Events with a missing or malformed `contractId` fail closed for the same
   * reason — their identity cannot be verified. Rejections are counted per
   * reason in `PollResult.dropped` and logged, so the drop is visible rather
   * than silent. The topic vocabulary then narrows further, and an
   * unrecognised topic is dropped rather than guessed at.
   */
  async poll(params: { startLedger?: number; cursor?: string; limit?: number } = {}): Promise<PollResult> {
    const request = (
      params.cursor
        ? { filters: [{ type: "contract" as const, contractIds: [this.config.guard] }], cursor: params.cursor, limit: params.limit }
        : {
            filters: [{ type: "contract" as const, contractIds: [this.config.guard] }],
            startLedger: params.startLedger,
            limit: params.limit,
          }
    ) as rpc.Api.GetEventsRequest;

    if (!params.cursor && params.startLedger === undefined) {
      // Default to the current head: replaying a year of history by accident is
      // a mean surprise, and callers that want history pass `startLedger`.
      const latest = await this.config.server.getLatestLedger();
      (request as { startLedger: number }).startLedger = latest.sequence;
    }

    const response = await this.config.server.getEvents(request);
    const events: GuardEvent[] = [];
    // Kept rather than merely skipped: an event this listener cannot interpret
    // is a coverage fact a host may need to see. Counting it is the only way to
    // tell "the guard was quiet" from "the guard spoke in a vocabulary this SDK
    // version does not know", and the per-topic summary below is page metadata
    // a logger-less host can read without retaining the source payload (#287).
    const dropped: GuardEventDropCounts = {
      unknownTopic: 0,
      foreignContract: 0,
      missingContractId: 0,
      malformedContractId: 0,
    };
    const unknownTopicCounts = new Map<string, number>();
    for (const event of response.events) {
      const rawContractId = (event as { contractId?: unknown }).contractId;
      if (rawContractId === undefined || rawContractId === null || rawContractId === "") {
        // Fail closed: without an emitting identity the event cannot be shown to
        // belong to this guard, and the server-side filter is what is in doubt.
        dropped.missingContractId += 1;
        continue;
      }
      const contractId = canonicalContractId(rawContractId);
      if (contractId === null) {
        dropped.malformedContractId += 1;
        continue;
      }
      if (contractId !== this.guardContractId) {
        dropped.foreignContract += 1;
        continue;
      }
      const topics = event.topic.map((topic) => String(scValToNative(topic)));
      const decoded = interpret(
        topics,
        decodeData(event.value),
        {
          source: "ledger",
          stream: "committed",
          contractId,
          ledger: event.ledger,
          ledgerClosedAt: event.ledgerClosedAt ?? null,
          transactionHash: event.txHash ?? null,
          // Committed events anchor on the transaction hash, not on a position
          // within a page: a page boundary would otherwise change an event's id.
          simulationIndex: null,
          // `includeRaw` is off unless the listener was constructed with it, so
          // the default path keeps discarding the RPC object (issue #94).
          ...(this.config.includeRaw ? { raw: event } : {}),
        },
      );
      if (decoded) {
        events.push(decoded);
      } else {
        dropped.unknownTopic += 1;
        const topic = topics[0] ?? "";
        unknownTopicCounts.set(topic, (unknownTopicCounts.get(topic) ?? 0) + 1);
      }
    }
    sortCommittedPage(events);
    const unknownTopics = unknownTopicSummary(unknownTopicCounts);
    const oldestLedger = typeof response.oldestLedger === "number" ? response.oldestLedger : null;
    const droppedTotal =
      dropped.unknownTopic +
      dropped.foreignContract +
      dropped.missingContractId +
      dropped.malformedContractId;
    this.logger.debug("telemetry page received", {
      guard: this.config.guard,
      events: events.length,
      dropped: droppedTotal,
      droppedByReason: dropped,
      unknownTopics,
      latestLedger: response.latestLedger,
      oldestLedger,
    });
    this.record(events);
    return {
      events,
      cursor: response.cursor,
      latestLedger: response.latestLedger,
      dropped,
      // Best-effort: a host that omits the retention boundary gets no gap
      // detection, rather than a boundary invented from `latestLedger`.
      oldestLedger,
      unknownTopics,
    };
  }

  /** Claim the single active-stream lease, or reject concurrent use. */
  private acquireStreamLease(kind: "watch" | "watchAll"): symbol {
    if (this.activeStreamLease !== null) {
      throw new ConcurrentTelemetryStreamError(kind);
    }
    const lease = Symbol(kind);
    this.activeStreamLease = lease;
    return lease;
  }

  /** Release the lease only if it is still the one this stream holds. */
  private releaseStreamLease(lease: symbol): void {
    if (this.activeStreamLease === lease) this.activeStreamLease = null;
  }

  /**
   * Follow the guard from `startLedger` (default: one page back) or from a
   * stored `cursor` until aborted. Yields batches so a caller controls
   * backpressure; the cursor is advanced internally so no event is delivered
   * twice.
   *
   * When `onGap` is supplied, the listener also checks each response's retention
   * window and reports a provable hole (see `GuardTelemetryGap`) instead of
   * silently skipping it. Omitting `onGap` changes nothing about the stream.
   * `onUnknownTopics` reports unrecognised name topics by count without retaining
   * their payloads; omitting it leaves delivery unchanged.
   *
   * ## Aborting
   *
   * `signal` ending the stream is a normal exit, never a throw: an abort before
   * the first request issues no RPC call at all, an abort between pages prevents
   * the next poll and does not serve out the remaining interval, and an abort
   * that lands while a request is in flight lets that request's rejection go
   * quietly as teardown rather than surfacing as an unhandled rejection. The
   * one bound on promptness is the request already in flight: `getEvents` takes
   * no `AbortSignal` (see the README's cancellation note), so the listener can
   * stop *issuing* requests immediately but cannot cancel one already sent.
   *
   * ## Concurrency
   *
   * One listener supports one active stream. Starting a second `watch()` or
   * `watchAll()` while the first is still being pulled throws
   * `ConcurrentTelemetryStreamError`; it never issues an RPC request, saves a
   * cursor, or records an event. Use a separate listener for an independent
   * stream.
   */
  async *watch(
    params: GuardTelemetryWatchParams = {},
  ): AsyncGenerator<GuardEvent[], void, undefined> {
    const lease = this.acquireStreamLease("watch");
    this.healthStream = "watch";
    try {
      yield* this.watchStream(params);
    } finally {
      this.finishHealthStream(params.signal);
      this.healthStream = null;
      this.releaseStreamLease(lease);
    }
  }

  /**
   * Settle the state of a stream that has just ended (#286): an abort wins,
   * while a stream that ended on its own is `stopped`; `failed` is preserved.
   */
  private finishHealthStream(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      this.healthState = "aborted";
    } else if (this.healthState === "running" || this.healthState === "recovering") {
      this.healthState = "stopped";
    }
  }

  /** The implementation behind `watch()`, also used by `watchAll()`. */
  private async *watchStream(
    params: GuardTelemetryWatchParams = {},
  ): AsyncGenerator<GuardEvent[], void, undefined> {
    const interval = params.pollIntervalMs ?? 5_000;
    const jitter = params.jitter ?? "full";
    const rng = params.rng ?? Math.random;
    const signal = params.signal;
    const sleep: PollSleep = params.sleep ?? defaultPollSleep;
    let cursor = params.cursor;
    let startLedger = params.startLedger;
    let failedTxCursor: string | undefined;
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.lastErrorAt = null;

    // An abort that landed before the iterator was first pulled must not probe
    // the RPC — not even the `getLatestLedger` call that resolves the default
    // start ledger. Teardown gets no requests at all, not one.
    if (signal?.aborted) return;

    this.healthState = "running";
    this.healthStartedAt = this.nowIso();

    if (cursor === undefined && startLedger === undefined) {
      cursor = (await this.activeCursorStore.load()) ?? undefined;
    }

    if (this.config.failedTx) {
      // The failed-transaction stream resumes from its own store, never from
      // `cursorStore` (issue #279): the cursors are not interchangeable.
      failedTxCursor = (await this.activeFailedTxCursorStore.load()) ?? undefined;
      this.failedTxCursorState = failedTxCursor ?? null;
    }

    // `expectedFrom` is the earliest ledger the listener has not yet confirmed
    // coverage through: `startLedger` for a fresh range request, or the ledger
    // *after* a resumed cursor. `null` means "cannot be known", in which case gap
    // detection is skipped rather than guessed at.
    let expectedFrom: number | null;
    if (cursor !== undefined) {
      expectedFrom = params.resumeLedger === undefined ? null : params.resumeLedger + 1;
    } else {
      if (startLedger === undefined) {
        const latest = await this.config.server.getLatestLedger();
        startLedger = Math.max(1, latest.sequence - 1);
      }
      expectedFrom = startLedger;
    }

    while (!signal?.aborted) {
      let page: PollResult;
      let attempts = 0;
      try {
        page = await this.poll({
          ...(startLedger !== undefined ? { startLedger } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        });
        this.recordHealthyPoll(page);
      } catch (error) {
        this.recordFailedPoll();
        // Abort landed while this request was in flight. The request itself
        // cannot be cancelled — `@stellar/stellar-sdk`'s `getEvents` accepts no
        // signal — so the caller's stop request usually shows up here, as the
        // rejection of the request it arrived during. That is teardown, not a
        // telemetry failure: end the stream quietly instead of throwing at the
        // `for await` consumer or leaving an unhandled rejection behind.
        if (signal?.aborted) {
          this.logger.debug("telemetry watch aborted with a request in flight", {
            guard: this.config.guard,
          });
          return;
        }
        // Bounded retry with backoff, then a fail-visible end: call
        // `onStreamError` once with the terminal error and complete the
        // iterator normally. A callback that throws propagates (the consumer
        // asked for it); without a callback the error is retrievable via
        // `getLastError()`.
        const maxAttempts = 5;
        let terminal: unknown = error;
        let recovered: PollResult | null = null;
        while (attempts < maxAttempts) {
          attempts += 1;
          const backoff = Math.min(interval, 100 * 2 ** (attempts - 1));
          await raceAbort(signal, () => sleep(backoff, signal));
          if (signal?.aborted) return;
          try {
            recovered = await this.poll({
              ...(startLedger !== undefined ? { startLedger } : {}),
              ...(cursor !== undefined ? { cursor } : {}),
              ...(params.limit !== undefined ? { limit: params.limit } : {}),
            });
            break;
          } catch (retryError) {
            if (signal?.aborted) return;
            terminal = retryError;
            this.recordFailedPoll();
          }
        }
        if (recovered === null) {
          this.logger.warn(
            `telemetry poll failed: ${terminal instanceof Error ? terminal.message : String(terminal)}`,
            { guard: this.config.guard },
          );
          this.lastError = terminal;
          this.lastErrorAt = this.nowIso();
          this.healthState = "failed";
          if (params.onStreamError) params.onStreamError(terminal);
          return;
        }
        this.recordHealthyPoll(recovered);
        page = recovered;
      }
      cursor = page.cursor;
      // Once a cursor is held, the ledger range must not be sent again — the RPC
      // rejects a request that mixes the two modes.
      startLedger = undefined;

      let failedTxEvents: GuardEvent[] = [];
      if (this.config.failedTx) {
        try {
          const failedTxPage = await this.pollFailedTransactions({
            ...(failedTxCursor !== undefined ? { cursor: failedTxCursor } : {}),
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
          });
          failedTxCursor = failedTxPage.cursor;
          failedTxEvents = failedTxPage.events;
          // Persist the failed-tx stream's own cursor, independently of the
          // getEvents cursor (issue #279). A failed scan leaves the stored
          // cursor untouched so the page is retried after a restart.
          if (!this.failedTxScanFailed) {
            await this.activeFailedTxCursorStore.save(failedTxPage.cursor);
          }
        } catch {
          // This optional stream must not interrupt committed event polling.
        }
      }

      // ── Gap detection ────────────────────────────────────────────────────
      // The retention window is reported on every response, so the rule is
      // exact rather than heuristic: coverage is broken precisely when the
      // earliest ledger the listener still needs is older than the oldest ledger
      // the RPC retains. Event *density* plays no part — an empty page inside the
      // window is silence, not loss — so a sparse but fully-retained history
      // cannot raise a false notice. No events are fabricated for the hole.
      if (
        params.onGap &&
        expectedFrom !== null &&
        page.oldestLedger !== null &&
        expectedFrom < page.oldestLedger
      ) {
        const gap: GuardTelemetryGap = {
          fromLedger: expectedFrom,
          toLedger: page.oldestLedger - 1,
          reason: "history_pruned",
          retainedFromLedger: page.oldestLedger,
          retainedToLedger: page.latestLedger,
        };
        // Also reported through the logger, because `onGap` is only wired when a
        // caller supplies it and a pruned range is worth seeing in a log even
        // for a listener that did not ask for a callback.
        this.logger.warn(
          `telemetry coverage gap: ledgers ${gap.fromLedger}-${gap.toLedger} are no longer retained by the RPC`,
          { ...gap, guard: this.config.guard },
        );
        this.recordedGaps.push({ ...gap });
        if (this.recordedGaps.length > MAX_RECORDED_GAPS) this.recordedGaps.shift();
        try {
          params.onGap(gap);
        } catch {
          // A consumer's alerting failure must not stop the stream: the notice
          // is advisory, and swallowing it mirrors `onStep`'s isolation.
        }
      }

      if (params.onUnknownTopics && page.unknownTopics.length > 0) {
        try {
          params.onUnknownTopics(page.unknownTopics);
        } catch {
          // Observability must not be able to stop telemetry: the same isolation
          // contract as `onGap`.
        }
      }

      const events = [...page.events, ...failedTxEvents];

      // Counters are fed here, at the one place a page's events become the
      // caller's, so every entry point counts each committed/failed-tx
      // decision exactly once (#321). `watchAll()` records only the
      // diagnostic half of its merged stream for the same reason.
      for (const event of events) this.counters?.record(event);

      await this.activeCursorStore.save(page.cursor);
      
      if (events.length > 0) yield events;

      // Advance confirmed coverage. A page that reached the RPC's head confirms
      // everything up to `latestLedger`; a full page (a partial window, more to
      // come) confirms only through its last event, leaving the boundary check
      // active for the next poll.
      const ledgers = page.events
        .map((event) => event.ledger)
        .filter((ledger): ledger is number => ledger !== null);
      const fullPage = params.limit !== undefined && page.events.length >= params.limit;
      expectedFrom =
        fullPage && ledgers.length > 0
          ? Math.max(...ledgers) + 1
          : page.latestLedger + 1;

      if (signal?.aborted) return;
      const delay = computePollDelay(interval, jitter, rng);
      // Abort-aware: otherwise a caller that aborts mid-interval waits out the
      // whole poll delay (5s by default, jittered) before the iterator ends.
      await raceAbort(signal, () => sleep(delay, signal));
    }
  }

  /**
   * Follow **both** of the listener's streams as one ordered stream of
   * `GuardEvent`s (issue #67).
   *
   * `watch()` tails committed ledger events only, so a consumer that reads just
   * it watches a guard that never blocks — a refusal is rolled back before
   * broadcast and exists only as a simulation diagnostic. `watchAll()` merges
   * the committed stream with the `diagnostics` the caller feeds in, tags every
   * event with `stream` (`committed` | `diagnostic`) and `observedAt`, and
   * de-duplicates by `id`. The ordering and de-duplication rules are documented
   * on `mergeGuardEventStreams()` and in `docs/event-schema.md`.
   *
   * `watch()` is untouched: this is additive, and the default path still yields
   * committed events only. `signal` ends this stream too (it is forwarded to
   * both `watch()` and the merge, so a pending diagnostic source cannot hold it
   * open past teardown).
   */
  async *watchAll(
    params: GuardTelemetryUnifiedParams = {},
  ): AsyncGenerator<GuardEvent, void, undefined> {
    const lease = this.acquireStreamLease("watchAll");
    this.healthStream = "watchAll";
    try {
      if (params.signal?.aborted) return;
      for await (const event of mergeGuardEventStreams(
        this.watchStream(params),
        params.diagnostics,
        params.signal,
      )) {
        // Committed and failed-tx events were already counted by the page loop
        // in `watchStream()`, so only the diagnostic half is counted here —
        // counting the merged stream wholesale would double every event the
        // committed side contributed.
        if (event.stream === "diagnostic") {
          this.counters?.record(event);
          this.record([event]);
        }
        yield event;
      }
    } finally {
      this.finishHealthStream(params.signal);
      this.healthStream = null;
      this.releaseStreamLease(lease);
    }
  }
}

/** Options accepted by `GuardTelemetryListener`. */
export interface GuardTelemetryListenerOptions {
  /**
   * Opt-in sliding-window counters over allowed/blocked decisions. Absent →
   * no counter state is allocated and `stats()` returns `null`.
   */
  counters?: GuardTelemetryCountersOptions;
}

/**
 * Convenience: interpret one `PreFlightDecision`'s diagnostics into events.
 *
 * Accepts a preflight or simulation decision object, and extracts GuardEvents
 * from its `diagnosticEvents` array if the decision outcome was `blocked`.
 * Distinct from `guardEventsFromDiagnostics` which operates on raw diagnostic
 * event arrays directly; both delegate to canonical `diagnosticsToEvents`.
 */
export function telemetryFromDecision(
  decision: { kind: string; diagnosticEvents?: unknown[]; reason?: string },
  guard: string,
  options?: GuardEventDecodeOptions,
): GuardEvent[] {
  if (decision.kind !== "blocked" || !decision.diagnosticEvents) return [];
  return diagnosticsToEvents(decision.diagnosticEvents, guard, options);
}

/** True when a decoded decision means the guard permitted the action. */
export function isAllowedDecision(decision: GuardAuthDecision | null): boolean {
  return decision?.result === GUARD_AUTH_RESULTS.allowed;
}

/**
 * The top-level key order `serializeEvent()` emits, pinned to the `GuardEvent`
 * field reference in `docs/event-schema.md`: the identity fields first, then the
 * stream facts, then the decoded decision and data.
 *
 * This is an explicit, frozen projection rather than an object spread, so adding
 * a field to `GuardEvent` cannot silently change the serialized shape (or its
 * key order) — a new field must be added here deliberately, and its addition is
 * a visible golden-string diff in `tests/unit/serialize-event.test.ts`.
 */
const EVENT_KEY_ORDER = [
  "id",
  "kind",
  "topic",
  "source",
  "stream",
  "contractId",
  "ledger",
  "ledgerClosedAt",
  "observedAt",
  "transactionHash",
  "decision",
  "data",
] as const;

/** The nested key order `serializeEvent()` emits for `decision`. */
const DECISION_KEY_ORDER = ["result", "reason", "source"] as const;

/**
 * Recursively project a decoded value into the JSON-safe shape `serializeEvent()`
 * ships, matching the repo's normalization policy (`normalizeEventData` +
 * `stableStringify`):
 *
 * - `undefined` is **dropped** from objects (the documented empty-field policy)
 *   and rendered as `null` inside arrays, so indices stay stable;
 * - `null` is kept — it is a real value on stream-dependent fields, not absence;
 * - `bigint` becomes a decimal **string** (no `n` suffix), because `JSON.stringify`
 *   throws on a bigint and a logger needs a value `JSON.parse` can read back;
 * - a `Uint8Array`/`Buffer` becomes `bytes:<hex>`, the rendering `stableStringify`
 *   already uses for hashing.
 */
function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (value instanceof Uint8Array) return `bytes:${bytesToHex(value)}`;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = toJsonSafe(item);
      return normalized === undefined ? null : normalized;
    });
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = toJsonSafe(item);
    if (normalized !== undefined) out[key] = normalized;
  }
  return out;
}

/**
 * Canonical one-line JSON for a `GuardEvent`, for deterministic JSON-lines log
 * shipping (issue #130).
 *
 * The output is a stable serialization, not a debugging convenience:
 *
 * - **Key order is fixed** (see `EVENT_KEY_ORDER`), so the same event always
 *   renders byte-for-byte identically and a log line can be diffed.
 * - **`undefined` fields are dropped; `null` is kept.** Absence is expressed by
 *   the key not being present, while `null` remains a real value on the
 *   stream-dependent fields (`ledger`, `transactionHash`, …).
 * - **`bigint` is rendered as a decimal string.** `JSON.stringify` throws on a
 *   bigint, so the decoded `data.at` (a u64 `bigint`) must be converted; decimal
 *   is used over the hashing form `…n` so `JSON.parse` reads a normal string.
 * - **Round-trip:** `JSON.parse(serializeEvent(e))` is shape-equal to `e` modulo
 *   those normalizations (`bigint` → decimal string, `Uint8Array` → `bytes:…`,
 *   `undefined` → absent).
 *
 * The exact contract — order and policies — is documented in
 * `docs/event-schema.md` under "Canonical JSON serialization".
 */
export function serializeEvent(event: GuardEvent): string {
  return JSON.stringify(toJsonSafe(projectEvent(event)));
}

/** The bare, unversioned projection `serializeEvent()` has always emitted. */
function projectEvent(event: GuardEvent): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of EVENT_KEY_ORDER) {
    const value = event[key];
    if (value === undefined) continue;
    projected[key] = value;
  }
  if (event.decision !== undefined && event.decision !== null) {
    const decision: Record<string, unknown> = {};
    for (const key of DECISION_KEY_ORDER) {
      const value = event.decision[key];
      if (value === undefined) continue;
      decision[key] = value;
    }
    projected.decision = decision;
  }
  return projected;
}

/**
 * Current version of the serialized event-record envelope (#323).
 *
 * `serializeEvent()` remains the unversioned v0 format it has always been: its
 * output is a documented **Stable** contract, so changing it in place would
 * silently break every consumer of stored JSON-lines. Persisted records instead
 * opt in to `serializeEventRecord()`, whose envelope carries this version
 * explicitly. A legacy line is identifiable by the absence of `v` (v0).
 */
export const TELEMETRY_EVENT_RECORD_VERSION = 1;

/**
 * One versioned, JSON-safe telemetry record: `{ "v": 1, "event": { ... } }`.
 *
 * The envelope keeps the event projection byte-identical to `serializeEvent()`'s
 * output — only the version wrapper is new — so a v1 reader can hand `event` to
 * any existing consumer, and a v0 reader that ignores unknown top-level keys can
 * still find the event fields. See `docs/event-schema.md` for the migration
 * note and `tests/fixtures/telemetry/event-record-v1.golden.json` for the golden
 * fixture.
 */
export interface GuardEventRecord {
  /** Envelope schema version; `TELEMETRY_EVENT_RECORD_VERSION` at write time. */
  v: number;
  /** The canonical event projection, identical to `serializeEvent()`'s object. */
  event: Record<string, unknown>;
}

/**
 * Serialize one event inside a versioned envelope, for persisted JSON-lines.
 *
 * Rendering rules are exactly `serializeEvent()`'s (fixed key order, drop
 * `undefined`, keep `null`, `bigint` → decimal string, bytes → `bytes:<hex>`),
 * so the value is JSON-safe and deterministic. The envelope adds `v` as the
 * first key; `event` follows with the historical field order.
 */
export function serializeEventRecord(event: GuardEvent): string {
  const record: GuardEventRecord = {
    v: TELEMETRY_EVENT_RECORD_VERSION,
    event: projectEvent(event),
  };
  return JSON.stringify(toJsonSafe(record));
}

/**
 * Render an event sequence as bounded JSON Lines (#324): one
 * `serializeEventRecord()` per event, newline-terminated, in iteration order.
 *
 * Deliberately synchronous and allocation-only: no file handle, no stream, no
 * buffer copy beyond the output string. A caller exporting the listener's
 * `recent()` window gets exactly the bounded snapshot it asked for, and a
 * caller with its own store can render any iterable with the same rules.
 *
 * Every line is a complete, independently parsable record
 * (`parseEventRecord()`), so a partially written export is still a valid prefix
 * of complete records — there is no trailing half-line to special-case.
 * `raw` is never emitted: the projection is a fixed field list, so a retained
 * debug payload cannot ride along into a shared incident bundle.
 */
export function serializeEventLines(events: Iterable<GuardEvent>): string {
  let out = "";
  for (const event of events) out += `${serializeEventRecord(event)}\n`;
  return out;
}

/** The result of reading one stored telemetry line. */
export interface ParsedGuardEventRecord {
  /**
   * `0` for a legacy bare event line written before the envelope existed,
   * otherwise the envelope's `v`. A version greater than
   * `TELEMETRY_EVENT_RECORD_VERSION` is returned as-is so a caller can detect a
   * record written by a newer SDK rather than silently mis-order its fields.
   */
  version: number;
  /** The event projection, unmodified. */
  event: Record<string, unknown>;
}

/**
 * Read one stored telemetry line, versioned or legacy (#323).
 *
 * Older records remain identifiable: a bare event line (no `v` key) is
 * reported as `version: 0`, while an envelope reports its own version. The
 * parser is deliberately shallow — it identifies the format, it does not
 * validate every event field — so an unknown-but-newer record is still
 * inspectable. Malformed input throws `TypeError` rather than being guessed at.
 */
export function parseEventRecord(line: string): ParsedGuardEventRecord {
  const parsed: unknown = JSON.parse(line);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("telemetry record must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (!("v" in record)) {
    return { version: 0, event: record };
  }
  const version = record.v;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new TypeError("telemetry record `v` must be a positive integer");
  }
  const event = record.event;
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("telemetry record `event` must be a JSON object");
  }
  return { version, event: event as Record<string, unknown> };
}

/** A compact one-line rendering of a guard event, for logs. */
export function describeGuardEvent(event: GuardEvent): string {
  const where =
    event.stream === "committed"
      ? `ledger ${event.ledger ?? "?"}`
      : event.stream === "failed_tx"
        ? `failed tx ${event.transactionHash?.slice(0, 8) ?? "?"}`
        : "pre-broadcast";
  const what =
    event.kind === "auth_checked"
      ? `${event.decision?.result ?? "?"}${event.decision?.reason ? ` (${event.decision.reason})` : ""}`
      : event.kind;
  return `${where}: ${event.topic} → ${what}`;
}