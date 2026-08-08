# TODO

Fork-local maintenance work for keeping the WeatherFlow Tempest integration current as Homebridge, Node.js, dependencies, and related APIs evolve.

## Compatibility maintenance

- [ ] Replace the inherited `node-persist` dependency with a maintained, minimal storage implementation.
  - Homebridge/HAP-NodeJS removed `node-persist` in Homebridge 2.3.0 because it is no longer maintained.
  - Preserve the existing Tempest current-report and hourly rain-accumulation state across upgrades, or provide a safe migration path.
  - Keep the optional Tempest JSONL observation output independent from the state-storage implementation.
  - Verify the Tempest UDP and forecast contracts on the supported Node.js and Homebridge versions.
