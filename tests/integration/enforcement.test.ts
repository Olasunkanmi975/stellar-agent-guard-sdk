/**
 * Live enforcement integration tests — the actual Phase 2 exit criterion.
 *
 * Every test below drives the real `invoke()` pipeline against the live Phase 2
 * instance on testnet and asserts on what the network did. Nothing is mocked:
 * an allowed action carries a real transaction hash that is re-read from the RPC,
 * and a blocked action is a real refusal by the deployed `__check_auth` that
 * never reached the mempool.
 *
 * On evidence standards, because "blocked" is easy to fake and easy to
 * misreport: a block happens in enforced re-simulation, *before* broadcast, so
 * by construction it has no transaction hash. The evidence for a block is
 * therefore the contract's own `event_auth_checked, blocked, <reason>` diagnostic
 * event plus the fact that no state moved. Asserting only "it failed" would pass
 * for a contract trap, an absent trustline, or a fee error, which is exactly the
 * confusion this suite exists to rule out.
 *
 * Requires `.env.phase2` (see `scripts/deploy-phase2-instance.ts`). Run with:
 *   npm run test:integration
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { rpc } from "@stellar/stellar-sdk";
import { GUARD_AUTH_RESULTS, decodeAuthDecision } from "../../src/events.ts";
import { topicSymbols } from "../../src/invoke.ts";
import { GUARD_REASON_CODES } from "../../src/reasons.ts";
import {
  TESTNET_PASSPHRASE,
  assertPreconditions,
  guardTokenBalance,
  installPolicy,
  loadPhase2Config,
  readPolicy,
  readStatus,
  readWindowTotal,
  transfer,
  type Phase2Config,
} from "./harness.ts";

let config: Phase2Config;
let server: rpc.Server;

/** A blocked action has no submission — that is the pre-broadcast guarantee. */
type BlockedOutcome = { kind: "blocked"; reason: string; detail?: string; diagnosticEvents: unknown[] };

function assertBlocked(
  outcome: Awaited<ReturnType<typeof transfer>>,
  expectedReason: keyof typeof GUARD_REASON_CODES,
): BlockedOutcome {
  assert.equal(
    outcome.kind,
    "blocked",
    `expected the guard to block with ${expectedReason}, got: ${JSON.stringify(outcome)}`,
  );
  const blocked = outcome as BlockedOutcome;

  // The specific reason, not merely "it failed".
  assert.equal(blocked.reason, expectedReason);
  assert.ok(
    blocked.reason in GUARD_REASON_CODES,
    `reason ${blocked.reason} is not in the SDK's reason vocabulary`,
  );

  // Pre-broadcast: no transaction was submitted, so there is no hash at all.
  assert.ok(
    !("submission" in outcome),
    "a blocked action must not carry a submission result",
  );

  // The refusal must be signed by the contract itself, not inferred from a
  // generic failure: find the guard's own decision event in the diagnostics.
  const decisions = blocked.diagnosticEvents
    .map((event) => decodeAuthDecision(topicSymbols(event), "diagnostic"))
    .filter((decision) => decision !== null);
  assert.ok(
    decisions.length > 0,
    `no event_auth_checked decision among the diagnostics: ${JSON.stringify(outcome)}`,
  );
  const decision = decisions.find((d) => d.result === GUARD_AUTH_RESULTS.blocked);
  assert.ok(decision, "the guard emitted no blocked decision");
  assert.equal(decision.reason, expectedReason);

  return blocked;
}

before(async () => {
  config = await loadPhase2Config();
  server = new rpc.Server(config.rpcUrl);

  // Assert preconditions upfront (code exists, policy active, agent funded, token funded)
  const preconditions = await assertPreconditions(server, config);
  const policy = (await readPolicy(server, config))!;

  console.log(
    `[live preconditions OK] agent balance: ${preconditions.agentBalanceXlm} XLM, token balance: ${preconditions.tokenBalance}\n` +
      `[live] guard ${config.guard}\n` +
      `[live] per-tx cap ${policy.per_tx_cap}, rolling window ${policy.window_cap}/${policy.window_secs}s, ` +
      `${policy.recipients.length} allowlisted recipient(s)`,
  );
});

