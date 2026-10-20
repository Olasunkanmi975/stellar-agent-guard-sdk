/**
 * Shared cross-framework conformance matrix (issue #317).
 *
 * Every adapter is driven through the same fixture table — admissible, blocked,
 * undetermined, mapping failures and failing observers — so a divergence in the
 * invariants that are supposed to hold everywhere shows up as one failing row
 * rather than as four unrelated test files drifting apart.
 *
 * The shared invariants are deliberately framework-agnostic:
 *
 *   - only an admissible verdict lets the handler run;
 *   - a non-admissible verdict (including a fail-closed `undetermined` one)
 *     never enters the handler;
 *   - a mapper failure halts too (issue #316);
 *   - an observer that throws or rejects changes nothing (issue #313);
 *   - `signal`/`timeoutMs` reach the pre-flight check (issue #315).
 *
 * Result-shape assertions stay in their own block at the bottom: the host
 * contracts genuinely differ (a `ToolMessage`, a boolean, an `isError` result,
 * a thrown error), and collapsing those into the matrix would hide the very
 * difference the docs spell out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLangChainGuardMiddleware } from "../../src/adapters/langchain.ts";
import { mapContractCalls } from "../../src/adapters/shared.ts";
import { createGuardValidator } from "../../src/adapters/elizaos.ts";
import { guardMcpToolHandler } from "../../src/adapters/mcp.ts";
import { wrapToolWithGuard } from "../../src/adapters/vercelai.ts";
import { AdapterMappingError } from "../../src/errors.ts";
import { GuardBlockedError, explainReason } from "../../src/reasons.ts";
import { PreFlightUndeterminedError } from "../../src/preflight.ts";
import { unsafeContractAddress } from "../../src/policy.ts";
import type {
  PreFlightCheckOptions,
  PreFlightDecision,
  PreFlightInterceptor,
} from "../../src/preflight.ts";
import type { ContractCall } from "../../src/tx.ts";
import type {
  BlockedHookLogger,
  GuardAdapterName,
  GuardBlockedInfo,
} from "../../src/adapters/shared.ts";

const GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");

const CALL: ContractCall = { contract: GUARD, fn: "transfer", args: [] };

const ADMISSIBLE: PreFlightDecision = {
  allowed: true,
  kind: "admissible",
  estimatedResourceFee: 100n,
  footprintKeys: 2,
};

const BLOCKED: PreFlightDecision = {
  allowed: false,
  kind: "blocked",
  reason: "per_tx_cap_exceeded",
  explanation: explainReason("per_tx_cap_exceeded"),
  detail: "enforced simulation refused the transfer",
  diagnosticEvents: [],
};

const UNDETERMINED: PreFlightDecision = {
  allowed: false,
  kind: "undetermined",
  detail: "rpc unreachable",
};

/** The five fixtures every adapter must agree on. */
interface Scenario {
  name: string;
  /** Verdict the stub interceptor returns; never consulted for mapper failures. */
  decision: PreFlightDecision;
  /** `maps` = one valid call, `null` = not fund-moving, failures halt. */
  mapping: "maps" | "null" | "throws" | "malformed";
  /** Whether the handler must be kept from running. */
  halts: boolean;
  /** Expected `onDecision` calls. */
  decisions: number;
  /** Expected `onBlocked` calls (adapters that expose the hook). */
  blockedHooks: number;
}

const SCENARIOS: Scenario[] = [
  { name: "admissible", decision: ADMISSIBLE, mapping: "maps", halts: false, decisions: 1, blockedHooks: 0 },
  { name: "blocked", decision: BLOCKED, mapping: "maps", halts: true, decisions: 1, blockedHooks: 1 },
  { name: "undetermined", decision: UNDETERMINED, mapping: "maps", halts: true, decisions: 1, blockedHooks: 1 },
  { name: "mapping throws", decision: ADMISSIBLE, mapping: "throws", halts: true, decisions: 0, blockedHooks: 1 },
  { name: "mapping malformed", decision: ADMISSIBLE, mapping: "malformed", halts: true, decisions: 0, blockedHooks: 1 },
  { name: "mapping null (not fund-moving)", decision: ADMISSIBLE, mapping: "null", halts: false, decisions: 0, blockedHooks: 0 },
];

function mapperFor(scenario: Scenario): () => ContractCall | null {
  switch (scenario.mapping) {
    case "null":
      return () => null;
    case "throws":
      return () => {
        throw new Error("mapper exploded");
      };
    case "malformed":
      // Structurally not a contract call: empty contract, no usable args.
      return () => ({ contract: "", fn: "transfer", args: [] }) as unknown as ContractCall;
    default:
      return () => CALL;
  }
}

