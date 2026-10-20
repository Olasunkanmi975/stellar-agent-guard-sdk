#!/usr/bin/env node
/**
 * Shared vendoring helper: one refresh entry point for every vendored
 * cross-repo artifact this SDK keeps (issue #133).
 *
 * The SDK vendors cross-repo artifacts as committed, hash-pinned files so the
 * test suite is hermetic — no test that decides pass/fail may fetch from the
 * network at run time. Vendoring (committing a copy + provenance) is how the
 * SDK has handled the contracts repo's reason vocabulary since Phase 2
 * (`tests/fixtures/contract-fixtures.json`, refreshed by `npm run sync:fixtures`);
 * the PolicyConfig JSON schema (`tests/fixtures/vendor/policy.schema.json`) is
 * the same pattern with one more guard: the file's own SHA-256 digest is
 * recorded next to it, so a refresh that changes even a byte must update the
 * digest in the same commit — an accidental hand-edit or a truncated download
 * fails the integrity test instead of silently becoming the new truth.
 *
 * One helper, several feeds (issue #133's "sequence note"): the reason
 * vocabulary feed (`npm run sync:fixtures`) landed first and keeps its own
 * script; this module does not absorb it. It exists so the *next* vendored feed
 * does not have to reinvent the provenance shape — and so each vendor entry
 * below is one object with one `refresh` implementation, rather than a third
 * copy of the same write-and-stamp logic.
 *
 * Provenance contract (enforced by `tests/unit/policy-schema.test.ts`):
 * every vendored artifact carries a `_provenance` header with the source repo,
 * the pinned source commit, the source path, the pinned content digest, the
 * refresh command, and an explicit `upstreamLanded: false` acknowledgement
 * when vendored ahead of the upstream file's own issue landing.
 *
 * ## Refresh protocol (what happens when contracts #61 lands)
 *
 * 1. `git fetch upstream && git rev-parse upstream/main` → note the SHA.
 * 2. Update `POLICY_SCHEMA.repoCommit` below to that SHA and flip its
 *    `upstreamLanded` to `true` — in the same commit as step 4.
 * 3. `npm run vendor:refresh` → re-fetches, re-hashes, rewrites the vendored
 *    file + `digest` + `updatedAt` in one write.
 * 4. Commit the artifact and its digest together. The SDK validator's
 *    expectations re-derive from the refreshed file, so drift fails the
 *    policy-schema test rather than waiting for review to catch it.
 *
 * Usage:
 *   npm run vendor:refresh          # refresh every registered feed
 *   npm run vendor:refresh -- --dry-run
 */
import { createHash } from "node:crypto";
import { get as httpsGet } from "node:https";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** A vendored artifact: where it comes from, where it lives, how it refreshes. */
export interface VendoredArtifact {
  /** Source repo (`owner/name`). */
  sourceRepo: string;
  /** Pinned source commit — the provenance SHA recorded in the header. */
  repoCommit: string;
  /** Path inside the source repo. */
  sourcePath: string;
  /** Repo-relative destination path in this SDK. */
  outputPath: string;
  /** Has the upstream artifact's own issue landed? (contracts #61: no, yet.) */
  upstreamLanded: boolean;
  /**
   * Key the vendored content is stored under in the output document.
   *
   * Defaults to `schema`, the key the policy schema has always used. A second
   * vendored artifact picks its own key so the two never share a namespace.
   */
  contentKey?: string;
  /** The upstream issue this artifact tracks. */
  upstreamIssue?: string;
  /** Note recorded in the provenance header, describing the vendoring state. */
  note?: string;
  /** ISO timestamp recorded as the last refresh of this artifact. */
  updatedAt?: string;
}

/**
 * The canonical source of `policy.schema.json` is contracts issue #61
 * ("policy config JSON schema file for editor/tooling validation"), which has
 * **not** landed as of this vendoring. The vendored file is therefore written
 * ahead of upstream, from SPEC §8, as the SDK-side bootstrap — field-compatible
 * with what #61 is expected to land (same field names, same §8 if/then rules),
 * so the refresh protocol above is a re-fetch and a digest bump, not a rewrite.
 */
const POLICY_SCHEMA: VendoredArtifact = {
  sourceRepo: "Stellar-Agent-Guard/stellar-agent-guard-contracts",
  // Pinned ahead of upstream landing (contracts #61 open). Bump together with
  // `upstreamLanded` in the same commit when #61 merges.
  repoCommit: "18a6ba64d797e2f99a3726913213f9e6372724f0",
  sourcePath: "policy.schema.json",
  outputPath: "tests/fixtures/vendor/policy.schema.json",
  upstreamLanded: false,
};

/**
 * The canonical `auth_checked` vocabulary of the guard contract.
 *
 * The contracts repo owns the allowed path, every `Error` code and reason
 * symbol, the exact event topics and the data-map fields of the decision
 * event (contracts PR #280, issue #42). This SDK consumes that file as the
 * source of truth in its decoder tests instead of keeping a second copy of
 * the matrix here — a copy is a copy, and a copy drifts.
 */
const AUTH_CHECKED_VOCABULARY: VendoredArtifact = {
  sourceRepo: "Stellar-Agent-Guard/stellar-agent-guard-contracts",
  repoCommit: "c921063bbc90f608cbf0721e0fbb72e6183f9264",
  sourcePath: "tests/fixtures/auth-checked-vocabulary.json",
  outputPath: "tests/fixtures/vendor/auth-checked-vocabulary.json",
  upstreamLanded: true,
  contentKey: "vocabulary",
  upstreamIssue: "Stellar-Agent-Guard/stellar-agent-guard-contracts#42",
  note: "vendored copy of the landed upstream file; the SDK's decoder tests read it as the source of truth for the decision vocabulary",
  updatedAt: "2026-10-20T00:00:00.000Z",
};

