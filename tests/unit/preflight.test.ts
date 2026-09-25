/**
 * Unit tests for the opt-in pre-flight simulation cache.
 *
 * The mock RPC still drives the real probe + enforced-simulation pipeline, so
 * the simulation counter is a meaningful measure of avoided work. The cache is
 * deliberately tested as a security boundary: it is off by default, never
 * reuses across ledger changes, and never turns an undetermined result into a
 * reusable verdict.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Account, Address, Keypair, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import {
  PreFlightInterceptor,
  type PreFlightCacheOptions,
} from "../../src/preflight.ts";
import type { ContractCall } from "../../src/tx.ts";

const CONTRACT = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const OTHER_CONTRACT = Address.contract(Buffer.alloc(32)).toString();
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