function stub(decision: PreFlightDecision): PreFlightInterceptor {
  return {
    check: async () => decision,
    checkBatch: async (calls: readonly ContractCall[]) => ({
      admissible: decision.allowed,
      overallAdmissible: decision.allowed,
      verdicts: calls.map(() => decision),
      calls: calls.map(() => decision),
      totalEstimatedResourceFee: 0n,
    }),
  } as unknown as PreFlightInterceptor;
}

interface Observer {
  onBlocked?: ((info: GuardBlockedInfo) => unknown) | undefined;
  onDecision?: ((...args: unknown[]) => unknown) | undefined;
  logger?: BlockedHookLogger | undefined;
}

interface Controls {
  interceptor?: PreFlightInterceptor;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** A signal the host hook itself supplies (LangChain request / MCP extra). */
  hostSignal?: AbortSignal | undefined;
}

interface Outcome {
  /** How many times the framework handler/execute body ran. */
  entered: number;
  halted: boolean;
  /** Refusal text for the adapters that return one; empty for a plain boolean. */
  refusal: string;
}

interface AdapterHarness {
  name: GuardAdapterName;
  /** Whether this adapter's options expose `onBlocked`. */
  hasBlockedHook: boolean;
  run(scenario: Scenario, observer: Observer, controls?: Controls): Promise<Outcome>;
}

function interceptorFor(scenario: Scenario, controls?: Controls): PreFlightInterceptor {
  return controls?.interceptor ?? stub(scenario.decision);
}

/** Options every adapter shares; `onBlocked` is added only where the API has it. */
function baseOptions(scenario: Scenario, observer: Observer, controls: Controls) {
  return {
    interceptor: interceptorFor(scenario, controls),
    ...(observer.logger ? { blockedHookLogger: observer.logger } : {}),
    ...(controls.signal ? { signal: controls.signal } : {}),
    ...(controls.timeoutMs !== undefined ? { timeoutMs: controls.timeoutMs } : {}),
  };
}

