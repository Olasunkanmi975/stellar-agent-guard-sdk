/**
 * Unit tests for invoke() pipeline observability (`onStep`, issue #57).
 *
 * The mock server drives the real pipeline — probe simulation, signing pass,
 * enforced simulation, broadcast — with no network, and a recorder collects
 * the events `onStep` receives. The default no-callback path is pinned too:
 * the whole point of the hook is that omitting it changes nothing.
 *
 * Timing assertions avoid wall-clock fragility in both directions: durations
 * are checked for the contract's shape (a finite, non-negative number on
 * ok/fail, always 0 on start), never against a real sleep, and every test that
 * reaches the broadcast poll uses the test runner's mocked timers so the
 * pipeline's built-in 3s poll interval never slows (or flakes) the suite.
 * Retry indexing is checked against the pipeline's one built-in
 * stale-ledger re-run.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Account, Address, Keypair, nativeToScVal, rpc, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import {
  DEFAULT_INVOKE_RETRY_OPTIONS,
  invoke,
  InvokeRetryError,
} from "../../src/invoke.ts";
import { BroadcastError } from "../../src/tx.ts";
import { ContractResponseError, SimulationError } from "../../src/errors.ts";
import { RpcTimeoutError } from "../../src/invoke.ts";
import { FakeClock, type Clock } from "../../src/clock.ts";
import { TRACE_STEP_NAMES, type TraceStepName } from "../../src/trace.ts";
import type { InvokeStepEvent, SubmissionAcceptedEvent } from "../../src/invoke.ts";
import { unsafeContractAddress, unsafeAccountAddress } from "../../src/policy.ts";

const GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
const TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const RECIPIENT = unsafeAccountAddress("GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH");
const PASSPHRASE = "Test SDF Network ; September 2015";

function transferCall() {
  return {
    contract: TOKEN,
    fn: "transfer",
    args: [
      new Address(GUARD).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(100n, { type: "i128" }),
    ],
  };
}

/** A successful simulation response that asks for the guard's authorization. */
function probeSuccess(): unknown {
  return {
    minResourceFee: "100",
    // Real RPC responses carry the soroban data as XDR; the string form is
    // what `assembleFromSimulation`'s constructor branch handles natively.
    transactionData: new SorobanDataBuilder().build().toXDR(),
    result: {
      auth: [
        new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
            new xdr.SorobanAddressCredentials({
              address: new Address(GUARD).toScAddress(),
              nonce: BigInt(1),
              signatureExpirationLedger: 1,
              signature: xdr.ScVal.scvBytes(new Uint8Array(0)),
            }),
          ),
          // The invocation itself is irrelevant here: the pipeline re-signs the
          // guard entry from its own parameters and never reads this one.
          rootInvocation: new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({
                contractAddress: new Address(TOKEN).toScAddress(),
                functionName: "transfer",
                args: [],
              }),
            ),
            subInvocations: [],
          }),
        }),
      ],
    },
  };
}

/** A guard refusal on the enforced simulation, in the contract's own vocabulary. */
function blockedEnforcement(): unknown {
  return {
    error: "blocked",
    events: [
      {
        event: {
          contractId: GUARD,
          body: {
            v0: {
              topics: [
                xdr.ScVal.scvSymbol("event_auth_checked"),
                xdr.ScVal.scvSymbol("blocked"),
                xdr.ScVal.scvSymbol("per_tx_cap_exceeded"),
              ],
              data: xdr.ScVal.scvVoid(),
            },
          },
        },
      },
    ],
  };
}

interface MockServerOptions {
  /** Overrides every simulation (probe and enforced). */
  simulate?: (call: number) => unknown;
  /** Overrides only the discovery probe (the 1st simulation per attempt). */
  probe?: (attempt: number) => unknown;
  /** Overrides only the enforced simulation (the 2nd one per attempt). */
  enforced?: (attempt: number) => unknown;
  /** Overrides sendTransaction; receives the 1-based send count. */
  send?: (call: number) => unknown;
  /** Overrides getTransaction (post-broadcast polling); receives the tx hash. */
  getTransaction?: (hash: string) => unknown;
}

/**
 * A mock rpc.Server shaped for the invoke pipeline. Simulations are counted so
 * retry tests can assert that instrumentation added no extra attempts, and the
 * caller can override individual responses.
 */
function createMockServer(options: MockServerOptions = {}) {
  let simulations = 0;
  let sends = 0;
  let accountLookups = 0;
  const mock = {
    get simulationCount() {
      return simulations;
    },
    get sendCount() {
      return sends;
    },
    get accountLookupCount() {
      return accountLookups;
    },
    async getAccount() {
      accountLookups += 1;
      return new Account(Keypair.random().publicKey(), "100");
    },
    async getLatestLedger() {
      return { sequence: 1000 };
    },
    async simulateTransaction() {
      const call = ++simulations;
      if (options.simulate) return options.simulate(call);
      // Odd calls are the discovery probe; even calls are the enforced run.
      if (call % 2 === 1 && options.probe) return options.probe(Math.floor(call / 2));
      if (call % 2 === 0 && options.enforced) return options.enforced(Math.floor(call / 2) - 1);
      return probeSuccess();
    },
    async sendTransaction() {
      sends += 1;
      if (options.send) return options.send(sends);
      return { status: "PENDING", hash: "0".repeat(64) };
    },
    async getTransaction(hash: string) {
      if (options.getTransaction) return options.getTransaction(hash);
      return { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 42 };
    },
  } as unknown as rpc.Server & {
    simulationCount: number;
    sendCount: number;
    accountLookupCount: number;
  };
  return mock;
}

function makeParams(
  server: rpc.Server,
  overrides: Partial<Parameters<typeof invoke>[0]> = {},
): Parameters<typeof invoke>[0] {
  return {
    server,
    source: Keypair.random(),
    call: transferCall(),
    networkPassphrase: PASSPHRASE,
    guardAuth: { guard: GUARD, agent: Keypair.random() },
    ...overrides,
  };
}

/**
 * A post-inclusion stale-ledger resource rejection, from the recorded real
 * failure that motivated the bounded retry.
 */
const staleRejection = (): unknown => ({
  status: "FAILED",
  hash: "1".repeat(64),
  errorResult: null,
  resultXdr: "AAAAAAAAURj/////AAAAAQAAAAAAAAAY/////QAAAAA=",
  diagnosticEventsXdr: [
    {
      body: {
        v0: {
          topics: ["error", { type: "system", code: 5, value: "scecExceededLimit" }],
          data: ["operation byte-write resources exceeds amount specified", "724", "652"],
        },
      },
    },
  ],
});

/** A host rejection the guard never saw: not retryable, and not a block. */
const invalidInputSimulation = (): unknown => ({
  error: "HostError: invalid_input",
  events: [],
});

/** Recorder for onStep events. */
function recorder() {
  const events: InvokeStepEvent[] = [];
  return {
    events,
    callback(step: InvokeStepEvent) {
      events.push(step);
    },
  };
}

/**
 * Walk a broadcast-reaching invoke through the pipeline's poll sleeps under
 * mocked timers. `submitAndPoll` sleeps 3s before each poll, so ticking 3s at
 * a time fires exactly one poll per attempt; yielding between ticks lets the
 * pipeline's awaited RPC mock callbacks run, and the bounded loop ends as soon
 * as `invoke` has settled.
 */
