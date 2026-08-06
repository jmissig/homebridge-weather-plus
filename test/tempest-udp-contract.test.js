const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { TempestAPI, resolveObservationOutputPath } = require("../apis/weatherflow");

function createLog()
{
	const log = function () {};
	log.debug = function () {};
	log.error = function () {};
	log.warn = function () {};
	return log;
}

function createTempestHarness(observationsPath, observationOutputEnabled = false)
{
	const tempest = Object.create(TempestAPI.prototype);
	tempest.conditionDetail = false;
	tempest.statusFaultFilter = "ignoreLightning";
	tempest.log = createLog();
	tempest.observationsPath = observationsPath;
	tempest.observationOutputEnabled = observationOutputEnabled;
	tempest.derivedValueWarnings = {};
	tempest.rainAccumulation = new Array(60).fill(0);
	tempest.rainAccumulationMinute = 0;
	tempest.hasFreshLiveStationData = false;
	tempest.hasFreshLiveAirData = false;
	tempest.hasFreshLiveSkyData = false;
	tempest.currentReport = {
		AirPressure: 0,
		Temperature: 0,
		TemperatureMin: 50,
		TemperatureApparent: 0,
		TemperatureWetBulb: 0,
		DewPoint: 0,
		Humidity: 1,
		WindSpeed: 0,
		WindSpeedLull: 0,
		WindSpeedMax: 0,
		WindDirection: "N",
		LightLevel: 0,
		UVIndex: 0,
		SolarRadiation: 0,
		Rain1h: 0,
		RainDay: 0,
		RainBool: false,
		ConditionCategory: 0,
		LightningStrikes: 0,
		LightningAvgDistance: 0,
		BatteryLevel: 100,
		BatteryIsCharging: false,
		SkySensorBatteryLevel: 100,
		SkySensorFailureLog: -1,
		AirSensorFailureLog: -1,
		StatusFault: false,
		SensorString: "Ok",
		ObservedAtEpoch: null
	};
	return tempest;
}

function assertFiniteAndNonZero(value, name)
{
	assert.ok(Number.isFinite(value), `${name} should be finite`);
	assert.notStrictEqual(value, 0, `${name} should not silently fall back to zero`);
}

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "weather-plus-tempest-"));
const observationsPath = path.join(tempDirectory, "weather-observations.jsonl");

try
{
	const customPath = path.join(tempDirectory, "custom-observations.jsonl");
	assert.strictEqual(
		resolveObservationOutputPath(tempDirectory, ""),
		path.join(tempDirectory, "weather-observations.jsonl")
	);
	assert.strictEqual(resolveObservationOutputPath(tempDirectory, customPath), customPath);
	assert.strictEqual(
		resolveObservationOutputPath(tempDirectory, "relative-observations.jsonl"),
		path.join(tempDirectory, "weather-observations.jsonl")
	);

	const disabledPath = path.join(tempDirectory, "disabled-observations.jsonl");
	const disabledTempest = createTempestHarness(disabledPath);
	disabledTempest.hasFreshLiveStationData = true;
	disabledTempest.appendObservationIfNeeded("obs_st");
	assert.strictEqual(fs.existsSync(disabledPath), false, "observation output should be off by default");

	const tempest = createTempestHarness(observationsPath, true);

	// Official UDP shape: https://weatherflow.github.io/Tempest/api/udp.html
	tempest.parseMessage({
		serial_number: "ST-00000512",
		type: "rapid_wind",
		hub_sn: "HB-00013030",
		ob: [1717243200, 4.5, 225]
	});

	tempest.parseMessage({
		serial_number: "ST-00000512",
		type: "obs_st",
		hub_sn: "HB-00013030",
		obs: [[
			1717243200,
			0.8,
			2.4,
			5.6,
			225,
			3,
			1008.6,
			21.5,
			54,
			12345,
			4.2,
			410,
			0.6,
			1,
			12,
			3,
			2.65,
			1
		]],
		firmware_revision: 171
	});

	const report = tempest.currentReport;
	assert.strictEqual(report.ObservedAtEpoch, 1717243200);
	assert.strictEqual(report.ObservationStation, "ST-00000512");
	assert.strictEqual(report.AirPressure, 1008.6);
	assert.strictEqual(report.Temperature, 21.5);
	assert.strictEqual(report.Humidity, 54);
	assert.strictEqual(report.WindSpeed, 4.5);
	assert.strictEqual(report.WindDirection, "SW");
	assert.strictEqual(report.WindSpeedLull, 0.8);
	assert.strictEqual(report.WindSpeedMax, 5.6);
	assert.strictEqual(report.LightLevel, 12345);
	assert.strictEqual(report.UVIndex, 4.2);
	assert.strictEqual(report.SolarRadiation, 410);
	assert.strictEqual(report.Rain1h, 0.6);
	assert.strictEqual(report.RainDay, 0.6);
	assert.strictEqual(report.RainBool, true);
	assert.strictEqual(report.ConditionCategory, 2);
	assert.strictEqual(report.LightningAvgDistance, 12);
	assert.strictEqual(report.LightningStrikes, 3);
	assert.ok(report.BatteryLevel > 75 && report.BatteryLevel < 80);

	assertFiniteAndNonZero(report.DewPoint, "DewPoint");
	assertFiniteAndNonZero(report.TemperatureApparent, "TemperatureApparent");
	assertFiniteAndNonZero(report.TemperatureWetBulb, "TemperatureWetBulb");
	assert.ok(report.DewPoint > 10 && report.DewPoint < 14);
	assert.ok(report.TemperatureApparent > 19 && report.TemperatureApparent < 23);
	assert.ok(report.TemperatureWetBulb > 14 && report.TemperatureWetBulb < 18);

	const emittedLines = fs.readFileSync(observationsPath, "utf8").trim().split("\n");
	assert.strictEqual(emittedLines.length, 1, "one obs_st message should emit one observation");
	const emitted = JSON.parse(emittedLines[0]);
	assert.strictEqual(emitted.schema, "weather.current_report.v2");
	assert.strictEqual(emitted.temperature_c, 21.5);
	assert.strictEqual(emitted.airpressure_hpa, 1008.6);
	assert.strictEqual(emitted.windspeed_ms, 4.5);
	assertFiniteAndNonZero(emitted.dewpoint_c, "emitted dewpoint_c");
	assertFiniteAndNonZero(emitted.apparenttemperature_c, "emitted apparenttemperature_c");
	assertFiniteAndNonZero(emitted.wetbulbtemperature_c, "emitted wetbulbtemperature_c");

	// Lightning-only faults are intentionally ignored by the fork's default filter.
	tempest.parseMessage({
		serial_number: "ST-00000512",
		type: "device_status",
		timestamp: 1717243200,
		sensor_status: 0x00000001
	});
	assert.strictEqual(report.StatusFault, false);

	// A pressure sensor fault must still surface to HomeKit.
	tempest.parseMessage({
		serial_number: "ST-00000512",
		type: "device_status",
		timestamp: 1717243200,
		sensor_status: 0x00000008
	});
	assert.strictEqual(report.StatusFault, true);
	assert.ok(report.SensorString.includes("Pressure failed"));
}
finally
{
	if (fs.existsSync(observationsPath))
	{
		fs.unlinkSync(observationsPath);
	}
	fs.rmdirSync(tempDirectory);
}
