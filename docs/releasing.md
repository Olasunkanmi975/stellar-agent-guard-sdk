# Releasing

How a version of `stellar-agent-guard-sdk` goes from `main` to the npm registry.
`0.1.0` was published before this process existed; its history is recorded in
[`docs/publishing-history.md`](publishing-history.md). Everything after it
follows this document.

## Versioning policy

This package follows [semver](https://semver.org/), with the 0.x interpretation
npm users actually rely on:

> **During 0.x, a minor release may contain breaking changes** — `0.2.0` may
> break `0.1.x` callers. Patch releases (`0.x.Z`) are fixes only. `1.0.0` is the
> promise that breaking changes move to major bumps.

Until `1.0.0`, the minor version is the compatibility boundary; pin your
dependency range accordingly (for example `"~0.2.0"`). Within any minor series
(such as `0.1.x`), the SDK guarantees an **additive-only** contract: existing
exports, types, and behavioral contracts keep working across patches without
breaking changes. For full details on the deprecation lifecycle, TS-native
JSDoc warnings, runtime logger channels, and the tracking table, see
[`docs/deprecations.md`](deprecations.md).

## Who releases

Publishing is a maintainer-only operation. It requires the `NPM_TOKEN`
repository secret and npm two-factor auth / an automation token configured on
the maintainer's npm account — **setup that lives outside this repo** and is a
prerequisite, not something this checklist can create. If you are not the
maintainer, stop after the gates below and open an issue.

## Pre-flight gates (any contributor can run these)

Run all of these on the exact commit that will be tagged; every one must pass:

```bash
npm ci                 # clean install, lockfile is the source of truth
npm run typecheck
npm run lint
npm test               # unit suite
npm run build
npm run test:exports   # packed tarball resolves every advertised export
npm run test:pack      # packed tarball ships dist + metadata only (issue #49)
npm run test:packed-install # clean production-only consumer installs the tarball
```

Checklist:

- [ ] All gates green on the release commit (not "green yesterday").
- [ ] The exact packed artifact has a recorded SHA-256 digest. Verify it locally
      against the tarball that will be published:

      ```bash
      mkdir -p /tmp/sags-release-pack
      npm pack --ignore-scripts --pack-destination /tmp/sags-release-pack
      sha256sum /tmp/sags-release-pack/stellar-agent-guard-sdk-*.tgz
      ```

      The publish workflow records the same digest in the run summary and as the
      `release-artifact-integrity` workflow artifact, then publishes that exact
      tarball. The digest contains no credentials or secret material.
- [ ] Live-testnet evidence is fresh for the enforcement path: if the release
      contains changes to `src/tx.ts`, `src/invoke.ts`, `src/policy.ts`, or
      `src/preflight.ts`, a run of `npm run test:integration` with evidence in
      [`tests/fixtures/integration-evidence.md`](../tests/fixtures/integration-evidence.md)
      must already be merged, and the CI run on the release commit must include
      the `enforcement-path evidence gate` passing. Link the CI run of the
      release commit in the release notes.
- [ ] API deprecations and removals verified: if releasing a minor bump (e.g.,
      `0.2.0`), verify any removed exports were announced with `@deprecated`
      for at least one minor cycle per [`docs/deprecations.md`](deprecations.md)
      and update the deprecation tracking table. If releasing a patch (`0.x.Z`),
      confirm changes are additive-only (or carry the mandatory
      `[SECURITY OVERRIDE]` callout).
- [ ] Release notes match the changelog: `[Unreleased]` in
      [`CHANGELOG.md`](../CHANGELOG.md) was moved under this version's heading (with
      the date), and the GitHub Release body drafted from
      [`RELEASE_TEMPLATE.md`](../.github/RELEASE_TEMPLATE.md) agrees with it — the
      changelog is the cross-version source, the release body the per-tag record
      (issue #6 decided "yes"; executed in issue #81).
- [ ] `package.json` version bumped with the command, not by hand:

  ```bash
  npm version minor   # 0.x with breaking changes, or new features
  npm version patch   # fixes only
  ```

  This creates the `v<version>` commit and tag in one step. Push them:

  ```bash
  git push origin main --follow-tags
  ```

## Publish (maintainer)

Pushing a `v*` tag triggers [`publish.yml`](../.github/workflows/publish.yml):
it re-runs typecheck, lint, unit tests, verifies the tag matches
`package.json`, then runs `npm publish --access public` with `NPM_TOKEN`. The
two-person note: publishing is deliberately bottlenecked on the maintainer's
npm 2FA/automation-token setup — a second person cannot publish without it, and
that credential is **outside this repo** by design. Do not work around a missing
token with an alternate secret name.

## Post-publish verification

```bash
npm view stellar-agent-guard-sdk version   # must print the tag's version
npm view stellar-agent-guard-sdk dist.tarball
npm view stellar-agent-guard-sdk files     # spot-check the published set
```

Then smoke-install in a scratch directory:

```bash
mkdir /tmp/sags-smoke && cd /tmp/sags-smoke && npm init -y >/dev/null
npm install stellar-agent-guard-sdk
node -e "import('stellar-agent-guard-sdk').then(m => console.log('OK', Object.keys(m).length, 'exports'))"
```

If any step disagrees with the tag, **do not delete the version on npm** —
publish a patch. Deletion breaks consumers whose lockfiles reference the
tarball.

## 0.x breaking-change communication

Because 0.x minors may break, every minor release's notes must open with a
**Breaking changes** section (or state "none") and, for each break, the old
shape, the new shape, and the one-line migration. The README's
"Typed errors and 0.1.x migration" section is the model. If an urgent
verdict-correctness fix required a breaking change in a patch release, it must
be designated with the `[SECURITY OVERRIDE]` callout defined in
[`docs/deprecations.md`](deprecations.md).
