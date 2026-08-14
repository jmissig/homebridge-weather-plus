"use strict";

/*
	Support for the WeatherFlow Tempest (and legacy) weather station.
	https://weatherflow.com
	
	Full details of the developer APIs is published here:
	https://weatherflow.github.io/Tempest/
 */

const converter = require('../util/converter'),
	moment = require('moment-timezone'),
	dgram = require("dgram"),
	fs = require("fs"),
	path = require("path"),
	performance = require("perf_hooks").performance,
	wformula = require('weather-formulas'),
	axios = require('axios');

const TEMPEST_LIGHTNING_FAULT_MASK = 0x00000007;
const OBSERVATIONS_FILENAME = "weather-observations.jsonl";
const OBSERVATION_SCHEMA = "weather.current_report.v2";
const UDP_PORT = 50222,
	UDP_MAX_DATAGRAM_SIZE = 16 * 1024,
	UDP_MAX_REPORT_INTERVAL_MINUTES = 60,
	UDP_WATCHDOG_INTERVAL = 60 * 1000,
	UDP_MIN_STALE_TIMEOUT = 15 * 60 * 1000,
	UDP_REPORT_INTERVAL_MULTIPLIER = 3,
	UDP_RETRY_DELAYS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];

let lastEmittedObservationKey = null;

function resolveObservationOutputPath(cacheDirectory, configuredPath)
{
	if (configuredPath && path.isAbsolute(configuredPath))
	{
		return configuredPath;
	}

	return path.join(cacheDirectory, OBSERVATIONS_FILENAME);
}

function isFiniteNumber(value)
{
	return typeof value === "number" && Number.isFinite(value);
}

function isFiniteInRange(value, minimum, maximum)
{
	return isFiniteNumber(value) && value >= minimum && value <= maximum;
}

function isValidEpochSeconds(value)
{
	// JavaScript Date's inclusive range is +/- 8.64e15 milliseconds.
	return isFiniteInRange(value, 1, 8.64e12);
}

function isNonNegativeInteger(value)
{
	return Number.isSafeInteger(value) && value >= 0;
}

function isIntegerInRange(value, minimum, maximum)
{
	return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isValidUdpIdentifier(value)
{
	return typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value);
}

class TempestAPI
{
	constructor (apiKey, locationId, conditionDetail, log, cacheDirectory, statusFaultFilter, observationOutputEnabled, observationOutputPath, dependencies = {})
	{
		this.attribution = 'Weatherflow Tempest';
		this.reportCharacteristics = [
			'AirPressure', // Station Pressure
			'ConditionCategory', // Precipitation Type
			'Humidity', // Relative Humidity
			'ObservationStation', // Serial Number of Hub
			'ObservationTime', // Time Epoch
			'Rain1h', // Rain Accumulated
			'RainBool', // Is it raining now
			'RainDay', // Local Day Rain Accumulation
			'SolarRadiation', // Solar Radiation
			'Temperature', // Air Temperature
			'TemperatureMin', // Minimum temperature
			'UVIndex', // UV
			'WindDirection', // Wind Direction
			'WindSpeed', // Wind Avg
			'WindSpeedMax', // Wind Gust
			'WindSpeedLull', // Wind Lull
			'LightningStrikes', // Count of lightning Strikes over last hour?
			'LightningAvgDistance', // Average distance to the lightning strikes
			'LightLevel', // Illuminance
			'BatteryLevel', // Device Battery level percent
			'BatteryIsCharging', // Device Battery charging state
			'StatusFault', // Report if there is a fault
			
			// Derived values
			// @see https://weatherflow.github.io/Tempest/api/derived-metric-formulas.html
			'DewPoint', // Calculated from Humidity & Temperature
			'TemperatureApparent', // Calculated from Humidity, Temperature & Windspeed
			'TemperatureWetBulb' // Calculated from Humidity & Temperature
		];
		
		this.forecastCharacteristics = [
			'ObservationTime', // Forecast update time
			'Condition', //Conditions
			'ConditionCategory',
			'ForecastDay', // day_num, month_num, day_start_local
			'RainBool', // precip_icon contains === 'rain' || 'sleet' || 'storm'
			'SnowBool', // precip_icon contains === 'snow'
			'SunriseTime', //sunrise
			'SunsetTime', // sunset
			'TemperatureMax',  // air_temp_high
			'TemperatureMin', // air_temp_low
			'RainChance' // precip_probability
		];
		this.forecastDays = 0;
		
		// Only define the update variable if we have an apiKey and locationId
		if (apiKey && apiKey.length > 0 && locationId && locationId.length > 0) {
			this.forecastDays = 10;
			this.lastForecastUpdate = -1;
			}
	
		this.conditionDetail = conditionDetail;
		this.log = log;
		this.apiKey = apiKey;
		this.locationId = locationId;
		this.statusFaultFilter = statusFaultFilter || "ignoreLightning";
		
		this.storage = dependencies.storage || require('node-persist');
		// The saved data is only valid for up to 24hrs (TTL)
		this.storage.initSync({dir:cacheDirectory, forgiveParseErrors: true, ttl: true});
		this.observationOutputEnabled = observationOutputEnabled === true;
		this.observationsPath = resolveObservationOutputPath(cacheDirectory, observationOutputPath);
		if (observationOutputPath && !path.isAbsolute(observationOutputPath))
		{
			this.log.warn("Tempest observation output path must be absolute; using default path %s", this.observationsPath);
		}
		this.rainAccumulation = [];
		// Fill the array with zeros so that when we sum them up, it doesn't get NaN
		for (var i = 0; i < 60; i++) this.rainAccumulation[i] = 0.0;
		this.rainAccumulationMinute = 0;
		this.hasFreshLiveStationData = false;
		this.hasFreshLiveAirData = false;
		this.hasFreshLiveSkyData = false;
		
		this.currentReport = {};
	
		// Need to initialize values because a report could be requested before
		// we have received any information from the weather station.
		this.currentReport.AirPressure = 0;
		this.currentReport.Condition = "Unknown";
		this.currentReport.ConditionCategory = 0;
		this.currentReport.Humidity = 1;
		this.currentReport.ObservationStation = "Unknown";
		this.currentReport.ObservationTime = moment().format('HH:mm:ss');
		this.currentReport.Rain1h = 0.0;
		this.currentReport.RainBool = false;
		this.currentReport.RainDay = 0.0;
		this.currentReport.SolarRadiation = 0;
		this.currentReport.Temperature = 0;
		this.currentReport.TemperatureApparent = 0;
		this.currentReport.TemperatureMin = 50;
		this.currentReport.DewPoint = 0;
		this.currentReport.UVIndex = 0;
		this.currentReport.WindDirection = converter.getWindDirection(0);
		this.currentReport.WindSpeed = 0;
		this.currentReport.WindSpeedMax = 0;
		
		// Extras
		this.currentReport.BatteryLevel = 100;
		this.currentReport.BatteryIsCharging = false;
		this.currentReport.WindSpeedLull = 0;
		this.currentReport.LightningStrikes = 0;
		this.currentReport.LightningAvgDistance = 0;
		this.currentReport.LightLevel = 0;
		this.currentReport.TemperatureWetBulb = 0;
		this.currentReport.StatusFault = 0;
		this.currentReport.ObservedAtEpoch = null;

		// Non-exposed Weather report characteristics
		// Sky or Tempest station (unlikely to have both)
		this.currentReport.SkySensorBatteryLevel = 100;
		this.currentReport.SkySerialNumber = "SK-";
		this.currentReport.SkyFirmware = "1.0";
		this.currentReport.SkySensorFailureLog = -1;
		// Air station
		this.currentReport.AirSensorBatteryLevel = 100;
		this.currentReport.AirSerialNumber = "AR-";
		this.currentReport.AirFirmware = "1.0";
		this.currentReport.AirSensorFailureLog = -1;
		this.currentReport.SensorString = "Ok";
		this.derivedValueWarnings = {};

		// Attempt to restore previous values
		this.load();
		
		// Keep track of previous message so that
		// we can remove duplicates
		this.prevMsg = "";

		this.createSocket = dependencies.createSocket || ((options) => dgram.createSocket(options));
		this.now = dependencies.now || (() => performance.now());
		this.setInterval = dependencies.setInterval || setInterval;
		this.clearInterval = dependencies.clearInterval || clearInterval;
		this.setTimeout = dependencies.setTimeout || setTimeout;
		this.clearTimeout = dependencies.clearTimeout || clearTimeout;

		this.server = null;
		this.disposed = false;
		this.lastObservationAt = null;
		this.observationStaleTimeout = UDP_MIN_STALE_TIMEOUT;
		this.udpWatchdogTimer = null;
		this.udpRestartTimer = null;
		this.udpRestartPending = false;
		this.udpClosingServer = null;
		this.udpFailureCount = 0;
		this.udpGeneration = 0;
		this.udpRestartCount = 0;
		this.udpRecovery = null;
		this.udpPacketWarnings = new Set();

		this.createUdpServer();
	}

