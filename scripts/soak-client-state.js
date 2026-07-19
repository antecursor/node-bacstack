'use strict';

const assert = require('assert');
const EventEmitter = require('events').EventEmitter;

const Client = require('../lib/client');
const SegmentReceiver = require('../lib/client/segment-receiver');
const ServerTransactionManager = require('../lib/client/server-transaction-manager');
const baApdu = require('../lib/apdu');
const baBvlc = require('../lib/bvlc');
const baEnum = require('../lib/enum');
const baNpdu = require('../lib/npdu');

const DEFAULT_ITERATIONS = 20000;
const MAX_ITERATIONS = 1000000;
const WRITE_PROPERTY = baEnum.ConfirmedServiceChoice.WRITE_PROPERTY;
const OBJECT_ID = Object.freeze({type: baEnum.ObjectType.ANALOG_VALUE, instance: 1});
const VALUES = Object.freeze([
  Object.freeze({type: baEnum.ApplicationTags.REAL, value: 21.5})
]);

function configuredIterations() {
  const value = process.env.BACSTACK_SOAK_ITERATIONS == null ?
    DEFAULT_ITERATIONS : Number(process.env.BACSTACK_SOAK_ITERATIONS);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_ITERATIONS) {
    throw new Error('BACSTACK_SOAK_ITERATIONS must be an integer from 1 to ' + MAX_ITERATIONS);
  }
  return value;
}

function decodeConfirmedRequest(packet) {
  const bvlc = baBvlc.decode(packet, 0);
  assert(bvlc, 'soak transport received an invalid BVLC frame');
  const npdu = baNpdu.decode(packet, bvlc.len, packet.length - bvlc.len);
  assert(npdu, 'soak transport received an invalid NPDU');
  const offset = bvlc.len + npdu.len;
  const apdu = baApdu.decodeConfirmedServiceRequest(packet, offset, packet.length - offset);
  assert(apdu, 'soak transport received an invalid confirmed request');
  return apdu;
}

function simpleAck(invokeId) {
  const cursor = {buffer: Buffer.alloc(32), offset: baEnum.BVLC_HEADER_LENGTH};
  baNpdu.encode(cursor, baEnum.NpduControlPriority.NORMAL_MESSAGE, null, null);
  baApdu.encodeSimpleAck(cursor, baEnum.PduTypes.SIMPLE_ACK, WRITE_PROPERTY, invokeId);
  baBvlc.encode(
    cursor.buffer,
    baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU,
    cursor.offset
  );
  return Buffer.from(cursor.buffer.subarray(0, cursor.offset));
}

