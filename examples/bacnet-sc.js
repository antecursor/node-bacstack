'use strict';

const path = require('path');
const fs = require('fs');
const bacnet = require('../');

const certDir = path.join(__dirname, '..', 'docker', 'bacnet-sc', 'certs');
const fixtureCertDir = path.join(__dirname, '..', 'test', 'fixtures', 'sc-certs');
const objectId = {
  type: Number(process.env.BACNET_SC_OBJECT_TYPE || bacnet.enum.ObjectType.ANALOG_VALUE),
  instance: Number(process.env.BACNET_SC_OBJECT_INSTANCE || 1)
};
const trendObjectId = {
  type: Number(process.env.BACNET_SC_TREND_OBJECT_TYPE || bacnet.enum.ObjectType.TREND_LOG),
  instance: Number(process.env.BACNET_SC_TREND_OBJECT_INSTANCE || 1)
};
const propertyId = Number(process.env.BACNET_SC_PROPERTY_ID || bacnet.enum.PropertyIdentifier.PRESENT_VALUE);
const writeValue = Number(process.env.BACNET_SC_WRITE_VALUE || 42);
const connectTimeout = Number(process.env.BACNET_SC_CONNECT_TIMEOUT || 15000);
const webSocketTimeout = Number(process.env.BACNET_SC_WEBSOCKET_TIMEOUT || 60000);

function certPath(name, fixtureName) {
  const envValue = process.env['BACNET_SC_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_')];
  const generated = path.join(certDir, name);
  if (envValue) return envValue;
  if (fs.existsSync(generated)) return generated;
  return path.join(fixtureCertDir, fixtureName || name);
}

function waitForEvent(client, event, timeout) {
  timeout = timeout || 10000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for ' + event));
    }, timeout);
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

function readProperty(client, address) {
  return new Promise((resolve, reject) => {
    client.readProperty(address, objectId, propertyId, (err, value) => {
      if (err) return reject(err);
      resolve(value);
    });
  });
}

function writeProperty(client, address) {
  return new Promise((resolve, reject) => {
    client.writeProperty(address, objectId, propertyId, [
      {type: bacnet.enum.ApplicationTags.REAL, value: writeValue}
    ], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function readRange(client, address) {
  return new Promise((resolve, reject) => {
    client.readRange(address, trendObjectId, 1, 10, (err, value) => {
      if (err) return reject(err);
      resolve(value);
    });
  });
}

const client = new bacnet({
  transport: 'bacnet-sc',
  hubUrl: process.env.BACNET_SC_HUB_URL || 'wss://localhost:4443',
  vmac: process.env.BACNET_SC_VMAC || '020000000101',
  uuid: process.env.BACNET_SC_UUID || '02000000-0101-4222-8333-020000000101',
  cert: certPath('node-bacstack.pem', 'client.pem'),
  key: certPath('node-bacstack.key', 'client.key'),
  ca: certPath('ca.pem', 'ca.pem'),
  connectionWaitTimeout: connectTimeout,
  webSocketWaitTimeout: webSocketTimeout,
  apduTimeout: Number(process.env.BACNET_SC_APDU_TIMEOUT || 5000),
  reconnectMin: 1000,
  reconnectMax: 5000
});

waitForEvent(client, 'open', webSocketTimeout + connectTimeout + 5000)
  .then(() => {
    console.log('connected to ' + (process.env.BACNET_SC_HUB_URL || 'wss://localhost:4443'));
    const discovered = waitForEvent(client, 'iAm', Number(process.env.BACNET_SC_DISCOVERY_TIMEOUT || 10000));
    client.whoIs({
      lowLimit: process.env.BACNET_SC_DEVICE_INSTANCE ? Number(process.env.BACNET_SC_DEVICE_INSTANCE) : undefined,
      highLimit: process.env.BACNET_SC_DEVICE_INSTANCE ? Number(process.env.BACNET_SC_DEVICE_INSTANCE) : undefined
    });
    return discovered;
  })
  .then((device) => {
    console.log('discovered device ' + device.deviceId + ' at ' + device.address);
    return readProperty(client, device.address)
      .then((value) => {
        console.log('present value:', JSON.stringify(value.values));
        return writeProperty(client, device.address);
      })
      .then(() => readProperty(client, device.address))
      .then((value) => {
        console.log('readback value:', JSON.stringify(value.values));
        return readRange(client, device.address);
      })
      .then((range) => {
        console.log('read range itemCount:', range.itemCount);
      })
      .catch((err) => {
        console.log('trend range unavailable or rejected:', err.message);
      });
  })
  .then(() => client.close())
  .catch((err) => {
    client.close();
    console.error(err.stack || err.message);
    process.exitCode = 1;
  });
