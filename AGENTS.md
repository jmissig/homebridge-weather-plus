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

- Run `npm run verify` after dependency updates and after changes to the Tempest integration.
- The verification suite uses representative WeatherFlow payloads locally; it must not require a live station, open UDP port 50222, or make network requests.
- Treat a valid Tempest observation producing zero derived values as a failure. Dependency API changes must fail verification visibly rather than silently degrading HomeKit output.
