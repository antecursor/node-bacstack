'use strict';

const EventEmitter = require('events').EventEmitter;
const expect = require('chai').expect;

const Client = require('../../lib/client');
const baApdu = require('../../lib/apdu');
const baBvlc = require('../../lib/bvlc');
const baEnum = require('../../lib/enum');
const baNpdu = require('../../lib/npdu');
const baServices = require('../../lib/services');
const ServerTransactionManager = require('../../lib/client/server-transaction-manager');

const WRITE_PROPERTY = baEnum.ConfirmedServiceChoice.WRITE_PROPERTY;
const READ_PROPERTY = baEnum.ConfirmedServiceChoice.READ_PROPERTY;
const SEGMENTED = baEnum.PduConReqBits.SEGMENTED_MESSAGE;
const MORE_FOLLOWS = baEnum.PduConReqBits.MORE_FOLLOWS;

class CaptureTransport extends EventEmitter {
  constructor(options) {
    super();
    options = options || {};
    this.closed = false;
    this.maxPayload = options.maxPayload || 1482;
    this.onSend = null;
    this.sent = [];
  }

  getAddressKind() {
    return 'ip';
  }

  getBroadcastAddress() {
    return '255.255.255.255';
  }

  getMaxPayload() {
    return this.maxPayload;
  }

  open() {}

  close() {
    this.closed = true;
  }

  send(buffer, offset, receiver, context) {
    const sent = {
      buffer: Buffer.from(buffer.subarray(0, offset)),
      context: context,
      receiver: receiver
    };
    this.sent.push(sent);
    return this.onSend ? this.onSend(sent) : true;
  }

  receive(packet, remoteAddress, remotePort) {
    this.emit('message', packet, remoteAddress, remotePort == null ? 47808 : remotePort);
  }
}

function encodePayload(encoder) {
  const buffer = {buffer: Buffer.alloc(1024), offset: 0};
  encoder(buffer);
  return Buffer.from(buffer.buffer.subarray(0, buffer.offset));
}

function writePropertyPayload(value) {
  return encodePayload((buffer) => baServices.writeProperty.encode(
    buffer,
    baEnum.ObjectType.ANALOG_VALUE,
    47,
    baEnum.PropertyIdentifier.PRESENT_VALUE,
    baEnum.ASN1_ARRAY_ALL,
    baEnum.ASN1_NO_PRIORITY,
    [{type: baEnum.ApplicationTags.REAL, value: value}]
  ));
}

function readPropertyPayload(instance) {
  return encodePayload((buffer) => baServices.readProperty.encode(
    buffer,
    baEnum.ObjectType.DEVICE,
    instance,
    baEnum.PropertyIdentifier.PRESENT_VALUE,
    baEnum.ASN1_ARRAY_ALL
  ));
}

function enrollmentSummaryPayload() {
  return encodePayload((buffer) => baServices.getEnrollmentSummary.encode(buffer, 2));
}

function confirmedRequest(options) {
  const packet = Buffer.alloc(2048);
  const buffer = {buffer: packet, offset: baBvlc.BVLC_HEADER_LENGTH};
  baNpdu.encode(
    buffer,
    baEnum.NpduControlPriority.NORMAL_MESSAGE,
    null,
    options.source || null
  );
  baApdu.encodeConfirmedServiceRequest(
    buffer,
    baEnum.PduTypes.CONFIRMED_REQUEST |
      (options.segmented ? SEGMENTED : 0) |
      (options.moreFollows ? MORE_FOLLOWS : 0),
    options.service == null ? WRITE_PROPERTY : options.service,
    options.maxSegments == null ? baEnum.MaxSegmentsAccepted.SEGMENTS_8 : options.maxSegments,
    options.maxApdu == null ? baEnum.MaxApduLengthAccepted.OCTETS_1476 : options.maxApdu,
    options.invokeId,
    options.sequenceNumber || 0,
    options.windowSize || 1
  );
  options.payload.copy(packet, buffer.offset);
  buffer.offset += options.payload.length;
  baBvlc.encode(packet, baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU, buffer.offset);
  return Buffer.from(packet.subarray(0, buffer.offset));
}

function decodeOutgoing(packet) {
  const bvlc = baBvlc.decode(packet, 0);
  const npdu = baNpdu.decode(packet, bvlc.len, packet.length - bvlc.len);
  const offset = bvlc.len + npdu.len;
  const type = baApdu.getDecodedType(packet, offset);
  let apdu;
  switch (type & baEnum.PDU_TYPE_MASK) {
    case baEnum.PduTypes.SIMPLE_ACK:
      apdu = baApdu.decodeSimpleAck(packet, offset, packet.length - offset);
      break;
    case baEnum.PduTypes.COMPLEX_ACK:
      apdu = baApdu.decodeComplexAck(packet, offset, packet.length - offset);
      break;
    case baEnum.PduTypes.ERROR:
      apdu = baApdu.decodeError(packet, offset, packet.length - offset);
      break;
    case baEnum.PduTypes.SEGMENT_ACK:
      apdu = baApdu.decodeSegmentAck(packet, offset, packet.length - offset);
      break;
    case baEnum.PduTypes.ABORT:
    case baEnum.PduTypes.REJECT:
      apdu = baApdu.decodeAbort(packet, offset, packet.length - offset);
      break;
    default:
      throw new Error('Unexpected outgoing APDU type: ' + type);
  }
  return {apdu: apdu, npdu: npdu, type: type};
}

function splitPayload(payload) {
  const middle = Math.max(1, Math.floor(payload.length / 2));
  return [payload.subarray(0, middle), payload.subarray(middle)];
}

