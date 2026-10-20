/**
 * Unit tests for PreFlightInterceptor:
 *  - Input validation and the throw-vs-verdict contract
 *  - Opt-in pre-flight simulation cache
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Account, Address, Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import {
  InvalidInputError,
  PreFlightInterceptor,
  PreFlightUndeterminedError,
  validateContractCall,
  type PreFlightCacheOptions,
  type PreFlightCheckOptions,
  type PreFlightDecision,
} from "../../src/preflight.ts";
import { RpcTimeoutError } from "../../src/invoke.ts";
import { FakeClock } from "../../src/clock.ts";
import { GuardBlockedError } from "../../src/reasons.ts";
import type { PolicyConfig } from "../../src/policy.ts";
import type { ContractCall } from "../../src/tx.ts";
import { unsafeContractAddress, unsafeAccountAddress } from "../../src/policy.ts";

const VALID_GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
const VALID_TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const RECIPIENT = unsafeAccountAddress("GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH");

function validTransferCall(amount: bigint = 100n): ContractCall {
  return {
    contract: VALID_TOKEN,
    fn: "transfer",
    args: [
      new Address(VALID_GUARD).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
    ],
  };
}

/** Mock RPC server to track calls and assert zero requests when validation fails. */
function createMockServer(options?: {
  simulateResponse?: unknown;
  enforcedSimulateResponse?: unknown;
  simulateDelayMs?: number;
  simulateSignal?: AbortSignal;
}) {
  let requestCount = 0;
  let simulateCount = 0;
  const mock = {
    get requestCount() {
      return requestCount;
    },
    async getAccount() {
      requestCount++;
      return {
        sequenceNumber: () => "100",
      };
    },
    async getLatestLedger() {
      requestCount++;
      return { sequence: 1000 };
    },
    async simulateTransaction() {
      requestCount++;
      simulateCount++;
      if (options?.simulateDelayMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.simulateDelayMs);
          const signal = options.simulateSignal;
          if (signal) {
            if (signal.aborted) {
              clearTimeout(timer);
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }
        });
      }
      if (simulateCount === 2 && options?.enforcedSimulateResponse !== undefined) {
        return options.enforcedSimulateResponse;
      }
      return (
        options?.simulateResponse ?? {
          minResourceFee: "100",
          result: {
            auth: [],
          },
          transactionData: {
            getReadOnly: () => [],
            getReadWrite: () => [],
          },
        }
      );
    },
  } as unknown as rpc.Server & { requestCount: number };
  return mock;
}

function createTestInterceptor(server: rpc.Server) {
  return new PreFlightInterceptor({
    server,
    networkPassphrase: "Test SDF Network ; September 2015",
    guard: VALID_GUARD,
    agent: Keypair.random(),
    source: Keypair.random(),
  });
}

describe("validateContractCall validator unit tests", () => {
  describe("contract format validation", () => {
    it("rejects missing or empty contract string", () => {
      assert.throws(
        () => validateContractCall({ contract: unsafeContractAddress(""), fn: "transfer", args: [] }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "contract");
          assert.equal(err.rule, "required");
          return true;
        },
      );
    });

    it("rejects non-StrKey or malformed contract IDs", () => {
      for (const bad of ["invalid-contract", "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH", "C1234"]) {
        assert.throws(
          () => validateContractCall({ contract: unsafeContractAddress(bad), fn: "transfer", args: [] }),
          (err: unknown) => {
            assert(err instanceof InvalidInputError);
            assert.equal(err.field, "contract");
            assert.equal(err.rule, "invalid_format");
            return true;
          },
        );
      }
    });

    it("accepts valid StrKey C... contract ID", () => {
      assert.doesNotThrow(() =>
        validateContractCall({ contract: VALID_TOKEN, fn: "balance", args: [] }),
      );
    });
  });

  describe("method presence and shape validation", () => {
    it("rejects missing or empty fn string", () => {
      assert.throws(
        () => validateContractCall({ contract: VALID_TOKEN, fn: "", args: [] }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "fn");
          assert.equal(err.rule, "required");
          return true;
        },
      );
    });

    it("rejects method names with spaces, dashes, or special characters", () => {
      for (const bad of ["transfer tokens", "transfer-from", "transfer!"]) {
        assert.throws(
          () => validateContractCall({ contract: VALID_TOKEN, fn: bad, args: [] }),
          (err: unknown) => {
            assert(err instanceof InvalidInputError);
            assert.equal(err.field, "fn");
            assert.equal(err.rule, "symbol_shape");
            return true;
          },
        );
      }
    });

    it("rejects method names longer than Soroban 32-character symbol limit", () => {
      const toolong = "a".repeat(33);
      assert.throws(
        () => validateContractCall({ contract: VALID_TOKEN, fn: toolong, args: [] }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "fn");
          assert.equal(err.rule, "symbol_shape");
          return true;
        },
      );
    });
  });

  describe("args array & ScVal type validation", () => {
    it("rejects non-array args", () => {
      assert.throws(
        () => validateContractCall({ contract: VALID_TOKEN, fn: "transfer", args: null as unknown as xdr.ScVal[] }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "args");
          assert.equal(err.rule, "array");
          return true;
        },
      );
    });

    it("rejects args with non-ScVal elements", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "some_fn",
            args: ["not-an-scval" as unknown as xdr.ScVal],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "args");
          assert.equal(err.rule, "typed_scval");
          return true;
        },
      );
    });
  });

  describe("amount type validation for SAC operations", () => {
    it("rejects transfer with missing arguments", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "transfer",
            args: [new Address(VALID_GUARD).toScVal()],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "args");
          assert.equal(err.rule, "missing_argument");
          return true;
        },
      );
    });

    it("rejects transfer where amount is not an i128 ScVal", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "transfer",
            args: [
              new Address(VALID_GUARD).toScVal(),
              new Address(RECIPIENT).toScVal(),
              // non-i128 ScVal (u32)
              nativeToScVal(100, { type: "u32" }),
            ],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "amount");
          assert.equal(err.rule, "i128_type");
          return true;
        },
      );
    });

    it("rejects transfer where amount is raw non-ScVal string", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "transfer",
            args: [
              new Address(VALID_GUARD).toScVal(),
              new Address(RECIPIENT).toScVal(),
              "1000" as unknown as xdr.ScVal,
            ],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "amount");
          assert.equal(err.rule, "i128_type");
          return true;
        },
      );
    });

    it("rejects transfer_from where amount is not an i128 ScVal", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "transfer_from",
            args: [
              new Address(VALID_GUARD).toScVal(),
              new Address(VALID_GUARD).toScVal(),
              new Address(RECIPIENT).toScVal(),
              nativeToScVal("100", { type: "string" }),
            ],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "amount");
          assert.equal(err.rule, "i128_type");
          return true;
        },
      );
    });
  });
});

