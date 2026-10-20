# Runtime and bundler support matrix

This page states what the package actually **executes** in CI, not what its
TypeScript happens to compile against. A type-check is not runtime evidence: a
Node-only import, a CJS-style `require`, or a bundler that ignores the export map
each fail somewhere a `tsc --noEmit` run cannot see. Every `Supported` row below
names the fixture that proves it and the CI step that runs that fixture.

<!-- runtime-matrix:start -->

| Status | Target | Gate |
| --- | --- | --- |
| Supported | Node.js `>=24` (the `engines.node` floor), ESM `import` of the root entry | `npm run test:smoke`, `npm run test:exports` |
| Supported | Node.js `>=24`, `await import("stellar-agent-guard-sdk")` from a CommonJS file | `npm run test:exports` |
| Supported | Browser bundlers that honour the package `exports` map for an ESM-only root entry (esbuild is the executed bundler; any other ESM bundler is a shape claim, not an executed one) | `npm run test:browser`, `npm run check:bundle-size` |
| Supported | Packed-tarball consumer: install the published file set and import/typecheck only the public surface | `npm run test:packed-install`, `npm run test:types:packed`, `npm run test:pack` |
| Unsupported | Node.js `<24` — `engines.node` excludes it, and the test suite's own runtime is 24 | – |
| Unsupported | CommonJS `require("stellar-agent-guard-sdk")` — no `require` export condition exists; use `await import()` instead | – |
| Unsupported | Deno, Bun, and other non-Node ESM hosts — not executed anywhere in CI | – |
| Unsupported | Edge/serverless runtimes whose bundler rewrites or forbids `node:` built-ins (Cloudflare Workers, Vercel Edge) — the root entry is browser-safe, but no edge runtime is exercised | – |
| Unsupported | React Native / Hermes — no fixture, no executed target | – |

<!-- runtime-matrix:end -->

## What each row means

**Node 24+, ESM only.** `package.json` declares `"type": "module"`,
`"engines": { "node": ">=24" }`, and a single root export with `types` and
`import` conditions. The published `main` is ESM. This is the one runtime the
whole suite runs on: `npm run typecheck`, `npm test`, and the smoke/export-map
steps in `.github/workflows/ci.yml` all execute on Node 24.

**`await import()` from CommonJS.** CJS files can consume the package through
dynamic `import()`, which is asserted in `tests/unit/exports.test.ts`. That is
interop with an ESM package, not a CJS build: there is no `dist/index.cjs`, no
`require` condition, and a bare `require("stellar-agent-guard-sdk")` fails.

**Browser.** `scripts/check-browser-entry.mjs` bundles the **built** root entry
for a browser target with no `node:*` externals, so a Node-only import reachable
from the root entry fails CI instead of failing in a consumer's bundler.
`scripts/check-bundle-size.mjs` then bounds the shipped client-side weight. The
claim is deliberately narrower than "works in browsers": esbuild is the executed
bundler, and a framework-based target (Next.js, Vite, webpack) is expected to
work because it resolves the same `exports` map — but it is not run here, so it
is not claimed as tested.

**Packed tarball.** `npm run test:packed-install`, `npm run test:types:packed`,
and `npm run test:pack` install the tarball into a temporary consumer and prove
the published file set, the export-map resolution, and the shipped declarations.
A source-tree type-check cannot see a missing or mis-pathed declaration in the
published package.

## Unsupported, stated plainly

- **No CJS build.** `require(...)` is not supported. Use `await import(...)`.
- **No Node <24.** The package declares the floor and does not test below it.
- **No Deno, Bun, or edge runtime fixture.** Nothing in CI executes them, so no
  support is claimed even where the code would probably work.
- **No React Native / Hermes.** Same reason: untested means unsupported.

## Fixtures

| Claim | Fixture |
| --- | --- |
| Node 24 ESM import, named exports present | `scripts/run-tests.ts` (unit suite) + the `test:smoke` script in `package.json` |
| CommonJS interop via dynamic `import()` | `tests/unit/exports.test.ts` |
| Browser-safe root entry | `scripts/check-browser-entry.mjs` |
| Browser bundle weight | `scripts/check-bundle-size.mjs` |
| Packed tarball install/import/typecheck | `scripts/check-packed-install.ts`, `scripts/check-packed-types.ts`, `scripts/check-pack-contents.ts` |

None of these fixtures depends on a runtime framework (no Next.js, no Vite, no
test-runner plugin): each is a plain Node script or `node --test` file, so the
matrix does not grow a framework dependency just to prove the package loads.

## How this matrix changes

The matrix is a claim about executed tests, so it changes only when a test
changes.

### Node.js upgrade (for example 24 → 26)

1. Bump `engines.node` in `package.json` and the `node-version` in every
   `.github/workflows/*.yml` job.
2. Raise the minimum in the `Node.js >=24` rows of this table.
3. Run the full offline gates locally on the new major: `npm run typecheck`,
   `npm run lint`, `npm test`, `npm run test:browser`, `npm run test:pack`.
4. Drop the old major from the table only after it is no longer the CI runtime;
   if it stays supported, add a second matrix axis in CI rather than claiming it
   from a single run.
5. `tests/unit/runtime-support.test.ts` fails if this table and `package.json`
   disagree on the floor, or if a listed gate is not a real script that CI runs.

### `@stellar/stellar-sdk` upgrade

The dependency (`^17.0.1`) is the only runtime dependency, and it is where the
node/browser boundary can move.

1. Bump the dependency and run `npm ci` so the lockfile records it.
2. Re-run the browser gate (`npm run test:browser`) first: a new transitive
   `node:*` import shows up here as a bundle error, not as a type error.
3. Re-run `npm run test:pack` / `npm run test:types:packed` to confirm the
   shipped declaration set still resolves against the new types.
4. If the SDK drops a Node major or changes its own export conditions, re-derive
   the Node rows from the new `engines` field rather than leaving this table
   stale — the guard test checks the floor, not the dependency's.
5. Record the change in `CHANGELOG.md`; an unsupported target becoming supported
   (or the reverse) is a consumer-visible change.

### Adding a new claimed target

Add a fixture first, then a row. A row without an executed gate is exactly the
claim this document exists to prevent, and
`tests/unit/runtime-support.test.ts` rejects a `Supported` row whose gate is not
a real, CI-run `npm run` script.
