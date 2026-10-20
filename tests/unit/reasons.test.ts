/**
 * Unit tests for the guard's reason vocabulary.
 *
 * No network: these assert that the off-chain table matches the on-chain enum.
 * The exact numbers matter — `reasonNameFromCode` is what turns a decoded
 * `Error(Contract, #22)` into `per_tx_cap_exceeded`, and a table that drifts from
 * `stellar-agent-guard-contracts/src/types.rs` would silently mislabel every
 * refusal.
 *
 * The matrix itself is **not** copied into this file. It is read from the
 * contracts repo's own vocabulary fixture, vendored at
 * `tests/fixtures/vendor/auth-checked-vocabulary.json`, so a reason the
 * contract adds fails this test until the SDK's table is extended — instead of
 * being silently accepted by a second, hand-maintained copy.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  ACCOUNT_STATE_REASONS,
  GUARD_REASON_CODES,
  GUARD_REASONS,
  GuardBlockedError,
  explainReason,
  isGuardReason,
  reasonMessages,
  reasonMessagesEn,
  reasonName,
  reasonNameFromCode,
  type GuardReason,
} from "../../src/reasons.ts";
import { unsafeContractAddress } from "../../src/policy.ts";

/**
 * The contract's own vocabulary, read from the vendored contracts fixture.
 *
 * `Allowed` is the one outcome without an `Error` code, so it contributes no
 * reason; every other outcome is one reason symbol with its numeric code.
 */
function contractReasonCodes(): Record<string, number> {
  const path = resolve(process.cwd(), "tests/fixtures/vendor/auth-checked-vocabulary.json");
  const doc = JSON.parse(readFileSync(path, "utf8")) as {
    vocabulary: {
      outcomes: Array<{ symbol: string; code: number | null }>;
    };
  };
  const codes: Record<string, number> = {};
  for (const outcome of doc.vocabulary.outcomes) {
    if (outcome.code === null) continue;
    codes[outcome.symbol] = outcome.code;
  }
  return codes;
}

describe("reason code table", () => {
  it("matches the contract's Error enum exactly", () => {
    // Read from the contracts repo's fixture, not from a second copy of the
    // matrix kept in this repository. If this fails, the SDK is describing a
    // different contract — or the contract added a reason.
    assert.deepEqual({ ...GUARD_REASON_CODES }, contractReasonCodes());
  });

  it("has no duplicate numeric codes", () => {
    const codes = Object.values(GUARD_REASON_CODES);
    assert.equal(new Set(codes).size, codes.length);
  });

  it("maps every code back to its name", () => {
    for (const [name, code] of Object.entries(GUARD_REASON_CODES)) {
      assert.equal(reasonNameFromCode(code), name);
    }
  });

  it("returns undefined for a code the contract does not define", () => {
    assert.equal(reasonNameFromCode(999), undefined);
  });
});

describe("GuardReason vocabulary", () => {
  it("derives GUARD_REASONS from the single reason table", () => {
    assert.deepEqual(Object.keys(GUARD_REASONS).sort(), Object.keys(GUARD_REASON_CODES).sort());
    for (const reason of Object.values(GUARD_REASONS)) {
      assert.equal(GUARD_REASONS[reason], reason);
    }
  });

  it("keeps GUARD_REASONS and the vendored contract fixture in lockstep, both ways", () => {
    const fixturePath = resolve(process.cwd(), "tests/fixtures/contract-fixtures.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      entries: Array<{ result: string; reason: string; code: number | null }>;
    };
    const fixtureReasons = fixture.entries
      .filter((entry) => entry.result === "blocked")
      .map((entry) => entry.reason)
      .sort();
    // deepEqual on sorted arrays is bidirectional: a reason present in only one
    // of the SDK vocabulary and the fixture fails in either direction.
    assert.deepEqual(Object.keys(GUARD_REASONS).sort(), fixtureReasons);
    for (const entry of fixture.entries) {
      if (entry.result !== "blocked") continue;
      assert.equal(GUARD_REASON_CODES[entry.reason as GuardReason], entry.code);
    }
  });

  it("recognises only the known vocabulary", () => {
    assert.equal(isGuardReason("paused"), true);
    assert.equal(isGuardReason("not_a_reason"), false);
    assert.equal(isGuardReason(22), false);
  });

  it("rejects an unknown reason at compile time", () => {
    // @ts-expect-error `drain_the_account` is not part of the guard vocabulary
    const notAReason: GuardReason = "drain_the_account";
    assert.equal(notAReason, "drain_the_account");
  });
});