const HARNESSES: AdapterHarness[] = [
  {
    name: "langchain",
    hasBlockedHook: true,
    async run(scenario, observer, controls = {}) {
      let entered = 0;
      const middleware = createLangChainGuardMiddleware({
        ...baseOptions(scenario, observer, controls),
        toContractCall: mapperFor(scenario),
        ...(observer.onBlocked
          ? { onBlocked: observer.onBlocked as (info: GuardBlockedInfo) => void }
          : {}),
        ...(observer.onDecision
          ? {
              onDecision: observer.onDecision as (
                request: unknown,
                decision: PreFlightDecision,
              ) => void,
            }
          : {}),
      });
      const request = {
        toolCall: { name: "send_payment", id: "lc_1", args: {} },
        ...(controls.hostSignal ? { signal: controls.hostSignal } : {}),
      };
      const result = await middleware.wrapToolCall(request, async () => {
        entered += 1;
        return { content: "sent" };
      });
      return {
        entered,
        halted: entered === 0,
        refusal: "content" in result ? String(result.content) : "",
      };
    },
  },
  {
    name: "elizaos",
    hasBlockedHook: true,
    async run(scenario, observer, controls = {}) {
      let entered = 0;
      const validate = createGuardValidator({
        ...baseOptions(scenario, observer, controls),
        toContractCall: () => mapperFor(scenario)(),
        ...(observer.onBlocked
          ? { onBlocked: observer.onBlocked as (info: GuardBlockedInfo) => void }
          : {}),
        ...(observer.onDecision
          ? { onDecision: observer.onDecision as (decision: PreFlightDecision) => void }
          : {}),
      });
      const allowed = await validate({}, {}, {});
      if (allowed) entered += 1;
      return { entered, halted: !allowed, refusal: "" };
    },
  },
  {
    name: "mcp",
    hasBlockedHook: true,
    async run(scenario, observer, controls = {}) {
      let entered = 0;
      const handler = guardMcpToolHandler(
        "send_payment",
        async () => {
          entered += 1;
          return { content: [{ type: "text", text: "sent" }] };
        },
        {
          ...baseOptions(scenario, observer, controls),
          toContractCall: () => mapperFor(scenario)(),
          ...(observer.onBlocked
            ? { onBlocked: observer.onBlocked as (info: GuardBlockedInfo) => void }
            : {}),
          ...(observer.onDecision
            ? {
                onDecision: observer.onDecision as (
                  request: unknown,
                  decision: PreFlightDecision,
                ) => void,
              }
            : {}),
        },
      );
      const result = await handler(
        {},
        controls.hostSignal ? { signal: controls.hostSignal } : undefined,
      );
      return {
        entered,
        halted: entered === 0,
        refusal: result.content.map((block) => block.text ?? "").join(" "),
      };
    },
  },
  {
    name: "vercelai",
    // The AI SDK adapter signals refusals by throwing; it has no onBlocked.
    hasBlockedHook: false,
    async run(scenario, observer, controls = {}) {
      let entered = 0;
      const tool = wrapToolWithGuard(
        {
          async execute() {
            entered += 1;
            return "sent";
          },
        },
        {
          ...baseOptions(scenario, observer, controls),
          toContractCall: () => mapperFor(scenario)(),
          ...(observer.onDecision
            ? {
                onDecision: observer.onDecision as (
                  call: unknown,
                  decision: PreFlightDecision,
                ) => void,
              }
            : {}),
        },
        { toolName: "send_payment", input: {} },
      );
      let refusal = "";
      try {
        await tool.execute!();
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      return { entered, halted: entered === 0, refusal };
    },
  },
];

/** Count observer calls so the matrix can assert the callback invariants too. */
function observing(): {
  observer: Observer;
  blocked: GuardBlockedInfo[];
  decisionCount: () => number;
} {
  const blocked: GuardBlockedInfo[] = [];
  let decisions = 0;
  return {
    observer: {
      onBlocked: (info) => {
        blocked.push(info);
      },
      onDecision: () => {
        decisions += 1;
      },
    },
    blocked,
    decisionCount: () => decisions,
  };
}

describe("cross-framework conformance matrix (issue #317)", () => {
  for (const adapter of HARNESSES) {
    describe(adapter.name, () => {
      for (const scenario of SCENARIOS) {
        it(`${scenario.name}: handler entered ${scenario.halts ? 0 : 1} time(s)`, async () => {
          const { observer, blocked, decisionCount } = observing();
          const outcome = await adapter.run(scenario, observer);

          assert.equal(
            outcome.entered,
            scenario.halts ? 0 : 1,
            `${scenario.name}: the handler entry count differed from the shared invariant`,
          );
          assert.equal(outcome.halted, scenario.halts, `${scenario.name}: halt state`);
          assert.equal(decisionCount(), scenario.decisions, `${scenario.name}: onDecision calls`);
          if (adapter.hasBlockedHook) {
            assert.equal(blocked.length, scenario.blockedHooks, `${scenario.name}: onBlocked calls`);
          }
        });
      }
    });
  }
});

describe("call-mapping failures fail closed (issue #316)", () => {
  for (const adapter of HARNESSES.filter((candidate) => candidate.hasBlockedHook)) {
    it(`${adapter.name}: reports a mapper failure as an undetermined halt with no call`, async () => {
      const { observer, blocked } = observing();
      const outcome = await adapter.run(
        SCENARIOS.find((scenario) => scenario.name === "mapping throws")!,
        observer,
      );

      assert.equal(outcome.entered, 0);
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0]!.adapter, adapter.name);
      assert.equal(blocked[0]!.kind, "undetermined");
      assert.equal(blocked[0]!.reason, null);
      assert.equal(blocked[0]!.call, undefined, "a mapping failure has no mapped call to report");
      assert.match(blocked[0]!.explanation, /call mapping failed/);
      assert.match(blocked[0]!.explanation, /mapper exploded/);
    });
  }

  it("Vercel AI: a mapper failure throws PreFlightUndeterminedError with the mapping cause", async () => {
    const harness = HARNESSES.find((candidate) => candidate.name === "vercelai")!;
    const outcome = await harness.run(
      SCENARIOS.find((scenario) => scenario.name === "mapping throws")!,
      {},
    );
    assert.equal(outcome.entered, 0);
    assert.match(outcome.refusal, /could not determine/);
    assert.match(outcome.refusal, /call mapping failed/);
  });

  const isMappingError = (error: unknown): boolean => {
    if (error instanceof AdapterMappingError) return true;
    assert.fail(`expected an AdapterMappingError, got ${String(error)}`);
  };

  it("flags a malformed single-call return as a typed AdapterMappingError", () => {
    assert.throws(
      () =>
        mapContractCalls({}, {
          toContractCall: () => ({ contract: "", fn: "transfer", args: [] }) as unknown as ContractCall,
        }),
      isMappingError,
    );
  });

  it("flags a malformed batch entry and names its index", () => {
    assert.throws(
      () =>
        mapContractCalls({}, {
          toContractCalls: () => [{ contract: GUARD, fn: "", args: [] }] as ContractCall[],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AdapterMappingError);
        assert.equal(error.field, "toContractCalls");
        assert.match(error.message, /index 0/);
        return true;
      },
    );
  });

  it("runs unmapped calls through nothing at all (null stays a pass-through)", () => {
    assert.deepEqual(mapContractCalls({}, { toContractCall: () => null }), []);
    assert.deepEqual(mapContractCalls({}, { toContractCalls: () => null }), []);
  });
});

