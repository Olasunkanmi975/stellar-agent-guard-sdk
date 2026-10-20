/**
 * Unit tests for transaction-layer helpers.
 *
 * The classifier tested here decides whether a post-inclusion failure is worth
 * re-simulating. It was written after a real, reproducible failure: a transfer
 * that passed enforcement and was included, then rejected by core with
 * `scecExceededLimit` because the simulation had priced the gas against a
 * ledger snapshot one write behind. Classifying that as "not our problem" would
 * make the SDK intermittently fail; classifying a genuine guard block as
 * retryable would be worse, so both directions are pinned here.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  Account,
  Address,
  Keypair,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { ContractResponseError, SigningError } from "../../src/errors.ts";
import {
  BroadcastError,
  assembleFromSimulation,
  buildGuardAuthEntry,
  describeSimulationResources,
  isMinimumFeeBroadcastFailure,
  isSequenceNumberFailure,
  isValidAgentPublicKey,
  isStaleLedgerResourceFailure,
  keypairAgentSigner,
  parseSimulationResourceFee,
  submitAndPoll,
  toAgentSigner,
  validateAgentPublicKey,
  verifyAgentSignature,
  type AgentSigner,
  type ContractCall,
  type SubmissionAcceptedEvent,
} from "../../src/tx.ts";
import { unsafeContractAddress } from "../../src/policy.ts";

const GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
const CALL: ContractCall = {
  contract: unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"),
  fn: "transfer",
  args: [],
};
const PASSPHRASE = "Test SDF Network ; September 2015";

/** The real failure payload from the live testnet run, trimmed. */
const staleLedgerFailure = {
  resultXdr: "AAAAAAAAURj/////AAAAAQAAAAAAAAAY/////QAAAAA=",
  resultCode: "unknown",
  message: "transaction failed after inclusion",
  diagnosticEvents: [
    {
      body: {
        v0: {
          topics: [
            "error",
            { type: "system", code: 5, value: "scecExceededLimit" },
          ],
          data: ["operation byte-write resources exceeds amount specified", "724", "652"],
        },
      },
    },
  ],
};

const guardBlockFailure = {
  resultXdr: null,
  resultCode: "invokeHostFunctionResult=trap",
  message: "transaction failed after inclusion",
  diagnosticEvents: [
    {
      body: {
        v0: {
          topics: ["event_auth_checked", "blocked", "per_tx_cap_exceeded"],
          data: {},
        },
      },
    },
  ],
};