	createUdpServer()
	{
		if (this.disposed) return;
		const generation = ++this.udpGeneration;
		this.udpPacketWarnings = new Set();

		let server;
		try {
			server = this.createSocket({type: 'udp4', reuseAddr: true});
		} catch (err) {
			this.handleUdpError(null, err, generation);
			return;
		}

		this.server = server;
		server.on('error', (err) => {
			if (!this.disposed && server === this.server) this.handleUdpError(server, err, generation);
		});

		server.on('message', (msg, rinfo) => {
			if (this.disposed || this.udpRestartPending || server !== this.server) return;
			this.handleUdpDatagram(msg, rinfo, generation);
		});

		server.on('listening', () => {
			if (this.disposed || server !== this.server) return;
			const address = server.address();
			this.lastObservationAt = this.now();
			this.startUdpWatchdog();
			this.log(`WeatherFlow UDP listener generation ${generation} listening on ${address.address}:${address.port}`);
		});

		server.on('close', () => {
			if (server !== this.server) return;
			this.server = null;
			if (!this.disposed && !this.udpRestartPending) {
				this.scheduleUdpRestart("socket closed unexpectedly", this.nextUdpRetryDelay(), {generation: generation});
			}
		});

		try {
			server.bind(UDP_PORT);
		} catch (err) {
			this.handleUdpError(server, err, generation);
		}
	}

	handleUdpDatagram(msg, rinfo, generation = this.udpGeneration)
	{
		const decoded = this.decodeUdpDatagram(msg, generation);
		if (!decoded) return;
		if (decoded.observation) {
			// Every structurally valid observation proves that the UDP path is alive,
			// even if its payload is a duplicate or cannot update weather values.
			this.recordUdpObservation(decoded.reportIntervalMinutes, decoded.message, rinfo, generation);
		}

		const rawMessage = msg.toString();
		if (rawMessage === this.prevMsg) return;
		this.prevMsg = rawMessage;

		if (!decoded.parse) {
			this.warnUdpPacket(`invalid-${decoded.message.type}`, `invalid ${decoded.message.type} data`, generation);
			return;
		}

		this.parseMessage(decoded.message);
	}

	decodeUdpDatagram(msg, generation = this.udpGeneration)
	{
		if (!Buffer.isBuffer(msg)) {
			this.warnUdpPacket("non-buffer", "payload was not a buffer", generation);
			return null;
		}
		if (msg.length > UDP_MAX_DATAGRAM_SIZE) {
			this.warnUdpPacket("oversized", `payload was ${msg.length} bytes`, generation);
			return null;
		}

		let message;
		try {
			message = JSON.parse(msg.toString("utf8"));
		} catch (err) {
			this.warnUdpPacket("malformed-json", "payload was not valid JSON", generation);
			return null;
		}

		return this.validateUdpMessage(message, generation);
	}

	validateUdpMessage(message, generation = this.udpGeneration)
	{
		if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
			this.warnUdpPacket("invalid-envelope", "message had an invalid envelope", generation);
			return null;
		}

		if (message.type === "device_status") {
			const valid = isValidUdpIdentifier(message.serial_number) &&
				isValidEpochSeconds(message.timestamp) &&
				isNonNegativeInteger(message.sensor_status);
			if (!valid) this.warnUdpPacket("invalid-device-status", "invalid device_status message", generation);
			return valid ? {message: message, observation: false, parse: true} : null;
		}

		if (message.type === "evt_precip") {
			const valid = isValidUdpIdentifier(message.serial_number) && Array.isArray(message.evt) &&
				message.evt.length >= 1 && isValidEpochSeconds(message.evt[0]);
			if (!valid) this.warnUdpPacket("invalid-evt-precip", "invalid evt_precip message", generation);
			return valid ? {message: message, observation: false, parse: true} : null;
		}