describe("reasonName", () => {
  it("accepts a numeric code", () => {
    assert.equal(reasonName(22), "per_tx_cap_exceeded");
  });

  it("accepts the snake_case symbol the contract emits", () => {
    assert.equal(reasonName("window_cap_exceeded"), "window_cap_exceeded");
  });

  it("does not throw on an unknown numeric code", () => {
    assert.equal(reasonName(4242), "unknown_reason_4242");
  });
});

describe("explainReason", () => {
  it("explains a known reason by code and by name identically", () => {
    assert.equal(explainReason(21), explainReason("recipient_not_allowed"));
    assert.match(explainReason(21), /recipient/i);
  });

  it("falls back for an unrecognised reason rather than throwing", () => {
    assert.match(explainReason(777), /Unrecognised/);
  });
});

/**
 * Golden snapshot for issue #96.
 *
 * These strings were captured from `explainReason` *before* the message-key
 * refactor, by iterating `GUARD_REASON_CODES` against the then-current module.
 * They are committed here as the refactor's safety net: a default call must
 * still return exactly this text, character for character, or the refactor has
 * changed behavior a consumer depends on.
 */
const GOLDEN_EXPLANATIONS: Record<GuardReason, string> = {
  unauthorized: "The presented signature did not verify against the account's registered agent key.",
  already_initialized: "The guard account has already been initialized.",
  not_initialized: "The guard account has no registered agent key yet.",
  invalid_config: "The policy configuration was rejected by validation and was not applied.",
  invalid_amount: "The transfer amount was zero or negative.",
  no_pending_admin: "The account has no pending admin rotation to confirm or cancel.",
  admin_frozen: "An admin froze the account (freeze), or the dead-man switch grace window lapsed.",
  heartbeat_expired: "The dead-man switch fired: no heartbeat within the policy's grace window, so the account is frozen until an admin unfreezes it.",
  no_policy: "No policy is installed (never set, or revoked) — the account is default-deny.",
  paused: "The policy's admin kill switch is engaged.",
  outside_active_window: "The current ledger time is outside the policy's active_from/active_until window.",
  asset_not_allowed: "The SAC token being called is not in the policy's assets list.",
  recipient_not_allowed: "The transfer recipient is not in the policy's recipients allowlist.",
  per_tx_cap_exceeded: "The transfer amount exceeds the policy's per-transaction cap.",
  window_cap_exceeded: "The transfer would push cumulative spend over the rolling-window cap.",
  protocol_not_allowed: "The contract being called is not in the policy's protocols allowlist.",
  function_not_allowed: "The function being called on an allowlisted contract is not in its function allowlist.",
  unknown_contract: "The contract being called is neither the account itself, an allowlisted asset, nor an allowlisted protocol (default deny).",
  self_function_not_allowed: "The call targets a guard function that the agent key may not invoke.",
  create_contract_not_allowed: "The account may not authorize contract creation.",
  recipient_blocked: "The transfer recipient is explicitly blocked by the account's policy.",
  protocol_call_rate_exceeded: "The call would push the rolling protocol-call count past its configured limit.",
  decision_invariant_violation: "The guard's decision engine hit an internal invariant, so the call was refused rather than allowed.",
  asset_fn_not_allowed: "The call invoked a function other than `transfer` on an allowlisted asset.",
  too_many_auth_contexts: "The call carried more authorization contexts than the guard's decision engine evaluates.",
};

