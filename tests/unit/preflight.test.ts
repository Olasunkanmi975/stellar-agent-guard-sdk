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
  preflight,
  preflightBatch,
  validateContractCall,
  type PreFlightCacheOptions,
  type PreFlightDecision,
} from "../../src/preflight.ts";
import { RpcTimeoutError } from "../../src/invoke.ts";
import { ContractResponseError } from "../../src/errors.ts";
import { GuardBlockedError } from "../../src/reasons.ts";
import type { PolicyConfig } from "../../src/policy.ts";
import type { ContractCall } from "../../src/tx.ts";
import { unsafeContractAddress, unsafeAccountAddress } from "../../src/policy.ts";
import { mulberry32, randomUint } from "./seeded-random.ts";

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
          latestLedger: 123_456,
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

describe("one-shot pre-flight helpers", () => {
  function config() {
    return {
      server: createMockServer(),
      networkPassphrase: "Test SDF Network ; September 2015",
      guard: VALID_GUARD,
      agent: Keypair.random(),
      source: Keypair.random(),
    };
  }

  it("preflight() constructs an interceptor and checks one call", async () => {
    const decision = await preflight(config(), validTransferCall());
    assert.equal(decision.kind, "admissible");
    assert.equal(
      decision.kind === "admissible" ? decision.provenance?.ledger : undefined,
      123_456,
    );
  });

  it("preflightBatch() constructs an interceptor and checks a batch", async () => {
    const decision = await preflightBatch(config(), []);
    assert.equal(decision.overallAdmissible, true);
    assert.equal(decision.calls.length, 0);
  });
});

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

