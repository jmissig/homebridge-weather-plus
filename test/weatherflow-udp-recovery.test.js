"use strict";

const assert = require('assert'),
	EventEmitter = require('events'),
	TempestAPI = require('../apis/weatherflow').TempestAPI,
	registerStationShutdown = require('../index').registerStationShutdown;

const MINUTE = 60 * 1000;

class FakeClock
{
	constructor()
	{
		this.time = 0;
		this.nextId = 1;
		this.timers = [];
	}

	now()
	{
		return this.time;
	}

	setTimeout(callback, delay)
	{
		return this.addTimer(callback, delay, null);
	}

	clearTimeout(id)
	{
		this.removeTimer(id);
	}

	setInterval(callback, delay)
	{
		return this.addTimer(callback, delay, delay);
	}

	clearInterval(id)
	{
		this.removeTimer(id);
	}

	addTimer(callback, delay, interval)
	{
		const timer = {
			id: this.nextId++,
			at: this.time + delay,
			callback: callback,
			interval: interval,
			cancelled: false
		};
		this.timers.push(timer);
		return timer.id;
	}

	removeTimer(id)
	{
		const timer = this.timers.find((candidate) => candidate.id === id);
		if (timer) timer.cancelled = true;
	}

	tick(duration)
	{
		const target = this.time + duration;
		while (true) {
			this.timers = this.timers.filter((timer) => !timer.cancelled);
			const dueTimers = this.timers.filter((timer) => timer.at <= target);
			if (dueTimers.length === 0) break;
			dueTimers.sort((left, right) => left.at - right.at || left.id - right.id);
			const timer = dueTimers[0];
			this.timers = this.timers.filter((candidate) => candidate !== timer);
			this.time = timer.at;
			if (timer.interval !== null && !timer.cancelled) {
				timer.at += timer.interval;
				this.timers.push(timer);
			}
			if (!timer.cancelled) timer.callback();
		}
		this.time = target;
	}
}

class FakeSocket extends EventEmitter
{
	constructor(events, deferClose = false)
	{
		super();
		this.events = events;
		this.deferClose = deferClose;
		this.boundPort = null;
		this.closeCount = 0;
		this.pendingCloseCallback = null;
	}

	bind(port)
	{
		this.boundPort = port;
		this.events.push(`bind:${port}`);
	}

	address()
	{
		return {address: '0.0.0.0', port: this.boundPort};
	}

	listen()
	{
		this.emit('listening');
	}

	close(callback)
	{
		this.closeCount++;
		this.events.push('close');
		if (this.deferClose) {
			this.pendingCloseCallback = callback;
			return;
		}
		this.finishClose(callback);
	}

	finishClose(callback = this.pendingCloseCallback)
	{
		this.pendingCloseCallback = null;
		this.emit('close');
		if (callback) callback();
	}

	message(message)
	{
		this.emit('message', Buffer.from(JSON.stringify(message)), {});
	}
}

function createLog()
{
	const entries = [];
	const log = (message) => entries.push(['info', message]);
	log.debug = (message) => entries.push(['debug', message]);
	log.warn = (message) => entries.push(['warn', message]);
	log.error = (message) => entries.push(['error', message]);
	log.entries = entries;
	return log;
}

function createHarness(options = {})
{
	const clock = new FakeClock(),
		events = [],
		sockets = [],
		storage = {
			initSync: () => {},
			getItemSync: () => undefined,
			setItemSync: () => {}
		},
		log = createLog(),
		dependencies = {
			storage: storage,
			createSocket: () => {
				const socket = new FakeSocket(events, options.deferClose === true);
				sockets.push(socket);
				return socket;
			},
			now: () => clock.now(),
			setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
			clearTimeout: (id) => clock.clearTimeout(id),
			setInterval: (callback, delay) => clock.setInterval(callback, delay),
			clearInterval: (id) => clock.clearInterval(id)
		};

	const api = new TempestAPI('', '', false, log, '/tmp/weatherflow-test', dependencies);
	return {api: api, clock: clock, events: events, log: log, sockets: sockets};
}

