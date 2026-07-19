'use strict';

const EventEmitter = require('events').EventEmitter;
const expect = require('chai').expect;

const Client = require('../../lib/client');
const baApdu = require('../../lib/apdu');
const baBvlc = require('../../lib/bvlc');
const baEnum = require('../../lib/enum');
const baNpdu = require('../../lib/npdu');
const baServices = require('../../lib/services');
const SegmentReceiver = require('../../lib/client/segment-receiver');
const TransactionManager = require('../../lib/client/transaction-manager');

const READ_PROPERTY = baEnum.ConfirmedServiceChoice.READ_PROPERTY;
const SEGMENTED = baEnum.PduConReqBits.SEGMENTED_MESSAGE;
const MORE_FOLLOWS = baEnum.PduConReqBits.MORE_FOLLOWS;

class CaptureTransport extends EventEmitter {
  constructor(addressKind) {
    super();
    this.addressKind = addressKind || 'ip';
    this.closed = 0;
    this.opened = 0;
    this.sent = [];
  }

  getAddressKind() {
    return this.addressKind;
  }

  getBroadcastAddress() {
    return this.addressKind === 'vmac' ? 'ffffffffffff' : '255.255.255.255';
  }

  getMaxPayload() {
    return 1482;
  }

  open() {
    this.opened++;
  }

  close() {
    this.closed++;
  }

  send(buffer, offset, receiver, context) {
    this.sent.push({
      buffer: Buffer.from(buffer.subarray(0, offset)),
      receiver: receiver,
      context: context
    });
    return true;
  }

  receive(packet, remoteAddress, metadata) {
    this.emit('message', packet, remoteAddress, 47808, metadata);
  }
}

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  now = () => this.time;

  setTimeout = (callback, delay) => {
    const timer = {id: this.nextId++, at: this.time + delay, callback: callback};
    this.timers.set(timer.id, timer);
    return timer;
  };

  clearTimeout = (timer) => {
    if (timer) this.timers.delete(timer.id);
  };

  tick(milliseconds) {
    const end = this.time + milliseconds;
    while (true) {
      const due = Array.from(this.timers.values())
        .filter((timer) => timer.at <= end)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!due) break;
      this.time = due.at;
      this.timers.delete(due.id);
      due.callback();
    }
    this.time = end;
  }
}

function createContext(options) {
  options = options || {};
  const transport = new CaptureTransport(options.addressKind);
  const client = new Client(Object.assign({
    apduTimeout: 1000,
    transport: transport
  }, options, {
    addressKind: undefined
  }));
  return {client: client, transport: transport};
}

function encodeService(encoder) {
  const buffer = {buffer: Buffer.alloc(1024), offset: 0};
  encoder(buffer);
  return Buffer.from(buffer.buffer.subarray(0, buffer.offset));
}

function readPropertyRequest(instance) {
  return encodeService((buffer) => baServices.readProperty.encode(
    buffer,
    baEnum.ObjectType.DEVICE,
    instance,
    baEnum.PropertyIdentifier.PRESENT_VALUE,
    baEnum.ASN1_ARRAY_ALL
  ));
}

function readPropertyAck(instance, value) {
  return encodeService((buffer) => baServices.readProperty.encodeAcknowledge(
    buffer,
    {type: baEnum.ObjectType.DEVICE, instance: instance},
    baEnum.PropertyIdentifier.PRESENT_VALUE,
    baEnum.ASN1_ARRAY_ALL,
    [{type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: value}]
  ));
}

function segmentedPacket(options) {
  const buffer = {buffer: Buffer.alloc(2048), offset: baBvlc.BVLC_HEADER_LENGTH};
  baNpdu.encode(
    buffer,
    baEnum.NpduControlPriority.NORMAL_MESSAGE,
    options.destination || null,
    options.source,
    0xFF,
    baEnum.NetworkLayerMessageType.WHO_IS_ROUTER_TO_NETWORK,
    0
  );

  const more = options.moreFollows ? MORE_FOLLOWS : 0;
  if (options.direction === 'request') {
    baApdu.encodeConfirmedServiceRequest(
      buffer,
      baEnum.PduTypes.CONFIRMED_REQUEST | SEGMENTED | more,
      options.service == null ? READ_PROPERTY : options.service,
      baEnum.MaxSegmentsAccepted.SEGMENTS_8,
      baEnum.MaxApduLengthAccepted.OCTETS_1476,
      options.invokeId,
      options.sequenceNumber,
      options.windowSize
    );
  } else {
    baApdu.encodeComplexAck(
      buffer,
      baEnum.PduTypes.COMPLEX_ACK | SEGMENTED | more,
      options.service == null ? READ_PROPERTY : options.service,
      options.invokeId,
      options.sequenceNumber,
      options.windowSize
    );
  }
  options.payload.copy(buffer.buffer, buffer.offset);
  buffer.offset += options.payload.length;
  baBvlc.encode(
    buffer.buffer,
    options.broadcast ? baEnum.BvlcResultPurpose.ORIGINAL_BROADCAST_NPDU :
      baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU,
    buffer.offset
  );
  return Buffer.from(buffer.buffer.subarray(0, buffer.offset));
}

function complexAckPacket(options) {
  const buffer = {buffer: Buffer.alloc(2048), offset: baBvlc.BVLC_HEADER_LENGTH};
  baNpdu.encode(
    buffer,
    baEnum.NpduControlPriority.NORMAL_MESSAGE,
    null,
    null,
    0xFF,
    baEnum.NetworkLayerMessageType.WHO_IS_ROUTER_TO_NETWORK,
    0
  );
  baApdu.encodeComplexAck(
    buffer,
    baEnum.PduTypes.COMPLEX_ACK,
    options.service == null ? READ_PROPERTY : options.service,
    options.invokeId,
    0,
    0
  );
  options.payload.copy(buffer.buffer, buffer.offset);
  buffer.offset += options.payload.length;
  baBvlc.encode(
    buffer.buffer,
    baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU,
    buffer.offset
  );
  return Buffer.from(buffer.buffer.subarray(0, buffer.offset));
}

