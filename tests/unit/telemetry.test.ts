/**
 * Unit tests for the telemetry decoder's pure parts.
 *
 * The payloads here are not invented: they are verbatim diagnostic event shapes
 * captured from the live testnet run recorded in `docs/event-schema.md`, wrapped
 * in the `xdr.ScVal` form the RPC actually returns. Reconstructing them by hand
 * instead would test the test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StrKey, xdr } from "@stellar/stellar-sdk";
import {
  DEFAULT_JITTER_FRACTION,
  GuardEventRingBuffer,
  GuardTelemetryListener,
  computePollDelay,
  describeGuardEvent,
  diagnosticsToEvents,
  guardEventId,
  guardEventsFromDiagnostics,
  isAllowedDecision,
  mergeGuardEventStreams,
  telemetryFromDecision,
  type GuardDiagnosticBatch,
  type GuardEvent,
  type GuardTelemetryGap,
  type RecentEventFilter,
} from "../../src/telemetry.ts";
import { unsafeContractAddress } from "../../src/policy.ts";

const GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");

/**
 * Build a diagnostic event in the shape the RPC returns: the host's own
 * diagnostic events arrive as `{ event: { contractId, body: { v0: {...} } } }`
 * with topics as `ScVal`s.
 */
function diagnosticEvent(topics: string[], data: xdr.ScVal = xdr.ScVal.scvMap([])) {
  return {
    event: {
      contractId: GUARD,
      type: "contract",
      body: {
        v0: {
          topics: topics.map((topic) => xdr.ScVal.scvSymbol(topic)),
          data,
        },
      },
    },
  };
}

describe("guardEventsFromDiagnostics", () => {
  it("decodes a real blocked decision from the captured event", () => {
    const events = guardEventsFromDiagnostics(
      [diagnosticEvent(["event_auth_checked", "blocked", "per_tx_cap_exceeded"])],
      GUARD,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "auth_checked");
    assert.equal(events[0]!.decision?.result, "blocked");
    assert.equal(events[0]!.decision?.reason, "per_tx_cap_exceeded");
    assert.equal(events[0]!.source, "diagnostic");
  });

  it("ignores host diagnostics that are not guard events", () => {
    const events = guardEventsFromDiagnostics(
      [
        diagnosticEvent(["fn_call", "transfer"]),
        diagnosticEvent(["error", "scecExceededLimit"]),
        diagnosticEvent(["core_metrics", "cpu_insn"]),
      ],
      GUARD,
    );
    assert.deepEqual(events, []);
  });

  it("keeps only the guard event when mixed with host noise", () => {
    const events = guardEventsFromDiagnostics(
      [
        diagnosticEvent(["fn_call", "transfer"]),
        diagnosticEvent(["event_auth_checked", "blocked", "window_cap_exceeded"]),
        diagnosticEvent(["core_metrics", "write_entry"]),
      ],
      GUARD,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.decision?.reason, "window_cap_exceeded");
  });

  it("decodes an allowed decision and normalises its empty reason symbol", () => {
    const events = guardEventsFromDiagnostics(
      [diagnosticEvent(["event_auth_checked", "allowed", ""])],
      GUARD,
    );
    assert.equal(events[0]!.decision?.result, "allowed");
    assert.equal(events[0]!.decision?.reason, null);
    assert.equal(isAllowedDecision(events[0]!.decision), true);
  });

  it("decodes heartbeat data as a timestamp payload, not a topic", () => {
    const events = guardEventsFromDiagnostics(
      [
        diagnosticEvent(
          ["event_heartbeat"],
          xdr.ScVal.scvMap([
            // XDR uint64 is a native bigint in this SDK, not a constructible class.
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("at"), val: xdr.ScVal.scvU64(1789393232n) }),
          ]),
        ),
      ],
      GUARD,
    );
    assert.equal(events[0]!.kind, "heartbeat");
    assert.equal(events[0]!.decision, null);
    assert.equal(String((events[0]!.data as { at: bigint }).at), "1789393232");
  });

  it("returns nothing for a decision with no diagnostics", () => {
    assert.deepEqual(guardEventsFromDiagnostics([]), []);
  });
});

describe("telemetryFromDecision", () => {
  it("extracts events from a blocked pre-flight decision", () => {
    const events = telemetryFromDecision(
      {
        kind: "blocked",
        reason: "recipient_not_allowed",
        diagnosticEvents: [diagnosticEvent(["event_auth_checked", "blocked", "recipient_not_allowed"])],
      },
      GUARD,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.decision?.reason, "recipient_not_allowed");
  });

  it("returns nothing for an admissible decision, which has no diagnostics", () => {
    assert.deepEqual(telemetryFromDecision({ kind: "admissible" }, GUARD), []);
  });
});

describe("diagnosticsToEvents & decode equivalence", () => {
  it("decodes diagnostic events directly via canonical diagnosticsToEvents", () => {
    const rawEvents = [
      diagnosticEvent(["fn_call", "transfer"]),
      diagnosticEvent(["event_auth_checked", "blocked", "window_cap_exceeded"]),
    ];
    const events = diagnosticsToEvents(rawEvents, GUARD);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "auth_checked");
    assert.equal(events[0]!.decision?.result, "blocked");
    assert.equal(events[0]!.decision?.reason, "window_cap_exceeded");
    assert.equal(events[0]!.source, "diagnostic");
    assert.equal(events[0]!.contractId, GUARD);
  });

  it("yields identical output from guardEventsFromDiagnostics and telemetryFromDecision for equivalent inputs", () => {
    const diagEvents = [
      diagnosticEvent(["event_auth_checked", "blocked", "per_tx_cap_exceeded"]),
      diagnosticEvent(["core_metrics", "cpu_insn"]),
    ];

    const fromDiagnostics = guardEventsFromDiagnostics(diagEvents, GUARD);
    const fromDecision = telemetryFromDecision(
      {
        kind: "blocked",
        reason: "per_tx_cap_exceeded",
        diagnosticEvents: diagEvents,
      },
      GUARD,
    );
    const fromCanonical = diagnosticsToEvents(diagEvents, GUARD);

    assert.deepEqual(fromDiagnostics, fromDecision);
    assert.deepEqual(fromDiagnostics, fromCanonical);
    assert.equal(fromDiagnostics.length, 1);
    assert.equal(fromDiagnostics[0]!.decision?.reason, "per_tx_cap_exceeded");
  });

  it("tags decoded diagnostic events with stream=diagnostic and a null observedAt", () => {
    // The `stream` discriminator is additive (issue #67): present on every
    // decoded event, derived from `source`, and `observedAt` is left null so
    // only the unified stream stamps a real observation time.
    const events = guardEventsFromDiagnostics(
      [diagnosticEvent(["event_auth_checked", "blocked", "per_tx_cap_exceeded"])],
      GUARD,
    );
    assert.equal(events[0]!.stream, "diagnostic");
    assert.equal(events[0]!.source, "diagnostic");
    assert.equal(events[0]!.observedAt, null);
  });
});

describe("describeGuardEvent", () => {
  it("labels a ledger event with its ledger number and outcome", () => {
    const text = describeGuardEvent({
      id: `ledger:${"ab".repeat(32)}:event_auth_checked`,
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "ledger",
      stream: "committed",
      contractId: GUARD,
      ledger: 4674314,
      ledgerClosedAt: null,
      observedAt: null,
      transactionHash: "ab".repeat(32),
      decision: { result: "allowed", reason: null, source: "ledger" },
      data: {},
    });
    assert.match(text, /ledger 4674314/);
    assert.match(text, /allowed/);
  });

  it("labels a blocked decision as pre-broadcast, since it has no ledger", () => {
    const text = describeGuardEvent({
      id: `diag:${"0".repeat(64)}`,
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "diagnostic",
      stream: "diagnostic",
      contractId: GUARD,
      ledger: null,
      ledgerClosedAt: null,
      observedAt: null,
      transactionHash: null,
      decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
      data: {},
    });
    assert.match(text, /pre-broadcast/);
    assert.match(text, /per_tx_cap_exceeded/);
  });
});