describe('bacstack - inbound confirmed-request transaction cache', () => {
  const clients = [];

  function createClient(options, transportOptions) {
    const transport = new CaptureTransport(transportOptions);
    const client = new Client(Object.assign({transport: transport}, options));
    clients.push(client);
    return {client: client, transport: transport};
  }

  afterEach(() => {
    while (clients.length > 0) clients.pop().close();
  });

  it('does not dispatch an identical pending WriteProperty request twice', () => {
    const current = createClient();
    const requests = [];
    const packet = confirmedRequest({invokeId: 7, payload: writePropertyPayload(1)});
    current.client.on('writeProperty', (request) => requests.push(request));

    current.transport.receive(packet, '192.0.2.10');
    current.transport.receive(packet, '192.0.2.10');

    expect(requests).to.have.length(1);
    expect(current.transport.sent).to.have.length(0);
  });

  it('replays the exact cached terminal response without redispatching', () => {
    const current = createClient();
    let dispatches = 0;
    let firstSendResult;
    const packet = confirmedRequest({invokeId: 8, payload: writePropertyPayload(2)});
    current.client.on('writeProperty', (request) => {
      dispatches++;
      firstSendResult = request.reply.simpleAck();
    });

    current.transport.receive(packet, '192.0.2.11');
    current.transport.receive(packet, '192.0.2.11');

    expect(firstSendResult).to.equal(true);
    expect(dispatches).to.equal(1);
    expect(current.transport.sent).to.have.length(2);
    expect(current.transport.sent[1].buffer.equals(current.transport.sent[0].buffer))
      .to.equal(true);
    expect(decodeOutgoing(current.transport.sent[1].buffer).apdu).to.deep.include({
      invokeId: 8,
      service: WRITE_PROPERTY
    });
  });

  it('retains a replayable response when the first transport send returns false', () => {
    const current = createClient();
    let dispatches = 0;
    let sends = 0;
    current.transport.onSend = () => ++sends === 1 ? false : true;
    const packet = confirmedRequest({invokeId: 9, payload: writePropertyPayload(3)});
    current.client.on('writeProperty', (request) => {
      dispatches++;
      request.reply.simpleAck();
    });

    current.transport.receive(packet, '192.0.2.12');
    current.transport.receive(packet, '192.0.2.12');

    expect(dispatches).to.equal(1);
    expect(current.transport.sent).to.have.length(2);
    expect(current.transport.sent[1].buffer.equals(current.transport.sent[0].buffer))
      .to.equal(true);
  });

  it('preserves an initial send exception while caching the encoded response', () => {
    const current = createClient();
    let dispatches = 0;
    let sends = 0;
    current.transport.onSend = () => {
      sends++;
      if (sends === 1) throw new Error('initial send failed');
      return true;
    };
    const packet = confirmedRequest({invokeId: 91, payload: writePropertyPayload(3.5)});
    current.client.on('writeProperty', (request) => {
      dispatches++;
      request.reply.simpleAck();
    });

    expect(() => current.transport.receive(packet, '192.0.2.91'))
      .to.throw('initial send failed');
    expect(() => current.transport.receive(packet, '192.0.2.91')).not.to.throw();

    expect(dispatches).to.equal(1);
    expect(current.transport.sent).to.have.length(2);
    expect(current.transport.sent[1].buffer.equals(current.transport.sent[0].buffer))
      .to.equal(true);
  });

  it('contains replay send exceptions while retaining completed state', () => {
    const current = createClient();
    let dispatches = 0;
    let sends = 0;
    current.transport.onSend = () => {
      sends++;
      if (sends === 2) throw new Error('replay failed');
      return true;
    };
    const packet = confirmedRequest({invokeId: 10, payload: writePropertyPayload(4)});
    current.client.on('writeProperty', (request) => {
      dispatches++;
      request.reply.simpleAck();
    });

    current.transport.receive(packet, '192.0.2.13');
    expect(() => current.transport.receive(packet, '192.0.2.13')).not.to.throw();
    expect(() => current.transport.receive(packet, '192.0.2.13')).not.to.throw();

    expect(dispatches).to.equal(1);
    expect(current.transport.sent).to.have.length(3);
    expect(current.transport.sent[2].buffer.equals(current.transport.sent[0].buffer))
      .to.equal(true);
  });

  it('aborts an invoke collision without dispatching the conflicting request', () => {
    const current = createClient();
    let dispatches = 0;
    const originalPayload = writePropertyPayload(5);
    current.client.on('writeProperty', () => dispatches++);

    current.transport.receive(confirmedRequest({
      invokeId: 11,
      payload: originalPayload
    }), '192.0.2.14');
    current.transport.receive(confirmedRequest({
      invokeId: 11,
      payload: writePropertyPayload(6)
    }), '192.0.2.14');
    current.transport.receive(confirmedRequest({
      invokeId: 11,
      payload: originalPayload,
      maxApdu: baEnum.MaxApduLengthAccepted.OCTETS_480
    }), '192.0.2.14');
    current.transport.receive(confirmedRequest({
      invokeId: 11,
      payload: originalPayload,
      service: READ_PROPERTY
    }), '192.0.2.14');

    expect(dispatches).to.equal(1);
    expect(current.transport.sent).to.have.length(3);
    const abort = decodeOutgoing(current.transport.sent[0].buffer);
    expect(abort.type & baEnum.PduAbortBits.SERVER).to.equal(baEnum.PduAbortBits.SERVER);
    expect(abort.apdu).to.deep.include({
      invokeId: 11,
      reason: baEnum.AbortReason.INVALID_APDU_IN_THIS_STATE
    });
    current.transport.sent.slice(1).forEach((sent) => {
      expect(decodeOutgoing(sent.buffer).apdu.reason)
        .to.equal(baEnum.AbortReason.INVALID_APDU_IN_THIS_STATE);
    });
  });

  it('rejects a mismatched response helper before sending it', () => {
    const current = createClient();
    let request;
    current.client.on('writeProperty', (event) => {
      request = event;
    });
    current.transport.receive(confirmedRequest({
      invokeId: 12,
      payload: writePropertyPayload(7)
    }), '192.0.2.15');

    expect(() => current.client.simpleAckResponse(
      request.address,
      READ_PROPERTY,
      request.invokeId,
      request.reply
    )).to.throw('ERR_SERVER_RESPONSE_MISMATCH')
      .with.property('code', 'ERR_SERVER_RESPONSE_MISMATCH');
    expect(current.transport.sent).to.have.length(0);

    request.reply.simpleAck();
    expect(current.transport.sent).to.have.length(1);
  });

  it('suppresses and replays a fully retried segmented request', () => {
    const current = createClient();
    const payload = writePropertyPayload(8);
    const parts = splitPayload(payload);
    let dispatches = 0;
    current.client.on('writeProperty', (request) => {
      dispatches++;
      request.reply.simpleAck();
    });
    const sendTransfer = () => parts.forEach((part, sequenceNumber) =>
      current.transport.receive(confirmedRequest({
        invokeId: 13,
        payload: part,
        segmented: true,
        moreFollows: sequenceNumber < parts.length - 1,
        sequenceNumber: sequenceNumber,
        windowSize: 1
      }), '192.0.2.16')
    );

    sendTransfer();
    sendTransfer();

    expect(dispatches).to.equal(1);
    expect(current.transport.sent.map((item) =>
      decodeOutgoing(item.buffer).type & baEnum.PDU_TYPE_MASK
    )).to.deep.equal([
      baEnum.PduTypes.SEGMENT_ACK,
      baEnum.PduTypes.SEGMENT_ACK,
      baEnum.PduTypes.SIMPLE_ACK,
      baEnum.PduTypes.SEGMENT_ACK,
      baEnum.PduTypes.SEGMENT_ACK,
      baEnum.PduTypes.SIMPLE_ACK
    ]);
    expect(current.transport.sent[5].buffer.equals(current.transport.sent[2].buffer))
      .to.equal(true);
  });

  it('terminalizes a malformed segmented request and reuses its completed slot', () => {
    const current = createClient({maxServerTransactions: 1});
    let dispatches = 0;
    current.client.on('writeProperty', (request) => {
      dispatches++;
      request.reply.simpleAck();
    });
    [Buffer.from([0xFF]), Buffer.from([0xFF])].forEach((payload, sequenceNumber) =>
      current.transport.receive(confirmedRequest({
        invokeId: 67,
        payload: payload,
        segmented: true,
        moreFollows: sequenceNumber === 0,
        sequenceNumber: sequenceNumber,
        windowSize: 1
      }), '192.0.2.67')
    );

    const healthy = confirmedRequest({
      invokeId: 67,
      payload: writePropertyPayload(30)
    });
    current.transport.receive(healthy, '192.0.2.67');
    current.transport.receive(healthy, '192.0.2.67');

    expect(dispatches).to.equal(1);
    expect(current.transport.sent.map((sent) =>
      decodeOutgoing(sent.buffer).type & baEnum.PDU_TYPE_MASK
    )).to.deep.equal([
      baEnum.PduTypes.SEGMENT_ACK,
      baEnum.PduTypes.SEGMENT_ACK,
      baEnum.PduTypes.REJECT,
      baEnum.PduTypes.SIMPLE_ACK,
      baEnum.PduTypes.SIMPLE_ACK
    ]);
    expect(decodeOutgoing(current.transport.sent[2].buffer).apdu.reason)
      .to.equal(baEnum.RejectReason.INVALID_PARAMETER_DATA_TYPE);
    expect(current.transport.sent[4].buffer.equals(current.transport.sent[3].buffer))
      .to.equal(true);
  });

  it('rejects confirmed requests unless their service payload is consumed exactly', () => {
    const current = createClient();
    let writeDispatches = 0;
    let alarmSummaryDispatches = 0;
    current.client.on('writeProperty', () => writeDispatches++);
    current.client.on('getAlarmSummary', () => alarmSummaryDispatches++);

    current.transport.receive(confirmedRequest({
      invokeId: 72,
      payload: Buffer.concat([writePropertyPayload(30), Buffer.from([0x00])])
    }), '192.0.2.72');
    current.transport.receive(confirmedRequest({
      invokeId: 73,
      payload: Buffer.from([0x00]),
      service: baEnum.ConfirmedServiceChoice.GET_ALARM_SUMMARY
    }), '192.0.2.73');

    expect(writeDispatches).to.equal(0);
    expect(alarmSummaryDispatches).to.equal(0);
    expect(current.transport.sent).to.have.length(2);
    current.transport.sent.forEach((sent) => {
      const response = decodeOutgoing(sent.buffer);
      expect(response.type & baEnum.PDU_TYPE_MASK).to.equal(baEnum.PduTypes.REJECT);
      expect(response.apdu.reason)
        .to.equal(baEnum.RejectReason.INVALID_PARAMETER_DATA_TYPE);
    });
  });

  it('accounts for WriteProperty priority when enforcing exact payload length', () => {
    const current = createClient();
    let request;
    const payload = encodePayload((buffer) => baServices.writeProperty.encode(
      buffer,
      baEnum.ObjectType.ANALOG_VALUE,
      47,
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      baEnum.ASN1_ARRAY_ALL,
      8,
      [{type: baEnum.ApplicationTags.REAL, value: 30}]
    ));
    current.client.on('writeProperty', (event) => {
      request = event;
      event.reply.simpleAck();
    });
    current.transport.receive(confirmedRequest({invokeId: 74, payload: payload}), '192.0.2.74');

    expect(request.request.value.priority).to.equal(8);
    expect(decodeOutgoing(current.transport.sent[0].buffer).type & baEnum.PDU_TYPE_MASK)
      .to.equal(baEnum.PduTypes.SIMPLE_ACK);
  });

  it('validates legacy untracked Error response fields before encoding', () => {
    const current = createClient({allowUntrackedServerResponses: true});
    expect(() => current.client.errorResponse(
      '192.0.2.75',
      WRITE_PROPERTY,
      75,
      NaN,
      baEnum.ErrorCode.UNKNOWN_PROPERTY
    )).to.throw('ERR_INVALID_ERROR_CLASS').with.property('code', 'ERR_INVALID_ERROR_CLASS');
    expect(() => current.client.errorResponse(
      '192.0.2.75',
      WRITE_PROPERTY,
      75,
      baEnum.ErrorClass.PROPERTY,
      1.5
    )).to.throw('ERR_INVALID_ERROR_CODE').with.property('code', 'ERR_INVALID_ERROR_CODE');
    expect(current.transport.sent).to.have.length(0);
  });

  it('expires pending state and permits a later request to dispatch', async() => {
    const current = createClient({serverTransactionTimeout: 5});
    let dispatches = 0;
    const packet = confirmedRequest({invokeId: 14, payload: writePropertyPayload(9)});
    current.client.on('writeProperty', () => dispatches++);

    current.transport.receive(packet, '192.0.2.17');
    await new Promise((resolve) => setTimeout(resolve, 15));
    current.transport.receive(packet, '192.0.2.17');

    expect(dispatches).to.equal(2);
  });

  it('bounds entries and bytes without evicting pending operations', () => {
    const cases = [
      {maxServerTransactions: 1},
      {maxServerTransactions: 4, maxServerTransactionBytes: 1514}
    ];
    cases.forEach((options, index) => {
      const current = createClient(options);
      let dispatches = 0;
      current.client.on('writeProperty', () => dispatches++);
      current.transport.receive(confirmedRequest({
        invokeId: 20,
        payload: writePropertyPayload(10)
      }), `192.0.2.${20 + index}`);
      current.transport.receive(confirmedRequest({
        invokeId: 21,
        payload: writePropertyPayload(11)
      }), `192.0.2.${30 + index}`);

      expect(dispatches).to.equal(1);
      const abort = decodeOutgoing(current.transport.sent[0].buffer);
      expect(abort.apdu.reason).to.equal(baEnum.AbortReason.OUT_OF_RESOURCES);
    });
  });

  it('applies per-peer limits to exact canonical routed peers', () => {
    const current = createClient({
      maxServerTransactions: 4,
      maxServerTransactionsPerPeer: 1
    });
    const requests = [];
    current.client.on('writeProperty', (request) => requests.push(request));
    const remote = '192.0.2.254';
    current.transport.receive(confirmedRequest({
      invokeId: 30,
      payload: writePropertyPayload(12),
      source: {net: 100, adr: [1]}
    }), remote);
    current.transport.receive(confirmedRequest({
      invokeId: 31,
      payload: writePropertyPayload(13),
      source: {net: 100, adr: [1]}
    }), remote);
    current.transport.receive(confirmedRequest({
      invokeId: 30,
      payload: writePropertyPayload(12),
      source: {net: 100, adr: [2]}
    }), remote);

    expect(requests).to.have.length(2);
    expect(requests.map((request) => request.address.adr)).to.deep.equal([[1], [2]]);
    expect(decodeOutgoing(current.transport.sent[0].buffer).apdu.reason)
      .to.equal(baEnum.AbortReason.OUT_OF_RESOURCES);
  });

  it('caches complex and error terminal response helpers', () => {
    const complex = createClient();
    let complexDispatches = 0;
    const readPacket = confirmedRequest({
      invokeId: 40,
      payload: readPropertyPayload(2),
      service: READ_PROPERTY
    });
    complex.client.on('readProperty', (request) => {
      complexDispatches++;
      request.reply.readProperty(
        request.request.objectId,
        request.request.property,
        [{type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 42}]
      );
    });
    complex.transport.receive(readPacket, '192.0.2.40');
    complex.transport.receive(readPacket, '192.0.2.40');

    const error = createClient();
    let errorDispatches = 0;
    const writePacket = confirmedRequest({invokeId: 41, payload: writePropertyPayload(14)});
    error.client.on('writeProperty', (request) => {
      errorDispatches++;
      request.reply.error(
        baEnum.ErrorClass.PROPERTY,
        baEnum.ErrorCode.UNKNOWN_PROPERTY
      );
    });
    error.transport.receive(writePacket, '192.0.2.41');
    error.transport.receive(writePacket, '192.0.2.41');

    expect(complexDispatches).to.equal(1);
    expect(errorDispatches).to.equal(1);
    expect(decodeOutgoing(complex.transport.sent[1].buffer).type & baEnum.PDU_TYPE_MASK)
      .to.equal(baEnum.PduTypes.COMPLEX_ACK);
    expect(decodeOutgoing(error.transport.sent[1].buffer).type & baEnum.PDU_TYPE_MASK)
      .to.equal(baEnum.PduTypes.ERROR);
    expect(complex.transport.sent[1].buffer.equals(complex.transport.sent[0].buffer))
      .to.equal(true);
    expect(error.transport.sent[1].buffer.equals(error.transport.sent[0].buffer))
      .to.equal(true);
  });

  it('exposes one immutable, non-serializable reply capability and enforces first terminal wins', () => {
    const current = createClient();
    let event;
    current.client.on('writeProperty', (request) => {
      event = request;
    });
    current.transport.receive(confirmedRequest({
      invokeId: 42,
      payload: writePropertyPayload(15)
    }), '192.0.2.42');

    expect(Object.isFrozen(event.reply)).to.equal(true);
    expect(Object.isFrozen(event.reply.address)).to.equal(true);
    expect(JSON.stringify(event.reply)).to.equal(undefined);
    event.reply.simpleAck();
    expect(() => event.reply.error(
      baEnum.ErrorClass.PROPERTY,
      baEnum.ErrorCode.UNKNOWN_PROPERTY
    )).to.throw('ERR_SERVER_REPLY_COMPLETED')
      .with.property('code', 'ERR_SERVER_REPLY_COMPLETED');
    expect(current.transport.sent).to.have.length(1);
  });

  it('rejects a stale generation after expiry and invoke reuse without changing the new request', async() => {
    const current = createClient({serverTransactionTimeout: 20});
    const events = [];
    current.client.on('writeProperty', (request) => events.push(request));
    current.transport.receive(confirmedRequest({
      invokeId: 43,
      payload: writePropertyPayload(16)
    }), '192.0.2.43');
    await new Promise((resolve) => setTimeout(resolve, 25));
    current.transport.receive(confirmedRequest({
      invokeId: 43,
      payload: writePropertyPayload(17)
    }), '192.0.2.43');

    expect(events).to.have.length(2);
    expect(() => events[0].reply.simpleAck()).to.throw('ERR_STALE_SERVER_REPLY')
      .with.property('code', 'ERR_STALE_SERVER_REPLY');
    expect(current.transport.sent).to.have.length(1);
    expect(decodeOutgoing(current.transport.sent[0].buffer).apdu.reason)
      .to.equal(baEnum.AbortReason.APPLICATION_EXCEEDED_REPLY_TIME);
    events[1].reply.simpleAck();
    expect(current.transport.sent).to.have.length(2);
  });

  it('supports async confirmed handlers and preserves once semantics', async() => {
    const current = createClient();
    let calls = 0;
    current.client.once('writeProperty', async(request) => {
      calls++;
      await Promise.resolve();
      request.reply.simpleAck();
    });
    const packet = confirmedRequest({invokeId: 62, payload: writePropertyPayload(26)});
    current.transport.receive(packet, '192.0.2.62');
    await new Promise((resolve) => setImmediate(resolve));
    current.transport.receive(packet, '192.0.2.62');

    expect(calls).to.equal(1);
    expect(current.transport.sent).to.have.length(2);
    expect(current.transport.sent[1].buffer.equals(current.transport.sent[0].buffer))
      .to.equal(true);
  });

  it('contains async handler rejection, terminalizes it, and surfaces diagnostics', async() => {
    const current = createClient();
    const diagnostics = [];
    const errors = [];
    let calls = 0;
    current.client.on('diagnostic', (event) => diagnostics.push(event));
    current.client.on('error', (error) => errors.push(error));
    current.client.on('writeProperty', async() => {
      calls++;
      throw new Error('async application failed');
    });
    const packet = confirmedRequest({invokeId: 63, payload: writePropertyPayload(27)});
    current.transport.receive(packet, '192.0.2.63');
    await new Promise((resolve) => setImmediate(resolve));
    current.transport.receive(packet, '192.0.2.63');

    expect(calls).to.equal(1);
    expect(diagnostics).to.have.length(1);
    expect(diagnostics[0]).to.deep.include({
      type: 'confirmed-handler-rejection',
      event: 'writeProperty',
      invokeId: 63,
      service: WRITE_PROPERTY
    });
    expect(errors).to.have.length(1);
    expect(errors[0].message).to.equal('async application failed');
    expect(decodeOutgoing(current.transport.sent[0].buffer).apdu.reason)
      .to.equal(baEnum.AbortReason.OTHER);
    expect(current.transport.sent[1].buffer.equals(current.transport.sent[0].buffer))
      .to.equal(true);
  });

  it('caches and replays reply-timeout Aborts after false and throwing sends', async() => {
    for (const behavior of ['false', 'throw']) {
      const current = createClient({serverTransactionTimeout: 20});
      let sends = 0;
      current.transport.onSend = () => {
        sends++;
        if (sends === 1 && behavior === 'throw') throw new Error('timeout send failed');
        if (sends === 1) return false;
        return true;
      };
      const packet = confirmedRequest({
        invokeId: behavior === 'false' ? 64 : 65,
        payload: writePropertyPayload(28)
      });
      current.client.on('writeProperty', () => {});
      current.transport.receive(packet, '192.0.2.64');
      await new Promise((resolve) => setTimeout(resolve, 25));
      current.transport.receive(packet, '192.0.2.64');

      expect(current.transport.sent).to.have.length(2);
      expect(decodeOutgoing(current.transport.sent[0].buffer).apdu.reason)
        .to.equal(baEnum.AbortReason.APPLICATION_EXCEEDED_REPLY_TIME);
      expect(current.transport.sent[1].buffer.equals(current.transport.sent[0].buffer))
        .to.equal(true);
    }
  });

  it('does not emit a pending timeout response after close', async() => {
    const current = createClient({serverTransactionTimeout: 10});
    current.client.on('writeProperty', () => {});
    current.transport.receive(confirmedRequest({
      invokeId: 66,
      payload: writePropertyPayload(29)
    }), '192.0.2.66');
    current.client.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(current.transport.sent).to.have.length(0);
    expect(current.client._serverTransactions.size).to.equal(0);
  });

  it('does not evict a completed reply to admit new work at capacity', () => {
    const current = createClient({maxServerTransactions: 1});
    let firstDispatches = 0;
    let secondDispatches = 0;
    current.client.on('writeProperty', (request) => {
      if (request.invokeId === 44) {
        firstDispatches++;
        request.reply.simpleAck();
      } else {
        secondDispatches++;
      }
    });
    const first = confirmedRequest({invokeId: 44, payload: writePropertyPayload(18)});
    current.transport.receive(first, '192.0.2.44');
    current.transport.receive(confirmedRequest({
      invokeId: 45,
      payload: writePropertyPayload(19)
    }), '192.0.2.45');
    current.transport.receive(first, '192.0.2.44');

    expect(firstDispatches).to.equal(1);
    expect(secondDispatches).to.equal(0);
    expect(decodeOutgoing(current.transport.sent[1].buffer).apdu.reason)
      .to.equal(baEnum.AbortReason.OUT_OF_RESOURCES);
    expect(current.transport.sent[2].buffer.equals(current.transport.sent[0].buffer))
      .to.equal(true);
  });

  it('replaces a completed generation for a different request fingerprint', () => {
    const current = createClient({maxServerTransactions: 1});
    const values = [];
    current.client.on('writeProperty', (request) => {
      values.push(request.request.value.value[0].value);
      request.reply.simpleAck();
    });
    const second = confirmedRequest({invokeId: 46, payload: writePropertyPayload(21)});
    current.transport.receive(confirmedRequest({
      invokeId: 46,
      payload: writePropertyPayload(20)
    }), '192.0.2.46');
    current.transport.receive(second, '192.0.2.46');
    current.transport.receive(second, '192.0.2.46');

    expect(values).to.deep.equal([20, 21]);
    expect(current.transport.sent).to.have.length(3);
    expect(current.transport.sent[2].buffer.equals(current.transport.sent[1].buffer))
      .to.equal(true);
  });

  it('caches terminal responses for malformed, unsupported, and unhandled requests', () => {
    const cases = [
      {
        packet: confirmedRequest({invokeId: 51, payload: Buffer.from([0xFF])}),
        expectedReason: baEnum.RejectReason.INVALID_PARAMETER_DATA_TYPE
      },
      {
        packet: confirmedRequest({
          invokeId: 52,
          payload: Buffer.alloc(0),
          service: 0xFF
        }),
        expectedReason: baEnum.RejectReason.UNRECOGNIZED_SERVICE
      },
      {
        packet: confirmedRequest({invokeId: 53, payload: writePropertyPayload(22)}),
        expectedReason: baEnum.RejectReason.UNRECOGNIZED_SERVICE
      }
    ];
    cases.forEach((testCase, index) => {
      const current = createClient();
      const peer = `192.0.2.${51 + index}`;
      current.transport.receive(testCase.packet, peer);
      current.transport.receive(testCase.packet, peer);
      expect(current.transport.sent).to.have.length(2);
      expect(decodeOutgoing(current.transport.sent[0].buffer).apdu.reason)
        .to.equal(testCase.expectedReason);
      expect(current.transport.sent[1].buffer.equals(current.transport.sent[0].buffer))
        .to.equal(true);
    });
  });

  it('fingerprints and replays duplicates without preparing their service twice', () => {
    const current = createClient();
    const prepare = current.client._prepareConfirmedServiceRequest.bind(current.client);
    let preparations = 0;
    current.client._prepareConfirmedServiceRequest = (...args) => {
      preparations++;
      return prepare(...args);
    };
    const malformed = confirmedRequest({invokeId: 71, payload: Buffer.from([0xFF])});

    current.transport.receive(malformed, '192.0.2.71');
    current.transport.receive(malformed, '192.0.2.71');

    expect(preparations).to.equal(1);
    expect(current.transport.sent).to.have.length(2);
    expect(current.transport.sent[1].buffer.equals(current.transport.sent[0].buffer))
      .to.equal(true);
  });

  it('does not run any confirmed handler when more than one is registered', () => {
    const current = createClient();
    let calls = 0;
    current.client.on('writeProperty', () => calls++);
    current.client.on('writeProperty', () => calls++);
    current.transport.receive(confirmedRequest({
      invokeId: 54,
      payload: writePropertyPayload(23)
    }), '192.0.2.54');

    expect(calls).to.equal(0);
    const response = decodeOutgoing(current.transport.sent[0].buffer);
    expect(response.type & baEnum.PDU_TYPE_MASK).to.equal(baEnum.PduTypes.ABORT);
    expect(response.apdu.reason).to.equal(baEnum.AbortReason.INVALID_APDU_IN_THIS_STATE);
  });

  it('caches an Abort when the sole confirmed handler throws and rethrows the handler error', () => {
    const current = createClient();
    let calls = 0;
    const packet = confirmedRequest({invokeId: 55, payload: writePropertyPayload(24)});
    current.client.on('writeProperty', () => {
      calls++;
      throw new Error('application failed');
    });

    expect(() => current.transport.receive(packet, '192.0.2.55'))
      .to.throw('application failed');
    expect(() => current.transport.receive(packet, '192.0.2.55')).not.to.throw();
    expect(calls).to.equal(1);
    expect(current.transport.sent).to.have.length(2);
    expect(current.transport.sent[1].buffer.equals(current.transport.sent[0].buffer))
      .to.equal(true);
    expect(decodeOutgoing(current.transport.sent[0].buffer).apdu.reason)
      .to.equal(baEnum.AbortReason.OTHER);
  });

  it('deliberately preserves the legacy getEntrollmentSummary event alias', () => {
    const current = createClient();
    let event;
    current.client.on('getEntrollmentSummary', (request) => {
      event = request;
      request.reply.complexAck(Buffer.alloc(0));
    });
    current.transport.receive(confirmedRequest({
      invokeId: 56,
      payload: enrollmentSummaryPayload(),
      service: baEnum.ConfirmedServiceChoice.GET_ENROLLMENT_SUMMARY
    }), '192.0.2.56');

    expect(event.request.acknowledgmentFilter).to.equal(2);
    expect(decodeOutgoing(current.transport.sent[0].buffer).type & baEnum.PDU_TYPE_MASK)
      .to.equal(baEnum.PduTypes.COMPLEX_ACK);
  });

  it('supports the corrected getEnrollmentSummary alias but rejects ambiguous aliases', () => {
    const correct = createClient();
    let calls = 0;
    correct.client.on('getEnrollmentSummary', (request) => {
      calls++;
      request.reply.complexAck(Buffer.alloc(0));
    });
    const packet = confirmedRequest({
      invokeId: 59,
      payload: enrollmentSummaryPayload(),
      service: baEnum.ConfirmedServiceChoice.GET_ENROLLMENT_SUMMARY
    });
    correct.transport.receive(packet, '192.0.2.59');
    expect(calls).to.equal(1);

    const ambiguous = createClient();
    ambiguous.client.on('getEnrollmentSummary', () => calls++);
    ambiguous.client.on('getEntrollmentSummary', () => calls++);
    ambiguous.transport.receive(packet, '192.0.2.60');
    expect(calls).to.equal(1);
    expect(decodeOutgoing(ambiguous.transport.sent[0].buffer).apdu.reason)
      .to.equal(baEnum.AbortReason.INVALID_APDU_IN_THIS_STATE);
  });

  it('uses an isolated ComplexACK payload encoder and validates SimpleACK legality', () => {
    const current = createClient();
    let event;
    current.client.on('readProperty', (request) => {
      event = request;
    });
    current.transport.receive(confirmedRequest({
      invokeId: 57,
      payload: readPropertyPayload(3),
      service: READ_PROPERTY
    }), '192.0.2.57');

    expect(() => event.reply.simpleAck()).to.throw('ERR_INVALID_SERVER_REPLY')
      .with.property('code', 'ERR_INVALID_SERVER_REPLY');
    event.reply.complexAck((payload) => {
      expect(payload.offset).to.equal(0);
      payload.buffer[payload.offset++] = 0xFF;
    });
    expect(decodeOutgoing(current.transport.sent[0].buffer).type & baEnum.PDU_TYPE_MASK)
      .to.equal(baEnum.PduTypes.COMPLEX_ACK);
  });

  it('turns an oversized tracked ComplexACK into a cached APDU_TOO_LONG Abort', () => {
    const current = createClient();
    let dispatches = 0;
    const packet = confirmedRequest({
      invokeId: 58,
      payload: readPropertyPayload(4),
      service: READ_PROPERTY,
      maxApdu: baEnum.MaxApduLengthAccepted.OCTETS_50
    });
    current.client.on('readProperty', (request) => {
      dispatches++;
      request.reply.complexAck(Buffer.alloc(100));
    });
    current.transport.receive(packet, '192.0.2.58');
    current.transport.receive(packet, '192.0.2.58');

    expect(dispatches).to.equal(1);
    expect(current.transport.sent).to.have.length(2);
    expect(decodeOutgoing(current.transport.sent[0].buffer).apdu.reason)
      .to.equal(baEnum.AbortReason.APDU_TOO_LONG);
    expect(current.transport.sent[1].buffer.equals(current.transport.sent[0].buffer))
      .to.equal(true);
  });

  it('fails oversized untracked, confirmed, and unconfirmed encodes locally without sending', () => {
    const current = createClient();
    const huge = Buffer.alloc(5000, 0xAA);
    expect(() => current.client.readPropertyResponse(
      '192.0.2.60',
      60,
      {type: baEnum.ObjectType.DEVICE, instance: 1},
      {id: baEnum.PropertyIdentifier.PRESENT_VALUE, index: baEnum.ASN1_ARRAY_ALL},
      [{type: baEnum.ApplicationTags.OCTET_STRING, value: huge}]
    )).to.throw('Encoded BACnet frame')
      .with.property('code', 'ERR_OUTBOUND_APDU_TOO_LARGE');
    expect(() => current.client.writeProperty(
      '192.0.2.60',
      {type: baEnum.ObjectType.ANALOG_VALUE, instance: 1},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      [{type: baEnum.ApplicationTags.OCTET_STRING, value: huge}],
      () => {}
    )).to.throw().with.property('code', 'ERR_OUTBOUND_APDU_TOO_LARGE');
    expect(() => current.client.unconfirmedPrivateTransfer(
      '192.0.2.60',
      1,
      1,
      huge
    )).to.throw().with.property('code', 'ERR_OUTBOUND_APDU_TOO_LARGE');
    expect(current.transport.sent).to.have.length(0);
  });

  it('requires a reply capability unless legacy untracked responses are explicitly enabled', () => {
    const strict = createClient();
    expect(() => strict.client.simpleAckResponse(
      '192.0.2.68',
      WRITE_PROPERTY,
      68
    )).to.throw('ERR_SERVER_REPLY_REQUIRED')
      .with.property('code', 'ERR_SERVER_REPLY_REQUIRED');
    expect(strict.transport.sent).to.have.length(0);

    const legacy = createClient({allowUntrackedServerResponses: true});
    expect(() => legacy.client.simpleAckResponse(
      '192.0.2.68',
      WRITE_PROPERTY,
      68
    )).not.to.throw();
    expect(legacy.transport.sent).to.have.length(1);
  });

  it('rejects BVLC overflow and inconsistent finalized cursors before transport send', () => {
    const current = createClient({}, {maxPayload: 70000});
    const overflow = {buffer: Buffer.alloc(0x10000), offset: 0x10000};
    expect(() => current.client._finalizeBuffer(
      overflow,
      baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU
    )).to.throw().with.property('code', 'ERR_OUTBOUND_APDU_TOO_LARGE');

    const lengthMismatch = {buffer: Buffer.alloc(8), offset: 8};
    lengthMismatch.buffer[0] = baEnum.BVLL_TYPE_BACNET_IP;
    lengthMismatch.buffer[1] = baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU;
    lengthMismatch.buffer.writeUInt16BE(7, 2);
    expect(() => current.client._sendBuffer(lengthMismatch, '192.0.2.69'))
      .to.throw().with.property('code', 'ERR_OUTBOUND_APDU_TOO_LARGE');
    expect(() => current.client._sendBuffer(
      {buffer: Buffer.alloc(8), offset: 9},
      '192.0.2.69'
    )).to.throw().with.property('code', 'ERR_OUTBOUND_APDU_TOO_LARGE');
    expect(current.transport.sent).to.have.length(0);
  });

  it('isolates inbound transactions and reply routing by UDP source port', () => {
    const current = createClient();
    const ports = [];
    current.client.on('writeProperty', (request) => {
      ports.push(request.reply.address.port);
      request.reply.simpleAck();
    });
    const packet = confirmedRequest({invokeId: 61, payload: writePropertyPayload(25)});
    current.transport.receive(packet, '192.0.2.61', 47809);
    current.transport.receive(packet, '192.0.2.61', 47810);

    expect(ports).to.deep.equal([47809, 47810]);
    expect(current.transport.sent.map((sent) => sent.context.destinationPort))
      .to.deep.equal([47809, 47810]);
  });

  it('isolates routed inbound peers by router UDP source port', () => {
    const current = createClient();
    const ports = [];
    current.client.on('writeProperty', (request) => {
      ports.push([request.address.port, request.reply.address.port]);
      request.reply.simpleAck();
    });
    const packet = confirmedRequest({
      invokeId: 69,
      payload: writePropertyPayload(31),
      source: {net: 100, adr: [9]}
    });
    current.transport.receive(packet, '192.0.2.69', 47809);
    current.transport.receive(packet, '192.0.2.69', 47810);

    expect(ports).to.deep.equal([[47809, 47809], [47810, 47810]]);
    expect(current.transport.sent.map((sent) => sent.context.destinationPort))
      .to.deep.equal([47809, 47810]);
  });

  it('clears retained server transactions on close', () => {
    const current = createClient();
    let dispatches = 0;
    const packet = confirmedRequest({invokeId: 50, payload: writePropertyPayload(15)});
    current.client.on('writeProperty', () => dispatches++);
    current.transport.receive(packet, '192.0.2.50');
    expect(current.client._serverTransactions.size).to.equal(1);

    current.client.close();
    current.transport.receive(packet, '192.0.2.50');

    expect(current.client._serverTransactions.size).to.equal(0);
    expect(dispatches).to.equal(1);
    expect(current.transport.closed).to.equal(true);
  });
});

