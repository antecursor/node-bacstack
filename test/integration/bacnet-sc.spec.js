'use strict';

const path = require('path');

const expect = require('chai').expect;
const baEnum = require('../../lib/enum');
const baServices = require('../../lib/services');
const {
  CERT_DIR,
  MockScHub,
  createClient,
  waitForEvent
} = require('../support/mock-sc-hub');

const TEST_OBJECT = {type: baEnum.ObjectType.ANALOG_VALUE, instance: 1};
const TEST_TREND = {type: baEnum.ObjectType.TREND_LOG, instance: 1};

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

function sendReadRangeResponse(reply, objectId) {
  const rangeBuffer = Buffer.from([0x21, 0x01, 0x21, 0x02]);
  reply.complexAck((buffer) => baServices.readRange.encodeAcknowledge(
    buffer,
    objectId,
    baEnum.PropertyIdentifier.LOG_BUFFER,
    baEnum.ASN1_ARRAY_ALL,
    {bitsUsed: 3, value: [0]},
    2,
    rangeBuffer,
    baEnum.ReadRangeType.BY_POSITION,
    1
  ));
}

function installResponder(device) {
  let presentValue = 12.5;
  device.on('whoIs', () => {
    device.iAmResponse(555003, baEnum.Segmentation.NO_SEGMENTATION, 999);
  });
  device.on('readProperty', (event) => {
    event.reply.readProperty(event.request.objectId, event.request.property, [
      {type: baEnum.ApplicationTags.REAL, value: presentValue}
    ]);
  });
  device.on('readPropertyMultiple', (event) => {
    event.reply.readPropertyMultiple([{
      objectId: TEST_OBJECT,
      values: [{
        property: {id: baEnum.PropertyIdentifier.PRESENT_VALUE, index: baEnum.ASN1_ARRAY_ALL},
        value: [{type: baEnum.ApplicationTags.REAL, value: presentValue}]
      }]
    }]);
  });
  device.on('writeProperty', (event) => {
    presentValue = event.request.value.value[0].value;
    event.reply.simpleAck();
  });
  device.on('readRange', (event) => {
    sendReadRangeResponse(event.reply, event.request.objectId);
  });
}