function tempestObservation(reportInterval)
{
	const observation = new Array(18).fill(0);
	observation[0] = 1588948614;
	observation[7] = 20;
	observation[8] = 0;
	observation[16] = 2.5;
	observation[17] = reportInterval;
	return {
		serial_number: 'ST-TEST',
		type: 'obs_st',
		hub_sn: 'HB-TEST',
		obs: [observation],
		firmware_revision: 1
	};
}

function test(name, callback)
{
	try {
		callback();
		console.log(`ok - ${name}`);
	} catch (err) {
		console.error(`not ok - ${name}`);
		throw err;
	}
}

test('waits fifteen minutes before replacing a silent listener', () => {
	const harness = createHarness();
	harness.sockets[0].listen();

	harness.clock.tick(14 * MINUTE);
	assert.strictEqual(harness.sockets.length, 1);
	assert.strictEqual(harness.sockets[0].closeCount, 0);

	harness.clock.tick(MINUTE);
	assert.strictEqual(harness.sockets[0].closeCount, 1);
	assert.strictEqual(harness.sockets.length, 2);
	assert.deepStrictEqual(harness.events.slice(-2), ['close', 'bind:50222']);
});

test('uses the advertised observation interval when it exceeds the minimum', () => {
	const harness = createHarness();
	harness.sockets[0].listen();
	harness.sockets[0].message(tempestObservation(10));
	assert.strictEqual(harness.api.observationStaleTimeout, 30 * MINUTE, JSON.stringify(harness.log.entries));

	harness.clock.tick(29 * MINUTE);
	assert.strictEqual(harness.sockets.length, 1);
	harness.clock.tick(MINUTE);
	assert.strictEqual(harness.sockets.length, 2);
});

test('a fresh observation resets the watchdog', () => {
	const harness = createHarness();
	harness.sockets[0].listen();

	harness.clock.tick(10 * MINUTE);
	harness.sockets[0].message(tempestObservation(1));
	harness.clock.tick(14 * MINUTE);
	assert.strictEqual(harness.sockets.length, 1);
	harness.clock.tick(MINUTE);
	assert.strictEqual(harness.sockets.length, 2);
});

test('a non-observation packet does not reset the watchdog', () => {
	const harness = createHarness();
	harness.sockets[0].listen();

	harness.clock.tick(10 * MINUTE);
	harness.sockets[0].message({type: 'hub_status'});
	harness.clock.tick(5 * MINUTE);
	assert.strictEqual(harness.sockets.length, 2);
});

test('socket errors schedule one serialized replacement', () => {
	const harness = createHarness();
	harness.sockets[0].listen();
	harness.sockets[0].emit('error', new Error('test failure'));
	harness.sockets[0].emit('error', new Error('duplicate failure'));

	assert.strictEqual(harness.sockets[0].closeCount, 1);
	assert.strictEqual(harness.api.udpFailureCount, 1);
	harness.clock.tick(29 * 1000);
	assert.strictEqual(harness.sockets.length, 1);
	harness.clock.tick(1000);
	assert.strictEqual(harness.sockets.length, 2);

	harness.sockets[1].emit('error', new Error('next genuine failure'));
	harness.clock.tick(119 * 1000);
	assert.strictEqual(harness.sockets.length, 2);
	harness.clock.tick(1000);
	assert.strictEqual(harness.sockets.length, 3);
});

test('unexpected close uses the same recovery path', () => {
	const harness = createHarness();
	harness.sockets[0].listen();
	harness.sockets[0].emit('close');

	harness.clock.tick(30 * 1000);
	assert.strictEqual(harness.sockets.length, 2);
});

