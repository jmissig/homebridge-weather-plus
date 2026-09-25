# Repository Guidance

## Fork scope

This fork exists to keep the WeatherFlow Tempest integration working. Weather Plus supports several other weather providers, but they are inherited upstream functionality rather than a maintenance goal for this fork.

- Prioritize the Tempest flow when choosing fixes, tests, dependency updates, and compatibility work.
- Avoid expanding or refactoring other provider integrations unless a Tempest change requires shared infrastructure work or an obvious regression must be prevented.
- The main Tempest implementation is in `apis/weatherflow.js`. Its current-observation path consumes local UDP broadcasts, while its optional forecast path uses WeatherFlow's remote API with a personal access token and station ID.
- JSONL observation output is a Tempest-only, opt-in feature and must remain disabled by default. Custom output locations must be absolute paths.
- Tempest configuration and service selection also touch `index.js`, `config.schema.json`, and the Tempest section of `README.md`.

## Official WeatherFlow Tempest references

- [API and developer platform overview](https://weatherflow.github.io/Tempest/api/)
- [REST API reference](https://weatherflow.github.io/Tempest/api/swagger/)
- [UDP reference](https://weatherflow.github.io/Tempest/api/udp.html) — local broadcasts use UDP port 50222; `obs_st` and `device_status` are the key Tempest message types used by this fork.
- [WebSocket reference](https://weatherflow.github.io/Tempest/api/ws.html) — not currently used, but part of the official remote API surface.
- [Derived metric formulas](https://weatherflow.github.io/Tempest/api/derived-metric-formulas.html)
- [Remote data access policy](https://weatherflow.github.io/Tempest/api/remote-developer-policy.html)

## Verification

- Run `npm ci`, `npm test`, and `npm pack --dry-run` after dependency updates and after changes to the Tempest integration. `npm test` includes the Homebridge characteristic-permissions test and `npm run verify`.
- The verification suite uses representative WeatherFlow payloads locally; it must not require a live station, open UDP port 50222, or make network requests.
- Treat a valid Tempest observation producing zero derived values as a failure. Dependency API changes must fail verification visibly rather than silently degrading HomeKit output.

## Dependency maintenance

- Dependabot is the sole dependency updater. Do not reintroduce scheduled `npm update` PR workflows, another dependency bot, or automatic merging/publishing.
- Routine updates run Saturdays at 09:00 `America/Los_Angeles`: npm minor/patch updates group as `npm-compatible`, npm majors stay individual, and GitHub Actions versions group as `github-actions`. Limits are two npm and one Actions open version-update PRs.
- Security updates use separate `npm-security` and `github-actions-security` groups. Keep repository Dependabot alerts/security updates enabled; security updates are advisory-triggered, independent of the weekly schedule and version-update PR limits.
- Preserve the existing Node/Homebridge engine declarations and manual release process. Automation-only changes do not warrant a version bump.
- See [contributor guidance](CONTRIBUTING.md) for clean-checkout verification, packaging, and update-review expectations.