		if (message.type === "rapid_wind") {
			const valid = isValidUdpIdentifier(message.serial_number) && Array.isArray(message.ob) &&
				message.ob.length >= 3 && isValidEpochSeconds(message.ob[0]) &&
				isFiniteInRange(message.ob[1], 0, 200) && isFiniteInRange(message.ob[2], 0, 360);
			if (!valid) this.warnUdpPacket("invalid-rapid-wind", "invalid rapid_wind message", generation);
			return valid ? {message: message, observation: false, parse: true} : null;
		}

		const observationLayouts = {
			obs_air: {
				minimumLength: 7,
				reportIntervalIndex: 7,
				validValues: (values) => isFiniteInRange(values[1], 0, 2000) &&
					isFiniteInRange(values[2], -100, 100) && isFiniteInRange(values[3], 0, 100) &&
					isIntegerInRange(values[4], 0, 1000) && isFiniteInRange(values[5], 0, 1000) &&
					isFiniteInRange(values[6], 0, 10)
			},
			obs_sky: {
				minimumLength: 13,
				reportIntervalIndex: 9,
				validValues: (values) => isFiniteInRange(values[1], 0, 2000000) &&
					isFiniteInRange(values[2], 0, 100) && isFiniteInRange(values[3], 0, 1000) &&
					isFiniteInRange(values[4], 0, 200) && isFiniteInRange(values[6], 0, 200) &&
					isFiniteInRange(values[8], 0, 10) && isFiniteInRange(values[10], 0, 5000) &&
					Number.isInteger(values[12]) && isFiniteInRange(values[12], 0, 3)
			},
			obs_st: {
				minimumLength: 17,
				reportIntervalIndex: 17,
				validValues: (values) => isFiniteInRange(values[1], 0, 200) &&
					isFiniteInRange(values[2], 0, 200) && isFiniteInRange(values[3], 0, 200) &&
					isFiniteInRange(values[6], 0, 2000) && isFiniteInRange(values[7], -100, 100) &&
					isFiniteInRange(values[8], 0, 100) && isFiniteInRange(values[9], 0, 2000000) &&
					isFiniteInRange(values[10], 0, 100) && isFiniteInRange(values[11], 0, 5000) &&
					isFiniteInRange(values[12], 0, 1000) && Number.isInteger(values[13]) &&
					isFiniteInRange(values[13], 0, 3) && isFiniteInRange(values[14], 0, 1000) &&
					isIntegerInRange(values[15], 0, 1000) && isFiniteInRange(values[16], 0, 10)
			}
		};
		const layout = observationLayouts[message.type];
		if (!layout) return null;
		if (!isValidUdpIdentifier(message.serial_number) || !Array.isArray(message.obs) ||
			!Array.isArray(message.obs[0]) || message.obs[0].length < layout.minimumLength) {
			this.warnUdpPacket(`invalid-${message.type}`, `invalid ${message.type} structure`, generation);
			return null;
		}

		const observation = message.obs[0];
		if (!isValidEpochSeconds(observation[0])) {
			this.warnUdpPacket(`invalid-${message.type}`, `invalid ${message.type} observation epoch`, generation);
			return null;
		}

		const advertisedInterval = observation[layout.reportIntervalIndex];
		const reportIntervalMinutes = isFiniteNumber(advertisedInterval) && advertisedInterval > 0 &&
			advertisedInterval <= UDP_MAX_REPORT_INTERVAL_MINUTES ? advertisedInterval : null;

