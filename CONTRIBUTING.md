# Contributing to this fork

The maintenance focus is WeatherFlow Tempest. See [AGENTS.md](AGENTS.md) for
scope and offline verification requirements.

## Clean-checkout verification

From a fresh checkout, using Node.js 22 or 24 (the existing CI matrix), run:

```sh
npm ci
npm test
npm pack --dry-run
```

`npm ci` installs the committed lockfile without updating dependencies.
`npm test` runs all five test files: Homebridge characteristic permissions,
weather-formulas compatibility, Tempest UDP recovery, UDP observations, and
forecasts. The tests use local fixtures/stubs, not a live station or Homebridge.

This plugin ships plain JavaScript directly. It has no compilation, generated
sources, lint script, or type-check script; there is no separate build command.
Do not add WAVE3's protobuf generation or build-toolchain changes here.
The package listing must include `index.js`, `accessories/`, `apis/`, `util/`,
`config.schema.json`, `package.json`, `README.md`, and `LICENSE`, without
`node_modules/`, credentials, or local runtime data. The existing package also
includes contributor docs, tests, changelog, and sample data; no packaging
allowlist or release-artifact policy is changed by this automation work.

The read-only Verify workflow runs on pull requests (including Dependabot),
pushes to `main`, and manual dispatch. It runs the commands above on both Node
versions with `contents: read`, no stored checkout credentials, and no secrets.
There is no bot-only approval job, privileged `pull_request_target` job,
automatic merge, or publish step. GitHub's repository-level approval rules for
outside contributors still apply.

## Dependency updates

Aligned with [WAVE3 commit 7d8eccd](https://github.com/jmissig/homebridge-ecoflow-wave3/commit/7d8eccd),
Dependabot is the only dependency PR producer:

- Both ecosystems check routine versions Saturdays at 09:00
  `America/Los_Angeles` (including daylight-saving changes).
- npm minor/patch updates group as `npm-compatible`; major upgrades remain
  individual PRs for compatibility review. At most two npm version-update PRs
  may be open.
- GitHub Actions version updates group as `github-actions`, with at most one
  open version-update PR.
- Security fixes group separately as `npm-security` and
  `github-actions-security`. Keep Dependabot alerts and security updates enabled
  in repository settings; YAML grouping does not enable those settings.
  Security updates respond to advisories, not the weekly version-update
  schedule, and are not restricted by the version-update PR limits.

The old `update-dependencies.yml` workflow is removed. Do not restore it or add
another scheduled npm updater. An already-open PR from that workflow is not
automatically closed by deleting the workflow; review or close it separately.
The goal is one updater, not exactly one PR: major upgrades, security fixes,
and Actions changes can legitimately remain separate.

Review dependency engine requirements and Tempest behavior before merging,
especially for major updates. Keep `package.json` and `package-lock.json` in
sync. Preserve the declared Node/Homebridge compatibility; the Node 22/24 CI
matrix is not a replacement for the package's engine declarations and does
not prove every historical Node/Homebridge combination works.

## Release boundaries

The fork is not published as a separate npm package; the README's fork install
path and existing manual release decisions remain unchanged. Merging dependency
or automation changes does not itself bump the plugin version or publish a
release. Do not install into or restart live Homebridge as part of CI or these
checks.

References: [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
and [Dependabot PR behavior](https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/supply-chain-security/dependabot-pull-requests).
