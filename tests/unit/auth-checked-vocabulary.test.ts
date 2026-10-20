/**
 * The guard contract's `auth_checked` vocabulary, consumed from the contracts
 * repo's own fixture.
 *
 * The canonical matrix lives in
 * `stellar-agent-guard-contracts/tests/fixtures/auth-checked-vocabulary.json`
 * (contracts PR #280, issue #42): the allowed path, every `Error` code and
 * reason symbol, the exact event topics, and the data-map fields of the
 * decision event. This suite reads that file — vendored here with its
 * provenance and digest — instead of keeping a second copy of the matrix in
 * this repository.
 *
 * The consequence is deliberate: when the contract adds an outcome, this test
 * fails until the SDK knows about it. A vocabulary the SDK cannot decode is a
 * vocabulary an operator would meet as an unknown refusal.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { Address, xdr } from "@stellar/stellar-sdk";
import { decodeAuthDecision, GUARD_EVENT_TOPICS } from "../../src/events.ts";
import { guardEventsFromDiagnostics } from "../../src/telemetry.ts";
import { GUARD_REASON_CODES, isGuardReason, type GuardReason } from "../../src/reasons.ts";
import { unsafeContractAddress } from "../../src/policy.ts";

const GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");

/** One outcome as the contracts repo publishes it. */
interface VocabularyOutcome {
  /** The contract's numeric `Error` value; null for the allowed path. */
  code: number | null;
  /** The Rust variant the outcome comes from. */
  error_variant: string;
  /** The stable snake_case symbol the contract publishes. */
  symbol: string;
  /** The exact topic list the decision event carries. */
  topics: string[];
  /** The data payload's shape. */
  data: {
    type: string;
    fields: Array<{ name: string; type: string }>;
  };
  /** The SPEC section this outcome is specified in. */
  spec_ref: string;
}

interface Vocabulary {
  schema_version: number;
  event: string;
  description: string;
  outcomes: VocabularyOutcome[];
}

interface VendoredVocabulary {
  _provenance: {
    sourceRepo: string;
    sourceCommit: string;
    sourcePath: string;
    digest: string;
    refreshCommand: string;
    upstreamLanded: boolean;
  };
  vocabulary: Vocabulary;
}

function loadVendoredVocabulary(): VendoredVocabulary {
  const path = resolve(process.cwd(), "tests/fixtures/vendor/auth-checked-vocabulary.json");
  return JSON.parse(readFileSync(path, "utf8")) as VendoredVocabulary;
}

/** The blocked outcomes — every reason the contract can publish. */
function blockedOutcomes(vocabulary: Vocabulary): VocabularyOutcome[] {
  return vocabulary.outcomes.filter((outcome) => outcome.symbol !== "allowed");
}

/**
 * A value of the type the fixture documents for one data field.
 *
 * A field whose documented type this test does not know is a hard failure, not
 * a silently skipped field: the data shape is part of the vocabulary the SDK
 * decodes, and a new field type must be a failing test until it is handled.
 */
function scValForType(type: string): xdr.ScVal {
  if (type === "Option<Address>") {
    return xdr.ScVal.scvAddress(new Address(GUARD).toScAddress());
  }
  if (type === "Option<Symbol>") {
    return xdr.ScVal.scvSymbol("transfer");
  }
  if (type === "u32") {
    return xdr.ScVal.scvU32(3);
  }
  if (type === "u64") {
    return xdr.ScVal.scvU64(7n);
  }
  throw new Error(`the fixture documents a data field type this test does not know: ${type}`);
}