describe("interceptor.check() input validation and zero RPC round-trips", () => {
  it("throws InvalidInputError synchronously with 0 RPC requests on malformed contract ID", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    await assert.rejects(
      async () => interceptor.check({ contract: unsafeContractAddress("not-a-contract"), fn: "transfer", args: [] }),
      (err: unknown) => {
        assert(err instanceof InvalidInputError);
        assert.equal(err.field, "contract");
        assert.equal(err.rule, "invalid_format");
        return true;
      },
    );

    assert.equal(mockServer.requestCount, 0, "No RPC calls should be attempted on invalid contract");
  });

  it("throws InvalidInputError synchronously with 0 RPC requests on missing/invalid method", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    await assert.rejects(
      async () => interceptor.check({ contract: VALID_TOKEN, fn: "bad method name!", args: [] }),
      (err: unknown) => {
        assert(err instanceof InvalidInputError);
        assert.equal(err.field, "fn");
        assert.equal(err.rule, "symbol_shape");
        return true;
      },
    );

    assert.equal(mockServer.requestCount, 0, "No RPC calls should be attempted on invalid method");
  });

  it("throws InvalidInputError synchronously with 0 RPC requests on non-i128 amount", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    await assert.rejects(
      async () =>
        interceptor.check({
          contract: VALID_TOKEN,
          fn: "transfer",
          args: [
            new Address(VALID_GUARD).toScVal(),
            new Address(RECIPIENT).toScVal(),
            nativeToScVal(500, { type: "u64" }),
          ],
        }),
      (err: unknown) => {
        assert(err instanceof InvalidInputError);
        assert.equal(err.field, "amount");
        assert.equal(err.rule, "i128_type");
        return true;
      },
    );

    assert.equal(mockServer.requestCount, 0, "No RPC calls should be attempted on invalid amount");
  });
});

describe("abortSignal + timeoutMs plumbing", () => {
  it("already-aborted signal returns an undetermined verdict without any RPC call", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);
    const controller = new AbortController();
    controller.abort();

    // A verdict question is answered with a verdict: the guard reached no
    // decision, so the check fails closed on its `undetermined` arm instead of
    // throwing at the caller.
    const decision = await interceptor.check(validTransferCall(), { signal: controller.signal });

    assert.equal(decision.kind, "undetermined");
    const error = decision.error;
    assert.ok(error instanceof RpcTimeoutError);
    assert.equal(error.stage, "pre-flight");
    assert.equal(error.aborted, true);
    assert.equal(mockServer.requestCount, 0, "No RPC calls should be attempted when signal is already aborted");
  });

  it("mid-flight abort returns an undetermined verdict promptly", async () => {
    const controller = new AbortController();
    const mockServer = createMockServer({ simulateDelayMs: 10_000, simulateSignal: controller.signal });
    const interceptor = createTestInterceptor(mockServer);

    const started = Date.now();
    const pending = interceptor.check(validTransferCall(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const decision = await pending;

    assert.equal(decision.kind, "undetermined");
    const error = decision.error;
    assert.ok(error instanceof RpcTimeoutError);
    assert.equal(error.aborted, true, "a caller abort is reported as an abort, not a timeout");
    assert.ok(
      Date.now() - started < 5_000,
      "the verdict must arrive on the abort, not on the 10s simulation",
    );
  });

  it("timeoutMs fires a typed RpcTimeoutError as an undetermined verdict", async () => {
    const mockServer = createMockServer({ simulateDelayMs: 10_000 });
    const interceptor = createTestInterceptor(mockServer);

    const decision = await interceptor.check(validTransferCall(), { timeoutMs: 10 });

    assert.equal(decision.kind, "undetermined");
    const error = decision.error;
    assert.ok(error instanceof RpcTimeoutError);
    assert.equal(error.aborted, false);
    assert.equal(error.timeoutMs, 10);
    assert.equal(error.cause, "timeout");
  });

  it("a furnished signal that never fires leaves the verdict path untouched", async () => {
    const controller = new AbortController();
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    const decision = await interceptor.check(validTransferCall(), {
      signal: controller.signal,
      timeoutMs: 30_000,
    });

    assert.equal(decision.kind, "admissible");
    assert.ok(mockServer.requestCount > 0);
  });
});