async function drainWithMockedTimers(
  timers: { tick: (ms: number) => void },
  pending: Promise<unknown>,
): Promise<void> {
  const settled = () =>
    Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      Promise.resolve(false),
    ]);
  await Promise.resolve(); // let the pipeline reach its first timer
  for (let i = 0; i < 20; i++) {
    timers.tick(3_000);
    if (await settled()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The event sequence a fully successful, non-retried invoke must produce. */
const SUCCESSFUL_ATTEMPT: Array<[TraceStepName, InvokeStepEvent["status"]]> = [
  ["probe", "start"],
  ["probe", "ok"],
  ["sign", "start"],
  ["sign", "ok"],
  ["simulate", "start"],
  ["simulate", "ok"],
  ["broadcast", "start"],
  ["broadcast", "ok"],
];

describe("invoke() onStep: pipeline order", () => {
  it("emits start→ok for each stage in pipeline order on a successful invoke", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = createMockServer();
    const { events, callback } = recorder();

    const pending = invoke(makeParams(server, { onStep: callback }));
    await drainWithMockedTimers(t.mock.timers, pending);
    const outcome = await pending;

    assert.equal(outcome.kind, "allowed");
    assert.deepEqual(
      events.map((event) => [event.name, event.status]),
      SUCCESSFUL_ATTEMPT,
    );
    assert.deepEqual(events.map((event) => event.attempt), [0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("emits no broadcast events on a dry run", async () => {
    const server = createMockServer();
    const { events, callback } = recorder();

    const outcome = await invoke(makeParams(server, { dryRun: true, onStep: callback }));

    // A dry run returns its own structured result rather than an `invoke()`
    // outcome, but the stages it does run are the same instrumented pipeline.
    assert.equal(outcome.kind, "dry_run");
    assert.equal(outcome.admissible, true);
    assert.deepEqual(events.map((event) => [event.name, event.status]), [
      ["probe", "start"],
      ["probe", "ok"],
      ["sign", "start"],
      ["sign", "ok"],
      ["simulate", "start"],
      ["simulate", "ok"],
    ]);
    assert.equal(server.sendCount, 0);
  });

  it("emits a fail event for the simulate stage on a guard block, with no ok for it", async () => {
    const server = createMockServer({ enforced: () => blockedEnforcement() });
    const { events, callback } = recorder();

    const outcome = await invoke(makeParams(server, { onStep: callback }));

    assert.equal(outcome.kind, "blocked");
    const simulateEvents = events.filter((event) => event.name === "simulate");
    assert.deepEqual(
      simulateEvents.map((event) => event.status),
      ["start", "fail"],
    );
    // Nothing after the failed enforced simulation: no broadcast was attempted.
    assert.equal(events.at(-1)?.name, "simulate");
    assert.equal(events.at(-1)?.status, "fail");
    assert.equal(events.some((event) => event.name === "broadcast"), false);
  });

  it("reports failures that happen during the probe stage", async () => {
    const server = createMockServer({ simulate: () => ({ error: "HostError: trap" }) });
    const { events, callback } = recorder();

    const outcome = await invoke(makeParams(server, { onStep: callback }));

    assert.equal(outcome.kind, "error");
    const probeEvents = events.filter((event) => event.name === "probe");
    assert.deepEqual(
      probeEvents.map((event) => event.status),
      ["start", "fail"],
    );
    assert.equal(events.some((event) => event.name === "sign"), false);
  });
});

describe("invoke() onStep: durationMs", () => {
  it("is 0 on start and a finite non-negative number on ok/fail", async () => {
    const server = createMockServer({ enforced: () => blockedEnforcement() });
    const { events, callback } = recorder();

    await invoke(makeParams(server, { onStep: callback }));

    for (const event of events) {
      if (event.status === "start") {
        assert.equal(event.durationMs, 0, `${event.name} start must carry durationMs 0`);
      } else {
        assert.ok(
          Number.isFinite(event.durationMs) && event.durationMs >= 0,
          `${event.name} ${event.status} must carry a finite non-negative durationMs`,
        );
      }
    }
  });
});

describe("invoke() onStep: original error identity", () => {
  // `invoke()` is result-oriented: a stage that throws becomes a typed
  // `kind: "error"` outcome rather than a rejection, so the original error
  // travels as the typed error's `cause`. The identity that matters is
  // unchanged — the pipeline's own error is the one that survives, and a
  // throwing consumer callback never replaces it with its own.
  it("keeps the exact error object a stage threw as the typed cause", async () => {
    const boom = new Error("rpc connection reset");
    const server = createMockServer({
      simulate: () => {
        throw boom;
      },
    });

    const outcome = await invoke(makeParams(server));

    assert.equal(outcome.kind, "error");
    assert.ok(outcome.error instanceof SimulationError);
    assert.equal(outcome.error.stage, "probe");
    assert.equal(outcome.error.cause, boom);
  });

  it("keeps the original error when the fail callback also throws", async () => {
    const boom = new Error("rpc connection reset");
    const server = createMockServer({
      simulate: () => {
        throw boom;
      },
    });

    const outcome = await invoke(
      makeParams(server, {
        onStep: (step) => {
          if (step.status === "fail") throw new Error("callback exploded");
        },
      }),
    );

    assert.equal(outcome.kind, "error");
    assert.ok(outcome.error instanceof SimulationError);
    assert.equal(outcome.error.cause, boom);
  });
});

describe("invoke() onStep: callback exceptions are isolated", () => {
  it("does not turn a successful pipeline into a failure when onStep always throws", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = createMockServer();

    const pending = invoke(
      makeParams(server, {
        onStep: () => {
          throw new Error("consumer bug");
        },
      }),
    );
    await drainWithMockedTimers(t.mock.timers, pending);
    const outcome = await pending;

    assert.equal(outcome.kind, "allowed");
    // The pipeline itself ran to completion regardless of the callback.
    assert.equal(server.simulationCount, 2);
  });

  it("emits every event anyway: the throwing callback is called for all stages", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = createMockServer();
    let calls = 0;
    const pending = invoke(
      makeParams(server, {
        onStep: () => {
          calls += 1;
          throw new Error("consumer bug");
        },
      }),
    );
    await drainWithMockedTimers(t.mock.timers, pending);
    await pending;

    assert.equal(calls, SUCCESSFUL_ATTEMPT.length);
  });
});

describe("invoke() onStep: retries", () => {
  function staleServer() {
    let sends = 0;
    return createMockServer({
      send: () => {
        sends += 1;
        // Every attempt is included, then rejected as stale.
        return { status: "PENDING", hash: `${sends}`.padStart(64, "0") };
      },
      getTransaction: staleRejection,
    });
  }

  it("emits per-attempt events with the attempt index on the stale-ledger retry", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = staleServer();
    const { events, callback } = recorder();

    const pending = invoke(makeParams(server, { onStep: callback }));
    await drainWithMockedTimers(t.mock.timers, pending);
    const outcome = await pending;

    assert.equal(outcome.kind, "error");
    // The retry budget is exhausted on a server where every broadcast is
    // included and then rejected as stale, so the exhausted-budget error is
    // what comes back — carrying the attempt count, not a bare outcome.
    assert.ok(outcome instanceof InvokeRetryError);
    assert.equal(outcome.attempts, DEFAULT_INVOKE_RETRY_OPTIONS.maxAttempts);

    // Every attempt runs the full pipeline; on this server every broadcast is
    // included and then rejected as stale, so all three attempts end
    // broadcast:fail — and each attempt is exactly one more full pass, indexed
    // 0, 1, 2 in order.
    const attemptEvents = (attempt: number) =>
      SUCCESSFUL_ATTEMPT.map(([name, status]) =>
        name === "broadcast" && status === "ok"
          ? `broadcast:fail:a${attempt}`
          : `${name}:${status}:a${attempt}`,
      );
    assert.deepEqual(
      events.map((event) => `${event.name}:${event.status}:a${event.attempt}`),
      [0, 1, 2].flatMap((attempt) => attemptEvents(attempt)),
    );
  });

  it("does not change the number of pipeline attempts (2 simulations per attempt, 3 attempts)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = staleServer();

    const pending = invoke(makeParams(server, { onStep: recorder().callback }));
    await drainWithMockedTimers(t.mock.timers, pending);
    await pending;

    // One full retry budget: 2 simulations + 1 broadcast per attempt, 3 attempts.
    const attempts = DEFAULT_INVOKE_RETRY_OPTIONS.maxAttempts;
    assert.equal(server.simulationCount, 2 * attempts);
    assert.equal(server.sendCount, attempts);
  });

  it("does not retry a broadcast failure that is not a stale-ledger rejection", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = createMockServer({
      getTransaction: () => ({
        status: "FAILED",
        hash: "2".repeat(64),
        resultXdr: null,
        diagnosticEventsXdr: [],
      }),
    });
    const { events, callback } = recorder();

    const pending = invoke(makeParams(server, { onStep: callback }));
    await drainWithMockedTimers(t.mock.timers, pending);
    const outcome = await pending;

    assert.equal(outcome.kind, "error");
    assert.equal(server.simulationCount, 2);
    const attempts = new Set(events.map((event) => event.attempt));
    assert.deepEqual([...attempts].sort(), [0]);
  });
});

