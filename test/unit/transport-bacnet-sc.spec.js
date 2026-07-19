'use strict';

const crypto = require('crypto');
const EventEmitter = require('events').EventEmitter;
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const WebSocket = require('ws');
const expect = require('chai').expect;
const baEnum = require('../../lib/enum');
const sc = require('../../lib/bacnet-sc/message');
const BacnetScTransport = require('../../lib/transport-bacnet-sc');

const HUB_PROTOCOL = 'hub.bsc.bacnet.org';
const CERT_DIR = path.join(__dirname, '..', 'fixtures', 'sc-certs');

function createTransport(options) {
  return new BacnetScTransport(Object.assign({
    hubUrl: 'ws://127.0.0.1:47809',
    allowPlain: true,
    reconnect: false
  }, options));
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.protocol = HUB_PROTOCOL;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closeCalls = 0;
    this.closeArguments = [];
    this.terminateCalls = 0;
    this.actions = [];
  }

  send(data, options, callback) {
    this.sent.push(Buffer.from(data));
    this.actions.push({type: 'send', data: Buffer.from(data), options: options});
    if (callback) callback();
  }

  close(code, reason) {
    this.closeCalls++;
    this.closeArguments.push({code: code, reason: reason});
    this.actions.push({type: 'close', code: code, reason: reason});
    this.readyState = WebSocket.CLOSING;
  }

  terminate() {
    this.terminateCalls++;
    this.actions.push({type: 'terminate'});
    this.readyState = WebSocket.CLOSED;
  }
}

class FakeSignal {
  constructor() {
    this.aborted = false;
    this.listeners = new Set();
  }

  addEventListener(name, listener) {
    if (name === 'abort') this.listeners.add(listener);
  }

  removeEventListener(name, listener) {
    if (name === 'abort') this.listeners.delete(listener);
  }

  abort() {
    this.aborted = true;
    Array.from(this.listeners).forEach((listener) => listener());
  }
}

class FakeProbe extends EventEmitter {
  constructor() {
    super();
    this.state = 'idle';
    this.openCalls = 0;
    this.closeCalls = 0;
  }

  getState() {
    return this.state;
  }

  open() {
    this.openCalls++;
    this.state = 'connecting';
    return true;
  }

  close() {
    this.closeCalls++;
    this.state = 'disconnecting';
  }
}

function activate(transport, state, peer) {
  const socket = new FakeSocket();
  transport._socket = socket;
  transport._socketGeneration++;
  transport._webSocketReady = true;
  transport._state = state || 'connected';
  transport._connected = transport._state === 'connected';
  transport._peer = peer || {
    vmac: '02000000abcd',
    uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    maxBvlc: 1600,
    maxNpdu: 1497
  };
  return {socket: socket, generation: transport._socketGeneration};
}

function packet(payload) {
  payload = payload || Buffer.from([0x01]);
  return Buffer.concat([Buffer.alloc(4), payload]);
}

function connectAccept(id, limits) {
  limits = limits || {};
  return sc.encode(sc.FUNCTIONS.CONNECT_ACCEPT, {
    id: id,
    payload: sc.encodeConnectPayload({
      vmac: '02000000abcd',
      uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      maxBvlc: limits.maxBvlc || 1600,
      maxNpdu: limits.maxNpdu || 1497
    })
  });
}

function bvlcResult(id, forFunction, resultCode, errorCode, options) {
  options = options || {};
  return sc.encode(sc.FUNCTIONS.BVLC_RESULT, {
    id: id,
    originating: options.originating,
    destination: options.destination,
    payload: sc.encodeBvlcResultPayload({
      forFunction: forFunction,
      resultCode: resultCode,
      errorHeaderMarker: options.errorHeaderMarker || 0,
      errorClass: options.errorClass == null ? baEnum.ErrorClass.COMMUNICATION : options.errorClass,
      errorCode: errorCode == null ? baEnum.ErrorCode.OTHER : errorCode,
      errorDetails: options.errorDetails || ''
    })
  });
}

function decodeSentResult(socket, index) {
  const message = sc.decode(socket.sent[index == null ? socket.sent.length - 1 : index]);
  return {message: message, result: sc.decodeBvlcResultPayload(message.payload)};
}

function nextTurn() {
  return new Promise((resolve) => process.nextTick(resolve));
}

