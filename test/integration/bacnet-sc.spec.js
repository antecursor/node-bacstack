'use strict';

const crypto = require('crypto');
const EventEmitter = require('events').EventEmitter;
const fs = require('fs');
const path = require('path');
const tls = require('tls');

const expect = require('chai').expect;
const bacnet = require('../../');
const baApdu = require('../../lib/apdu');
const baBvlc = require('../../lib/bvlc');
const baEnum = require('../../lib/enum');
const baNpdu = require('../../lib/npdu');
const baServices = require('../../lib/services');
const sc = require('../../lib/bacnet-sc/message');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CERT_DIR = path.join(__dirname, '..', 'fixtures', 'sc-certs');
const TEST_OBJECT = {type: baEnum.ObjectType.ANALOG_VALUE, instance: 1};
const TEST_TREND = {type: baEnum.ObjectType.TREND_LOG, instance: 1};

function readFixture(name) {
  return fs.readFileSync(path.join(CERT_DIR, name));
}

function websocketAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function waitForEvent(emitter, event, timeout) {
  timeout = timeout || 3000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for ' + event));
    }, timeout);
    function cleanup() {
      clearTimeout(timer);
      emitter.removeListener(event, onEvent);
      emitter.removeListener('error', onError);
    }
    function onEvent(value) {
      cleanup();
      resolve(value);
    }
    function onError(err) {
      cleanup();
      reject(err);
    }
    emitter.once(event, onEvent);
    if (event !== 'error') emitter.once('error', onError);
  });
}

function readClientFrame(buffer) {
  let offset = 2;
  const opcode = buffer[0] & 0x0F;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7F;
  let mask;
  let payload;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    if (buffer.readUInt32BE(offset) !== 0) throw new Error('Frame too large');
    length = buffer.readUInt32BE(offset + 4);
    offset += 8;
  }
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  payload = Buffer.from(buffer.slice(offset, offset + length));
  if (masked) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return {
    opcode: opcode,
    payload: payload,
    remaining: buffer.slice(offset + length)
  };
}

function writeServerFrame(socket, opcode, payload) {
  let header;
  payload = payload || Buffer.alloc(0);
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

class MockScPeer extends EventEmitter {
  constructor(hub, socket) {
    super();
    this.hub = hub;
    this.socket = socket;
    this.handshakeBuffer = Buffer.alloc(0);
    this.frameBuffer = Buffer.alloc(0);
    this.ready = false;
    this.vmac = null;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this.hub.removePeer(this));
  }

  close() {
    this.socket.destroy();
  }

  sendMessage(message) {
    writeServerFrame(this.socket, 0x02, sc.encode(message.function, message));
  }

  _onData(chunk) {
    if (!this.ready) return this._readHandshake(chunk);
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    this._readFrames();
  }

  _readHandshake(chunk) {
    const marker = '\r\n\r\n';
    const headers = {};
    let headerEnd;
    let lines;

    this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
    headerEnd = this.handshakeBuffer.indexOf(marker);
    if (headerEnd === -1) return;
    lines = this.handshakeBuffer.slice(0, headerEnd).toString('utf8').split('\r\n');
    lines.shift();
    lines.forEach((line) => {
      const index = line.indexOf(':');
      if (index !== -1) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
    });
    this.socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + websocketAccept(headers['sec-websocket-key']),
      'Sec-WebSocket-Protocol: hub.bsc.bacnet.org',
      '\r\n'
    ].join('\r\n'));
    this.ready = true;
    this.frameBuffer = this.handshakeBuffer.slice(headerEnd + marker.length);
    this.handshakeBuffer = Buffer.alloc(0);
    this._readFrames();
  }

  _readFrames() {
    let frame;
    while ((frame = readClientFrame(this.frameBuffer))) {
      this.frameBuffer = frame.remaining;
      if (frame.opcode === 0x02) this._handleMessage(sc.decode(frame.payload));
      if (frame.opcode === 0x08) this.socket.end();
    }
  }

  _handleMessage(message) {
    let connect;

    if (message.function === sc.FUNCTIONS.CONNECT_REQUEST) {
      connect = sc.decodeConnectPayload(message.payload);
      this.vmac = connect.vmac;
      this.hub.addPeer(this);
      this.sendMessage({
        function: sc.FUNCTIONS.CONNECT_ACCEPT,
        id: message.id,
        payload: sc.encodeConnectPayload({
          vmac: this.hub.vmac,
          uuid: this.hub.uuid,
          maxBvlc: 1600,
          maxNpdu: 1497
        })
      });
      return;
    }
    if (message.function === sc.FUNCTIONS.HEARTBEAT_REQUEST) {
      this.sendMessage({function: sc.FUNCTIONS.HEARTBEAT_ACK, id: message.id});
      return;
    }
    if (message.function === sc.FUNCTIONS.DISCONNECT_REQUEST) {
      this.sendMessage({function: sc.FUNCTIONS.DISCONNECT_ACK, id: message.id});
      this.socket.end();
      return;
    }
    if (message.function === sc.FUNCTIONS.ENCAPSULATED_NPDU) {
      this.hub.route(this, message);
    }
  }
}

