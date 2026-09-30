const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");

class TestCharacteristic
{
	constructor(displayName, UUID)
	{
		this.displayName = displayName;
		this.UUID = UUID;
		this.props = {};
		this.value = null;
	}
	setProps(props) { this.props = props; return this; }
	getDefaultValue() { return null; }
	updateValue(value) { this.value = value; return this; }
}

for (const name of ["CurrentTemperature", "CurrentRelativeHumidity", "CurrentAmbientLightLevel",
	"OccupancyDetected", "ConfiguredName", "Name"])
{
	TestCharacteristic[name] = name;
}

// Model HAP's lazy getCharacteristic behavior: a read can mount a new characteristic.
class TestService
{
	constructor(displayName, UUID, subtype)
	{
		this.displayName = displayName;
		this.UUID = UUID;
		this.subtype = subtype;
		this.characteristics = new Map();
	}
	addCharacteristic(type)
	{
		const characteristic = typeof type === "function" ? new type() : new TestCharacteristic(type, type);
		this.characteristics.set(type, characteristic);
		return characteristic;
	}
	testCharacteristic(type) { return this.characteristics.has(type); }
	getCharacteristic(type) { return this.characteristics.get(type) || this.addCharacteristic(type); }
	setCharacteristic(type, value) { this.getCharacteristic(type).updateValue(value); return this; }
}

function createPlatform(units = "si")
{
	const filename = path.resolve(__dirname, "../../index.js");
	const realRequire = createRequire(filename);
	const sandbox = {
		module: { exports: {} },
		require: (name) => name === "fakegato-history" ? () => class {} : realRequire(name),
		setTimeout: () => 0
	};
	vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
	let Platform;
	const homebridge = {
		hap: {
			Service: TestService,
			Characteristic: TestCharacteristic,
			Formats: { BOOL: "bool", FLOAT: "float", STRING: "string", UINT8: "uint8", UINT16: "uint16" },
			Perms: { PAIRED_READ: "pr", NOTIFY: "ev" },
			Units: { CELSIUS: "celsius", PERCENTAGE: "percentage" }
		},
		on() {},
		registerPlatform(plugin, name, constructor) { Platform = constructor; }
	};
	sandbox.module.exports(homebridge);
	const errors = [];
	const log = Object.assign(() => {}, {
		info() {}, debug() {}, warn() {}, error: (...args) => errors.push(args)
	});
	// No station construction: no sockets, storage, HTTP, or repeating timers.
	const platform = new Platform(log, { units, stations: [] });
	return { platform, errors, Characteristic: TestCharacteristic, Service: TestService, homebridge };
}

module.exports = { createPlatform, TestCharacteristic, TestService };