describe("explainReason golden snapshot (issue #96)", () => {
  it("returns the pre-refactor English output byte-identically for every reason", () => {
    for (const reason of Object.keys(GUARD_REASON_CODES) as GuardReason[]) {
      assert.equal(explainReason(reason), GOLDEN_EXPLANATIONS[reason], `${reason} drifted`);
    }
  });

  it("serves that output from the English message map, not a stray literal", () => {
    for (const reason of Object.keys(GUARD_REASON_CODES) as GuardReason[]) {
      assert.equal(explainReason(reason), reasonMessagesEn[reason].body);
      assert.equal(reasonMessagesEn[reason].body, GOLDEN_EXPLANATIONS[reason]);
    }
  });

  it("commits an unconditional snapshot, so the fixture cannot silently pass empty", () => {
    assert.equal(Object.keys(GOLDEN_EXPLANATIONS).length, Object.keys(GUARD_REASON_CODES).length);
  });

  it("keeps the unknown-reason fallback unchanged", () => {
    assert.equal(explainReason(777), "Unrecognised guard reason: 777");
    assert.equal(explainReason("not_a_reason"), "Unrecognised guard reason: not_a_reason");
  });
});

describe("reasonMessages structure (issue #96)", () => {
  it("lists every reason exactly once, derived from the single code source", () => {
    assert.deepEqual(
      Object.keys(reasonMessages).sort(),
      Object.keys(GUARD_REASON_CODES).sort(),
    );
    assert.deepEqual(
      Object.keys(reasonMessagesEn).sort(),
      Object.keys(GUARD_REASON_CODES).sort(),
    );
  });

  it("namespaces distinct title/body/remediation keys per reason and carries the code", () => {
    const keys = new Set<string>();
    for (const [reason, message] of Object.entries(reasonMessages)) {
      assert.equal(message.code, GUARD_REASON_CODES[reason as GuardReason]);
      assert.equal(message.titleKey, `guard.reason.${reason}.title`);
      assert.equal(message.bodyKey, `guard.reason.${reason}.body`);
      assert.equal(message.remediationKey, `guard.reason.${reason}.remediation`);
      for (const key of [message.titleKey, message.bodyKey, message.remediationKey]) {
        assert.ok(!keys.has(key), `duplicate message key ${key}`);
        keys.add(key);
      }
    }
  });

  it("provides English text for every title/body/remediation key", () => {
    for (const [reason, message] of Object.entries(reasonMessages)) {
      assert.ok(reasonMessagesEn[reason as GuardReason].title.length > 0);
      assert.ok(reasonMessagesEn[reason as GuardReason].body.length > 0);
      assert.ok(reasonMessagesEn[reason as GuardReason].remediation.length > 0);
      assert.ok(message.bodyKey.endsWith(".body"));
    }
  });

  it("ships no i18n framework: the maps are plain frozen objects", () => {
    assert.ok(Object.isFrozen(reasonMessages));
    assert.ok(Object.isFrozen(reasonMessagesEn));
  });
});

describe("explainReason localisation (issue #96)", () => {
  it("returns a per-reason override without touching the default", () => {
    const text = explainReason("paused", undefined, { paused: "Kill switch is on." });
    assert.equal(text, "Kill switch is on.");
    assert.equal(explainReason("paused"), GOLDEN_EXPLANATIONS.paused);
  });

  it("resolves a locale catalog through bodyKey", () => {
    const fr: Record<string, string> = {
      [reasonMessages.paused.bodyKey]: "Le coupe-circuit administrateur est actif.",
    };
    assert.equal(explainReason("paused", fr), "Le coupe-circuit administrateur est actif.");
    assert.equal(explainReason(13, fr), "Le coupe-circuit administrateur est actif.");
  });

  it("falls back to English for a key the locale omits", () => {
    assert.equal(explainReason("paused", {}), GOLDEN_EXPLANATIONS.paused);
  });

  it("applies the override ahead of the locale", () => {
    const fr: Record<string, string> = {
      [reasonMessages.paused.bodyKey]: "Le coupe-circuit administrateur est actif.",
    };
    assert.equal(
      explainReason("paused", fr, { paused: "overridden" }),
      "overridden",
    );
  });
});

