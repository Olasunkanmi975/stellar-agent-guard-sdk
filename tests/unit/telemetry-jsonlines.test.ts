/**
 * Bounded JSON Lines export of recent events (issue #324).
 *
 * The export has to be deterministic and parseable without the SDK's own
 * bigint/byte rules leaking into a consumer: `serializeEventRecord()` already
 * defines the rendering, and `recentJsonLines()` must be nothing more than that
 * projection applied to the retained window — no file, no stream, no `raw`
 * payload.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rpc, xdr } from "@stellar/stellar-sdk";
import {
  GuardTelemetryListener,
  parseEventRecord,
  serializeEventLines,
  serializeEventRecord,
  TELEMETRY_EVENT_RECORD_VERSION,
  type GuardEvent,
} from "../../src/telemetry.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const TX = "ab".repeat(32);

function committed(index: number, data: unknown = {}): GuardEvent {
  return {
    id: `ledger:${TX}:event_auth_checked:${index}`,
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "ledger",
    stream: "committed",
    contractId: GUARD,
    ledger: 500 + index,
    ledgerClosedAt: "2026-09-14T00:00:00Z",
    observedAt: null,
    transactionHash: TX,
    decision: { result: "allowed", reason: null, source: "ledger" },
    data,
  };
}

function diagnostic(index: number): GuardEvent {
  return {
    id: `diag:${index.toString(16).padStart(64, "0")}`,
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "diagnostic",
    stream: "diagnostic",
    contractId: GUARD,
    ledger: null,
    ledgerClosedAt: null,
    observedAt: "2026-09-14T00:00:01Z",
    transactionHash: null,
    decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
    data: {},
  };
}

function lines(text: string): string[] {
  assert.ok(text.endsWith("\n") || text === "", "every record is newline-terminated");
  return text === "" ? [] : text.slice(0, -1).split("\n");
}

describe("serializeEventLines (issue #324)", () => {
  it("emits one versioned, independently parsable record per event", () => {
    const events = [committed(0), diagnostic(1)];
    const out = serializeEventLines(events);
    const parsed = lines(out).map((line) => parseEventRecord(line));

    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed.map((record) => record.version), [
      TELEMETRY_EVENT_RECORD_VERSION,
      TELEMETRY_EVENT_RECORD_VERSION,
    ]);
    assert.deepEqual(parsed.map((record) => record.event.stream), ["committed", "diagnostic"]);
    assert.deepEqual(parsed.map((record) => record.event.id), events.map((event) => event.id));
  });

  it("is byte-for-byte deterministic and matches serializeEventRecord line for line", () => {
    const events = [committed(0, { at: 1n }), diagnostic(2), committed(3)];
    const first = serializeEventLines(events);
    const second = serializeEventLines(events);
    assert.equal(first, second);
    assert.deepEqual(lines(first), events.map((event) => serializeEventRecord(event)));
  });

  it("renders bigint and byte payloads JSON-safely", () => {
    const out = serializeEventLines([committed(0, { at: 9_007_199_254_740_993n, note: new Uint8Array([1, 2, 255]) })]);
    const [record] = lines(out).map((line) => parseEventRecord(line));
    assert.ok(record);
    const data = record!.event.data as Record<string, unknown>;
    // A decimal string, not a JSON number (which would lose precision) and not
    // the hashing form with an `n` suffix.
    assert.equal(data.at, "9007199254740993");
    assert.equal(data.note, "bytes:0102ff");
    assert.equal(typeof data.at, "string");
  });

  it("returns an empty string for an empty sequence", () => {
    assert.equal(serializeEventLines([]), "");
  });

  it("never serializes a retained raw payload", () => {
    const withRaw: GuardEvent = {
      ...committed(0),
      raw: { marker: "RAW-PAYLOAD-MUST-NOT-SHIP", nested: new Uint8Array([9]) },
    };
    const out = serializeEventLines([withRaw]);
    assert.ok(!out.includes("RAW-PAYLOAD-MUST-NOT-SHIP"));
    assert.ok(!out.includes("\"raw\""));
    assert.deepEqual(Object.keys(parseEventRecord(lines(out)[0]!).event), [
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
    ]);
  });
});

/** A raw committed page the listener can decode, one event per ledger. */
function ledgerPage(ledgers: number[], cursor: string) {
  return {
    cursor,
    latestLedger: 500,
    events: ledgers.map((ledger) => ({
      contractId: GUARD,
      type: "contract" as const,
      topic: [xdr.ScVal.scvSymbol("event_heartbeat")],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("at"), val: xdr.ScVal.scvU64(BigInt(ledger)) }),
      ]),
      ledger,
      ledgerClosedAt: null,
      txHash: `tx-${ledger}`,
    })),
  };
}

function listenerServing(pages: ReturnType<typeof ledgerPage>[], bufferMax: number) {
  let calls = 0;
  const server = {
    async getEvents() {
      const page = pages[calls];
      calls += 1;
      if (!page) throw new Error("no page scripted");
      return page;
    },
    async getLatestLedger() {
      return { sequence: 500 };
    },
  };
  return new GuardTelemetryListener({
    server: server as unknown as rpc.Server,
    guard: GUARD,
    buffer: { max: bufferMax },
  });
}

describe("GuardTelemetryListener.recentJsonLines (issue #324)", () => {
  it("returns an empty export when no buffer is configured", () => {
    const listener = new GuardTelemetryListener({ counters: { windowEvents: 5 } });
    assert.equal(listener.recentJsonLines(), "");
  });

  it("exports the bounded window in observation order", async () => {
    const listener = listenerServing([ledgerPage([501, 502, 503], "cursor-1")], 2);
    await listener.poll({ startLedger: 500, cursor: "cursor-0" });
    const ids = lines(listener.recentJsonLines()).map(
      (line) => parseEventRecord(line).event.id,
    );
    assert.deepEqual(ids, ["ledger:tx-502:event_heartbeat", "ledger:tx-503:event_heartbeat"], "the window is bounded");
  });

  it("applies the same filter surface as recent()", async () => {
    const listener = listenerServing([ledgerPage([501, 502], "cursor-1")], 10);
    await listener.poll({ startLedger: 500, cursor: "cursor-0" });
    assert.equal(lines(listener.recentJsonLines({ fromLedger: 502 })).length, 1);
    assert.deepEqual(lines(listener.recentJsonLines({ toLedger: 501 })).length, 1);
    assert.equal(lines(listener.recentJsonLines({ reason: "per_tx_cap_exceeded" })).length, 0);
  });

  it("is deterministic across calls and does not leak a mutated snapshot back", async () => {
    const listener = listenerServing([ledgerPage([501], "cursor-1")], 10);
    await listener.poll({ startLedger: 500, cursor: "cursor-0" });
    const first = listener.recentJsonLines();
    assert.equal(listener.recentJsonLines(), first);
    // The snapshot is detached: exporting cannot mutate the retained event.
    (listener.recent()[0]!.data as { at: bigint }).at = 999n;
    assert.equal(listener.recentJsonLines(), first);
  });
});