class MockScHub {
  constructor() {
    this.vmac = '02000000abcd';
    this.uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    this.peers = {};
    this.server = tls.createServer({
      key: readFixture('server.key'),
      cert: readFixture('server.pem'),
      ca: readFixture('ca.pem'),
      requestCert: true,
      rejectUnauthorized: true
    }, (socket) => new MockScPeer(this, socket));
  }

  start() {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.url = 'wss://localhost:' + this.server.address().port;
        resolve();
      });
    });
  }

  close() {
    Object.keys(this.peers).forEach((key) => this.peers[key].close());
    return new Promise((resolve) => this.server.close(resolve));
  }

  addPeer(peer) {
    this.peers[peer.vmac] = peer;
  }

  removePeer(peer) {
    if (peer.vmac && this.peers[peer.vmac] === peer) delete this.peers[peer.vmac];
  }

  dropConnections() {
    Object.keys(this.peers).forEach((key) => this.peers[key].close());
  }

  route(source, message) {
    if (message.destination === sc.BROADCAST_VMAC) {
      Object.keys(this.peers).forEach((key) => {
        if (this.peers[key] !== source) {
          this.peers[key].sendMessage({
            function: sc.FUNCTIONS.ENCAPSULATED_NPDU,
            id: message.id,
            originating: source.vmac,
            destination: sc.BROADCAST_VMAC,
            payload: message.payload
          });
        }
      });
      return;
    }
    if (this.peers[message.destination]) {
      this.peers[message.destination].sendMessage({
        function: sc.FUNCTIONS.ENCAPSULATED_NPDU,
        id: message.id,
        originating: source.vmac,
        payload: message.payload
      });
    }
  }
}

function createClient(hub, vmac, options) {
  options = options || {};
  return new bacnet(Object.assign({
    transport: 'bacnet-sc',
    hubUrl: hub.url,
    vmac: vmac,
    uuid: vmac.slice(0, 8) + '-1111-4222-8333-' + vmac.slice(0, 12),
    cert: path.join(CERT_DIR, 'client.pem'),
    key: path.join(CERT_DIR, 'client.key'),
    ca: path.join(CERT_DIR, 'ca.pem'),
    apduTimeout: 1000,
    heartbeatInterval: 200,
    reconnectMin: 100,
    reconnectMax: 200
  }, options));
}

function readProperty(client, address) {
  return new Promise((resolve, reject) => {
    client.readProperty(address, TEST_OBJECT, baEnum.PropertyIdentifier.PRESENT_VALUE, (err, value) => {
      if (err) return reject(err);
      resolve(value);
    });
  });
}

function readPropertyMultiple(client, address) {
  return new Promise((resolve, reject) => {
    client.readPropertyMultiple(address, [{
      objectId: TEST_OBJECT,
      properties: [{id: baEnum.PropertyIdentifier.PRESENT_VALUE}]
    }], (err, value) => {
      if (err) return reject(err);
      resolve(value);
    });
  });
}