describe("GuardBlockedError", () => {
  it("carries the reason name, code and explanation", () => {
    const error = new GuardBlockedError({ reason: 22, stage: "preflight" });
    assert.equal(error.reason, "per_tx_cap_exceeded");
    assert.equal(error.code, 22);
    assert.equal(error.stage, "preflight");
    assert.match(error.message, /per_tx_cap_exceeded/);
  });

  it("defaults to uncharged, because a pre-flight block never broadcasts", () => {
    const error = new GuardBlockedError({ reason: "window_cap_exceeded", stage: "preflight" });
    assert.equal(error.charged, false);
    assert.equal(error.code, 23);
  });

  it("can be marked charged for a post-broadcast refusal", () => {
    const error = new GuardBlockedError({
      reason: "admin_frozen",
      stage: "submission",
      charged: true,
    });
    assert.equal(error.charged, true);
    assert.equal(error.name, "GuardBlockedError");
  });

  it("carries offending call and raw diagnostic event when provided", () => {
    const dummyCall = {
      contract: unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44"),
      fn: "transfer",
      args: [],
    };
    const dummyEvent = { topics: ["event_auth_checked", "blocked", "paused"] };

    const error = new GuardBlockedError({
      reason: "paused",
      stage: "preflight",
      detail: "simulation refused",
      call: dummyCall,
      rawEvent: dummyEvent,
    });

    assert.equal(error.reason, "paused");
    assert.equal(error.code, 13);
    assert.equal(error.stage, "preflight");
    assert.equal(error.charged, false);
    assert.equal(error.detail, "simulation refused");
    assert.deepEqual(error.call, dummyCall);
    assert.deepEqual(error.rawEvent, dummyEvent);
    assert.match(error.message, /paused/);
    assert.match(error.message, /CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44/);
    assert.ok(error instanceof Error);
    assert.ok(error instanceof GuardBlockedError);
  });

  it("serializes to a structured, logging-friendly JSON object via toJSON()", () => {
    const dummyCall = {
      contract: unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44"),
      fn: "transfer",
      args: [],
    };
    const dummyEvent = { type: "diagnostic", topics: ["event_auth_checked"] };

    const error = new GuardBlockedError({
      reason: "per_tx_cap_exceeded",
      stage: "preflight",
      detail: "limit exceeded",
      call: dummyCall,
      rawEvent: dummyEvent,
    });

    const json = error.toJSON();
    assert.equal(json["name"], "GuardBlockedError");
    assert.equal(json["reason"], "per_tx_cap_exceeded");
    assert.equal(json["code"], 22);
    assert.equal(json["stage"], "preflight");
    assert.equal(json["charged"], false);
    assert.equal(json["detail"], "limit exceeded");
    assert.deepEqual(json["call"], {
      contract: unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44"),
      fn: "transfer",
      argsCount: 0,
    });
    assert.deepEqual(json["rawEvent"], dummyEvent);
    assert.equal(typeof json["message"], "string");
    assert.equal(typeof json["explanation"], "string");
  });
});

describe("account-state reasons", () => {
  it("separates 'the guard is not ready' from 'this call broke policy'", () => {
    for (const reason of ACCOUNT_STATE_REASONS) {
      assert.ok(
        reason in GUARD_REASON_CODES,
        `${reason} is listed as an account-state reason but is not a known reason`,
      );
    }
    assert.ok(!ACCOUNT_STATE_REASONS.includes("per_tx_cap_exceeded"));
  });
});