/**
 * Stable-id coverage (issue #33).
 *
 * A blocked decision is rolled back before broadcast, so it has no transaction
 * to anchor on — the only way a telemetry consumer can tell two refusals apart,
 * or recognise a re-parse as the same refusal, is the `id` the SDK derives.
 * Both properties are pinned here: determinism across re-parses, and
 * distinctness between two different blocks inside one simulation.
 */
describe("GuardEvent.id", () => {
  const blocked = (reason: string) =>
    diagnosticEvent(["event_auth_checked", "blocked", reason]);

  it("gives every decoded diagnostic event a non-null synthetic id", () => {
    const events = guardEventsFromDiagnostics([blocked("per_tx_cap_exceeded")], GUARD);
    assert.equal(events.length, 1);
    assert.ok(events[0]!.id.length > 0, "id must never be empty");
    assert.match(events[0]!.id, /^diag:[0-9a-f]{64}$/);
  });

  it("is deterministic: the same diagnostic event re-parsed yields the same id", () => {
    const batch = [blocked("per_tx_cap_exceeded"), blocked("recipient_not_allowed")];
    const first = guardEventsFromDiagnostics(batch, GUARD);
    const second = guardEventsFromDiagnostics(batch, GUARD);
    assert.deepEqual(
      first.map((event) => event.id),
      second.map((event) => event.id),
    );
  });

  it("keeps two distinct blocks in one simulation distinct, because their positions differ", () => {
    // Same topic list, same data: only the position within the batch separates
    // them, which is exactly the case a txHash-based id could not cover.
    const events = guardEventsFromDiagnostics([blocked("per_tx_cap_exceeded"), blocked("per_tx_cap_exceeded")], GUARD);
    assert.equal(events.length, 2);
    assert.notEqual(events[0]!.id, events[1]!.id);
  });

  it("gives the same ledger transaction's several events distinct ids", () => {
    // A heartbeat transaction commits both event_auth_checked and
    // event_heartbeat (live capture in docs/event-schema.md), so the txHash
    // alone is not an identity.
    const txHash = "ab".repeat(32);
    const decision = guardEventId({
      source: "ledger",
      topics: ["event_auth_checked", "allowed", ""],
      data: {},
      contractId: GUARD,
      ledger: 4674314,
      transactionHash: txHash,
      simulationIndex: null,
    });
    const heartbeat = guardEventId({
      source: "ledger",
      topics: ["event_heartbeat"],
      data: { at: 1789393232n },
      contractId: GUARD,
      ledger: 4674314,
      transactionHash: txHash,
      simulationIndex: null,
    });
    assert.notEqual(decision, heartbeat);
    assert.equal(decision, `ledger:${txHash}:event_auth_checked`);
    assert.equal(heartbeat, `ledger:${txHash}:event_heartbeat`);
  });

  it("anchors a committed event on its transaction hash, not on its page position", () => {
    const first = guardEventId({
      source: "ledger",
      topics: ["event_auth_checked", "blocked", "per_tx_cap_exceeded"],
      data: {},
      contractId: GUARD,
      ledger: 4674314,
      transactionHash: "cd".repeat(32),
      simulationIndex: null,
    });
    const second = guardEventId({
      source: "ledger",
      topics: ["event_auth_checked", "blocked", "per_tx_cap_exceeded"],
      data: {},
      contractId: GUARD,
      ledger: 9999999,
      transactionHash: "cd".repeat(32),
      simulationIndex: null,
    });
    assert.equal(first, second, "re-polling the ledger must not renumber an event");
  });

  it("falls back to the ledger sequence when a committed event arrives without a hash", () => {
    const id = guardEventId({
      source: "ledger",
      topics: ["event_heartbeat"],
      data: null,
      contractId: GUARD,
      ledger: 4674314,
      transactionHash: null,
      simulationIndex: null,
    });
    assert.equal(id, "ledger:4674314:event_heartbeat");
  });

  it("separates the two streams even when the content is identical", () => {
    const topics = ["event_auth_checked", "blocked", "per_tx_cap_exceeded"];
    const committed = guardEventId({
      source: "ledger",
      topics,
      data: {},
      contractId: GUARD,
      ledger: 4674314,
      transactionHash: "ab".repeat(32),
      simulationIndex: null,
    });
    const diagnostic = guardEventId({
      source: "diagnostic",
      topics,
      data: {},
      contractId: GUARD,
      ledger: null,
      transactionHash: null,
      simulationIndex: 0,
    });
    assert.match(committed, /^ledger:/);
    assert.match(diagnostic, /^diag:/);
    assert.notEqual(committed, diagnostic);
  });

  it("does not let object key order in decoded data change the id", () => {
    const base = {
      source: "diagnostic" as const,
      topics: ["event_heartbeat"],
      contractId: GUARD,
      ledger: null,
      transactionHash: null,
      simulationIndex: 0,
    };
    assert.equal(
      guardEventId({ ...base, data: { at: 1789393232n, by: null } }),
      guardEventId({ ...base, data: { by: null, at: 1789393232n } }),
    );
  });
});

describe("isAllowedDecision", () => {
  it("is false for a null decision rather than throwing", () => {
    assert.equal(isAllowedDecision(null), false);
  });
});

describe("telemetry polling jitter", () => {
  it("defaults to full jitter with documented fraction (0.2)", () => {
    assert.equal(DEFAULT_JITTER_FRACTION, 0.2);
    // RNG = 0 => delay = interval * (1 - 0.2) = 4000
    const minDelay = computePollDelay(5_000, "full", () => 0);
    assert.equal(minDelay, 4_000);

    // RNG = 1 => delay = interval * 1.0 = 5000
    const maxDelay = computePollDelay(5_000, "full", () => 1);
    assert.equal(maxDelay, 5_000);

    // RNG = 0.5 => delay = interval * 0.9 = 4500
    const midDelay = computePollDelay(5_000, "full", () => 0.5);
    assert.equal(midDelay, 4_500);
  });

  it("produces deterministic fixed interval when jitter is none", () => {
    const d1 = computePollDelay(5_000, "none", () => 0);
    const d2 = computePollDelay(5_000, "none", () => 0.5);
    const d3 = computePollDelay(5_000, "none", () => 1);
    assert.equal(d1, 5_000);
    assert.equal(d2, 5_000);
    assert.equal(d3, 5_000);
  });

  it("delays fall within expected range and differ across ticks", () => {
    const sequence = [0.1, 0.9, 0.4, 0.7, 0.0, 1.0];
    let idx = 0;
    const rng = () => sequence[idx++ % sequence.length]!;

    const delays = Array.from({ length: 6 }, () => computePollDelay(5_000, "full", rng));
    for (const d of delays) {
      assert.ok(d >= 4_000 && d <= 5_000, `Delay ${d} outside [4000, 5000]`);
    }
    // Verify variance across ticks
    assert.notEqual(delays[0], delays[1]);
    assert.notEqual(delays[1], delays[2]);
    assert.equal(delays[4], 4_000);
    assert.equal(delays[5], 5_000);
  });

  it("watch() applies jittered delays between polling ticks", async () => {
    const delaysRecorded: number[] = [];
    const fakeServer = {
      getLatestLedger: async () => ({ sequence: 100 }),
      getEvents: async () => ({
        events: [],
        cursor: "cursor_1",
        latestLedger: 100,
      }),
    };

    const listener = new GuardTelemetryListener({
      server: fakeServer as never,
      guard: GUARD,
    });

    const controller = new AbortController();
    const rngSequence = [0.0, 0.5, 1.0];
    let rngCall = 0;

    let tick = 0;
    const watcher = listener.watch({
      pollIntervalMs: 5_000,
      jitter: "full",
      rng: () => rngSequence[rngCall++ % rngSequence.length]!,
      sleep: async (ms) => {
        delaysRecorded.push(ms);
        tick++;
        if (tick >= 3) {
          controller.abort();
        }
      },
      signal: controller.signal,
    });

    // Run the generator
    for await (const _events of watcher) {
      // no events yielded since fake response is empty
    }

    assert.deepEqual(delaysRecorded, [4_000, 4_500, 5_000]);
  });
});

/**
 * Coverage-gap detection (issue #86).
 *
 * The RPC reports its retention window (`oldestLedger` / `latestLedger`) on
 * every `getEvents` response, so a pruned range is a fact the listener can
 * prove — not a guess inferred from how sparse the events look. These tests pin
 * both halves of that: a gap is reported once with the correct bounds, and a
 * simply-quiet range is not reported at all.
 */
