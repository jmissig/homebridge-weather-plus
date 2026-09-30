const assert = require("assert");
const { createPlatform } = require("./helpers/platform-harness");
const { TempestAPI } = require("../apis/weatherflow");

function verifyConditionConfiguration()
{
	const { platform } = createPlatform();
	for (const category of [undefined, "simple", "detailed"])
	{
		const config = { service: "tempest" };
		if (category !== undefined) config.conditionCategory = category;
		assert.strictEqual(platform.parseStationConfig(config), true);
		const detailed = category === "detailed";
		assert.strictEqual(config.conditionDetail, detailed);
		const tempest = Object.create(TempestAPI.prototype);
		assert.strictEqual(tempest.getConditionCategory(1, config.conditionDetail), detailed ? 6 : 2);
		assert.strictEqual(tempest.getForecastConditionCategory("rainy", config.conditionDetail), detailed ? 6 : 2);
	}
}

function verifyHistory(mode, units, extraLight = false, hiddenLight = false)
{
	const { platform, Characteristic, Service, errors } = createPlatform(units);
	const entries = [];
	const config = { service: "tempest", compatibility: mode, extraLightLevel: extraLight };
	if (hiddenLight) config.hidden = ["LightLevel"];
	platform.parseStationConfig(config);
	const main = new Service();
	const accessory = {
		stationIndex: 0, name: "Tempest", config, CurrentConditionsService: main,
		historyService: { addEntry: (entry) => entries.push(entry) }
	};
	if (mode === "home" || mode === "both")
	{
		accessory.AirPressureService = new Service();
		accessory.AirPressureService.unit = units === "sitorr" ? "mmHg" : "hPa";
		accessory.HumidityService = new Service();
	}
	if (config.extraLightLevel) accessory.LightLevelService = new Service();
	let report = { Temperature: 20, Humidity: 55, AirPressure: 1013.27, LightLevel: 5432 };
	const station = {
		reportCharacteristics: Object.keys(report),
		update(forecast, callback) { callback(null, { report }); }
	};
	platform.stationConfigs = [config];
	platform.stations = [station];
	platform.accessoriesList = [accessory];
	platform.updateWeather();
	assert.deepStrictEqual(errors, []);
	assert.strictEqual(entries[0].pressure, 1013.27, mode + "/" + units + ": preserve raw hPa precision");
	assert.strictEqual(entries[0].lux, hiddenLight ? 0 : 5432);
	assert.strictEqual(entries[0].temp, 20);
	assert.strictEqual(entries[0].humidity, 55);
	if (hiddenLight)
		assert.strictEqual(main.testCharacteristic(Characteristic.CurrentAmbientLightLevel), false,
			"history must not mount a missing light characteristic");

	// Missing/zero pressure after a good observation must not flatten the graph.
	for (const value of [undefined, 0])
	{
		report = { Temperature: 21, Humidity: 56 };
		if (value !== undefined) report.AirPressure = value;
		station.reportCharacteristics = Object.keys(report);
		platform.updateWeather();
		assert.strictEqual(entries[entries.length - 1].pressure, 1013.27);
	}
	report.AirPressure = 1014.82;
	station.reportCharacteristics = Object.keys(report);
	platform.updateWeather();
	assert.strictEqual(entries[entries.length - 1].pressure, 1014.82);
	assert.deepStrictEqual(errors, []);
}

function verifyEveGrouping()
{
	const { Service, Characteristic } = createPlatform();
	const { EveWeatherService } = require("../util/services")(Service, Characteristic);
	const service = new EveWeatherService("Tempest", "current");
	assert.ok(service instanceof Service);
	assert.strictEqual(service.UUID, "E863F001-079E-48FF-8F27-9C2605A29F52");
	assert.strictEqual(service.subtype, "current");
	assert.ok(service.testCharacteristic(Characteristic.CurrentTemperature));
}

verifyConditionConfiguration();
verifyEveGrouping();
for (const mode of ["home", "both", "eve", "eve2"])
	for (const units of ["si", "sitorr", "imperial"])
		verifyHistory(mode, units);
verifyHistory("eve", "si", true);
verifyHistory("eve", "si", false, true);
console.log("Platform history: Tempest categories, Eve grouping, and 14 history configurations passed.");