describe("boundary: valid-but-unusual inputs proceed to simulation", () => {
  it("allows unknown fn names to proceed to simulation (boundary: policy/contract question, not input shape)", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    // Unknown function name is symbol-shaped, so input validation passes.
    // Whether the contract implements it or policy allows it is an on-chain question for simulation.
    const call: ContractCall = {
      contract: VALID_TOKEN,
      fn: "unusual_arbitrary_call_v2",
      args: [],
    };

    assert.doesNotThrow(() => validateContractCall(call));
    const decision = await interceptor.check(call);
    assert.equal(decision.kind, "admissible");
    assert(mockServer.requestCount > 0, "Simulation RPC must be called for valid input shape");
  });

  it("allows huge amounts to proceed to simulation (boundary: cap/policy question, not input shape)", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    // Extremely large i128 amount is structurally valid.
    // Whether it exceeds spend caps is a policy question for simulation, not input validation.
    const hugeAmount = 999999999999999999999999999999999999n;
    const call = validTransferCall(hugeAmount);

    assert.doesNotThrow(() => validateContractCall(call));
    const decision = await interceptor.check(call);
    assert.equal(decision.kind, "admissible");
    assert(mockServer.requestCount > 0, "Simulation RPC must be called for valid amount type");
  });
});

describe("throw vs verdict contract asymmetry", () => {
  it("programmer error (invalid input) throws InvalidInputError", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    await assert.rejects(
      async () => interceptor.check({ contract: unsafeContractAddress(""), fn: "transfer", args: [] }),
      InvalidInputError,
    );
  });

  it("policy refusal (blocked) returns a verdict without throwing", async () => {
    // Simulate a guard policy block (diagnostic event carries event_auth_checked, blocked, per_tx_cap_exceeded)
    const blockedErrorResponse = {
      error: "transaction failed",
      events: [
        {
          event: {
            contractId: VALID_GUARD,
            body: {
              v0: {
                topics: [
                  xdr.ScVal.scvSymbol("event_auth_checked"),
                  xdr.ScVal.scvSymbol("blocked"),
                  xdr.ScVal.scvSymbol("per_tx_cap_exceeded"),
                ],
                data: xdr.ScVal.scvMap([]),
              },
            },
          },
        },
      ],
    };

    const mockServer = createMockServer({ enforcedSimulateResponse: blockedErrorResponse });
    const interceptor = createTestInterceptor(mockServer);

    const call = validTransferCall(5000n);
    // check() does NOT throw: returns kind: "blocked"
    const decision = await interceptor.check(call);
    assert.equal(decision.allowed, false);
    assert.equal(decision.kind, "blocked");
    if (decision.kind === "blocked") {
      assert.equal(decision.reason, "per_tx_cap_exceeded");
      assert(decision.explanation.length > 0);
    }
  });

  it("assertAllowed throws GuardBlockedError carrying offending call and rawEvent on block", async () => {
    const blockedErrorResponse = {
      error: "transaction failed",
      events: [
        {
          event: {
            contractId: VALID_GUARD,
            body: {
              v0: {
                topics: [
                  xdr.ScVal.scvSymbol("event_auth_checked"),
                  xdr.ScVal.scvSymbol("blocked"),
                  xdr.ScVal.scvSymbol("recipient_not_allowed"),
                ],
                data: xdr.ScVal.scvMap([]),
              },
            },
          },
        },
      ],
    };

    const mockServer = createMockServer({ enforcedSimulateResponse: blockedErrorResponse });
    const interceptor = createTestInterceptor(mockServer);
    const call = validTransferCall(100n);

    await assert.rejects(
      async () => interceptor.assertAllowed(call),
      (err: unknown) => {
        assert(err instanceof GuardBlockedError);
        assert.equal(err.reason, "recipient_not_allowed");
        assert.equal(err.code, 21);
        assert.equal(err.stage, "preflight");
        assert.equal(err.charged, false);
        assert.deepEqual(err.call, call);
        assert.ok(err.rawEvent !== undefined);
        assert.match(err.explanation, /recipient/i);
        const json = err.toJSON();
        assert.equal(json["reason"], "recipient_not_allowed");
        assert.deepEqual(json["call"], {
          contract: call.contract,
          fn: call.fn,
          argsCount: 3,
        });
        return true;
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/*             Unit tests for opt-in pre-flight simulation cache              */
/* -------------------------------------------------------------------------- */

const CONTRACT = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
const OTHER_CONTRACT = unsafeContractAddress(Address.contract(Buffer.alloc(32)).toString());
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const CALL: ContractCall = { contract: CONTRACT, fn: "noop", args: [] };

function makeHarness() {
  let simulations = 0;
  let latestLedgerCalls = 0;
  let ledger = 100;
  const source = Keypair.random();
  const server = {
    getAccount: async () => new Account(source.publicKey(), "1"),
    getLatestLedger: async () => {
      latestLedgerCalls += 1;
      return { sequence: ledger };
    },
    simulateTransaction: async () => {
      simulations += 1;
      return {
        result: { auth: [] },
        minResourceFee: "17",
        transactionData: {
          getReadOnly: () => [],
          getReadWrite: () => [{}],
        },
      };
    },
  } as unknown as rpc.Server;

  return {
    server,
    source,
    call: CALL,
    get simulations() {
      return simulations;
    },
    get latestLedgerCalls() {
      return latestLedgerCalls;
    },
    advanceLedger() {
      ledger += 1;
    },
  };
}

function makeInterceptor(
  harness: ReturnType<typeof makeHarness>,
  options: { cache?: PreFlightCacheOptions } = {},
): PreFlightInterceptor {
  return new PreFlightInterceptor({
    server: harness.server,
    networkPassphrase: NETWORK_PASSPHRASE,
    guard: CONTRACT,
    agent: harness.source,
    source: harness.source,
    ...(options.cache ? { cache: options.cache } : {}),
  });
}

describe("PreFlightInterceptor simulation cache", () => {
  it("does not cache unless explicitly enabled", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness);

    await interceptor.check(harness.call);
    await interceptor.check(harness.call);

    assert.equal(harness.simulations, 4);
    // No cache-context ledger lookup is added to the default path.
    assert.equal(harness.latestLedgerCalls, 2);
  });

  it("returns a hit for the same call within the ledger window", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });

    const first = await interceptor.check(harness.call);
    const second = await interceptor.check(harness.call);

    assert.equal(harness.simulations, 2);
    assert.equal(harness.latestLedgerCalls, 3);
    assert.equal(second, first);
  });

  it("supports ledger-based TTL configuration", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlLedgers: 1 } });

    await interceptor.check(harness.call);
    await interceptor.check(harness.call);

    assert.equal(harness.simulations, 2);
  });

  it("does not reuse a verdict after its TTL expires", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 1 } });

    await interceptor.check(harness.call);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await interceptor.check(harness.call);

    assert.equal(harness.simulations, 4);
  });

  it("invalidates the complete cache explicitly", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });

    await interceptor.check(harness.call);
    interceptor.invalidate();
    await interceptor.check(harness.call);

    assert.equal(harness.simulations, 4);
  });

  it("invalidates only the requested call when one is supplied", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });
    const otherCall: ContractCall = {
      contract: CONTRACT,
      fn: "noop",
      args: [nativeToScVal(1n, { type: "i128" })],
    };

    await interceptor.check(harness.call);
    await interceptor.check(otherCall);
    interceptor.invalidate(harness.call);
    await interceptor.check(harness.call);
    await interceptor.check(otherCall);

    assert.equal(harness.simulations, 6);
  });

  it("invalidates when the ledger advances", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });

    await interceptor.check(harness.call);
    harness.advanceLedger();
    await interceptor.check(harness.call);

    assert.equal(harness.simulations, 4);
  });

  it("invalidates when the policy revision changes", async () => {
    const harness = makeHarness();
    let revision = 1;
    const interceptor = makeInterceptor(harness, {
      cache: { ttlMs: 5_000, policyRevision: () => revision },
    });

    await interceptor.check(harness.call);
    revision = 2;
    await interceptor.check(harness.call);

    assert.equal(harness.simulations, 4);
  });

  it("bypasses the cache when a supplied policy revision is unreadable", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, {
      cache: { ttlMs: 5_000, policyRevision: () => undefined },
    });

    await interceptor.check(harness.call);
    await interceptor.check(harness.call);

    assert.equal(harness.simulations, 4);
  });

  it("uses different keys for different arguments", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });
    const otherCall: ContractCall = {
      contract: CONTRACT,
      fn: "noop",
      args: [nativeToScVal(1n, { type: "i128" })],
    };

    await interceptor.check(harness.call);
    await interceptor.check(otherCall);

    assert.equal(harness.simulations, 4);
  });

  it("uses different keys for different functions", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });
    const otherCall: ContractCall = { ...harness.call, fn: "other" };

    await interceptor.check(harness.call);
    await interceptor.check(otherCall);

    assert.equal(harness.simulations, 4);
  });

  it("uses different keys for different contracts", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });
    const otherCall: ContractCall = { ...harness.call, contract: OTHER_CONTRACT };

    await interceptor.check(harness.call);
    await interceptor.check(otherCall);

    assert.equal(harness.simulations, 4);
  });

  it("does not cache an undetermined result", async () => {
    const source = Keypair.random();
    let simulations = 0;
    const server = {
      getAccount: async () => new Account(source.publicKey(), "1"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async () => {
        simulations += 1;
        return { error: "HostError: trap" };
      },
    } as unknown as rpc.Server;
    const interceptor = new PreFlightInterceptor({
      server,
      networkPassphrase: NETWORK_PASSPHRASE,
      guard: CONTRACT,
      agent: source,
      source,
      cache: { ttlMs: 5_000 },
    });

    await interceptor.check(CALL);
    await interceptor.check(CALL);

    assert.equal(simulations, 2);
  });

  it("rejects a cache configuration without a positive TTL", () => {
    const harness = makeHarness();
    assert.throws(
      () => makeInterceptor(harness, { cache: {} }),
      /requires ttlMs or ttlLedgers/,
    );
    assert.throws(
      () => makeInterceptor(harness, { cache: { ttlMs: 0 } }),
      /ttlMs must be a positive finite number/,
    );
  });
});

