
const BaseAccessory = require('./BaseAccessory');

const fakegatoHistory = require('fakegato-history');
const fs = require('fs');
const path = require('path');

// const os = require('os');
// const DEBUG = os.hostname().split(".")[0] == 'athena';
// const DEBUG = true;

class OutletAccessory extends BaseAccessory {
    static getCategory(Categories) {
        return Categories.OUTLET;
    }

    constructor(...props) {
        super(...props);
    }

    _registerPlatformAccessory() {
        const {Service} = this.hap;

        this.accessory.addService(Service.Outlet, this.device.context.name);
        super._registerPlatformAccessory();
    }

    _registerCharacteristics(dps) {
        const {Service, Characteristic, EveCharacteristics, EnergyCharacteristics} = this.hap;
        const service = this.accessory.getService(Service.Outlet);
        this._checkServiceName(service, this.device.context.name);
        
        const log = this.log;
        // this.log.info(`OutletPlus: DPS=${JSON.stringify(dps)}`);
        const powerManagement = ('19' in dps || '5' in dps) ? true : false;
        const shift = ('19' in dps) ? 14 : 0;

        // const log_debug = DEBUG ? console.log : log.debug;

        // Eve.Characteristics.TotalConsumption = EnergyCharacteristics.KilowattHours
        const OutletOn         = {dp: String(1),         div: null, char: Characteristic.On};
        const OutletInUse      = {dp: null,              div: null, char: Characteristic.OutletInUse};
        const ResetTotal       = {dp: null,              div: null, char: EveCharacteristics.ResetTotal};
        const TotalConsumption = {dp: null,              div: null, char: EnergyCharacteristics.KilowattHours};
        const Amperes          = {dp: String(4 + shift), div: 1000, char: EnergyCharacteristics.Amperes};
        const Watts            = {dp: String(5 + shift), div: 10,   char: EnergyCharacteristics.Watts};
        const Volts            = {dp: String(6 + shift), div: 10,   char: EnergyCharacteristics.Volts};

        const onCharacteristic    = service.getCharacteristic(OutletOn.char);
        const inuseCharacteristic = service.getCharacteristic(OutletInUse.char);
        const Ports = [Amperes, Watts, Volts];

        for (let state of Ports) {
            let initValue = (parseFloat(dps[state.dp]) / state.div) || 0;
            service.getCharacteristic(state.char).updateValue(initValue)
                .on('get', this.getDpValue.bind(this, state));
        }
        onCharacteristic
            .updateValue(dps[OutletOn.dp])
            .on('get', this.getState.bind(this, OutletOn.dp))
            .on('set', this.setState.bind(this, OutletOn.dp));
    
        inuseCharacteristic
            .on('get', this.getInUse.bind(this, OutletOn, Volts));

        this.device.on('change', changes => {
            // log.debug(`OutletPlus ${this.device.context.name}: changes "${JSON.stringify(changes)}"`);
            let inUse = false;
            if (OutletOn.dp in changes && onCharacteristic.value !== changes[OutletOn.dp]) {
                onCharacteristic.updateValue(changes[OutletOn.dp]);
                inUse = changes[OutletOn.dp]; // This is already a boolean value
            }
            for (let state of Ports) {
                if (state.dp && state.dp in changes) {
                    let newValue = (parseFloat(changes[state.dp]) / state.div) || 0;
                    let char = service.getCharacteristic(state.char);
                    if (char.value !== newValue) {
                        char.updateValue(newValue);
                        if (state == Volts)
                            inUse = inUse && (newValue > 0);
                    }
                }
            }
            inuseCharacteristic.updateValue(inUse);
        });

        if (powerManagement) {
            const EveEpoch = 978307200;
            const kwhDivisor = 60 * 60 * 1000;

            // Activate FakeGato stuff
            const fakeHistory = fakegatoHistory(this.platform.homebridge); // class(accessoryType, accessory, optionalParams)
            const historyOptions = {disableTimer: false, storage: 'fs'};   // , minutes: 1};
            let device = {displayName: this.device.context.name, log: this.log };
            const historyService = new fakeHistory('energy', device, historyOptions);

            // Eve TotalConsumption & ResetTotal Characteristics (Eve.app)
            // service.addCharacteristic(TotalConsumption.char);
            // historyService.addOptionalCharacteristic(ResetTotal.char);
            // service.addCharacteristic(ResetTotal.char);
            // Register History service
            this.accessory.services.push(historyService);
            // Additional managed characteristics
            const totalCharacteristic = service.getCharacteristic(TotalConsumption.char);
            const wattsCharacteristic = service.getCharacteristic(Watts.char);
            const resetCharacteristic = service.getCharacteristic(ResetTotal.char);

            // Read actual state at launch time...
            const devicePersist = path.join(this.platform.homebridge.user.storagePath(),
                                      `consumption_${this.device.context.name}.json`);
            
            let now = Math.floor(Date.now() / 1000);
            // We can also provide TotalConsumption straight to Eve.app
            let deviceConsumption = {joules: 0, resetTotal: now - EveEpoch};
            fs.readFile(devicePersist, 'utf8', function(err, data) {
                if (!err)
                    deviceConsumption = JSON.parse(data);
                resetCharacteristic.updateValue(deviceConsumption.resetTotal);
            });

            totalCharacteristic
                .on('get', function (cb) { cb(null, deviceConsumption.joules / kwhDivisor);});

            resetCharacteristic
                .on('get', cb => cb(null, deviceConsumption.resetTotal))
                .on('set', (reset, cb) => {
                    deviceConsumption = {joules: 0, resetTotal: reset};
                    cb(null, reset);
                });


            let currentPower = { time: now, power: 0 };  // at initialization time
            let currentValue = currentPower.power;
            let frameStart = Math.floor(Date.now() / 1000);
            let frameJoules = 0.0;
            const updatePower = () => {
                let now = Math.floor(Date.now() / 1000);
                let frameSize = now - frameStart;
                this.getDpValue.bind(this, Watts, (err, value) => {
                    if (err) return;
                    currentValue = value;
                    wattsCharacteristic.updateValue(currentValue);    // immediate power
                    if ('time' in currentPower) {              // too cautious?
                        let consumption = currentValue * (now - currentPower.time);
                        frameJoules += consumption;
                        deviceConsumption.joules += consumption; // stored in Ws (Joules)
                        totalCharacteristic.updateValue(deviceConsumption.joules / kwhDivisor);
                        if (frameSize >= 60) {                 // send to FakeGato every minute
                            let avrPower = frameJoules / (now - frameStart);
                            historyService.addEntry({time: now, power: avrPower}); // average power over the time frame
                            // We then initiate a new frame...
                            frameStart = now,
                            frameJoules = 0.0;
                        }
                        currentPower = {time: now, power: currentValue};
                    }
                })();
                if (frameSize >= 60) log.debug(`OutletPlus Power: ${frameSize} -> ${frameJoules}, ${currentPower.power}`);
                setTimeout(updatePower.bind(this), 1000);
            };
            setTimeout(updatePower.bind(this), 1000);

            const recordConsumption = function() {
                let error = 0;
                fs.writeFile(devicePersist, JSON.stringify(deviceConsumption), 'utf8', function(err) {
                    error = err;
                });
                if (error) log.error(`failed to record consumption (${error})`);
            };
            setInterval(recordConsumption.bind(this), 3 * 60 * 1000); // Eve.app expects every 10 minutes...

            /*
            const record_frequency = 3 * 60 * 1000; // Eve.app expects every 10 minutes...
            const record = () => {
                fs.writeFile(devicePersist, JSON.stringify(deviceConsumption), 'utf8', function(err) {
                    if (err) return;
                });
                setTimeout(record, record_frequency);
            };
            setTimeout(record, record_frequency);

            const updateFrequency = 1000;         // update in memory every second
            // const update_watts = this.getDpValue.bind(this, watts); // avoiding 'this' trickery...
            // let watts = 0;
            const update = () => {
                this.getDpValue.bind(this, watts, (err, watts) => {
                    if (err) return;
                    let logEntry = {time: Math.floor(Date.now() / 1000), power: watts};
                    if ('time' in devicePower) {                // Riemann sum
                        let slice = logEntry.time - devicePower.time;
                        let delta = watts * slice;
                        deviceConsumption.joules += delta; // stored in Ws (Joules)
                        if (delta > 0) {
                            totalCharacteristic.updateValue(deviceConsumption.joules / kwhDivisor);
                        }
                        if (slice > historyFrequency) {
                            historyService.addEntry(logEntry);
                        }
                    }
                    devicePower = logEntry;
                })();
                // log_debug(`Power = ${watts} W`);
                setTimeout(update.bind(this), updateFrequency);
            };
            setTimeout(update.bind(this), updateFrequency);
            */

            log.info(`OutletPlus "${this.device.context.name}" History  "${historyService.constructor.name}" added`);
        }
    }

