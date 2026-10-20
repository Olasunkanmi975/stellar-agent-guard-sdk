/**
 * Unit tests for optional logger injection (issue #121).
 *
 * Two properties matter more than the log lines themselves, and both are pinned
 * here:
 *
 *  1. **Silence is the default.** A library that prints pollutes whatever
 *     logging pipeline its host runs. The audit guard at the bottom of this file
 *     is the exhaustive half of that claim — no `src/` file calls a console
 *     method or writes to stdout/stderr — and the `check → blocked` cycle below
 *     is the behavioural half: with no logger, a complete decision produces no
 *     output anywhere.
 *  2. **A logger is advisory.** It cannot change an outcome, and a sink that
 *     throws cannot break a pipeline stage — the same isolation `onStep` and
 *     `onGap` have.
 *
 * The audit in `docs/`/PR terms: one `console.*` call existed before this change
 * (`invoke.ts`, env-gated by `SAG_DEBUG_RESOURCES=1`). It is gone, and its
 * description now goes to an injected logger.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  Account,
  Address,
  Keypair,
  nativeToScVal,
  rpc,
  SorobanDataBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { CostPreChecker } from "../../src/cost.ts";
import { invoke, InvokeRetryError } from "../../src/invoke.ts";
import {
  GUARD_LOG_LEVELS,
  SILENT_LOGGER,
  resolveLogger,
  type GuardLogMeta,
  type GuardLoggerInput,
} from "../../src/logger.ts";
import { unsafeContractAddress } from "../../src/policy.ts";
import { PreFlightInterceptor } from "../../src/preflight.ts";
import { GuardTelemetryListener } from "../../src/telemetry.ts";

const GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
const TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const RECIPIENT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";
const PASSPHRASE = "Test SDF Network ; September 2015";

/** A recorder standing in for a host's logger, with no output of its own. */
function recorder() {
  const lines: Array<{ level: string; message: string; meta: GuardLogMeta | undefined }> = [];
  const logger: GuardLoggerInput = {};
  for (const level of GUARD_LOG_LEVELS) {
    logger[level] = (message: string, meta?: GuardLogMeta) => {
      lines.push({ level, message, meta });
    };
  }
  return {
    lines,
    messages: () => lines.map((line) => line.message),
    logger,
    at(level: string) {
      return lines.filter((line) => line.level === level);
    },
  };
}

function transferCall() {
  return {
    contract: TOKEN,
    fn: "transfer",
    args: [
      new Address(GUARD).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(100n, { type: "i128" }),
    ],
  };
}

/** A successful simulation response that asks for the guard's authorization. */
function probeSuccess(): unknown {
  return {
    minResourceFee: "100",
    transactionData: new SorobanDataBuilder().build().toXDR(),
    result: {
      auth: [
        new xdr.SorobanAuthorizationEntry({
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
            new xdr.SorobanAddressCredentials({
              address: new Address(GUARD).toScAddress(),
              nonce: BigInt(1),
              signatureExpirationLedger: 1,
              signature: xdr.ScVal.scvBytes(new Uint8Array(0)),
            }),
          ),
          rootInvocation: new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({
                contractAddress: new Address(TOKEN).toScAddress(),
                functionName: "transfer",
                args: [],
              }),
            ),
            subInvocations: [],
          }),
        }),
      ],
    },
  };
}