test('repeated socket failures use capped backoff', () => {
	const harness = createHarness();
	harness.sockets[0].listen();
	harness.sockets[0].emit('error', new Error('first failure'));
	harness.clock.tick(30 * 1000);
	assert.strictEqual(harness.sockets.length, 2);

	harness.sockets[1].listen();
	harness.sockets[1].emit('error', new Error('second failure'));
	harness.clock.tick(119 * 1000);
	assert.strictEqual(harness.sockets.length, 2);
	harness.clock.tick(1000);
	assert.strictEqual(harness.sockets.length, 3);

	harness.sockets[2].listen();
	harness.sockets[2].emit('error', new Error('third failure'));
	harness.clock.tick(9 * MINUTE);
	assert.strictEqual(harness.sockets.length, 3);
	harness.clock.tick(MINUTE);
	assert.strictEqual(harness.sockets.length, 4);
});

test('a valid observation resets socket failure backoff', () => {
	const harness = createHarness();
	harness.sockets[0].listen();
	harness.sockets[0].emit('error', new Error('first failure'));
	harness.clock.tick(30 * 1000);

	harness.sockets[1].listen();
	harness.sockets[1].emit('error', new Error('second failure'));
	harness.clock.tick(2 * MINUTE);

	harness.sockets[2].listen();
	harness.sockets[2].message(tempestObservation(1));
	harness.sockets[2].emit('error', new Error('failure after recovery'));
	harness.clock.tick(29 * 1000);
	assert.strictEqual(harness.sockets.length, 3);
	harness.clock.tick(1000);
	assert.strictEqual(harness.sockets.length, 4);
});

test('a replacement gets a full grace period before another stale recovery', () => {
	const harness = createHarness();
	harness.sockets[0].listen();
	harness.clock.tick(15 * MINUTE);
	assert.strictEqual(harness.sockets.length, 2);

	harness.sockets[1].listen();
	harness.clock.tick(14 * MINUTE);
	assert.strictEqual(harness.sockets.length, 2);
	harness.clock.tick(MINUTE);
	assert.strictEqual(harness.sockets.length, 3);
});

test('dispose closes the listener and cancels the watchdog', () => {
	const harness = createHarness();
	harness.sockets[0].listen();

	harness.api.dispose();
	assert.strictEqual(harness.api.disposed, true);
	assert.strictEqual(harness.api.server, null);
	assert.strictEqual(harness.api.udpWatchdogTimer, null);
	assert.strictEqual(harness.sockets[0].closeCount, 1);

	harness.clock.tick(60 * MINUTE);
	assert.strictEqual(harness.sockets.length, 1);
});

test('dispose is idempotent', () => {
	const harness = createHarness();
	harness.sockets[0].listen();

	harness.api.dispose();
	harness.api.dispose();
	assert.strictEqual(harness.sockets[0].closeCount, 1);
});

test('dispose cancels a pending error retry', () => {
	const harness = createHarness();
	harness.sockets[0].listen();
	harness.sockets[0].emit('error', new Error('test failure'));
	assert.notStrictEqual(harness.api.udpRestartTimer, null);

	harness.api.dispose();
	assert.strictEqual(harness.api.udpRestartTimer, null);
	harness.clock.tick(10 * MINUTE);
	assert.strictEqual(harness.sockets.length, 1);
});

test('dispose while close is pending prevents a replacement', () => {
	const harness = createHarness({deferClose: true});
	harness.sockets[0].listen();
	harness.sockets[0].emit('error', new Error('test failure'));
	assert.strictEqual(harness.sockets[0].closeCount, 1);
	assert.strictEqual(harness.api.udpRestartTimer, null);

	harness.api.dispose();
	harness.sockets[0].finishClose();
	harness.clock.tick(10 * MINUTE);
	assert.strictEqual(harness.sockets[0].closeCount, 1);
	assert.strictEqual(harness.sockets.length, 1);
});

test('Homebridge shutdown disposes every disposable station', () => {
	const homebridge = new EventEmitter();
	let firstDisposeCount = 0;
	let secondDisposeCount = 0;
	registerStationShutdown(homebridge, [
		{dispose: () => firstDisposeCount++},
		{},
		{dispose: () => secondDisposeCount++}
	]);

	homebridge.emit('shutdown');
	assert.strictEqual(firstDisposeCount, 1);
	assert.strictEqual(secondDisposeCount, 1);
});