/* -------------------------------------------------------------------------- */

/**
 * In-flight coalescing: concurrent checks for the same call share one
 * discovery/enforcement run, without turning into a durable cache and without
 * letting one caller's bound cancel another caller's result.
 */
describe("PreFlightInterceptor in-flight coalescing", () => {
  function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function admissibleSimulation() {
    return {
      result: { auth: [] },
      minResourceFee: "17",
      transactionData: { getReadOnly: () => [], getReadWrite: () => [{}] },
    };
  }

  function makeHarness(options: { rejected?: boolean } = {}) {
    const source = Keypair.random();
    const gate = deferred();
    const probeStarted = deferred();
    let simulations = 0;
    const server = {
      getAccount: async () => new Account(source.publicKey(), "1"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async () => {
        simulations += 1;
        if (simulations === 1) probeStarted.resolve();
        await gate.promise;
        return options.rejected ? { error: "HostError: trap" } : admissibleSimulation();
      },
    } as unknown as rpc.Server;
    return {
      server,
      source,
      probeStarted: probeStarted.promise,
      release: () => gate.resolve(),
      get simulations() {
        return simulations;
      },
    };
  }

  function makeInterceptor(harness: ReturnType<typeof makeHarness>) {
    return new PreFlightInterceptor({
      server: harness.server,
      networkPassphrase: NETWORK_PASSPHRASE,
      guard: VALID_GUARD,
      agent: harness.source,
      source: harness.source,
    });
  }

  it("runs one discovery/enforcement pass for concurrent identical calls", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness);
    const call = validTransferCall(10n);

    const first = interceptor.check(call);
    const second = interceptor.check(call);
    await harness.probeStarted;
    harness.release();

    const [firstDecision, secondDecision] = await Promise.all([first, second]);
    assert.equal(firstDecision.kind, "admissible");
    assert.equal(secondDecision.kind, "admissible");
    // One probe plus one enforced simulation, not two of each.
    assert.equal(harness.simulations, 2);
    assert.equal(secondDecision, firstDecision);

    // The settled entry is gone: the next call runs its own pass.
    await new Promise((resolve) => setImmediate(resolve));
    const later = await interceptor.check(call);
    assert.equal(later.kind, "admissible");
    assert.equal(harness.simulations, 4);
  });

  it("can be disabled per interceptor", async () => {
    const harness = makeHarness();
    const interceptor = new PreFlightInterceptor({
      server: harness.server,
      networkPassphrase: NETWORK_PASSPHRASE,
      guard: VALID_GUARD,
      agent: harness.source,
      source: harness.source,
      coalesceInFlight: false,
    });
    const call = validTransferCall(10n);

    const first = interceptor.check(call);
    const second = interceptor.check(call);
    harness.release();

    const [firstDecision, secondDecision] = await Promise.all([first, second]);
    assert.equal(firstDecision.kind, "admissible");
    assert.equal(secondDecision.kind, "admissible");
    assert.equal(harness.simulations, 4);
  });

  it("does not coalesce distinct calls", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness);

    const first = interceptor.check(validTransferCall(10n));
    const second = interceptor.check(validTransferCall(20n));
    harness.release();

    const [firstDecision, secondDecision] = await Promise.all([first, second]);
    assert.equal(firstDecision.kind, "admissible");
    assert.equal(secondDecision.kind, "admissible");
    assert.equal(harness.simulations, 4);
  });

  it("keeps a waiter's result when another waiter's signal aborts", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness);
    const call = validTransferCall(10n);
    const controller = new AbortController();

    const aborted = interceptor.check(call, { signal: controller.signal });
    const patient = interceptor.check(call);
    await harness.probeStarted;

    controller.abort();
    harness.release();

    const [abortedDecision, patientDecision] = await Promise.all([aborted, patient]);
    assert.equal(abortedDecision.kind, "undetermined");
    assert.ok(abortedDecision.error instanceof RpcTimeoutError);
    assert.equal(abortedDecision.error.aborted, true);
    // The abort cancelled one waiter's wait, not the shared run.
    assert.equal(patientDecision.kind, "admissible");
    assert.equal(harness.simulations, 2);
  });

  it("removes a rejected run and never persists its undetermined outcome", async () => {
    const harness = makeHarness({ rejected: true });
    const interceptor = makeInterceptor(harness);
    const call = validTransferCall(10n);

    const first = interceptor.check(call);
    const second = interceptor.check(call);
    await harness.probeStarted;
    harness.release();

    const [firstDecision, secondDecision] = await Promise.all([first, second]);
    assert.equal(firstDecision.kind, "undetermined");
    assert.equal(secondDecision.kind, "undetermined");
    assert.equal(harness.simulations, 1);

    // A settled failure is removed, not cached: the next call runs again.
    await new Promise((resolve) => setImmediate(resolve));
    const third = await interceptor.check(call);
    assert.equal(third.kind, "undetermined");
    assert.equal(harness.simulations, 2);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Batched pre-flight: the all-or-nothing aggregate over a list of calls.
 *
 * The single-call path is mocked RPC; what these tests pin is the *staging* on
 * top of it — that the aggregate is admissible only when every call is, that a
 * call which passes alone can still be refused once the batch's cumulative
 * window spend is accounted for, and that a refusal anywhere is never averaged
 * away. `window_cap_exceeded` is synthesised client-side from staged amounts,
 * so the reasoning behind it is asserted explicitly rather than assumed.
 */
describe("PreFlightInterceptor.checkBatch()", () => {
  const PASSPHRASE = "Test SDF Network ; September 2015";

  /** An enforced simulation that passes, priced at `minResourceFee` stroops. */
  function admissibleSimulation(feeStroops: string) {
    return {
      result: { auth: [] },
      minResourceFee: feeStroops,
      transactionData: { getReadOnly: () => [], getReadWrite: () => [{}] },
    };
  }

  /** A guard refusal in the contract's own vocabulary. */
  function blockedSimulation() {
    return {
      error: "blocked",
      events: [
        {
          event: {
            contractId: CONTRACT,
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

  /**
   * A server whose enforced simulation (every 2nd call) is scripted per
   * 1-based enforced-run index, so a batch can mix admissible and refused calls.
   */
  function batchServer(options: {
    enforcedRuns: readonly unknown[];
    ledgerEntries?: () => unknown;
  }) {
    let simulations = 0;
    let enforcedRun = 0;
    const server = {
      getAccount: async () => new Account(Keypair.random().publicKey(), "1"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async () => {
        simulations += 1;
        if (simulations % 2 === 0) {
          const scripted = options.enforcedRuns[enforcedRun];
          enforcedRun += 1;
          return scripted ?? admissibleSimulation("10");
        }
        return admissibleSimulation("10");
      },
      ...(options.ledgerEntries
        ? { getLedgerEntries: async () => options.ledgerEntries?.() }
        : {}),
    } as unknown as rpc.Server;
    return {
      server,
      get simulations() {
        return simulations;
      },
    };
  }

  function transferCall(amount: bigint): ContractCall {
    return {
      contract: VALID_TOKEN,
      fn: "transfer",
      args: [
        new Address(VALID_GUARD).toScVal(),
        new Address(RECIPIENT).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
      ],
    };
  }

  /** A policy that objects to nothing except the window cap under test. */
  function policyWithWindowCap(windowCap: bigint): PolicyConfig {
    return {
      per_tx_cap: 1_000_000_000_000n,
      window_secs: 86_400n,
      window_cap: windowCap,
      assets: [VALID_TOKEN],
      protocols: [],
      recipients: [RECIPIENT],
      allow_any_recipient: true,
      active_from: 0n,
      active_until: 0n,
      paused: false,
      dms_grace_secs: 3_600n,
    };
  }

  function batchInterceptor(
    server: rpc.Server,
    policy?: PolicyConfig | null,
  ): PreFlightInterceptor {
    return new PreFlightInterceptor({
      server,
      networkPassphrase: PASSPHRASE,
      guard: CONTRACT,
      agent: Keypair.random(),
      source: Keypair.random(),
      ...(policy !== undefined ? { policy } : {}),
    });
  }

  /** Narrow a verdict to its blocked arm, or fail with its actual kind. */
  function blockedArm(verdict: PreFlightDecision | undefined) {
    assert.ok(verdict, "expected a verdict for this call");
    assert.equal(verdict.kind, "blocked", `expected blocked, got ${verdict.kind}`);
    return verdict;
  }

  it("treats an empty batch as admissible with no fee and no verdicts", async () => {
    const harness = batchServer({ enforcedRuns: [] });
    const decision = await batchInterceptor(harness.server).checkBatch([]);

    assert.equal(decision.admissible, true);
    assert.equal(decision.overallAdmissible, true);
    assert.deepEqual(decision.verdicts, []);
    assert.deepEqual(decision.calls, decision.verdicts);
    assert.equal(decision.totalEstimatedResourceFee, 0n);
    assert.equal(harness.simulations, 0);
  });

  it("returns one verdict per call, in input order, and sums the admissible fees", async () => {
    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("25")],
    });
    const calls = [transferCall(10n), transferCall(20n)];

    const decision = await batchInterceptor(harness.server, policyWithWindowCap(1_000n)).checkBatch(
      calls,
      { initialWindowSpent: 0n },
    );

    assert.equal(decision.admissible, true);
    assert.equal(decision.verdicts.length, 2);
    assert.deepEqual(
      decision.verdicts.map((verdict) => verdict.kind),
      ["admissible", "admissible"],
    );
    // 10 + 25, summed from the per-call estimates.
    assert.equal(decision.totalEstimatedResourceFee, 35n);
    // Two simulations per call: the probe and the enforced run.
    assert.equal(harness.simulations, 4);
  });

  it("refuses a call that passes alone but breaches the staged window cap", async () => {
    // Both calls pass in isolation: 60n and 60n against a 100n cap.
    const { server } = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
    });
    const decision = await batchInterceptor(server, policyWithWindowCap(100n)).checkBatch(
      [transferCall(60n), transferCall(60n)],
      { initialWindowSpent: 0n },
    );

    assert.equal(decision.admissible, false);
    assert.equal(decision.overallAdmissible, false);
    assert.equal(decision.verdicts[0]?.kind, "admissible");
    const staged = blockedArm(decision.verdicts[1]);
    // The refusal names the window cap and shows the arithmetic, so the caller
    // can see *why* a call the chain would have allowed was staged out.
    assert.equal(staged.reason, "window_cap_exceeded");
    assert.match(staged.detail, /120 > window_cap 100/);
    // A staged-out call is never charged to the batch's fee total.
    assert.equal(decision.totalEstimatedResourceFee, 10n);
  });

  it("counts the committed window spend already on the ledger against the cap", async () => {
    const { server } = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
    });
    // 90n already committed leaves room for exactly one 10n transfer, not two.
    const decision = await batchInterceptor(server, policyWithWindowCap(100n)).checkBatch(
      [transferCall(10n), transferCall(10n)],
      { initialWindowSpent: 90n },
    );

    assert.equal(decision.admissible, false);
    assert.equal(decision.verdicts[0]?.kind, "admissible");
    assert.equal(decision.verdicts[1]?.kind, "blocked");
  });

  it("propagates a contract refusal and makes the whole batch inadmissible", async () => {
    const { server } = batchServer({
      enforcedRuns: [admissibleSimulation("10"), blockedSimulation()],
    });
    const decision = await batchInterceptor(server, policyWithWindowCap(1_000n)).checkBatch(
      [transferCall(10n), transferCall(20n)],
      { initialWindowSpent: 0n },
    );

    assert.equal(decision.admissible, false);
    // The guard's own reason survives, decoded from its diagnostic.
    assert.equal(blockedArm(decision.verdicts[1]).reason, "per_tx_cap_exceeded");
    assert.equal(decision.totalEstimatedResourceFee, 10n);
  });

  it("skips window staging when no window cap is configured", async () => {
    const { server } = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
    });
    // A `null` cap must mean "no objection", not "refuse everything".
    const decision = await batchInterceptor(server, null).checkBatch(
      [transferCall(1_000_000n), transferCall(1_000_000n)],
      { initialWindowSpent: 0n },
    );

    assert.equal(decision.admissible, true);
    assert.deepEqual(
      decision.verdicts.map((verdict) => verdict.kind),
      ["admissible", "admissible"],
    );
  });

  it("falls back to a zero committed spend when the ledger read is unavailable", async () => {
    // No `getLedgerEntries` on the mock: the fetch throws and is swallowed, so
    // the batch must still run rather than fail closed on a missing read.
    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
    });
    const decision = await batchInterceptor(harness.server).checkBatch([
      transferCall(10n),
      transferCall(20n),
    ]);

    assert.equal(decision.admissible, true);
    assert.equal(harness.simulations, 4);
  });

  it("reads the live policy and window from ledger storage when none is supplied", async () => {
    // `readPersistentEntry` decodes the contract-data entry's ScVal; the batch
    // check then stages against the committed total it finds there.
    const { server } = batchServer({
      enforcedRuns: [admissibleSimulation("10")],
      ledgerEntries: () => {
        throw new Error("not modelled");
      },
    });
    // An unreadable policy degrades to "no cap" rather than a fabricated one.
    const decision = await batchInterceptor(server).checkBatch([transferCall(10n)]);

    assert.equal(decision.admissible, true);
  });

  it("assertBatchAllowed returns the batch when every call is admissible", async () => {
    const { server } = batchServer({ enforcedRuns: [admissibleSimulation("10")] });
    const batch = await batchInterceptor(server, policyWithWindowCap(1_000n)).assertBatchAllowed(
      [transferCall(10n)],
      { initialWindowSpent: 0n },
    );

    assert.equal(batch.admissible, true);
  });

  it("assertBatchAllowed throws GuardBlockedError on the first refusal", async () => {
    const { server } = batchServer({ enforcedRuns: [blockedSimulation()] });
    const interceptor = batchInterceptor(server, policyWithWindowCap(1_000n));

    await assert.rejects(
      interceptor.assertBatchAllowed([transferCall(10n)], { initialWindowSpent: 0n }),
      (error: unknown) => {
        assert.ok(error instanceof GuardBlockedError);
        assert.equal(error.reason, "per_tx_cap_exceeded");
        return true;
      },
    );
  });

  it("assertBatchAllowed throws PreFlightUndeterminedError on an undetermined call", async () => {
    // A host rejection is not the guard refusing, and it is not the batch
    // staging either: it must surface as undetermined, never as a block.
    const { server } = batchServer({
      enforcedRuns: [{ error: "HostError: invalid_input", events: [] }],
    });
    const interceptor = batchInterceptor(server, policyWithWindowCap(1_000n));

    await assert.rejects(
      interceptor.assertBatchAllowed([transferCall(10n)], { initialWindowSpent: 0n }),
      (error: unknown) => {
        assert.ok(error instanceof PreFlightUndeterminedError);
        return true;
      },
    );
  });

  it("does no work at all when the batch signal is already aborted", async () => {
    const harness = batchServer({ enforcedRuns: [] });
    const interceptor = batchInterceptor(harness.server, policyWithWindowCap(1_000n));
    const controller = new AbortController();
    controller.abort();

    const decision = await interceptor.checkBatch(
      [transferCall(10n), transferCall(20n)],
      { initialWindowSpent: 0n, signal: controller.signal },
    );

    assert.equal(decision.admissible, false);
    assert.equal(decision.verdicts.length, 2);
    for (const verdict of decision.verdicts) {
      assert.equal(verdict.kind, "undetermined");
      assert.ok(verdict.error instanceof RpcTimeoutError);
      assert.equal(verdict.error.aborted, true);
    }
    assert.equal(harness.simulations, 0, "an already-aborted batch must issue no RPC");
  });

  it("stops before the next call after a mid-batch abort", async () => {
    /** Abort after the first completed check, so the boundary is deterministic. */
    class AbortAfterFirstCheck extends PreFlightInterceptor {
      readonly controller = new AbortController();
      private completedChecks = 0;

      override async check(
        call: ContractCall,
        options?: PreFlightCheckOptions,
      ): Promise<PreFlightDecision> {
        const decision = await super.check(call, options);
        this.completedChecks += 1;
        if (this.completedChecks === 1) this.controller.abort();
        return decision;
      }
    }

    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
    });
    const interceptor = new AbortAfterFirstCheck({
      server: harness.server,
      networkPassphrase: PASSPHRASE,
      guard: CONTRACT,
      agent: Keypair.random(),
      source: Keypair.random(),
      policy: policyWithWindowCap(1_000n),
    });

    const decision = await interceptor.checkBatch(
      [transferCall(10n), transferCall(20n), transferCall(30n)],
      { initialWindowSpent: 0n, signal: interceptor.controller.signal },
    );

    assert.equal(decision.admissible, false);
    assert.deepEqual(
      decision.verdicts.map((verdict) => verdict.kind),
      ["admissible", "undetermined", "undetermined"],
    );
    assert.equal(decision.totalEstimatedResourceFee, 10n);
    // The first call's probe + enforced run only; the other two never started.
    assert.equal(harness.simulations, 2);
    const unfinished = decision.verdicts[1];
    assert.ok(unfinished?.kind === "undetermined");
    assert.ok(unfinished.error instanceof RpcTimeoutError);
    assert.equal(unfinished.error.aborted, true);
  });

  it("spends one deadline budget across the batch without wall-clock sleeps", async () => {
    const clock = new FakeClock(1_000);
    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
    });
    const interceptor = new PreFlightInterceptor({
      server: harness.server,
      networkPassphrase: PASSPHRASE,
      guard: CONTRACT,
      agent: Keypair.random(),
      source: Keypair.random(),
      policy: policyWithWindowCap(1_000n),
      clock,
    });
    let advanced = false;

    const decision = await interceptor.checkBatch(
      [transferCall(10n), transferCall(20n)],
      {
        initialWindowSpent: 0n,
        deadlineMs: 5_000,
        onStep: (step) => {
          // Advance virtual time while the first call is running. The first
          // call was already admitted its bound; the loop must not start the
          // second one once the budget is gone.
          if (!advanced && step.name === "probe" && step.status === "start") {
            advanced = true;
            clock.advance(5_001);
          }
        },
      },
    );

    assert.equal(decision.admissible, false);
    assert.equal(decision.verdicts[0]?.kind, "admissible");
    const unfinished = decision.verdicts[1];
    assert.ok(unfinished?.kind === "undetermined");
    assert.ok(unfinished.error instanceof RpcTimeoutError);
    assert.equal(unfinished.error.deadline, true);
    assert.equal(unfinished.error.timeoutMs, 5_000);
    assert.equal(harness.simulations, 2);
  });

  it("rejects a non-positive batch deadline before any work", async () => {
    const harness = batchServer({ enforcedRuns: [] });
    const interceptor = batchInterceptor(harness.server, policyWithWindowCap(1_000n));

    await assert.rejects(
      interceptor.checkBatch([transferCall(10n)], { deadlineMs: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof RangeError);
        assert.match(error.message, /deadlineMs/);
        return true;
      },
    );
    assert.equal(harness.simulations, 0);
  });
});
