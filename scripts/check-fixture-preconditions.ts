#!/usr/bin/env node
/**
 * Preflight check for the live testnet suite.
 *
 * Verifies that the testnet deployment fixture instance is alive, funded, and valid
 * before executing live integration tests.
 *
 * If any precondition check fails, emits an explicit actionable error message:
 * "fixture needs redeploy — run scripts/deploy-phase2-instance.ts"
 * and exits with code 1.
 */
import { rpc } from "@stellar/stellar-sdk";
import {
  assertPreconditions,
  loadPhase2Config,
  readFixtureInstance,
} from "../tests/integration/harness.ts";

async function main(): Promise<void> {
  console.log("=== Checking Phase 2 Fixture Preconditions ===");

  // 1. Check fixture schema
  try {
    const fixture = await readFixtureInstance();
    console.log(`[precondition 0/4] ✓ fixture JSON schema valid (guard ${fixture.phase2EnforcementInstance.guard})`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // 2. Load configuration from .env.phase2
  let config;
  try {
    config = await loadPhase2Config();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const server = new rpc.Server(config.rpcUrl);

  // 3. Assert on-chain preconditions (code, policy, agent balance, token balance)
  try {
    const report = await assertPreconditions(server, config);
    console.log("[precondition 1/4] ✓ guard contract code exists on ledger");
    console.log("[precondition 2/4] ✓ guard policy installed and active");
    console.log(`[precondition 3/4] ✓ agent account funded (${report.agentBalanceXlm} XLM)`);
    console.log(`[precondition 4/4] ✓ guard token balance funded (${report.tokenBalance})`);
    console.log("=== All Fixture Preconditions Passed ===\n");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