class SoakTransport extends EventEmitter {
  constructor(autoAcknowledge) {
    super();
    this.autoAcknowledge = autoAcknowledge;
    this.closed = false;
    this.maxSendDepth = 0;
    this.sendDepth = 0;
    this.sent = 0;
    this.contexts = [];
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

  open() {}

  close() {
    this.closed = true;
  }

  send(buffer, offset, receiver, context) {
    this.sent++;
    this.sendDepth++;
    this.maxSendDepth = Math.max(this.maxSendDepth, this.sendDepth);
    try {
      const request = decodeConfirmedRequest(buffer.subarray(0, offset));
      if (this.autoAcknowledge) {
        this.emit('message', simpleAck(request.invokeId), receiver, 47808);
      } else {
        this.contexts.push(context);
      }
      return true;
    } finally {
      this.sendDepth--;
    }
  }
}

function sendWrite(client, address, callback) {
  client.writeProperty(
    address,
    OBJECT_ID,
    baEnum.PropertyIdentifier.PRESENT_VALUE,
    VALUES,
    callback
  );
}

function runTransportChurn(iterations) {
  const batchSize = 2048;
  let callbacks = 0;
  let maxSendDepth = 0;
  let packets = 0;
  let sessions = 0;
  for (let offset = 0; offset < iterations; offset += batchSize) {
    const transport = new SoakTransport(true);
    const client = new Client({
      apduTimeout: 60000,
      maxTransactions: 32,
      maxTransactionPeers: 16,
      transport: transport
    });
    const end = Math.min(iterations, offset + batchSize);
    for (let index = offset; index < end; index++) {
      const peer = '192.0.2.' + ((index % 16) + 1);
      sendWrite(client, peer, (error) => {
        assert.strictEqual(error, null, 'synchronous ACK returned an error');
        callbacks++;
      });
      assert.strictEqual(client._transactions.size, 0, 'settled transaction state leaked');
      assert(client._transactions._peerStates.size <= 16,
        'transaction peer state exceeded its configured bound');
    }
    packets += transport.sent;
    maxSendDepth = Math.max(maxSendDepth, transport.maxSendDepth);
    client.close();
    assert(transport.closed, 'client did not close its transport');
    assert.strictEqual(client._transactions._peerStates.size, 0,
      'close retained transaction peer state');
    sessions++;
  }
  assert.strictEqual(callbacks, iterations, 'not every confirmed request settled once');
  assert.strictEqual(packets, iterations, 'transport send count differs from request count');
  assert.strictEqual(maxSendDepth, 1, 'transport send recursion became unbounded');
  return {callbacks: callbacks, packets: packets, sessions: sessions};
}

function runTransactionBoundary() {
  const limit = 32;
  const transport = new SoakTransport(false);
  const client = new Client({
    apduTimeout: 60000,
    maxTransactions: limit,
    maxTransactionPeers: 4,
    transport: transport
  });
  const errors = [];
  for (let index = 0; index < limit; index++) {
    sendWrite(client, '198.51.100.' + ((index % 4) + 1), (error) => errors.push(error));
  }
  assert.strictEqual(client._transactions.size, limit, 'transaction boundary was not reached');
  assert.throws(
    () => sendWrite(client, '198.51.100.1', () => {}),
    (error) => error && error.code === 'ERR_TRANSACTION_LIMIT'
  );
  assert.strictEqual(transport.sent, limit, 'rejected transaction reached the transport');
  assert.strictEqual(transport.contexts.length, limit, 'transport context boundary is incorrect');
  client.close();
  assert.strictEqual(errors.length, limit, 'close did not settle every pending transaction');
  errors.forEach((error) => assert.strictEqual(error.code, 'ERR_CLIENT_CLOSED'));
  transport.contexts.forEach((context) => assert(context.signal.aborted));
  assert.strictEqual(client._transactions.size, 0, 'close retained transaction state');
  assert.strictEqual(client._transactions._peerStates.size, 0,
    'close retained transaction peer state');
  assert.strictEqual(client._segments.size, 0, 'close retained segmented-transfer state');
  return {limit: limit, cancelled: errors.length};
}

function runServerTransactionChurn(iterations) {
  const maxEntries = 32;
  const maxResponseBytes = 64;
  const maxBytes = maxEntries * (32 + maxResponseBytes);
  let clock = 0;
  let nextTimer = 0;
  const liveTimers = new Set();
  const manager = new ServerTransactionManager({
    defaultPort: 47808,
    maxBytes: maxBytes,
    maxEntries: maxEntries,
    maxEntriesPerPeer: 8,
    maxResponseBytes: maxResponseBytes,
    now: () => clock,
    setTimeout: () => {
      const timer = {id: nextTimer++, unref() {}};
      liveTimers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => liveTimers.delete(timer),
    timeout: 1000000
  });
  let maxRetained = 0;
  let maxRetainedBytes = 0;

  for (let index = 0; index < iterations; index++) {
    clock++;
    const port = 47808 + (index % 4);
    const invokeId = Math.floor(index / 4) % 8;
    const payload = Buffer.alloc(8);
    payload.writeUInt32BE(index, 0);
    payload.writeUInt32BE((index ^ 0xA5A5A5A5) >>> 0, 4);
    const request = {
      address: {ip: '192.0.2.200', port: port},
      invokeId: invokeId,
      maxApdu: baEnum.MaxApduLengthAccepted.OCTETS_1476,
      maxSegments: baEnum.MaxSegmentsAccepted.SEGMENTS_0,
      payload: payload,
      responseMaxApdu: 1476,
      service: WRITE_PROPERTY,
      type: baEnum.PduTypes.CONFIRMED_REQUEST
    };
    const accepted = manager.accept(request);
    assert.strictEqual(accepted.status, 'new', 'server transaction was not admitted');

    const conflictingPayload = Buffer.from(payload);
    conflictingPayload[0] ^= 0xFF;
    const collision = manager.accept(Object.assign({}, request, {
      payload: conflictingPayload
    }));
    assert.strictEqual(collision.status, 'collision', 'pending invoke collision was not isolated');

    const frame = Buffer.from([0x81, 0x0A, 0x00, 0x08, 0x01, 0x00, 0x20, invokeId]);
    const completed = manager.bindResponse({
      address: request.address,
      frame: frame,
      generation: accepted.generation,
      invokeId: invokeId,
      service: WRITE_PROPERTY
    });
    assert.strictEqual(completed.status, 'completed', 'server response was not retained');
    const replay = manager.accept(request);
    assert.strictEqual(replay.status, 'completed', 'server duplicate was not replayable');
    assert(replay.frame.equals(frame), 'server duplicate replay changed terminal bytes');
    maxRetained = Math.max(maxRetained, manager.size);
    maxRetainedBytes = Math.max(maxRetainedBytes, manager.totalBytes);
    assert(manager.size <= maxEntries, 'server transaction count exceeded its bound');
    assert(manager.totalBytes <= maxBytes, 'server transaction bytes exceeded their bound');
    assert(liveTimers.size <= maxEntries, 'server transaction timers exceeded their bound');
  }

  manager.close();
  assert.strictEqual(manager.size, 0, 'server transaction close retained entries');
  assert.strictEqual(manager.totalBytes, 0, 'server transaction close retained bytes');
  assert.strictEqual(liveTimers.size, 0, 'server transaction close retained timers');
  return {maxRetained: maxRetained, maxRetainedBytes: maxRetainedBytes};
}

function segment(options) {
  return Object.assign({
    direction: 'response',
    invokeId: 0,
    moreFollows: true,
    payload: Buffer.alloc(16, 0xA5),
    peerKey: 'peer',
    sequenceNumber: 0,
    service: baEnum.ConfirmedServiceChoice.READ_PROPERTY,
    type: baEnum.PduTypes.COMPLEX_ACK,
    windowSize: 2
  }, options);
}

function runSegmentBoundary() {
  const receiver = new SegmentReceiver({
    absoluteTimeout: 60000,
    completedRetentionTimeout: 60000,
    idleTimeout: 60000,
    maxBytesPerTransfer: 64,
    maxCompletedTransfers: 8,
    maxCompletedTransfersPerPeer: 2,
    maxSegments: 4,
    maxTotalBytes: 128,
    maxTransfers: 8,
    maxTransfersPerPeer: 2
  });
  for (let index = 0; index < 8; index++) {
    const result = receiver.accept(segment({
      invokeId: index % 2,
      peerKey: 'boundary-' + Math.floor(index / 2)
    }));
    assert.strictEqual(result.status, 'pending');
  }
  assert.strictEqual(receiver.size, 8, 'segmented-transfer boundary was not reached');
  assert.strictEqual(receiver.totalBytes, 128, 'segmented byte accounting is incorrect');
  const rejected = receiver.accept(segment({peerKey: 'boundary-overflow'}));
  assert.strictEqual(rejected.reason, 'TRANSFER_LIMIT');
  receiver.cancelAll();
  assert.strictEqual(receiver.size, 0);
  assert.strictEqual(receiver.totalBytes, 0);
  return {bytes: 128, limit: 8};
}

function runSegmentChurn(iterations) {
  const receiver = new SegmentReceiver({
    absoluteTimeout: 60000,
    completedRetentionTimeout: 60000,
    idleTimeout: 60000,
    maxBytesPerTransfer: 64,
    maxCompletedTransfers: 8,
    maxCompletedTransfersPerPeer: 2,
    maxSegments: 4,
    maxTotalBytes: 128,
    maxTransfers: 8,
    maxTransfersPerPeer: 2
  });
  for (let index = 0; index < iterations; index++) {
    const peerKey = 'churn-' + index;
    const first = receiver.accept(segment({invokeId: index & 0xFF, peerKey: peerKey}));
    assert.strictEqual(first.status, 'pending');
    const completed = receiver.accept(segment({
      invokeId: index & 0xFF,
      moreFollows: false,
      peerKey: peerKey,
      sequenceNumber: 1
    }));
    assert.strictEqual(completed.status, 'complete');
    assert.strictEqual(receiver.size, 0, 'completed segment state leaked');
    assert.strictEqual(receiver.totalBytes, 0, 'completed segment bytes leaked');
    assert(receiver.completedSize <= 8, 'completion replay state exceeded its configured bound');
  }
  const retained = receiver.completedSize;
  receiver.cancelAll();
  assert.strictEqual(receiver.completedSize, 0);
  return {completed: iterations, maxRetained: 8, retainedBeforeClose: retained};
}

function main() {
  const iterations = configuredIterations();
  const segmentIterations = Math.max(1, Math.floor(iterations / 10));
  const startedAt = process.hrtime.bigint();
  const transport = runTransportChurn(iterations);
  const transactions = runTransactionBoundary();
  const serverTransactions = runServerTransactionChurn(iterations);
  const segmentBoundary = runSegmentBoundary();
  const segments = runSegmentChurn(segmentIterations);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1000000;
  process.stdout.write(JSON.stringify({
    elapsedMs: Math.round(elapsedMs),
    iterations: iterations,
    segmentBoundary: segmentBoundary,
    segments: segments,
    serverTransactions: serverTransactions,
    transactions: transactions,
    transport: transport
  }) + '\n');
}

main();
