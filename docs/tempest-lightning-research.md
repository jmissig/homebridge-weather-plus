# Tempest lightning research

[Questions about Tempest lightning data (UDP vs cloud vs NEA)](https://community.tempest.earth/t/questions-about-tempest-lightning-data-after-capturing-a-thunderstorm-udp-vs-cloud-vs-nea/28324)

Occasionally check this thread to see whether any questions have been answered; the answers could be useful for homebridge-weather-plus.

## Check — 2026-10-09

Checked live Discourse topic JSON and GitHub PR/release APIs, not just search caches.

### Progress in linked implementation work

- [pyweatherflowudp #203](https://github.com/natekspencer/pyweatherflowudp/pull/203)
  reports WeatherFlow support confirming that lightning-energy bit 24 is a firmware
  bug and may be ignored. The exact affected Tempest-versus-hub firmware remains
  unclear from the support account. The library now clears only that bit;
  [1.7.0](https://github.com/natekspencer/pyweatherflowudp/releases/tag/1.7.0)
  shipped the fix on October 8 UTC.
- [Home Assistant #185579](https://github.com/home-assistant/core/pull/185579)
  was opened October 9 PDT to adopt 1.7.0; still open at this check.
- [pyweatherflowudp #201](https://github.com/natekspencer/pyweatherflowudp/pull/201)
  merged and shipped in [1.6.3](https://github.com/natekspencer/pyweatherflowudp/releases/tag/1.6.3)
  on September 30 UTC. Single-event distance 63 is treated as unavailable/out of
  range, and average distance is unavailable when the interval has zero strikes.
  Its documentation distinguishes estimated storm-front distance from distance to
  an individual strike.

### Thread status and unresolved questions

- The main thread above still has six visible posts, last posted September 28.
  No new public WeatherFlow answer there. The author's captured example shows
  out-of-range 63 included in the device's precomputed average (63 and 8 → 36).
  Neither library fix repairs an already contaminated per-minute average.
- No new replies in [UDP sensor_status 655871](https://community.tempest.earth/t/udp-sensor-status-655871/23807)
  (last April 11, 2025) or [Sensor Status bits?](https://community.tempest.earth/t/sensor-status-bits/23272)
  (last March 26, 2026).
- Still unresolved in the checked sources: persistent lightning-disturber flag
  semantics, cloud distance 42, missing/qualified cloud strikes, energy's physical
  units, and precise meanings of undocumented status bits. The older linked
  [lightning-count thread](https://community.tempest.earth/t/lightning-count-bug/14128)
  returned HTTP 404, so its current content could not be checked.

### Relevance to this fork

The current adapter does not consume `evt_strike` or expose strike energy, so the
energy correction is not a patch we currently need. It does copy `obs_st`/`obs_air`
lightning counts and average distances into its current report and JSONL output.
A future normalization change should distinguish no-strike/unavailable distance
from a real zero, preserve raw-versus-derived provenance, and not pretend a
precomputed average can be repaired without sufficient event data. No runtime
code changed during this check; no new basis to change lightning fault filtering.