describe('bacstack - BACnet/SC transport', () => {
  it('validates numeric configuration and related limits', () => {
    expect(() => createTransport({heartbeatInterval: -1}))
      .to.throw('Invalid BACnet/SC heartbeatInterval');
    expect(() => createTransport({heartbeatInterval: 0}))
      .to.throw('Invalid BACnet/SC heartbeatInterval');
    expect(() => createTransport({maxBvlc: 100, maxNpdu: 101}))
      .to.throw('maxNpdu: must not exceed maxBvlc minus the BACnet/SC header');
    expect(() => createTransport({reconnectMin: 20, reconnectMax: 10}))
      .to.throw('reconnectMax: must be greater than or equal to reconnectMin');
    expect(() => createTransport({reconnectMax: 600001}))
      .to.throw('Invalid BACnet/SC reconnectMax');
    expect(() => createTransport({maxBvlc: 100, maxNpdu: 50, maxBufferedAmount: 99}))
      .to.throw('maxBufferedAmount: must be greater than or equal to maxBvlc');
    expect(() => createTransport({sendQueueLimit: 1.5}))
      .to.throw('Invalid BACnet/SC sendQueueLimit');
    expect(() => createTransport({vmac: 'not-a-vmac'}))
      .to.throw('Invalid BACnet/SC identity');
    expect(createTransport()._settings.maxBvlc).to.equal(5705);
    expect(createTransport()._settings.maxNpdu).to.equal(1497);
  });

  it('requires an explicit opt-in before opening plain WebSockets', async() => {
    const errors = [];
    const transport = new BacnetScTransport({
      hubUrl: 'ws://127.0.0.1:47809',
      reconnect: false
    });
    transport.on('error', (err) => errors.push(err));

    transport.open();
    await nextTurn();

    expect(errors[0].code).to.equal('BACNET_SC_PLAIN_WS_DISABLED');
    expect(transport.getState()).to.equal('idle');
  });

  it('does not create a socket when a connecting diagnostic closes the transport', () => {
    const transport = createTransport();
    transport.on('diagnostic', (event) => {
      if (event.code === 'connecting') transport.close();
    });

    expect(transport.open()).to.equal(true);
    expect(transport.getState()).to.equal('idle');
    expect(transport._manualClose).to.equal(true);
    expect(transport._socket).to.equal(null);
  });

  it('never queues a send beyond the APDU transaction timeout', () => {
    const transport = createTransport({
      apduTimeout: 25,
      sendQueueTimeout: 1000
    });

    expect(transport._settings.sendQueueTimeout).to.equal(25);
  });

  it('preserves nested TLS options when top-level TLS values are undefined', () => {
    const cert = Buffer.from('cert');
    const key = Buffer.from('key');
    const ca = Buffer.from('ca');
    const transport = createTransport({
      tlsOptions: {
        cert: cert,
        key: key,
        ca: ca,
        servername: 'fixture.internal',
        rejectUnauthorized: false
      }
    });

    const options = transport._createWebSocketOptions(new URL('wss://localhost:47809'));

    expect(options.cert).to.equal(cert);
    expect(options.key).to.equal(key);
    expect(options.ca).to.equal(ca);
    expect(options.servername).to.equal('fixture.internal');
    expect(options.rejectUnauthorized).to.equal(false);
    expect(options.minVersion).to.equal('TLSv1.3');
    expect(options.maxVersion).to.equal('TLSv1.3');
    expect(options.maxPayload).to.equal(0xFFFF);
    expect(options.maxHeaderSize).to.equal(16 * 1024);
    expect(options.perMessageDeflate).to.equal(false);
  });

  it('requires TLS 1.3 by default and makes lower-version support an explicit insecure opt-in', () => {
    expect(() => createTransport({tlsVersion: 'TLSv1.2'}))
      .to.throw('TLS 1.3 is required unless allowInsecureTls is explicitly enabled');
    expect(() => createTransport({tlsOptions: {minVersion: 'TLSv1.2'}}))
      .to.throw('TLS 1.3 is required unless allowInsecureTls is explicitly enabled');

    const transport = createTransport({
      allowInsecureTls: true,
      allowSystemTrust: true,
      tlsMinVersion: 'TLSv1.2',
      tlsMaxVersion: 'TLSv1.3',
      cert: Buffer.from('cert'),
      key: Buffer.from('key')
    });
    const options = transport._createWebSocketOptions(new URL('wss://hub.example:47809'));

    expect(options.minVersion).to.equal('TLSv1.2');
    expect(options.maxVersion).to.equal('TLSv1.3');
  });

  it('does not synthesize an invalid SNI name from a bracketed IPv6 hub address', () => {
    const transport = createTransport({
      cert: Buffer.from('cert'),
      key: Buffer.from('key'),
      allowSystemTrust: true
    });
    const options = transport._createWebSocketOptions(new URL('wss://[2001:db8::1]:47809'));
    expect(options.servername).to.equal(undefined);

    const explicit = createTransport({
      cert: Buffer.from('cert'),
      key: Buffer.from('key'),
      allowSystemTrust: true,
      servername: 'hub.example'
    })._createWebSocketOptions(new URL('wss://[2001:db8::1]:47809'));
    expect(explicit.servername).to.equal('hub.example');
  });

  it('requires an explicit site CA store for authenticated BACnet/SC TLS', () => {
    const transport = createTransport({
      cert: Buffer.from('cert'),
      key: Buffer.from('key')
    });

    expect(() => transport._createWebSocketOptions(new URL('wss://hub.example:47809')))
      .to.throw('requires an explicitly configured site CA certificate store');
    expect(() => createTransport({allowSystemTrust: 'yes'}))
      .to.throw('allowSystemTrust: expected a boolean');
  });

  it('enforces a configured CA as the direct signer without hostname matching by default', () => {
    const peer = new crypto.X509Certificate(
      fs.readFileSync(path.join(CERT_DIR, 'server.pem'))
    ).toLegacyObject();
    const base = {
      cert: path.join(CERT_DIR, 'client.pem'),
      key: path.join(CERT_DIR, 'client.key')
    };
    const options = createTransport(Object.assign({}, base, {
      ca: path.join(CERT_DIR, 'ca.pem')
    }))._createWebSocketOptions(new URL('wss://hub.example:47809'));

    expect(options.servername).to.equal('hub.example');
    expect(options.checkServerIdentity('not-in-the-certificate.invalid', peer)).to.equal(undefined);

    const unrelated = createTransport(Object.assign({}, base, {
      ca: tls.rootCertificates[0]
    }))._createWebSocketOptions(new URL('wss://hub.example:47809'));
    const signerError = unrelated.checkServerIdentity('hub.example', peer);
    expect(signerError.code).to.equal('BACNET_SC_CA_DIRECT_SIGNER_MISMATCH');
  });

  it('performs hostname validation only when explicitly enabled', () => {
    const peer = new crypto.X509Certificate(
      fs.readFileSync(path.join(CERT_DIR, 'server.pem'))
    ).toLegacyObject();
    const transport = createTransport({
      cert: path.join(CERT_DIR, 'client.pem'),
      key: path.join(CERT_DIR, 'client.key'),
      ca: path.join(CERT_DIR, 'ca.pem'),
      servername: 'wrong-host.invalid'
    });
    const options = transport._createWebSocketOptions(new URL('wss://127.0.0.1:47809'));
    const identityError = options.checkServerIdentity('wrong-host.invalid', peer);

    expect(identityError.code).to.equal('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('lets WebSocket reassemble the protocol maximum while locally discarding a smaller configured excess', () => {
    const diagnostics = [];
    const transport = createTransport({maxBvlc: 100, maxNpdu: 50, maxBufferedAmount: 100});
    const options = transport._createWebSocketOptions(new URL('ws://127.0.0.1:47809'));
    const active = activate(transport);
    transport.on('diagnostic', (event) => diagnostics.push(event));

    expect(options.maxPayload).to.equal(0xFFFF);
    transport._onSocketMessage(active.socket, active.generation, Buffer.alloc(101), true);

    expect(active.socket.closeCalls).to.equal(0);
    expect(active.socket.terminateCalls).to.equal(0);
    expect(active.socket.sent).to.have.length(0);
    expect(diagnostics.some((event) => event.code === 'BACNET_SC_MESSAGE_TOO_LARGE')).to.equal(true);
  });

  it('expires disconnected sends instead of replaying stale work', async() => {
    const diagnostics = [];
    const transport = createTransport({sendQueueTimeout: 10});
    transport.on('error', () => {});
    transport.on('diagnostic', (event) => diagnostics.push(event));

    expect(transport.send(packet(), 5, '020000000001')).to.equal(true);
    expect(transport.getStatus().pendingSends).to.equal(1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(transport.getStatus().pendingSends).to.equal(0);
    expect(diagnostics.some((event) => event.code === 'send-expired')).to.equal(true);
    transport.close();
  });

  it('clears disconnected sends and rejects new work when explicitly closed', () => {
    const diagnostics = [];
    const transport = createTransport({sendQueueTimeout: 1000});
    transport.on('error', () => {});
    transport.on('diagnostic', (event) => diagnostics.push(event));

    transport.send(packet(), 5, '020000000001');
    transport.close();

    expect(transport.getStatus().pendingSends).to.equal(0);
    expect(transport.send(packet(), 5, '020000000001')).to.equal(false);
    expect(diagnostics.some((event) => event.code === 'BACNET_SC_SEND_CANCELLED')).to.equal(true);
    expect(diagnostics.some((event) => event.code === 'BACNET_SC_CLOSED')).to.equal(true);
  });

  it('rejects already-aborted and expired send contexts', () => {
    const diagnostics = [];
    const transport = createTransport();
    const aborted = new FakeSignal();
    aborted.abort();
    transport.on('error', () => {});
    transport.on('diagnostic', (event) => diagnostics.push(event));

    expect(transport.send(packet(), 5, '020000000001', {signal: aborted})).to.equal(false);
    expect(transport.send(packet(), 5, '020000000001', {deadline: Date.now() - 1})).to.equal(false);
    expect(transport.getStatus().pendingSends).to.equal(0);
    expect(diagnostics.map((event) => event.code)).to.include('send-aborted');
    expect(diagnostics.map((event) => event.code)).to.include('send-expired');
  });

  it('removes an aborted queued send and cleans up its listener', () => {
    const diagnostics = [];
    const signal = new FakeSignal();
    const transport = createTransport({sendQueueTimeout: 1000});
    transport.on('error', () => {});
    transport.on('diagnostic', (event) => diagnostics.push(event));

    expect(transport.send(packet(), 5, '020000000001', {signal: signal})).to.equal(true);
    expect(signal.listeners.size).to.equal(1);
    signal.abort();

    expect(transport.getStatus().pendingSends).to.equal(0);
    expect(signal.listeners.size).to.equal(0);
    expect(diagnostics.some((event) => event.code === 'send-aborted')).to.equal(true);
  });

  it('rechecks queued context and removes abort listeners on flush and close', () => {
    const firstSignal = new FakeSignal();
    const secondSignal = new FakeSignal();
    const transport = createTransport({sendQueueTimeout: 1000});
    transport.on('error', () => {});

    transport.send(packet(), 5, '020000000001', {
      signal: firstSignal,
      deadline: Date.now() + 1000
    });
    const active = activate(transport);
    transport._flushPendingSends(active.socket, active.generation);
    expect(firstSignal.listeners.size).to.equal(0);
    expect(active.socket.sent).to.have.length(1);

    transport._connected = false;
    transport._state = 'reconnecting';
    transport.send(packet(), 5, '020000000001', {signal: secondSignal});
    expect(secondSignal.listeners.size).to.equal(1);
    transport.close();
    expect(secondSignal.listeners.size).to.equal(0);
  });

  it('rechecks a queued signal immediately before flushing', () => {
    const diagnostics = [];
    const signal = new FakeSignal();
    const transport = createTransport({sendQueueTimeout: 1000});
    transport.on('error', () => {});
    transport.on('diagnostic', (event) => diagnostics.push(event));
    transport.send(packet(), 5, '020000000001', {signal: signal});

    // Simulate an abort racing with a connection acceptance without dispatching
    // the event, so the flush-time guard is the only protection.
    signal.aborted = true;
    const active = activate(transport);
    transport._flushPendingSends(active.socket, active.generation);

    expect(active.socket.sent).to.have.length(0);
    expect(signal.listeners.size).to.equal(0);
    expect(diagnostics.some((event) => event.code === 'send-aborted')).to.equal(true);
  });

  it('uses a unique Disconnect-Request ID and accepts only its matching acknowledgment', () => {
    const transport = createTransport();
    const active = activate(transport);
    let messages = 0;
    transport.on('error', () => {});
    transport.on('message', () => messages++);

    transport.close();
    const request = sc.decode(active.socket.sent[0]);
    expect(request.function).to.equal(sc.FUNCTIONS.DISCONNECT_REQUEST);
    expect(request.id).to.be.within(1, 0xFFFF);
    transport.close();
    expect(active.socket.sent).to.have.length(1);

    const npdu = sc.encode(sc.FUNCTIONS.ENCAPSULATED_NPDU, {
      id: 90,
      originating: '020000000002',
      payload: Buffer.from([0x01])
    });
    transport._onSocketMessage(active.socket, active.generation, npdu, true);
    expect(messages).to.equal(0);

    transport._onSocketMessage(active.socket, active.generation, sc.encode(sc.FUNCTIONS.DISCONNECT_ACK, {
      id: request.id + 1
    }), true);
    expect(active.socket.closeCalls).to.equal(0);

    transport._onSocketMessage(active.socket, active.generation, sc.encode(sc.FUNCTIONS.DISCONNECT_ACK, {
      id: request.id
    }), true);
    expect(active.socket.closeCalls).to.equal(1);
    expect(active.socket.closeArguments[0].code).to.equal(1000);
    transport._clearDisconnectTimer();
  });

  it('closes immediately on a matching Disconnect-Request NAK and ignores unrelated results', () => {
    const transport = createTransport();
    const active = activate(transport);
    transport.on('error', () => {});

    transport.close();
    const request = sc.decode(active.socket.sent[0]);

    transport._onSocketMessage(active.socket, active.generation, bvlcResult(
      request.id + 1,
      sc.FUNCTIONS.DISCONNECT_REQUEST,
      1,
      baEnum.ErrorCode.OTHER
    ), true);
    transport._onSocketMessage(active.socket, active.generation, bvlcResult(
      request.id,
      sc.FUNCTIONS.HEARTBEAT_REQUEST,
      1,
      baEnum.ErrorCode.OTHER
    ), true);
    expect(active.socket.closeCalls).to.equal(0);

    transport._onSocketMessage(active.socket, active.generation, bvlcResult(
      request.id,
      sc.FUNCTIONS.DISCONNECT_REQUEST,
      1,
      baEnum.ErrorCode.OTHER
    ), true);

    expect(transport._disconnectRequestId).to.equal(null);
    expect(active.socket.closeCalls).to.equal(1);
    expect(active.socket.closeArguments[0].code).to.equal(1000);
    expect(active.socket.actions.map((action) => action.type)).to.deep.equal(['send', 'close']);
    transport._clearDisconnectTimer();
  });

  it('reconnects after the hub initiates a clean disconnect', () => {
    const reconnects = [];
    const transport = createTransport({reconnect: true, reconnectMin: 1000});
    const active = activate(transport);
    transport.on('reconnect', (event) => reconnects.push(event));

    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.DISCONNECT_REQUEST,
      {id: 81}
    ), true);

    expect(sc.decode(active.socket.sent[0])).to.include({
      function: sc.FUNCTIONS.DISCONNECT_ACK,
      id: 81
    });
    expect(active.socket.closeArguments[0].code).to.equal(1000);
    expect(transport.getState()).to.equal('disconnecting');

    transport._onSocketClose(active.socket, active.generation, 1000, Buffer.alloc(0));

    expect(reconnects).to.have.length(1);
    expect(transport.getState()).to.equal('reconnecting');
    transport.close();
  });

  it('retries the primary first after losing an established primary connection', () => {
    const reconnects = [];
    const transport = createTransport({
      hubUrls: ['ws://primary.test:47809', 'ws://failover.test:47809'],
      reconnect: true,
      reconnectMin: 1000
    });
    const active = activate(transport);
    transport._hubIndex = 0;
    transport.on('reconnect', (event) => reconnects.push(event));

    transport._onSocketClose(active.socket, active.generation, 1006, Buffer.alloc(0));

    expect(reconnects).to.have.length(1);
    expect(reconnects[0].hubIndex).to.equal(0);
    expect(reconnects[0].hubUrl).to.equal('ws://primary.test:47809');
    transport.close();
  });

  it('keeps failover active while probing primary and switches only after the probe closes', () => {
    const reconnects = [];
    const transport = createTransport({
      hubUrls: ['ws://primary.test:47809', 'ws://failover.test:47809'],
      reconnect: true,
      reconnectMin: 1000
    });
    const active = activate(transport);
    const probe = new FakeProbe();
    transport._hubIndex = 1;
    transport._createPrimaryProbeTransport = () => probe;
    transport.on('reconnect', (event) => reconnects.push(event));

    transport._startPrimaryProbe();
    expect(probe.openCalls).to.equal(1);
    expect(transport.getState()).to.equal('connected');
    expect(active.socket.sent).to.have.length(0);

    probe.emit('open');
    expect(probe.closeCalls).to.equal(1);
    expect(transport.getState()).to.equal('connected');
    expect(active.socket.sent).to.have.length(0);

    probe.emit('close');
    const disconnect = sc.decode(active.socket.sent[0]);
    expect(disconnect.function).to.equal(sc.FUNCTIONS.DISCONNECT_REQUEST);
    expect(transport.getState()).to.equal('disconnecting');
    expect(transport._nextReconnectHubIndex).to.equal(0);

    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.DISCONNECT_ACK,
      {id: disconnect.id}
    ), true);
    transport._onSocketClose(active.socket, active.generation, 1000, Buffer.alloc(0));

    expect(reconnects).to.have.length(1);
    expect(reconnects[0].hubIndex).to.equal(0);
    expect(reconnects[0].hubUrl).to.equal('ws://primary.test:47809');
    transport.close();
  });

  it('backs off a failed primary probe without disturbing the active failover', () => {
    let scheduled = 0;
    const transport = createTransport({
      hubUrls: ['ws://primary.test:47809', 'ws://failover.test:47809'],
      reconnect: true,
      reconnectMin: 10,
      reconnectMax: 40
    });
    const active = activate(transport);
    const probe = new FakeProbe();
    transport._hubIndex = 1;
    transport._createPrimaryProbeTransport = () => probe;
    transport._schedulePrimaryProbe = () => scheduled++;

    transport._startPrimaryProbe();
    probe.emit('error', new Error('primary unavailable'));

    expect(probe.closeCalls).to.equal(1);
    expect(transport._primaryProbe).to.equal(null);
    expect(transport._primaryProbeDelay).to.equal(20);
    expect(scheduled).to.equal(1);
    expect(transport.getState()).to.equal('connected');
    expect(transport._socket).to.equal(active.socket);
    expect(active.socket.sent).to.have.length(0);
    transport.close();
    transport._clearDisconnectTimer();
  });

  it('owns and cancels a live primary probe on outer close and ignores its stale events', () => {
    const transport = createTransport({
      hubUrls: ['ws://primary.test:47809', 'ws://failover.test:47809'],
      reconnect: true,
      reconnectMin: 1000
    });
    const active = activate(transport);
    const probe = new FakeProbe();
    transport._hubIndex = 1;
    transport._createPrimaryProbeTransport = () => probe;

    transport._startPrimaryProbe();
    transport.close();

    expect(probe.closeCalls).to.equal(1);
    expect(transport._primaryProbe).to.equal(null);
    expect(transport._manualClose).to.equal(true);
    expect(transport._nextReconnectHubIndex).to.equal(null);
    expect(sc.decode(active.socket.sent[0]).function).to.equal(sc.FUNCTIONS.DISCONNECT_REQUEST);

    probe.emit('open');
    probe.emit('close');
    expect(transport._nextReconnectHubIndex).to.equal(null);
    expect(active.socket.sent).to.have.length(1);
    transport._clearDisconnectTimer();
  });

  it('reschedules when a primary probe closes cleanly before Connect-Accept', () => {
    let scheduled = 0;
    const transport = createTransport({
      hubUrls: ['ws://primary.test:47809', 'ws://failover.test:47809'],
      reconnect: true,
      reconnectMin: 10,
      reconnectMax: 40
    });
    activate(transport);
    const probe = new FakeProbe();
    transport._hubIndex = 1;
    transport._createPrimaryProbeTransport = () => probe;
    transport._schedulePrimaryProbe = () => scheduled++;

    transport._startPrimaryProbe();
    probe.state = 'idle';
    probe.emit('diagnostic', {code: 'websocket-close'});

    expect(transport._primaryProbe).to.equal(null);
    expect(transport._primaryProbeDelay).to.equal(20);
    expect(scheduled).to.equal(1);
    expect(transport.getState()).to.equal('connected');
    transport.close();
    transport._clearDisconnectTimer();
  });

  it('reports the exact close status before scheduling a reconnect', () => {
    const events = [];
    const transport = createTransport({reconnect: true, reconnectMin: 1000});
    const active = activate(transport);
    transport.on('diagnostic', (event) => {
      if (event.code === 'websocket-close') events.push({type: 'diagnostic', details: event.details});
    });
    transport.on('close', (details) => events.push({type: 'close', details: details}));
    transport.on('reconnect', (details) => events.push({type: 'reconnect', details: details}));

    transport._onSocketClose(active.socket, active.generation, 1008, Buffer.from('site policy'));

    expect(events.map((event) => event.type)).to.deep.equal(['diagnostic', 'close', 'reconnect']);
    expect(events[0].details).to.deep.equal({code: 1008, reason: 'site policy', intentional: false});
    expect(events[1].details).to.deep.equal(events[0].details);
    expect(transport.getState()).to.equal('reconnecting');
    transport.close();
  });

  it('allows an explicit reopen from the close event before automatic reconnect scheduling', () => {
    const events = [];
    const transport = createTransport({reconnect: true, reconnectMin: 1000});
    const active = activate(transport);
    const replacement = new FakeSocket();
    transport._connect = (hubUrl) => {
      events.push('connect:' + hubUrl);
      transport._socket = replacement;
      transport._state = 'connecting';
    };
    transport.on('close', (details) => {
      events.push('close:' + details.code);
      expect(transport.getState()).to.equal('idle');
      expect(transport.open()).to.equal(true);
    });
    transport.on('reconnect', () => events.push('automatic-reconnect'));

    transport._onSocketClose(active.socket, active.generation, 1001, Buffer.alloc(0));

    expect(events).to.deep.equal([
      'close:1001',
      'connect:ws://127.0.0.1:47809'
    ]);
    expect(transport._socket).to.equal(replacement);
    expect(transport.getState()).to.equal('connecting');
    transport._socket = null;
    transport._state = 'idle';
    transport.close();
  });

  it('ignores all callbacks from stale socket generations', () => {
    const transport = createTransport();
    const stale = activate(transport);
    const current = new FakeSocket();
    transport._socket = current;
    transport._socketGeneration++;
    const currentGeneration = transport._socketGeneration;
    let messages = 0;
    transport.on('message', () => messages++);

    const npdu = sc.encode(sc.FUNCTIONS.ENCAPSULATED_NPDU, {
      id: 1,
      originating: '020000000002',
      payload: Buffer.from([0x01])
    });
    transport._onSocketMessage(stale.socket, stale.generation, npdu, true);
    transport._onSocketError(stale.socket, stale.generation, new Error('late error'));
    transport._onSocketClose(stale.socket, stale.generation, 1006, Buffer.alloc(0));

    expect(messages).to.equal(0);
    expect(transport._socket).to.equal(current);
    expect(transport._socketGeneration).to.equal(currentGeneration);
    expect(current.terminateCalls).to.equal(0);
  });

  it('handles an error/close callback race only once per socket generation', () => {
    const reconnects = [];
    const transport = createTransport({reconnect: true, reconnectMin: 1000});
    const active = activate(transport);
    let messages = 0;
    transport.on('reconnect', (event) => reconnects.push(event));
    transport.on('message', () => messages++);

    transport._onSocketError(active.socket, active.generation, new Error('first error'));
    transport._onSocketError(active.socket, active.generation, new Error('duplicate error'));
    transport._onSocketMessage(active.socket, active.generation, sc.encode(sc.FUNCTIONS.ENCAPSULATED_NPDU, {
      id: 1,
      originating: '020000000002',
      payload: Buffer.from([0x01])
    }), true);
    expect(active.socket.terminateCalls).to.equal(1);
    expect(messages).to.equal(0);
    expect(transport.send(packet(), 5, '020000000001')).to.equal(false);

    transport._onSocketClose(active.socket, active.generation, 1006, Buffer.alloc(0));
    transport._onSocketClose(active.socket, active.generation, 1006, Buffer.alloc(0));
    expect(reconnects).to.have.length(1);
    expect(transport.getState()).to.equal('reconnecting');
    transport.close();
  });

  it('rejects a WebSocket that did not negotiate the exact BACnet/SC subprotocol', async() => {
    const errors = [];
    const transport = createTransport();
    const active = activate(transport, 'connecting');
    active.socket.protocol = '';
    transport.on('error', (err) => errors.push(err));

    transport._onSocketOpen(active.socket, active.generation);
    await nextTurn();

    expect(errors[0].code).to.equal('BACNET_SC_WEBSOCKET_PROTOCOL_MISMATCH');
    expect(active.socket.terminateCalls).to.equal(0);
    expect(active.socket.closeCalls).to.equal(1);
    expect(active.socket.closeArguments[0].code).to.equal(1002);
  });

  it('maps WebSocket handshake failures to stable transport error codes', async() => {
    const cases = [
      {
        message: 'Max payload size exceeded',
        nativeCode: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
        expected: 'BACNET_SC_MESSAGE_TOO_LARGE'
      },
      {
        message: 'Unexpected server response: 403',
        expected: 'BACNET_SC_WEBSOCKET_REJECTED'
      },
      {
        message: 'Invalid Sec-WebSocket-Accept header',
        expected: 'BACNET_SC_WEBSOCKET_ACCEPT_MISMATCH'
      },
      {
        message: 'Server sent no subprotocol',
        expected: 'BACNET_SC_WEBSOCKET_PROTOCOL_MISMATCH'
      },
      {
        message: 'Opening handshake has timed out',
        expected: 'BACNET_SC_WEBSOCKET_TIMEOUT'
      },
      {
        message: 'ECONNRESET',
        expected: 'BACNET_SC_SOCKET_ERROR'
      }
    ];

    for (const testCase of cases) {
      const errors = [];
      const transport = createTransport();
      const active = activate(transport, 'connecting');
      const err = new Error(testCase.message);
      if (testCase.nativeCode) err.code = testCase.nativeCode;
      transport.on('error', (value) => errors.push(value));

      transport._onSocketError(active.socket, active.generation, err);
      await nextTurn();

      expect(errors, testCase.message).to.have.length(1);
      expect(errors[0].code, testCase.message).to.equal(testCase.expected);
      expect(active.socket.terminateCalls, testCase.message).to.equal(1);
      expect(active.socket.closeCalls, testCase.message).to.equal(0);
    }
  });

  it('closes text WebSocket messages gracefully with status 1003', async() => {
    const errors = [];
    const transport = createTransport();
    const active = activate(transport);
    transport.on('error', (err) => errors.push(err));

    transport._onSocketMessage(active.socket, active.generation, Buffer.from('text'), false);
    await nextTurn();

    expect(errors[0].code).to.equal('BACNET_SC_TEXT_MESSAGE');
    expect(active.socket.terminateCalls).to.equal(0);
    expect(active.socket.closeCalls).to.equal(1);
    expect(active.socket.closeArguments[0]).to.deep.equal({
      code: 1003,
      reason: 'Binary messages required'
    });
  });

  it('closes protocol violations gracefully with status 1002', async() => {
    const errors = [];
    const transport = createTransport();
    const active = activate(transport, 'awaiting-accept');
    transport._connectRequestId = 42;
    transport.on('error', (err) => errors.push(err));

    const npdu = sc.encode(sc.FUNCTIONS.ENCAPSULATED_NPDU, {
      id: 1,
      payload: Buffer.from([0x01])
    });
    transport._onSocketMessage(active.socket, active.generation, npdu, true);
    await nextTurn();

    expect(errors[0].code).to.equal('BACNET_SC_UNEXPECTED_CONNECT_MESSAGE');
    expect(active.socket.terminateCalls).to.equal(0);
    expect(active.socket.closeCalls).to.equal(1);
    expect(active.socket.closeArguments[0]).to.deep.equal({
      code: 1002,
      reason: 'Unexpected BACnet/SC message'
    });
  });

  it('performs a normal close handshake when manually closed while awaiting Connect-Accept', () => {
    const transport = createTransport();
    const active = activate(transport, 'awaiting-accept');
    transport._connected = false;
    transport._connectRequestId = 42;

    transport.close();

    expect(transport.getState()).to.equal('disconnecting');
    expect(active.socket.sent).to.have.length(0);
    expect(active.socket.terminateCalls).to.equal(0);
    expect(active.socket.closeCalls).to.equal(1);
    expect(active.socket.closeArguments[0]).to.deep.equal({code: 1000, reason: undefined});
    transport._clearDisconnectTimer();
  });

  it('handles a matching Connect-Request NAK as a graceful connection rejection', async() => {
    const errors = [];
    const transport = createTransport({vmac: '020000000001'});
    const active = activate(transport, 'awaiting-accept');
    transport._connected = false;
    transport._peer = null;
    transport._connectRequestId = 42;
    transport.on('error', (err) => errors.push(err));

    transport._onSocketMessage(active.socket, active.generation, bvlcResult(
      42,
      sc.FUNCTIONS.CONNECT_REQUEST,
      1,
      baEnum.ErrorCode.OTHER,
      {errorDetails: 'not accepted'}
    ), true);
    await nextTurn();

    expect(errors).to.have.length(1);
    expect(errors[0].code).to.equal('BACNET_SC_CONNECT_REJECTED');
    expect(active.socket.terminateCalls).to.equal(0);
    expect(active.socket.closeArguments[0]).to.deep.equal({code: 1000, reason: 'Connect rejected'});
    transport._clearDisconnectTimer();
  });

  it('rotates its Random-48 VMAC before closing on a duplicate-VMAC Connect NAK', async() => {
    const diagnostics = [];
    const transport = createTransport({vmac: '020000000001'});
    const active = activate(transport, 'awaiting-accept');
    const originalMakeRandomVmac = sc.makeRandomVmac;
    transport._connected = false;
    transport._peer = null;
    transport._connectRequestId = 43;
    transport.on('diagnostic', (event) => diagnostics.push(event));
    transport.on('error', () => {});

    try {
      sc.makeRandomVmac = () => '020000000099';
      transport._onSocketMessage(active.socket, active.generation, bvlcResult(
        43,
        sc.FUNCTIONS.CONNECT_REQUEST,
        1,
        baEnum.ErrorCode.NODE_DUPLICATE_VMAC
      ), true);
      await nextTurn();
    } finally {
      sc.makeRandomVmac = originalMakeRandomVmac;
    }

    expect(transport.getStatus().vmac).to.equal('020000000099');
    expect(diagnostics.some((event) => event.code === 'duplicate-vmac' &&
      event.details.previousVmac === '020000000001' &&
      event.details.replacementVmac === '020000000099')).to.equal(true);
    expect(active.socket.closeArguments[0]).to.deep.equal({code: 1000, reason: 'Connect rejected'});
    transport._clearDisconnectTimer();
  });

  it('ignores Connect results with the wrong message ID or causing function', () => {
    const diagnostics = [];
    const transport = createTransport();
    const active = activate(transport, 'awaiting-accept');
    transport._connected = false;
    transport._peer = null;
    transport._connectRequestId = 44;
    transport.on('diagnostic', (event) => diagnostics.push(event));
    transport.on('error', () => {});

    transport._onSocketMessage(active.socket, active.generation, bvlcResult(
      44,
      sc.FUNCTIONS.HEARTBEAT_REQUEST,
      1,
      baEnum.ErrorCode.OTHER
    ), true);
    transport._onSocketMessage(active.socket, active.generation, bvlcResult(
      45,
      sc.FUNCTIONS.CONNECT_REQUEST,
      1,
      baEnum.ErrorCode.OTHER
    ), true);

    expect(transport.getState()).to.equal('awaiting-accept');
    expect(active.socket.closeCalls).to.equal(0);
    expect(active.socket.terminateCalls).to.equal(0);
    expect(diagnostics.some((event) => event.code === 'unexpected-connect-result')).to.equal(true);
  });

  it('validates peer limits and uses the smaller peer NPDU limit', async() => {
    const errors = [];
    const transport = createTransport();
    const active = activate(transport, 'awaiting-accept');
    transport._connected = false;
    transport._peer = null;
    transport._connectRequestId = 42;
    transport.on('error', (err) => errors.push(err));

    const invalid = connectAccept(42);
    invalid.writeUInt16BE(0, invalid.length - 2);
    transport._onSocketMessage(active.socket, active.generation, invalid, true);
    await nextTurn();

    expect(errors[0].code).to.equal('BACNET_SC_INVALID_PEER_LIMITS');
    expect(active.socket.terminateCalls).to.equal(0);
    expect(active.socket.closeCalls).to.equal(1);

    const second = createTransport();
    const secondActive = activate(second, 'awaiting-accept');
    second._connected = false;
    second._peer = null;
    second._connectRequestId = 51;
    second.on('error', () => {});
    second._onSocketMessage(secondActive.socket, secondActive.generation, connectAccept(51, {
      maxBvlc: 100,
      maxNpdu: 40
    }), true);
    expect(second.getMaxPayload()).to.equal(44);
    second._clearHeartbeatTimer();
  });

  it('does not expose mutable peer state through open or status snapshots', () => {
    const transport = createTransport();
    const active = activate(transport, 'awaiting-accept');
    transport._connected = false;
    transport._peer = null;
    transport._connectRequestId = 61;
    transport.on('open', (peer) => {
      peer.maxNpdu = 1;
      peer.vmac = '020000000099';
    });

    transport._onSocketMessage(active.socket, active.generation, connectAccept(61, {
      maxBvlc: 100,
      maxNpdu: 40
    }), true);

    const first = transport.getStatus();
    expect(first.peer.maxNpdu).to.equal(40);
    expect(first.peer.vmac).to.equal('02000000abcd');
    first.peer.maxNpdu = 2;
    expect(transport.getStatus().peer.maxNpdu).to.equal(40);
    transport._clearHeartbeatTimer();
  });

  it('does not emit open or flush queued work after a connected diagnostic closes reentrantly', () => {
    let opens = 0;
    const transport = createTransport({sendQueueTimeout: 1000});
    transport.on('error', () => {});
    transport.send(packet(), 5, '020000000001');
    const active = activate(transport, 'awaiting-accept');
    transport._connected = false;
    transport._peer = null;
    transport._connectRequestId = 63;
    transport.on('open', () => opens++);
    transport.on('diagnostic', (event) => {
      if (event.code === 'connected') transport.close();
    });

    transport._onSocketMessage(active.socket, active.generation, connectAccept(63), true);

    expect(opens).to.equal(0);
    expect(transport.getState()).to.equal('disconnecting');
    expect(transport.getStatus().pendingSends).to.equal(0);
    expect(active.socket.sent).to.have.length(1);
    expect(sc.decode(active.socket.sent[0]).function).to.equal(sc.FUNCTIONS.DISCONNECT_REQUEST);
    transport._clearDisconnectTimer();
  });

  it('drops a malformed Connect-Accept without generating a response loop', () => {
    const diagnostics = [];
    const transport = createTransport();
    const active = activate(transport, 'awaiting-accept');
    transport._connected = false;
    transport._peer = null;
    transport._connectRequestId = 62;
    transport.on('diagnostic', (event) => diagnostics.push(event));

    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.CONNECT_ACCEPT,
      {
        id: 62,
        originating: '020000000002',
        dataOptions: [{type: 1, mustUnderstand: true}],
        payload: sc.encodeConnectPayload({
          vmac: '02000000abcd',
          uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          maxBvlc: 1600,
          maxNpdu: 1497
        })
      }
    ), true);

    expect(active.socket.sent).to.have.length(0);
    expect(transport.getState()).to.equal('awaiting-accept');
    expect(transport.getStatus().connected).to.equal(false);
    expect(active.socket.closeCalls).to.equal(0);
    expect(diagnostics.some((event) => event.code === 'invalid-control-flags')).to.equal(true);
  });

  it('enforces peer NPDU and encoded BVLC limits on outbound traffic', async() => {
    const errors = [];
    const transport = createTransport();
    activate(transport, 'connected', {
      vmac: '02000000abcd',
      uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      maxBvlc: 10,
      maxNpdu: 2
    });
    transport.on('error', (err) => errors.push(err));

    expect(transport.send(packet(Buffer.alloc(3)), 7, '020000000001')).to.equal(false);
    expect(transport.send(packet(Buffer.alloc(1)), 5, '020000000001')).to.equal(false);
    await nextTurn();

    expect(errors.map((err) => err.code)).to.deep.equal([
      'BACNET_SC_PEER_NPDU_TOO_LARGE',
      'BACNET_SC_PEER_BVLC_TOO_LARGE'
    ]);
  });

  it('rejects an inbound NPDU over the local limit without closing the connection', () => {
    const diagnostics = [];
    const transport = createTransport({maxBvlc: 100, maxNpdu: 20, maxBufferedAmount: 100});
    const active = activate(transport);
    transport.on('diagnostic', (event) => diagnostics.push(event));

    const oversized = sc.encode(sc.FUNCTIONS.ENCAPSULATED_NPDU, {
      id: 1,
      originating: '020000000002',
      payload: Buffer.alloc(21)
    });
    transport._onSocketMessage(active.socket, active.generation, oversized, true);

    const rejection = decodeSentResult(active.socket);
    expect(rejection.message.id).to.equal(1);
    expect(rejection.result.forFunction).to.equal(sc.FUNCTIONS.ENCAPSULATED_NPDU);
    expect(rejection.result.resultCode).to.equal(1);
    expect(rejection.result.errorClass).to.equal(baEnum.ErrorClass.COMMUNICATION);
    expect(rejection.result.errorCode).to.equal(baEnum.ErrorCode.PARAMETER_OUT_OF_RANGE);
    expect(active.socket.closeCalls).to.equal(0);
    expect(active.socket.terminateCalls).to.equal(0);
    expect(diagnostics.some((event) => event.code === 'npdu-too-large')).to.equal(true);
  });

  it('returns an exact BVLC-Result NAK for an unsupported unicast Must-Understand option', () => {
    let delivered = 0;
    const transport = createTransport();
    const active = activate(transport);
    transport.on('message', () => delivered++);

    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.ENCAPSULATED_NPDU,
      {
        id: 0x1234,
        originating: '020000000002',
        destOptions: [{type: 2, mustUnderstand: true}],
        payload: Buffer.from([0x01])
      }
    ), true);

    const rejection = decodeSentResult(active.socket);
    expect(delivered).to.equal(0);
    expect(rejection.message.function).to.equal(sc.FUNCTIONS.BVLC_RESULT);
    expect(rejection.message.id).to.equal(0x1234);
    expect(rejection.message.destination).to.equal('020000000002');
    expect(rejection.message.dataOptions).to.equal(undefined);
    expect(rejection.result).to.include({
      forFunction: sc.FUNCTIONS.ENCAPSULATED_NPDU,
      resultCode: 1,
      errorHeaderMarker: 0x42,
      errorClass: baEnum.ErrorClass.COMMUNICATION,
      errorCode: baEnum.ErrorCode.HEADER_NOT_UNDERSTOOD
    });
    expect(active.socket.closeCalls).to.equal(0);
    expect(active.socket.terminateCalls).to.equal(0);
  });

  it('silently drops a broadcast with an unsupported Must-Understand option', () => {
    let delivered = 0;
    const diagnostics = [];
    const transport = createTransport();
    const active = activate(transport);
    transport.on('message', () => delivered++);
    transport.on('diagnostic', (event) => diagnostics.push(event));

    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.ENCAPSULATED_NPDU,
      {
        id: 0x1235,
        originating: '020000000002',
        destination: sc.BROADCAST_VMAC,
        destOptions: [{type: 2, mustUnderstand: true}],
        payload: Buffer.from([0x01])
      }
    ), true);

    expect(delivered).to.equal(0);
    expect(active.socket.sent).to.have.length(0);
    expect(active.socket.closeCalls).to.equal(0);
    expect(diagnostics.some((event) => event.code === 'broadcast-rejected')).to.equal(true);
  });

  it('forwards Data Options unchanged but never responds to a rejected BVLC-Result', () => {
    const transport = createTransport();
    const active = activate(transport);
    const messages = [];
    transport.on('message', (buffer, address, port, context) => {
      messages.push({buffer: buffer, address: address, port: port, context: context});
    });

    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.ENCAPSULATED_NPDU,
      {
        id: 0x1237,
        originating: '020000000002',
        dataOptions: [{type: 2, mustUnderstand: true}],
        payload: Buffer.from([0x01])
      }
    ), true);

    expect(messages).to.have.length(1);
    expect(messages[0].context).to.deep.equal({
      transport: 'bacnet-sc',
      messageId: 0x1237,
      originating: '020000000002',
      destination: null,
      dataOptions: [{
        marker: 0x42,
        type: 2,
        mustUnderstand: true
      }]
    });
    expect(active.socket.sent).to.have.length(0);

    const sentBeforeResult = active.socket.sent.length;
    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.BVLC_RESULT,
      {
        id: 0x1238,
        destOptions: [{type: 2, mustUnderstand: true}],
        payload: sc.encodeBvlcResultPayload({
          forFunction: sc.FUNCTIONS.ENCAPSULATED_NPDU,
          resultCode: 0
        })
      }
    ), true);

    expect(active.socket.sent).to.have.length(sentBeforeResult);
    expect(active.socket.closeCalls).to.equal(0);
  });

  it('ignores an unsupported non-Must-Understand option and delivers the NPDU', () => {
    const messages = [];
    const transport = createTransport();
    const active = activate(transport);
    transport.on('message', (buffer, address) => messages.push({buffer: buffer, address: address}));

    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.ENCAPSULATED_NPDU,
      {
        id: 0x1236,
        originating: '020000000002',
        destOptions: [{type: 2, mustUnderstand: false}],
        payload: Buffer.from([0x01, 0x02])
      }
    ), true);

    expect(messages).to.have.length(1);
    expect(messages[0].address).to.equal('020000000002');
    expect(messages[0].buffer.slice(4)).to.deep.equal(Buffer.from([0x01, 0x02]));
    expect(active.socket.sent).to.have.length(0);
    transport._clearHeartbeatTimer();
  });

  it('NAKs malformed, unknown, payload-less, and forbidden-field messages without disconnecting', () => {
    const cases = [
      {
        name: 'truncated header field',
        id: 31,
        functionCode: sc.FUNCTIONS.ENCAPSULATED_NPDU,
        buffer: Buffer.from([sc.FUNCTIONS.ENCAPSULATED_NPDU, 0x08, 0x00, 31]),
        errorCode: baEnum.ErrorCode.MESSAGE_INCOMPLETE
      },
      {
        name: 'unknown function',
        id: 32,
        functionCode: 0x7E,
        buffer: sc.encode(0x7E, {id: 32}),
        errorCode: baEnum.ErrorCode.BVLC_FUNCTION_UNKNOWN
      },
      {
        name: 'missing NPDU payload',
        id: 33,
        functionCode: sc.FUNCTIONS.ENCAPSULATED_NPDU,
        buffer: sc.encode(sc.FUNCTIONS.ENCAPSULATED_NPDU, {id: 33}),
        errorCode: baEnum.ErrorCode.PAYLOAD_EXPECTED
      },
      {
        name: 'forbidden control address',
        id: 34,
        functionCode: sc.FUNCTIONS.HEARTBEAT_REQUEST,
        buffer: sc.encode(sc.FUNCTIONS.HEARTBEAT_REQUEST, {
          id: 34,
          originating: '020000000002'
        }),
        errorCode: baEnum.ErrorCode.PARAMETER_OUT_OF_RANGE
      }
    ];

    cases.forEach((testCase) => {
      const transport = createTransport();
      const active = activate(transport);

      transport._onSocketMessage(active.socket, active.generation, testCase.buffer, true);

      expect(active.socket.sent, testCase.name).to.have.length(1);
      const rejection = decodeSentResult(active.socket);
      expect(rejection.message.id, testCase.name).to.equal(testCase.id);
      expect(rejection.result.forFunction, testCase.name).to.equal(testCase.functionCode);
      expect(rejection.result.resultCode, testCase.name).to.equal(1);
      expect(rejection.result.errorClass, testCase.name).to.equal(baEnum.ErrorClass.COMMUNICATION);
      expect(rejection.result.errorCode, testCase.name).to.equal(testCase.errorCode);
      expect(active.socket.closeCalls, testCase.name).to.equal(0);
      expect(active.socket.terminateCalls, testCase.name).to.equal(0);
      expect(active.socket.readyState, testCase.name).to.equal(WebSocket.OPEN);
    });
  });

  it('maps malformed header-option causes to their standards-defined errors', () => {
    const cases = [
      {
        name: 'reserved option type zero',
        buffer: Buffer.from([sc.FUNCTIONS.ENCAPSULATED_NPDU, 0x02, 0x00, 81, 0x00, 0x01]),
        errorCode: baEnum.ErrorCode.PARAMETER_OUT_OF_RANGE
      },
      {
        name: 'inconsistent Secure-Path marker',
        buffer: Buffer.from([sc.FUNCTIONS.ENCAPSULATED_NPDU, 0x02, 0x00, 82, 0x01, 0x01]),
        errorCode: baEnum.ErrorCode.INCONSISTENT_PARAMETERS
      },
      {
        name: 'inconsistent proprietary option',
        buffer: Buffer.from([
          sc.FUNCTIONS.ENCAPSULATED_NPDU, 0x02, 0x00, 83,
          0x3F, 0x00, 0x02, 0x00, 0x01, 0x01
        ]),
        errorCode: baEnum.ErrorCode.INCONSISTENT_PARAMETERS
      }
    ];

    cases.forEach((testCase) => {
      const transport = createTransport();
      const active = activate(transport);
      transport._onSocketMessage(active.socket, active.generation, testCase.buffer, true);
      const rejection = decodeSentResult(active.socket);
      expect(rejection.result.errorCode, testCase.name).to.equal(testCase.errorCode);
      expect(active.socket.closeCalls, testCase.name).to.equal(0);
    });
  });

  it('NAKs Address-Resolution when Direct Connect is unsupported', () => {
    const transport = createTransport();
    const active = activate(transport);

    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.ADDRESS_RESOLUTION,
      {id: 35, originating: '020000000002'}
    ), true);

    const rejection = decodeSentResult(active.socket);
    expect(rejection.message.id).to.equal(35);
    expect(rejection.message.destination).to.equal('020000000002');
    expect(rejection.result).to.include({
      forFunction: sc.FUNCTIONS.ADDRESS_RESOLUTION,
      resultCode: 1,
      errorClass: baEnum.ErrorClass.COMMUNICATION,
      errorCode: baEnum.ErrorCode.OPTIONAL_FUNCTIONALITY_NOT_SUPPORTED
    });
    expect(active.socket.closeCalls).to.equal(0);
  });

  it('never sends a BVLC-Result in response to malformed response messages', () => {
    const responses = [
      sc.encode(sc.FUNCTIONS.BVLC_RESULT, {
        id: 70,
        dataOptions: [{type: 1, mustUnderstand: true}],
        payload: sc.encodeBvlcResultPayload({
          forFunction: sc.FUNCTIONS.ENCAPSULATED_NPDU,
          resultCode: 0
        })
      }),
      sc.encode(sc.FUNCTIONS.ADDRESS_RESOLUTION_ACK, {
        id: 71,
        dataOptions: [{type: 1, mustUnderstand: true}]
      }),
      sc.encode(sc.FUNCTIONS.CONNECT_ACCEPT, {
        id: 72,
        dataOptions: [{type: 1, mustUnderstand: true}],
        payload: Buffer.alloc(26)
      }),
      sc.encode(sc.FUNCTIONS.DISCONNECT_ACK, {id: 73, payload: Buffer.from([1])}),
      sc.encode(sc.FUNCTIONS.HEARTBEAT_ACK, {id: 74, payload: Buffer.from([1])})
    ];

    responses.forEach((response) => {
      const transport = createTransport();
      const active = activate(transport);
      transport._onSocketMessage(active.socket, active.generation, response, true);
      expect(active.socket.sent).to.have.length(0);
      expect(active.socket.closeCalls).to.equal(0);
    });
  });

  it('enforces inbound NPDU boundaries and drops a non-broadcast destination from the hub', () => {
    const messages = [];
    const diagnostics = [];
    const transport = createTransport({maxBvlc: 100, maxNpdu: 20, maxBufferedAmount: 100});
    const active = activate(transport);
    transport.on('message', (buffer) => messages.push(buffer));
    transport.on('diagnostic', (event) => diagnostics.push(event));

    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.ENCAPSULATED_NPDU,
      {id: 40, originating: '020000000002', payload: Buffer.alloc(20, 0xAA)}
    ), true);
    expect(messages).to.have.length(1);
    expect(messages[0].slice(4)).to.deep.equal(Buffer.alloc(20, 0xAA));

    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.ENCAPSULATED_NPDU,
      {id: 41, originating: '020000000002', payload: Buffer.alloc(21, 0xBB)}
    ), true);
    expect(messages).to.have.length(1);
    expect(decodeSentResult(active.socket).result.errorCode).to.equal(baEnum.ErrorCode.PARAMETER_OUT_OF_RANGE);

    const sentBeforeBroadcast = active.socket.sent.length;
    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.ENCAPSULATED_NPDU,
      {
        id: 42,
        originating: '020000000002',
        destination: sc.BROADCAST_VMAC,
        payload: Buffer.alloc(21, 0xCC)
      }
    ), true);
    expect(active.socket.sent).to.have.length(sentBeforeBroadcast);
    expect(messages).to.have.length(1);

    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.ENCAPSULATED_NPDU,
      {
        id: 43,
        originating: '020000000002',
        destination: '020000000099',
        payload: Buffer.from([0x01])
      }
    ), true);
    expect(messages).to.have.length(1);
    expect(active.socket.sent).to.have.length(sentBeforeBroadcast);
    expect(diagnostics.some((event) => event.code === 'misrouted-message')).to.equal(true);
    expect(active.socket.closeCalls).to.equal(0);
    transport._clearHeartbeatTimer();
  });

  it('keeps the advertised outbound payload boundary consistent with BVLC header overhead', async() => {
    const errors = [];
    const transport = createTransport({maxBvlc: 100, maxNpdu: 50, maxBufferedAmount: 100});
    const active = activate(transport, 'connected', {
      vmac: '02000000abcd',
      uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      maxBvlc: 30,
      maxNpdu: 26
    });
    transport.on('error', (err) => errors.push(err));

    expect(transport.getMaxPayload()).to.equal(24);
    expect(transport.send(packet(Buffer.alloc(20)), 24, '020000000001')).to.equal(true);
    expect(sc.decode(active.socket.sent[0]).payload).to.have.length(20);
    expect(transport.send(packet(Buffer.alloc(21)), 25, '020000000001')).to.equal(false);
    await nextTurn();
    expect(errors.map((err) => err.code)).to.include('BACNET_SC_PEER_BVLC_TOO_LARGE');
  });

  it('bounds ws bufferedAmount instead of allowing unbounded internal queuing', async() => {
    const errors = [];
    const transport = createTransport({maxBvlc: 100, maxNpdu: 50, maxBufferedAmount: 100});
    const active = activate(transport);
    active.socket.bufferedAmount = 100;
    transport.on('error', (err) => errors.push(err));

    expect(transport.send(packet(), 5, '020000000001')).to.equal(false);
    await nextTurn();

    expect(errors[0].code).to.equal('BACNET_SC_BACKPRESSURE');
    expect(active.socket.terminateCalls).to.equal(0);
    expect(active.socket.closeCalls).to.equal(1);
  });

  it('counts only validated BACnet/SC activity toward heartbeat liveness', () => {
    const transport = createTransport();
    const active = activate(transport);
    const pendingAt = Number(process.hrtime.bigint() / 1000000n);
    transport._heartbeatPendingAt = pendingAt;
    transport._heartbeatRequestId = 10;

    transport._onSocketMessage(active.socket, active.generation, sc.encode(sc.FUNCTIONS.HEARTBEAT_ACK, {
      id: 11
    }), true);
    expect(transport._heartbeatPendingAt).to.equal(pendingAt);
    expect(transport._heartbeatRequestId).to.equal(10);

    transport._onSocketMessage(active.socket, active.generation, sc.encode(sc.FUNCTIONS.HEARTBEAT_REQUEST, {
      id: 12
    }), true);
    expect(transport._heartbeatPendingAt).to.equal(pendingAt);
    expect(transport._heartbeatRequestId).to.equal(10);
    expect(transport._lastBvlcActivityAt).to.be.a('number');
    expect(sc.decode(active.socket.sent[0]).function).to.equal(sc.FUNCTIONS.HEARTBEAT_ACK);
  });

  it('keeps the Heartbeat-ACK deadline armed across other valid BVLC activity', () => {
    const scheduled = [];
    let messages = 0;
    const transport = createTransport({heartbeatInterval: 75, heartbeatTimeout: 150});
    const active = activate(transport);
    transport._scheduleHeartbeatCheck = (delay, socket, generation) => {
      scheduled.push({delay: delay, socket: socket, generation: generation});
    };
    transport.on('message', () => messages++);
    const firstPendingAt = Number(process.hrtime.bigint() / 1000000n);
    transport._heartbeatPendingAt = firstPendingAt;
    transport._heartbeatRequestId = 50;

    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.HEARTBEAT_REQUEST,
      {id: 51}
    ), true);

    expect(transport._heartbeatPendingAt).to.equal(firstPendingAt);
    expect(transport._heartbeatRequestId).to.equal(50);
    expect(scheduled).to.have.length(1);
    expect(scheduled[0].socket).to.equal(active.socket);
    expect(scheduled[0].generation).to.equal(active.generation);
    expect(scheduled[0].delay).to.be.within(1, 150);
    expect(sc.decode(active.socket.sent[0])).to.include({
      function: sc.FUNCTIONS.HEARTBEAT_ACK,
      id: 51
    });

    const secondPendingAt = Number(process.hrtime.bigint() / 1000000n);
    transport._heartbeatPendingAt = secondPendingAt;
    transport._heartbeatRequestId = 52;
    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.ENCAPSULATED_NPDU,
      {id: 53, originating: '020000000002', payload: Buffer.from([0x01])}
    ), true);

    expect(messages).to.equal(1);
    expect(transport._heartbeatPendingAt).to.equal(secondPendingAt);
    expect(transport._heartbeatRequestId).to.equal(52);
    expect(scheduled).to.have.length(2);
    expect(scheduled[1].socket).to.equal(active.socket);
    expect(scheduled[1].generation).to.equal(active.generation);
    expect(scheduled[1].delay).to.be.within(1, 150);
  });

  it('times out one unanswered heartbeat using a monotonic deadline', async() => {
    const errors = [];
    const transport = createTransport({heartbeatInterval: 10, heartbeatTimeout: 15});
    const active = activate(transport);
    transport.on('error', (err) => errors.push(err));
    transport._lastBvlcActivityAt = 0;

    transport._heartbeatCheck(active.socket, active.generation);
    expect(sc.decode(active.socket.sent[0]).function).to.equal(sc.FUNCTIONS.HEARTBEAT_REQUEST);
    transport._heartbeatPendingAt = 0;
    transport._heartbeatCheck(active.socket, active.generation);
    await nextTurn();

    expect(errors[0].code).to.equal('BACNET_SC_HEARTBEAT_TIMEOUT');
    const disconnect = sc.decode(active.socket.sent[1]);
    expect(disconnect.function).to.equal(sc.FUNCTIONS.DISCONNECT_REQUEST);
    expect(disconnect.id).to.equal(transport._disconnectRequestId);
    expect(transport.getState()).to.equal('disconnecting');
    expect(active.socket.terminateCalls).to.equal(0);
    expect(active.socket.closeCalls).to.equal(0);

    transport._onSocketMessage(active.socket, active.generation, sc.encode(
      sc.FUNCTIONS.DISCONNECT_ACK,
      {id: disconnect.id}
    ), true);
    expect(active.socket.closeCalls).to.equal(1);
    transport._clearHeartbeatTimer();
    transport._clearDisconnectTimer();
  });
});
