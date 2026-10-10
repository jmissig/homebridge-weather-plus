# Upstream cherry-picks

This fork selectively incorporates upstream fixes needed for Tempest and its
shared HomeKit paths. Check this ledger before importing the same changes again.

## Current upstream baseline

Rebased onto [`v3.5.0-beta.2`](https://github.com/naofireblade/homebridge-weather-plus/releases/tag/v3.5.0-beta.2)
(`b699f6852492fc11058e7e7ed969d664e3a1acdf`) on 2026-10-09. Fork version:
`3.5.0-beta.2.jmissig.1`.

- PRs #327 and #331 below are now included in the upstream base. Their fork-local
  regression tests and provenance remain; their functional patches are not
  reapplied over the upstream equivalents.
- Upstream also includes the fork's UDP recovery/hardening via PR #332
  (`9cbdbcf`) and weather-formulas compatibility via PR #314 (`0600bfb`).
  Retain the fork's extended Tempest constructor arguments in the UDP test harness
  and run that suite as part of `verify:tempest`.
- Preserve the fork's Tempest fault filtering, state/forecast fixes, opt-in JSONL
  output, locked dependency updates, CI, and explicit npm packaging exclusions.
- The historical commit IDs below refer to the pre-rebase history.

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

## PR #331 — Eve temperature units

- Source: [naofireblade/homebridge-weather-plus#331](https://github.com/naofireblade/homebridge-weather-plus/pull/331)
  by 7onnie; incorporated 2026-09-29, after committing #327 as `8831bd9`.
- Reviewed PR head/source commit: `84d8357ffd01c0db7f7827f34aa440ce19afca25`.
- Integration: applied the complete functional diff. Dew point, minimum,
  apparent and wet-bulb temperatures use Fahrenheit only at the Eve custom
  characteristic write site for imperial/US units. Native HomeKit
  CurrentTemperature writes remain Celsius. No version bump.
- Regression coverage: actual platform write paths for current/forecast,
  eve/eve2/home/both, all seven supported unit aliases, negative/zero/positive
  temperatures, hidden values and unchanged non-temperature values. The test
  reproduced the Celsius-under-Fahrenheit-label failure before applying the fix.
  Wet bulb remains Eve-only; this PR does not add a native Home compatibility
  service for it.
- Verification: `npm ci`, `npm test`, `npm pack --dry-run`. Offline stubs
  verify write routing; live Homebridge/Eve presentation is not tested.
