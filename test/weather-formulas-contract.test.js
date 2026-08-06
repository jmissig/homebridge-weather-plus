const assert = require("assert");
const weatherFormulas = require("weather-formulas");

assert.ok(weatherFormulas.temperature, "weather-formulas should expose temperature helpers");

[
	"celciusToKelvin",
	"kelvinToCelcius",
	"dewPointMagnusFormula",
	"australianApparentTemperature"
].forEach((name) =>
{
	assert.strictEqual(
		typeof weatherFormulas.temperature[name],
		"function",
		`weather-formulas.temperature.${name} should be a function`
	);
});

const temperatureC = 20;
const humidity = 50;
const windSpeed = 2;
const temperatureK = weatherFormulas.temperature.celciusToKelvin(temperatureC);

assert.ok(Number.isFinite(temperatureK), "celciusToKelvin should return a finite number");
assert.ok(temperatureK > 293 && temperatureK < 294, "20C should convert to about 293K");

const roundTripTemperatureC = weatherFormulas.temperature.kelvinToCelcius(temperatureK);

assert.ok(Number.isFinite(roundTripTemperatureC), "kelvinToCelcius should return a finite number");
assert.ok(roundTripTemperatureC > 19.9 && roundTripTemperatureC < 20.1, "Kelvin/Celsius round trip should preserve temperature");

const dewPointC = weatherFormulas.temperature.kelvinToCelcius(
	weatherFormulas.temperature.dewPointMagnusFormula(temperatureK, humidity)
);

assert.ok(Number.isFinite(dewPointC), "dewPointMagnusFormula should return a finite number");
assert.ok(dewPointC > 8 && dewPointC < 11, "20C/50% humidity should produce dew point near 9C");

const apparentTemperatureC = weatherFormulas.temperature.kelvinToCelcius(
	weatherFormulas.temperature.australianApparentTemperature(temperatureK, humidity, windSpeed)
);

assert.ok(Number.isFinite(apparentTemperatureC), "australianApparentTemperature should return a finite number");
assert.ok(
	apparentTemperatureC > 17 && apparentTemperatureC < 20,
	"20C/50% humidity/2mps wind should produce apparent temperature near 18C"
);
