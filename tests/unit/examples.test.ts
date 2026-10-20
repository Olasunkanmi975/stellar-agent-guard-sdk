/**
 * Unit tests verifying runnable framework adapter examples in examples/ directory.
 *
 * Ensures no dead code in documentation/examples, matching evidence culture.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runLangChainExample } from "../../examples/langchain.ts";
import { runElizaOSExample } from "../../examples/elizaos.ts";
import { runMcpExample } from "../../examples/mcp.ts";

describe("runnable framework adapter examples", () => {
  it("executes LangChain middleware example with allowed and blocked runs", async () => {
    const res = await runLangChainExample();

    // Run 1: Allowed
    assert.equal(res.allowedToolRan, true, "allowed tool body should execute");
    assert.deepEqual(res.allowedResult, { content: '{"success":true,"transferred":"50"}' });

    // Run 2: Blocked
    assert.equal(res.blockedToolRan, false, "blocked tool body must never execute");
    assert.ok("status" in res.blockedResult && res.blockedResult.status === "error");
    const content = (res.blockedResult as { content: string }).content;
    assert.match(content, /stellar-agent-guard blocked 'transfer_tokens': recipient_not_allowed/);
    assert.match(content, /No transaction was submitted, so nothing was spent and no fee was paid/);

    // Decisions observed
    assert.equal(res.decisionsObserved.length, 2);
    assert.equal(res.decisionsObserved[0]!.kind, "admissible");
    assert.equal(res.decisionsObserved[1]!.kind, "blocked");

    // Operator alerting: the onBlocked hook fires once with the shared payload
    assert.equal(res.blockedInfos.length, 1);
    assert.equal(res.blockedInfos[0]!.adapter, "langchain");
    assert.equal(res.blockedInfos[0]!.kind, "blocked");
    assert.equal(res.blockedInfos[0]!.reason, "recipient_not_allowed");
    assert.equal(res.blockedInfos[0]!.call?.fn, "transfer");
    assert.match(res.blockedInfos[0]!.explanation, /recipient/i);
  });

  it("executes ElizaOS validator example with allowed and blocked runs", async () => {
    const res = await runElizaOSExample();

    // Base validate was consulted for both runs
    assert.equal(res.baseValidateRan, 2);

    // Run 1: Allowed
    assert.equal(res.allowedDirectVerdict, true, "direct validator must return true for allowed state");
    assert.equal(res.allowedVerdict, true, "allowed action must validate to true");

    // Run 2: Blocked
    assert.equal(res.blockedVerdict, false, "blocked action must validate to false");
    assert.equal(res.blockedDecisions.length, 1);
    assert.equal(res.blockedDecisions[0]!.adapter, "elizaos");
    assert.equal(res.blockedDecisions[0]!.kind, "blocked");
    if (res.blockedDecisions[0]!.kind === "blocked") {
      assert.equal(res.blockedDecisions[0]!.reason, "per_tx_cap_exceeded");
      assert.match(res.blockedDecisions[0]!.explanation, /exceeds the policy's per-transaction cap/);
    }
    assert.equal(res.blockedDecisions[0]!.call?.fn, "transfer");
  });

  it("executes the MCP adapter example at both boundaries", async () => {
    const res = await runMcpExample();

    // Run 1: Allowed — the registered handler runs.
    assert.equal(res.allowedHandlerRan, true);
    assert.equal(res.allowedResult.content[0]?.text, "transferred");

    // Run 2: Blocked — the handler never runs, the client gets an error result.
    assert.equal(res.blockedHandlerRan, false);
    assert.ok("isError" in res.blockedResult && res.blockedResult.isError === true);
    assert.match(res.blockedResult.content[0]?.text ?? "", /recipient_not_allowed/);

    // Operator alerting through the shared hook.
    assert.equal(res.blockedInfos.length, 1);
    assert.equal(res.blockedInfos[0]!.adapter, "mcp");
    assert.equal(res.blockedInfos[0]!.reason, "recipient_not_allowed");

    // Client boundary: refused before the request was sent.
    assert.equal(res.requestSent, false);
    assert.ok("isError" in res.clientResult && res.clientResult.isError === true);
  });
});