describe("live enforcement: SAC transfer", () => {
  it("allows a transfer inside both caps, with a real on-chain hash", async () => {
    await installPolicy(server, config); // clean window, re-armed heartbeat
    const before = await guardTokenBalance(server, config);
    const amount = 50n; // ≤ per-tx 1000 and ≤ window 150

    const outcome = await transfer(server, config, amount, config.keys.recipient.publicKey());
    assert.equal(outcome.kind, "allowed", JSON.stringify(outcome));
    const submission = (outcome as { submission: { hash: string; status: string; ledger: number | null } })
      .submission;

    assert.match(submission.hash, /^[0-9a-f]{64}$/, "expected a real transaction hash");
    assert.ok(submission.ledger !== null, "expected the transaction to land in a ledger");

    // Re-read it from the network rather than trusting the submission result.
    const tx = await server.getTransaction(submission.hash);
    assert.equal(tx.status, "SUCCESS", `transaction ${submission.hash} was not successful`);
    console.log(`[allowed] tx ${submission.hash} at ledger ${submission.ledger}`);

    const after = await guardTokenBalance(server, config);
    assert.equal(after, before - amount, "the guarded account's balance did not move as expected");

    const window = await readWindowTotal(server, config);
    assert.equal(window.total, amount, "the rolling window did not record the spend");
  });

  it("blocks a per-transaction-cap violation, pre-broadcast", async () => {
    await installPolicy(server, config);
    const before = await guardTokenBalance(server, config);
    const windowBefore = await readWindowTotal(server, config);
    const overCap = config.policy.per_tx_cap + 1n;

    const outcome = await transfer(server, config, overCap, config.keys.recipient.publicKey());
    const blocked = assertBlocked(outcome, "per_tx_cap_exceeded");
    console.log(`[blocked] per_tx_cap_exceeded (${overCap} > ${config.policy.per_tx_cap})`);
    console.log(`[blocked] detail: ${blocked.detail ?? "(none)"}`);

    // A refusal must move nothing: not funds, not window accounting.
    assert.equal(await guardTokenBalance(server, config), before);
    assert.equal((await readWindowTotal(server, config)).total, windowBefore.total);
  });

  it("blocks a rolling-window-cap violation that only accumulation can explain", async () => {
    await installPolicy(server, config);

    // Each transfer is individually admissible — below `window_cap` and below
    // `per_tx_cap` — and the sum *strictly* exceeds the rolling cap because the
    // contract rejects on `total + amount > cap`, not `>=`. Halving alone would
    // land exactly on the cap and be admitted, which is a test that passes for
    // the wrong reason.
    const perTransfer = config.policy.window_cap / 2n + 1n; // 76 of 150 → sum 152
    assert.ok(
      perTransfer <= config.policy.window_cap,
      "each transfer must be admissible on its own",
    );
    assert.ok(perTransfer <= config.policy.per_tx_cap);
    assert.ok(perTransfer * 2n > config.policy.window_cap);

    const first = await transfer(server, config, perTransfer, config.keys.recipient.publicKey());
    assert.equal(first.kind, "allowed", `first transfer should be allowed: ${JSON.stringify(first)}`);
    const afterFirst = await readWindowTotal(server, config);
    assert.equal(afterFirst.total, perTransfer, "the window did not accumulate the first transfer");

    const balanceAfterFirst = await guardTokenBalance(server, config);
    const second = await transfer(server, config, perTransfer, config.keys.recipient.publicKey());
    const blocked = assertBlocked(second, "window_cap_exceeded");
    console.log(
      `[rolling] ${perTransfer} + ${perTransfer} = ${perTransfer * 2n} > window_cap ${config.policy.window_cap}`,
    );
    console.log(`[rolling] detail: ${blocked.detail ?? "(none)"}`);

    // The second transfer was refused, so the balance and the window are both
    // exactly where the first one left them.
    assert.equal(await guardTokenBalance(server, config), balanceAfterFirst);
    assert.equal((await readWindowTotal(server, config)).total, perTransfer);
  });

  it("blocks a recipient-allowlist violation", async () => {
    await installPolicy(server, config);
    const before = await guardTokenBalance(server, config);
    const outsider = config.keys.outsider.publicKey();
    assert.ok(
      !config.policy.recipients.includes(outsider),
      "the outsider address must not be allowlisted for this test to mean anything",
    );

    const outcome = await transfer(server, config, 10n, outsider);
    const blocked = assertBlocked(outcome, "recipient_not_allowed");
    console.log(`[blocked] recipient_not_allowed (${outsider})`);
    console.log(`[blocked] detail: ${blocked.detail ?? "(none)"}`);

    assert.equal(await guardTokenBalance(server, config), before);
  });

  it("distinguishes an account-state refusal from a policy refusal", async () => {
    // A paused policy refuses with `paused` — an account-state reason, not a
    // spend violation. Pausing is admin-only, and this test restores the policy
    // afterwards so the instance is left as it was found.
    await installPolicy(server, config, { ...config.policy, paused: true });
    const outcome = await transfer(server, config, 10n, config.keys.recipient.publicKey());
    assertBlocked(outcome, "paused");
    console.log("[blocked] paused (account-state refusal)");

    await installPolicy(server, config);
    const status = await readStatus(server, config);
    assert.equal(status.has_policy, true, "the policy was not restored after the paused test");
    const restored = await readPolicy(server, config);
    assert.equal(restored?.paused, false, "the policy is still paused");
  });
});

after(() => {
  console.log(`[live] suite finished against ${config.guard} on ${TESTNET_PASSPHRASE}`);
});