describe("GuardTelemetryListener coverage-gap detection", () => {
  /** A committed ledger event in the shape `poll()` reads from the RPC. */
  function ledgerEvent(ledger: number) {
    return {
      contractId: GUARD,
      type: "contract",
      ledger,
      ledgerClosedAt: "2026-09-27T00:00:00Z",
      txHash: "ab".repeat(32),
      topic: ["event_auth_checked", "allowed", ""].map((topic) => xdr.ScVal.scvSymbol(topic)),
      value: xdr.ScVal.scvMap([]),
    };
  }

  /** A fake RPC serving queued getEvents pages, recording what it was asked. */
  function pagedServer(
    pages: Array<{ events: unknown[]; oldestLedger?: number; latestLedger: number }>,
  ) {
    let index = 0;
    return {
      getLatestLedger: async () => ({ sequence: pages[0]?.latestLedger ?? 1 }),
      getEvents: async () => {
        const page = pages[Math.min(index, pages.length - 1)]!;
        index += 1;
        return { ...page, cursor: `cursor_${index}` };
      },
    };
  }

  async function drainWatch(
    listener: GuardTelemetryListener,
    params: Parameters<GuardTelemetryListener["watch"]>[0],
    abortAfterTicks: number,
  ): Promise<GuardEvent[][]> {
    const controller = new AbortController();
    let ticks = 0;
    const batches: GuardEvent[][] = [];
    for await (const batch of listener.watch({
      ...params,
      sleep: async () => {
        if (++ticks >= abortAfterTicks) controller.abort();
      },
      signal: controller.signal,
    })) {
      batches.push(batch);
    }
    return batches;
  }

  it("exposes the retention boundary on poll() for callers managing their own loop", async () => {
    const server = pagedServer([{ events: [], oldestLedger: 4778215, latestLedger: 4899174 }]);
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    const page = await listener.poll({ startLedger: 4_899_000 });
    assert.equal(page.oldestLedger, 4_778_215);
    assert.equal(page.latestLedger, 4_899_174);
  });

  it("reports the pruned range exactly once when retention moved past a fresh startLedger", async () => {
    // Three polls, all with the retention edge at 500. The gap must be announced
    // on the first and then stay quiet — an alert per poll would be noise, and
    // coverage cannot un-break itself. Only the real ledger-500 event streams:
    // the missing range is reported, never filled with fabricated events.
    const server = pagedServer([
      { events: [ledgerEvent(500)], oldestLedger: 500, latestLedger: 600 },
      { events: [ledgerEvent(500)], oldestLedger: 500, latestLedger: 601 },
      { events: [ledgerEvent(500)], oldestLedger: 500, latestLedger: 602 },
    ]);
    const gaps: GuardTelemetryGap[] = [];
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    const batches = await drainWatch(
      listener,
      { startLedger: 100, onGap: (gap) => gaps.push(gap) },
      3,
    );

    assert.equal(gaps.length, 1, "once per discontinuity, not once per poll");
    assert.deepEqual(gaps[0], {
      fromLedger: 100,
      toLedger: 499,
      reason: "history_pruned",
      retainedFromLedger: 500,
      retainedToLedger: 600,
    });
    assert.deepEqual(
      batches.flat().map((event) => event.ledger),
      [500, 500, 500],
      "only real events stream — no dummies for the pruned range",
    );
  });

  it("does not report a gap when the requested range is inside the retention window", async () => {
    const server = pagedServer([
      { events: [ledgerEvent(100)], oldestLedger: 90, latestLedger: 120 },
    ]);
    const gaps: GuardTelemetryGap[] = [];
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    const batches = await drainWatch(
      listener,
      { startLedger: 100, onGap: (gap) => gaps.push(gap) },
      1,
    );
    assert.deepEqual(gaps, [], "a quiet-but-retained range is silence, not loss");
    assert.equal(batches.flat().length, 1);
  });

  it("uses the caller's resume ledger to prove a pruned cursor", async () => {
    const server = pagedServer([
      { events: [ledgerEvent(500)], oldestLedger: 500, latestLedger: 600 },
    ]);
    const gaps: GuardTelemetryGap[] = [];
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    await drainWatch(
      listener,
      { cursor: "saved_cursor", resumeLedger: 100, onGap: (gap) => gaps.push(gap) },
      1,
    );
    assert.deepEqual(gaps, [
      {
        fromLedger: 101,
        toLedger: 499,
        reason: "history_pruned",
        retainedFromLedger: 500,
        retainedToLedger: 600,
      },
    ]);
  });

  it("reports no gap for a cursor resume that is still inside retention", async () => {
    const server = pagedServer([
      { events: [ledgerEvent(400)], oldestLedger: 100, latestLedger: 600 },
    ]);
    const gaps: GuardTelemetryGap[] = [];
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    await drainWatch(
      listener,
      { cursor: "saved_cursor", resumeLedger: 100, onGap: (gap) => gaps.push(gap) },
      1,
    );
    assert.deepEqual(gaps, []);
  });

  it("cannot prove a gap from a cursor alone, and does not pretend to", async () => {
    const server = pagedServer([
      { events: [ledgerEvent(500)], oldestLedger: 500, latestLedger: 600 },
    ]);
    const gaps: GuardTelemetryGap[] = [];
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    await drainWatch(listener, { cursor: "saved_cursor", onGap: (gap) => gaps.push(gap) }, 1);
    assert.deepEqual(gaps, [], "without resumeLedger the boundary cannot be derived");
  });

  it("isolates a throwing onGap so the stream keeps yielding real events", async () => {
    const server = pagedServer([
      { events: [ledgerEvent(500)], oldestLedger: 500, latestLedger: 600 },
    ]);
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    const batches = await drainWatch(
      listener,
      {
        startLedger: 100,
        onGap: () => {
          throw new Error("alerting sink is down");
        },
      },
      1,
    );
    assert.equal(batches.flat().length, 1);
    assert.equal(batches.flat()[0]!.ledger, 500);
  });

  it("skips gap detection when the host reports no retention boundary", async () => {
    const server = {
      getLatestLedger: async () => ({ sequence: 100 }),
      getEvents: async () => ({ events: [], cursor: "c", latestLedger: 100 }),
    };
    const gaps: GuardTelemetryGap[] = [];
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    await drainWatch(listener, { startLedger: 1, onGap: (gap) => gaps.push(gap) }, 1);
    assert.deepEqual(gaps, []);
    const page = await listener.poll({ startLedger: 1 });
    assert.equal(page.oldestLedger, null);
  });

  it("leaves the stream untouched when no onGap callback is supplied", async () => {
    const server = pagedServer([
      { events: [ledgerEvent(50)], oldestLedger: 500, latestLedger: 600 },
    ]);
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    const batches = await drainWatch(listener, { startLedger: 100 }, 1);
    assert.equal(batches.flat().length, 1);
    assert.equal(batches.flat()[0]!.ledger, 50);
  });
});

/**
 * Abort cancellation (issue #95).
 *
 * `watch({ signal })` promises teardown, not a slow fade. A stopped listener
 * must not keep issuing `getEvents` requests ("zombie polls"), must not make
 * its caller wait out the poll interval first, and must not leave the process
 * holding an unhandled rejection or an open timer.
 *
 * One limit is honest rather than papered over — `@stellar/stellar-sdk`'s
 * `getEvents` takes no `AbortSignal`, so a request already in flight cannot be
 * cancelled — and the mid-flight case below is written the way a real
 * fetch-level abort would look: the mock rejects the in-flight request when the
 * caller aborts, and the loop is asserted to end quietly rather than surfacing
 * that rejection or firing another poll.
 */
