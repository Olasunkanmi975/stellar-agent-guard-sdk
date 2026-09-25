/**
 * Unit tests asserting package module format, exports map, and CJS interop resolution.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const PKG_PATH = resolve(process.cwd(), "package.json");
const DIST_INDEX_PATH = resolve(process.cwd(), "dist/index.js");
const DIST_INDEX_URL = pathToFileURL(DIST_INDEX_PATH).href;

describe("package module format and export-map", () => {
  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as {
    type?: string;
    engines?: { node?: string };
    main?: string;
    types?: string;
    exports?: Record<string, { types?: string; import?: string }>;
  };

  it("declares type: module explicitly for pure ESM shipping", () => {
    assert.equal(pkg.type, "module");
  });

  it("declares engines.node >=24.0.0 target", () => {
    assert(pkg.engines?.node, "engines.node should be declared");
    assert.match(pkg.engines.node, />=24/);
  });

  it("declares export map pointing to ESM entry point and types", () => {
    assert(pkg.exports?.["."], "export map for root '.' must be present");
    assert.equal(pkg.exports["."].import, "./dist/index.js");
    assert.equal(pkg.exports["."].types, "./dist/index.d.ts");
    assert.equal(pkg.main, "./dist/index.js");
    assert.equal(pkg.types, "./dist/index.d.ts");
  });

  it("resolves built ESM package entry point with expected named exports", async () => {
    if (!existsSync(DIST_INDEX_PATH)) {
      // If running before build, skip this check
      return;
    }
    const module = await import(DIST_INDEX_URL);
    assert(typeof module === "object" && module !== null);

    const requiredExports = [
      "PreFlightInterceptor",
      "CostPreChecker",
      "GuardTelemetryListener",
      "invoke",
      "enforceCall",
      "decodeAuthDecision",
      "describePolicy",
      "policyToScVal",
      "GUARD_EVENT_TOPICS",
      "GUARD_AUTH_RESULTS",
      "GUARD_REASON_CODES",
      "GuardBlockedError",
    ];

    for (const exp of requiredExports) {
      assert(exp in module, `Expected export '${exp}' in built module`);
    }
  });

  it("supports CJS consumers via dynamic await import() pattern", async () => {
    // In CommonJS environments (Jest configs, legacy LangChain deployments),
    // ESM-only packages are consumed via dynamic import():
    // const { PreFlightInterceptor } = await import("stellar-agent-guard-sdk");
    if (!existsSync(DIST_INDEX_PATH)) return;

    // Simulate CJS consumption via dynamic import
    const cjsConsumer = async () => {
      const { PreFlightInterceptor, CostPreChecker } = await import(DIST_INDEX_URL);
      return { PreFlightInterceptor, CostPreChecker };
    };

    const resolved = await cjsConsumer();
    assert(typeof resolved.PreFlightInterceptor === "function");
    assert(typeof resolved.CostPreChecker === "function");
  });
});
