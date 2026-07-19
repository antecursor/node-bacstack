'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const EventEmitter = require('events').EventEmitter;
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT_FILES = new Set([
  'ARCHITECTURE.md',
  'BACNET_SC.md',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'FAQ.md',
  'LICENSE.md',
  'README.md',
  'RELEASE.md',
  'SECURITY.md',
  'index.js',
  'package.json'
]);
const REQUIRED_FILES = [
  ...ROOT_FILES,
  'lib/client.js',
  'lib/enum.js',
  'lib/transport-bacnet-sc.js'
];
const READ_PROPERTY_ACK = Buffer.from(
  '810a0021010030000c0c020004d2194d3e750d00736d6f6b652d6465766963653f',
  'hex'
);

function run(command, args, options) {
  const result = childProcess.spawnSync(command, args, Object.assign({
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }, options));
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      command + ' exited with status ' + result.status,
      result.stdout,
      result.stderr
    ].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function isAllowedPackagePath(filePath) {
  if (ROOT_FILES.has(filePath)) return true;
  return filePath.startsWith('lib/') && filePath.endsWith('.js') &&
    !filePath.includes('..') && !filePath.includes('\\');
}

function validatePackageListing(pack) {
  assert(pack && Array.isArray(pack.files), 'npm pack did not return a file listing');
  const paths = pack.files.map((file) => file.path);
  const unexpected = paths.filter((filePath) => !isAllowedPackagePath(filePath));
  assert.deepStrictEqual(unexpected, [], 'package contains files outside the public allowlist');
  REQUIRED_FILES.forEach((filePath) => {
    assert(paths.includes(filePath), 'package is missing required file: ' + filePath);
  });
  assert.strictEqual(new Set(paths).size, paths.length, 'package contains duplicate paths');
  return paths;
}

class SmokeTransport extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
    this.opened = false;
    this.sent = [];
  }

  getAddressKind() {
    return 'ip';
  }

  getBroadcastAddress() {
    return '255.255.255.255';
  }

  getMaxPayload() {
    return 1482;
  }

  open() {
    this.opened = true;
  }

  close() {
    this.closed = true;
  }

  send(buffer, length, receiver) {
    const request = Buffer.from(buffer.subarray(0, length));
    this.sent.push({receiver: receiver, request: request});
    assert(request.length >= 10, 'mocked read request is shorter than its BACnet headers');
    assert.strictEqual(request[0], 0x81, 'mocked read request is not classic BACnet BVLC');
    assert.strictEqual(request[6] & 0xF0, 0x00, 'mocked read request is not a Confirmed-Request');
    const response = Buffer.from(READ_PROPERTY_ACK);
    response[7] = request[8];
    this.emit('message', response, receiver, 47808);
    return true;
  }
}

function validateInstalledApi(api, manifest) {
  assert.strictEqual(typeof api, 'function', 'default export must be the Client constructor');
  assert(api.enum && typeof api.enum === 'object', 'enum export is missing');
  assert(Number.isInteger(api.enum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU),
    'BVLC enum export is missing');
  assert(api.transport && typeof api.transport.BacnetSc === 'function',
    'BACnet/SC transport export is missing');
  assert(api.bacnetSc && typeof api.bacnetSc.encode === 'function',
    'BACnet/SC message encoder export is missing');
  assert.strictEqual(typeof api.bacnetSc.decode, 'function',
    'BACnet/SC message decoder export is missing');

  const transport = new SmokeTransport();
  const client = new api({transport: transport});
  assert(transport.opened, manifest.name + ' did not initialize a custom transport');
  let callbackResult;
  client.readProperty(
    '192.0.2.10',
    {type: api.enum.ObjectType.DEVICE, instance: 1234},
    api.enum.PropertyIdentifier.OBJECT_NAME,
    (error, result) => {
      assert.ifError(error);
      callbackResult = result;
    }
  );
  assert(callbackResult, manifest.name + ' did not complete the mocked read');
  assert.deepStrictEqual(callbackResult.objectId, {
    type: api.enum.ObjectType.DEVICE,
    instance: 1234
  });
  assert.strictEqual(callbackResult.property.id, api.enum.PropertyIdentifier.OBJECT_NAME);
  assert.strictEqual(callbackResult.values[0].value, 'smoke-device');
  assert.strictEqual(transport.sent.length, 1, 'mocked read sent an unexpected frame count');
  assert.strictEqual(transport.sent[0].receiver, '192.0.2.10');
  client.close();
  assert(transport.closed, manifest.name + ' did not close a custom transport');
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bacstack-package-smoke-'));
  try {
    const packOutput = run(npmCommand(), [
      'pack',
      '--json',
      '--pack-destination',
      tempRoot
    ], {cwd: projectRoot});
    const packs = JSON.parse(packOutput);
    assert.strictEqual(packs.length, 1, 'npm pack must produce exactly one tarball');
    const packagedFiles = validatePackageListing(packs[0]);
    const tarball = path.join(tempRoot, packs[0].filename);
    assert(fs.existsSync(tarball), 'npm pack did not create the reported tarball');

    const consumerRoot = path.join(tempRoot, 'consumer');
    fs.mkdirSync(consumerRoot);
    run(npmCommand(), [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarball
    ], {cwd: consumerRoot});
    const installedApi = require(path.join(consumerRoot, 'node_modules', manifest.name));
    validateInstalledApi(installedApi, manifest);

    process.stdout.write(JSON.stringify({
      package: manifest.name + '@' + manifest.version,
      packagedFiles: packagedFiles.length,
      publicApi: 'ok'
    }) + '\n');
  } finally {
    fs.rmSync(tempRoot, {force: true, recursive: true});
  }
}

main();