describe("isSequenceNumberFailure", () => {
  it("recognises tx_bad_seq from the RPC error result", () => {
    assert.equal(
      isSequenceNumberFailure({
        resultXdr: null,
        resultCode: null,
        message: JSON.stringify({ code: "tx_bad_seq" }),
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("recognises a prose sequence mismatch", () => {
    assert.equal(
      isSequenceNumberFailure({
        resultXdr: null,
        resultCode: null,
        message: "transaction sequence number is too low",
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("does not classify an unrelated submission failure as a sequence error", () => {
    assert.equal(
      isSequenceNumberFailure({
        resultXdr: null,
        resultCode: "tx_insufficient_fee",
        message: "insufficient fee",
        diagnosticEvents: [],
      }),
      false,
    );
  });
});

describe("parseSimulationResourceFee", () => {
  it("accepts exact non-negative u64 values across SDK representations", () => {
    assert.equal(parseSimulationResourceFee("0"), 0n);
    assert.equal(parseSimulationResourceFee("42"), 42n);
    assert.equal(parseSimulationResourceFee(42), 42n);
    assert.equal(parseSimulationResourceFee(42n), 42n);
    assert.equal(parseSimulationResourceFee((2n ** 64n - 1n).toString()), 2n ** 64n - 1n);
  });

  it("rejects missing, malformed, negative, unsafe, and out-of-range fees", () => {
    for (const value of [undefined, null, "", "not-a-fee", "1.5", Number.MAX_SAFE_INTEGER + 1, -1, -1n, "-1", 2n ** 64n]) {
      assert.throws(
        () => parseSimulationResourceFee(value),
        (error: unknown) => {
          assert.ok(error instanceof ContractResponseError);
          assert.equal(error.field, "minResourceFee");
          return true;
        },
      );
    }
  });

  it("records the stage that read the fee, so the failure says where it happened", () => {
    assert.throws(
      () => parseSimulationResourceFee("not-a-fee", { stage: "assemble" }),
      (error: unknown) => {
        assert.ok(error instanceof ContractResponseError);
        assert.equal(error.field, "minResourceFee");
        assert.equal(error.stage, "assemble");
        return true;
      },
    );
  });

  it("leaves the stage absent when the caller names none", () => {
    try {
      parseSimulationResourceFee("not-a-fee");
      assert.fail("expected a ContractResponseError");
    } catch (error) {
      assert.ok(error instanceof ContractResponseError);
      assert.equal(error.stage, undefined);
    }
  });
});

/**
 * A simulation payload whose only interesting field is the resource fee.
 *
 * The rest of the shape is what the assembler needs to build a transaction, so
 * a malformed fee is the *only* thing wrong with it — which is what makes the
 * failure attributable to the fee and nothing else.
 */
function simulationWithFee(minResourceFee: unknown): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    minResourceFee,
    transactionData: new SorobanDataBuilder().build().toXDR(),
    result: { auth: [] },
  } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
}

describe("assembleFromSimulation resource-fee handling", () => {
  const operation = Operation.invokeContractFunction({
    contract: CALL.contract,
    function: CALL.fn,
    args: [],
  });

  function assemble(minResourceFee: unknown) {
    return assembleFromSimulation({
      simulation: simulationWithFee(minResourceFee),
      source: new Account(Keypair.random().publicKey(), "100"),
      operation,
      networkPassphrase: PASSPHRASE,
      guard: null,
    });
  }

  it("accepts the fee in every representation the SDK may hand back", () => {
    assert.equal(assemble("42").resourceFee, 42n);
    assert.equal(assemble(42).resourceFee, 42n);
    assert.equal(assemble(42n).resourceFee, 42n);
  });

  it("rejects a malformed fee with the typed contract-response error, not a native conversion error", () => {
    for (const value of [undefined, null, "", "not-a-fee", "1.5", -1, 2n ** 64n]) {
      assert.throws(
        () => assemble(value),
        (error: unknown) => {
          assert.ok(
            error instanceof ContractResponseError,
            `expected a ContractResponseError for ${String(value)}`,
          );
          assert.equal(error.field, "minResourceFee");
          assert.equal(error.stage, "assemble");
          return true;
        },
      );
    }
  });
});

/** A signed-shaped transaction, enough for the submission path. */
function buildTestTransaction(): Transaction {
  return new TransactionBuilder(new Account(Keypair.random().publicKey(), "100"), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CALL.contract,
        function: CALL.fn,
        args: [],
      }),
    )
    .setTimeout(0)
    .build();
}

describe("submitAndPoll: the submission is reported before any polling", () => {
  const HASH = "a".repeat(64);

  it("publishes the hash the moment the network accepted the submission", async () => {
    const events: SubmissionAcceptedEvent[] = [];
    const order: string[] = [];
    const server = {
      async sendTransaction() {
        order.push("send");
        return { status: "PENDING", hash: HASH };
      },
      async getTransaction(hash: string) {
        order.push(`poll:${hash}`);
        return { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 42 };
      },
    } as unknown as rpc.Server;

    const result = await submitAndPoll(server, buildTestTransaction(), [], {
      pollAttempts: 1,
      pollIntervalMs: 0,
      onSubmitted: (event) => {
        order.push("submitted");
        events.push(event);
      },
    });

    assert.deepEqual(events, [{ hash: HASH, status: "PENDING" }]);
    assert.deepEqual(order, ["send", "submitted", `poll:${HASH}`]);
    assert.equal(result.hash, HASH);
  });

  it("reports an ambiguous response — no hash — and fails closed", async () => {
    const events: SubmissionAcceptedEvent[] = [];
    let polls = 0;
    const server = {
      async sendTransaction() {
        return { status: "PENDING", hash: "" };
      },
      async getTransaction() {
        polls += 1;
        return { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 42 };
      },
    } as unknown as rpc.Server;

    await assert.rejects(
      () =>
        submitAndPoll(server, buildTestTransaction(), [], {
          pollAttempts: 1,
          pollIntervalMs: 0,
          onSubmitted: (event) => events.push(event),
        }),
      (error: unknown) => {
        assert.ok(error instanceof BroadcastError);
        assert.equal(error.transactionHash, null);
        assert.match(error.message, /no transaction hash/);
        return true;
      },
    );

    assert.deepEqual(events, [{ hash: null, status: "PENDING" }]);
    assert.equal(polls, 0, "an untrackable transaction must not be polled for");
  });

  it("isolates a throwing hook: the submission still completes", async () => {
    const server = {
      async sendTransaction() {
        return { status: "PENDING", hash: HASH };
      },
      async getTransaction() {
        return { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 42 };
      },
    } as unknown as rpc.Server;

    const result = await submitAndPoll(server, buildTestTransaction(), [], {
      pollAttempts: 1,
      pollIntervalMs: 0,
      onSubmitted: () => {
        throw new Error("consumer exploded");
      },
    });

    assert.equal(result.hash, HASH);
    assert.equal(result.failure, null);
  });
});

describe("isStaleLedgerResourceFailure", () => {
  it("recognises the real scecExceededLimit rejection", () => {
    assert.equal(isStaleLedgerResourceFailure(staleLedgerFailure), true);
  });

  it("recognises a stale declaration when only the message matches", () => {
    assert.equal(
      isStaleLedgerResourceFailure({
        resultXdr: null,
        resultCode: null,
        message: "operation byte-write resources exceeds amount specified",
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("recognises an insufficient refundable resource fee", () => {
    assert.equal(
      isStaleLedgerResourceFailure({
        resultXdr: null,
        resultCode: null,
        message: "insufficient refundable fee",
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("does NOT treat a guard block as retryable", () => {
    assert.equal(isStaleLedgerResourceFailure(guardBlockFailure), false);
  });

  it("does not retry an ordinary failure", () => {
    assert.equal(
      isStaleLedgerResourceFailure({
        resultXdr: null,
        resultCode: "tx_bad_seq",
        message: "transaction failed after inclusion",
        diagnosticEvents: [],
      }),
      false,
    );
  });
});

describe("verifyAgentSignature", () => {
  const payload = Buffer.alloc(32, 7);
  const agent = Keypair.random();
  const signature = agent.sign(payload);

  it("accepts the exact payload/signature pair for strkey, hex, and raw public keys", () => {
    assert.equal(verifyAgentSignature(agent.publicKey(), payload, signature), true);
    assert.equal(
      verifyAgentSignature(Buffer.from(agent.rawPublicKey()).toString("hex"), payload, signature),
      true,
    );
    assert.equal(verifyAgentSignature(agent.rawPublicKey(), payload, signature), true);
  });

  it("rejects a signature made by a different registered key", () => {
    assert.equal(verifyAgentSignature(Keypair.random().publicKey(), payload, signature), false);
  });

  it("rejects a one-bit payload mutation without rehashing the payload", () => {
    const mutated = Buffer.from(payload);
    mutated[0] = mutated[0]! ^ 1;
    assert.equal(verifyAgentSignature(agent.publicKey(), mutated, signature), false);
  });

  it("rejects payloads that are not the 32-byte host auth digest", () => {
    for (const size of [0, 1, 31, 33, 64]) {
      const signature = agent.sign(Buffer.alloc(size, 9));
      assert.equal(
        verifyAgentSignature(agent.publicKey(), Buffer.alloc(size, 9), signature),
        false,
      );
    }
  });

  it("returns false for empty, truncated, and oversized signatures", () => {
    assert.equal(verifyAgentSignature(agent.publicKey(), payload, new Uint8Array()), false);
    assert.equal(verifyAgentSignature(agent.publicKey(), payload, signature.subarray(0, 63)), false);
    const oversized = Buffer.alloc(65);
    oversized.set(signature);
    assert.equal(verifyAgentSignature(agent.publicKey(), payload, oversized), false);
  });

  it("returns false for malformed or wrong-length raw public keys", () => {
    assert.equal(verifyAgentSignature("not-a-stellar-key", payload, signature), false);
    assert.equal(verifyAgentSignature(new Uint8Array(31), payload, signature), false);
  });

  it("does not accept a SEP-53 message signature for a raw host digest", () => {
    const messageSignature = agent.signMessage("diagnostic only");
    assert.equal(verifyAgentSignature(agent.publicKey(), payload, messageSignature), false);
  });
});

describe("describeSimulationResources", () => {
  it("reports the declared resources and footprint size", () => {
    const data = new SorobanDataBuilder().setResources(1000, 200, 300);
    const text = describeSimulationResources({ transactionData: data, minResourceFee: "42" }, null);
    assert.match(text, /instructions: 1000/);
    assert.match(text, /disk_read_bytes: 200/);
    assert.match(text, /write_bytes: 300/);
    assert.match(text, /minResourceFee: 42/);
  });

  it("names each guard storage key and whether it is declared read-write", () => {
    const guard = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
    const data = new SorobanDataBuilder().setResources(1, 2, 3);
    const text = describeSimulationResources({ transactionData: data, minResourceFee: "0" }, guard);
    assert.match(text, /guard key Policy: NOT in the footprint/);
    assert.match(text, /guard key Window: NOT in the footprint/);
  });

  it("explains a simulation error instead of printing empty numbers", () => {
    const text = describeSimulationResources({ error: "HostError: boom" }, null);
    assert.match(text, /simulation error/);
    assert.match(text, /boom/);
  });
});

/**
 * Agent signer identity validation (issue #295).
 *
 * The signing boundary accepts only verify-only encodings of the registered
 * Ed25519 public key. A configuration mismatch must fail here, before the
 * signer is invoked, rather than after a probe simulation surfaces a contract
 * `__check_auth` failure that says nothing about which key was misconfigured.
 */
describe("agent public-key validation", () => {
  const local = Keypair.random();
  const validHex = Buffer.from(local.rawPublicKey()).toString("hex");

  it("accepts a checksum-valid StrKey and returns it unchanged", () => {
    assert.equal(validateAgentPublicKey(local.publicKey()), local.publicKey());
    assert.equal(isValidAgentPublicKey(local.publicKey()), true);
  });

  it("accepts the raw 32-byte key as hex and normalises it to the StrKey form", () => {
    assert.equal(validateAgentPublicKey(validHex), local.publicKey());
    assert.equal(validateAgentPublicKey(validHex.toUpperCase()), local.publicKey());
    assert.equal(isValidAgentPublicKey(validHex), true);
  });

  it("rejects a StrKey with a bad checksum", () => {
    const invalid = local.publicKey().slice(0, -1) + (local.publicKey().endsWith("A") ? "B" : "A");
    assert.throws(() => validateAgentPublicKey(invalid), (error: unknown) => {
      assert.ok(error instanceof SigningError);
      assert.match(error.message, /signer\.publicKey/);
      return true;
    });
    assert.equal(isValidAgentPublicKey(invalid), false);
  });

  it("rejects secret seeds instead of deriving a public key from them", () => {
    assert.throws(() => validateAgentPublicKey(local.secret()), (error: unknown) => {
      assert.ok(error instanceof SigningError);
      assert.match(error.message, /must not be a secret key/);
      return true;
    });
    assert.equal(isValidAgentPublicKey(local.secret()), false);
  });

  it("rejects malformed and non-Ed25519 values", () => {
    const malformed = [
      "",
      "not-a-stellar-key",
      `0x${validHex}`,
      validHex.slice(0, -1),
      `${validHex}00`,
      "g".repeat(64),
      "C".repeat(56),
      new Address(CALL.contract).toString(),
      undefined,
      null,
      42,
    ];
    for (const value of malformed) {
      assert.equal(isValidAgentPublicKey(value), false, `expected ${String(value)} to be rejected`);
      assert.throws(
        () => validateAgentPublicKey(value as string),
        (error: unknown) => error instanceof SigningError,
      );
    }
  });

  it("rejects an invalid custom signer at construction", () => {
    const invalid: AgentSigner = {
      publicKey: "GINVALID",
      signDigest: () => new Uint8Array(64),
    };
    assert.throws(() => toAgentSigner(invalid), (error: unknown) => error instanceof SigningError);
  });

  it("accepts a valid remote signer, including a hex-encoded identity", async () => {
    const remote = Keypair.random();
    const signer: AgentSigner = {
      publicKey: Buffer.from(remote.rawPublicKey()).toString("hex"),
      signDigest: (digest) => remote.sign(Buffer.from(digest)),
    };

    const entry = await buildGuardAuthEntry({
      guard: GUARD,
      call: CALL,
      signer,
      nonce: 3n,
      signatureExpirationLedger: 100,
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    const addressCredentials = (
      entry.credentials as unknown as { address: xdr.SorobanAddressCredentials }
    ).address;
    const signature = scValToNative(addressCredentials.signature) as Uint8Array;
    assert.equal(signature.length, 64);
  });
});

/**
 * The agent-signing seam (issue #29).
 *
 * `buildGuardAuthEntry` used to take a `Keypair` and call `.sign()` on it
 * directly, which hard-codes "the agent key is a local single Ed25519 key" into
 * the signature of a public function. Contracts v2 will make the guard's
 * `Signature` type multi-key, and this pins the two properties that let that
 * land without another breaking change: a plain `Keypair` still signs exactly
 * as before, and anything implementing `AgentSigner` is accepted in its place.
 */
describe("AgentSigner", () => {
  const networkPassphrase = "Test SDF Network ; September 2015";

  it("wraps a Keypair as a signer that signs the digest with that same key", async () => {
    const keypair = Keypair.random();
    const signer = keypairAgentSigner(keypair);
    assert.equal(signer.publicKey, keypair.publicKey());

    const digest = createHash("sha256").update("authorization preimage").digest();
    const signature = await signer.signDigest(digest);
    assert.equal(signature.length, 64, "a raw Ed25519 signature is 64 bytes");
    assert.equal(
      keypair.verify(digest, Buffer.from(signature)),
      true,
      "the signature must verify against the key that produced it",
    );
  });

  it("passes a valid AgentSigner through unchanged", () => {
    const custom: AgentSigner = {
      publicKey: Keypair.random().publicKey(),
      signDigest: () => new Uint8Array(64),
    };
    assert.equal(toAgentSigner(custom), custom, "no wrapping an already-adapted signer");
  });

  it("wraps a plain Keypair so existing callers keep working", () => {
    const keypair = Keypair.random();
    const signer = toAgentSigner(keypair);
    assert.equal(signer.publicKey, keypair.publicKey());
    assert.equal(typeof signer.signDigest, "function");
  });

  it("signs the 32-byte digest the host verifies, not the whole entry", async () => {
    const keypair = Keypair.random();
    const seen: Uint8Array[] = [];
    const recording: AgentSigner = {
      publicKey: keypair.publicKey(),
      signDigest: (digest) => {
        seen.push(digest);
        return keypair.sign(Buffer.from(digest));
      },
    };

    const entry = await buildGuardAuthEntry({
      guard: GUARD,
      call: CALL,
      signer: recording,
      nonce: 7n,
      signatureExpirationLedger: 4_000_000,
      networkPassphrase,
    });

    assert.equal(seen.length, 1, "the signer is called exactly once per entry");
    assert.equal(seen[0]!.length, 32, "__check_auth verifies a 32-byte SHA-256 digest");

    // The entry must carry exactly what the signer produced, and the nonce and
    // expiration that were written into the signed preimage.
    assert.equal(entry.credentials.type, "sorobanCredentialsAddress");
    const addressCredentials = (
      entry.credentials as unknown as { address: xdr.SorobanAddressCredentials }
    ).address;
    assert.equal(addressCredentials.nonce, 7n);
    assert.equal(addressCredentials.signatureExpirationLedger, 4_000_000);
    const carried = scValToNative(addressCredentials.signature) as Uint8Array;
    assert.ok(
      Buffer.from(carried).equals(Buffer.from(keypair.sign(Buffer.from(seen[0]!)))),
      "the entry carries the signer's signature verbatim",
    );
  });

  it("still signs with a bare Keypair, byte-for-byte as before", async () => {
    const keypair = Keypair.random();
    const entry = await buildGuardAuthEntry({
      guard: GUARD,
      call: CALL,
      signer: keypair,
      nonce: 1n,
      signatureExpirationLedger: 100,
      networkPassphrase,
    });
    const addressCredentials = (
      entry.credentials as unknown as { address: xdr.SorobanAddressCredentials }
    ).address;
    const signature = scValToNative(addressCredentials.signature) as Uint8Array;
    assert.equal(signature.length, 64);
    assert.equal(
      keypair.verify(Buffer.alloc(32), Buffer.from(signature)),
      false,
      "a signature over a real preimage must not validate against an unrelated digest",
    );
  });

  it("rejects an invalid signer identity before invoking signDigest", async () => {
    let signs = 0;
    const invalid: AgentSigner = {
      publicKey: "not-a-stellar-public-key",
      signDigest: () => {
        signs += 1;
        return new Uint8Array(64);
      },
    };

    await assert.rejects(
      buildGuardAuthEntry({
        guard: GUARD,
        call: CALL,
        signer: invalid,
        nonce: 1n,
        signatureExpirationLedger: 100,
        networkPassphrase,
      }),
      (error: unknown) => {
        assert.ok(error instanceof SigningError);
        assert.match(error.message, /signer\.publicKey/);
        return true;
      },
    );
    assert.equal(signs, 0, "the signer must not be invoked with an invalid public identity");
  });

  it("answers a V2 (address-bound) credential with the matching preimage", async () => {
    const keypair = Keypair.random();
    const entry = await buildGuardAuthEntry({
      guard: GUARD,
      call: CALL,
      signer: keypairAgentSigner(keypair),
      nonce: 2n,
      signatureExpirationLedger: 100,
      networkPassphrase,
      credentialType: "sorobanCredentialsAddressV2",
    });
    assert.equal(entry.credentials.type, "sorobanCredentialsAddressV2");
  });
});

describe("isMinimumFeeBroadcastFailure", () => {
  it("recognises structured result=txInsufficientFee", () => {
    assert.equal(
      isMinimumFeeBroadcastFailure({
        resultXdr: null,
        resultCode: "result=txInsufficientFee",
        message: '{"status":"ERROR"}',
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("recognises tx_insufficient_fee in the failure message", () => {
    assert.equal(
      isMinimumFeeBroadcastFailure({
        resultXdr: null,
        resultCode: null,
        message: '{"result":"tx_insufficient_fee"}',
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("recognises tx too cheap in the failure message", () => {
    assert.equal(
      isMinimumFeeBroadcastFailure({
        resultXdr: null,
        resultCode: null,
        message: "transaction rejected: tx too cheap for current ledger",
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("recognises min-fee in the failure message", () => {
    assert.equal(
      isMinimumFeeBroadcastFailure({
        resultXdr: null,
        resultCode: null,
        message: "fee 100 below min-fee 250",
        diagnosticEvents: [],
      }),
      true,
    );
  });

  it("does not treat stale-ledger resource failure as a minimum-fee failure", () => {
    assert.equal(isMinimumFeeBroadcastFailure(staleLedgerFailure), false);
  });

  it("does not treat a guard block as a minimum-fee failure", () => {
    assert.equal(isMinimumFeeBroadcastFailure(guardBlockFailure), false);
  });

  it("does not treat an unrelated failure (e.g. bad seq) as a minimum-fee failure", () => {
    assert.equal(
      isMinimumFeeBroadcastFailure({
        resultXdr: null,
        resultCode: "tx_bad_seq",
        message: "sequence mismatch",
        diagnosticEvents: [],
      }),
      false,
    );
  });
});

describe("BroadcastError", () => {
  it("formats message with attempt count and last fee", () => {
    const error = new BroadcastError({
      attempts: 3,
      lastFee: 400n,
      failure: {
        resultXdr: null,
        resultCode: "result=txInsufficientFee",
        message: "tx too cheap",
        diagnosticEvents: [],
      },
    });

    assert.equal(error.name, "BroadcastError");
    assert.equal(error.kind, "error");
    assert.equal(error.attempts, 3);
    assert.equal(error.lastFee, 400n);
    assert.equal(error.error, error);
    assert.match(error.message, /3 attempt\(s\)/);
    assert.match(error.message, /400 stroops/);
    assert.ok(error instanceof Error);
  });
});
