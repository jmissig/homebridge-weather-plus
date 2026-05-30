const assert = require("assert");
const createCustomCharacteristics = require("../util/characteristics");

class TestCharacteristic
{
	constructor(displayName, UUID)
	{
		this.displayName = displayName;
		this.UUID = UUID;
		this.props = {};
	}

	setProps(props)
	{
		this.props = props;
	}

	getDefaultValue()
	{
		return null;
	}
}

function assertAllCustomCharacteristicsUsePerms(HomebridgeAPI, expectedReadPerm)
{
	const customCharacteristics = createCustomCharacteristics(TestCharacteristic, HomebridgeAPI, "si");

	Object.entries(customCharacteristics).forEach(([name, CharacteristicClass]) =>
	{
		const characteristic = new CharacteristicClass();

		assert.deepStrictEqual(
			characteristic.props.perms,
			[expectedReadPerm, HomebridgeAPI.hap.Perms.NOTIFY],
			`${name} should use valid read and notify permissions`
		);
	});
}

const hap2HomebridgeAPI = {
	hap: {
		Formats: {
			BOOL: "bool",
			FLOAT: "float",
			STRING: "string",
			UINT8: "uint8",
			UINT16: "uint16"
		},
		Perms: {
			PAIRED_READ: "pr",
			NOTIFY: "ev"
		},
		Units: {
			CELSIUS: "celsius",
			PERCENTAGE: "percentage"
		}
	}
};

assertAllCustomCharacteristicsUsePerms(hap2HomebridgeAPI, hap2HomebridgeAPI.hap.Perms.PAIRED_READ);

const legacyHomebridgeAPI = JSON.parse(JSON.stringify(hap2HomebridgeAPI));
legacyHomebridgeAPI.hap.Perms.READ = "pr";
delete legacyHomebridgeAPI.hap.Perms.PAIRED_READ;

assertAllCustomCharacteristicsUsePerms(legacyHomebridgeAPI, legacyHomebridgeAPI.hap.Perms.READ);
