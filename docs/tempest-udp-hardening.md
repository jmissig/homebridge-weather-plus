# Tempest UDP Listener Hardening and Test Plan

Last reviewed: 2026-08-14

## Purpose

Weather Plus receives current observations from WeatherFlow Tempest hardware through UDP broadcasts on port 50222. A UDP listener can remain bound while no longer receiving useful observations, so socket errors alone are not a sufficient health signal.

This document records:

- the reliability protections already present in the listener;
- additional hardening worth considering;
- the unit, integration, and macOS service tests that should cover the listener;
- deliberately deferred work that would add complexity without current evidence that it is needed.

It is a contributor checklist, not a requirement that every item be included in one pull request.

## Primary references

- [WeatherFlow Tempest API overview](https://weatherflow.github.io/Tempest/api/)
- [WeatherFlow Tempest UDP reference, version 171](https://weatherflow.github.io/Tempest/api/udp/v171/)
- [WeatherFlow firmware release history](https://weatherflow.github.io/Tempest/releases/firmware.html)
- [Node.js UDP/datagram socket documentation](https://nodejs.org/api/dgram.html)
- [Node.js timer documentation](https://nodejs.org/api/timers.html)
- [Node.js process timing documentation](https://nodejs.org/api/process.html#processhrtimetime)
- [Node.js test runner documentation](https://nodejs.org/api/test.html)
- [Homebridge API lifecycle documentation](https://developers.homebridge.io/homebridge/interfaces/API.html)
- [Official Homebridge plugin template](https://github.com/homebridge/homebridge-plugin-template)
- [Homebridge Node.js support policy](https://github.com/homebridge/homebridge/wiki/How-To-Update-Node.js/)
- [Apple TN3179: Understanding local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
- [Apple Daemons and Services Programming Guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/DesigningDaemons.html)
- [Apple launchd job guidance](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [TypeScript strict mode](https://www.typescriptlang.org/tsconfig/strict)
- [TypeScript `strictNullChecks`](https://www.typescriptlang.org/tsconfig/strictNullChecks.html)
- [TypeScript `noUncheckedIndexedAccess`](https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html)

## Protocol and platform facts

### WeatherFlow UDP

- The Tempest hub broadcasts local messages on UDP port 50222.
- Observation types are `obs_air`, `obs_sky`, and `obs_st`.
- Their report interval is stored at index 7, 9, or 17 respectively.
- Messages include `serial_number` and `hub_sn` but are not authenticated.
- Observation fields are positional, may contain documented `null` values, and may gain trailing fields in later protocol versions.
- WeatherFlow recommends its REST or WebSocket interfaces as the primary source of the best available data and describes UDP as an off-grid or backup interface.
- WeatherFlow firmware history includes fixes for dropped UDP packets and cases where UDP broadcasts stopped. Silence can therefore originate in the hub or network as well as in the Node process.

### Node UDP lifecycle

- `bind()` is asynchronous, although some invalid calls can throw synchronously.
- Listener lifecycle is represented by `listening`, `message`, `error`, and `close` events.
- `close(callback)` runs the callback after the socket has closed.
- With `reuseAddr: true`, multiple sockets may bind the address, but Node documents that only one socket can receive the datagrams. Listener generations must not overlap.
- A bound socket and referenced timers keep the Node event loop alive by default.
- Timer callbacks are approximate; Node does not guarantee their exact firing time or ordering.

### Homebridge and macOS lifecycle

- Homebridge exposes both `didFinishLaunching` and `shutdown` events.
- A macOS LaunchDaemon runs in the system context and independently of GUI login sessions.
- A LaunchAgent runs in a per-user context and has different login/logout and Local Network privacy behavior.
- Apple says receiving UDP broadcasts is a Local Network operation. It also says launchd daemons are automatically allowed, while launchd agents are not covered by that exception.
- `launchd` sends `SIGTERM` during job or system shutdown and expects a daemon to unwind promptly.

## Protections already implemented

The listener currently includes these appropriate protections:

- A freshness watchdog based on valid observation messages rather than arbitrary UDP traffic.
- A 15-minute minimum stale threshold.
- A longer threshold when three times the observation's advertised report interval exceeds 15 minutes.
- A one-minute watchdog check that compares elapsed time rather than counting missed packets.
- Serialized listener replacement: the old socket closes before a replacement is created.
- One pending restart at a time.
- Socket-error retry delays of 30 seconds, 2 minutes, and 10 minutes, capped at 10 minutes.
- Backoff reset only after a valid observation proves recovery.
- Generation checks that ignore events from replaced sockets.
- Deterministic fake-clock and fake-socket lifecycle tests.

These behaviors should remain small and explicit. A full general-purpose connection state machine is not currently necessary.

## Recommended hardening

### 1. Intentional shutdown and disposal

Add an idempotent disposal path to the Tempest adapter and invoke it from Homebridge's `shutdown` event.

Disposal should:

- mark the listener as intentionally shutting down;
- clear the watchdog interval;
- clear any pending restart timeout;
- close the current socket once;
- prevent `error` and `close` handlers from scheduling a replacement;
- tolerate repeated disposal calls and already-closed sockets.

Calling `unref()` on background timers can be an additional safeguard, but it does not replace explicit cleanup. The socket must still be closed.

### 2. Monotonic freshness time

Use a monotonic clock such as `performance.now()` or `process.hrtime()` for observation age and retry timing.

Wall-clock changes caused by time synchronization, administrator changes, or clock corrections should not:

- make a healthy listener immediately stale;
- extend a stale listener's grace period unexpectedly;
- produce negative observation ages.

Continue injecting the clock in tests.

### 3. Runtime packet validation

Treat every UDP payload as untrusted input, regardless of whether the code is JavaScript or TypeScript.

Before a packet updates weather values or proves listener health, require:

- a payload below a documented reasonable size limit;
- valid JSON;
- a plain object at the top level;
- a recognized observation `type`;
- an `obs` array containing an observation array;
- the minimum array length needed for that observation type;
- a finite, positive observation epoch;
- a finite, positive, plausible report interval;
- valid types or documented `null` values for every field that is consumed.

Protocol handling should:

- ignore unknown message types safely;
- ignore unknown trailing observation fields for forward compatibility;
- reject nonsensical report intervals rather than allowing one packet to suppress recovery for hours;
- avoid logging the entire malformed payload, especially when it is large;
- rate-limit repeated malformed-packet warnings.

Transport liveness should remain separate from downstream formula calculation. A structurally valid, intended observation may prove UDP delivery even if one derived weather calculation fails.

### 4. Station identity and foreign packets

UDP broadcast packets are not authenticated. A second WeatherFlow station, test process, or other LAN host can send the same JSON shape.

Prefer one of these policies:

1. Accept an optional configured `hub_sn` or device `serial_number`; or
2. Learn the identity from the first fully valid observation, log it, and retain it for the process lifetime.

Only a valid observation from the selected identity should:

- update current conditions;
- reset the freshness watchdog;
- reset socket-error backoff.

Do not use the source IP address as the sole durable identity because DHCP can change it. The source address from Node's `rinfo` remains useful diagnostic context.

### 5. Bounded, transition-level logging

Log lifecycle transitions rather than every packet. Useful fields are:

- listener generation;
- bound address and port;
- recovery reason;
- Node error name and `code`;
- last valid observation age;
- advertised report interval and resulting stale threshold;
- selected hub and device serials;
- sender address and port;
- cumulative listener restart count;
- successful recovery after a stale or error state.

Warnings should be emitted once per state transition. Continued silence should not produce a warning every watchdog tick.

### 6. Support-policy honesty

The repository currently declares an old Node compatibility floor while current Homebridge supports current even-numbered LTS releases. The official Homebridge template also uses a modern Node and TypeScript toolchain.

Choose one of these approaches in a separate compatibility change:

- test every declared Node version in CI, including the legacy floor; or
- remove unsupported historical versions from `engines` and test the Node versions supported by current Homebridge.

Do not combine a Node/TypeScript modernization with a narrowly scoped UDP recovery pull request.

## Unit and fault-injection tests

Keep deterministic fake-clock and fake-socket tests for lifecycle races.

### Freshness behavior

- Five, ten, and fourteen minutes of silence do not restart a normal one-minute station.
- The exact 15-minute boundary schedules exactly one restart.
- A valid selected-station observation resets freshness.
- `rapid_wind`, events, status messages, malformed observations, and foreign-station observations do not reset freshness.
- A longer valid advertised report interval produces the intended three-times interval threshold.
- Missing, zero, negative, nonnumeric, and implausibly large intervals fall back safely.
- A replacement listener receives a full startup grace period.
- Delayed timer execution evaluates actual elapsed time rather than assuming one watchdog tick per minute.
- Wall-clock movement does not affect a monotonic freshness clock.

### Socket lifecycle

- Socket construction throws.
- `bind()` throws synchronously.
- Binding emits an asynchronous error such as `EADDRINUSE` or `EACCES`.
- A socket emits an unexpected `close` event.
- Duplicate errors from one generation schedule one replacement and consume one backoff slot.
- Error, close, and stale-watchdog events collide while close is pending.
- The old socket closes before the replacement binds.
- Delayed events from an old generation cannot affect the current generation.
- Repeated failure reaches and remains at the capped retry delay.
- A valid selected-station observation resets error backoff.
- Repeated recovery cycles leave one socket, one watchdog, and at most one retry timer.

### Shutdown

- Shutdown while normally listening closes the socket and clears the watchdog.
- Shutdown while a retry timeout is pending cancels the timeout.
- Shutdown while socket close is pending does not create a replacement.
- Shutdown racing with `error` or unexpected `close` remains intentional and quiet.
- Repeated disposal is harmless.
- No timer or socket owned by the adapter remains active after disposal.

### Packet parsing and identity

- Invalid JSON is rejected without a crash or unbounded log output.
- Oversized payloads are rejected before expensive processing.
- Each documented observation type accepts its minimum valid layout.
- Short arrays and wrong container types are rejected.
- Documented nullable fields are handled safely.
- Unknown trailing fields are ignored.
- Unknown message types do not affect liveness.
- A foreign hub or device cannot update state or reset liveness.
- A source-IP change for the same selected serial remains valid.
- Duplicate observations do not produce duplicate output records.

### Logging

- Each recovery transition emits one warning.
- Successful recovery is logged once.
- Duplicate errors do not duplicate the transition warning.
- Malformed-packet warnings are bounded.
- Logs contain no access token and do not dump arbitrary packet bodies.

## Real-socket integration tests

Fake sockets cannot prove all operating-system and libuv behavior. Add a small integration suite using actual Node `dgram` sockets and a configurable test port.

Verify that:

- a real UDP datagram reaches the parser;
- a valid observation resets freshness;
- closing the socket releases the port;
- the replacement binds only after the old socket closes;
- a deliberate port conflict follows the expected error/retry path;
- repeated restart cycles do not leak file descriptors;
- only the current listener generation handles messages;
- teardown leaves no socket or timer that keeps the test process alive.

The default verification suite must continue to avoid opening production port 50222 or requiring a live Tempest station.

## Homebridge integration tests

Exercise the adapter inside a minimal Homebridge test configuration:

- listener startup at the intended Homebridge lifecycle point;
- Homebridge `shutdown` invokes adapter disposal;
- a Tempest child-bridge restart exits promptly and starts one fresh listener;
- full Homebridge restart behaves the same way;
- a prolonged Tempest outage does not prevent unrelated accessories or providers from operating;
- supported Homebridge and Node version combinations start successfully.

Use Homebridge debug mode and reduce a failure to the smallest reproducible plugin configuration when investigating a regression.

## macOS deployment tests

Test the exact deployment mode. Results from an interactive Terminal command, LaunchAgent, or GUI application do not prove behavior for a system LaunchDaemon.

For the deployed LaunchDaemon and service user, test:

- Screen Sharing connection and disconnection;
- fast-user switching;
- GUI login and logout;
- operation with no GUI user logged in;
- sleep and wake;
- Ethernet or Wi-Fi down and up;
- DHCP renewal or network reconfiguration;
- router restart;
- Tempest hub restart;
- station firmware update;
- packet loss shorter than the stale threshold;
- packet loss longer than the stale threshold;
- Homebridge service stop, restart, and system shutdown.

When reproducing a stall, capture packets at the same time as Homebridge logs:

- packets visible on the interface but absent from Node point toward the host socket or runtime;
- packets absent from the interface point toward the hub or network;
- a heavily delayed watchdog points toward event-loop blockage.

Record the following incident context:

- macOS version;
- Node and Homebridge versions;
- plugin version and commit;
- launchd job type and service user;
- active network interface;
- hub and station serials;
- hub and station firmware revisions;
- last valid observation time;
- listener generation and restart count.

## Soak and regression testing

For major listener changes, run a 24- to 72-hour soak against a real station and record:

- observation gaps;
- listener restart count and reason;
- process RSS;
- file descriptor count;
- duplicate observation count;
- malformed or foreign packet count;
- recovery time after deliberate hub and network interruptions.

The soak should include at least one GUI session transition and one network or hub interruption on macOS.

## TypeScript guidance

If the adapter later migrates to TypeScript:

- parse network JSON as `unknown`;
- narrow it with runtime type guards;
- model known message types as a discriminated union;
- enable `strict`, `strictNullChecks`, and `noUncheckedIndexedAccess`;
- represent documented nullable fields explicitly;
- do not assert a parsed packet directly to a trusted message type.

Static types improve maintainability but do not replace runtime packet validation.

## Deliberately deferred complexity

Do not add these without evidence or a separate architectural decision:

- **Network-interface watchers:** observation freshness is a simpler end-to-end signal.
- **Large receive buffers:** Tempest traffic is low-volume; measure kernel drops first.
- **Permanent event-loop telemetry:** use it diagnostically if stalls continue after recovery hardening.
- **`reusePort`:** distributing datagrams between listener generations conflicts with serialized ownership and is not supported on every platform.
- **Source-IP locking:** DHCP makes it brittle; prefer Tempest serial identity.
- **Random retry jitter:** valuable for fleets retrying a shared service, but unnecessary for one local listener.
- **Cloud failover inside the listener:** WeatherFlow recommends remote interfaces, but adding REST or WebSocket failover requires credentials, source arbitration, freshness rules, and its own recovery lifecycle. Treat that as a separate feature.
- **A general-purpose connection state-machine framework:** the current listener needs only explicit ownership, freshness, restart, and disposal states.

## Recommended implementation order

1. Add disposal and Homebridge shutdown tests.
2. Use a monotonic freshness clock.
3. Strengthen runtime packet validation and bound the report interval.
4. Filter liveness and updates by selected hub/device identity.
5. Add transition-level diagnostics.
6. Add real-socket integration tests.
7. Run the macOS LaunchDaemon reproduction and soak matrix.
8. Address Node support and TypeScript modernization separately.
9. Add deeper telemetry or cloud failover only if operational evidence warrants it.