describe("invoke() without onStep: default behavior unchanged", () => {
  it("returns the same outcome with no callback supplied", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = createMockServer();

    const pending = invoke(makeParams(server));
    await drainWithMockedTimers(t.mock.timers, pending);
    const outcome = await pending;

    assert.equal(outcome.kind, "allowed");
    if (outcome.kind === "allowed") {
      assert.equal(outcome.submission.status, "SUCCESS");
    }
  });

  it("still returns blocked verdicts with no callback supplied", async () => {
    const server = createMockServer({ enforced: () => blockedEnforcement() });

    const outcome = await invoke(makeParams(server));

    assert.equal(outcome.kind, "blocked");
    if (outcome.kind === "blocked") {
      assert.equal(outcome.reason, "per_tx_cap_exceeded");
    }
  });

  it("still reports stage errors as typed results with no callback supplied", async () => {
    const boom = new Error("rpc connection reset");
    const server = createMockServer({
      simulate: () => {
        throw boom;
      },
    });

    const outcome = await invoke(makeParams(server));

    assert.equal(outcome.kind, "error");
    assert.ok(outcome.error instanceof SimulationError);
    assert.equal(outcome.error.cause, boom);
  });
});

describe("invoke() abortSignal + timeoutMs", () => {
  it("returns without any RPC call when the signal is already aborted", async () => {
    const server = createMockServer();
    const controller = new AbortController();
    controller.abort();

    const outcome = await invoke(
      makeParams(server, { signal: controller.signal }),
    );

    assert.equal(outcome.kind, "error");
    assert.ok(outcome.error instanceof RpcTimeoutError);
    assert.equal(outcome.error.cause, "timeout");
    // The pipeline must short-circuit before touching the RPC at all.
    assert.equal(server.simulationCount, 0);
    assert.equal(server.sendCount, 0);
    assert.equal(server.accountLookupCount, 0);
  });

  it("rejects promptly when aborted mid-flight", async () => {
    const controller = new AbortController();
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const server = createMockServer({
      probe: async () => {
        await probeGate;
        return probeSuccess();
      },
    });

    const pending = invoke(makeParams(server, { signal: controller.signal }));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    releaseProbe();

    const outcome = await pending;
    assert.equal(outcome.kind, "error");
    assert.ok(outcome.error instanceof RpcTimeoutError);
    assert.equal(outcome.error.cause, "timeout");
    // The abort happened during the probe: no signing or broadcast followed.
    assert.equal(server.sendCount, 0);
  });

  it("fires a typed timeout with fake timers", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = createMockServer({
      probe: () => new Promise(() => {}),
    });

    const pending = invoke(makeParams(server, { timeoutMs: 5_000 }));
    await Promise.resolve();
    t.mock.timers.tick(5_000);
    const outcome = await pending;

    assert.equal(outcome.kind, "error");
    assert.ok(outcome.error instanceof RpcTimeoutError);
    assert.equal(outcome.error.cause, "timeout");
    assert.equal(server.sendCount, 0);
  });

  it("does not time out when the pipeline finishes within the budget", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = createMockServer();

    const pending = invoke(makeParams(server, { timeoutMs: 30_000 }));
    await drainWithMockedTimers(t.mock.timers, pending);
    const outcome = await pending;

    assert.equal(outcome.kind, "allowed");
  });

  it("clears the timeout timer on success so no stray timer survives", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const server = createMockServer();

    const pending = invoke(makeParams(server, { timeoutMs: 30_000 }));
    await drainWithMockedTimers(t.mock.timers, pending);
    await pending;

    // If the timeout timer were left armed, ticking past the budget would
    // surface as an unhandled rejection; the run must already be settled.
    t.mock.timers.tick(60_000);
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe("invoke() onStep: shared step vocabulary", () => {
  it("only ever emits step names from the shared TRACE_STEP_NAMES list", async () => {
    const server = createMockServer({ enforced: () => blockedEnforcement() });
    const { events, callback } = recorder();

    await invoke(makeParams(server, { onStep: callback }));

    // Drift detection: a stage added to the pipeline without extending the
    // shared vocabulary (or a hand-rolled name) fails here, because the type
    // alone would silently accept a second list.
    const seen = new Set(events.map((event) => event.name));
    for (const name of seen) {
      assert.ok(
        (TRACE_STEP_NAMES as readonly string[]).includes(name),
        `step '${name}' is not part of the shared trace vocabulary`,
      );
    }
    // And the vocabulary covers exactly the stages the pipeline can emit.
    assert.deepEqual([...TRACE_STEP_NAMES].sort(), ["broadcast", "probe", "sign", "simulate"]);
  });
});

/** Deterministic coverage for the per-account invoke queue. */
describe("invoke sequence reservation", () => {
  it("retries a sequence collision once after refreshing the account sequence", async () => {
    const source = Keypair.random();
    const sentSequences: string[] = [];
    let sends = 0;
    const simulation = {
      transactionData: new SorobanDataBuilder().setResources(1, 0, 0).build(),
      minResourceFee: "1",
      result: { auth: [] },
    };
    const server = {
      getAccount: async () => new Account(source.publicKey(), "7"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async () => simulation,
      sendTransaction: async (transaction: { sequence: string }) => {
        sentSequences.push(transaction.sequence);
        sends += 1;
        return sends === 1
          ? { status: "ERROR", hash: "bad-seq", errorResult: { code: "tx_bad_seq" } }
          : { status: "PENDING", hash: "good-seq" };
      },
      getTransaction: async () => ({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 101,
        events: { contractEventsXdr: [] },
      }),
    } as unknown as rpc.Server;

    const outcome = await invoke({
      server,
      source,
      call: { contract: TOKEN, fn: "transfer", args: [] },
      networkPassphrase: PASSPHRASE,
    });

    assert.equal(outcome.kind, "allowed");
    assert.deepEqual(sentSequences, ["8", "9"]);
  });

  it("serializes concurrent calls and gives each transaction a distinct sequence", async () => {
    const source = Keypair.random();
    const simulated: string[] = [];
    const sent: string[] = [];
    let simulationsStarted = 0;
    let releaseFirst!: () => void;
    const firstSimulation = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const simulation = {
      transactionData: new SorobanDataBuilder().setResources(1, 0, 0).build(),
      minResourceFee: "1",
      result: { auth: [] },
    };
    const server = {
      // The RPC snapshot deliberately never advances: the second invoke can
      // only get a fresh sequence from the per-account reservation.
      getAccount: async () => new Account(source.publicKey(), "7"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async (transaction: { sequence: string }) => {
        simulated.push(transaction.sequence);
        simulationsStarted += 1;
        if (simulationsStarted === 1) await firstSimulation;
        return simulation;
      },
      sendTransaction: async (transaction: { sequence: string }) => {
        sent.push(transaction.sequence);
        return { status: "PENDING", hash: `tx-${sent.length}` };
      },
      getTransaction: async () => ({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 101,
        events: { contractEventsXdr: [] },
      }),
    } as unknown as rpc.Server;

    const params = {
      server,
      source,
      call: { contract: TOKEN, fn: "transfer", args: [] },
      networkPassphrase: PASSPHRASE,
    };
    const first = invoke(params);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = invoke(params);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The second invoke must still be waiting behind the first one's queue.
    assert.equal(simulationsStarted, 1);
    releaseFirst();
    const outcomes = await Promise.all([first, second]);

    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["allowed", "allowed"]);
    // TransactionBuilder consumes the base account sequence and emits base + 1,
    // so the reservation is what keeps the two broadcast envelopes distinct.
    assert.deepEqual(sent, ["8", "9"]);
    assert.deepEqual(simulated, ["8", "8", "9", "9"]);
  });
});

/**
 * The retry boundary itself: how many attempts, how long between them, and what
 * comes back when the budget runs out.
 *
 * The RPC is mocked, but the tests still drive the real transaction-building and
 * signing path. That matters here: a retry is only safe if it builds a fresh
 * transaction and reruns both simulations, not if it blindly resubmits the first
 * resource declaration again.
 *
 * `sleep` is injected rather than timed, so the full-jitter windows are asserted
 * exactly, with no wall-clock flake and no waiting.
 */
describe("invoke() stale-ledger retry", () => {
  /** A short poll so the post-broadcast check happens without a real 3s wait. */
  const FAST_POLL = { pollAttempts: 1, pollIntervalMs: 0 };

  /** Collects the delays a run asks for instead of actually waiting them out. */
  function sleepRecorder() {
    const delays: number[] = [];
    return {
      delays,
      sleep: async (delayMs: number) => {
        delays.push(delayMs);
      },
    };
  }

  it("uses full jitter and reruns the complete simulation pipeline on each retry", async () => {
    const { delays, sleep } = sleepRecorder();
    const randomValues = [0.25, 0.75];
    let randomCall = 0;
    const server = createMockServer({
      send: (call) => ({ status: "PENDING", hash: `tx-${call}` }),
      getTransaction: (hash) => (hash === "tx-3" ? { status: "SUCCESS", ledger: 1002 } : staleRejection()),
    });

    const outcome = await invoke(
      makeParams(server, {
        ...FAST_POLL,
        retry: {
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 250,
          random: () => randomValues[randomCall++] ?? 0,
          sleep,
        },
      }),
    );

    assert.equal(outcome.kind, "allowed");
    assert.equal(server.sendCount, 3);
    // A fresh account lookup per attempt: the retry must not reuse the first
    // attempt's sequence number.
    assert.equal(server.accountLookupCount, 3);
    // Probe + enforced simulation for each of the three attempts.
    assert.equal(server.simulationCount, 6);
    // 0.25 x min(250, 100) = 25, then 0.75 x min(250, 200) = 150.
    assert.deepEqual(delays, [25, 150]);
  });

  it("does not sleep after a single configured attempt", async () => {
    let sleeps = 0;
    const server = createMockServer({
      send: () => ({ status: "PENDING", hash: "single-attempt" }),
      getTransaction: staleRejection,
    });

    const outcome = await invoke(
      makeParams(server, {
        ...FAST_POLL,
        retry: {
          maxAttempts: 1,
          sleep: async () => {
            sleeps += 1;
          },
        },
      }),
    );

    assert.ok(outcome instanceof InvokeRetryError);
    assert.equal(outcome.attempts, 1);
    assert.equal(sleeps, 0);
    assert.equal(server.sendCount, 1);
    assert.equal(server.simulationCount, 2);
  });

  it("returns a typed error with the final attempt count and cause when exhausted", async () => {
    const { delays, sleep } = sleepRecorder();
    const server = createMockServer({
      send: (call) => ({ status: "PENDING", hash: `stale-${call}` }),
      getTransaction: staleRejection,
    });

    const outcome = await invoke(
      makeParams(server, {
        ...FAST_POLL,
        retry: { maxAttempts: 3, baseDelayMs: 100, sleep, random: () => 0.5 },
      }),
    );

    assert.ok(outcome instanceof InvokeRetryError);
    assert.equal(outcome.kind, "error");
    assert.equal(outcome.attempts, 3);
    assert.equal(outcome.lastCause, "stale_ledger_resource_limit");
    assert.equal(outcome.cause, "stale_ledger_resource_limit");
    assert.match(outcome.message, /retry budget exhausted after 3 attempt/);
    assert.deepEqual(delays, [50, 100]);
    assert.equal(server.sendCount, 3);
    assert.equal(server.simulationCount, 6);
  });

  it("fails fast for invalid input without sleeping or broadcasting", async () => {
    let sleeps = 0;
    const server = createMockServer({
      simulate: invalidInputSimulation,
      send: () => ({ status: "PENDING", hash: "must-not-send" }),
    });

    const outcome = await invoke(
      makeParams(server, {
        ...FAST_POLL,
        retry: {
          maxAttempts: 3,
          sleep: async () => {
            sleeps += 1;
          },
        },
      }),
    );

    assert.equal(outcome.kind, "error");
    // The guard made no decision here, so this is `undetermined` — never
    // conflated with `blocked`, and never retried.
    assert.equal(outcome.kind === "error" ? outcome.cause : undefined, "undetermined");
    assert.equal(server.sendCount, 0);
    assert.equal(server.simulationCount, 1);
    assert.equal(sleeps, 0);
  });

  it("does not sleep again when a retry discovers a non-retryable failure", async () => {
    const { delays, sleep } = sleepRecorder();
    const server = createMockServer({
      simulate: (call) => (call >= 3 ? invalidInputSimulation() : probeSuccess()),
      send: (call) => ({ status: "PENDING", hash: `tx-${call}` }),
      getTransaction: (hash) => (hash === "tx-1" ? staleRejection() : { status: "SUCCESS", ledger: 9 }),
    });

    const outcome = await invoke(
      makeParams(server, {
        ...FAST_POLL,
        retry: { maxAttempts: 3, baseDelayMs: 10, random: () => 0.5, sleep },
      }),
    );

    assert.equal(outcome.kind, "error");
    assert.equal(outcome.kind === "error" ? outcome.cause : undefined, "undetermined");
    // Exactly one sleep: the first rejection is retryable, the second is not.
    assert.deepEqual(delays, [5]);
    assert.equal(server.sendCount, 1);
    assert.equal(server.simulationCount, 3);
  });
});


// ── Fee-bump retry on min-fee broadcast failure (Issue #25) ──────────────────

const FEE_BUMP_CONTRACT_ID = unsafeContractAddress(Address.contract(Buffer.alloc(32)).toString());
const FAST_POLL = { pollAttempts: 5, pollIntervalMs: 0 };

function createBlockedSimulationResponse(reason: string) {
  return {
    error: `HostError: Error(Contract, #${reason})`,
    events: [
      {
        event: {
          contractId: FEE_BUMP_CONTRACT_ID,
          type: "contract",
          body: {
            v0: {
              topics: [
                xdr.ScVal.scvSymbol("event_auth_checked"),
                xdr.ScVal.scvSymbol("blocked"),
                xdr.ScVal.scvSymbol(reason),
              ],
              data: xdr.ScVal.scvVoid(),
            },
          },
        },
      },
    ],
  };
}

function createSuccessSimulationResponse(minResourceFee = "500") {
  return {
    result: { auth: [] },
    transactionData: new SorobanDataBuilder(),
    minResourceFee,
    events: [],
  };
}

function createMinFeeErrorResponse(hash: string) {
  return {
    status: "ERROR" as const,
    hash,
    errorResult: new xdr.TransactionResult({
      feeCharged: 0n,
      result: xdr.TransactionResultResult.txInsufficientFee(),
      ext: xdr.TransactionResultExt.v0(),
    }),
  };
}

describe("invoke() fee-bump retry lifecycle", () => {
  it("Test 1 — fee bump succeeds: re-prepares, re-simulates, and succeeds on second broadcast", async () => {
    const source = Keypair.random();
    let seq = 100n;
    const getAccountCalls: string[] = [];
    const simulateCalls: xdr.Transaction[] = [];
    const sendCalls: xdr.Transaction[] = [];

    const mockServer = {
      getAccount: async (pubKey: string) => {
        getAccountCalls.push(pubKey);
        return { sequenceNumber: () => (seq++).toString() };
      },
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async (tx: xdr.Transaction) => {
        simulateCalls.push(tx);
        return createSuccessSimulationResponse("500");
      },
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        if (sendCalls.length === 1) {
          return createMinFeeErrorResponse("hash-attempt-1");
        }
        return {
          status: "PENDING" as const,
          hash: "hash-attempt-2",
        };
      },
      getTransaction: async (_hash: string) => ({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 1002,
      }),
    };

    const outcome = await invoke({
      server: mockServer as unknown as rpc.Server,
      source,
      call: { contract: FEE_BUMP_CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: PASSPHRASE,
      feeBump: { maxAttempts: 3, feeMultiplier: 2 },
      pollOptions: FAST_POLL,
    });

    assert.equal(outcome.kind, "allowed");
    assert.equal(sendCalls.length, 2, "must have attempted broadcast twice");
    assert.ok(simulateCalls.length >= 4, "must re-run probe and enforced simulation on retry");
  });

  it("Test 2 — fee bump remains too cheap: exhausts retry budget and returns typed BroadcastError", async () => {
    const source = Keypair.random();
    let seq = 100n;
    const sendCalls: xdr.Transaction[] = [];

    const mockServer = {
      getAccount: async () => ({ sequenceNumber: () => (seq++).toString() }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => createSuccessSimulationResponse("500"),
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        return createMinFeeErrorResponse(`hash-attempt-${sendCalls.length}`);
      },
      getTransaction: async () => ({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 1001,
      }),
    };

    const outcome = await invoke({
      server: mockServer as unknown as rpc.Server,
      source,
      call: { contract: FEE_BUMP_CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: PASSPHRASE,
      feeBump: { maxAttempts: 3, feeMultiplier: 2 },
      pollOptions: FAST_POLL,
    });

    // Budget exhausted: returns typed BroadcastError
    assert.ok(outcome instanceof BroadcastError);
    assert.equal(outcome.name, "BroadcastError");
    assert.equal(outcome.kind, "error");
    assert.equal(outcome.attempts, 3);
    assert.equal(outcome.lastFee, 900n);
    assert.match(outcome.message, /minimum fee not met after 3 attempt\(s\)/);
    assert.equal(sendCalls.length, 3, "must bound total broadcast attempts to configured max");
  });

  it("Test 3 — policy block during re-simulation prevents subsequent broadcast", async () => {
    const source = Keypair.random();
    let seq = 100n;
    const sendCalls: xdr.Transaction[] = [];
    let simulateCount = 0;

    const mockServer = {
      getAccount: async () => ({ sequenceNumber: () => (seq++).toString() }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => {
        simulateCount++;
        // Attempt 1: probe and enforced simulation succeed
        if (simulateCount <= 2) {
          return createSuccessSimulationResponse("500");
        }
        // Attempt 2: probe succeeds, but second (enforced) simulation blocks due to policy
        if (simulateCount === 3) {
          return createSuccessSimulationResponse("500");
        }
        return createBlockedSimulationResponse("spend_limit_exceeded");
      },
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        return createMinFeeErrorResponse("hash-attempt-1");
      },
      getTransaction: async () => ({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 1001,
      }),
    };

    const outcome = await invoke({
      server: mockServer as unknown as rpc.Server,
      source,
      call: { contract: FEE_BUMP_CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: PASSPHRASE,
      feeBump: { maxAttempts: 3, feeMultiplier: 2 },
      pollOptions: FAST_POLL,
    });

    // Re-simulation blocked by policy -> halts pipeline immediately without broadcast
    assert.equal(outcome.kind, "blocked");
    assert.equal(sendCalls.length, 1, "must never broadcast if re-simulation is policy-blocked");
  });

  it("Regression: happy path without fee bump still broadcasts once and succeeds", async () => {
    const source = Keypair.random();
    let seq = 100n;
    const sendCalls: xdr.Transaction[] = [];

    const mockServer = {
      getAccount: async () => ({ sequenceNumber: () => (seq++).toString() }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => createSuccessSimulationResponse("500"),
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        return { status: "PENDING" as const, hash: "happy-hash" };
      },
      getTransaction: async () => ({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 1002,
      }),
    };

    const outcome = await invoke({
      server: mockServer as unknown as rpc.Server,
      source,
      call: { contract: FEE_BUMP_CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: PASSPHRASE,
      pollOptions: FAST_POLL,
    });

    assert.equal(outcome.kind, "allowed");
    assert.equal(sendCalls.length, 1);
  });

  it("Regression: non-fee broadcast error does not trigger fee bumping", async () => {
    const source = Keypair.random();
    let seq = 100n;
    const sendCalls: xdr.Transaction[] = [];

    const mockServer = {
      getAccount: async () => ({ sequenceNumber: () => (seq++).toString() }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => createSuccessSimulationResponse("500"),
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        return {
          status: "ERROR" as const,
          hash: "bad-auth-hash",
          errorResult: new xdr.TransactionResult({
            feeCharged: 0n,
            result: xdr.TransactionResultResult.txBadAuth(),
            ext: xdr.TransactionResultExt.v0(),
          }),
        };
      },
      getTransaction: async () => ({
        status: rpc.Api.GetTransactionStatus.FAILED,
        ledger: 1001,
      }),
    };

    const outcome = await invoke({
      server: mockServer as unknown as rpc.Server,
      source,
      call: { contract: FEE_BUMP_CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: PASSPHRASE,
      pollOptions: FAST_POLL,
    });

    assert.equal(outcome.kind, "error");
    assert.ok(!(outcome instanceof BroadcastError));
    // No retry for non-fee error
    assert.equal(sendCalls.length, 1);
  });

  it("Regression: initial policy block never attempts broadcast", async () => {
    const source = Keypair.random();
    let seq = 100n;
    const sendCalls: xdr.Transaction[] = [];
    let simCallCount = 0;

    const mockServer = {
      getAccount: async () => ({ sequenceNumber: () => (seq++).toString() }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => {
        simCallCount++;
        if (simCallCount === 1) {
          // Probe succeeds in recording mode
          return createSuccessSimulationResponse("500");
        }
        // Enforced simulation blocks
        return createBlockedSimulationResponse("admin_frozen");
      },
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        return { status: "PENDING" as const, hash: "unreachable" };
      },
      getTransaction: async () => ({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 1001,
      }),
    };

    const outcome = await invoke({
      server: mockServer as unknown as rpc.Server,
      source,
      call: { contract: FEE_BUMP_CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: PASSPHRASE,
      pollOptions: FAST_POLL,
    });

    assert.equal(outcome.kind, "blocked");
    assert.equal(sendCalls.length, 0);
  });

  it("Regression: stale-ledger resource failure coordinates within the same retry envelope", async () => {
    const source = Keypair.random();
    let seq = 100n;
    const sendCalls: xdr.Transaction[] = [];

    const mockServer = {
      getAccount: async () => ({ sequenceNumber: () => (seq++).toString() }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => createSuccessSimulationResponse("500"),
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        return { status: "PENDING" as const, hash: `stale-tx-${sendCalls.length}` };
      },
      getTransaction: async (hash: string) => {
        if (hash === "stale-tx-1") {
          return {
            status: rpc.Api.GetTransactionStatus.FAILED,
            ledger: 1001,
            resultXdr: null,
            diagnosticEventsXdr: [
              {
                body: {
                  v0: {
                    topics: ["error", { type: "system", code: 5, value: "scecExceededLimit" }],
                    data: ["operation byte-write resources exceeds amount specified"],
                  },
                },
              },
            ],
          };
        }
        return {
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 1002,
        };
      },
    };

    const outcome = await invoke({
      server: mockServer as unknown as rpc.Server,
      source,
      call: { contract: FEE_BUMP_CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: PASSPHRASE,
      pollOptions: FAST_POLL,
    });

    assert.equal(outcome.kind, "allowed");
    assert.equal(sendCalls.length, 2);
  });
});

// ── Public option validation (issue #296) ────────────────────────────────────

/**
 * A server that fails loudly if any RPC method is touched. Table-driven option
 * tests assert zero calls on it: invalid options must fail before RPC I/O, not
 * after a probe simulation has already cost a round trip.
 */
function createUntouchableServer(): { server: rpc.Server; readonly calls: number } {
  let calls = 0;
  const touch = (name: string): never => {
    calls += 1;
    throw new Error(`RPC ${name} must not be called for invalid invoke options`);
  };
  const server = {
    getAccount: async () => touch("getAccount"),
    getLatestLedger: async () => touch("getLatestLedger"),
    simulateTransaction: async () => touch("simulateTransaction"),
    sendTransaction: async () => touch("sendTransaction"),
    getTransaction: async () => touch("getTransaction"),
  } as unknown as rpc.Server;
  return {
    server,
    get calls() {
      return calls;
    },
  };
}

describe("invoke() option validation", () => {
  it("rejects invalid and contradictory options with field-specific errors before any RPC", async () => {
    const cases: Array<{
      label: string;
      overrides: Partial<Parameters<typeof invoke>[0]>;
      field: RegExp;
    }> = [
      { label: "retry.maxAttempts zero", overrides: { retry: { maxAttempts: 0 } }, field: /retry\.maxAttempts/ },
      { label: "retry.maxAttempts fractional", overrides: { retry: { maxAttempts: 1.5 } }, field: /retry\.maxAttempts/ },
      { label: "retry.maxAttempts NaN", overrides: { retry: { maxAttempts: Number.NaN } }, field: /retry\.maxAttempts/ },
      { label: "retry.baseDelayMs negative", overrides: { retry: { baseDelayMs: -1 } }, field: /retry\.baseDelayMs/ },
      { label: "retry.baseDelayMs infinite", overrides: { retry: { baseDelayMs: Number.POSITIVE_INFINITY } }, field: /retry\.baseDelayMs/ },
      { label: "retry.maxDelayMs negative", overrides: { retry: { maxDelayMs: -1 } }, field: /retry\.maxDelayMs/ },
      {
        label: "retry.maxDelayMs below baseDelayMs",
        overrides: { retry: { baseDelayMs: 100, maxDelayMs: 50 } },
        field: /retry\.maxDelayMs/,
      },
      {
        label: "retry aliases disagree",
        overrides: { retry: { baseDelayMs: 100, initialDelayMs: 50 } },
        field: /retry\.initialDelayMs/,
      },
      { label: "retry.random not a function", overrides: { retry: { random: 1 as unknown as () => number } }, field: /retry\.random/ },
      { label: "retry.random and jitter both set", overrides: { retry: { random: () => 0.5, jitter: () => 0.5 } }, field: /retry\.jitter/ },
      { label: "maxRetries negative", overrides: { maxRetries: -1 }, field: /maxRetries/ },
      { label: "maxRetries fractional", overrides: { maxRetries: 1.5 }, field: /maxRetries/ },
      { label: "feeBump.maxAttempts zero", overrides: { feeBump: { maxAttempts: 0 } }, field: /feeBump\.maxAttempts/ },
      { label: "feeBump.feeMultiplier at one", overrides: { feeBump: { feeMultiplier: 1 } }, field: /feeBump\.feeMultiplier/ },
      { label: "feeBump.feeMultiplier NaN", overrides: { feeBump: { feeMultiplier: Number.NaN } }, field: /feeBump\.feeMultiplier/ },
      { label: "feeBump.initialInclusionFee zero", overrides: { feeBump: { initialInclusionFee: 0n } }, field: /feeBump\.initialInclusionFee/ },
      { label: "pollAttempts zero", overrides: { pollAttempts: 0 }, field: /pollAttempts/ },
      { label: "pollAttempts fractional", overrides: { pollAttempts: 2.5 }, field: /pollAttempts/ },
      { label: "pollIntervalMs negative", overrides: { pollIntervalMs: -1 }, field: /pollIntervalMs/ },
      { label: "pollIntervalMs NaN", overrides: { pollIntervalMs: Number.NaN }, field: /pollIntervalMs/ },
      { label: "pollOptions.pollAttempts zero", overrides: { pollOptions: { pollAttempts: 0 } }, field: /pollOptions\.pollAttempts/ },
      { label: "pollOptions.pollIntervalMs negative", overrides: { pollOptions: { pollIntervalMs: -1 } }, field: /pollOptions\.pollIntervalMs/ },
      {
        label: "top-level and nested pollAttempts disagree",
        overrides: { pollAttempts: 1, pollOptions: { pollAttempts: 2 } },
        field: /pollOptions\.pollAttempts/,
      },
      {
        label: "top-level and nested pollIntervalMs disagree",
        overrides: { pollIntervalMs: 1, pollOptions: { pollIntervalMs: 2 } },
        field: /pollOptions\.pollIntervalMs/,
      },
      { label: "timeoutMs negative", overrides: { timeoutMs: -1 }, field: /timeoutMs/ },
      { label: "deadlineMs zero", overrides: { deadlineMs: 0 }, field: /deadlineMs/ },
      { label: "deadlineMs infinite", overrides: { deadlineMs: Number.POSITIVE_INFINITY }, field: /deadlineMs/ },
    ];

    for (const testCase of cases) {
      const { server, calls } = createUntouchableServer();
      await assert.rejects(
        invoke(makeParams(server, testCase.overrides)),
        (error: unknown) => {
          assert.ok(error instanceof RangeError, testCase.label);
          assert.match(error.message, testCase.field, testCase.label);
          return true;
        },
      );
      assert.equal(calls, 0, testCase.label);
    }
  });

  it("rejects a jitter sample outside [0, 1) before scheduling another RPC", async () => {
    const server = createMockServer({
      send: () => ({ status: "PENDING", hash: "bad-jitter" }),
      getTransaction: staleRejection,
    });

    await assert.rejects(
      invoke(
        makeParams(server, {
          pollOptions: { pollAttempts: 1, pollIntervalMs: 0 },
          retry: {
            maxAttempts: 2,
            baseDelayMs: 10,
            random: () => 1,
            sleep: async () => undefined,
          },
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof RangeError);
        assert.match(error.message, /retry\.random/);
        return true;
      },
    );
    assert.equal(server.sendCount, 1);
    assert.equal(server.simulationCount, 2);
  });

  it("applies maxRetries as an overall attempt bound", async () => {
    let sleeps = 0;
    const server = createMockServer({
      send: (call) => ({ status: "PENDING", hash: `bounded-${call}` }),
      getTransaction: staleRejection,
    });

    const outcome = await invoke(
      makeParams(server, {
        pollOptions: { pollAttempts: 1, pollIntervalMs: 0 },
        maxRetries: 0,
        retry: {
          maxAttempts: 10,
          sleep: async () => {
            sleeps += 1;
          },
        },
      }),
    );

    assert.ok(outcome instanceof InvokeRetryError);
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.retry.attempts, 1);
    assert.equal(outcome.retry.maxAttempts, 1);
    assert.equal(sleeps, 0);
    assert.equal(server.sendCount, 1);
  });
});

// ── Structured retry metadata (issue #297) ───────────────────────────────────

const RETRY_METADATA_KEYS = [
  "attempts",
  "exhausted",
  "maxAttempts",
  "outcome",
  "retried",
  "retries",
  "terminalCause",
  "terminalFailure",
  "totalDelayMs",
];

function sequenceRejection(): unknown {
  return {
    status: "FAILED",
    hash: "sequence",
    resultXdr: null,
    diagnosticEventsXdr: ["tx_bad_seq"],
  };
}

describe("invoke() retry metadata", () => {
  const FAST = { pollAttempts: 1, pollIntervalMs: 0 };

  it("records a successful stale-ledger recovery without leaking payloads", async () => {
    const server = createMockServer({
      send: (call) => ({ status: "PENDING", hash: `recover-${call}` }),
      getTransaction: (hash) =>
        hash === "recover-1" ? staleRejection() : { status: "SUCCESS", ledger: 77 },
    });

    const outcome = await invoke(
      makeParams(server, {
        ...FAST,
        retry: { maxAttempts: 3, baseDelayMs: 100, random: () => 0.5, sleep: async () => undefined },
      }),
    );

    assert.equal(outcome.kind, "allowed");
    const metadata = outcome.retry;
    assert.ok(metadata);
    assert.equal(metadata.attempts, 2);
    assert.equal(metadata.retried, true);
    assert.equal(metadata.exhausted, false);
    assert.equal(metadata.totalDelayMs, 50);
    assert.equal(metadata.terminalFailure, null);
    assert.equal(metadata.terminalCause, null);
    assert.equal(metadata.outcome, "allowed");
    assert.deepEqual(metadata.retries, [
      {
        attempt: 1,
        failure: "stale_ledger_resource_limit",
        cause: "stale_ledger_resource_limit",
        delayMs: 50,
      },
    ]);

    assert.deepEqual(Object.keys(metadata).sort(), RETRY_METADATA_KEYS);
    assert.deepEqual(Object.keys(metadata.retries[0]!).sort(), [
      "attempt",
      "cause",
      "delayMs",
      "failure",
    ]);
    const serialised = JSON.stringify(metadata);
    assert.doesNotMatch(serialised, /resultXdr|diagnostic|signature|secret|AAAA/i);
  });

  it("records stale-ledger exhaustion and the terminal attempt", async () => {
    const server = createMockServer({
      send: (call) => ({ status: "PENDING", hash: `stale-${call}` }),
      getTransaction: staleRejection,
    });

    const outcome = await invoke(
      makeParams(server, {
        ...FAST,
        retry: { maxAttempts: 2, baseDelayMs: 100, random: () => 0.5, sleep: async () => undefined },
      }),
    );

    assert.ok(outcome instanceof InvokeRetryError);
    assert.equal(outcome.retry.attempts, 2);
    assert.equal(outcome.retry.maxAttempts, 2);
    assert.equal(outcome.retry.exhausted, true);
    assert.equal(outcome.retry.terminalFailure, "stale_ledger_resource_limit");
    assert.equal(outcome.retry.terminalCause, "stale_ledger_resource_limit");
    assert.equal(outcome.retry.retries.length, 1);
    assert.equal(outcome.retry.totalDelayMs, 50);
  });

  it("recovers from a sequence collision and records the class", async () => {
    const server = createMockServer({
      send: (call) => ({ status: "PENDING", hash: `seq-${call}` }),
      getTransaction: (hash) =>
        hash === "seq-1" ? sequenceRejection() : { status: "SUCCESS", ledger: 88 },
    });

    const outcome = await invoke(
      makeParams(server, {
        ...FAST,
        retry: { maxAttempts: 3, baseDelayMs: 100, random: () => 0.5, sleep: async () => undefined },
      }),
    );

    assert.equal(outcome.kind, "allowed");
    assert.ok(outcome.retry);
    assert.equal(outcome.retry.retried, true);
    assert.deepEqual(outcome.retry.retries.map((attempt) => attempt.failure), [
      "sequence_number_collision",
    ]);
    assert.equal(outcome.retry.terminalFailure, null);
  });

  it("records sequence-collision exhaustion", async () => {
    const server = createMockServer({
      send: (call) => ({ status: "PENDING", hash: `seq-${call}` }),
      getTransaction: sequenceRejection,
    });

    const outcome = await invoke(
      makeParams(server, {
        ...FAST,
        retry: { maxAttempts: 2, baseDelayMs: 100, random: () => 0.5, sleep: async () => undefined },
      }),
    );

    assert.ok(outcome instanceof InvokeRetryError);
    assert.equal(outcome.retry.exhausted, true);
    assert.equal(outcome.retry.terminalFailure, "sequence_number_collision");
    assert.equal(outcome.retry.terminalCause, "sequence_number_collision");
  });

  it("records a successful min-fee fee bump", async () => {
    const sendCalls: xdr.Transaction[] = [];
    const server = {
      getAccount: async () => ({ sequenceNumber: () => "100" }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => createSuccessSimulationResponse("500"),
      sendTransaction: async (tx: xdr.Transaction) => {
        sendCalls.push(tx);
        if (sendCalls.length === 1) return createMinFeeErrorResponse("fee-1");
        return { status: "PENDING" as const, hash: "fee-2" };
      },
      getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 1002 }),
    } as unknown as rpc.Server;

    const outcome = await invoke({
      server,
      source: Keypair.random(),
      call: { contract: FEE_BUMP_CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: PASSPHRASE,
      feeBump: { maxAttempts: 2, feeMultiplier: 2 },
      pollOptions: FAST_POLL,
    });

    assert.equal(outcome.kind, "allowed");
    assert.ok(outcome.retry);
    assert.equal(outcome.retry.attempts, 2);
    assert.equal(outcome.retry.exhausted, false);
    assert.equal(outcome.retry.totalDelayMs, 0);
    assert.deepEqual(outcome.retry.retries, [
      { attempt: 1, failure: "min_fee", cause: "undetermined", delayMs: 0 },
    ]);
  });

  it("records min-fee exhaustion on the typed BroadcastError", async () => {
    let sends = 0;
    const server = {
      getAccount: async () => ({ sequenceNumber: () => "100" }),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => createSuccessSimulationResponse("500"),
      sendTransaction: async () => createMinFeeErrorResponse(`fee-${++sends}`),
      getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.FAILED, ledger: 1001 }),
    } as unknown as rpc.Server;

    const outcome = await invoke({
      server,
      source: Keypair.random(),
      call: { contract: FEE_BUMP_CONTRACT_ID, fn: "transfer", args: [] },
      networkPassphrase: PASSPHRASE,
      feeBump: { maxAttempts: 2, feeMultiplier: 2 },
      pollOptions: FAST_POLL,
    });

    assert.ok(outcome instanceof BroadcastError);
    assert.ok(outcome.retry);
    assert.equal(outcome.retry.attempts, 2);
    assert.equal(outcome.retry.maxAttempts, 2);
    assert.equal(outcome.retry.exhausted, true);
    assert.equal(outcome.retry.terminalFailure, "min_fee");
    assert.equal(outcome.retry.retries.length, 1);
  });
});

// ── Overall deadline (issue #298) ────────────────────────────────────────────

/**
 * A deadline much larger than the real default RPC timeout, so the virtual
 * clock—not a wall-clock timer on a slow CI runner—decides the test. Tests
 * advance the injected clock past the deadline explicitly.
 */
const VIRTUAL_DEADLINE_MS = 60_000;

function expectDeadlineError(outcome: Awaited<ReturnType<typeof invoke>>): RpcTimeoutError {
  assert.equal(outcome.kind, "error");
  if (outcome.kind !== "error") throw new Error("unreachable");
  assert.ok(outcome.error instanceof RpcTimeoutError);
  assert.equal(outcome.error.deadline, true);
  assert.equal(outcome.error.cause, "timeout");
  return outcome.error;
}

describe("invoke() overall deadline", () => {
  it("fails closed during discovery before any simulation", async () => {
    const clock = new FakeClock(0);
    let simulations = 0;
    let sends = 0;
    const server = {
      getAccount: async () => {
        clock.advance(VIRTUAL_DEADLINE_MS + 1);
        return new Account(Keypair.random().publicKey(), "100");
      },
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => {
        simulations += 1;
        return probeSuccess();
      },
      sendTransaction: async () => {
        sends += 1;
        return { status: "PENDING" as const, hash: "unreachable" };
      },
      getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 1 }),
    } as unknown as rpc.Server;

    const outcome = await invoke(makeParams(server, { deadlineMs: VIRTUAL_DEADLINE_MS, clock }));
    const error = expectDeadlineError(outcome);
    assert.equal(error.stage, "probe");
    assert.equal(simulations, 0);
    assert.equal(sends, 0);
  });

  it("fails closed while signing after a successful probe", async () => {
    const clock = new FakeClock(0);
    let simulations = 0;
    let sends = 0;
    const server = {
      getAccount: async () => new Account(Keypair.random().publicKey(), "100"),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => {
        simulations += 1;
        if (simulations === 1) clock.advance(VIRTUAL_DEADLINE_MS + 1);
        return probeSuccess();
      },
      sendTransaction: async () => {
        sends += 1;
        return { status: "PENDING" as const, hash: "unreachable" };
      },
      getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 1 }),
    } as unknown as rpc.Server;

    const outcome = await invoke(makeParams(server, { deadlineMs: VIRTUAL_DEADLINE_MS, clock }));
    const error = expectDeadlineError(outcome);
    assert.equal(error.stage, "sign");
    assert.equal(simulations, 1);
    assert.equal(sends, 0);
  });

  it("never sleeps past the deadline during backoff", async () => {
    const clock = new FakeClock(0);
    const sleeps: number[] = [];
    const server = createMockServer({
      send: (call) => ({ status: "PENDING", hash: `deadline-${call}` }),
      getTransaction: staleRejection,
    });

    const outcome = await invoke(
      makeParams(server, {
        pollOptions: { pollAttempts: 1, pollIntervalMs: 0 },
        deadlineMs: VIRTUAL_DEADLINE_MS,
        clock,
        retry: {
          maxAttempts: 3,
          baseDelayMs: VIRTUAL_DEADLINE_MS * 2,
          maxDelayMs: VIRTUAL_DEADLINE_MS * 2,
          random: () => 0.5,
          sleep: async (delayMs) => {
            sleeps.push(delayMs);
            clock.advance(delayMs);
          },
        },
      }),
    );

    const error = expectDeadlineError(outcome);
    assert.equal(error.stage, "retry_backoff");
    assert.deepEqual(sleeps, [VIRTUAL_DEADLINE_MS]);
    assert.ok(outcome.kind === "error" && outcome.retry);
    assert.equal(outcome.retry.attempts, 1);
    assert.equal(outcome.retry.totalDelayMs, VIRTUAL_DEADLINE_MS);
    assert.equal(outcome.retry.retries.length, 1);
    assert.equal(server.sendCount, 1);
    assert.equal(server.simulationCount, 2);
  });

  it("consumes the same budget in post-submit polling", async () => {
    let now = 0;
    const clock: Clock = {
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
    };
    let polls = 0;
    const server = {
      getAccount: async () => new Account(Keypair.random().publicKey(), "100"),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => probeSuccess(),
      sendTransaction: async () => ({ status: "PENDING" as const, hash: "poll-deadline" }),
      getTransaction: async () => {
        polls += 1;
        return { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 2 };
      },
    } as unknown as rpc.Server;

    const outcome = await invoke(
      makeParams(server, {
        deadlineMs: VIRTUAL_DEADLINE_MS,
        clock,
        pollOptions: { pollAttempts: 5, pollIntervalMs: VIRTUAL_DEADLINE_MS * 2 },
      }),
    );

    const error = expectDeadlineError(outcome);
    assert.equal(error.stage, "poll");
    assert.equal(polls, 0, "the deadline must fire before another getTransaction");
    assert.ok(outcome.kind === "error" && outcome.retry);
    assert.equal(outcome.retry.attempts, 1);
    assert.equal(outcome.retry.retries.length, 0);
  });

  it("reports a dry run as undetermined, never admissible, when the deadline expires", async () => {
    const clock = new FakeClock(0);
    let simulations = 0;
    const server = {
      getAccount: async () => new Account(Keypair.random().publicKey(), "100"),
      getLatestLedger: async () => ({ sequence: 1000 }),
      simulateTransaction: async () => {
        simulations += 1;
        if (simulations === 2) clock.advance(VIRTUAL_DEADLINE_MS + 1);
        return probeSuccess();
      },
      sendTransaction: async () => ({ status: "PENDING" as const, hash: "unreachable" }),
      getTransaction: async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 1 }),
    } as unknown as rpc.Server;

    const outcome = await invoke(
      makeParams(server, { dryRun: true, deadlineMs: VIRTUAL_DEADLINE_MS, clock }),
    );

    assert.equal(outcome.kind, "dry_run");
    if (outcome.kind !== "dry_run") throw new Error("unreachable");
    assert.equal(outcome.admissible, false);
    assert.equal(outcome.verdict, "undetermined");
    assert.ok(outcome.error instanceof RpcTimeoutError);
    assert.equal(outcome.error.deadline, true);
    assert.equal(outcome.fees.totalFeeStroops, 0n);
  });
});