/** A guard refusal on the enforced simulation, in the contract's own vocabulary. */
function blockedEnforcement(): unknown {
  return {
    error: "blocked",
    events: [
      {
        event: {
          contractId: GUARD,
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
 * A post-inclusion stale-ledger rejection, copied from the recorded real failure
 * that motivated the bounded retry (`tests/unit/invoke.test.ts`).
 */
const staleRejection = (): unknown => ({
  status: "FAILED",
  hash: "1".repeat(64),
  errorResult: null,
  resultXdr: "AAAAAAAAURj/////AAAAAQAAAAAAAAAY/////QAAAAA=",
  diagnosticEventsXdr: [
    {
      body: {
        v0: {
          topics: ["error", { type: "system", code: 5, value: "scecExceededLimit" }],
          data: ["operation byte-write resources exceeds amount specified", "724", "652"],
        },
      },
    },
  ],
});

/**
 * A minimal `rpc.Server` stand-in. Odd simulations are the discovery probe, even
 * ones the enforced run — the same parity the real pipeline drives.
 */
function mockServer(options: { enforced?: () => unknown; send?: () => unknown } = {}) {
  let simulations = 0;
  let sends = 0;
  const server = {
    get simulations() {
      return simulations;
    },
    get sends() {
      return sends;
    },
    async getAccount() {
      return new Account(Keypair.random().publicKey(), "100");
    },
    async getLatestLedger() {
      return { sequence: 1000 };
    },
    async simulateTransaction() {
      const call = ++simulations;
      if (call % 2 === 0 && options.enforced) return options.enforced();
      return probeSuccess();
    },
    async sendTransaction() {
      sends += 1;
      if (options.send) return options.send();
      return { status: "PENDING", hash: "0".repeat(64) };
    },
    async getTransaction(): Promise<unknown> {
      return { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 42 };
    },
  };
  return server;
}

function blockingInterceptor(logger?: GuardLoggerInput) {
  const server = mockServer({ enforced: blockedEnforcement });
  return new PreFlightInterceptor({
    server: server as unknown as rpc.Server,
    networkPassphrase: PASSPHRASE,
    guard: GUARD,
    agent: Keypair.random(),
    source: Keypair.random(),
    ...(logger ? { logger } : {}),
  });
}

describe("resolveLogger", () => {
  it("returns the shared silent logger when none is supplied", () => {
    assert.equal(resolveLogger(), SILENT_LOGGER);
    assert.equal(resolveLogger(null), SILENT_LOGGER);
    assert.equal(resolveLogger(undefined), SILENT_LOGGER);
  });

  it("never throws from a silent logger", () => {
    for (const level of GUARD_LOG_LEVELS) {
      assert.doesNotThrow(() => SILENT_LOGGER[level]("nothing to say"));
    }
  });

  it("delivers the message, the structured detail, and the host's own receiver", () => {
    const seen: Array<{ message: string; meta: GuardLogMeta | undefined }> = [];
    const host = {
      prefix: "agent-7",
      debug(message: string, meta?: GuardLogMeta) {
        // `this` must survive: real loggers (pino, winston) are bound to their
        // instance, and a detached call would break them at runtime only.
        seen.push({ message: `${this.prefix}: ${message}`, meta });
      },
    };
    const logger = resolveLogger(host);
    logger.debug("retrying", { attempt: 1 });

    assert.deepEqual(seen, [{ message: "agent-7: retrying", meta: { attempt: 1 } }]);
  });

  it("redacts private keys, signer output, caller arguments, and raw payloads from metadata", () => {
    const seen: GuardLogMeta[] = [];
    const original: GuardLogMeta = {
      safe: "kept",
      privateKey: "private-key",
      signerOutput: "signature",
      rawPayload: { xdr: "payload" },
      call: { contract: GUARD, fn: "transfer", args: ["caller-data"] },
      nested: { visible: true, diagnosticEvents: [{ secret: "event" }] },
    };
    const logger = resolveLogger({ debug: (_message, meta) => meta && seen.push(meta) });

    logger.debug("diagnostics", original);

    assert.deepEqual(seen, [
      {
        safe: "kept",
        call: { contract: GUARD, fn: "transfer" },
        nested: { visible: true },
      },
    ]);
    assert.equal(original.privateKey, "private-key", "redaction must not mutate caller metadata");
  });

  it("drops levels the host did not implement instead of routing them elsewhere", () => {
    const seen: string[] = [];
    const logger = resolveLogger({ warn: (message) => seen.push(message) });

    assert.doesNotThrow(() => {
      logger.debug("debug");
      logger.info("info");
      logger.warn("warn");
      logger.error("error");
    });
    assert.deepEqual(seen, ["warn"]);
  });

  it("isolates a throwing sink on every level, so a broken logger cannot decide an outcome", () => {
    const logger = resolveLogger({
      debug: () => {
        throw new Error("debug sink is down");
      },
      info: () => {
        throw new Error("info sink is down");
      },
      warn: () => {
        throw new Error("warn sink is down");
      },
      error: () => {
        throw new Error("error sink is down");
      },
    });

    for (const level of GUARD_LOG_LEVELS) {
      assert.doesNotThrow(() => logger[level]("must not escape"));
    }
  });
});

describe("silent by default", () => {
  it("writes nothing anywhere across a full check → blocked cycle", async () => {
    // Method: the console methods are replaced with recorders and both
    // `process.stdout.write` and `process.stderr.write` are wrapped, so a direct
    // stream write would be caught as well as a console call. Nothing is piped
    // at the process level, which keeps the capture from also swallowing the
    // test runner's own output.
    const consoleCalls: string[] = [];
    const streamWrites: string[] = [];
    const consoleProbe = console as unknown as Record<string, (...args: unknown[]) => void>;
    const originals = new Map<string, (...args: unknown[]) => void>();
    for (const level of ["log", "debug", "info", "warn", "error", "trace"]) {
      originals.set(level, consoleProbe[level] as (...args: unknown[]) => void);
      consoleProbe[level] = (..._args: unknown[]) => {
        consoleCalls.push(level);
      };
    }
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: unknown) => {
      streamWrites.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      streamWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    let kind: string;
    try {
      // A real decision, through the real pipeline: probe → sign → enforced
      // simulation, ending in the guard's own per-tx cap refusal.
      const decision = await blockingInterceptor().check(transferCall());
      kind = decision.kind;
    } finally {
      for (const [level, original] of originals) consoleProbe[level] = original;
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    }

    assert.equal(kind, "blocked", "the cycle under test must actually reach a verdict");
    assert.deepEqual(consoleCalls, [], "no console method may be called by the library");
    assert.deepEqual(streamWrites, [], "the library must not write to stdout or stderr");
  });
});

describe("injected logger receives the decision points", () => {
  it("reports the verdict of a blocked pre-flight check", async () => {
    const log = recorder();
    const decision = await blockingInterceptor(log.logger).check(transferCall());

    assert.equal(decision.kind, "blocked");
    const refusals = log.at("info");
    assert.equal(refusals.length, 1);
    assert.match(refusals[0]!.message, /guard refused the call \(per_tx_cap_exceeded\)/);
    assert.equal(refusals[0]!.meta?.["reason"], "per_tx_cap_exceeded");
  });

  it("reports each pipeline stage attempt at debug level", async () => {
    const log = recorder();
    await blockingInterceptor(log.logger).check(transferCall());

    const stages = log
      .at("debug")
      .map((line) => line.meta?.["step"])
      .filter((step) => typeof step === "string");
    assert.ok(stages.includes("probe"), "the probe stage is reported");
    assert.ok(stages.includes("sign"), "the signing stage is reported");
    assert.ok(stages.includes("simulate"), "the enforced simulation is reported");
  });

  it("reports a cache hit as a distinct decision from a fresh simulation", async () => {
    const log = recorder();
    const interceptor = new PreFlightInterceptor({
      server: mockServer({ enforced: blockedEnforcement }) as unknown as rpc.Server,
      networkPassphrase: PASSPHRASE,
      guard: GUARD,
      agent: Keypair.random(),
      source: Keypair.random(),
      cache: { ttlMs: 1_000 },
      logger: log.logger,
    });

    await interceptor.check(transferCall());
    await interceptor.check(transferCall());

    assert.equal(log.messages().filter((message) => message === "pre-flight verdict cached").length, 1);
    const hits = log.messages().filter((message) => message === "pre-flight verdict served from cache");
    assert.equal(hits.length, 1, "the second identical check is the one served from cache");
  });

  it("reports a stale-ledger retry and then the exhausted budget", async () => {
    const log = recorder();
    const server = mockServer({ send: () => ({ status: "PENDING", hash: "tx" }) });
    server.getTransaction = async () => staleRejection();

    const outcome = await invoke({
      server: server as unknown as rpc.Server,
      source: Keypair.random(),
      call: transferCall(),
      networkPassphrase: PASSPHRASE,
      guardAuth: { guard: GUARD, agent: Keypair.random() },
      pollAttempts: 1,
      pollIntervalMs: 0,
      retry: { maxAttempts: 2, sleep: async () => {}, random: () => 0.5 },
      logger: log.logger,
    });

    assert.ok(outcome instanceof InvokeRetryError);
    const retries = log.at("debug").filter((line) => line.message.startsWith("retrying invoke"));
    assert.equal(retries.length, 1, "one retry, one line");
    assert.deepEqual(retries[0]!.meta, {
      attempt: 1,
      maxAttempts: 2,
      retryable: "stale_ledger_resource_limit",
      delayMs: 50,
    });

    const exhausted = log.at("warn");
    assert.equal(exhausted.length, 1);
    assert.match(exhausted[0]!.message, /retry budget exhausted after 2 attempt\(s\)/);
    // A failure that is about to be retried is not also reported as terminal:
    // one failure, one line.
    assert.equal(log.messages().filter((message) => message.startsWith("invoke ended without a verdict")).length, 0);
  });

  it("reports telemetry pages, dropped events and a coverage gap", async () => {
    const log = recorder();
    const page = {
      events: [
        {
          contractId: GUARD,
          type: "contract",
          ledger: 500,
          ledgerClosedAt: "2026-09-27T00:00:00Z",
          txHash: "ab".repeat(32),
          topic: ["event_auth_checked", "allowed", ""].map((topic) => xdr.ScVal.scvSymbol(topic)),
          value: xdr.ScVal.scvMap([]),
        },
        {
          // A topic this SDK version does not know: coverage the listener cannot
          // interpret, which is exactly why it is counted rather than ignored.
          contractId: GUARD,
          type: "contract",
          ledger: 500,
          ledgerClosedAt: "2026-09-27T00:00:00Z",
          txHash: "cd".repeat(32),
          topic: [xdr.ScVal.scvSymbol("event_not_in_this_version")],
          value: xdr.ScVal.scvMap([]),
        },
      ],
      cursor: "cursor_1",
      latestLedger: 600,
      oldestLedger: 500,
    };
    const server = {
      getLatestLedger: async () => ({ sequence: 600 }),
      getEvents: async () => page,
    };
    const listener = new GuardTelemetryListener({
      server: server as unknown as rpc.Server,
      guard: GUARD,
      logger: log.logger,
    });

    const polled = await listener.poll({ startLedger: 100 });
    assert.equal(polled.events.length, 1);

    const pages = log.at("debug").filter((line) => line.message === "telemetry page received");
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.meta?.["events"], 1);
    assert.equal(pages[0]!.meta?.["dropped"], 1, "an uninterpretable event is counted, not silently ignored");
    assert.equal(pages[0]!.meta?.["oldestLedger"], 500);

    // The same response also proves a gap (expected 100, retained from 500) on
    // the watch loop, which reports it through the logger as well as `onGap`.
    const controller = new AbortController();
    const gaps: unknown[] = [];
    for await (const _batch of listener.watch({
      startLedger: 100,
      onGap: (gap) => gaps.push(gap),
      sleep: async () => controller.abort(),
      signal: controller.signal,
    })) {
      // Drain: the assertion is about the notice, not the stream.
    }
    assert.equal(gaps.length, 1);
    const gapWarnings = log.at("warn").filter((line) => line.message.startsWith("telemetry coverage gap"));
    assert.equal(gapWarnings.length, 1);
    assert.equal(gapWarnings[0]!.meta?.["fromLedger"], 100);
    assert.equal(gapWarnings[0]!.meta?.["toLedger"], 499);
  });

  it("reports an over-budget price at warn level", async () => {
    const log = recorder();
    const checker = new CostPreChecker({
      interceptor: {
        check: async () => ({
          allowed: true as const,
          kind: "admissible" as const,
          estimatedResourceFee: 10_000n,
          footprintKeys: 3,
        }),
      },
      maxFeeStroops: 100n,
      logger: log.logger,
    });

    const cost = await checker.check(transferCall());
    assert.equal(cost.kind, "over_budget");
    const warnings = log.at("warn");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /exceeds the fee ceiling/);
    // 10,000 stroops of resources plus the SDK's 100-stroop inclusion floor.
    assert.equal(warnings[0]!.meta?.["totalFeeStroops"], "10100");
  });

  it("isolates a resource description that cannot be rendered", async () => {
    const log = recorder();
    const server = mockServer({
      // A simulation whose footprint is not parseable XDR. Rendering the debug
      // description throws on it, and that must not become the call's failure:
      // the description is only ever asked for because a sink was attached.
      enforced: () => ({ minResourceFee: "100", transactionData: "not-xdr", result: { auth: [] } }),
    });

    const outcome = await invoke({
      server: server as unknown as rpc.Server,
      source: Keypair.random(),
      call: transferCall(),
      networkPassphrase: PASSPHRASE,
      guardAuth: { guard: GUARD, agent: Keypair.random() },
      logger: log.logger,
    });

    // The pipeline still reaches its own verdict — the malformed footprint
    // fails it at assembly, which is a different (and correctly reported) thing
    // from a description that could not be rendered.
    assert.equal(outcome.kind, "error");
    assert.equal(
      log.messages().filter((message) => message.endsWith("(resource description unavailable)")).length,
      1,
    );
  });

  it("does not change the outcome when the logger throws", async () => {
    const decision = await blockingInterceptor({
      debug: () => {
        throw new Error("sink down");
      },
      info: () => {
        throw new Error("sink down");
      },
      warn: () => {
        throw new Error("sink down");
      },
      error: () => {
        throw new Error("sink down");
      },
    }).check(transferCall());

    assert.equal(decision.kind, "blocked");
    assert.equal(decision.reason, "per_tx_cap_exceeded");
  });
});

/**
 * The exhaustive half of "silent by default" (issue #121's audit criterion).
 *
 * A behavioural test can only catch the output a test happens to exercise; this
 * one reads every source file, so a `console.log` added anywhere in `src/` fails
 * `npm test` rather than surfacing in a host's log stream. Only `src/` is
 * scanned: scripts, examples and tests are host-facing programs and may print
 * whatever they like.
 */
describe("library-side output audit", () => {
  const SRC = resolve(process.cwd(), "src");
  const FORBIDDEN = ["console.", "process.stdout", "process.stderr"];

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(path));
      else if (entry.name.endsWith(".ts")) out.push(path);
    }
    return out;
  }

  it("finds no console call and no direct stdout/stderr write anywhere in src/", () => {
    const files = sourceFiles(SRC);
    assert.ok(files.length > 10, `expected to scan the real source tree, found ${files.length} file(s)`);

    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const needle of FORBIDDEN) {
          if (line.includes(needle)) {
            offenders.push(`${file.replace(process.cwd(), ".")}:${index + 1}: ${line.trim()}`);
          }
        }
      });
    }

    assert.deepEqual(
      offenders,
      [],
      `src/ must not write output itself — route it through the injected logger:\n${offenders.join("\n")}`,
    );
  });
});
