'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const bacnet = require('../');
const baAsn1 = require('../lib/asn1');
const baEnum = require('../lib/enum');

const certDir = path.join(__dirname, '..', 'docker', 'bacnet-sc', 'certs');
const fixtureCertDir = path.join(__dirname, '..', 'test', 'fixtures', 'sc-certs');
const deviceInstance = Number(process.env.BACNET_SC_FIXTURE_DEVICE_INSTANCE || 777001);
const analogObject = {
  type: Number(process.env.BACNET_SC_FIXTURE_ANALOG_TYPE || baEnum.ObjectType.ANALOG_VALUE),
  instance: Number(process.env.BACNET_SC_FIXTURE_ANALOG_INSTANCE || 1)
};
const trendObject = {
  type: Number(process.env.BACNET_SC_FIXTURE_TREND_TYPE || baEnum.ObjectType.TREND_LOG),
  instance: Number(process.env.BACNET_SC_FIXTURE_TREND_INSTANCE || 1)
};
const expectedInitialValue = Number(process.env.BACNET_SC_FIXTURE_INITIAL_VALUE || 12.5);
const writeValue = Number(process.env.BACNET_SC_FIXTURE_WRITE_VALUE || 42.25);
const expectedTrendValues = (process.env.BACNET_SC_FIXTURE_TREND_VALUES || '1.25,2.5,3.75')
  .split(',')
  .map((value) => Number(value.trim()));
const connectTimeout = Number(process.env.BACNET_SC_CONNECT_TIMEOUT || 15000);
const webSocketTimeout = Number(process.env.BACNET_SC_WEBSOCKET_TIMEOUT || 120000);
const apduTimeout = Number(process.env.BACNET_SC_APDU_TIMEOUT || 10000);
const hubUrl = process.env.BACNET_SC_HUB_URL || 'ws://localhost:4443';

function certPath(name, fixtureName) {
  const envValue = process.env['BACNET_SC_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_')];
  const generated = path.join(certDir, name);
  if (envValue) return envValue;
  if (fs.existsSync(generated)) return generated;
  return path.join(fixtureCertDir, fixtureName || name);
}

function waitForEvent(client, event, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for ' + event));
    }, timeout || 10000);
    function cleanup() {
      clearTimeout(timer);
      client.removeListener(event, onEvent);
      client.removeListener('error', onError);
    }
    function onEvent(value) {
      cleanup();
      resolve(value);
    }
    function onError(err) {
      cleanup();
      reject(err);
    }
    client.once(event, onEvent);
    if (event !== 'error') client.once('error', onError);
  });
}

function readProperty(client, address, objectId, propertyId) {
  return new Promise((resolve, reject) => {
    client.readProperty(address, objectId, propertyId, (err, value) => {
      if (err) return reject(err);
      resolve(value);
    });
  });
}

function readPropertyMultiple(client, address) {
  return new Promise((resolve, reject) => {
    client.readPropertyMultiple(address, [{
      objectId: analogObject,
      properties: [{id: baEnum.PropertyIdentifier.PRESENT_VALUE}]
    }, {
      objectId: {type: baEnum.ObjectType.DEVICE, instance: deviceInstance},
      properties: [{id: baEnum.PropertyIdentifier.OBJECT_NAME}]
    }], (err, value) => {
      if (err) return reject(err);
      resolve(value);
    });
  });
}