function writeProperty(client, address, value) {
  return new Promise((resolve, reject) => {
    client.writeProperty(address, TEST_OBJECT, baEnum.PropertyIdentifier.PRESENT_VALUE, [
      {type: baEnum.ApplicationTags.REAL, value: value}
    ], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function readRange(client, address) {
  return new Promise((resolve, reject) => {
    client.readRange(address, TEST_TREND, 1, 2, (err, value) => {
      if (err) return reject(err);
      resolve(value);
    });
  });
}

function sendReadRangeResponse(client, receiver, invokeId, objectId) {
  const buffer = {
    buffer: Buffer.alloc(client._transport.getMaxPayload()),
    offset: baEnum.BVLC_HEADER_LENGTH
  };
  const rangeBuffer = Buffer.from([0x21, 0x01, 0x21, 0x02]);
  baNpdu.encode(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE, receiver);
  baApdu.encodeComplexAck(buffer, baEnum.PduTypes.COMPLEX_ACK, baEnum.ConfirmedServiceChoice.READ_RANGE, invokeId);
  baServices.readRange.encodeAcknowledge(buffer, objectId, baEnum.PropertyIdentifier.LOG_BUFFER, baEnum.ASN1_ARRAY_ALL, {bitsUsed: 8, value: [0]}, 2, rangeBuffer, baEnum.ReadRangeType.BY_POSITION, 1);
  baBvlc.encode(buffer.buffer, baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU, buffer.offset);
  client._transport.send(buffer.buffer, buffer.offset, receiver);
}

function installResponder(device) {
  let presentValue = 12.5;
  device.on('whoIs', () => {
    device.iAmResponse(555003, baEnum.Segmentation.NO_SEGMENTATION, 999);
  });
  device.on('readProperty', (event) => {
    device.readPropertyResponse(event.address, event.invokeId, event.request.objectId, event.request.property, [
      {type: baEnum.ApplicationTags.REAL, value: presentValue}
    ]);
  });
  device.on('readPropertyMultiple', (event) => {
    device.readPropertyMultipleResponse(event.address, event.invokeId, [{
      objectId: TEST_OBJECT,
      values: [{
        property: {id: baEnum.PropertyIdentifier.PRESENT_VALUE, index: baEnum.ASN1_ARRAY_ALL},
        value: [{type: baEnum.ApplicationTags.REAL, value: presentValue}]
      }]
    }]);
  });
  device.on('writeProperty', (event) => {
    presentValue = event.request.value.value[0].value;
    device.simpleAckResponse(event.address, baEnum.ConfirmedServiceChoice.WRITE_PROPERTY, event.invokeId);
  });
  device.on('readRange', (event) => {
    sendReadRangeResponse(device, event.address, event.invokeId, event.request.objectId);
  });
}

describe('bacstack - BACnet/SC integration', function() {
  this.timeout(10000);

  let hub;
  let clients;

  beforeEach(() => {
    clients = [];
    hub = new MockScHub();
    return hub.start();
  });

  afterEach(() => {
    clients.forEach((client) => client.close());
    return hub.close();
  });

  it('connects to a BACnet/SC hub over WebSocket/TLS with mTLS', () => {
    const client = createClient(hub, '020000000001', {
      ca: [path.join(CERT_DIR, 'ca.pem')]
    });
    clients.push(client);
    return waitForEvent(client, 'open').then((peer) => {
      const status = client.getTransportStatus();
      expect(peer.vmac).to.equal(hub.vmac);
      expect(status.connected).to.equal(true);
      expect(status.peer.vmac).to.equal(hub.vmac);
      expect(status.pendingSends).to.equal(0);
    });
  });

  it('fails fast without a configured client certificate', () => {
    const client = createClient(hub, '020000000001', {
      cert: undefined,
      key: undefined,
      reconnect: false
    });
    clients.push(client);
    return waitForEvent(client, 'error').then((err) => {
      expect(err.code).to.equal('BACNET_SC_CLIENT_CERT_REQUIRED');
    });
  });

  it('fails over to the next configured hub without emitting a transient error', () => {
    const diagnostics = [];
    const client = createClient(hub, '020000000001', {
      hubUrl: undefined,
      hubUrls: ['wss://127.0.0.1:1', hub.url],
      reconnectMin: 10,
      reconnectMax: 20,
      webSocketWaitTimeout: 500
    });
    clients.push(client);
    client.on('diagnostic', (event) => diagnostics.push(event));
    return waitForEvent(client, 'open', 5000).then((peer) => {
      const status = client.getTransportStatus();
      expect(peer.vmac).to.equal(hub.vmac);
      expect(status.hubUrl).to.equal(hub.url);
      expect(status.hubIndex).to.equal(1);
      expect(diagnostics.some((event) => event.code === 'reconnect')).to.equal(true);
      expect(status.lastError.code).to.equal('BACNET_SC_SOCKET_ERROR');
    });
  });

  it('routes Who-Is/I-Am, ReadProperty, RPM, WriteProperty/readback, and ReadRange', () => {
    const requester = createClient(hub, '020000000001');
    const device = createClient(hub, '020000000002');
    let deviceAddress;
    clients.push(requester, device);

    return Promise.all([waitForEvent(requester, 'open'), waitForEvent(device, 'open')])
      .then(() => {
        installResponder(device);
        const discovered = waitForEvent(requester, 'iAm');
        requester.whoIs();
        return discovered;
      })
      .then((iam) => {
        expect(iam.deviceId).to.equal(555003);
        deviceAddress = iam.address;
        return readProperty(requester, deviceAddress);
      })
      .then((value) => {
        expect(value.values[0].value).to.equal(12.5);
        return readPropertyMultiple(requester, deviceAddress);
      })
      .then((value) => {
        expect(value.values[0].values[0].value[0].value).to.equal(12.5);
        return writeProperty(requester, deviceAddress, 44.25);
      })
      .then(() => readProperty(requester, deviceAddress))
      .then((value) => {
        expect(value.values[0].value).to.equal(44.25);
        return readRange(requester, deviceAddress);
      })
      .then((value) => {
        expect(value.itemCount).to.equal(2);
        expect(value.rangeBuffer).to.deep.equal(Buffer.from([0x21, 0x01, 0x21, 0x02]));
      });
  });

  it('reconnects after a hub-side connection drop', () => {
    const client = createClient(hub, '020000000001');
    clients.push(client);
    return waitForEvent(client, 'open')
      .then(() => {
        const reconnected = waitForEvent(client, 'open', 5000);
        hub.dropConnections();
        return reconnected;
      })
      .then((peer) => {
        expect(peer.vmac).to.equal(hub.vmac);
      });
  });
});