describe("observer isolation (issue #313)", () => {
  for (const adapter of HARNESSES) {
    it(`${adapter.name}: sync throws and rejected async hooks cannot change the halt`, async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const failures: Observer[] = [
          {
            onBlocked: () => {
              throw new Error("sync sink failure");
            },
          },
          { onBlocked: () => Promise.reject(new Error("async sink failure")) },
          {
            onDecision: () => {
              throw new Error("sync decision failure");
            },
          },
          { onDecision: () => Promise.reject(new Error("async decision failure")) },
        ];

        const applicable = failures.filter(
          (observer) => adapter.hasBlockedHook || observer.onDecision !== undefined,
        );

        for (const observer of applicable) {
          const logged: unknown[][] = [];
          const logger: BlockedHookLogger = {
            error: (...args) => {
              logged.push(args);
            },
          };
          const outcome = await adapter.run(SCENARIOS[1]!, { ...observer, logger });

          assert.equal(outcome.entered, 0, "an observer failure resumed a blocked action");
          assert.equal(outcome.halted, true);
          assert.match(
            String(logged[0]?.[0] ?? ""),
            /onBlocked|onDecision/,
            "a swallowed observer failure must name the hook when a logger is supplied",
          );
          // Let every isolated rejection settle before the unhandled check.
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      assert.deepEqual(unhandled, [], "an observer rejection escaped as unhandled");
    });

    it(`${adapter.name}: does not await a pending async observer`, async () => {
      const pending = adapter.run(SCENARIOS[1]!, {
        onBlocked: () => new Promise<void>(() => {}),
        onDecision: () => new Promise<void>(() => {}),
      });
      const result = await Promise.race([
        pending,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ]);
      assert.notEqual(result, "timeout", "the adapter awaited an observer hook");
      assert.equal((result as Outcome).entered, 0);
    });

    it(`${adapter.name}: a failing onDecision cannot stop an admissible handler`, async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const failures: Observer[] = [
          {
            onDecision: () => {
              throw new Error("sync decision failure");
            },
          },
          { onDecision: () => Promise.reject(new Error("async decision failure")) },
        ];

        for (const observer of failures) {
          const logged: unknown[][] = [];
          const logger: BlockedHookLogger = {
            error: (...args) => {
              logged.push(args);
            },
          };
          const outcome = await adapter.run(SCENARIOS[0]!, { ...observer, logger });

          assert.equal(outcome.entered, 1, "an observer failure suppressed an allowed action");
          assert.equal(outcome.halted, false);
          assert.doesNotMatch(outcome.refusal, /blocked|could not determine|refus/i);
          assert.match(
            String(logged[0]?.[0] ?? ""),
            /onDecision/,
            "a swallowed observer failure must name the hook when a logger is supplied",
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      assert.deepEqual(unhandled, [], "an observer rejection escaped as unhandled");
    });
  }
});

describe("cancellation and timeout forwarding (issue #315)", () => {
  function capturing(decision: PreFlightDecision): {
    seen: PreFlightCheckOptions[];
    interceptor: PreFlightInterceptor;
  } {
    const seen: PreFlightCheckOptions[] = [];
    return {
      seen,
      interceptor: {
        check: async (_call: ContractCall, options?: PreFlightCheckOptions) => {
          seen.push(options ?? {});
          return decision;
        },
        checkBatch: async (calls: readonly ContractCall[], options?: PreFlightCheckOptions) => {
          seen.push(options ?? {});
          return {
            admissible: decision.allowed,
            overallAdmissible: decision.allowed,
            verdicts: calls.map(() => decision),
            calls: calls.map(() => decision),
            totalEstimatedResourceFee: 0n,
          };
        },
      } as unknown as PreFlightInterceptor,
    };
  }

  for (const adapter of HARNESSES) {
    it(`${adapter.name}: forwards signal and timeoutMs to the pre-flight check`, async () => {
      const controller = new AbortController();
      const { seen, interceptor } = capturing(ADMISSIBLE);
      const outcome = await adapter.run(SCENARIOS[0]!, {}, {
        interceptor,
        signal: controller.signal,
        timeoutMs: 250,
      });

      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.signal, controller.signal);
      assert.equal(seen[0]!.timeoutMs, 250);
      assert.equal(outcome.entered, 1);
    });

    it(`${adapter.name}: a pre-aborted signal still halts instead of running the action`, async () => {
      const controller = new AbortController();
      controller.abort();
      const signalAware = {
        check: async (_call: ContractCall, options?: PreFlightCheckOptions) =>
          options?.signal?.aborted ? UNDETERMINED : ADMISSIBLE,
      } as unknown as PreFlightInterceptor;

      const outcome = await adapter.run(SCENARIOS[0]!, {}, {
        interceptor: signalAware,
        signal: controller.signal,
      });
      assert.equal(outcome.entered, 0, "an aborted pre-flight check still executed the handler");
      assert.equal(outcome.halted, true);
    });
  }

  it("MCP: the host invocation signal from `extra` takes precedence", async () => {
    const host = new AbortController();
    const configured = new AbortController();
    const { seen, interceptor } = capturing(ADMISSIBLE);
    const mcp = HARNESSES.find((candidate) => candidate.name === "mcp")!;
    await mcp.run(SCENARIOS[0]!, {}, {
      interceptor,
      signal: configured.signal,
      hostSignal: host.signal,
    });
    assert.equal(seen[0]!.signal, host.signal);
  });

  it("LangChain: a request-supplied signal takes precedence", async () => {
    const host = new AbortController();
    const configured = new AbortController();
    const { seen, interceptor } = capturing(ADMISSIBLE);
    const langchain = HARNESSES.find((candidate) => candidate.name === "langchain")!;
    await langchain.run(SCENARIOS[0]!, {}, {
      interceptor,
      signal: configured.signal,
      hostSignal: host.signal,
    });
    assert.equal(seen[0]!.signal, host.signal);
  });

  it("rejects a malformed signal or timeout at construction time", async () => {
    const { createLangChainGuardMiddleware: create } = await import(
      "../../src/adapters/langchain.ts"
    );
    assert.throws(
      () =>
        create({
          interceptor: stub(ADMISSIBLE),
          toContractCall: () => null,
          signal: { aborted: "no" } as unknown as AbortSignal,
        }),
      /signal/,
    );
    assert.throws(
      () =>
        create({
          interceptor: stub(ADMISSIBLE),
          toContractCall: () => null,
          timeoutMs: -1,
        }),
      /timeoutMs/,
    );
  });
});