function writeProperty(client, address, value) {
  return new Promise((resolve, reject) => {
    client.writeProperty(address, analogObject, baEnum.PropertyIdentifier.PRESENT_VALUE, [
      {type: baEnum.ApplicationTags.REAL, value: value}
    ], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function readRange(client, address) {
  return new Promise((resolve, reject) => {
    client.readRange(address, trendObject, 1, expectedTrendValues.length, (err, value) => {
      if (err) return reject(err);
      resolve(value);
    });
  });
}

function applicationValues(values) {
  return values.map((value) => value.value);
}

function decodeRangeValues(rangeBuffer) {
  const values = [];
  let offset = 0;
  while (offset < rangeBuffer.length) {
    const decoded = baAsn1.bacappDecodeApplicationData(
      rangeBuffer,
      offset,
      rangeBuffer.length,
      baEnum.ObjectType.TREND_LOG,
      baEnum.PropertyIdentifier.LOG_BUFFER
    );
    if (!decoded) throw new Error('Unable to decode ReadRange item at offset ' + offset);
    offset += decoded.len;
    values.push(decoded.value);
  }
  return values;
}

function assertNear(actual, expected, label) {
  assert(Math.abs(actual - expected) < 0.00001, label + ': expected ' + expected + ', got ' + actual);
}

function assertArrayNear(actual, expected, label) {
  assert.strictEqual(actual.length, expected.length, label + ': length');
  actual.forEach((value, index) => assertNear(value, expected[index], label + '[' + index + ']'));
}

const client = new bacnet({
  transport: 'bacnet-sc',
  hubUrl: hubUrl,
  vmac: process.env.BACNET_SC_VMAC || '02000000c101',
  uuid: process.env.BACNET_SC_UUID || '02000000-c101-4222-8333-02000000c101',
  cert: certPath('node-bacstack.pem', 'client.pem'),
  key: certPath('node-bacstack.key', 'client.key'),
  ca: certPath('ca.pem', 'ca.pem'),
  connectionWaitTimeout: connectTimeout,
  webSocketWaitTimeout: webSocketTimeout,
  apduTimeout: apduTimeout,
  allowPlain: hubUrl.indexOf('ws://') === 0 || process.env.BACNET_SC_ALLOW_PLAIN === 'true',
  reconnect: false
});

waitForEvent(client, 'open', webSocketTimeout + connectTimeout + 5000)
  .then(() => {
    const discovered = waitForEvent(client, 'iAm', Number(process.env.BACNET_SC_DISCOVERY_TIMEOUT || 15000));
    client.whoIs({lowLimit: deviceInstance, highLimit: deviceInstance});
    return discovered;
  })
  .then((device) => {
    assert.strictEqual(device.deviceId, deviceInstance, 'fixture device instance');
    assert.strictEqual(device.address, process.env.BACNET_SC_FIXTURE_VMAC || '777777777001', 'fixture VMAC');
    console.log('discovered Java fixture device ' + device.deviceId + ' at ' + device.address);
    return readProperty(client, device.address, analogObject, baEnum.PropertyIdentifier.PRESENT_VALUE)
      .then((value) => {
        const values = applicationValues(value.values);
        assert.strictEqual(values.length, 1, 'ReadProperty value count');
        assertNear(values[0], expectedInitialValue, 'ReadProperty Present_Value');
        console.log('ReadProperty Present_Value=' + values[0]);
        return readPropertyMultiple(client, device.address);
      })
      .then((value) => {
        assert.strictEqual(value.values.length, 2, 'RPM object count');
        const presentValue = value.values[0].values[0].value[0].value;
        const objectName = value.values[1].values[0].value[0].value;
        assertNear(presentValue, expectedInitialValue, 'RPM Present_Value');
        assert.strictEqual(objectName, 'JavaFixture-' + deviceInstance, 'RPM Object_Name');
        console.log('ReadPropertyMultiple Present_Value=' + presentValue + ' Object_Name=' + objectName);
        return writeProperty(client, device.address, writeValue);
      })
      .then(() => readProperty(client, device.address, analogObject, baEnum.PropertyIdentifier.PRESENT_VALUE))
      .then((value) => {
        const values = applicationValues(value.values);
        assertNear(values[0], writeValue, 'WriteProperty readback');
        console.log('WriteProperty readback Present_Value=' + values[0]);
        return readRange(client, device.address);
      })
      .then((range) => {
        assert.strictEqual(range.itemCount, expectedTrendValues.length, 'ReadRange itemCount');
        const values = decodeRangeValues(range.rangeBuffer);
        assertArrayNear(values, expectedTrendValues, 'ReadRange values');
        console.log('ReadRange values=' + values.join(','));
      });
  })
  .then(() => {
    client.close();
  })
  .catch((err) => {
    client.close();
    console.error(err.stack || err.message);
    process.exitCode = 1;
  });
