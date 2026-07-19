'use strict';

const fs = require('fs');
const path = require('path');
const bacnet = require('../');

const certDir = path.join(__dirname, '..', 'docker', 'bacnet-sc', 'certs');
const fixtureCertDir = path.join(__dirname, '..', 'test', 'fixtures', 'sc-certs');
const writeEnabled = process.env.BACNET_SC_ENABLE_WRITE === 'true';
let activeOperation = 'startup';

function numberSetting(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(name + ' must be a finite number');
  return value;
}

function booleanSetting(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(name + ' must be exactly "true" or "false"');
  }
  return raw === 'true';
}

function plainWebSocketSetting(hubUrl) {
  let url;
  try {
    url = new URL(hubUrl);
  } catch (err) {
    throw new Error(
      'BACNET_SC_HUB_URL must be a valid ws:// or wss:// URL: ' + err.message,
      {cause: err}
    );
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('BACNET_SC_HUB_URL must use ws:// or wss://');
  }

  const allowPlain = booleanSetting('BACNET_SC_ALLOW_PLAIN', false);
  if (url.protocol === 'ws:' && !allowPlain) {
    throw new Error('A ws:// BACNET_SC_HUB_URL requires BACNET_SC_ALLOW_PLAIN=true');
  }
  if (url.protocol !== 'ws:' && allowPlain) {
    throw new Error('BACNET_SC_ALLOW_PLAIN=true is only valid with a ws:// fixture URL');
  }
  return allowPlain;
}

function requiredSetting(name) {
  const value = process.env[name];
  if (value == null || value === '') throw new Error('Write mode requires ' + name);
  return value;
}

function validateInteger(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(name + ' must be an integer from ' + minimum + ' through ' + maximum);
  }
}

function validateWriteSettings() {
  const setting = process.env.BACNET_SC_ENABLE_WRITE;
  if (setting != null && setting !== 'true' && setting !== 'false') {
    throw new Error('BACNET_SC_ENABLE_WRITE must be exactly "true" or "false"');
  }
  if (!writeEnabled) return;

  [
    'BACNET_SC_DEVICE_INSTANCE',
    'BACNET_SC_TARGET_ADDRESS',
    'BACNET_SC_OBJECT_TYPE',
    'BACNET_SC_OBJECT_INSTANCE',
    'BACNET_SC_PROPERTY_ID',
    'BACNET_SC_WRITE_VALUE',
    'BACNET_SC_WRITE_PRIORITY'
  ].forEach(requiredSetting);
}

function writeConfiguration() {
  if (!writeEnabled) return null;
  const targetAddress = requiredSetting('BACNET_SC_TARGET_ADDRESS').toLowerCase();
  const priority = numberSetting('BACNET_SC_WRITE_PRIORITY');

  if (!/^[0-9a-f]{12}$/.test(targetAddress)) {
    throw new Error('BACNET_SC_TARGET_ADDRESS must be exactly 12 hexadecimal characters');
  }
  if (!Number.isInteger(priority) || priority < 1 || priority > 16) {
    throw new Error('BACNET_SC_WRITE_PRIORITY must be an integer from 1 through 16');
  }
  const value = numberSetting('BACNET_SC_WRITE_VALUE');
  if (!Number.isFinite(Math.fround(value))) {
    throw new Error('BACNET_SC_WRITE_VALUE must fit in a finite BACnet REAL');
  }
  return {
    targetAddress: targetAddress,
    value: value,
    priority: priority
  };
}

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
      reject(new Error('timed out waiting for event "' + event + '"'));
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

function readProperty(client, address, objectId, propertyId) {
  return new Promise((resolve, reject) => {
    client.readProperty(address, objectId, propertyId, (err, value) => {
      if (err) return reject(err);
      resolve(value);
    });
  });
}

