/**
 * Consistency guard for the SDK attack-surface inventory (issue #330).
 *
 * The inventory is only useful if a reviewer can trust its citations. This test
 * enforces the two properties that rot first:
 *
 * - every cited `src/`, `tests/`, or `scripts/` path exists;
 * - every boundary section cites at least one test, so "the tests enforce this"
 *   cannot be claimed without naming one.
 *
 * It deliberately does not re-check the prose: the document is an inventory of
 * entry points, and `docs/check-doc-links.ts` already fails any broken relative
 * link out of it.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const ROOT = process.cwd();
const DOC = resolve(ROOT, "docs/attack-surface.md");
const markdown = readFileSync(DOC, "utf8");

/** Sections that carry no boundary of their own. */
const NON_BOUNDARY = new Set(["SDK attack-surface inventory", "Summary", "Review and update procedure"]);

/** Resolve every backticked repository path cited in the document. */
function citedPaths(text: string): string[] {
  return [...text.matchAll(/`((?:src|tests|scripts)\/[A-Za-z0-9_./-]+)`/g)].map(
    (match) => match[1]!,
  );
}

/** Split the document into `## <heading>` sections, keeping the body. */
function sections(text: string): { heading: string; body: string }[] {
  const start = text.indexOf("\n## ");
  assert.notEqual(start, -1, "the inventory must have boundary sections");
  return text
    .slice(start + 1)
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const newline = chunk.indexOf("\n");
      return {
        heading: chunk.slice(0, newline).trim(),
        body: chunk.slice(newline + 1),
      };
    });
}

describe("SDK attack-surface inventory (issue #330)", () => {
  it("covers signing, simulation, policy, telemetry, logs, adapters, and supply chain", () => {
    const headings = sections(markdown).map((section) => section.heading.toLowerCase());
    const required = [
      "signer callbacks",
      "agent signing and auth digests",
      "simulation and pre-flight verdicts",
      "policy validation and decoding",
      "rpc event data",
      "telemetry outputs",
      "logs",
      "framework adapters",
      "supply chain",
    ];
    for (const name of required) {
      assert.ok(headings.includes(name), `missing boundary section: ${name}`);
    }
  });

  it("cites only files that exist", () => {
    const paths = citedPaths(markdown);
    assert.ok(paths.length >= 15, "the inventory must cite its implementing code and tests");
    for (const path of new Set(paths)) {
      assert.ok(existsSync(resolve(ROOT, path)), `cited path does not exist: ${path}`);
    }
  });

  it("names at least one test per boundary", () => {
    for (const section of sections(markdown)) {
      if (NON_BOUNDARY.has(section.heading)) continue;
      const tests = citedPaths(section.body).filter((path) => path.startsWith("tests/"));
      assert.ok(
        tests.length > 0,
        `boundary "${section.heading}" claims enforcement without naming a test`,
      );
    }
  });

  it("states a fail-closed behaviour and a secret rule per boundary", () => {
    for (const section of sections(markdown)) {
      if (NON_BOUNDARY.has(section.heading)) continue;
      assert.match(section.body, /\|\s*Fail-closed behaviour\s*\|/, `no fail-closed row: ${section.heading}`);
      assert.match(section.body, /\|\s*Secret rule\s*\|/, `no secret rule row: ${section.heading}`);
    }
  });

  it("points at the threat model instead of duplicating it", () => {
    assert.match(markdown, /\(\.\/threat-model\.md\)/);
    assert.match(markdown, /inventory, not a threat model/);
  });

  it("documents an update procedure", () => {
    const review = sections(markdown).find(
      (section) => section.heading === "Review and update procedure",
    );
    assert.ok(review, "the inventory needs a review/update procedure");
    assert.match(review!.body, /dangling path/, "the procedure must point at the enforcing test");
  });
});