describe('bacstack - inbound server transaction deadlines', () => {
  it('enforces an expired deadline even when the scheduled timer has not run', () => {
    let now = 100;
    const timers = [];
    const expired = [];
    let manager;
    manager = new ServerTransactionManager({
      timeout: 10,
      maxEntries: 1,
      maxEntriesPerPeer: 1,
      maxBytes: 96,
      maxResponseBytes: 64,
      now: () => now,
      setTimeout: (callback) => {
        timers.push(callback);
        return {unref() {}};
      },
      clearTimeout: () => {},
      onExpire: (transaction) => {
        expired.push(transaction);
        manager.bindResponse({
          address: transaction.address,
          invokeId: transaction.invokeId,
          service: transaction.service,
          generation: transaction.generation,
          allowExpired: true,
          frame: Buffer.from([0xAA])
        });
      }
    });
    const request = {
      address: '192.0.2.70',
      invokeId: 70,
      type: baEnum.PduTypes.CONFIRMED_REQUEST,
      service: WRITE_PROPERTY,
      maxSegments: baEnum.MaxSegmentsAccepted.SEGMENTS_8,
      maxApdu: baEnum.MaxApduLengthAccepted.OCTETS_1476,
      responseMaxApdu: 1476,
      payload: writePropertyPayload(32)
    };
    const transaction = manager.accept(request);
    expect(transaction.status).to.equal('new');

    now = transaction.expiresAt + 1;
    expect(() => manager.bindResponse({
      address: transaction.address,
      invokeId: transaction.invokeId,
      service: transaction.service,
      generation: transaction.generation,
      frame: Buffer.from([0xBB])
    })).to.throw().with.property('code', 'ERR_SERVER_REPLY_COMPLETED');

    expect(expired).to.have.length(1);
    expect(manager.accept(request)).to.deep.include({status: 'completed'});
    timers[0]();
    expect(manager.accept(request)).to.deep.include({status: 'completed'});
    manager.close();
  });
});