    getInUse(on, volts, callback = () => {}) {
        this.getState(on.dp, (err, state) => {
            if (err) callback(err);
            this.getState(volts.dp, (err, use) => {
                if (err) callback(err);
                callback(null, state & use > 0);
            });
        });
    }

    getDpValue(state, callback) {
        return this.getDividedState(state.dp, state.div, callback);
    }

}

module.exports = OutletAccessory;

// UUID pattern =     E863F${id}-079E-48FF-8F27-9C2605A29F52
// ---------------------------------------------------------------------
// id  | Unit | TuyaEnergy             | EveHomeKit         | FakeGato
// ---------------------------------------------------------------------
// 10A |    V | Volts                  | Voltage            |
// 10C |  kWh | KilowattHours          | TotalConsumption   |
// 10D |    W | Watts                  | CurrentConsumption | *checked* (when TYPE_CUSTOM)
// 110 |   VA | VoltAmperes            |                    |
// 126 |    A | Amperes                | ElectricCurrent    |
// 127 | kVAh | KilowattVoltAmpereHour |                    |
// 112 |      |                        | ResetTotal         |
// 116 |      |                        | HistoryStatus      | S2R1Characteristic
// 117 |      |                        | HistoryEntries     | S2R2Characteristic
// 11C |      |                        | HistoryRequest     | S2W1Characteristic
// 121 |      |                        | SetTime            | S2W1Characteristic
// Others are present on Eve side, s.t. ResetTotal 112, History, Programs

/*
  let watts = 0;
  const power = () => {
  this.log.debug('Power...');
  this.getDpValue.bind(this, watts, (err, val) => { watts = val; })();
  this.log.debug(`... ${watts} W`);
  setTimeout(power.bind(this), 1000);
  };
  setTimeout(power.bind(this), 1000);
*/
