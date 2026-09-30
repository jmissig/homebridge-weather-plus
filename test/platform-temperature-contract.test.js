const assert = require("assert");
const { createPlatform } = require("./helpers/platform-harness");
const createCustomCharacteristics = require("../util/characteristics");

const names = ["DewPoint", "TemperatureMin", "TemperatureApparent", "TemperatureWetBulb"];
let configurations = 0;
for (const units of ["imperial", "us", "si", "metric", "ca", "uk", "sitorr"])
{
	for (const mode of ["eve", "eve2", "home", "both"])
	{
		for (const type of ["current", "forecast"])
		{
			const { platform, Service, Characteristic, homebridge, errors } = createPlatform(units);
			const custom = createCustomCharacteristics(Characteristic, homebridge, units);
			const main = new Service();
			const accessory = {
				config: { compatibility: mode, hidden: [] },
				CurrentConditionsService: main, ForecastService: main
			};
			for (const name of names) accessory[name + "Service"] = new Service();
			for (const celsius of [-10, 0, 20, 37.5])
			{
				for (const name of names)
				{
					platform.saveCharacteristic(accessory, name, celsius, type);
					if (mode === "eve" || mode === "eve2")
					{
						const characteristic = main.getCharacteristic(custom[name]);
						const imperial = units === "imperial" || units === "us";
						assert.strictEqual(characteristic.value, imperial ? celsius * 1.8 + 32 : celsius,
							[units, mode, type, name, celsius].join("/"));
						assert.strictEqual(characteristic.props.unit, imperial ? "fahrenheit" : "celsius");
					}
					else if (name !== "TemperatureWetBulb")
					{
						assert.strictEqual(accessory[name + "Service"].getCharacteristic(Characteristic.CurrentTemperature).value,
							celsius, "native HomeKit temperature must remain Celsius");
						assert.strictEqual(main.testCharacteristic(custom[name]), false);
					}
					else
					{
						// Wet bulb has no home/both compatibility service today.
						// This cherry-pick must not introduce a custom characteristic there.
						assert.strictEqual(main.testCharacteristic(custom[name]), false);
					}
				}
				for (const name of ["Temperature", "TemperatureMax"])
				{
					platform.saveCharacteristic(accessory, name, celsius, type);
					assert.strictEqual(main.getCharacteristic(Characteristic.CurrentTemperature).value, celsius);
				}
			}
			accessory.config.hidden = names;
			const count = main.characteristics.size;
			for (const name of names) platform.saveCharacteristic(accessory, name, 99, type);
			assert.strictEqual(main.characteristics.size, count);
			if (mode === "eve" || mode === "eve2")
			{
				const expected = units === "imperial" || units === "us" ? 99.5 : 37.5;
				for (const name of names) assert.strictEqual(main.getCharacteristic(custom[name]).value, expected);
				// Non-temperature custom values must not be converted.
				platform.saveCharacteristic(accessory, "ConditionCategory", 2, type);
				assert.strictEqual(main.getCharacteristic(custom.ConditionCategory).value, 2);
			}
			assert.deepStrictEqual(errors, []);
			configurations++;
		}
	}
}
console.log("Platform temperatures: " + configurations + " unit/mode/current-forecast configurations passed.");
