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
import { xdr } from "@stellar/stellar-sdk";
import {
  describeGuardEvent,
  diagnosticsToEvents,
  guardEventsFromDiagnostics,
  isAllowedDecision,
  telemetryFromDecision,
} from "../../src/telemetry.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

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
});

describe("describeGuardEvent", () => {
  it("labels a ledger event with its ledger number and outcome", () => {
    const text = describeGuardEvent({
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "ledger",
      contractId: GUARD,
      ledger: 4674314,
      ledgerClosedAt: null,
      transactionHash: "ab".repeat(32),
      decision: { result: "allowed", reason: null, source: "ledger" },
      data: {},
    });
    assert.match(text, /ledger 4674314/);
    assert.match(text, /allowed/);
  });

  it("labels a blocked decision as pre-broadcast, since it has no ledger", () => {
    const text = describeGuardEvent({
      kind: "auth_checked",
      topic: "event_auth_checked",
      source: "diagnostic",
      contractId: GUARD,
      ledger: null,
      ledgerClosedAt: null,
      transactionHash: null,
      decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
      data: {},
    });
    assert.match(text, /pre-broadcast/);
    assert.match(text, /per_tx_cap_exceeded/);
  });
});

describe("isAllowedDecision", () => {
  it("is false for a null decision rather than throwing", () => {
    assert.equal(isAllowedDecision(null), false);
  });
});