function whoIsPacket() {
  const buffer = {buffer: Buffer.alloc(256), offset: baBvlc.BVLC_HEADER_LENGTH};
  baNpdu.encode(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE);
  baApdu.encodeUnconfirmedServiceRequest(
    buffer,
    baEnum.PduTypes.UNCONFIRMED_REQUEST,
    baEnum.UnconfirmedServiceChoice.WHO_IS
  );
  baServices.whoIs.encode(buffer);
  baBvlc.encode(
    buffer.buffer,
    baEnum.BvlcResultPurpose.ORIGINAL_BROADCAST_NPDU,
    buffer.offset
  );
  return Buffer.from(buffer.buffer.subarray(0, buffer.offset));
}

function decodeSent(packet) {
  const bvlc = baBvlc.decode(packet, 0);
  expect(bvlc).not.to.equal(undefined);
  const npdu = baNpdu.decode(packet, bvlc.len, packet.length - bvlc.len);
  expect(npdu).not.to.equal(undefined);
  const offset = bvlc.len + npdu.len;
  const type = baApdu.getDecodedType(packet, offset);
  let apdu;
  switch (type & baEnum.PDU_TYPE_MASK) {
    case baEnum.PduTypes.SEGMENT_ACK:
      apdu = baApdu.decodeSegmentAck(packet, offset, packet.length - offset);
      break;
    case baEnum.PduTypes.ABORT:
      apdu = baApdu.decodeAbort(packet, offset, packet.length - offset);
      break;
    default:
      throw new Error('Unexpected outgoing APDU type: ' + type);
  }
  return {apdu: apdu, npdu: npdu, type: type};
}

function decodeConfirmedRequest(packet) {
  const bvlc = baBvlc.decode(packet, 0);
  const npdu = baNpdu.decode(packet, bvlc.len, packet.length - bvlc.len);
  return baApdu.decodeConfirmedServiceRequest(
    packet,
    bvlc.len + npdu.len,
    packet.length - bvlc.len - npdu.len
  );
}

function halves(payload) {
  const split = Math.max(1, Math.floor(payload.length / 2));
  return [payload.subarray(0, split), payload.subarray(split)];
}

function metadata(messageId, flow) {
  return Object.freeze({
    transport: 'bacnet-sc',
    messageId: messageId,
    originating: flow,
    destination: '0200000000ff',
    dataOptions: Object.freeze([])
  });
}

function installFakeClock(client, clock, options) {
  options = options || {};
  client._transactions.close();
  client._segments.cancelAll();
  client._transactions = new TransactionManager({
    allowRoutedResponseFallback: client._settings.allowRoutedResponseFallback,
    clearTimeout: clock.clearTimeout,
    defaultTimeout: options.apduTimeout || 10,
    now: clock.now,
    segmentedResponseRetention: options.idleTimeout || 5,
    setTimeout: clock.setTimeout,
    stringAddressKind: client._addressKind
  });
  client._segments = new SegmentReceiver({
    absoluteTimeout: options.absoluteTimeout || 20,
    clearTimeout: clock.clearTimeout,
    idleTimeout: options.idleTimeout || 5,
    now: clock.now,
    onExpire: client._onSegmentExpire.bind(client),
    setTimeout: clock.setTimeout
  });
}