describe("simulation ledger provenance (#347)", () => {
  it("reports the ledger from the same simulation that produced the quote", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    const decision = await interceptor.check(validTransferCall());

    assert.equal(decision.kind, "admissible");
    assert.deepEqual(decision.kind === "admissible" ? decision.provenance : undefined, {
      ledger: 123_456,
    });
  });

  it("omits provenance rather than inventing one when the response has no ledger", async () => {
    const mockServer = createMockServer({
      simulateResponse: {
        minResourceFee: "100",
        result: { auth: [] },
        transactionData: {
          getReadOnly: () => [],
          getReadWrite: () => [],
        },
      },
    });
    const interceptor = createTestInterceptor(mockServer);

    const decision = await interceptor.check(validTransferCall());

    assert.equal(decision.kind, "admissible");
    assert.equal(
      decision.kind === "admissible" ? decision.provenance : "not-admissible",
      undefined,
    );
  });

  it("omits a malformed ledger instead of passing it through", async () => {
    for (const latestLedger of [-1, 1.5, Number.NaN, "123", null]) {
      const mockServer = createMockServer({
        simulateResponse: {
          minResourceFee: "100",
          latestLedger,
          result: { auth: [] },
          transactionData: {
            getReadOnly: () => [],
            getReadWrite: () => [],
          },
        },
      });
      const interceptor = createTestInterceptor(mockServer);

      const decision = await interceptor.check(validTransferCall());

      assert.equal(decision.kind, "admissible");
      assert.equal(
        decision.kind === "admissible" ? decision.provenance : "not-admissible",
        undefined,
        `expected ${String(latestLedger)} to be omitted`,
      );
    }
  });

  it("never performs an additional ledger read to label the quote", async () => {
    let latestLedgerCalls = 0;
    const server = {
      getAccount: async () => ({ sequenceNumber: () => "100" }),
      getLatestLedger: async () => {
        latestLedgerCalls += 1;
        return { sequence: 999_999 };
      },
      simulateTransaction: async () => ({
        minResourceFee: "100",
        latestLedger: 500_000,
        result: { auth: [] },
        transactionData: {
          getReadOnly: () => [],
          getReadWrite: () => [],
        },
      }),
    } as unknown as rpc.Server;
    const interceptor = createTestInterceptor(server);

    const decision = await interceptor.check(validTransferCall());

    assert.equal(decision.kind, "admissible");
    assert.deepEqual(decision.kind === "admissible" ? decision.provenance : undefined, {
      ledger: 500_000,
    });
    // The check already reads the current ledger once for its cache context;
    // provenance must add no further read and must not use that value.
    assert.equal(latestLedgerCalls, 1, "provenance must come from the pricing simulation");
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
/*             Pre-flight resource-fee handling (fail closed)                 */
/* -------------------------------------------------------------------------- */

/**
 * A malformed resource fee must fail the way every other malformed contract
 * response fails: with the SDK's typed `ContractResponseError`, naming the
 * field and the stage, and with the verdict `undetermined` — never
 * `admissible`, because an unpriceable simulation must not produce a budget
 * decision.
 */
describe("pre-flight resource-fee handling", () => {
  function serverWithFee(minResourceFee: unknown) {
    return createMockServer({
      enforcedSimulateResponse: {
        minResourceFee,
        result: { auth: [] },
        transactionData: {
          getReadOnly: () => [],
          getReadWrite: () => [],
        },
      },
    });
  }

  it("reports a missing, malformed, negative or out-of-range fee as undetermined", async () => {
    for (const value of [undefined, null, "", "not-a-fee", "1.5", -1, 2n ** 64n]) {
      const server = serverWithFee(value);
      const interceptor = createTestInterceptor(server);

      const decision = await interceptor.check(validTransferCall());

      assert.equal(decision.kind, "undetermined");
      assert.ok(
        decision.error instanceof ContractResponseError,
        `expected a ContractResponseError for ${String(value)}`,
      );
      assert.equal(decision.error.field, "minResourceFee");
      assert.equal(decision.error.stage, "preflight");
      assert.equal(decision.allowed, false);
    }
  });

  it("accepts the fee in every representation the SDK may hand back", async () => {
    for (const value of ["42", 42, 42n]) {
      const server = serverWithFee(value);
      const interceptor = createTestInterceptor(server);

      const decision = await interceptor.check(validTransferCall());

      assert.equal(decision.kind, "admissible");
      assert.equal(decision.kind === "admissible" ? decision.estimatedResourceFee : undefined, 42n);
    }
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

    const stats = interceptor.getCacheStats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
    assert.equal(stats.size, 1);
    assert.equal(stats.invalidations, 0);
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

    const stats = interceptor.getCacheStats();
    assert.equal(stats.hits, 0); // first call: miss, invalidate, second call: miss
    assert.equal(stats.misses, 2); // both calls are misses
    assert.equal(stats.size, 1); // cache populated by second call after invalidate
    assert.equal(stats.invalidations, 1); // one invalidation call cleared one entry
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

    const stats = interceptor.getCacheStats();
    assert.equal(stats.hits, 0);
    assert.equal(stats.misses, 2);
    assert.equal(stats.size, 1);
    assert.equal(stats.invalidations, 0);
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

  it("fails closed when a required live staging read fails", async () => {
    // Without an explicit snapshot, a failed ledger read means the committed
    // window spend is unknown. Staging against an assumed zero could label an
    // over-cap batch admissible, so the transfer cannot be decided.
    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
      ledgerEntries: () => {
        throw new Error("rpc unavailable");
      },
    });
    const decision = await batchInterceptor(
      harness.server,
      policyWithWindowCap(1_000n),
    ).checkBatch([transferCall(10n), transferCall(20n)]);

    assert.equal(decision.admissible, false);
    assert.equal(decision.kind, "undetermined");
    assert.equal(decision.staging?.source, "unavailable");
    assert.equal(decision.staging?.windowSpent, null);
    assert.equal(decision.staging?.unavailable, true);
    assert.equal(decision.verdicts.length, 2);
    assert.equal(decision.verdicts[0]?.kind, "undetermined");
    assert.equal(decision.verdicts[1]?.kind, "undetermined");
    assert.match(
      decision.verdicts[0]!.kind === "undetermined" ? decision.verdicts[0]!.detail : "",
      /committed window spend/,
    );
  });

  it("treats an absent Window entry as zero committed spend, not a failed read", async () => {
    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
      ledgerEntries: () => ({ entries: [] }),
    });
    // The policy is supplied (cap 100) but the committed spend is read from the
    // ledger: an absent entry means 0n, so 60 + 40 lands exactly on the cap.
    const decision = await batchInterceptor(
      harness.server,
      policyWithWindowCap(100n),
    ).checkBatch([transferCall(60n), transferCall(40n)]);

    assert.equal(decision.admissible, true);
    assert.equal(decision.kind, "admissible");
    assert.equal(decision.staging?.source, "absent");
    assert.equal(decision.staging?.windowSpent, 0n);
    assert.equal(decision.staging?.unavailable, false);
  });

  it("trusts an explicitly supplied zero snapshot even when the live read fails", async () => {
    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
      ledgerEntries: () => {
        throw new Error("rpc unavailable");
      },
    });
    const decision = await batchInterceptor(
      harness.server,
      policyWithWindowCap(1_000n),
    ).checkBatch([transferCall(10n), transferCall(20n)], { initialWindowSpent: 0n });

    assert.equal(decision.admissible, true);
    assert.equal(decision.kind, "admissible");
    assert.equal(decision.staging?.source, "provided");
    assert.equal(decision.staging?.windowSpent, 0n);
    assert.equal(decision.staging?.unavailable, false);
  });

  it("does not need window state for a batch with only non-transfer calls", async () => {
    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10")],
      ledgerEntries: () => {
        throw new Error("rpc unavailable");
      },
    });
    const decision = await batchInterceptor(harness.server).checkBatch([
      { contract: VALID_TOKEN, fn: "balance", args: [new Address(VALID_GUARD).toScVal()] },
    ]);

    // Staging is not required, so an unavailable window read cannot change the
    // verdict for a call that never touches the window.
    assert.equal(decision.admissible, true);
    assert.equal(decision.kind, "admissible");
    assert.equal(decision.staging, undefined);
  });

  it("reads the live policy and window from ledger storage when none is supplied", async () => {
    // `readPersistentEntry` decodes the contract-data entry's ScVal; the batch
    // check then stages against the committed total it finds there.
    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10")],
      ledgerEntries: () => ({ entries: [] }),
    });
    const decision = await batchInterceptor(harness.server).checkBatch([transferCall(10n)]);

    assert.equal(decision.admissible, true);
    assert.equal(decision.staging?.source, "absent");
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

  it("assertBatchAllowed throws PreFlightUndeterminedError when staging state is unavailable", async () => {
    const { server } = batchServer({
      enforcedRuns: [admissibleSimulation("10")],
      ledgerEntries: () => {
        throw new Error("rpc unavailable");
      },
    });
    const interceptor = batchInterceptor(server, policyWithWindowCap(1_000n));

    await assert.rejects(
      interceptor.assertBatchAllowed([transferCall(10n)]),
      (error: unknown) => {
        assert.ok(error instanceof PreFlightUndeterminedError);
        assert.match((error as Error).message, /batch staging state unavailable/);
        return true;
      },
    );
  });

  /**
   * Cumulative staging boundaries (issue #337).
   *
   * The explicit matrix below pins the three arithmetic boundaries the cap can
   * have, and the seeded case explores mixed batches so ordering, non-transfer
   * calls, and individual blocked/undetermined verdicts cannot be averaged
   * away. The seed is printed in the failure, and the iteration count is kept
   * small so the mock-RPC suite stays fast in CI.
   */
  describe("cumulative staging boundaries (issue #337)", () => {
    const STAGING_SEED = 0x5eed337;
    const STAGING_ITERATIONS = 50;

    type ForcedKind = "admissible" | "blocked" | "undetermined";

    interface Member {
      call: ContractCall;
      forced: ForcedKind;
      /** Transfer amount, or `null` for a non-transfer call. */
      amount: bigint | null;
    }

    function nonTransferCall(): ContractCall {
      return {
        contract: VALID_TOKEN,
        fn: "balance",
        args: [new Address(VALID_GUARD).toScVal()],
      };
    }

    function forcedRun(kind: ForcedKind): unknown {
      if (kind === "blocked") return blockedSimulation();
      if (kind === "undetermined") return { error: "HostError: invalid_input", events: [] };
      return admissibleSimulation("10");
    }

    /** Run one batch and return the verdict kinds plus the fee total. */
    async function runBatch(
      members: readonly Member[],
      windowCap: bigint,
      initialWindowSpent: bigint,
    ) {
      const { server } = batchServer({
        enforcedRuns: members.map((member) => forcedRun(member.forced)),
      });
      const decision = await batchInterceptor(server, policyWithWindowCap(windowCap)).checkBatch(
        members.map((member) => member.call),
        { initialWindowSpent },
      );
      return decision;
    }

    function expectedVerdicts(
      members: readonly Member[],
      windowCap: bigint,
      initialWindowSpent: bigint,
    ): { kinds: string[]; fee: bigint } {
      let staged = 0n;
      let fee = 0n;
      const kinds = members.map((member) => {
        if (member.forced === "blocked") return "blocked";
        if (member.forced === "undetermined") return "undetermined";
        if (member.amount !== null && member.amount > 0n && windowCap > 0n) {
          const projected = initialWindowSpent + staged + member.amount;
          if (projected > windowCap) return "blocked";
          staged += member.amount;
        }
        fee += 10n;
        return "admissible";
      });
      return { kinds, fee };
    }

    function describeFailure(
      seed: number,
      iteration: number,
      members: readonly Member[],
      windowCap: bigint,
      initialWindowSpent: bigint,
    ): string {
      const replay = JSON.stringify(
        { windowCap, initialWindowSpent, members },
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      );
      return `seed 0x${seed.toString(16)} iteration ${iteration}\nbatch: ${replay}`;
    }

    it("admits below and equal to the cap, and refuses one stroop above", async () => {
      const cases: Array<{ amounts: bigint[]; expected: string[] }> = [
        { amounts: [99n], expected: ["admissible"] },
        { amounts: [100n], expected: ["admissible"] },
        { amounts: [101n], expected: ["blocked"] },
        { amounts: [60n, 40n], expected: ["admissible", "admissible"] },
        { amounts: [60n, 41n], expected: ["admissible", "blocked"] },
        { amounts: [50n, 49n], expected: ["admissible", "admissible"] },
        { amounts: [50n, 51n], expected: ["admissible", "blocked"] },
      ];

      for (const boundary of cases) {
        const members = boundary.amounts.map(
          (amount): Member => ({
            call: transferCall(amount),
            forced: "admissible",
            amount,
          }),
        );
        const decision = await runBatch(members, 100n, 0n);
        assert.deepEqual(
          decision.verdicts.map((verdict) => verdict.kind),
          boundary.expected,
          `amounts ${boundary.amounts.join(" + ")} against cap 100`,
        );
        assert.equal(
          decision.admissible,
          !boundary.expected.includes("blocked"),
          "only a fully admissible batch is admissible",
        );
      }
    });

    it("keeps staging order-dependent and ignores non-transfer calls", async () => {
      const ordered = [
        { amounts: [101n, 50n], expected: ["blocked", "admissible"] },
        { amounts: [50n, 101n], expected: ["admissible", "blocked"] },
        { amounts: [60n, 40n], expected: ["admissible", "admissible"] },
        { amounts: [60n, 41n], expected: ["admissible", "blocked"] },
      ];

      for (const boundary of ordered) {
        const members = boundary.amounts.map(
          (amount): Member => ({ call: transferCall(amount), forced: "admissible", amount }),
        );
        const decision = await runBatch(members, 100n, 0n);
        assert.deepEqual(
          decision.verdicts.map((verdict) => verdict.kind),
          boundary.expected,
          `ordered amounts ${boundary.amounts.join(", ")}`,
        );
      }

      const mixed: Member[] = [
        { call: transferCall(60n), forced: "admissible", amount: 60n },
        { call: nonTransferCall(), forced: "admissible", amount: null },
        { call: transferCall(40n), forced: "admissible", amount: 40n },
      ];
      const mixedDecision = await runBatch(mixed, 100n, 0n);
      assert.deepEqual(
        mixedDecision.verdicts.map((verdict) => verdict.kind),
        ["admissible", "admissible", "admissible"],
      );
      assert.equal(mixedDecision.totalEstimatedResourceFee, 30n);

      const overMixed = await runBatch(
        [
          { call: transferCall(60n), forced: "admissible", amount: 60n },
          { call: nonTransferCall(), forced: "admissible", amount: null },
          { call: transferCall(41n), forced: "admissible", amount: 41n },
        ],
        100n,
        0n,
      );
      assert.deepEqual(
        overMixed.verdicts.map((verdict) => verdict.kind),
        ["admissible", "admissible", "blocked"],
      );
    });

    it("never upgrades an individual blocked or undetermined member", async () => {
      const members: Member[] = [
        { call: transferCall(1n), forced: "blocked", amount: 1n },
        { call: transferCall(60n), forced: "admissible", amount: 60n },
        { call: transferCall(1n), forced: "undetermined", amount: 1n },
        { call: transferCall(40n), forced: "admissible", amount: 40n },
      ];
      const decision = await runBatch(members, 100n, 0n);

      assert.deepEqual(
        decision.verdicts.map((verdict) => verdict.kind),
        ["blocked", "admissible", "undetermined", "admissible"],
      );
      assert.equal(decision.admissible, false);
      assert.equal(decision.kind, "blocked");
      // The 60 + 40 transfers still stage to exactly the cap; neither is
      // upgraded by the blocked or undetermined member around them.
      assert.equal(decision.totalEstimatedResourceFee, 20n);
    });

    it("matches a seeded generator of mixed batches", async () => {
      const rand = mulberry32(STAGING_SEED);

      for (let iteration = 0; iteration < STAGING_ITERATIONS; iteration += 1) {
        const windowCap = [0n, 1n, 10n, 100n, 1_000n][Math.floor(rand() * 5)]!;
        const initialWindowSpent =
          rand() < 0.5 ? 0n : randomUint(rand, Math.min(12, windowCap.toString(2).length + 1));
        const length = 1 + Math.floor(rand() * 5);
        let staged = 0n;
        const members: Member[] = [];

        for (let index = 0; index < length; index += 1) {
          if (rand() < 0.2) {
            members.push({ call: nonTransferCall(), forced: "admissible", amount: null });
            continue;
          }

          const kindRoll = rand();
          const forced: ForcedKind =
            kindRoll < 0.15 ? "blocked" : kindRoll < 0.3 ? "undetermined" : "admissible";

          let amount: bigint;
          if (forced !== "admissible") {
            amount = 1n;
          } else {
            const remaining = windowCap - initialWindowSpent - staged;
            const boundaryRoll = rand();
            if (boundaryRoll < 0.15) {
              amount = remaining > 0n ? remaining - 1n : 0n;
            } else if (boundaryRoll < 0.3) {
              amount = remaining > 0n ? remaining : 0n;
            } else if (boundaryRoll < 0.45) {
              amount = remaining >= 0n ? remaining + 1n : 1n;
            } else {
              amount = randomUint(rand, 32) % 1_000n;
            }
          }

          members.push({ call: transferCall(amount), forced, amount });

          if (
            forced === "admissible" &&
            amount > 0n &&
            windowCap > 0n &&
            initialWindowSpent + staged + amount <= windowCap
          ) {
            staged += amount;
          }
        }

        const expected = expectedVerdicts(members, windowCap, initialWindowSpent);

        try {
          const decision = await runBatch(members, windowCap, initialWindowSpent);
          assert.deepEqual(
            decision.verdicts.map((verdict) => verdict.kind),
            expected.kinds,
            "staged verdict kinds",
          );
          assert.equal(decision.totalEstimatedResourceFee, expected.fee, "admissible fee total");
          assert.equal(
            decision.admissible,
            !expected.kinds.includes("blocked") && !expected.kinds.includes("undetermined"),
            "batch must not upgrade a blocked/undetermined member",
          );
        } catch (error) {
          assert.fail(
            `${describeFailure(
              STAGING_SEED,
              iteration,
              members,
              windowCap,
              initialWindowSpent,
            )}\nexpected kinds: ${expected.kinds.join(", ")}\n${
              error instanceof Error ? error.stack ?? error.message : String(error)
            }`,
          );
        }
      }
    });
  });
});
