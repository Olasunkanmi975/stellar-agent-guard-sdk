/**
 * Telemetry for the guard contract's events.
 *
 * The listener consumes **two** streams, and this is the part that is easy to
 * get wrong: a blocked decision never reaches the ledger. The guard returns
 * `Err`, which rolls the event back, so a listener that only tails committed
 * ledger events sees a contract that appears to approve everything. The two
 * streams are:
 *
 *   1. **ledger events** — `server.getEvents`, filtered to the guard contract.
 *      Carries allowed decisions, heartbeats, and the admin lifecycle events.
 *   2. **simulation diagnostics** — attached to a failed *enforced simulation*.
 *      Carries blocked decisions, which by construction have no transaction.
 *
 * The topic vocabulary is the one verified against the live chain in
 * `docs/event-schema.md`, not the one the contracts documentation describes.
 */
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { GUARD_AUTH_RESULTS, GUARD_EVENT_TOPICS, decodeAuthDecision, type GuardAuthDecision } from "./events.ts";
import { topicSymbols } from "./invoke.ts";

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

export interface GuardEvent {
  kind: GuardEventKind;
  /** The event's name topic, e.g. `event_auth_checked`. */
  topic: string;
  source: GuardEventSource;
  /** The contract that emitted it, when the stream identifies one. */
  contractId: string | null;
  /** Ledger sequence, when the event was committed. */
  ledger: number | null;
  ledgerClosedAt: string | null;
  transactionHash: string | null;
  /** Present only for `auth_checked`. */
  decision: GuardAuthDecision | null;
  /** Decoded event data: `{ at }` for a heartbeat, `{ by }` for admin events. */
  data: unknown;
}

function decodeData(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  try {
    return scValToNative(value as xdr.ScVal) as unknown;
  } catch {
    return String(value);
  }
}

/** Interpret an already-decoded topic list plus data as a `GuardEvent`. */
function interpret(
  topics: string[],
  data: unknown,
  context: Omit<GuardEvent, "kind" | "topic" | "decision" | "data">,
): GuardEvent | null {
  const topic = topics[0];
  if (!topic || !KNOWN_TOPICS.has(topic)) return null;
  return {
    kind: KIND_BY_TOPIC[topic] ?? "unknown",
    topic,
    ...context,
    decision: decodeAuthDecision(topics, context.source),
    data,
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
): GuardEvent[] {
  const out: GuardEvent[] = [];
  for (const raw of diagnosticEvents) {
    const bare = (raw as { event?: unknown }).event ?? raw;
    const topics = topicSymbols(bare);
    if (topics.length === 0) continue;
    const decoded = interpret(topics, decodeData(dataOf(bare)), {
      source: "diagnostic",
      contractId: guard ?? null,
      ledger: null,
      ledgerClosedAt: null,
      transactionHash: null,
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
): GuardEvent[] {
  return diagnosticsToEvents(diagnosticEvents, guard);
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

export interface GuardTelemetryConfig {
  server: rpc.Server;
  /** The guard contract to follow. */
  guard: string;
  /** RPC URL, only used for error messages. */
  rpcUrl?: string;
}

export interface PollResult {
  events: GuardEvent[];
  /** Cursor to resume from, as returned by the RPC. */
  cursor: string;
  latestLedger: number;
}

export class GuardTelemetryListener {
  private readonly config: GuardTelemetryConfig;

  constructor(config: GuardTelemetryConfig) {
    this.config = config;
  }

  /**
   * One page of committed guard events at or after `startLedger`.
   *
   * Filters server-side by contract id, so the listener only ever sees this
   * guard's own events — the topic vocabulary then narrows further, and an
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
    for (const event of response.events) {
      const contractId = event.contractId ? String(event.contractId) : null;
      const decoded = interpret(
        event.topic.map((topic) => String(scValToNative(topic))),
        decodeData(event.value),
        {
          source: "ledger",
          contractId,
          ledger: event.ledger,
          ledgerClosedAt: event.ledgerClosedAt ?? null,
          transactionHash: event.txHash ?? null,
        },
      );
      if (decoded) events.push(decoded);
    }
    return { events, cursor: response.cursor, latestLedger: response.latestLedger };
  }

  /**
   * Follow the guard from `startLedger` (default: one page back) until aborted.
   * Yields batches so a caller controls backpressure; the cursor is advanced
   * internally so no event is delivered twice.
   */
  async *watch(
    params: { startLedger?: number; pollIntervalMs?: number; limit?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<GuardEvent[], void, undefined> {
    const interval = params.pollIntervalMs ?? 5_000;
    let cursor: string | undefined;
    let startLedger = params.startLedger;

    if (startLedger === undefined) {
      const latest = await this.config.server.getLatestLedger();
      startLedger = Math.max(1, latest.sequence - 1);
      cursor = undefined;
    }

    while (!params.signal?.aborted) {
      const page = await this.poll({
        ...(startLedger !== undefined ? { startLedger } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
      cursor = page.cursor;
      // Once a cursor is held, the ledger range must not be sent again — the RPC
      // rejects a request that mixes the two modes.
      startLedger = undefined;
      if (page.events.length > 0) yield page.events;
      if (params.signal?.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
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
): GuardEvent[] {
  if (decision.kind !== "blocked" || !decision.diagnosticEvents) return [];
  return diagnosticsToEvents(decision.diagnosticEvents, guard);
}

/** True when a decoded decision means the guard permitted the action. */
export function isAllowedDecision(decision: GuardAuthDecision | null): boolean {
  return decision?.result === GUARD_AUTH_RESULTS.allowed;
}

/** A compact one-line rendering of a guard event, for logs. */
export function describeGuardEvent(event: GuardEvent): string {
  const where = event.source === "ledger" ? `ledger ${event.ledger ?? "?"}` : "pre-broadcast";
  const what =
    event.kind === "auth_checked"
      ? `${event.decision?.result ?? "?"}${event.decision?.reason ? ` (${event.decision.reason})` : ""}`
      : event.kind;
  return `${where}: ${event.topic} → ${what}`;
}