		return {
			message: message,
			observation: true,
			parse: layout.validValues(observation),
			reportIntervalMinutes: reportIntervalMinutes
		};
	}

	warnUdpPacket(category, detail, generation = this.udpGeneration)
	{
		if (generation !== this.udpGeneration || this.udpPacketWarnings.has(category)) return;
		this.udpPacketWarnings.add(category);
		this.log.warn(`Ignoring WeatherFlow UDP packet in generation ${generation}: ${detail}`);
	}

	formatUdpLogValue(value)
	{
		if (typeof value !== "string" || value.length === 0) return "unknown";
		return value.replace(/[\x00-\x1F\x7F,=\u2028\u2029]/g, "?").slice(0, 64);
	}

	handleUdpError(server, err, generation = this.udpGeneration)
	{
		if (this.disposed || generation !== this.udpGeneration ||
			(server && server !== this.server) || this.udpRestartPending) return;
		const errorName = err && err.name ? this.formatUdpLogValue(err.name) : "Error";
		const errorCode = err && err.code ? this.formatUdpLogValue(String(err.code)) : "unknown";
		const errorMessage = err && err.message ? this.formatUdpLogValue(err.message) : "unknown error";
		this.scheduleUdpRestart("socket error", this.nextUdpRetryDelay(), {
			generation: generation,
			errorName: errorName,
			errorCode: errorCode,
			errorMessage: errorMessage
		});
	}

	nextUdpRetryDelay()
	{
		const delayIndex = Math.min(this.udpFailureCount, UDP_RETRY_DELAYS.length - 1);
		this.udpFailureCount++;
		return UDP_RETRY_DELAYS[delayIndex];
	}

	scheduleUdpRestart(reason, delay, details = {})
	{
		if (this.disposed || this.udpRestartPending) return;
		this.udpRestartPending = true;
		this.stopUdpWatchdog();
		this.udpRestartCount++;
		const generation = details.generation || this.udpGeneration;
		this.udpRecovery = {
			reason: reason,
			fromGeneration: generation,
			restartCount: this.udpRestartCount
		};

		const server = this.server;
		const queueReplacement = () => {
			if (server === this.udpClosingServer) this.udpClosingServer = null;
			if (server === this.server) this.server = null;
			if (this.disposed) {
				this.udpRestartPending = false;
				return;
			}
			this.udpRestartTimer = this.setTimeout(() => {
				this.udpRestartTimer = null;
				this.udpRestartPending = false;
				if (!this.disposed) this.createUdpServer();
			}, delay);
		};

		const observationAge = this.lastObservationAt === null ? null : Math.max(0, this.now() - this.lastObservationAt);
		const ageDescription = observationAge === null ? "unknown" : Math.floor(observationAge / (60 * 1000));
		let warning = `WeatherFlow UDP recovery ${this.udpRestartCount} scheduled: generation=${generation}` +
			`, reason=${reason}, delaySeconds=${Math.round(delay / 1000)}` +
			`, observationAgeMinutes=${ageDescription}` +
			`, staleThresholdMinutes=${Math.round(this.observationStaleTimeout / (60 * 1000))}`;
		if (details.errorName) warning += `, error=${details.errorName}`;
		if (details.errorCode) warning += `, code=${details.errorCode}`;
		if (details.errorMessage) warning += `, message=${details.errorMessage}`;
		this.log.warn(warning);
		if (!server) {
			queueReplacement();
			return;
		}

		try {
			this.udpClosingServer = server;
			server.close(queueReplacement);
		} catch (err) {
			this.udpClosingServer = null;
			this.log.debug(`Unable to close WeatherFlow UDP server: ${err.message}`);
			queueReplacement();
		}
	}

	dispose()
	{
		if (this.disposed) return;
		this.disposed = true;
		this.stopUdpWatchdog();

		if (this.udpRestartTimer !== null) {
			this.clearTimeout(this.udpRestartTimer);
			this.udpRestartTimer = null;
		}
		this.udpRestartPending = false;

		const server = this.server;
		this.server = null;
		if (!server || server === this.udpClosingServer) return;

		try {
			server.close();
		} catch (err) {
			this.log.debug(`Unable to close WeatherFlow UDP server during shutdown: ${err.message}`);
		}
	}

	startUdpWatchdog()
	{
		if (this.disposed) return;
		this.stopUdpWatchdog();
		this.udpWatchdogTimer = this.setInterval(() => this.checkUdpFreshness(), UDP_WATCHDOG_INTERVAL);
	}

	stopUdpWatchdog()
	{
		if (this.udpWatchdogTimer !== null) {
			this.clearInterval(this.udpWatchdogTimer);
			this.udpWatchdogTimer = null;
		}
	}

	checkUdpFreshness()
	{
		if (this.disposed || this.udpRestartPending || this.lastObservationAt === null) return;
		const observationAge = this.now() - this.lastObservationAt;
		if (observationAge < this.observationStaleTimeout) return;

		const observationAgeMinutes = Math.floor(observationAge / (60 * 1000));
		this.scheduleUdpRestart(`no observations for ${observationAgeMinutes} minutes`, 0);
	}

	recordUdpObservation(reportIntervalMinutes, message, rinfo, generation = this.udpGeneration)
	{
		this.lastObservationAt = this.now();
		this.udpFailureCount = 0;
		if (Number.isFinite(reportIntervalMinutes) && reportIntervalMinutes > 0) {
			this.observationStaleTimeout = Math.max(
				UDP_MIN_STALE_TIMEOUT,
				reportIntervalMinutes * 60 * 1000 * UDP_REPORT_INTERVAL_MULTIPLIER
			);
		} else {
			this.observationStaleTimeout = UDP_MIN_STALE_TIMEOUT;
		}

		if (this.udpRecovery !== null && generation > this.udpRecovery.fromGeneration) {
			const sourceAddress = rinfo && rinfo.address ? this.formatUdpLogValue(String(rinfo.address)) : "unknown";
			const sourcePort = rinfo && Number.isFinite(rinfo.port) ? rinfo.port : "unknown";
			const type = message ? this.formatUdpLogValue(message.type) : "unknown";
			const serial = message ? this.formatUdpLogValue(message.serial_number) : "unknown";
			const hub = message ? this.formatUdpLogValue(message.hub_sn) : "unknown";
			const interval = Number.isFinite(reportIntervalMinutes) ? reportIntervalMinutes : "unknown";
			this.log(`WeatherFlow UDP listener recovered: generation=${generation}` +
				`, restart=${this.udpRecovery.restartCount}, type=${type}, serial=${serial}, hub=${hub}` +
				`, source=${sourceAddress}:${sourcePort}, reportIntervalMinutes=${interval}` +
				`, staleThresholdMinutes=${Math.round(this.observationStaleTimeout / (60 * 1000))}`);
			this.udpRecovery = null;
		}
	}

	logDerivedValueWarning(key, error)
	{
		if (!this.derivedValueWarnings[key])
		{
			this.derivedValueWarnings[key] = true;
			this.log.warn("Failed to calculate Tempest %s: %s", key, error.toString());
		}
	}

	updateDerivedValue(key, calculate)
	{
		try
		{
			const value = calculate();
			if (Number.isFinite(value))
			{
				this.currentReport[key] = value;
				delete this.derivedValueWarnings[key];
			}
		}
		catch (error)
		{
			this.logDerivedValueWarning(key, error);
		}
	}

	updateDerivedTemperatures(temperatureC, humidity, windSpeed)
	{
		this.updateDerivedValue("DewPoint", () =>
			wformula.temperature.kelvinToCelcius(wformula.temperature.dewPointMagnusFormula(
				wformula.temperature.celciusToKelvin(temperatureC),
				humidity))
		);

		this.updateDerivedValue("TemperatureApparent", () =>
			wformula.temperature.kelvinToCelcius(wformula.temperature.australianApparentTemperature(
				wformula.temperature.celciusToKelvin(temperatureC),
				humidity,
				windSpeed))
		);

		this.updateDerivedValue("TemperatureWetBulb", () =>
			converter.getWetBulbTemperature(temperatureC, humidity)
		);
	}

	getFilteredSensorStatus(sensorStatus)
	{
		switch (this.statusFaultFilter)
		{
			case "ignoreAll":
				return 0;
			case "reportAll":
				return sensorStatus;
			case "ignoreLightning":
			default:
				return sensorStatus & ~TEMPEST_LIGHTNING_FAULT_MASK;
		}
	}

	load() {
		this.log("Restoring last readings");
		this.reportCharacteristics.forEach((name) => {
			this.log.debug(`Loading ${name}`);
			let result = this.storage.getItemSync(name);
			// Only update the default value if loaded something
			if (typeof result !== 'undefined') {
					this.currentReport[name] = result;
					this.log.debug(`Loaded ${name} with ${result}`);
			}
		})
		
		// Reload last hour of rainfall
		let lastRainAccumulationMinute = this.storage.getItemSync('rainAccumulationMinute');
		if (typeof lastRainAccumulationMinute !== 'undefined') {
			this.log.debug("Restoring rain readings");
			this.rainAccumulationMinute = lastRainAccumulationMinute;
			for (var i = 0; i < 60; i++)
				this.rainAccumulation[i] = this.storage.getItemSync('rainAccumulation'+i);
		} else {
			this.log.debug("Reset rain readings");
			this.currentReport.Rain1h = 0.0;
		}
	}

	save(currentReport) {
		// Save each value of the current report
		this.reportCharacteristics.forEach((name) => {
			this.log.debug(`Persisting ${name}: ${currentReport[name]}`);
			this.storage.setItemSync(name, currentReport[name]);
		})
		
		// Store last hour rain fall
		let hourTTL = 1000 * 60 * 60; // Rainfall data is only valid for an hour.
		this.storage.setItemSync('rainAccumulationMinute', this.rainAccumulationMinute, {ttl: hourTTL});
		for (var i = 0; i < 60; i++)
			this.storage.setItemSync('rainAccumulation'+i, this.rainAccumulation[i], {ttl: hourTTL});
	}

	update(forecastDays, callback)
	{
		this.log.debug("Updating weather from Weatherflow Tempest");

		let weather = {};
		weather.forecasts = [];
		
		// Limit forecast updates to once every hour. Forecast won't change that quickly
		if ((typeof this.lastForecastUpdate !== 'undefined')  && moment().hour() != this.lastForecastUpdate) {
			this.lastForecastUpdate = moment().hour();
			this.getForecastData((error, result) =>
								 {
				if (!error) {
					try {
						weather.forecasts = this.parseForecasts(result["current_conditions"]["time"], result["forecast"]["daily"], result["timezone"]);
					} catch (e) {
						this.log.error("Error parsing weather Forecast");
						this.log.error(result);
						this.log.error(e);
					}
				} else {
					this.log.error("Error retrieving weather Forecast");
					this.log.error(result);
				}
				
				let that = this;
				weather.report = that.currentReport;
				callback(null, weather);
				
				// Save the state after updating plugin state so we don't
				// delay the update
				this.save(that.currentReport);
			});
		}
		else {
			// Don't update the forecast, just update current conditions
			let that = this;
			weather.report = that.currentReport;
			callback(null, weather);
			this.save(that.currentReport);
		}
	}

	buildObservationPayload()
	{
		return {
			schema: OBSERVATION_SCHEMA,
			observed_at_epoch: this.currentReport.ObservedAtEpoch,
			temperature_c: this.currentReport.Temperature,
			humidity_pct: this.currentReport.Humidity,
			airpressure_hpa: this.currentReport.AirPressure,
			dewpoint_c: this.currentReport.DewPoint,
			apparenttemperature_c: this.currentReport.TemperatureApparent,
			wetbulbtemperature_c: this.currentReport.TemperatureWetBulb,
			lightlevel_lux: this.currentReport.LightLevel,
			uvindex: this.currentReport.UVIndex,
			solarradiation_wm2: this.currentReport.SolarRadiation,
			windspeed_ms: this.currentReport.WindSpeed,
			windlull_ms: this.currentReport.WindSpeedLull,
			windgust_ms: this.currentReport.WindSpeedMax,
			winddirection_compass: this.currentReport.WindDirection,
			raining: this.currentReport.RainBool,
			rain1h_mm: this.currentReport.Rain1h,
			rainday_mm: this.currentReport.RainDay,
			lightningstrikes: this.currentReport.LightningStrikes,
			lightningavgdistance_km: this.currentReport.LightningAvgDistance
		};
	}

	markFreshLiveStationData(messageType)
	{
		if (messageType == 'obs_st')
		{
			this.hasFreshLiveStationData = true;
			return;
		}

		if (messageType == 'obs_air')
		{
			this.hasFreshLiveAirData = true;
		}

		if (messageType == 'obs_sky')
		{
			this.hasFreshLiveSkyData = true;
		}

		if (this.hasFreshLiveAirData && this.hasFreshLiveSkyData)
		{
			this.hasFreshLiveStationData = true;
		}
	}

	appendObservationIfNeeded(messageType)
	{
		if (!this.observationOutputEnabled)
		{
			return;
		}

		if (messageType !== 'obs_st' && messageType !== 'obs_sky')
		{
			return;
		}

		if (!this.hasFreshLiveStationData)
		{
			return;
		}

		if (messageType === 'obs_sky' && !this.hasFreshLiveAirData)
		{
			return;
		}

		const payload = this.buildObservationPayload();
		const dedupePayload = Object.assign({}, payload);
		delete dedupePayload.observed_at_epoch;

		const observationKey = JSON.stringify(dedupePayload);
		if (observationKey === lastEmittedObservationKey)
		{
			return;
		}

		try
		{
			fs.appendFileSync(this.observationsPath, JSON.stringify(payload) + "\n", "utf8");
			lastEmittedObservationKey = observationKey;
		}
		catch (error)
		{
			this.log.error("Failed to append Tempest observation to %s: %s", this.observationsPath, error.toString());
		}
	}

	// Map Tempest precipitation values to Eve Condition Categories
	getConditionCategory(precipitationType, detail = false)
	{
	// Tempest: 0 = none, 1 = rain, 2 = hail, 3 = rain + hail (experimental)
	
	// Eve (simple): 0 = clear; 3 = snow; 2 = rain; 1 = overcast
	// Eve (detailed): 0 = clear; 1 = Few clouds;2 = Broken clouds;3 =  Overcast;
	//   4 = Fog; 5 = Drizzle; 6 = Rain; 7 = Hail; 8 = Snow; 9 = Severe weather

		if (precipitationType == 1) {
			// Rain
			return detail ? 6 : 2;
		} else if (precipitationType == 2) {
			// Hail
			return detail ? 7 : 2;
		} else if (precipitationType == 3){
			// Rain + Hail (return as hail)
			return detail ? 7 : 2;
		} else {
			// 0 = Clear
			return 0;
		}
	}

	getHourlyAccumulatedRain(observationTime, mmOfRainInLastMinute)
	{
		let that = this;
		
		// Have we moved on to the next minute
		let currentObservationMinute = moment.unix(observationTime).minute();
		if (that.rainAccumulationMinute == currentObservationMinute)
			that.rainAccumulation[currentObservationMinute] += mmOfRainInLastMinute;
		else {
			// Erase the minutes between last recorded minute and current minute
			for (var i = that.rainAccumulationMinute + 1; (i % 60) != currentObservationMinute; i++)
				that.rainAccumulation[i % 60] = 0;
			that.rainAccumulation[currentObservationMinute] = mmOfRainInLastMinute;
		}
		that.rainAccumulationMinute = currentObservationMinute;
	
		var accumulation = converter.getRainAccumulated(that.rainAccumulation)
	
		this.log.debug("getHourlyAccumulatedRain last minute: " + mmOfRainInLastMinute + " rainAccumulation: " + this.rainAccumulation + " last hour: " + accumulation);
		return accumulation;
	}

	// For AIR/SKY sensor units, assume to be the same as
	// the Tempest documentation.
	getBatteryPercent(batteryVoltage)
	{
		return this.getTempestBatteryPercent(batteryVoltage);
	}
	
	// Tempest battery ranges from 2.355 (low) to 2.8 (full)
	// https://help.weatherflow.com/hc/en-us/articles/360048877194-Solar-Power-Rechargeable-Battery
	// Assume "low" to be 5%, so "zero" battery level is approx. 2.11v
	getTempestBatteryPercent(batteryVoltage)
	{
		var percent = (batteryVoltage * 100.0 - 211.0)/0.69;
		return (percent > 100) ? 100 : (percent < 0.0) ? 0 : percent;
	}
	

	// API for UDP data: https://weatherflow.github.io/Tempest/api/udp.html
	parseMessage(message)
	{
		let that = this;
		
		if (message.type == 'device_status') {
			that.currentReport.ObservationStation = message.serial_number;
			that.currentReport.ObservationTime = moment.unix(message.timestamp).format('HH:mm:ss');
			
			// Handle sensor failures
			// Per API v171, only intepret values defined, ignore all others
			message.sensor_status = message.sensor_status & 0x1FFFF;

			const filteredSensorStatus = this.getFilteredSensorStatus(message.sensor_status);
			that.currentReport.StatusFault = filteredSensorStatus !== 0;
			if (message.sensor_status !== 0 && filteredSensorStatus === 0) {
				that.log.debug("Ignoring Tempest sensor failure after applying filter '%s'", this.statusFaultFilter);
			}
			if (message.sensor_status == 0) {
				this.currentReport.SensorString = "Ok";
				
				// Reset logging interval for only the unit that is ok
				// Unit prefixes: AR Air, SK Sky, ST Tempest
				if (message.serial_number.charAt(1) == 'R') {
					this.currentReport.AirSensorFailureLog = -1;
				} else {
					this.currentReport.SkySensorFailureLog = -1;
				}
			} else {
				this.currentReport.SensorString = "";
				if (message.sensor_status & 0x00000001) {
					this.currentReport.SensorString += "Lightning failed"
				}
				if (message.sensor_status & 0x00000002) {
					if (this.currentReport.SensorString.length > 0) this.currentReport.SensorString += ", ";
					this.currentReport.SensorString += "Lightning noise"
				}
				if (message.sensor_status & 0x00000004) {
					if (this.currentReport.SensorString.length > 0) this.currentReport.SensorString += ", ";
					this.currentReport.SensorString += "Lightning disturber"
				}
				if (message.sensor_status & 0x00000008) {
					if (this.currentReport.SensorString.length > 0) this.currentReport.SensorString += ", ";
					this.currentReport.SensorString += "Pressure failed"
				}
				if (message.sensor_status & 0x00000010) {
					if (this.currentReport.SensorString.length > 0) this.currentReport.SensorString += ", ";
					this.currentReport.SensorString += "Temperature failed"
				}
				if (message.sensor_status & 0x00000020) {
					if (this.currentReport.SensorString.length > 0) this.currentReport.SensorString += ", ";
					this.currentReport.SensorString += "Relative Humidity failed"
				}
				if (message.sensor_status & 0x00000040) {
					if (this.currentReport.SensorString.length > 0) this.currentReport.SensorString += ", ";
					this.currentReport.SensorString += "Wind failed"
				}
				if (message.sensor_status & 0x00000080) {
					if (this.currentReport.SensorString.length > 0) this.currentReport.SensorString += ", ";
					this.currentReport.SensorString += "Precipitation failed"
				}
				if (message.sensor_status & 0x00000100) {
					if (this.currentReport.SensorString.length > 0) this.currentReport.SensorString += ", ";
					this.currentReport.SensorString += "Light/UV failed"
				}
				if (message.sensor_status & 0x00008000) {
					if (this.currentReport.SensorString.length > 0) this.currentReport.SensorString += ", ";
					this.currentReport.SensorString += "Power booster depleted"
				}
				if (message.sensor_status & 0x00010000) {
					if (this.currentReport.SensorString.length > 0) this.currentReport.SensorString += ", ";
					this.currentReport.SensorString += "Power booster shore power"
				}
				this.log.debug("Sensor on unit %s failed error code: %d", message.serial_number, message.sensor_status);
				
				// Track error logging per failed device
				// Unit prefixes: AR Air, SK Sky, ST Tempest
				if (message.serial_number.charAt(1) == 'R') {
					if (this.currentReport.AirSensorFailureLog != moment.unix(message.timestamp).hour()) {
						this.log.debug("Sensor on unit %s failed: ", message.serial_number, this.currentReport.SensorString);
					}
					this.currentReport.AirSensorFailureLog = moment.unix(message.timestamp).hour();
				} else {
					if (this.currentReport.SkySensorFailureLog != moment.unix(message.timestamp).hour()) {
						this.log.debug("Sensor on unit %s failed: ", message.serial_number, this.currentReport.SensorString);
					}
					this.currentReport.SkySensorFailureLog = moment.unix(message.timestamp).hour();
				}
			}
		}
		
		if (message.type == 'evt_precip') {
			that.currentReport.ObservationStation = message.serial_number;
			that.currentReport.ObservationTime = moment.unix(message.evt[0]).format('HH:mm:ss');
			that.currentReport.ConditionCategory = this.getConditionCategory(1, this.conditionDetail); // It has started to rain
			that.currentReport.RainBool = true;
		}
		
		if (message.type == 'rapid_wind') {
			that.currentReport.ObservationStation = message.serial_number;
			that.currentReport.ObservationTime = moment.unix(message.ob[0]).format('HH:mm:ss');
			that.currentReport.WindSpeed = message.ob[1];
			that.currentReport.WindDirection = converter.getWindDirection(message.ob[2]);
		}
		
		if (message.type == 'obs_air') {
			that.currentReport.AirSerialNumber = message.serial_number;
			that.currentReport.ObservationStation = that.currentReport.AirSerialNumber;
			that.currentReport.AirFirmware = message.firmware_revision;
			that.currentReport.ObservedAtEpoch = message.obs[0][0];
			that.currentReport.ObservationTime = moment.unix(message.obs[0][0]).format('HH:mm:ss');
			that.currentReport.AirPressure = message.obs[0][1];
			that.currentReport.Temperature = message.obs[0][2];
			that.currentReport.Humidity = message.obs[0][3];
			
			// Only perform new calculations if temperature and humidity values are within a good range
			// We could get out of range values if the sensors have failed.
			if (that.currentReport.Humidity > 0 && that.currentReport.Humidity <= 100 &&
				that.currentReport.Temperature > -100 && that.currentReport.Temperature < 100) {
				that.updateDerivedTemperatures(
					that.currentReport.Temperature,
					that.currentReport.Humidity,
					that.currentReport.WindSpeed
				);
			}
			that.currentReport.TemperatureMin = (that.currentReport.Temperature < that.currentReport.TemperatureMin) ?
					that.currentReport.Temperature : that.currentReport.TemperatureMin;
			that.currentReport.LightningStrikes = message.obs[0][4];
			that.currentReport.LightningAvgDistance = message.obs[0][5];
			
			// Report battery status.
			var previousLevel = that.currentReport.AirSensorBatteryLevel;
			that.currentReport.AirSensorBatteryLevel = this.getBatteryPercent(message.obs[0][6]);
			// If the AIR sensor has the lowest battery level, then report it as the Station battery level
			if (that.currentReport.AirSensorBatteryLevel < that.currentReport.SkySensorBatteryLevel) {
				that.currentReport.BatteryLevel = that.currentReport.AirSensorBatteryLevel;
				// It could have a solar panel on it, so check to see if it is going up (charging)
				that.currentReport.BatteryIsCharging = false;
				if (that.currentReport.BatteryLevel > previousLevel) {
					that.currentReport.BatteryIsCharging = true;
				}
			}
		}

		if (message.type == 'obs_sky') {
			that.currentReport.SkySerialNumber = message.serial_number;
			that.currentReport.ObservationStation = that.currentReport.SkySerialNumber;
			that.currentReport.SkyFirmware = message.firmware_revision;
			that.currentReport.ObservedAtEpoch = message.obs[0][0];
			that.currentReport.ObservationTime = moment.unix(message.obs[0][0]).format('HH:mm:ss');
			that.currentReport.LightLevel = message.obs[0][1];
			that.currentReport.UVIndex = message.obs[0][2];
			that.currentReport.Rain1h = this.getHourlyAccumulatedRain(message.obs[0][0], message.obs[0][3]);
		
			// Use wind values reported by rapid_wind as they are instantanous,
			// whereas obs_sky are averaged values over last minute
			//that.currentReport.WindSpeed = message.obs[0][5];
			//that.currentReport.WindDirection = converter.getWindDirection(message.obs[0][7]);
			
			// Wind values are min/max over last minute
			that.currentReport.WindSpeedLull = message.obs[0][4];
			that.currentReport.WindSpeedMax = message.obs[0][6];
			
			// Report battery status.
			var previousLevel = that.currentReport.SkySensorBatteryLevel;
			that.currentReport.SkySensorBatteryLevel = this.getBatteryPercent(message.obs[0][8]);
			// If the SKY sensor has the lowest battery level, then report it as the Station battery level
			if (that.currentReport.SkySensorBatteryLevel < that.currentReport.AirSensorBatteryLevel) {
				that.currentReport.BatteryLevel = that.currentReport.SkySensorBatteryLevel;
				// It could have a solar panel on it, so check to see if it is going up (charging)
				that.currentReport.BatteryIsCharging = false;
				if (that.currentReport.BatteryLevel > previousLevel) {
					that.currentReport.BatteryIsCharging = true;
				}
			}
			
			that.currentReport.SolarRadiation = message.obs[0][10];
			// Note that Local Day Rain Accumulation (Field 11) is currently always null. Hence we have to approximate it with data available to us.
			that.currentReport.RainBool = message.obs[0][3] > 0 ? true : false;
			if (that.rainDayDate === moment.unix(message.obs[0][0]).format('DD')) {
				that.currentReport.RainDay += parseFloat(message.obs[0][3]);
			} else {
				that.rainDayDate = moment.unix(message.obs[0][0]).format('DD');
				that.currentReport.RainDay = parseFloat(message.obs[0][3]);
				that.currentReport.TemperatureMin = that.currentReport.Temperature;
			}
			that.currentReport.ConditionCategory = this.getConditionCategory(message.obs[0][12], this.conditionDetail);
		}

       if (message.type == 'obs_st') {
            that.currentReport.SkySerialNumber = message.serial_number;
      	    that.currentReport.ObservationStation = that.currentReport.SkySerialNumber;
            that.currentReport.SkyFirmware = message.firmware_revision;
            that.currentReport.ObservedAtEpoch = message.obs[0][0];
            that.currentReport.ObservationTime = moment.unix(message.obs[0][0]).format('HH:mm:ss');
            
            // Wind values are min/max over last minute
            that.currentReport.WindSpeedLull = message.obs[0][1];
            that.currentReport.WindSpeedMax = message.obs[0][3];
            // Use wind values reported by rapid_wind as they are instantanous,
            // whereas obs_sky are averaged values over last minute
            //that.currentReport.WindSpeed = message.obs[0][2];
            //that.currentReport.WindDirection = converter.getWindDirection(message.obs[0][4]);
            
            that.currentReport.AirPressure = message.obs[0][6];
            that.currentReport.Temperature = message.obs[0][7];
            that.currentReport.Humidity = message.obs[0][8];
	
            // Only perform new calculations if temperature and humidity values are within a good range
            // We could get out of range values if the sensors have failed.
            if (that.currentReport.Humidity > 0 && that.currentReport.Humidity <= 100 &&
                    that.currentReport.Temperature > -100 && that.currentReport.Temperature < 100) {
                that.updateDerivedTemperatures(
					that.currentReport.Temperature,
					that.currentReport.Humidity,
					message.obs[0][2]
				);
            }
            
            that.currentReport.LightLevel = message.obs[0][9];
            that.currentReport.UVIndex = message.obs[0][10];
            that.currentReport.SolarRadiation = message.obs[0][11];
            that.currentReport.Rain1h = this.getHourlyAccumulatedRain(message.obs[0][0], message.obs[0][12]);
            that.currentReport.RainBool = message.obs[0][12] > 0 ? true : false;
            if (that.rainDayDate === moment.unix(message.obs[0][0]).format('DD')) {
		this.log.debug("Adding rain " + parseFloat(message.obs[0][12]) + " for day " + that.rainDayDate);
                that.currentReport.RainDay += parseFloat(message.obs[0][12]);
                that.currentReport.TemperatureMin = (that.currentReport.Temperature < that.currentReport.TemperatureMin) ?
					that.currentReport.Temperature : that.currentReport.TemperatureMin;
            } else {
		this.log.debug("Creating new count for rain " + parseFloat(message.obs[0][12]) + " for day " + that.rainDayDate);
                that.rainDayDate = moment.unix(message.obs[0][0]).format('DD');
                that.currentReport.RainDay = parseFloat(message.obs[0][12]);
                that.currentReport.TemperatureMin = that.currentReport.Temperature;
            }
            that.currentReport.ConditionCategory = this.getConditionCategory(message.obs[0][13], this.conditionDetail);
            that.currentReport.LightningAvgDistance = message.obs[0][14];
            that.currentReport.LightningStrikes = message.obs[0][15];
            that.currentReport.SkySensorBatteryLevel = this.getTempestBatteryPercent(message.obs[0][16]);
            var previousLevel = that.currentReport.BatteryLevel;
			that.currentReport.BatteryIsCharging = false;
			that.currentReport.BatteryLevel = that.currentReport.SkySensorBatteryLevel;
			if (that.currentReport.BatteryLevel > previousLevel) {
				that.currentReport.BatteryIsCharging = true;
			}
            
        }

		this.markFreshLiveStationData(message.type);
		this.appendObservationIfNeeded(message.type);
	}
	
	getForecastConditionCategory(icon, detail = false)
	{
		// Convert the icon names to condition category
		// See https://weatherflow.github.io/Tempest/api/swagger/#!/forecast/getBetterForecast
		
		if (icon.includes("thunderstorm") || icon.includes("windy"))
		{
			// Severe weather
			return detail ? 9 : 2;
		}
		else if (icon.includes("snow"))
		{
			// Snow
			return detail ? 8 : 3;
		}
		else if (icon.includes("sleet"))
		{
			// Hail
			return detail ? 7 : 3;
		}
		else if (icon.includes("rain"))
		{
			// Rain
			return detail ? 6 : 2;
		}
		else if (icon.includes("fog"))
		{
			// Fog
			return detail ? 4 : 1;
		}
		else if (icon.includes("partly-cloudy"))
		{
			// Few Clouds
			return detail ? 1 : 0;
		}
		else if (icon.includes("cloudy"))
		{
			// Overcast
			return detail ? 3 : 1;
		}
		else if (icon.includes("clear"))
		{
			// Clear
			return 0;
		}
		else
		{
			this.log.warn("Unknown Tempest Forecast icon " + icon);
			return 0;
		}
	};
	
	getForecastData(callback)
	{
		/*
		Weatherflow do provide an API to get forecasts
		https://weatherflow.github.io/Tempest/api/remote-developer-policy.html
		https://weatherflow.github.io/Tempest/api/swagger/#!/forecast/getBetterForecast
		 */
		this.log.debug("Getting weather forecast for station %s", this.locationId);

		// Response defaults to metric
		const queryUri = "https://swd.weatherflow.com/swd/rest/better_forecast?station_id=" + this.locationId + "&token=" + this.apiKey;
		axios.get(encodeURI(queryUri))
			.then(response =>
			{
				if (response.status == 200) {
					let parseError;
					let weather
					try
					{
						weather = response.data;
					} catch (e)
					{
						parseError = e;
					}
					callback(parseError, weather);
				} else {
					this.log.error("Weatherflow forecast response failure");
					callback(true, response.data);
				}
			})
			.catch(requestError =>
			{
				this.log.error("Weatherflow forecast request failure: " + requestError.toString());
				callback(requestError);
			});
	}
	
	
	parseForecasts(observation_time, values, timezone)
	{
		let forecasts = [];

		if (!Array.isArray(values) || values.length === 0)
		{
			this.log.warn("Weatherflow forecast payload did not include any daily values");
			return forecasts;
		}
		 
		// Check to see if we have 'Todays' forecast as it may be too late
		// in the day (11pm-midnight) for a daily forecast
		// If we don't have 'Todays' forecast, then the forecasts will start from tomorrow.
		let currentDay = moment.unix(observation_time).tz(timezone).date();
		let forecastOffset = values[0].day_num == currentDay ? 0 : 1;
		this.log.debug("Weatherflow forecast. Today is:" + currentDay + " First forecast day:" + values[0].day_num);
		
		for (let i = 0; i < values.length; i++) {
			// this.log(values[i]);
			let forecast = {};
			forecast.Condition = values[i].conditions;
			forecast.ConditionCategory = this.getForecastConditionCategory(values[i].icon, this.conditionDetail);
			forecast.ForecastDay =  moment.unix(values[i].day_start_local).tz(timezone).format('dddd');
			let detailedCondition = this.getForecastConditionCategory(values[i].icon, true);
			forecast.RainBool = [5, 6, 9].includes(detailedCondition);
			forecast.SnowBool = [7, 8].includes(detailedCondition);
			forecast.SunriseTime = moment.unix(values[i].sunrise).tz(timezone).format('HH:mm:ss');
			forecast.SunsetTime = moment.unix(values[i].sunset).tz(timezone).format('HH:mm:ss');
			forecast.TemperatureMax = values[i].air_temp_high;
			forecast.TemperatureMin = values[i].air_temp_low;
			forecast.RainChance = values[i].precip_probability;
			forecast.ObservationTime = moment.unix(observation_time).tz(timezone).format('HH:mm:ss');
			
			forecasts[i+forecastOffset] = forecast;
		}
		
		if (forecastOffset == 0) {
			// If we have the current day forecast save it away
			this.savedDayForecast = forecasts[0];
			this.log.debug("Weatherflow storing today's forecast");
		} else {
			// If we don't have the current day forecast, present the last saved one
			this.log.debug("Weatherflow inserting saved today's forecast");
			forecasts[0] = this.savedDayForecast;
		}
		
		return forecasts;
	}

}

module.exports = {
	TempestAPI: TempestAPI,
	resolveObservationOutputPath: resolveObservationOutputPath
};