// ── The transaction hash, published before the confirmation polling ─────────

/**
 * The transaction hash is the operator's recovery handle after the broadcast.
 *
 * These tests pin *when* it becomes available: as soon as the network accepts
 * the submission, not only when the whole invocation returns. A caller that
 * has to wait for a long — or exhausted — confirmation poll must still be able
 * to find the transaction, and must never have to scrape it out of an error
 * string or a log line.
 */
describe("invoke() submission hash", () => {
  const HASH = "b".repeat(64);

  it("publishes the hash before the confirmation polling starts", async () => {
    const order: string[] = [];
    const events: SubmissionAcceptedEvent[] = [];
    const server = createMockServer({
      send: () => {
        order.push("send");
        return { status: "PENDING", hash: HASH };
      },
      getTransaction: (hash) => {
        order.push(`poll:${hash}`);
        return { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 42 };
      },
    });

    const outcome = await invoke(
      makeParams(server, {
        pollOptions: { pollAttempts: 1, pollIntervalMs: 0 },
        onSubmitted: (event) => {
          order.push("submitted");
          events.push(event);
        },
      }),
    );

    assert.equal(outcome.kind, "allowed");
    assert.deepEqual(events, [{ hash: HASH, status: "PENDING" }]);
    assert.deepEqual(order, ["send", "submitted", `poll:${HASH}`]);
  });

  it("keeps the hash when the status poll fails after the broadcast", async () => {
    const events: SubmissionAcceptedEvent[] = [];
    const server = createMockServer({
      send: () => ({ status: "PENDING", hash: HASH }),
      getTransaction: () => {
        throw new Error("rpc unavailable");
      },
    });

    const outcome = await invoke(
      makeParams(server, {
        pollOptions: { pollAttempts: 1, pollIntervalMs: 0 },
        onSubmitted: (event) => events.push(event),
      }),
    );

    assert.equal(outcome.kind, "error");
    assert.ok(outcome.error instanceof BroadcastError);
    // The recovery handle survives the failed poll: both on the event and on
    // the outcome, so a caller never has to parse it out of the error text.
    assert.deepEqual(events, [{ hash: HASH, status: "PENDING" }]);
    assert.equal(outcome.transactionHash, HASH);
    assert.equal(outcome.error.transactionHash, HASH);
  });

  it("keeps the hash when the overall deadline stops the confirmation polling", async () => {
    let now = 0;
    const clock: Clock = {
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
    };
    const events: SubmissionAcceptedEvent[] = [];
    const server = createMockServer({
      send: () => ({ status: "PENDING", hash: HASH }),
      getTransaction: () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 42 }),
    });

    const outcome = await invoke(
      makeParams(server, {
        deadlineMs: VIRTUAL_DEADLINE_MS,
        clock,
        pollOptions: { pollAttempts: 5, pollIntervalMs: VIRTUAL_DEADLINE_MS * 2 },
        onSubmitted: (event) => events.push(event),
      }),
    );

    const error = expectDeadlineError(outcome);
    assert.equal(error.stage, "poll");
    assert.deepEqual(events, [{ hash: HASH, status: "PENDING" }]);
    assert.equal(outcome.kind === "error" ? outcome.transactionHash : undefined, HASH);
  });

  it("fails closed when the broadcast response names no transaction", async () => {
    const events: SubmissionAcceptedEvent[] = [];
    let polls = 0;
    const server = createMockServer({
      send: () => ({ status: "PENDING", hash: "" }),
      getTransaction: () => {
        polls += 1;
        return { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 42 };
      },
    });

    const outcome = await invoke(
      makeParams(server, {
        pollOptions: { pollAttempts: 1, pollIntervalMs: 0 },
        onSubmitted: (event) => events.push(event),
      }),
    );

    assert.equal(outcome.kind, "error");
    assert.ok(outcome.error instanceof BroadcastError);
    assert.equal(outcome.error.transactionHash, null);
    // The ambiguity is reported, not hidden: the caller learns that the
    // submission was accepted but cannot be tracked.
    assert.deepEqual(events, [{ hash: null, status: "PENDING" }]);
    assert.equal(polls, 0, "an untrackable transaction must not be polled for");
  });

  it("changes nothing when no hook is supplied", async () => {
    const server = createMockServer({
      send: () => ({ status: "PENDING", hash: HASH }),
      getTransaction: () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 42 }),
    });

    const outcome = await invoke(
      makeParams(server, { pollOptions: { pollAttempts: 1, pollIntervalMs: 0 } }),
    );

    assert.equal(outcome.kind, "allowed");
    assert.equal(outcome.kind === "allowed" ? outcome.submission.hash : undefined, HASH);
  });
});