describe('bacstack - Client segmented APDU integration', () => {
  let contexts;

  beforeEach(() => {
    contexts = [];
  });

  afterEach(() => {
    contexts.forEach((context) => {
      if (!context.client._closed) context.client.close();
    });
  });

  function context(options) {
    const result = createContext(options);
    contexts.push(result);
    return result;
  }

  it('isolates interleaved ComplexACK transfers by peer and invoke ID', () => {
    const current = context();
    const callbacks = [];
    const settlements = [];
    const originalSettle = current.client._transactions.settle.bind(current.client._transactions);
    current.client._transactions.settle = (details) => {
      settlements.push(details);
      return originalSettle(details);
    };
    const requests = [
      {peer: '192.0.2.10', invokeId: 7, value: 107, flow: 'a7'},
      {peer: '192.0.2.20', invokeId: 7, value: 207, flow: 'b7'},
      {peer: '192.0.2.10', invokeId: 8, value: 108, flow: 'a8'}
    ];

    requests.forEach((request) => {
      current.client.readProperty(
        request.peer,
        {type: baEnum.ObjectType.DEVICE, instance: request.value},
        baEnum.PropertyIdentifier.PRESENT_VALUE,
        {invokeId: request.invokeId},
        (error, result, linkContext) => callbacks.push({
          error: error,
          flow: request.flow,
          linkContext: linkContext,
          value: result && result.values[0].value
        })
      );
      request.parts = halves(readPropertyAck(request.value, request.value));
    });
    current.transport.sent.length = 0;

    const emit = (request, sequenceNumber) => current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: request.invokeId,
      moreFollows: sequenceNumber === 0,
      payload: request.parts[sequenceNumber],
      sequenceNumber: sequenceNumber,
      windowSize: 4
    }), request.peer, metadata(request.flow + '-' + sequenceNumber, request.flow));

    emit(requests[0], 0);
    emit(requests[1], 0);
    emit(requests[2], 0);
    expect(callbacks).to.deep.equal([]);
    emit(requests[1], 1);
    emit(requests[2], 1);
    emit(requests[0], 1);

    expect(callbacks.map((entry) => entry.flow)).to.deep.equal(['b7', 'a8', 'a7']);
    callbacks.forEach((entry) => {
      expect(entry.error).to.equal(null);
      expect(entry.linkContext).to.include({segmented: true, segmentCount: 2});
      expect(entry.linkContext.messageIds).to.deep.equal([entry.flow + '-0', entry.flow + '-1']);
    });
    expect(callbacks.map((entry) => entry.value)).to.deep.equal([207, 108, 107]);
    expect(settlements).to.have.length(3);
    settlements.forEach((details) => {
      expect(details.pduType).to.equal(baEnum.PduTypes.COMPLEX_ACK);
      expect(details.result.result.type).to.equal(baEnum.PduTypes.COMPLEX_ACK);
    });
    expect(current.client._transactions.size).to.equal(0);
    expect(current.client._segments.size).to.equal(0);
  });

  it('lets valid segmented response progress continue beyond the request timeout', () => {
    const current = context();
    const clock = new FakeClock();
    const callbacks = [];
    const payload = readPropertyAck(18, 180);
    const split = Math.ceil(payload.length / 3);
    const parts = [
      payload.subarray(0, split),
      payload.subarray(split, split * 2),
      payload.subarray(split * 2)
    ];
    installFakeClock(current.client, clock);
    current.client.readProperty(
      '192.0.2.18',
      {type: baEnum.ObjectType.DEVICE, instance: 18},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 18},
      (error, result) => callbacks.push({error, result})
    );
    current.transport.sent.length = 0;
    const receive = (sequenceNumber) => current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 18,
      moreFollows: sequenceNumber < 2,
      payload: parts[sequenceNumber],
      sequenceNumber: sequenceNumber,
      windowSize: 2
    }), '192.0.2.18');

    clock.tick(8);
    receive(0);
    clock.tick(4);
    expect(callbacks).to.deep.equal([]);
    expect(current.client._transactions.size).to.equal(1);
    receive(1);
    clock.tick(4);
    expect(callbacks).to.deep.equal([]);
    receive(2);

    expect(callbacks).to.have.length(1);
    expect(callbacks[0].error).to.equal(null);
    expect(callbacks[0].result.values[0].value).to.equal(180);
    expect(current.client._transactions.size).to.equal(0);
    expect(current.client._segments.size).to.equal(0);

    receive(2);
    expect(callbacks).to.have.length(1);
    expect(current.transport.sent).to.have.length(3);
    expect(decodeSent(current.transport.sent[2].buffer).apdu).to.include({
      originalInvokeId: 18,
      sequencenumber: 2
    });
  });

  it('does not let an old response tombstone consume a reused invoke ID', () => {
    const current = context();
    const clock = new FakeClock();
    const callbacks = [];
    const parts = halves(readPropertyAck(19, 190));
    installFakeClock(current.client, clock, {
      absoluteTimeout: 100,
      apduTimeout: 10,
      idleTimeout: 30
    });
    const request = () => current.client.readProperty(
      '192.0.2.19',
      {type: baEnum.ObjectType.DEVICE, instance: 19},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 19, timeout: 10},
      (error, result) => callbacks.push({error, result})
    );
    const receive = (sequenceNumber) => current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 19,
      moreFollows: sequenceNumber === 0,
      payload: parts[sequenceNumber],
      sequenceNumber: sequenceNumber,
      windowSize: 2
    }), '192.0.2.19');

    request();
    current.transport.sent.length = 0;
    receive(0);
    receive(1);
    expect(callbacks).to.have.length(1);
    expect(callbacks[0].error).to.equal(null);
    expect(current.client._segments.completedSize).to.equal(1);

    clock.tick(10);
    expect(request).to.throw('ERR_INVOKE_ID_QUARANTINED')
      .with.property('code', 'ERR_INVOKE_ID_QUARANTINED');
    receive(1);
    expect(callbacks).to.have.length(1);
    expect(current.client._transactions.size).to.equal(0);

    clock.tick(20);
    request();
    current.transport.sent.length = 0;
    receive(1);
    expect(callbacks).to.have.length(1);
    expect(current.client._transactions.size).to.equal(1);
    receive(0);
    receive(1);

    expect(callbacks).to.have.length(2);
    expect(callbacks[1].error).to.equal(null);
    expect(callbacks[1].result.values[0].value).to.equal(190);
    expect(current.client._transactions.size).to.equal(0);
    expect(current.client._segments.completedSize).to.equal(1);
  });

  it('aborts and fails a stalled segmented response exactly once at idle expiry', () => {
    const current = context();
    const clock = new FakeClock();
    const callbacks = [];
    installFakeClock(current.client, clock);
    current.client.readProperty(
      '192.0.2.20',
      {type: baEnum.ObjectType.DEVICE, instance: 20},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 20},
      (error, result) => callbacks.push({error, result})
    );
    current.transport.sent.length = 0;

    clock.tick(8);
    current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 20,
      moreFollows: true,
      payload: Buffer.from('partial'),
      sequenceNumber: 0,
      windowSize: 2
    }), '192.0.2.20');
    clock.tick(5);

    expect(callbacks).to.have.length(1);
    expect(callbacks[0].error).to.include({
      code: 'BACNET_SEGMENTATION_ERROR',
      reason: 'IDLE_TIMEOUT'
    });
    expect(callbacks[0].result).to.equal(undefined);
    expect(current.client._transactions.size).to.equal(0);
    expect(current.client._segments.size).to.equal(0);
    expect(current.transport.sent).to.have.length(2);
    const abort = decodeSent(current.transport.sent[1].buffer);
    expect(abort.type).to.equal(baEnum.PduTypes.ABORT);
    expect(abort.apdu.reason).to.equal(baEnum.AbortReason.TSM_TIMEOUT);

    clock.tick(50);
    expect(callbacks).to.have.length(1);
    expect(current.transport.sent).to.have.length(2);
  });

  it('contains an initial response SegmentACK throw and fails exactly once', () => {
    const current = context();
    const callbacks = [];
    current.client.readProperty(
      '192.0.2.21',
      {type: baEnum.ObjectType.DEVICE, instance: 21},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 21},
      (error, result) => callbacks.push({error, result})
    );
    current.transport.sent.length = 0;
    const send = current.transport.send.bind(current.transport);
    let sends = 0;
    current.transport.send = (...args) => {
      sends++;
      if (sends === 1) throw new Error('ACK transport failed');
      return send(...args);
    };

    expect(() => current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 21,
      moreFollows: true,
      payload: Buffer.from('partial'),
      sequenceNumber: 0,
      windowSize: 2
    }), '192.0.2.21')).not.to.throw();

    expect(callbacks).to.have.length(1);
    expect(callbacks[0].error).to.include({
      code: 'BACNET_SEGMENTATION_ERROR',
      reason: 'SEGMENT_ACK_FAILED'
    });
    expect(callbacks[0].result).to.equal(undefined);
    expect(current.client._transactions.size).to.equal(0);
    expect(current.client._segments.size).to.equal(0);
    expect(current.transport.sent).to.have.length(1);
    expect(decodeSent(current.transport.sent[0].buffer).type & baEnum.PDU_TYPE_MASK)
      .to.equal(baEnum.PduTypes.ABORT);
  });

  it('contains a final response SegmentACK false result without settling success', () => {
    const current = context();
    const callbacks = [];
    const parts = halves(readPropertyAck(22, 220));
    current.client.readProperty(
      '192.0.2.22',
      {type: baEnum.ObjectType.DEVICE, instance: 22},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 22},
      (error, result) => callbacks.push({error, result})
    );
    current.transport.sent.length = 0;
    const send = current.transport.send.bind(current.transport);
    let sends = 0;
    current.transport.send = (...args) => {
      sends++;
      if (sends === 2) return false;
      return send(...args);
    };
    const receive = (sequenceNumber) => current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 22,
      moreFollows: sequenceNumber === 0,
      payload: parts[sequenceNumber],
      sequenceNumber: sequenceNumber,
      windowSize: 2
    }), '192.0.2.22');

    receive(0);
    expect(() => receive(1)).not.to.throw();
    expect(callbacks).to.have.length(1);
    expect(callbacks[0].error).to.include({
      code: 'BACNET_SEGMENTATION_ERROR',
      reason: 'SEGMENT_ACK_FAILED'
    });
    expect(callbacks[0].result).to.equal(undefined);
    expect(current.client._segments.size).to.equal(0);
    expect(current.client._segments.completedSize).to.equal(0);
    expect(current.transport.sent).to.have.length(2);
    expect(decodeSent(current.transport.sent[1].buffer).type & baEnum.PDU_TYPE_MASK)
      .to.equal(baEnum.PduTypes.ABORT);
  });

  it('silently drops unsolicited and mismatched segmented responses', () => {
    const current = context();
    const packet = (service) => segmentedPacket({
      direction: 'response',
      invokeId: 24,
      moreFollows: true,
      payload: Buffer.from('partial'),
      sequenceNumber: 0,
      service: service,
      windowSize: 2
    });

    current.transport.receive(packet(READ_PROPERTY), '192.0.2.24');
    expect(current.transport.sent).to.have.length(0);
    expect(current.client._segments.size).to.equal(0);

    current.client.readProperty(
      '192.0.2.24',
      {type: baEnum.ObjectType.DEVICE, instance: 24},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 24},
      () => {}
    );
    current.transport.sent.length = 0;
    current.transport.receive(packet(READ_PROPERTY + 1), '192.0.2.24');
    expect(current.transport.sent).to.have.length(0);
    expect(current.client._segments.size).to.equal(0);
    expect(current.client._transactions.size).to.equal(1);
  });

  it('drops confirmed broadcast APDUs without blocking unconfirmed discovery', () => {
    [
      {addressKind: 'ip', peer: '192.0.2.29', metadata: undefined},
      {
        addressKind: 'vmac',
        peer: '020000000029',
        metadata: Object.freeze({
          transport: 'bacnet-sc',
          messageId: 'broadcast-request',
          originating: '020000000029',
          destination: 'ffffffffffff',
          dataOptions: Object.freeze([])
        })
      }
    ].forEach((settings) => {
      const current = context({addressKind: settings.addressKind});
      const confirmed = [];
      const discoveries = [];
      current.client.on('readProperty', (event) => confirmed.push(event));
      current.client.on('whoIs', (event) => discoveries.push(event));

      current.transport.receive(segmentedPacket({
        broadcast: true,
        direction: 'request',
        invokeId: 29,
        moreFollows: true,
        payload: Buffer.from('partial'),
        sequenceNumber: 0,
        windowSize: 2
      }), settings.peer, settings.metadata);
      expect(confirmed).to.deep.equal([]);
      expect(current.transport.sent).to.have.length(0);
      expect(current.client._segments.size).to.equal(0);

      current.transport.receive(whoIsPacket(), settings.peer, settings.metadata);
      expect(discoveries).to.have.length(1);
    });

    [303, 0xFFFF].forEach((network) => {
      const current = context();
      const confirmed = [];
      current.client.on('readProperty', (event) => confirmed.push(event));
      current.transport.receive(segmentedPacket({
        destination: {net: network},
        direction: 'request',
        invokeId: 30,
        moreFollows: true,
        payload: Buffer.from('partial'),
        sequenceNumber: 0,
        windowSize: 2
      }), '192.0.2.30');
      expect(confirmed).to.deep.equal([]);
      expect(current.transport.sent).to.have.length(0);
      expect(current.client._segments.size).to.equal(0);
    });
  });

  it('ignores an unsegmented success after segmented response state begins', () => {
    const current = context();
    const callbacks = [];
    const payload = readPropertyAck(28, 280);
    const parts = halves(payload);
    current.client.readProperty(
      '192.0.2.28',
      {type: baEnum.ObjectType.DEVICE, instance: 28},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 28},
      (error, result) => callbacks.push({error, result})
    );
    current.transport.sent.length = 0;
    current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 28,
      moreFollows: true,
      payload: parts[0],
      sequenceNumber: 0,
      windowSize: 2
    }), '192.0.2.28');
    current.transport.receive(complexAckPacket({
      invokeId: 28,
      payload: payload
    }), '192.0.2.28');

    expect(callbacks).to.deep.equal([]);
    expect(current.client._transactions.size).to.equal(1);
    expect(current.client._segments.size).to.equal(1);

    current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 28,
      moreFollows: false,
      payload: parts[1],
      sequenceNumber: 1,
      windowSize: 2
    }), '192.0.2.28');
    expect(callbacks).to.have.length(1);
    expect(callbacks[0].error).to.equal(null);
    expect(callbacks[0].result.values[0].value).to.equal(280);
  });

  it('rejects a response segment larger than the advertised APDU length', () => {
    const current = context();
    const callbacks = [];
    current.client.readProperty(
      '192.0.2.25',
      {type: baEnum.ObjectType.DEVICE, instance: 25},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {
        invokeId: 25,
        maxApdu: baEnum.MaxApduLengthAccepted.OCTETS_50
      },
      (error, result) => callbacks.push({error, result})
    );
    current.transport.sent.length = 0;
    current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 25,
      moreFollows: true,
      payload: Buffer.alloc(46),
      sequenceNumber: 0,
      windowSize: 2
    }), '192.0.2.25');

    expect(current.client._segments.size).to.equal(0);
    expect(callbacks).to.have.length(1);
    expect(callbacks[0].error).to.include({
      code: 'BACNET_SEGMENTATION_ERROR',
      reason: 'APDU_TOO_LONG'
    });
    expect(callbacks[0].result).to.equal(undefined);
    expect(current.transport.sent).to.have.length(1);
    const abort = decodeSent(current.transport.sent[0].buffer);
    expect(abort.apdu.reason).to.equal(baEnum.AbortReason.APDU_TOO_LONG);
  });

  it('enforces the advertised APDU length for unsegmented ComplexACKs', () => {
    const exact = context();
    const exactCallbacks = [];
    const exactPayload = encodeService((buffer) => baServices.readProperty.encodeAcknowledge(
      buffer,
      {type: baEnum.ObjectType.DEVICE, instance: 26},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      baEnum.ASN1_ARRAY_ALL,
      [{type: baEnum.ApplicationTags.OCTET_STRING, value: Buffer.alloc(36)}]
    ));
    exact.client.readProperty(
      '192.0.2.26',
      {type: baEnum.ObjectType.DEVICE, instance: 26},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 26, maxApdu: baEnum.MaxApduLengthAccepted.OCTETS_50},
      (error, result) => exactCallbacks.push({error, result})
    );
    exact.transport.sent.length = 0;
    exact.transport.receive(complexAckPacket({
      invokeId: 26,
      payload: exactPayload
    }), '192.0.2.26');

    expect(exactCallbacks).to.have.length(1);
    expect(exactCallbacks[0].error).to.equal(null);
    expect(exactCallbacks[0].result.values[0].value).to.deep.equal(Array(36).fill(0));
    expect(exact.transport.sent).to.have.length(0);

    const oversized = context();
    const oversizedCallbacks = [];
    oversized.client.readProperty(
      '192.0.2.27',
      {type: baEnum.ObjectType.DEVICE, instance: 27},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 27, maxApdu: baEnum.MaxApduLengthAccepted.OCTETS_50},
      (error, result) => oversizedCallbacks.push({error, result})
    );
    oversized.transport.sent.length = 0;
    oversized.transport.receive(complexAckPacket({
      invokeId: 27,
      payload: encodeService((buffer) => baServices.readProperty.encodeAcknowledge(
        buffer,
        {type: baEnum.ObjectType.DEVICE, instance: 27},
        baEnum.PropertyIdentifier.PRESENT_VALUE,
        baEnum.ASN1_ARRAY_ALL,
        [{type: baEnum.ApplicationTags.OCTET_STRING, value: Buffer.alloc(37)}]
      ))
    }), '192.0.2.27');

    expect(oversizedCallbacks).to.have.length(1);
    expect(oversizedCallbacks[0].error).to.include({
      code: 'BACNET_SEGMENTATION_ERROR',
      reason: 'APDU_TOO_LONG'
    });
    expect(oversizedCallbacks[0].result).to.equal(undefined);
    expect(oversized.transport.sent).to.have.length(1);
    expect(decodeSent(oversized.transport.sent[0].buffer).apdu.reason).to.equal(
      baEnum.AbortReason.APDU_TOO_LONG
    );
  });

  it('sends positive response ACKs at the window boundary and on the final segment', () => {
    const current = context();
    const chunks = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')];
    current.client.readProperty(
      '192.0.2.19',
      {type: baEnum.ObjectType.DEVICE, instance: 19},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 19},
      () => {}
    );
    current.transport.sent.length = 0;
    const receive = (sequenceNumber, moreFollows) => current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 19,
      moreFollows: moreFollows,
      payload: chunks[sequenceNumber],
      sequenceNumber: sequenceNumber,
      windowSize: 2
    }), '192.0.2.19');

    receive(0, true);
    expect(current.transport.sent).to.have.length(1);
    receive(1, true);
    expect(current.transport.sent).to.have.length(1);
    receive(2, false);
    expect(current.transport.sent).to.have.length(2);

    const initial = decodeSent(current.transport.sent[0].buffer);
    const final = decodeSent(current.transport.sent[1].buffer);
    expect(initial.apdu).to.include({
      originalInvokeId: 19,
      sequencenumber: 0,
      actualWindowSize: 2
    });
    expect(final.apdu).to.include({
      originalInvokeId: 19,
      sequencenumber: 2,
      actualWindowSize: 2
    });
    expect(initial.type & baEnum.PduSegAckBits.NEGATIVE_ACK).to.equal(0);
    expect(initial.type & baEnum.PduSegAckBits.SERVER).to.equal(0);
    expect(final.type & baEnum.PduSegAckBits.NEGATIVE_ACK).to.equal(0);
    expect(current.client._segments.size).to.equal(0);
  });

  it('negative-acknowledges an out-of-order segment without appending it', () => {
    const current = context();
    current.client.readProperty(
      '192.0.2.23',
      {type: baEnum.ObjectType.DEVICE, instance: 23},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 23},
      () => {}
    );
    current.transport.sent.length = 0;
    const receive = (sequenceNumber, moreFollows, payload) => current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 23,
      moreFollows: moreFollows,
      payload: Buffer.from(payload),
      sequenceNumber: sequenceNumber,
      windowSize: 3
    }), '192.0.2.23');

    receive(0, true, 'a');
    receive(2, true, 'discarded');

    expect(current.transport.sent).to.have.length(2);
    const negative = decodeSent(current.transport.sent[1].buffer);
    expect(negative.type & baEnum.PduSegAckBits.NEGATIVE_ACK).to.equal(
      baEnum.PduSegAckBits.NEGATIVE_ACK
    );
    expect(negative.type & baEnum.PduSegAckBits.SERVER).to.equal(0);
    expect(negative.apdu).to.include({
      originalInvokeId: 23,
      sequencenumber: 0,
      actualWindowSize: 3
    });
    expect(current.client._segments.totalBytes).to.equal(1);

    receive(1, false, 'b');
    expect(current.client._segments.size).to.equal(0);
    expect(current.client._segments.totalBytes).to.equal(0);
  });

  it('reassembles a routed VMAC confirmed request and returns a server ACK through its router', () => {
    const current = context({addressKind: 'vmac'});
    const routerVmac = '0200000000aa';
    const route = {net: 303, adr: [5, 0xFE]};
    const payload = readPropertyRequest(47);
    const parts = halves(payload);
    let event;
    current.client.once('readProperty', (value) => event = value);

    const receive = (sequenceNumber) => current.transport.receive(segmentedPacket({
      direction: 'request',
      invokeId: 31,
      moreFollows: sequenceNumber === 0,
      payload: parts[sequenceNumber],
      sequenceNumber: sequenceNumber,
      source: route,
      windowSize: 2
    }), routerVmac, metadata('request-' + sequenceNumber, 'routed-request'));

    receive(0);
    expect(event).to.equal(undefined);
    expect(current.transport.sent).to.have.length(1);
    receive(1);

    expect(event).not.to.equal(undefined);
    expect(event.invokeId).to.equal(31);
    expect(event.address).to.deep.equal(event.sourceAddress);
    expect(event.address).to.deep.equal({vmac: routerVmac, net: 303, adr: [5, 0xFE]});
    expect(event.request).to.deep.equal({
      len: payload.length,
      objectId: {type: baEnum.ObjectType.DEVICE, instance: 47},
      property: {id: baEnum.PropertyIdentifier.PRESENT_VALUE, index: baEnum.ASN1_ARRAY_ALL}
    });
    expect(event.linkContext).to.include({
      messageId: 'request-0',
      segmented: true,
      segmentCount: 2
    });
    expect(event.linkContext.messageIds).to.deep.equal(['request-0', 'request-1']);

    expect(current.transport.sent).to.have.length(2);
    expect(current.transport.sent[1].receiver).to.equal(routerVmac);
    const acknowledgment = decodeSent(current.transport.sent[1].buffer);
    expect(acknowledgment.type & baEnum.PduSegAckBits.SERVER).to.equal(
      baEnum.PduSegAckBits.SERVER
    );
    expect(acknowledgment.type & baEnum.PduSegAckBits.NEGATIVE_ACK).to.equal(0);
    expect(acknowledgment.apdu).to.include({
      originalInvokeId: 31,
      sequencenumber: 1,
      actualWindowSize: 2
    });
    expect(acknowledgment.npdu.destination).to.deep.equal({
      type: 0,
      net: 303,
      adr: [5, 0xFE]
    });
  });

  it('uses the canonical route for fallback reassembly, cleanup, and final replay ACK', () => {
    const current = context({allowRoutedResponseFallback: true});
    const router = '192.0.2.254';
    const route = {ip: router, net: 303, adr: [7]};
    const callbacks = [];
    const parts = halves(readPropertyAck(58, 580));
    current.client.readProperty(
      route,
      {type: baEnum.ObjectType.DEVICE, instance: 58},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 58},
      (error, result) => callbacks.push({error, result})
    );
    current.transport.sent.length = 0;
    const receive = (sequenceNumber) => current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 58,
      moreFollows: sequenceNumber === 0,
      payload: parts[sequenceNumber],
      sequenceNumber: sequenceNumber,
      windowSize: 2
    }), router);

    receive(0);
    expect(current.client._segments.size).to.equal(1);
    expect(decodeSent(current.transport.sent[0].buffer).npdu.destination).to.deep.include({
      net: 303,
      adr: [7]
    });
    receive(1);
    expect(callbacks).to.have.length(1);
    expect(callbacks[0].error).to.equal(null);
    expect(current.client._segments.size).to.equal(0);
    expect(current.client._segments.completedSize).to.equal(1);

    receive(1);
    expect(callbacks).to.have.length(1);
    expect(current.transport.sent).to.have.length(3);
    expect(decodeSent(current.transport.sent[2].buffer).npdu.destination).to.deep.include({
      net: 303,
      adr: [7]
    });

    const cancelled = context({allowRoutedResponseFallback: true});
    const controller = new AbortController();
    const cancelledCalls = [];
    cancelled.client.readProperty(
      route,
      {type: baEnum.ObjectType.DEVICE, instance: 59},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 59, signal: controller.signal},
      (error) => cancelledCalls.push(error)
    );
    cancelled.transport.sent.length = 0;
    cancelled.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 59,
      moreFollows: true,
      payload: Buffer.from('partial'),
      sequenceNumber: 0,
      windowSize: 2
    }), router);
    expect(cancelled.client._segments.size).to.equal(1);
    controller.abort(new Error('cancel routed response'));
    expect(cancelledCalls).to.have.length(1);
    expect(cancelled.client._segments.size).to.equal(0);
  });

  it('expires a routed fallback transfer without leaking its canonical state', () => {
    const current = context({allowRoutedResponseFallback: true});
    const clock = new FakeClock();
    const route = {ip: '192.0.2.254', net: 304, adr: [8]};
    const callbacks = [];
    installFakeClock(current.client, clock);
    current.client.readProperty(
      route,
      {type: baEnum.ObjectType.DEVICE, instance: 60},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 60},
      (error) => callbacks.push(error)
    );
    current.transport.sent.length = 0;
    clock.tick(8);
    current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 60,
      moreFollows: true,
      payload: Buffer.from('partial'),
      sequenceNumber: 0,
      windowSize: 2
    }), route.ip);
    clock.tick(5);

    expect(callbacks).to.have.length(1);
    expect(callbacks[0]).to.include({
      code: 'BACNET_SEGMENTATION_ERROR',
      reason: 'IDLE_TIMEOUT'
    });
    expect(current.client._segments.size).to.equal(0);
    const abort = decodeSent(current.transport.sent[1].buffer);
    expect(abort.npdu.destination).to.deep.include({net: 304, adr: [8]});
  });

  it('ACKs final confirmed-request replay without duplicate delivery', () => {
    const current = context();
    const payload = readPropertyRequest(48);
    const parts = halves(payload);
    const events = [];
    current.client.on('readProperty', (event) => events.push(event));
    const receive = (sequenceNumber) => current.transport.receive(segmentedPacket({
      direction: 'request',
      invokeId: 48,
      moreFollows: sequenceNumber === 0,
      payload: parts[sequenceNumber],
      sequenceNumber: sequenceNumber,
      windowSize: 2
    }), '192.0.2.48');

    receive(0);
    receive(1);
    expect(events).to.have.length(1);
    expect(current.transport.sent).to.have.length(2);

    receive(1);
    expect(events).to.have.length(1);
    expect(current.transport.sent).to.have.length(3);
    const repeatedFinal = decodeSent(current.transport.sent[2].buffer);
    expect(repeatedFinal.apdu).to.include({
      originalInvokeId: 48,
      sequencenumber: 1
    });
    expect(repeatedFinal.type & baEnum.PduSegAckBits.SERVER).to.equal(
      baEnum.PduSegAckBits.SERVER
    );

    expect(current.client._segments.size).to.equal(0);
    expect(current.client._segments.completedSize).to.equal(1);
  });

  it('drops inbound requests when an initial or final SegmentACK cannot be sent', () => {
    const initial = context();
    const initialEvents = [];
    initial.client.on('readProperty', (event) => initialEvents.push(event));
    const initialSend = initial.transport.send.bind(initial.transport);
    let initialSends = 0;
    initial.transport.send = (...args) => {
      initialSends++;
      if (initialSends === 1) throw new Error('initial ACK failed');
      return initialSend(...args);
    };
    expect(() => initial.transport.receive(segmentedPacket({
      direction: 'request',
      invokeId: 56,
      moreFollows: true,
      payload: Buffer.from('partial'),
      sequenceNumber: 0,
      windowSize: 2
    }), '192.0.2.56')).not.to.throw();
    expect(initialEvents).to.deep.equal([]);
    expect(initial.client._segments.size).to.equal(0);

    const final = context();
    const finalEvents = [];
    const parts = halves(readPropertyRequest(57));
    final.client.on('readProperty', (event) => finalEvents.push(event));
    const finalSend = final.transport.send.bind(final.transport);
    let finalSends = 0;
    final.transport.send = (...args) => {
      finalSends++;
      if (finalSends === 2) return false;
      return finalSend(...args);
    };
    final.transport.receive(segmentedPacket({
      direction: 'request',
      invokeId: 57,
      moreFollows: true,
      payload: parts[0],
      sequenceNumber: 0,
      windowSize: 2
    }), '192.0.2.57');
    expect(() => final.transport.receive(segmentedPacket({
      direction: 'request',
      invokeId: 57,
      moreFollows: false,
      payload: parts[1],
      sequenceNumber: 1,
      windowSize: 2
    }), '192.0.2.57')).not.to.throw();
    expect(finalEvents).to.deep.equal([]);
    expect(final.client._segments.size).to.equal(0);
    expect(final.client._segments.completedSize).to.equal(0);
  });

  it('preserves first-only SC Data Options and enforces every-segment options', () => {
    const current = context();
    const payload = readPropertyRequest(49);
    const parts = halves(payload);
    const events = [];
    current.client.on('readProperty', (event) => events.push(event));
    const scMetadata = (messageId, dataOptions) => Object.freeze({
      transport: 'bacnet-sc',
      messageId: messageId,
      originating: '020000000049',
      destination: '0200000000ff',
      dataOptions: Object.freeze(dataOptions)
    });
    const firstOnly = Object.freeze({
      marker: 0xA2,
      type: 2,
      everySegment: false,
      data: Buffer.from([1])
    });
    const every = Object.freeze({
      marker: 0xE3,
      type: 3,
      everySegment: true,
      data: Buffer.from([2])
    });

    current.transport.receive(segmentedPacket({
      direction: 'request',
      invokeId: 49,
      moreFollows: true,
      payload: parts[0],
      sequenceNumber: 0,
      windowSize: 2
    }), '192.0.2.49', scMetadata('options-0', [firstOnly, every]));
    current.transport.receive(segmentedPacket({
      direction: 'request',
      invokeId: 49,
      moreFollows: false,
      payload: parts[1],
      sequenceNumber: 1,
      windowSize: 2
    }), '192.0.2.49', scMetadata('options-1', [Object.freeze(Object.assign({}, every, {
      marker: 0x63
    }))]));

    expect(events).to.have.length(1);
    expect(events[0].linkContext.dataOptions).to.deep.equal([firstOnly, every]);
    expect(events[0].linkContext.messageIds).to.deep.equal(['options-0', 'options-1']);

    const badPayload = readPropertyRequest(50);
    const badParts = halves(badPayload);
    current.transport.receive(segmentedPacket({
      direction: 'request',
      invokeId: 50,
      moreFollows: true,
      payload: badParts[0],
      sequenceNumber: 0,
      windowSize: 2
    }), '192.0.2.50', scMetadata('bad-0', [every]));
    current.transport.receive(segmentedPacket({
      direction: 'request',
      invokeId: 50,
      moreFollows: false,
      payload: badParts[1],
      sequenceNumber: 1,
      windowSize: 2
    }), '192.0.2.50', scMetadata('bad-1', [Object.freeze(Object.assign({}, every, {
      data: Buffer.from([3])
    }))]));

    expect(events).to.have.length(1);
    const abort = decodeSent(current.transport.sent[current.transport.sent.length - 1].buffer);
    expect(abort.type & baEnum.PDU_TYPE_MASK).to.equal(baEnum.PduTypes.ABORT);
    expect(abort.apdu.reason).to.equal(baEnum.AbortReason.INCONSISTENT_ATTRIBUTES);
  });

  it('refuses segmentation when the configured cap cannot advertise two segments', () => {
    const current = context({maxSegmentsPerTransfer: 1});
    const callback = [];
    const payload = readPropertyAck(52, 52);
    const parts = halves(payload);
    current.client.readProperty(
      '192.0.2.52',
      {type: baEnum.ObjectType.DEVICE, instance: 52},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 52},
      (error, result, linkContext) => callback.push({error, result, linkContext})
    );
    current.transport.sent.length = 0;

    current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 52,
      moreFollows: true,
      payload: parts[0],
      sequenceNumber: 0,
      windowSize: 2
    }), '192.0.2.52', metadata('limit-0', 'limit'));
    current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 52,
      moreFollows: false,
      payload: parts[1],
      sequenceNumber: 1,
      windowSize: 2
    }), '192.0.2.52', metadata('limit-1', 'limit'));

    expect(current.transport.sent).to.have.length(1);
    const abort = decodeSent(current.transport.sent[0].buffer);
    expect(abort.type).to.equal(baEnum.PduTypes.ABORT);
    expect(abort.apdu).to.include({
      invokeId: 52,
      reason: baEnum.AbortReason.SEGMENTATION_NOT_SUPPORTED
    });
    expect(callback).to.have.length(1);
    expect(callback[0].error).to.include({
      code: 'BACNET_SEGMENTATION_ERROR',
      reason: 'SEGMENTATION_NOT_SUPPORTED'
    });
    expect(callback[0].result).to.equal(undefined);
    expect(callback[0].linkContext.messageId).to.equal('limit-0');
    expect(current.client._transactions.size).to.equal(0);
    expect(current.client._segments.size).to.equal(0);
  });

  it('never advertises more response segments than its configured receiver cap', () => {
    const none = context({maxSegmentsPerTransfer: 1});
    none.client.readProperty(
      '192.0.2.54',
      {type: baEnum.ObjectType.DEVICE, instance: 54},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 54},
      () => {}
    );
    const noneRequest = decodeConfirmedRequest(none.transport.sent[0].buffer);
    expect(noneRequest.maxSegments).to.equal(baEnum.MaxSegmentsAccepted.SEGMENTS_0);
    expect(noneRequest.type & baEnum.PduConReqBits.SEGMENTED_RESPONSE_ACCEPTED).to.equal(0);

    const bounded = context({maxSegmentsPerTransfer: 16});
    bounded.client.readProperty(
      '192.0.2.55',
      {type: baEnum.ObjectType.DEVICE, instance: 55},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 55},
      () => {}
    );
    const boundedRequest = decodeConfirmedRequest(bounded.transport.sent[0].buffer);
    expect(boundedRequest.maxSegments).to.equal(baEnum.MaxSegmentsAccepted.SEGMENTS_16);
    expect(boundedRequest.type & baEnum.PduConReqBits.SEGMENTED_RESPONSE_ACCEPTED).to.equal(
      baEnum.PduConReqBits.SEGMENTED_RESPONSE_ACCEPTED
    );
  });

  it('aborts and fails once when the advertised response segment cap is exceeded', () => {
    const current = context({maxSegmentsPerTransfer: 2});
    const callback = [];
    const payload = readPropertyAck(53, 53);
    const split = Math.ceil(payload.length / 3);
    const parts = [
      payload.subarray(0, split),
      payload.subarray(split, split * 2),
      payload.subarray(split * 2)
    ];
    current.client.readProperty(
      '192.0.2.53',
      {type: baEnum.ObjectType.DEVICE, instance: 53},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 53},
      (error, result, linkContext) => callback.push({error, result, linkContext})
    );
    current.transport.sent.length = 0;

    parts.forEach((part, sequenceNumber) => current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 53,
      moreFollows: sequenceNumber < 2,
      payload: part,
      sequenceNumber: sequenceNumber,
      windowSize: 2
    }), '192.0.2.53', metadata('cap-' + sequenceNumber, 'cap')));

    expect(current.transport.sent).to.have.length(2);
    const abort = decodeSent(current.transport.sent[1].buffer);
    expect(abort.type).to.equal(baEnum.PduTypes.ABORT);
    expect(abort.apdu).to.include({
      invokeId: 53,
      reason: baEnum.AbortReason.BUFFER_OVERFLOW
    });
    expect(callback).to.have.length(1);
    expect(callback[0].error).to.include({
      code: 'BACNET_SEGMENTATION_ERROR',
      reason: 'SEGMENT_LIMIT'
    });
    expect(callback[0].linkContext.messageId).to.equal('cap-2');
    expect(current.client._transactions.size).to.equal(0);
    expect(current.client._segments.size).to.equal(0);
  });

  it('cleans active transactions and both segment directions on close', () => {
    const current = context();
    const callback = [];
    current.client.readProperty(
      '192.0.2.60',
      {type: baEnum.ObjectType.DEVICE, instance: 60},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      {invokeId: 60},
      (error, result) => callback.push({error, result})
    );
    current.transport.sent.length = 0;

    current.transport.receive(segmentedPacket({
      direction: 'response',
      invokeId: 60,
      moreFollows: true,
      payload: Buffer.from('response'),
      sequenceNumber: 0,
      windowSize: 2
    }), '192.0.2.60');
    current.transport.receive(segmentedPacket({
      direction: 'request',
      invokeId: 61,
      moreFollows: true,
      payload: Buffer.from('request'),
      sequenceNumber: 0,
      windowSize: 2
    }), '192.0.2.61');

    expect(current.client._transactions.size).to.equal(1);
    expect(current.client._segments.size).to.equal(2);
    expect(current.client._segments.totalBytes).to.equal(15);

    current.client.close();
    current.client.close();

    expect(callback).to.have.length(1);
    expect(callback[0].error).to.have.property('code', 'ERR_CLIENT_CLOSED');
    expect(callback[0].result).to.equal(undefined);
    expect(current.client._transactions.size).to.equal(0);
    expect(current.client._segments.size).to.equal(0);
    expect(current.client._segments.totalBytes).to.equal(0);
    expect(current.transport.closed).to.equal(1);
  });

  it('ignores packets delivered by a transport after the client is closed', () => {
    const current = context();
    let eventCount = 0;
    current.client.on('readProperty', () => eventCount++);
    current.client.close();

    current.transport.receive(segmentedPacket({
      direction: 'request',
      invokeId: 70,
      moreFollows: true,
      payload: Buffer.from('late'),
      sequenceNumber: 0,
      windowSize: 2
    }), '192.0.2.70');

    expect(current.client._segments.size).to.equal(0);
    expect(current.transport.sent).to.have.length(0);
    expect(eventCount).to.equal(0);
  });
});