describe("framework-specific refusal shapes stay distinct (issue #317)", () => {
  it("LangChain returns a ToolMessage with status error", async () => {
    const langchain = HARNESSES.find((candidate) => candidate.name === "langchain")!;
    const outcome = await langchain.run(SCENARIOS[1]!, {});
    assert.match(outcome.refusal, /per_tx_cap_exceeded/);
    assert.match(outcome.refusal, /No transaction was submitted/);
  });

  it("ElizaOS returns false and reports the reason through onBlocked", async () => {
    const elizaos = HARNESSES.find((candidate) => candidate.name === "elizaos")!;
    const { observer, blocked } = observing();
    const outcome = await elizaos.run(SCENARIOS[1]!, observer);
    assert.equal(outcome.halted, true);
    assert.equal(blocked[0]!.reason, "per_tx_cap_exceeded");
  });

  it("MCP returns an isError result naming the reason", async () => {
    const result = (await guardMcpToolHandler("send_payment", async () => ({ content: [] }), {
      interceptor: stub(BLOCKED),
      toContractCall: () => CALL,
    })({}, undefined)) as { isError?: boolean; content: Array<{ text?: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text!, /per_tx_cap_exceeded/);
  });

  it("Vercel AI throws the typed guard error for a blocked verdict", async () => {
    const vercelai = HARNESSES.find((candidate) => candidate.name === "vercelai")!;
    const outcome = await vercelai.run(SCENARIOS[1]!, {});
    assert.match(outcome.refusal, /stellar-agent-guard blocked/);
    await assert.rejects(
      async () => {
        const tool = wrapToolWithGuard(
          { execute: async () => "sent" },
          { interceptor: stub(BLOCKED), toContractCall: () => CALL },
          { toolName: "send_payment", input: {} },
        );
        await tool.execute!();
      },
      (error: unknown) => error instanceof GuardBlockedError,
    );
    await assert.rejects(
      async () => {
        const tool = wrapToolWithGuard(
          { execute: async () => "sent" },
          { interceptor: stub(UNDETERMINED), toContractCall: () => CALL },
          { toolName: "send_payment", input: {} },
        );
        await tool.execute!();
      },
      (error: unknown) => error instanceof PreFlightUndeterminedError,
    );
  });
});