// ── Malformed simulation fees are classified, not converted ─────────────────

/**
 * A malformed resource fee must fail the way every other malformed contract
 * response fails: with the SDK's typed `ContractResponseError`, naming the
 * field and the stage. A native `BigInt` conversion error says neither, and
 * escapes the SDK's own classification.
 */
describe("invoke() malformed simulation resource fee", () => {
  function enforcedWithFee(minResourceFee: unknown) {
    return {
      ...(probeSuccess() as Record<string, unknown>),
      minResourceFee,
    };
  }

  it("reports a malformed enforced-simulation fee as a typed contract-response error", async () => {
    for (const value of [undefined, null, "", "not-a-fee", "1.5", -1, 2n ** 64n]) {
      const server = createMockServer({ enforced: () => enforcedWithFee(value) });

      const outcome = await invoke(makeParams(server));

      assert.equal(outcome.kind, "error");
      assert.ok(
        outcome.error instanceof ContractResponseError,
        `expected a ContractResponseError for ${String(value)}`,
      );
      assert.equal(outcome.error.field, "minResourceFee");
      assert.equal(outcome.error.stage, "assemble");
      assert.match(outcome.kind === "error" ? (outcome.detail ?? "") : "", /assembly failed/);
      assert.equal(server.sendCount, 0, "a malformed fee must stop the pipeline before the broadcast");
    }
  });

  it("accepts the fee in every representation the SDK may hand back", async () => {
    for (const value of ["42", 42, 42n]) {
      const server = createMockServer({ enforced: () => enforcedWithFee(value) });

      const outcome = await invoke(
        makeParams(server, { pollOptions: { pollAttempts: 1, pollIntervalMs: 0 } }),
      );

      assert.equal(outcome.kind, "allowed");
    }
  });

  it("reports a malformed fee in a dry run as undetermined, never admissible", async () => {
    const server = createMockServer({ enforced: () => enforcedWithFee("not-a-fee") });

    const outcome = await invoke(makeParams(server, { dryRun: true }));

    assert.equal(outcome.kind, "dry_run");
    if (outcome.kind !== "dry_run") throw new Error("unreachable");
    assert.equal(outcome.admissible, false);
    assert.equal(outcome.verdict, "undetermined");
    assert.ok(outcome.error instanceof ContractResponseError);
    assert.equal(outcome.error.field, "minResourceFee");
    assert.equal(outcome.error.stage, "simulate");
    assert.equal(outcome.fees.totalFeeStroops, 0n);
  });
});
