const assert = require("assert");
const axios = require("axios");
const { TempestAPI } = require("../apis/weatherflow");

function createLog()
{
	const log = function () {};
	log.debug = function () {};
	log.error = function () {};
	log.warn = function () {};
	return log;
}

function createTempestHarness()
{
	const tempest = Object.create(TempestAPI.prototype);
	tempest.apiKey = "personal-token";
	tempest.locationId = "12345";
	tempest.conditionDetail = false;
	tempest.log = createLog();
	return tempest;
}

const observationTime = 1717243200;
const dailyForecast = [{
	day_num: 1,
	day_start_local: 1717225200,
	conditions: "Rain Possible",
	icon: "possibly-rainy-day",
	sunrise: 1717245900,
	sunset: 1717298100,
	air_temp_high: 24.5,
	air_temp_low: 13.2,
	precip_probability: 65
}];

function verifyForecastMapping()
{
	const tempest = createTempestHarness();
	const forecasts = tempest.parseForecasts(observationTime, dailyForecast, "America/Los_Angeles");

	assert.strictEqual(forecasts.length, 1);
	assert.strictEqual(forecasts[0].Condition, "Rain Possible");
	assert.strictEqual(forecasts[0].ConditionCategory, 2);
	assert.strictEqual(forecasts[0].RainBool, true);
	assert.strictEqual(forecasts[0].SnowBool, false);
	assert.strictEqual(forecasts[0].TemperatureMax, 24.5);
	assert.strictEqual(forecasts[0].TemperatureMin, 13.2);
	assert.strictEqual(forecasts[0].RainChance, 65);
	assert.ok(forecasts[0].SunriseTime !== "00:00:00");
	assert.ok(forecasts[0].SunsetTime !== "00:00:00");
	assert.deepStrictEqual(tempest.parseForecasts(observationTime, [], "America/Los_Angeles"), []);
}

async function verifyForecastRequest()
{
	const tempest = createTempestHarness();
	const originalGet = axios.get;
	let requestedUrl;
	const responseBody = {
		current_conditions: { time: observationTime },
		forecast: { daily: dailyForecast },
		timezone: "America/Los_Angeles"
	};

	axios.get = function (url)
	{
		requestedUrl = url;
		return Promise.resolve({ status: 200, data: responseBody });
	};

	try
	{
		const result = await new Promise((resolve, reject) =>
		{
			tempest.getForecastData((error, data) =>
			{
				if (error)
				{
					reject(error);
					return;
				}
				resolve(data);
			});
		});

		assert.strictEqual(
			requestedUrl,
			"https://swd.weatherflow.com/swd/rest/better_forecast?station_id=12345&token=personal-token"
		);
		assert.strictEqual(result, responseBody);
	}
	finally
	{
		axios.get = originalGet;
	}
}

verifyForecastMapping();
verifyForecastRequest().catch((error) =>
{
	console.error(error);
	process.exitCode = 1;
});