describe("auth_checked vocabulary (contracts fixture)", () => {
  it("vendors the contracts fixture with its provenance and an intact digest", () => {
    const doc = loadVendoredVocabulary();
    const provenance = doc._provenance;

    assert.equal(provenance.sourceRepo, "Stellar-Agent-Guard/stellar-agent-guard-contracts");
    assert.match(provenance.sourceCommit, /^[0-9a-f]{40}$/, "source commit must be a pinned SHA");
    assert.equal(provenance.sourcePath, "tests/fixtures/auth-checked-vocabulary.json");
    assert.equal(provenance.refreshCommand, "npm run vendor:refresh");
    assert.equal(provenance.upstreamLanded, true);

    // The digest is recomputed from the vendored file alone, so a hand-edit or
    // a truncated download fails here instead of silently becoming the truth.
    const canonical = `${JSON.stringify(doc.vocabulary, null, 2)}\n`;
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    assert.equal(
      provenance.digest,
      `sha256:${digest}`,
      "the vendored vocabulary was modified without refreshing its digest — run npm run vendor:refresh and commit both together",
    );
  });

  it("decodes every fixture outcome through the SDK's decision decoder", () => {
    const { vocabulary } = loadVendoredVocabulary();

    for (const outcome of vocabulary.outcomes) {
      const decision = decodeAuthDecision(outcome.topics, "diagnostic");
      assert.ok(decision, `the SDK could not decode the fixture outcome '${outcome.symbol}'`);

      if (outcome.symbol === "allowed") {
        assert.equal(decision.result, "allowed");
        // An allowed decision carries the empty symbol as its reason.
        assert.equal(decision.reason, null);
        continue;
      }
      assert.equal(decision.result, "blocked");
      assert.equal(decision.reason, outcome.symbol);
      assert.ok(isGuardReason(decision.reason), `'${outcome.symbol}' is not a known guard reason`);
    }
  });

  it("publishes the exact topic layout the fixture documents", () => {
    const { vocabulary } = loadVendoredVocabulary();

    assert.equal(vocabulary.event, GUARD_EVENT_TOPICS.authChecked);
    for (const outcome of vocabulary.outcomes) {
      assert.equal(outcome.topics.length, 3, `${outcome.symbol}: expected three topics`);
      assert.equal(outcome.topics[0], GUARD_EVENT_TOPICS.authChecked);
      assert.equal(outcome.topics[1], outcome.symbol === "allowed" ? "allowed" : "blocked");
      assert.equal(outcome.topics[2], outcome.symbol === "allowed" ? "" : outcome.symbol);
    }
  });

  it("knows every reason symbol the contract can publish, in both directions", () => {
    const { vocabulary } = loadVendoredVocabulary();

    const sdkSymbols = Object.keys(GUARD_REASON_CODES).sort();
    const fixtureSymbols = blockedOutcomes(vocabulary)
      .map((outcome) => outcome.symbol)
      .sort();

    // A deepEqual on sorted arrays is bidirectional: a reason present in only
    // one of the two vocabularies fails in either direction. A new contract
    // outcome therefore fails here until the SDK's table is extended.
    assert.deepEqual(
      sdkSymbols,
      fixtureSymbols,
      "the SDK's reason vocabulary and the contract's fixture must list the same symbols — a newly added contract outcome fails here until decoder support is updated",
    );

    for (const outcome of blockedOutcomes(vocabulary)) {
      assert.equal(GUARD_REASON_CODES[outcome.symbol as GuardReason], outcome.code);
    }
  });

  it("surfaces the documented data-map fields of the decision event", () => {
    const { vocabulary } = loadVendoredVocabulary();

    for (const outcome of vocabulary.outcomes) {
      const documented = outcome.data.fields.map((field) => field.name).sort();
      const data = xdr.ScVal.scvMap(
        outcome.data.fields.map(
          (field) =>
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol(field.name),
              val: scValForType(field.type),
            }),
        ),
      );
      const event = {
        event: {
          contractId: GUARD,
          body: {
            v0: {
              topics: outcome.topics.map((topic) => xdr.ScVal.scvSymbol(topic)),
              data,
            },
          },
        },
      };

      const decoded = guardEventsFromDiagnostics([event], GUARD);
      assert.equal(decoded.length, 1, `${outcome.symbol}: the event did not decode`);
      const payload = decoded[0]!.data as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(payload).sort(),
        documented,
        `${outcome.symbol}: the decoded data payload does not carry the documented fields`,
      );
      assert.equal(typeof payload["contract"], "string");
      assert.equal(typeof payload["fn_name"], "string");
      assert.equal(typeof payload["context_index"], "number");
      // The u64 field's JavaScript representation depends on the SDK's
      // conversion, so only "a number that is not a string" is pinned here.
      assert.ok(
        typeof payload["revision"] === "number" || typeof payload["revision"] === "bigint",
        `${outcome.symbol}: the revision field must decode to a number, not a string`,
      );
    }
  });

  it("detects a newly added contract outcome instead of accepting it silently", () => {
    const { vocabulary } = loadVendoredVocabulary();

    // The check above is only meaningful if it can fail: a synthetic outcome
    // the SDK does not know must be reported as a mismatch.
    const withNewOutcome: Vocabulary = {
      ...vocabulary,
      outcomes: [
        ...vocabulary.outcomes,
        {
          code: 99,
          error_variant: "BrandNewReason",
          symbol: "brand_new_reason",
          topics: [GUARD_EVENT_TOPICS.authChecked, "blocked", "brand_new_reason"],
          data: vocabulary.outcomes[0]!.data,
          spec_ref: "§99",
        },
      ],
    };

    const sdkSymbols = Object.keys(GUARD_REASON_CODES).sort();
    const fixtureSymbols = blockedOutcomes(withNewOutcome)
      .map((outcome) => outcome.symbol)
      .sort();

    assert.notDeepEqual(fixtureSymbols, sdkSymbols);
    assert.equal(isGuardReason("brand_new_reason"), false);
  });
});