describe('bacstack - BACnet/SC integration', function() {
  this.timeout(10000);

  let hub;
  let clients;
  let extraHubs;

  beforeEach(() => {
    clients = [];
    extraHubs = [];
    hub = new MockScHub();
    return hub.start();
  });

  afterEach(() => {
    clients.forEach((client) => client.close());
    return Promise.all([hub].concat(extraHubs).map((item) => item.close()));
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

  it('negotiates TLS 1.3 with the default BACnet/SC TLS settings', () => {
    const client = createClient(hub, '020000000001');
    clients.push(client);

    return waitForEvent(client, 'open').then(() => {
      const peer = hub.peers['020000000001'];
      expect(peer.socket.authorized).to.equal(true);
      expect(peer.socket.getProtocol()).to.equal('TLSv1.3');
      expect(client._transport._socket._socket.authorized).to.equal(true);
      expect(client._transport._socket._socket.getProtocol()).to.equal('TLSv1.3');
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

  it('rejects a hub certificate that is not trusted by the configured CA set', () => {
    const client = createClient(hub, '020000000001', {
      ca: [],
      reconnect: false
    });
    clients.push(client);

    return waitForEvent(client, 'error').then((err) => {
      expect(err.code).to.equal('BACNET_SC_CA_REQUIRED');
      expect(err.message).to.match(/site CA certificate/i);
      expect(client.getTransportStatus().connected).to.equal(false);
    });
  });

  it('rejects a hub certificate for the wrong configured TLS server name', () => {
    const client = createClient(hub, '020000000001', {
      servername: 'wrong-host.invalid',
      reconnect: false
    });
    clients.push(client);

    return waitForEvent(client, 'error').then((err) => {
      expect(err.code).to.equal('BACNET_SC_SOCKET_ERROR');
      expect(err.message).to.match(/hostname|IP|altnames/i);
      expect(client.getTransportStatus().connected).to.equal(false);
    });
  });

  it('rejects a client certificate paired with the wrong private key', () => {
    const client = createClient(hub, '020000000001', {
      key: path.join(CERT_DIR, 'server.key'),
      reconnect: false
    });
    clients.push(client);

    return waitForEvent(client, 'error').then((err) => {
      expect(err.message).to.match(/key values mismatch|private key/i);
      expect(client.getTransportStatus().connected).to.equal(false);
    });
  });

  it('rejects a hub that omits the required BACnet/SC WebSocket subprotocol', () => {
    hub.subprotocol = null;
    const client = createClient(hub, '020000000001', {reconnect: false});
    clients.push(client);

    return waitForEvent(client, 'error').then((err) => {
      expect(err.code).to.equal('BACNET_SC_WEBSOCKET_PROTOCOL_MISMATCH');
      expect(client.getTransportStatus().connected).to.equal(false);
    });
  });

  it('rejects a text frame with an RFC6455 Close frame using status 1003', () => {
    const client = createClient(hub, '020000000001', {reconnect: false});
    clients.push(client);

    return waitForEvent(client, 'open').then(() => {
      const peer = hub.peers['020000000001'];
      const error = waitForEvent(client, 'error');
      const socketClosed = waitForEvent(peer, 'socket-close');
      peer.sendText('not a BACnet/SC message');
      return Promise.all([error, socketClosed]).then((results) => ({
        err: results[0],
        peer: peer
      }));
    }).then(({err, peer}) => {
      expect(err.code).to.equal('BACNET_SC_TEXT_MESSAGE');
      expect(peer.receivedCloseCode).to.equal(1003);
      expect(peer.receivedCloseReason).to.be.a('string');
    });
  });

  it('completes BACnet and WebSocket close handshakes on manual close', () => {
    const client = createClient(hub, '020000000001', {reconnect: false});
    clients.push(client);

    return waitForEvent(client, 'open').then(() => {
      const peer = hub.peers['020000000001'];
      const closeFrame = waitForEvent(peer, 'close-frame');
      const socketClosed = waitForEvent(peer, 'socket-close');
      const clientClosed = waitForEvent(client, 'close');
      client.close();
      return Promise.all([closeFrame, socketClosed, clientClosed]).then((results) => ({
        closeFrame: results[0],
        peer: peer
      }));
    }).then(({closeFrame, peer}) => {
      const status = client.getTransportStatus();
      expect(peer.receivedDisconnectRequestId).to.be.within(1, 0xFFFF);
      expect(closeFrame).to.deep.equal({code: 1000, reason: ''});
      expect(peer.receivedCloseCode).to.equal(1000);
      expect(peer.receivedCloseReason).to.equal('');
      expect(status.state).to.equal('idle');
      expect(status.connected).to.equal(false);
      expect(status.webSocketReady).to.equal(false);
      expect(status.peer).to.equal(null);
      expect(status.lastDisconnectedAt).to.be.a('string');
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

  it('keeps failover active while probing and then restores the primary hub', () => {
    const failover = new MockScHub();
    failover.vmac = '02000000abce';
    extraHubs.push(failover);
    hub.subprotocol = null;

    return failover.start().then(() => {
      const client = createClient(hub, '020000000001', {
        hubUrl: undefined,
        hubUrls: [hub.url, failover.url],
        reconnectMin: 20,
        reconnectMax: 40,
        webSocketWaitTimeout: 500
      });
      clients.push(client);
      return waitForEvent(client, 'open', 5000).then((peer) => {
        expect(peer.vmac).to.equal(failover.vmac);
        expect(client.getTransportStatus().hubIndex).to.equal(1);
        hub.subprotocol = 'hub.bsc.bacnet.org';
        return waitForEvent(client, 'open', 5000);
      }).then((peer) => {
        const status = client.getTransportStatus();
        expect(peer.vmac).to.equal(hub.vmac);
        expect(status.hubIndex).to.equal(0);
        expect(status.connected).to.equal(true);
        expect(status.primaryProbe).to.equal(null);
      });
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
