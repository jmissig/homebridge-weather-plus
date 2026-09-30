# Upstream cherry-picks

This fork selectively incorporates pending upstream PRs needed for Tempest and
its shared HomeKit paths. These are adapted/squashed cherry-picks, not upstream
merges. Check this ledger before importing the same changes again.

## PR #327 — General fixes

- Source: [naofireblade/homebridge-weather-plus#327](https://github.com/naofireblade/homebridge-weather-plus/pull/327)
  by dacarson; incorporated 2026-09-29.
- Reviewed PR head: `120aa503adbe9839920dd8a00bea42cedec5b4fa`.
- Functional source commits:
  - `d499d57fcbaa0582acfe9907bd2b629d7ab83967`: ES6 EveWeatherService.
  - `ccefda798d50bc6b0c1907db16857a56a73a0f2e`: fakegato-history minimum 0.6.7.
  - `822aa7dcdc242da6806241062dfb988ecc8f5394`: Eve pressure/light history.
  - `4f86fc9888489c6227da24f3cf9a5759b1f5a723`: full-precision raw hPa history and last-value fallback.
  - `bd131a32f7ec964baf041b4b1f49f220efcc90ba`: boolean condition-detail configuration.
- Integration: applied the final combined functional diff, preserving the fork's
  Tempest configuration. Raised the manifest/lockfile root dependency floor to
  `^0.6.7`; the resolved fakegato version was already 0.6.7. Omitted the
  changelog-only trailing newline; no plugin version bump.
- Regression coverage: actual platform configuration/history/write paths with
  offline HAP stubs, Tempest simple/detailed categories, Eve class construction,
  raw-pressure precision and missing-reading fallback, and guarded lux history.
- Verification: `npm ci`, `npm test`, `npm pack --dry-run`.