/** Every registered feed. Add new vendored artifacts here. */
export const VENDORED_ARTIFACTS: readonly VendoredArtifact[] = [
  POLICY_SCHEMA,
  AUTH_CHECKED_VOCABULARY,
];

export interface VendorReport {
  artifact: VendoredArtifact;
  /** Bytes of the vendored schema content (excluding the provenance header). */
  bytes: number;
  /** SHA-256 hex digest of the schema content. */
  digest: string;
  /** Skipped because the content (and digest) is unchanged. */
  unchanged: boolean;
}

/** Stable, byte-exact provenance header for a vendored artifact. */
export function provenanceHeader(artifact: VendoredArtifact, digest: string): Record<string, unknown> {
  const contentKey = artifact.contentKey ?? "schema";
  return {
    _provenance: {
      sourceRepo: artifact.sourceRepo,
      sourceCommit: artifact.repoCommit,
      sourcePath: artifact.sourcePath,
      digest: `sha256:${digest}`,
      digestAlgorithm: `sha256 over the vendored content bytes (the \`${contentKey}\` value re-serialized)`,
      refreshCommand: "npm run vendor:refresh",
      refreshProtocol:
        "bump scripts/vendor-fixtures.ts <artifact>.repoCommit to the pinned upstream SHA, then rerun; commit artifact + digest together",
      upstreamLanded: artifact.upstreamLanded,
      upstreamIssue:
        artifact.upstreamIssue ?? "Stellar-Agent-Guard/stellar-agent-guard-contracts#61",
      note:
        artifact.note ??
        (artifact.upstreamLanded
          ? "vendored copy of the landed upstream file; refresh protocol applies on every upstream schema change"
          : "vendored ahead of upstream: written from contracts SPEC §8 pending issue #61; refresh protocol re-fetches the landed file once it exists"),
      updatedAt: artifact.updatedAt ?? "2026-09-30T00:00:00.000Z",
    },
  };
}

/** SHA-256 of the schema content, as recorded in the provenance header. */
export function contentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Canonical form of a schema's bytes: parsed, re-serialized at the vendored
 * file's indent, with the file's trailing newline. The digest is taken over
 * this form — not the raw source bytes — so the integrity test can recompute
 * it from the vendored file alone (`JSON.stringify(doc.schema, null, 2)`),
 * without needing the original upstream bytes.
 */
export function canonicalSchemaContent(content: string): string {
  return `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
}

/** Fetch the raw upstream file. Used only by the refresh script, never by tests. */
export function fetchUpstream(artifact: VendoredArtifact): Promise<string> {
  const url = `https://raw.githubusercontent.com/${artifact.sourceRepo}/${artifact.repoCommit}/${artifact.sourcePath}`;
  return new Promise((resolvePromise, reject) => {
    httpsGet(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} fetching ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject);
  });
}

/**
 * Write one vendored artifact with its provenance header. Skipped (reported as
 * unchanged) when the existing file already carries the current digest — so
 * rerunning the refresh never churns `updatedAt` without a content change.
 */
export function refreshArtifact(
  artifact: VendoredArtifact,
  rawContent: string,
  options: { dryRun?: boolean } = {},
): VendorReport {
  const canonical = canonicalSchemaContent(rawContent);
  const digest = contentDigest(canonical);
  const destination = resolve(process.cwd(), artifact.outputPath);
  let unchanged: boolean;
  try {
    const existing = JSON.parse(readFileSync(destination, "utf8")) as {
      _provenance?: { digest?: string };
    };
    unchanged = existing._provenance?.digest === `sha256:${digest}`;
  } catch {
    unchanged = false;
  }
  if (!options.dryRun && !unchanged) {
    mkdirSync(dirname(destination), { recursive: true });
    const parsed = JSON.parse(rawContent) as Record<string, unknown>;
    const contentKey = artifact.contentKey ?? "schema";
    const document = { ...provenanceHeader(artifact, digest), [contentKey]: parsed };
    writeFileSync(destination, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
  return { artifact, bytes: Buffer.byteLength(canonical, "utf8"), digest, unchanged };
}

/** Bootstrap path: vendor the spec-derived schema ahead of upstream landing. */
export function bootstrapAheadOfUpstream(
  content: string,
  options: { dryRun?: boolean } = {},
): VendorReport {
  return refreshArtifact(POLICY_SCHEMA, content, options);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  for (const artifact of VENDORED_ARTIFACTS) {
    try {
      const content = await fetchUpstream(artifact);
      const report = refreshArtifact(artifact, content, { dryRun });
      const state = report.unchanged ? "unchanged" : dryRun ? "would write" : "wrote";
      console.log(
        `[vendor] ${state} ${artifact.outputPath} (${report.bytes} bytes, sha256:${report.digest.slice(0, 12)}…)`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[vendor] could not refresh ${artifact.outputPath}: ${detail}`);
      process.exitCode = 1;
    }
  }
}

/* Run only when invoked directly, so tests can import the pure helpers. */
if (process.argv[1] && process.argv[1].endsWith("vendor-fixtures.ts")) {
  main();
}
