#!/usr/bin/env node
/**
 * Clean-consumer check for the packed SDK (issue #329).
 *
 * The consumer is created outside the repository, has no workspace links and
 * installs the tarball with production dependencies only. It then checks the
 * root ESM surface, a framework adapter export, and a TypeScript invocation
 * path against the declarations shipped in that tarball.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = process.cwd();

class PackedInstallFailure extends Error {}

function fail(message: string): never {
  throw new PackedInstallFailure(message);
}

function npm(args: string[], cwd: string): string {
  return execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }) as string;
}

function run(): void {
  const workDir = mkdtempSync(join(tmpdir(), "stellar-agent-guard-packed-install-"));
  try {
    const packDir = join(workDir, "pack");
    const consumerDir = join(workDir, "consumer");
    mkdirSync(packDir);
    mkdirSync(consumerDir);

    const packed = JSON.parse(
      npm(["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], ROOT),
    ) as Array<{ filename?: string }> | Record<string, { filename?: string }>;
    const result = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
    const filename = result?.filename;
    if (!filename) fail("npm pack produced no tarball");
    const tarball = join(packDir, filename);

    writeFileSync(
      join(consumerDir, "package.json"),
      JSON.stringify({ name: "stellar-agent-guard-clean-consumer", private: true, type: "module" }, null, 2),
    );
    npm(["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumerDir);

    const runtimeCheck = [
      `const sdk = await import(${JSON.stringify("stellar-agent-guard-sdk")});`,
      'for (const name of ["invoke", "createLangChainGuardMiddleware", "policyToJson", "decodePolicyJson"]) {',
      '  if (typeof sdk[name] !== "function") throw new Error("missing packed export: " + name);',
      "}",
      'console.log("packed root ESM and adapter exports resolved");',
    ].join("\n");
    writeFileSync(join(consumerDir, "runtime-check.mjs"), runtimeCheck);
    execFileSync(process.execPath, ["runtime-check.mjs"], { cwd: consumerDir, stdio: "inherit" });

    writeFileSync(
      join(consumerDir, "typed-invocation.ts"),
      [
        'import { invoke, unsafeContractAddress } from "stellar-agent-guard-sdk";',
        'import type { ContractCall, InvokeParams } from "stellar-agent-guard-sdk";',
        "const call: ContractCall = {",
        '  contract: unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44"),',
        '  fn: "transfer",',
        "  args: [],",
        "};",
        'const typed: Pick<InvokeParams, "call" | "networkPassphrase"> = { call, networkPassphrase: "test" };',
        "const typedInvoke: typeof invoke = invoke;",
        "void typed;",
        "void typedInvoke;",
      ].join("\n") + "\n",
    );
    const tsc = resolve(ROOT, "node_modules/typescript/bin/tsc");
    if (!existsSync(tsc)) fail(`TypeScript compiler not found at ${tsc}; run npm ci first`);
    execFileSync(
      process.execPath,
      [
        tsc,
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2023",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "typed-invocation.ts",
      ],
      { cwd: consumerDir, stdio: "inherit" },
    );
    console.log("packed install check OK: production-only consumer imported and typechecked the SDK tarball");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

try {
  run();
} catch (error) {
  if (error instanceof PackedInstallFailure) {
    console.error(`packed install check FAILED: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