function writeProperty(client, address, objectId, propertyId, value, priority) {
  return new Promise((resolve, reject) => {
    client.writeProperty(address, objectId, propertyId, [
      {type: bacnet.enum.ApplicationTags.REAL, value: value}
    ], {priority: priority}, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function readRange(client, address, objectId) {
  return new Promise((resolve, reject) => {
    client.readRange(address, objectId, 1, 10, (err, value) => {
      if (err) return reject(err);
      resolve(value);
    });
  });
}

async function operation(name, action) {
  activeOperation = name;
  try {
    return await action();
  } catch (err) {
    const wrapped = new Error(name + ' failed: ' + err.message);
    wrapped.cause = err;
    throw wrapped;
  }
}

async function main() {
  validateWriteSettings();
  const write = writeConfiguration();

  const objectId = {
    type: numberSetting('BACNET_SC_OBJECT_TYPE', bacnet.enum.ObjectType.ANALOG_VALUE),
    instance: numberSetting('BACNET_SC_OBJECT_INSTANCE', 1)
  };
  const trendObjectId = {
    type: numberSetting('BACNET_SC_TREND_OBJECT_TYPE', bacnet.enum.ObjectType.TREND_LOG),
    instance: numberSetting('BACNET_SC_TREND_OBJECT_INSTANCE', 1)
  };
  const propertyId = numberSetting('BACNET_SC_PROPERTY_ID', bacnet.enum.PropertyIdentifier.PRESENT_VALUE);
  const deviceInstance = numberSetting('BACNET_SC_DEVICE_INSTANCE', undefined);
  const connectTimeout = numberSetting('BACNET_SC_CONNECT_TIMEOUT', 15000);
  const webSocketTimeout = numberSetting('BACNET_SC_WEBSOCKET_TIMEOUT', 60000);
  const hubUrl = process.env.BACNET_SC_HUB_URL || 'wss://localhost:4443';
  const allowPlain = plainWebSocketSetting(hubUrl);

  if (write) {
    validateInteger('BACNET_SC_DEVICE_INSTANCE', deviceInstance, 0, 4194303);
    validateInteger('BACNET_SC_OBJECT_TYPE', objectId.type, 0, 1023);
    validateInteger('BACNET_SC_OBJECT_INSTANCE', objectId.instance, 0, 4194303);
    validateInteger('BACNET_SC_PROPERTY_ID', propertyId, 0, 4294967295);
  }

  const client = new bacnet({
    transport: 'bacnet-sc',
    hubUrl: hubUrl,
    allowPlain: allowPlain,
    vmac: process.env.BACNET_SC_VMAC || '020000000101',
    uuid: process.env.BACNET_SC_UUID || '02000000-0101-4222-8333-020000000101',
    cert: certPath('node-bacstack.pem', 'client.pem'),
    key: certPath('node-bacstack.key', 'client.key'),
    ca: certPath('ca.pem', 'ca.pem'),
    connectionWaitTimeout: connectTimeout,
    webSocketWaitTimeout: webSocketTimeout,
    apduTimeout: numberSetting('BACNET_SC_APDU_TIMEOUT', 5000),
    reconnectMin: 1000,
    reconnectMax: 5000
  });

  client.on('error', (err) => {
    console.error('BACnet/SC transport error during ' + activeOperation + ': ' + (err.stack || err.message));
  });

  try {
    await operation('BACnet/SC connection', () => {
      return waitForEvent(client, 'open', webSocketTimeout + connectTimeout + 5000);
    });
    console.log('connected to ' + hubUrl);

    const device = await operation('Who-Is/I-Am discovery', () => {
      const discovered = waitForEvent(
        client,
        'iAm',
        numberSetting('BACNET_SC_DISCOVERY_TIMEOUT', 10000)
      );
      client.whoIs({lowLimit: deviceInstance, highLimit: deviceInstance});
      return discovered;
    });
    console.log('discovered device ' + device.deviceId + ' at ' + device.address);

    if (deviceInstance != null && device.deviceId !== deviceInstance) {
      throw new Error('Discovery returned unexpected device instance ' + device.deviceId);
    }

    const value = await operation('ReadProperty', () => {
      return readProperty(client, device.address, objectId, propertyId);
    });
    console.log('property value:', JSON.stringify(value.values));

    if (write) {
      if (String(device.address).toLowerCase() !== write.targetAddress) {
        throw new Error(
          'Refusing WriteProperty: discovered address ' + device.address +
          ' does not match BACNET_SC_TARGET_ADDRESS=' + write.targetAddress
        );
      }

      await operation('WriteProperty', () => {
        return writeProperty(client, device.address, objectId, propertyId, write.value, write.priority);
      });
      const readback = await operation('WriteProperty readback', () => {
        return readProperty(client, device.address, objectId, propertyId);
      });
      console.log('write readback value:', JSON.stringify(readback.values));
    } else {
      console.log('write skipped (read-only mode; BACNET_SC_ENABLE_WRITE is not true)');
    }

    const range = await operation('ReadRange', () => readRange(client, device.address, trendObjectId));
    console.log('read range itemCount:', range.itemCount);
  } finally {
    activeOperation = 'shutdown';
    client.close();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  if (err.cause && err.cause.stack) console.error('Caused by: ' + err.cause.stack);
  process.exitCode = 1;
});
