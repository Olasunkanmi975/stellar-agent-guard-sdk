/**
 * Consistency guard for the runtime/bundler support matrix (issue #326).
 *
 * `docs/runtime-support.md` claims only what CI executes, so this test holds the
 * document to that promise mechanically:
 *
 * - every `Supported` row names at least one `npm run <script>` gate;
 * - each named gate is a real `package.json` script **and** is actually invoked
 *   by `.github/workflows/ci.yml` — a documented claim with no CI step behind it
 *   is exactly what the issue exists to prevent;
 * - the Node floor in the document matches `engines.node`, and the ESM-only
 *   claim matches the export map (no `require` condition);
 * - every fixture path named in the matrix exists on disk.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const ROOT = process.cwd();
const DOC = resolve(ROOT, "docs/runtime-support.md");
const PKG = resolve(ROOT, "package.json");
const CI = resolve(ROOT, ".github/workflows/ci.yml");

interface Row {
  status: string;
  target: string;
  gate: string;
}

/** The matrix rows between the markers, parsed cell by cell. */
function matrixRows(markdown: string): Row[] {
  const start = markdown.indexOf("<!-- runtime-matrix:start -->");
  const end = markdown.indexOf("<!-- runtime-matrix:end -->");
  assert.ok(start !== -1 && end > start, "the matrix markers must be present");
  return markdown
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
    .slice(1) // header row
    .map((line) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      assert.equal(cells.length, 3, `expected three columns in: ${line}`);
      return { status: cells[0]!, target: cells[1]!, gate: cells[2]! };
    });
}

/** `npm run x` script names referenced in a cell. */
function gatesIn(cell: string): string[] {
  return [...cell.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)].map((match) => match[1]!);
}

describe("runtime support matrix (issue #326)", () => {
  const markdown = readFileSync(DOC, "utf8");
  const pkg = JSON.parse(readFileSync(PKG, "utf8")) as {
    type?: string;
    engines?: { node?: string };
    scripts?: Record<string, string>;
    exports?: Record<string, { types?: string; import?: string; require?: string }>;
  };
  const ci = readFileSync(CI, "utf8");
  const rows = matrixRows(markdown);

  it("classifies every row as supported or unsupported with a stated target", () => {
    assert.ok(rows.length >= 4, "the matrix must cover more than a single target");
    for (const row of rows) {
      assert.match(row.status, /^(Supported|Unsupported)$/, `unexpected status: ${row.status}`);
      assert.ok(row.target.length > 0, "every row names a target");
    }
    assert.ok(rows.some((row) => row.status === "Supported"), "at least one tested target");
    assert.ok(rows.some((row) => row.status === "Unsupported"), "unsupported targets are stated");
  });

  it("gives every supported target a real, CI-executed gate", () => {
    for (const row of rows.filter((candidate) => candidate.status === "Supported")) {
      const gates = gatesIn(row.gate);
      assert.ok(gates.length > 0, `supported target has no \`npm run\` gate: ${row.target}`);
      for (const gate of gates) {
        assert.ok(pkg.scripts?.[gate], `documented gate is not a package.json script: ${gate}`);
        assert.match(
          ci,
          new RegExp(`run: npm run ${gate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`),
          `documented gate is not executed by CI: ${gate}`,
        );
      }
    }
  });

  it("keeps the Node floor and ESM-only claim aligned with package.json", () => {
    const floor = pkg.engines?.node;
    assert.ok(floor, "engines.node must be declared");
    assert.match(floor!, />=\s*24/);
    assert.ok(markdown.includes("`>=24`"), "the matrix states the same Node floor");
    assert.equal(pkg.type, "module", "the ESM-only claim depends on type: module");
    assert.equal(pkg.exports?.["."]?.require, undefined, "no CJS condition may be claimed");
    assert.match(markdown, /CommonJS `require\("stellar-agent-guard-sdk"\)`/);
  });

  it("references only fixtures that exist", () => {
    const paths = [
      ...markdown.matchAll(/`((?:scripts|tests)\/[^`]+)`/g),
    ].map((match) => match[1]!);
    assert.ok(paths.length > 0, "the fixture table must name its fixtures");
    for (const path of new Set(paths)) {
      assert.ok(existsSync(resolve(ROOT, path)), `fixture named but missing: ${path}`);
    }
  });

  it("documents how the matrix changes on Node and stellar-sdk upgrades", () => {
    assert.match(markdown, /### Node\.js upgrade/);
    assert.match(markdown, /### `@stellar\/stellar-sdk` upgrade/);
  });
});