describe("GuardTelemetryListener abort cancellation (issue #95)", () => {
  /**
   * The outcome of `wait` if it settles within `ms`, or `"hung"` if it does not.
   *
   * The timer is cleared the moment the race settles, so the guard against a
   * hang is not itself an open handle — the failure mode this suite is about.
   */
  async function settledWithin<T>(wait: Promise<T>, ms = 1_000): Promise<T | "hung"> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        wait,
        new Promise<"hung">((resolve) => {
          timer = setTimeout(() => resolve("hung"), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  it("issues no RPC call at all when aborted before the first pull", async () => {
    let getEventsCalls = 0;
    let getLatestLedgerCalls = 0;
    const server = {
      getLatestLedger: async () => {
        getLatestLedgerCalls += 1;
        return { sequence: 500 };
      },
      getEvents: async () => {
        getEventsCalls += 1;
        return { events: [], cursor: "cursor_1", latestLedger: 500 };
      },
    };
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
    const controller = new AbortController();
    controller.abort();

    const batches: GuardEvent[][] = [];
    for await (const batch of listener.watch({ signal: controller.signal })) {
      batches.push(batch);
    }

    assert.deepEqual(batches, []);
    assert.equal(getEventsCalls, 0, "no zombie poll before the iterator even starts");
    assert.equal(
      getLatestLedgerCalls,
      0,
      "an already-aborted watch must not probe the head to resolve a default start ledger",
    );
  });

  it("ends on abort during an in-flight request, with no further poll and no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const controller = new AbortController();
      let getEventsCalls = 0;
      const server = {
        getLatestLedger: async () => ({ sequence: 500 }),
        getEvents: () => {
          getEventsCalls += 1;
          // Settles only when the caller aborts — the shape a fetch-level
          // cancellation rejection has.
          return new Promise((_resolve, reject) => {
            controller.signal.addEventListener(
              "abort",
              () => {
                const error = new Error("The operation was aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          });
        },
      };
      const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });
      const iterator = listener
        .watch({ startLedger: 400, signal: controller.signal })[Symbol.asyncIterator]();

      const inFlight = iterator.next();
      assert.equal(getEventsCalls, 1, "the first pull dispatches exactly one request");
      controller.abort();

      // No fake timers: the abort alone has to end the iterator, and the
      // sentinel exists only so a regression fails loudly instead of hanging.
      const outcome = await settledWithin(
        inFlight.then(
          () => "ended",
          () => "threw",
        ),
      );
      assert.equal(
        outcome,
        "ended",
        "abort during an in-flight request must end the iterator, not throw or hang",
      );

      assert.equal(getEventsCalls, 1, "post-abort zombie poll: no request may follow the abort");
      assert.deepEqual(unhandled, [], "abort teardown must not produce an unhandled rejection");
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("aborts between pages without serving out the poll interval, and polls no further", async () => {
    const controller = new AbortController();
    let getEventsCalls = 0;
    const sleepDelays: number[] = [];
    const server = {
      getLatestLedger: async () => ({ sequence: 500 }),
      getEvents: async () => {
        getEventsCalls += 1;
        return { events: [], cursor: `cursor_${getEventsCalls}`, latestLedger: 500 };
      },
    };
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });

    const drain = (async () => {
      for await (const _batch of listener.watch({
        startLedger: 400,
        pollIntervalMs: 5_000,
        jitter: "none",
        signal: controller.signal,
        sleep: (ms) => {
          sleepDelays.push(ms);
          // Never settles on its own: only the abort ends this wait, so what is
          // under test is the race against the signal, not the timer.
          return new Promise<void>(() => {
            controller.abort();
          });
        },
      })) {
        // Drain: the assertion is that this loop ends at all.
      }
    })();

    const outcome = await settledWithin(
      drain.then(
        () => "ended",
        () => "threw",
      ),
    );
    assert.equal(outcome, "ended", "abort during the poll delay must end the iterator, not hang");
    assert.equal(getEventsCalls, 1, "the aborted interval must not be followed by another poll");
    assert.deepEqual(sleepDelays, [5_000], "the delay is requested once, then cut short");
  });
});

/**
 * Unified stream (`watchAll` / `mergeGuardEventStreams`, issue #67).
 *
 * `watch()` alone is the motivating trap: a blocked decision is rolled back
 * before broadcast, so a consumer tailing the ledger sees a guard that never
 * blocks. These tests pin the merged stream both ways — that it really carries
 * both sources, ordered and de-duplicated, and that the default `watch()` path
 * is untouched.
 */
describe("GuardTelemetryListener unified stream (issue #67)", () => {
  /** A committed event shaped as `poll()` produces one. */
  function committedEvent(ledger: number, txHash = "ab".repeat(32)): GuardEvent {
    return {
      id: `ledger:${txHash}:event_auth_checked`,
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "ledger",
      stream: "committed",
      contractId: GUARD,
      ledger,
      ledgerClosedAt: "2026-09-27T00:00:00Z",
      observedAt: null,
      transactionHash: txHash,
      decision: { result: "allowed", reason: null, source: "ledger" },
      data: {},
    };
  }

  function diagnosticBatch(reason: string, observedAt = "T1"): GuardDiagnosticBatch {
    return {
      events: guardEventsFromDiagnostics(
        [diagnosticEvent(["event_auth_checked", "blocked", reason])],
        GUARD,
      ),
      observedAt,
    };
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** A fake RPC serving one committed page, then aborting the loop. */
  function onePageServer(ledger = 100) {
    return {
      getLatestLedger: async () => ({ sequence: ledger }),
      getEvents: async () => ({
        events: [
          {
            contractId: GUARD,
            type: "contract",
            ledger,
            ledgerClosedAt: "2026-09-27T00:00:00Z",
            txHash: "ab".repeat(32),
            topic: ["event_auth_checked", "allowed", ""].map((topic) => xdr.ScVal.scvSymbol(topic)),
            value: xdr.ScVal.scvMap([]),
          },
        ],
        cursor: "cursor_1",
        latestLedger: ledger,
      }),
    };
  }

  it("yields both sources, discriminating and time-tagging them", async () => {
    const controller = new AbortController();
    const listener = new GuardTelemetryListener({ server: onePageServer() as never, guard: GUARD });
    const seen: GuardEvent[] = [];

    for await (const event of listener.watchAll({
      startLedger: 100,
      signal: controller.signal,
      diagnostics: [diagnosticBatch("per_tx_cap_exceeded", "2026-09-27T00:00:01.000Z")],
      sleep: async () => controller.abort(),
    })) {
      seen.push(event);
    }

    const committed = seen.find((event) => event.stream === "committed");
    const diagnostic = seen.find((event) => event.stream === "diagnostic");

    assert.ok(committed, "the committed feed must be present");
    assert.equal(committed.source, "ledger");
    assert.equal(committed.observedAt, null);

    assert.ok(diagnostic, "the diagnostic feed must be present");
    assert.equal(diagnostic.source, "diagnostic");
    assert.equal(diagnostic.observedAt, "2026-09-27T00:00:01.000Z", "diagnostics carry the observation time");
    assert.equal(diagnostic.decision?.result, "blocked");
  });

  it("sorts committed events by ledger regardless of page order", async () => {
    const seen: GuardEvent[] = [];
    for await (const event of mergeGuardEventStreams([
      [committedEvent(500, "cc".repeat(32)), committedEvent(100, "dd".repeat(32))],
    ])) {
      seen.push(event);
    }
    assert.deepEqual(seen.map((event) => event.ledger), [100, 500]);
  });

  it("interleaves a diagnostic batch at its point of observation", async () => {
    const page1 = deferred();
    const page2 = deferred();
    const diag1 = deferred();
    const diag2 = deferred();

    async function* committed() {
      await page1.promise;
      yield [committedEvent(100, "11".repeat(32))];
      await page2.promise;
      yield [committedEvent(101, "22".repeat(32))];
    }

    async function* diagnostics() {
      await diag1.promise;
      yield diagnosticBatch("per_tx_cap_exceeded", "T1");
      await diag2.promise;
      yield diagnosticBatch("window_cap_exceeded", "T2");
    }

    const seen: GuardEvent[] = [];
    const drain = (async () => {
      for await (const event of mergeGuardEventStreams(committed(), diagnostics())) {
        seen.push(event);
      }
    })();

    const shape = () => seen.map((event) => event.ledger ?? event.decision?.reason);

    page1.resolve();
    await flush();
    assert.deepEqual(shape(), [100]);

    diag1.resolve();
    await flush();
    assert.deepEqual(shape(), [100, "per_tx_cap_exceeded"]);

    page2.resolve();
    await flush();
    assert.deepEqual(shape(), [100, "per_tx_cap_exceeded", 101]);

    diag2.resolve();
    await drain;
    assert.deepEqual(shape(), [100, "per_tx_cap_exceeded", 101, "window_cap_exceeded"]);
    assert.deepEqual(
      seen.map((event) => event.stream),
      ["committed", "diagnostic", "committed", "diagnostic"],
    );
  });

  it("de-duplicates by id: a re-fed diagnostic batch is emitted once", async () => {
    const batch = diagnosticBatch("per_tx_cap_exceeded");
    const seen: GuardEvent[] = [];
    for await (const event of mergeGuardEventStreams([], [batch, batch, batch])) {
      seen.push(event);
    }
    assert.equal(seen.length, 1, "identical ids must collapse to one delivery");
  });

  it("emits every id at most once across both sources", async () => {
    const duplicate = committedEvent(100, "aa".repeat(32));
    const seen: GuardEvent[] = [];
    for await (const event of mergeGuardEventStreams(
      [[duplicate, { ...duplicate }]],
      [diagnosticBatch("per_tx_cap_exceeded"), diagnosticBatch("per_tx_cap_exceeded")],
    )) {
      seen.push(event);
    }
    const ids = seen.map((event) => event.id);
    assert.equal(new Set(ids).size, ids.length, "no id may be delivered twice");
    assert.deepEqual(seen.map((event) => event.stream), ["committed", "diagnostic"]);
  });

  it("leaves the default watch() path committed-only, tagging every event", async () => {
    const controller = new AbortController();
    const listener = new GuardTelemetryListener({ server: onePageServer() as never, guard: GUARD });
    const seen: GuardEvent[] = [];

    for await (const page of listener.watch({
      startLedger: 100,
      signal: controller.signal,
      sleep: async () => controller.abort(),
    })) {
      seen.push(...page);
    }

    assert.ok(seen.length >= 1, "watch() must still yield the committed page");
    assert.ok(
      seen.every(
        (event) =>
          event.stream === "committed" && event.source === "ledger" && event.observedAt === null,
      ),
      "watch() is unchanged: committed events only, with the additive fields defaulted",
    );
  });
});

describe("GuardEventRingBuffer (issue #68)", () => {
  /** A minimal well-formed event; only the fields a test cares about are overridden. */
  function event(partial: Partial<GuardEvent>): GuardEvent {
    return {
      id: "id",
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "ledger",
      stream: "committed",
      contractId: GUARD,
      ledger: 100,
      ledgerClosedAt: null,
      observedAt: null,
      transactionHash: null,
      decision: null,
      data: null,
      ...partial,
    };
  }

  it("rejects a max that is not a positive integer", () => {
    assert.throws(() => new GuardEventRingBuffer(0), RangeError);
    assert.throws(() => new GuardEventRingBuffer(-1), RangeError);
    assert.throws(() => new GuardEventRingBuffer(2.5), RangeError);
  });

  it("evicts oldest first and preserves order once full (FIFO)", () => {
    const buffer = new GuardEventRingBuffer(5);
    for (let i = 1; i <= 8; i += 1) buffer.push(event({ id: `e${i}`, ledger: i }));

    assert.equal(buffer.size, 5, "push max+3 retains exactly max");
    assert.deepEqual(
      buffer.recent().map((entry) => entry.id),
      ["e4", "e5", "e6", "e7", "e8"],
      "the three oldest are evicted and the rest stay in order",
    );
  });

  it("keeps the newest window across many wraps of the ring", () => {
    const buffer = new GuardEventRingBuffer(3);
    for (let i = 1; i <= 100; i += 1) buffer.push(event({ id: `e${i}`, ledger: i }));
    assert.deepEqual(buffer.recent().map((entry) => entry.id), ["e98", "e99", "e100"]);
  });

  it("filters by stream and reason", () => {
    const buffer = new GuardEventRingBuffer(10);
    buffer.push(event({ id: "allowed" }));
    buffer.push(
      event({
        id: "cap",
        source: "diagnostic",
        stream: "diagnostic",
        decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
      }),
    );
    buffer.push(
      event({
        id: "paused",
        source: "diagnostic",
        stream: "diagnostic",
        decision: { result: "blocked", reason: "paused", source: "diagnostic" },
      }),
    );

    assert.deepEqual(
      buffer.recent({ stream: "diagnostic" }).map((entry) => entry.id),
      ["cap", "paused"],
    );
    assert.deepEqual(
      buffer.recent({ reason: "paused" }).map((entry) => entry.id),
      ["paused"],
    );
    assert.deepEqual(buffer.recent({ stream: "committed", reason: "paused" }), []);
  });

  it("filters by ledger range and excludes ledger-less diagnostics from a range", () => {
    const buffer = new GuardEventRingBuffer(10);
    buffer.push(event({ id: "l10", ledger: 10 }));
    buffer.push(event({ id: "l20", ledger: 20 }));
    buffer.push(event({ id: "diag", ledger: null, source: "diagnostic", stream: "diagnostic" }));

    assert.deepEqual(
      buffer.recent({ fromLedger: 15 }).map((entry) => entry.id),
      ["l20"],
    );
    assert.deepEqual(
      buffer.recent({ toLedger: 15 }).map((entry) => entry.id),
      ["l10"],
    );
    assert.deepEqual(
      buffer.recent({ fromLedger: 0, toLedger: 100 }).map((entry) => entry.id),
      ["l10", "l20"],
      "a ledger-less diagnostic is not inside a ledger range",
    );
  });

  it("hands out a copy, so a caller cannot mutate retained events", () => {
    const buffer = new GuardEventRingBuffer(2);
    buffer.push(event({ id: "a" }));
    const returned = buffer.recent();
    returned.pop();
    assert.equal(buffer.recent().length, 1);
  });
});

/**
 * Detached snapshots from `recent()` (issue #344).
 *
 * `recent()` used to hand out the buffer's own event objects: a consumer that
 * edited one changed what the buffer still retained, and the next `recent()`
 * reported the edit instead of the event. The contract is now a *detached
 * snapshot* — the array, the events in it, and everything nested inside them
 * (decoded data, the decoded decision, the opt-in raw payload) are copies.
 */
describe("GuardEventRingBuffer detached snapshots (issue #344)", () => {
  /** A minimal well-formed event; only the fields a test cares about are overridden. */
  function event(partial: Partial<GuardEvent>): GuardEvent {
    return {
      id: "id",
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "ledger",
      stream: "committed",
      contractId: GUARD,
      ledger: 100,
      ledgerClosedAt: null,
      observedAt: null,
      transactionHash: null,
      decision: null,
      data: null,
      ...partial,
    };
  }

  it("hands out a fresh event object on every call", () => {
    const buffer = new GuardEventRingBuffer(2);
    buffer.push(event({ id: "a" }));

    const first = buffer.recent();
    const second = buffer.recent();

    assert.notEqual(first[0], second[0], "each snapshot is a new object");
    assert.equal(first[0]!.id, "a", "and it still carries the retained event's data");
  });

  it("a top-level edit cannot change the retained event", () => {
    const buffer = new GuardEventRingBuffer(2);
    buffer.push(event({ id: "a", ledger: 100 }));

    const snapshot = buffer.recent();
    snapshot[0]!.id = "mutated";
    snapshot[0]!.ledger = 999;

    const retained = buffer.recent()[0]!;
    assert.equal(retained.id, "a");
    assert.equal(retained.ledger, 100);
  });

  it("a nested edit cannot change the retained decoded data", () => {
    const buffer = new GuardEventRingBuffer(2);
    buffer.push(event({ id: "a", data: { nested: { amount: 10n }, list: [1, 2] } }));

    const snapshot = buffer.recent();
    const edited = snapshot[0]!.data as { nested: { amount: bigint }; list: number[] };
    edited.nested.amount = 99n;
    edited.list.push(3);

    const retained = buffer.recent()[0]!.data as { nested: { amount: bigint }; list: number[] };
    assert.equal(retained.nested.amount, 10n, "the retained nested value is untouched");
    assert.deepEqual(retained.list, [1, 2], "and so is the retained list");
  });

  it("a nested edit cannot change the retained decision", () => {
    const buffer = new GuardEventRingBuffer(2);
    buffer.push(
      event({
        id: "a",
        source: "diagnostic",
        stream: "diagnostic",
        decision: { result: "blocked", reason: "paused", source: "diagnostic" },
      }),
    );

    const snapshot = buffer.recent();
    (snapshot[0]!.decision as { reason: string }).reason = "mutated";

    assert.equal(buffer.recent()[0]!.decision?.reason, "paused");
  });

  it("a nested edit cannot change the retained raw payload", () => {
    const buffer = new GuardEventRingBuffer(2);
    const raw = { event: { contractId: GUARD, body: { v0: { topics: [] } } } };
    buffer.push(event({ id: "a", raw }));

    const snapshot = buffer.recent();
    assert.notEqual(snapshot[0]!.raw, raw, "the raw payload is copied, not aliased");
    (snapshot[0]!.raw as { event: { contractId: string } }).event.contractId = "mutated";

    const retained = buffer.recent()[0]!.raw as { event: { contractId: string } };
    assert.equal(retained.event.contractId, GUARD);
  });

  it("keeps the raw payload's shape: an XDR value in the copy is still an XDR value", () => {
    const buffer = new GuardEventRingBuffer(1);
    const raw = { topic: [xdr.ScVal.scvSymbol("event_auth_checked")] };
    buffer.push(event({ id: "a", raw }));

    const copied = buffer.recent()[0]!.raw as { topic: xdr.ScVal[] };
    assert.ok(copied.topic[0] instanceof xdr.ScVal, "the copy keeps the XDR prototype");
    assert.equal(copied.topic[0]!.type, "scvSymbol");
  });

  it("leaves `raw` absent when the decode did not retain it", () => {
    const buffer = new GuardEventRingBuffer(1);
    buffer.push(event({ id: "a" }));

    const snapshot = buffer.recent()[0]!;
    assert.equal(snapshot.raw, undefined);
    assert.ok(!("raw" in snapshot), "an absent raw payload stays absent in the snapshot");
  });

  it("detaches byte arrays, so a byte written into the copy stays there", () => {
    const buffer = new GuardEventRingBuffer(1);
    const bytes = new Uint8Array([1, 2, 3]);
    buffer.push(event({ id: "a", data: { bytes } }));

    const snapshot = buffer.recent();
    const edited = snapshot[0]!.data as { bytes: Uint8Array };
    edited.bytes[0] = 99;

    const retained = buffer.recent()[0]!.data as { bytes: Uint8Array };
    assert.equal(retained.bytes[0], 1, "the retained bytes are untouched");
    assert.notEqual(retained.bytes, bytes, "and the byte array itself is a copy");
  });
});

describe("GuardTelemetryListener opt-in buffer (issue #68)", () => {
  function rawLedgerEvent(ledger: number) {
    return {
      contractId: GUARD,
      ledger,
      ledgerClosedAt: "2026-09-27T00:00:00Z",
      txHash: "ab".repeat(32),
      topic: ["event_auth_checked", "allowed", ""].map((topic) => xdr.ScVal.scvSymbol(topic)),
      value: xdr.ScVal.scvMap([]),
    };
  }

  function singlePageServer(events: unknown[]) {
    return {
      getLatestLedger: async () => ({ sequence: 1 }),
      getEvents: async () => ({ events, cursor: "cursor_1", latestLedger: 600 }),
    };
  }

  it("retains committed events decoded by poll()", async () => {
    const server = singlePageServer([rawLedgerEvent(500)]);
    const listener = new GuardTelemetryListener({
      server: server as never,
      guard: GUARD,
      buffer: { max: 5 },
    });

    await listener.poll({ startLedger: 500 });

    const recent = listener.recent();
    assert.equal(recent.length, 1);
    assert.equal(recent[0]!.ledger, 500);
    assert.equal(recent[0]!.stream, "committed");
  });

  it("keeps nothing when no buffer is configured (default off)", async () => {
    const server = singlePageServer([rawLedgerEvent(500)]);
    const listener = new GuardTelemetryListener({ server: server as never, guard: GUARD });

    await listener.poll({ startLedger: 500 });

    assert.deepEqual(listener.recent(), [], "no buffer requested → recent() is always empty");
  });

  it("retains diagnostic events merged by watchAll()", async () => {
    const server = singlePageServer([]);
    const listener = new GuardTelemetryListener({
      server: server as never,
      guard: GUARD,
      buffer: { max: 5 },
    });
    const blocked = guardEventsFromDiagnostics(
      [diagnosticEvent(["event_auth_checked", "blocked", "paused"])],
      GUARD,
    );
    async function* diagnostics(): AsyncIterable<GuardDiagnosticBatch> {
      yield { events: blocked, observedAt: "2026-09-27T00:00:00Z" };
    }

    const controller = new AbortController();
    let ticks = 0;
    const seen: GuardEvent[] = [];
    for await (const event of listener.watchAll({
      startLedger: 500,
      signal: controller.signal,
      sleep: async () => {
        if (++ticks >= 2) controller.abort();
      },
      diagnostics: diagnostics(),
    })) {
      seen.push(event);
    }

    assert.ok(
      seen.some((event) => event.stream === "diagnostic"),
      "the blocked decision must reach the unified stream",
    );
    const recent = listener.recent({ stream: "diagnostic" });
    assert.equal(recent.length, 1, "the diagnostic half is what watchAll() adds to the buffer");
    assert.equal(recent[0]!.decision?.reason, "paused");
  });

  it("exposes the filter surface through the listener accessor", async () => {
    const server = singlePageServer([rawLedgerEvent(10), rawLedgerEvent(20)]);
    const listener = new GuardTelemetryListener({
      server: server as never,
      guard: GUARD,
      buffer: { max: 5 },
    });

    await listener.poll({ startLedger: 10 });

    const filter: RecentEventFilter = { stream: "committed", fromLedger: 15 };
    const filtered = listener.recent(filter);
    assert.deepEqual(
      filtered.map((event) => event.ledger),
      [20],
    );
  });

  it("hands out detached snapshots, so a consumer's edit never reaches the buffer", async () => {
    const server = singlePageServer([rawLedgerEvent(500)]);
    const listener = new GuardTelemetryListener({
      server: server as never,
      guard: GUARD,
      buffer: { max: 5 },
    });

    await listener.poll({ startLedger: 500 });

    const snapshot = listener.recent();
    snapshot[0]!.ledger = 999;
    snapshot[0]!.id = "mutated";

    const retained = listener.recent()[0]!;
    assert.equal(retained.ledger, 500, "the listener still retains the decoded event");
    assert.notEqual(retained.id, "mutated");
  });
});

/**
 * Opt-in raw event retention (issue #94).
 *
 * When a decoded verdict looks wrong, the raw payload is the evidence an SDK
 * bug report needs. It is off by default because the payload (XDR `ScVal`s,
 * host-shaped objects) is large enough that retaining it for every event is a
 * memory decision, not a convenience. These tests pin both halves: the source
 * object is attached when asked for, and *absent* — not merely empty —
 * otherwise, so the default path keeps discarding it.
 */
describe("opt-in raw event retention (issue #94)", () => {
  const blockedEvent = () =>
    diagnosticEvent(["event_auth_checked", "blocked", "per_tx_cap_exceeded"]);

  it("omits the raw field entirely by default, including on guardEventsFromDiagnostics", () => {
    const events = guardEventsFromDiagnostics([blockedEvent()], GUARD);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.raw, undefined);
    assert.ok(
      !("raw" in events[0]!),
      "the default decode must not retain the source payload at all",
    );
  });

  it("attaches the exact source event object when includeRaw is enabled", () => {
    const source = blockedEvent();
    const events = guardEventsFromDiagnostics([source], GUARD, { includeRaw: true });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.raw, source);
    // Same reference, not a copy: a bug report should carry what the SDK saw.
    assert.equal(events[0]!.raw, source);
  });

  it("keeps includeRaw off when the option object is present but false", () => {
    const events = diagnosticsToEvents([blockedEvent()], GUARD, { includeRaw: false });
    assert.ok(!("raw" in events[0]!));
  });

  it("forwards includeRaw through telemetryFromDecision", () => {
    const source = blockedEvent();
    const events = telemetryFromDecision(
      { kind: "blocked", reason: "per_tx_cap_exceeded", diagnosticEvents: [source] },
      GUARD,
      { includeRaw: true },
    );
    assert.deepEqual(events[0]!.raw, source);
  });

  it("retains the ledger RPC event only when the listener opts in", async () => {
    function rawLedgerEvent() {
      return {
        contractId: GUARD,
        type: "contract",
        ledger: 500,
        ledgerClosedAt: "2026-09-27T00:00:00Z",
        txHash: "ab".repeat(32),
        topic: ["event_auth_checked", "allowed", ""].map((topic) => xdr.ScVal.scvSymbol(topic)),
        value: xdr.ScVal.scvMap([]),
      };
    }
    function server() {
      return {
        getLatestLedger: async () => ({ sequence: 1 }),
        getEvents: async () => ({ events: [rawLedgerEvent()], cursor: "c", latestLedger: 600 }),
      };
    }

    const off = new GuardTelemetryListener({ server: server() as never, guard: GUARD });
    const offPage = await off.poll({ startLedger: 500 });
    assert.equal(offPage.events[0]!.raw, undefined);
    assert.ok(!("raw" in offPage.events[0]!));

    const on = new GuardTelemetryListener({
      server: server() as never,
      guard: GUARD,
      includeRaw: true,
    });
    const onPage = await on.poll({ startLedger: 500 });
    assert.deepEqual(onPage.events[0]!.raw, rawLedgerEvent());
  });

  it("preserves raw across the unified stream's diagnostic tagging", async () => {
    const source = blockedEvent();
    const batch: GuardDiagnosticBatch = {
      events: guardEventsFromDiagnostics([source], GUARD, { includeRaw: true }),
      observedAt: "2026-09-27T00:00:00Z",
    };
    const seen: GuardEvent[] = [];
    for await (const event of mergeGuardEventStreams([], [batch])) {
      seen.push(event);
    }
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.raw, source);
  });
});

describe("GuardTelemetryListener counters", () => {
  const decisionEvent = (result: "allowed" | "blocked", reason: string | null, index: number): GuardEvent => ({
    id: `diag:${index.toString(16).padStart(64, "0")}`,
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "diagnostic",
    stream: "diagnostic",
    contractId: GUARD,
    ledger: null,
    ledgerClosedAt: null,
    observedAt: new Date(index).toISOString(),
    transactionHash: null,
    decision: { result, reason, source: "diagnostic" } as GuardEvent["decision"],
    data: {},
  });

  it("does not allocate counters by default and returns null from stats()", () => {
    const listener = new GuardTelemetryListener();
    assert.equal(listener.stats(), null);
  });

  it("counts allowed and blocked decisions by reason over a count-window", () => {
    const listener = new GuardTelemetryListener({ counters: { windowEvents: 20 } });
    const reasons = ["per_tx_cap_exceeded", "window_cap_exceeded", "recipient_not_allowed"];
    for (let i = 0; i < 20; i++) {
      const blocked = i % 2 === 0;
      listener.observe(
        decisionEvent(blocked ? "blocked" : "allowed", blocked ? reasons[(i / 2) % 3]! : null, i),
      );
    }
    const stats = listener.stats();
    assert.ok(stats);
    assert.equal(stats!.allowed, 10);
    assert.equal(stats!.blocked, 10);
    assert.deepEqual(stats!.byReason, {
      per_tx_cap_exceeded: 4,
      window_cap_exceeded: 3,
      recipient_not_allowed: 3,
    });
  });

  it("evicts old events once the count window is exceeded", () => {
    const listener = new GuardTelemetryListener({ counters: { windowEvents: 5 } });
    for (let i = 0; i < 5; i++) {
      listener.observe(decisionEvent("blocked", "per_tx_cap_exceeded", i));
    }
    for (let i = 5; i < 10; i++) {
      listener.observe(decisionEvent("allowed", null, i));
    }
    const stats = listener.stats();
    assert.ok(stats);
    assert.equal(stats!.allowed, 5);
    assert.equal(stats!.blocked, 0);
    assert.deepEqual(stats!.byReason, {});
  });

  it("returns a deep-copied snapshot that callers cannot mutate", () => {
    const listener = new GuardTelemetryListener({ counters: { windowEvents: 10 } });
    listener.observe(decisionEvent("blocked", "per_tx_cap_exceeded", 0));
    const first = listener.stats();
    assert.ok(first);
    first!.allowed = 999;
    first!.byReason.per_tx_cap_exceeded = 999;
    const second = listener.stats();
    assert.equal(second!.allowed, 0);
    assert.equal(second!.byReason.per_tx_cap_exceeded, 1);
  });

  it("supports a time-window with an injected clock", () => {
    let now = 0;
    const listener = new GuardTelemetryListener( {
      counters: { windowMs: 1000 },
      clock: () => now,
    });
    listener.observe(decisionEvent("blocked", "per_tx_cap_exceeded", 0));
    now = 500;
    listener.observe(decisionEvent("allowed", null, 1));
    now = 1500;
    listener.observe(decisionEvent("allowed", null, 2));
    const stats = listener.stats();
    assert.ok(stats);
    assert.equal(stats!.allowed, 2);
    assert.equal(stats!.blocked, 0);
  });
});

/**
 * Wall-clock rollback (#320).
 *
 * The counters evict on a monotonic timeline: observations are clamped to the
 * high-water mark, so a clock that moves backwards cannot extend how long an
 * entry is retained, and a clock that jumps forward still expires stale entries
 * immediately. Only an injected clock is used, so there is no wall-clock wait.
 */
describe("GuardDecisionCounters wall-clock resilience (issue #320)", () => {
  const decisionEvent = (
    result: "allowed" | "blocked",
    reason: string | null,
    index: number,
  ): GuardEvent => ({
    id: `diag:${index.toString(16).padStart(64, "0")}`,
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "diagnostic",
    stream: "diagnostic",
    contractId: GUARD,
    ledger: null,
    ledgerClosedAt: null,
    observedAt: new Date(index).toISOString(),
    transactionHash: null,
    decision: { result, reason, source: "diagnostic" } as GuardEvent["decision"],
    data: {},
  });

  it("does not retain entries past the window when the clock rolls back", () => {
    let now = 1_000;
    const listener = new GuardTelemetryListener({
      counters: { windowMs: 1_000 },
      clock: () => now,
    });
    listener.observe(decisionEvent("blocked", "per_tx_cap_exceeded", 0));

    // A rollback must not move the eviction cutoff backwards. The entry stays
    // retained only for the original window, measured on internal time.
    now = 0;
    listener.observe(decisionEvent("allowed", null, 1));
    let stats = listener.stats();
    assert.ok(stats);
    assert.equal(stats!.allowed + stats!.blocked, 2, "a rollback does not evict early");
    assert.equal(stats!.windowStart, 1_000, "clamped to the high-water mark, not the rolled-back value");

    // Still inside the window on the monotonic timeline (cutoff 999).
    now = 1_999;
    stats = listener.stats();
    assert.equal(stats!.allowed + stats!.blocked, 2);

    // One millisecond past the window: both entries at t=1000 age out.
    now = 2_001;
    stats = listener.stats();
    assert.equal(stats!.allowed, 0);
    assert.equal(stats!.blocked, 0);
    assert.deepEqual(stats!.byReason, {});
    assert.equal(stats!.windowStart, 2_001, "an empty window starts at the current monotonic time");
  });

  it("honours a forward jump immediately", () => {
    let now = 1_000;
    const listener = new GuardTelemetryListener({
      counters: { windowMs: 1_000 },
      clock: () => now,
    });
    listener.observe(decisionEvent("blocked", "per_tx_cap_exceeded", 0));
    now = 5_000;
    const stats = listener.stats();
    assert.ok(stats);
    assert.equal(stats!.blocked, 0);
    assert.deepEqual(stats!.byReason, {});
  });
});

/**
 * Counter coverage and reset semantics (#321).
 *
 * A zero `blocked` count is only evidence that nothing was refused when both
 * decision-bearing streams have fed the counters. These tests pin the three
 * cases the issue calls out — committed-only, unified, and no observation — and
 * prove that reset clears coverage instead of leaving a stale `complete`.
 */
describe("GuardTelemetryListener counter coverage (issue #321)", () => {
  const decisionEvent = (
    result: "allowed" | "blocked",
    reason: string | null,
    index: number,
    stream: "committed" | "diagnostic" | "failed_tx",
  ): GuardEvent => ({
    id: `${stream}:${index.toString(16).padStart(64, "0")}`,
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: stream === "committed" ? "ledger" : "diagnostic",
    stream,
    contractId: GUARD,
    ledger: stream === "committed" ? index : null,
    ledgerClosedAt: stream === "committed" ? new Date(index).toISOString() : null,
    observedAt: stream === "committed" ? null : new Date(index).toISOString(),
    transactionHash: stream === "committed" ? "ab".repeat(32) : null,
    decision: { result, reason, source: stream === "committed" ? "ledger" : "diagnostic" } as GuardEvent["decision"],
    data: {},
  });

  it("reports no observation rather than a confident zero", () => {
    const listener = new GuardTelemetryListener({ counters: { windowEvents: 10 } });
    const stats = listener.stats();
    assert.ok(stats);
    assert.equal(stats!.blocked, 0);
    assert.equal(stats!.coverage.status, "none");
    assert.equal(stats!.coverage.observed, 0);
    assert.deepEqual(stats!.coverage.seen, []);
    assert.deepEqual(stats!.coverage.missing, ["committed", "diagnostic"]);
  });

  it("reports incomplete coverage when only committed events were observed", () => {
    const listener = new GuardTelemetryListener({ counters: { windowEvents: 10 } });
    listener.observe(decisionEvent("allowed", null, 1, "committed"));
    const stats = listener.stats();
    assert.ok(stats);
    assert.equal(stats!.coverage.status, "incomplete");
    assert.equal(stats!.coverage.observed, 1);
    assert.deepEqual(stats!.coverage.seen, ["committed"]);
    assert.deepEqual(stats!.coverage.missing, ["diagnostic"]);
    assert.deepEqual(stats!.coverage.streams, { committed: 1, diagnostic: 0, failed_tx: 0 });
  });

  it("reports complete coverage only once both decision streams have fed", () => {
    const listener = new GuardTelemetryListener({ counters: { windowEvents: 10 } });
    listener.observe(decisionEvent("allowed", null, 1, "committed"));
    listener.observe(decisionEvent("blocked", "per_tx_cap_exceeded", 2, "diagnostic"));
    const stats = listener.stats();
    assert.ok(stats);
    assert.equal(stats!.coverage.status, "complete");
    assert.deepEqual(stats!.coverage.missing, []);
    assert.deepEqual(stats!.coverage.seen, ["committed", "diagnostic"]);
    // Counted once each: coverage counts and window counts agree.
    assert.equal(stats!.coverage.observed, 2);
    assert.equal(stats!.allowed + stats!.blocked, 2);
    assert.equal(stats!.blocked, 1);
  });

  it("does not treat a failed-transaction stream as the diagnostic half", () => {
    const listener = new GuardTelemetryListener({ counters: { windowEvents: 10 } });
    listener.observe(decisionEvent("allowed", null, 1, "committed"));
    listener.observe(decisionEvent("blocked", "per_tx_cap_exceeded", 2, "failed_tx"));
    const stats = listener.stats();
    assert.ok(stats);
    assert.equal(stats!.coverage.status, "incomplete");
    assert.deepEqual(stats!.coverage.missing, ["diagnostic"]);
  });

  it("clears counts and coverage together on resetStats(), without double-counting", () => {
    const listener = new GuardTelemetryListener({ counters: { windowEvents: 10 } });
    listener.observe(decisionEvent("blocked", "per_tx_cap_exceeded", 1, "committed"));
    listener.resetStats();
    const afterReset = listener.stats();
    assert.ok(afterReset);
    assert.equal(afterReset!.blocked, 0);
    assert.deepEqual(afterReset!.byReason, {});
    assert.equal(afterReset!.coverage.status, "none");
    assert.equal(afterReset!.coverage.observed, 0, "coverage is reset, not stale-complete");

    // A reset listener counts only what arrives after it, once.
    listener.observe(decisionEvent("allowed", null, 2, "committed"));
    const afterOne = listener.stats();
    assert.ok(afterOne);
    assert.equal(afterOne!.allowed, 1);
    assert.equal(afterOne!.coverage.observed, 1);
  });

  it("resets a cumulative coverage record while the window evicts independently", () => {
    const listener = new GuardTelemetryListener({ counters: { windowEvents: 1 } });
    listener.observe(decisionEvent("allowed", null, 1, "committed"));
    listener.observe(decisionEvent("blocked", "per_tx_cap_exceeded", 2, "diagnostic"));
    const stats = listener.stats();
    assert.ok(stats);
    // The window holds one decision; coverage still records both streams.
    assert.equal(stats!.allowed + stats!.blocked, 1);
    assert.equal(stats!.coverage.observed, 2);
    assert.equal(stats!.coverage.status, "complete");
  });
});

/**
 * Emitting-identity validation before decoding (#322).
 *
 * `poll()` filters by contract server-side, but does not trust that filter. An
 * RPC that returns another contract's guard-shaped topic must not have it
 * reported as this guard's decision; missing or malformed identity fails closed
 * and every rejection is counted in `PollResult.dropped`.
 */
describe("GuardTelemetryListener event identity validation (issue #322)", () => {
  const FOREIGN = StrKey.encodeContract(new Uint8Array(32).fill(7));

  function eventFor(contractId: unknown, topics: string[]) {
    return {
      ...(contractId === undefined ? {} : { contractId }),
      type: "contract",
      ledger: 500,
      ledgerClosedAt: "2026-09-27T00:00:00Z",
      txHash: "ab".repeat(32),
      topic: topics.map((topic) => xdr.ScVal.scvSymbol(topic)),
      value: xdr.ScVal.scvMap([]),
    };
  }

  function serverFor(events: unknown[]) {
    return {
      getLatestLedger: async () => ({ sequence: 600 }),
      getEvents: async () => ({ events, cursor: "cursor_1", latestLedger: 600 }),
    };
  }

  it("drops a foreign contract's guard-shaped topic instead of reporting a decision", async () => {
    const foreign = eventFor(FOREIGN, ["event_auth_checked", "allowed", ""]);
    const own = eventFor(GUARD, ["event_auth_checked", "blocked", "per_tx_cap_exceeded"]);
    const listener = new GuardTelemetryListener({
      server: serverFor([foreign, own]) as never,
      guard: GUARD,
    });

    const page = await listener.poll({ startLedger: 100 });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]!.contractId, GUARD);
    assert.equal(page.events[0]!.decision?.reason, "per_tx_cap_exceeded");
    assert.deepEqual(page.dropped, {
      unknownTopic: 0,
      foreignContract: 1,
      missingContractId: 0,
      malformedContractId: 0,
    });
  });

  it("fails closed on missing and malformed identity, and counts each reason", async () => {
    const listener = new GuardTelemetryListener({
      server: serverFor([
        eventFor(undefined, ["event_auth_checked", "allowed", ""]),
        eventFor("not-a-contract", ["event_auth_checked", "allowed", ""]),
        eventFor(GUARD, ["event_auth_checked", "allowed", ""]),
        eventFor(GUARD, ["event_not_in_this_version"]),
      ]) as never,
      guard: GUARD,
    });

    const page = await listener.poll({ startLedger: 100 });
    assert.equal(page.events.length, 1, "only the verifiable, known-topic event decodes");
    assert.deepEqual(page.dropped, {
      unknownTopic: 1,
      foreignContract: 0,
      missingContractId: 1,
      malformedContractId: 1,
    });
  });

  it("accepts identity reported with surrounding whitespace by canonicalising it", async () => {
    const padded = ` ${GUARD} `;
    const listener = new GuardTelemetryListener({
      server: serverFor([eventFor(padded, ["event_auth_checked", "allowed", ""])]) as never,
      guard: GUARD,
    });
    const page = await listener.poll({ startLedger: 100 });
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0]!.contractId, GUARD);
  });
});
