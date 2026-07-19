'use strict';

const EventEmitter = require('events').EventEmitter;
const once = require('events').once;
const expect = require('chai').expect;

const Client = require('../../lib/client');
const baApdu = require('../../lib/apdu');
const baBvlc = require('../../lib/bvlc');
const baEnum = require('../../lib/enum');
const baNpdu = require('../../lib/npdu');
const baServices = require('../../lib/services');

const OBJECT_ID = Object.freeze({type: baEnum.ObjectType.ANALOG_VALUE, instance: 47});
const PROPERTY_ID = baEnum.PropertyIdentifier.PRESENT_VALUE;
const PROPERTY_VALUE = Object.freeze([
  Object.freeze({type: baEnum.ApplicationTags.REAL, value: 42.5})
]);
const WRITE_PROPERTY = baEnum.ConfirmedServiceChoice.WRITE_PROPERTY;

class FakeTransport extends EventEmitter {
  constructor(options) {
    super();
    options = options || {};
    this.addressKind = options.addressKind || 'ip';
    this.broadcastAddress = options.broadcastAddress ||
      (this.addressKind === 'vmac' ? 'ffffffffffff' : '255.255.255.255');
    this.closed = false;
    this.opened = false;
    this.onSend = options.onSend;
    this.sent = [];
    if (options.supportsAddress) this.supportsAddress = options.supportsAddress;
    if (options.ipVersion != null) this.getIpVersion = () => options.ipVersion;
  }

  getAddressKind() {
    return this.addressKind;
  }

  getBroadcastAddress() {
    return this.broadcastAddress;
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

  send(buffer, offset, receiver, context) {
    const item = {
      buffer: Buffer.from(buffer.subarray(0, offset)),
      context: context,
      receiver: receiver
    };
    this.sent.push(item);
    if (this.onSend) return this.onSend(item);
  }
}

function parseConfirmedRequest(packet) {
  const bvlc = baBvlc.decode(packet, 0);
  expect(bvlc).to.be.an('object');
  const npdu = baNpdu.decode(packet, bvlc.len, packet.length - bvlc.len);
  expect(npdu).to.be.an('object');
  const offset = bvlc.len + npdu.len;
  const apdu = baApdu.decodeConfirmedServiceRequest(packet, offset, packet.length - offset);
  expect(apdu).to.be.an('object');
  return {apdu: apdu, bvlc: bvlc, npdu: npdu};
}

function parseSimpleAck(packet) {
  const bvlc = baBvlc.decode(packet, 0);
  const npdu = baNpdu.decode(packet, bvlc.len, packet.length - bvlc.len);
  const offset = bvlc.len + npdu.len;
  return {
    apdu: baApdu.decodeSimpleAck(packet, offset, packet.length - offset),
    bvlc: bvlc,
    npdu: npdu
  };
}

function writeForwardedOrigin(buffer, address, port) {
  address.split('.').forEach((octet, index) => {
    buffer[4 + index] = Number(octet);
  });
  buffer.writeUInt16BE(port, 8);
}

function encodeResponse(options) {
  options = Object.assign({
    bvlcFunction: baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU,
    pduType: baEnum.PduTypes.SIMPLE_ACK,
    service: WRITE_PROPERTY
  }, options);
  const forwarded = options.bvlcFunction === baEnum.BvlcResultPurpose.FORWARDED_NPDU;
  const buffer = Buffer.alloc(512);
  const cursor = {buffer: buffer, offset: forwarded ? 10 : baEnum.BVLC_HEADER_LENGTH};
  baNpdu.encode(
    cursor,
    baEnum.NpduControlPriority.NORMAL_MESSAGE,
    null,
    options.source
  );

  switch (options.pduType & baEnum.PDU_TYPE_MASK) {
    case baEnum.PduTypes.SIMPLE_ACK:
      baApdu.encodeSimpleAck(cursor, options.pduType, options.service, options.invokeId);
      break;
    case baEnum.PduTypes.COMPLEX_ACK:
      baApdu.encodeComplexAck(cursor, options.pduType, options.service, options.invokeId);
      break;
    case baEnum.PduTypes.ERROR:
      baApdu.encodeError(cursor, options.pduType, options.service, options.invokeId);
      baServices.error.encode(
        cursor,
        options.errorClass == null ? baEnum.ErrorClass.PROPERTY : options.errorClass,
        options.errorCode == null ? baEnum.ErrorCode.UNKNOWN_PROPERTY : options.errorCode
      );
      break;
    case baEnum.PduTypes.ABORT:
    case baEnum.PduTypes.REJECT:
      baApdu.encodeAbort(cursor, options.pduType, options.invokeId, options.reason || 0);
      break;
    default:
      throw new Error('Unsupported test PDU');
  }

  baBvlc.encode(buffer, options.bvlcFunction, cursor.offset);
  if (forwarded) {
    writeForwardedOrigin(buffer, options.originatingAddress, options.originatingPort);
  }
  return Buffer.from(buffer.subarray(0, cursor.offset));
}

function encodeForwardedWhoIs(originatingAddress, originatingPort) {
  const buffer = Buffer.alloc(512);
  const cursor = {buffer: buffer, offset: 10};
  baNpdu.encode(cursor, baEnum.NpduControlPriority.NORMAL_MESSAGE);
  baApdu.encodeUnconfirmedServiceRequest(
    cursor,
    baEnum.PduTypes.UNCONFIRMED_REQUEST,
    baEnum.UnconfirmedServiceChoice.WHO_IS
  );
  baServices.whoIs.encode(cursor);
  baBvlc.encode(buffer, baEnum.BvlcResultPurpose.FORWARDED_NPDU, cursor.offset);
  writeForwardedOrigin(buffer, originatingAddress, originatingPort);
  return Buffer.from(buffer.subarray(0, cursor.offset));
}

function encodeUnconfirmedRequest(service, encodeService) {
  const buffer = Buffer.alloc(2048);
  const cursor = {buffer: buffer, offset: baEnum.BVLC_HEADER_LENGTH};
  baNpdu.encode(cursor, baEnum.NpduControlPriority.NORMAL_MESSAGE);
  baApdu.encodeUnconfirmedServiceRequest(
    cursor,
    baEnum.PduTypes.UNCONFIRMED_REQUEST,
    service
  );
  encodeService(cursor);
  baBvlc.encode(buffer, baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU, cursor.offset);
  return Buffer.from(buffer.subarray(0, cursor.offset));
}

function sendWrite(client, address, options, callback) {
  client.writeProperty(
    address,
    OBJECT_ID,
    PROPERTY_ID,
    PROPERTY_VALUE,
    options || {},
    callback
  );
}

describe('bacstack - Client transaction runtime', () => {
  const clients = [];

  function createClient(options, transportOptions) {
    const transport = new FakeTransport(transportOptions);
    const client = new Client(Object.assign({apduTimeout: 1000, transport: transport}, options));
    clients.push(client);
    return {client: client, transport: transport};
  }

  afterEach(() => {
    while (clients.length > 0) clients.pop().close();
  });

  it('registers before send so a synchronous ACK cannot outrun correlation', () => {
    const calls = [];
    let returned = false;
    let context;
    const runtime = createClient();
    runtime.transport.onSend = (item) => {
      const request = parseConfirmedRequest(item.buffer);
      context = item.context;
      expect(item.context.signal.aborted).to.equal(false);
      runtime.transport.emit('message', encodeResponse({
        invokeId: request.apdu.invokeId
      }), item.receiver, 47808);
      return true;
    };

    sendWrite(runtime.client, '192.0.2.10', {}, (error, value, metadata) => {
      calls.push({error: error, metadata: metadata, returned: returned, value: value});
    });
    returned = true;

    expect(calls).to.deep.equal([{
      error: null,
      metadata: undefined,
      returned: false,
      value: undefined
    }]);
    expect(context.signal.aborted).to.equal(false);
  });

  it('rejects address kinds that do not match the active transport', () => {
    const ip = createClient();
    const sc = createClient({}, {addressKind: 'vmac'});

    expect(() => sendWrite(ip.client, {vmac: '020000000010'}, {}, () => {}))
      .to.throw('ERR_ADDRESS_KIND_MISMATCH')
      .with.property('code', 'ERR_ADDRESS_KIND_MISMATCH');
    expect(() => sendWrite(sc.client, {ip: '192.0.2.10'}, {}, () => {}))
      .to.throw('ERR_ADDRESS_KIND_MISMATCH')
      .with.property('code', 'ERR_ADDRESS_KIND_MISMATCH');
    expect(ip.transport.sent).to.have.length(0);
    expect(sc.transport.sent).to.have.length(0);
  });

  it('rejects direct and routed IPv6 destinations on the built-in BACnet/IP transport', async() => {
    const client = new Client({port: 0});
    clients.push(client);
    await once(client._transport._server, 'listening');

    const addresses = [
      '2001:db8::10',
      {ip: '2001:db8::fe', net: 303, adr: [5]}
    ];
    addresses.forEach((address) => {
      expect(() => sendWrite(client, address, {}, () => {}))
        .to.throw('does not support this address family')
        .with.property('code', 'ERR_UNSUPPORTED_ADDRESS_FAMILY');
    });
    expect(client._transactions.size).to.equal(0);
  });

  it('lets an IPv6-capable custom IP transport opt in explicitly', () => {
    const runtime = createClient({}, {
      broadcastAddress: 'ff02::bac0',
      supportsAddress: (address) => address.includes(':')
    });
    const directCalls = [];
    const routedCalls = [];
    const route = {ip: '2001:0db8:0:0:0:0:0:fe', net: 303, adr: [5]};

    sendWrite(runtime.client, '2001:0db8:0:0:0:0:0:10', {invokeId: 70},
      (error) => directCalls.push(error));
    sendWrite(runtime.client, route, {invokeId: 71},
      (error) => routedCalls.push(error));

    expect(runtime.transport.sent.map((item) => item.receiver))
      .to.deep.equal(['2001:db8::10', '2001:db8::fe']);
    expect(parseConfirmedRequest(runtime.transport.sent[1].buffer).npdu.destination)
      .to.deep.include({net: route.net, adr: route.adr});

    runtime.transport.emit('message', encodeResponse({invokeId: 70}), '2001:db8::10', 47808);
    runtime.transport.emit('message', encodeResponse({
      invokeId: 71,
      source: {net: route.net, adr: route.adr}
    }), '2001:db8::fe', 47808);
    expect(directCalls).to.deep.equal([null]);
    expect(routedCalls).to.deep.equal([null]);
  });

  it('requires a custom IP transport to declare IPv6 capability', () => {
    const runtime = createClient({}, {broadcastAddress: 'ff02::bac0'});

    expect(() => sendWrite(runtime.client, '2001:db8::10', {}, () => {}))
      .to.throw('does not support this address family')
      .with.property('code', 'ERR_UNSUPPORTED_ADDRESS_FAMILY');
    expect(runtime.transport.sent).to.have.length(0);
  });

  it('honors a custom IP transport getIpVersion capability', () => {
    const ipv4 = createClient({}, {ipVersion: 4});
    const ipv6 = createClient({}, {broadcastAddress: 'ff02::bac0', ipVersion: 6});

    expect(() => sendWrite(ipv4.client, '2001:db8::10', {}, () => {}))
      .to.throw('does not support this address family')
      .with.property('code', 'ERR_UNSUPPORTED_ADDRESS_FAMILY');
    expect(() => sendWrite(ipv6.client, '192.0.2.10', {}, () => {}))
      .to.throw('does not support this address family')
      .with.property('code', 'ERR_UNSUPPORTED_ADDRESS_FAMILY');
    expect(() => sendWrite(ipv6.client, '2001:db8::10', {}, () => {})).not.to.throw();
  });

  it('rejects a configured address kind that conflicts with the transport', () => {
    const transport = new FakeTransport({addressKind: 'ip'});

    expect(() => new Client({transport: transport, addressKind: 'vmac'}))
      .to.throw('Configured address kind does not match the transport address kind')
      .with.property('code', 'ERR_ADDRESS_KIND_MISMATCH');
    expect(transport.opened).to.equal(false);
    expect(transport.closed).to.equal(false);
    expect(transport.sent).to.have.length(0);
  });

  it('releases constructor listeners without closing a caller-owned transport', () => {
    const invalid = new FakeTransport();
    expect(() => new Client({transport: invalid, maxSegmentsPerTransfer: 0}))
      .to.throw('maxSegments must be a positive integer');
    expect(invalid.closed).to.equal(false);
    expect(invalid.eventNames()).to.deep.equal([]);

    const openFailure = new FakeTransport();
    openFailure.open = () => {
      throw new Error('open failed');
    };
    expect(() => new Client({transport: openFailure})).to.throw('open failed');
    expect(openFailure.closed).to.equal(false);
    expect(openFailure.eventNames()).to.deep.equal([]);
  });

  it('rejects confirmed-service broadcasts on IP and BACnet/SC transports', () => {
    const ip = createClient();
    const sc = createClient({}, {addressKind: 'vmac'});

    expect(() => sendWrite(ip.client, '255.255.255.255', {}, () => {}))
      .to.throw('Confirmed BACnet services require a unicast destination')
      .with.property('code', 'ERR_CONFIRMED_BROADCAST');
    expect(() => sendWrite(
      ip.client,
      {ip: '255.255.255.255', port: 47809},
      {},
      () => {}
    )).to.throw('Confirmed BACnet services require a unicast destination')
      .with.property('code', 'ERR_CONFIRMED_BROADCAST');
    expect(() => sendWrite(sc.client, 'ffffffffffff', {}, () => {}))
      .to.throw('Confirmed BACnet services require a unicast destination')
      .with.property('code', 'ERR_CONFIRMED_BROADCAST');
    expect(ip.transport.sent).to.have.length(0);
    expect(sc.transport.sent).to.have.length(0);
  });

  it('encodes explicit invoke ID zero and rejects an active duplicate before send', () => {
    const runtime = createClient();
    const calls = [];

    sendWrite(runtime.client, '192.0.2.10', {invokeId: 0}, (error) => calls.push(error));
    expect(parseConfirmedRequest(runtime.transport.sent[0].buffer).apdu.invokeId).to.equal(0);

    let duplicateError;
    try {
      sendWrite(runtime.client, '192.0.2.10', {invokeId: 0}, () => {});
    } catch (error) {
      duplicateError = error;
    }
    expect(duplicateError).to.have.property('code', 'ERR_INVOKE_ID_IN_USE');
    expect(runtime.transport.sent).to.have.length(1);

    runtime.transport.emit('message', encodeResponse({invokeId: 0}), '192.0.2.10', 47808);
    expect(calls).to.deep.equal([null]);
  });

  it('ignores the wrong peer, service, and PDU without consuming a transaction', () => {
    const runtime = createClient();
    const calls = [];
    sendWrite(runtime.client, '192.0.2.10', {invokeId: 7},
      (error, value) => calls.push({error: error, value: value}));

    runtime.transport.emit('message', encodeResponse({invokeId: 7}), '192.0.2.11', 47808);
    runtime.transport.emit('message', encodeResponse({
      invokeId: 7,
      service: baEnum.ConfirmedServiceChoice.DELETE_OBJECT
    }), '192.0.2.10', 47808);
    runtime.transport.emit('message', encodeResponse({
      invokeId: 7,
      pduType: baEnum.PduTypes.COMPLEX_ACK
    }), '192.0.2.10', 47808);
    expect(calls).to.deep.equal([]);

    runtime.transport.emit('message', encodeResponse({invokeId: 7}), '192.0.2.10', 47808);
    expect(calls).to.deep.equal([{error: null, value: undefined}]);
  });

  it('ignores fixed-length terminal APDUs with trailing bytes', () => {
    const runtime = createClient();
    const calls = [];
    const cases = [
      {invokeId: 81, peer: '192.0.2.81', pduType: baEnum.PduTypes.SIMPLE_ACK},
      {
        invokeId: 82,
        peer: '192.0.2.82',
        pduType: baEnum.PduTypes.REJECT,
        reason: baEnum.RejectReason.UNRECOGNIZED_SERVICE
      },
      {
        invokeId: 83,
        peer: '192.0.2.83',
        pduType: baEnum.PduTypes.ABORT | baEnum.PduAbortBits.SERVER,
        reason: baEnum.AbortReason.TSM_TIMEOUT
      }
    ];
    cases.forEach((testCase) => sendWrite(
      runtime.client,
      testCase.peer,
      {invokeId: testCase.invokeId},
      (error, value) => calls.push({error: error, value: value})
    ));

    cases.forEach((testCase) => {
      const malformed = Buffer.concat([encodeResponse(testCase), Buffer.from([0x00])]);
      malformed.writeUInt16BE(malformed.length, 2);
      runtime.transport.emit('message', malformed, testCase.peer, 47808);
    });
    expect(calls).to.deep.equal([]);

    cases.forEach((testCase) => runtime.transport.emit(
      'message',
      encodeResponse(testCase),
      testCase.peer,
      47808
    ));
    expect(calls).to.have.length(3);
    expect(calls[0]).to.deep.equal({error: null, value: undefined});
    expect(calls[1].error).to.have.property('code', 'BACNET_REJECT');
    expect(calls[2].error).to.have.property('code', 'BACNET_ABORT');
  });

  it('reports encoded BACnet Error, Reject, and Abort responses distinctly', () => {
    const runtime = createClient();
    const calls = [];
    const cases = [
      {
        invokeId: 40,
        peer: '192.0.2.40',
        pduType: baEnum.PduTypes.ERROR,
        code: 'BACNET_ERROR',
        message: 'BacnetError - Class:2 - Code:32'
      },
      {
        invokeId: 41,
        peer: '192.0.2.41',
        pduType: baEnum.PduTypes.REJECT,
        reason: baEnum.RejectReason.UNRECOGNIZED_SERVICE,
        code: 'BACNET_REJECT',
        message: 'BacnetReject - Reason:9'
      },
      {
        invokeId: 42,
        peer: '192.0.2.42',
        pduType: baEnum.PduTypes.ABORT | baEnum.PduAbortBits.SERVER,
        reason: baEnum.AbortReason.TSM_TIMEOUT,
        code: 'BACNET_ABORT',
        message: 'BacnetAbort - Reason:10'
      }
    ];

    cases.forEach((testCase) => sendWrite(
      runtime.client,
      testCase.peer,
      {invokeId: testCase.invokeId},
      (error, value, metadata) => calls.push({error: error, metadata: metadata, value: value})
    ));
    cases.forEach((testCase) => runtime.transport.emit('message', encodeResponse(testCase),
      testCase.peer, 47808));

    expect(calls).to.have.length(3);
    calls.forEach((call, index) => {
      expect(call.error).to.include({code: cases[index].code});
      expect(call.error.message).to.equal(cases[index].message);
      expect(call.metadata).to.equal(undefined);
      expect(call.value).to.equal(undefined);
    });
    expect(calls[0].error).to.include({
      errorClass: baEnum.ErrorClass.PROPERTY,
      errorCode: baEnum.ErrorCode.UNKNOWN_PROPERTY,
      service: WRITE_PROPERTY
    });
    expect(calls[1].error.reason).to.equal(baEnum.RejectReason.UNRECOGNIZED_SERVICE);
    expect(calls[2].error.reason).to.equal(baEnum.AbortReason.TSM_TIMEOUT);
  });

  it('cancels and aborts transport context when send returns false', () => {
    const runtime = createClient();
    const calls = [];
    runtime.transport.onSend = () => false;

    sendWrite(runtime.client, '192.0.2.10', {invokeId: 3},
      (error, value) => calls.push({error: error, value: value}));

    const context = runtime.transport.sent[0].context;
    expect(calls).to.have.length(1);
    expect(calls[0].error).to.have.property('code', 'ERR_SEND_FAILED');
    expect(calls[0].value).to.equal(undefined);
    expect(context.signal.aborted).to.equal(true);
    expect(context.signal.reason).to.equal(calls[0].error);

    runtime.transport.emit('message', encodeResponse({invokeId: 3}), '192.0.2.10', 47808);
    expect(calls).to.have.length(1);
  });

  it('supports per-request AbortSignals before and during transport work', async() => {
    const runtime = createClient();
    const inFlight = new AbortController();
    const inFlightReason = new Error('operator cancelled request');
    const calls = [];

    sendWrite(runtime.client, '192.0.2.10', {invokeId: 4, signal: inFlight.signal},
      (error, value) => calls.push({error: error, value: value}));
    const context = runtime.transport.sent[0].context;
    inFlight.abort(inFlightReason);

    expect(calls).to.deep.equal([{error: inFlightReason, value: undefined}]);
    expect(context.signal.aborted).to.equal(true);
    expect(context.signal.reason).to.equal(inFlightReason);
    runtime.transport.emit('message', encodeResponse({invokeId: 4}), '192.0.2.10', 47808);
    expect(calls).to.have.length(1);

    const beforeSend = new AbortController();
    const beforeSendReason = new Error('cancelled before request');
    beforeSend.abort(beforeSendReason);
    sendWrite(runtime.client, '192.0.2.11', {invokeId: 5, signal: beforeSend.signal},
      (error, value) => calls.push({error: error, value: value}));

    expect(runtime.transport.sent).to.have.length(1);
    expect(calls).to.have.length(1);
    await Promise.resolve();
    expect(calls[1]).to.deep.equal({error: beforeSendReason, value: undefined});
  });

  it('rolls back cleanly when send throws without blocking another transaction', () => {
    const runtime = createClient();
    const expected = new Error('transport send failed');
    const calls = [];
    runtime.transport.onSend = () => {
      throw expected;
    };

    expect(() => sendWrite(runtime.client, '192.0.2.10', {invokeId: 0},
      (error) => calls.push(error))).to.throw(expected);
    expect(runtime.transport.sent[0].context.signal.aborted).to.equal(true);
    expect(runtime.transport.sent[0].context.signal.reason).to.equal(expected);
    expect(calls).to.deep.equal([]);

    runtime.transport.onSend = () => true;
    let reuseError;
    try {
      sendWrite(runtime.client, '192.0.2.10', {invokeId: 0}, () => {});
    } catch (error) {
      reuseError = error;
    }
    expect(reuseError).to.have.property('code', 'ERR_INVOKE_ID_QUARANTINED');
    expect(runtime.transport.sent).to.have.length(1);

    expect(() => sendWrite(runtime.client, '192.0.2.10', {invokeId: 1},
      (error) => calls.push(error))).not.to.throw();
    expect(parseConfirmedRequest(runtime.transport.sent[1].buffer).apdu.invokeId).to.equal(1);
    runtime.transport.emit('message', encodeResponse({invokeId: 1}), '192.0.2.10', 47808);
    expect(calls).to.deep.equal([null]);
  });

  it('cancels all callbacks and aborts every send context when closed', () => {
    const runtime = createClient();
    const calls = [];
    sendWrite(runtime.client, '192.0.2.10', {invokeId: 1},
      (error) => calls.push({name: 'first', error: error}));
    sendWrite(runtime.client, '192.0.2.11', {invokeId: 2},
      (error) => calls.push({name: 'second', error: error}));
    const contexts = runtime.transport.sent.map((item) => item.context);

    runtime.client.close();

    expect(runtime.transport.closed).to.equal(true);
    expect(calls.map((call) => call.name)).to.deep.equal(['first', 'second']);
    calls.forEach((call, index) => {
      expect(call.error).to.have.property('code', 'ERR_CLIENT_CLOSED');
      expect(contexts[index].signal.aborted).to.equal(true);
      expect(contexts[index].signal.reason).to.equal(call.error);
    });

    runtime.transport.emit('message', encodeResponse({invokeId: 1}), '192.0.2.10', 47808);
    expect(calls).to.have.length(2);
  });

  it('rejects every outbound path after the client is closed', () => {
    const runtime = createClient();
    runtime.client.close();

    expect(() => sendWrite(runtime.client, '192.0.2.10', {}, () => {}))
      .to.throw('ERR_CLIENT_CLOSED').with.property('code', 'ERR_CLIENT_CLOSED');
    expect(() => runtime.client.timeSync('192.0.2.10', new Date()))
      .to.throw('ERR_CLIENT_CLOSED').with.property('code', 'ERR_CLIENT_CLOSED');
    expect(() => runtime.client.simpleAckResponse('192.0.2.10', WRITE_PROPERTY, 1))
      .to.throw('ERR_CLIENT_CLOSED').with.property('code', 'ERR_CLIENT_CLOSED');
    expect(runtime.transport.sent).to.have.length(0);
  });

  it('sends routed BACnet/IP requests to the router and correlates the NPDU source', () => {
    const runtime = createClient();
    const route = {ip: '192.0.2.254', net: 303, adr: [5, 6]};
    const calls = [];
    sendWrite(runtime.client, route, {invokeId: 12}, (error) => calls.push(error));

    const request = parseConfirmedRequest(runtime.transport.sent[0].buffer);
    expect(runtime.transport.sent[0].receiver).to.equal(route.ip);
    expect(request.npdu.destination).to.deep.include({net: route.net, adr: route.adr});

    runtime.transport.emit('message', encodeResponse({
      invokeId: 12,
      source: {net: route.net, adr: route.adr}
    }), route.ip, 47808);
    expect(calls).to.deep.equal([null]);
  });

  it('requires exact routed BACnet/IP correlation unless link fallback is enabled', () => {
    const route = {ip: '192.0.2.254', net: 303, adr: [5]};
    const strict = createClient();
    const strictCalls = [];
    sendWrite(strict.client, route, {invokeId: 13}, (error) => strictCalls.push(error));
    strict.transport.emit('message', encodeResponse({invokeId: 13}), route.ip, 47808);
    expect(strictCalls).to.deep.equal([]);
    strict.transport.emit('message', encodeResponse({
      invokeId: 13,
      source: {net: route.net, adr: route.adr}
    }), route.ip, 47808);
    expect(strictCalls).to.deep.equal([null]);

    const fallback = createClient({allowRoutedResponseFallback: true});
    const fallbackCalls = [];
    sendWrite(fallback.client, route, {invokeId: 14}, (error) => fallbackCalls.push(error));
    fallback.transport.emit('message', encodeResponse({invokeId: 14}), route.ip, 47808);
    expect(fallbackCalls).to.deep.equal([null]);
  });

  it('sends routed BACnet/SC requests to the VMAC and correlates exact and fallback replies', () => {
    const route = {vmac: '02:00:00:00:00:2A', net: 400, adr: [9]};
    const transportOptions = {addressKind: 'vmac'};
    const exact = createClient({}, transportOptions);
    const exactCalls = [];
    sendWrite(exact.client, route, {invokeId: 20}, (error) => exactCalls.push(error));

    const request = parseConfirmedRequest(exact.transport.sent[0].buffer);
    expect(exact.transport.sent[0].receiver).to.equal('02000000002a');
    expect(request.npdu.destination).to.deep.include({net: route.net, adr: route.adr});
    exact.transport.emit('message', encodeResponse({
      invokeId: 20,
      source: {net: route.net, adr: route.adr}
    }), '02000000002a', 0);
    expect(exactCalls).to.deep.equal([null]);

    const fallback = createClient({allowRoutedResponseFallback: true}, transportOptions);
    const fallbackCalls = [];
    sendWrite(fallback.client, route, {invokeId: 21}, (error) => fallbackCalls.push(error));
    fallback.transport.emit('message', encodeResponse({invokeId: 21}), '02000000002a', 0);
    expect(fallbackCalls).to.deep.equal([null]);
  });

  it('drops Forwarded-NPDU terminal responses but preserves origin metadata for announcements', () => {
    const runtime = createClient();
    const origin = '198.51.100.23';
    const bbmd = '192.0.2.254';
    const calls = [];
    const discoveries = [];
    runtime.client.on('whoIs', (event) => discoveries.push(event));
    sendWrite(runtime.client, origin, {invokeId: 31},
      (error, value, metadata) => calls.push({error: error, metadata: metadata, value: value}));

    runtime.transport.emit('message', encodeResponse({
      bvlcFunction: baEnum.BvlcResultPurpose.FORWARDED_NPDU,
      invokeId: 31,
      originatingAddress: origin,
      originatingPort: 47809
    }), bbmd, 47808);

    expect(calls).to.deep.equal([]);
    expect(runtime.client._transactions.size).to.equal(1);

    runtime.transport.emit(
      'message',
      encodeForwardedWhoIs(origin, 47809),
      bbmd,
      47808
    );
    expect(discoveries).to.have.length(1);
    expect(discoveries[0].sourceAddress).to.deep.equal({ip: origin, port: 47809});
    expect(discoveries[0].linkContext).to.deep.equal({
      transport: 'bacnet-ip',
      forwardedBy: bbmd,
      forwardedByPort: 47808,
      originating: {ip: origin, port: 47809}
    });
    expect(Object.isFrozen(discoveries[0].linkContext)).to.equal(true);
    expect(Object.isFrozen(discoveries[0].linkContext.originating)).to.equal(true);
  });

  it('resolves routed response helpers to the IP or VMAC link peer', () => {
    const cases = [
      {
        route: {ip: '192.0.2.254', net: 303, adr: [7]},
        receiver: '192.0.2.254',
        transportOptions: {}
      },
      {
        route: {vmac: '02-00-00-00-00-2B', net: 404, adr: [8]},
        receiver: '02000000002b',
        transportOptions: {addressKind: 'vmac'}
      }
    ];

    cases.forEach((testCase) => {
      const runtime = createClient(
        {allowUntrackedServerResponses: true},
        testCase.transportOptions
      );
      runtime.client.simpleAckResponse(testCase.route, WRITE_PROPERTY, 55);
      const sent = runtime.transport.sent[0];
      const response = parseSimpleAck(sent.buffer);
      expect(sent.receiver).to.equal(testCase.receiver);
      expect(response.npdu.destination).to.deep.include({
        net: testCase.route.net,
        adr: testCase.route.adr
      });
      expect(response.npdu.hopCount).to.equal(0xFF);
      expect(response.apdu).to.deep.include({
        invokeId: 55,
        service: WRITE_PROPERTY,
        type: baEnum.PduTypes.SIMPLE_ACK
      });
    });
  });

  it('isolates outbound direct transactions and routing by UDP destination port', () => {
    const runtime = createClient({destinationPort: 47808});
    const calls = [];
    const first = {ip: '192.0.2.70', port: 47809};
    const second = {ip: '192.0.2.70', port: 47810};
    sendWrite(runtime.client, first, {invokeId: 70}, (error) => calls.push(['first', error]));
    sendWrite(runtime.client, second, {invokeId: 70}, (error) => calls.push(['second', error]));

    expect(runtime.transport.sent.map((sent) => sent.context.destinationPort))
      .to.deep.equal([47809, 47810]);
    runtime.transport.emit('message', encodeResponse({invokeId: 70}), first.ip, first.port);
    runtime.transport.emit('message', encodeResponse({invokeId: 70}), second.ip, second.port);
    expect(calls).to.deep.equal([['first', null], ['second', null]]);
  });

  it('isolates routed transactions by router UDP destination port', () => {
    const runtime = createClient({destinationPort: 47808});
    const calls = [];
    const first = {ip: '192.0.2.72', port: 47809, net: 303, adr: [7]};
    const second = {ip: '192.0.2.72', port: 47810, net: 303, adr: [7]};
    sendWrite(runtime.client, first, {invokeId: 72},
      (error) => calls.push(['first', error]));
    sendWrite(runtime.client, second, {invokeId: 72},
      (error) => calls.push(['second', error]));

    expect(runtime.transport.sent.map((sent) => sent.context.destinationPort))
      .to.deep.equal([47809, 47810]);
    runtime.transport.emit('message', encodeResponse({
      invokeId: 72,
      source: {net: first.net, adr: first.adr}
    }), first.ip, first.port);
    runtime.transport.emit('message', encodeResponse({
      invokeId: 72,
      source: {net: second.net, adr: second.adr}
    }), second.ip, second.port);
    expect(calls).to.deep.equal([['first', null], ['second', null]]);
  });

  it('uses the configured destination port for legacy strings and rejects invalid ports', () => {
    const runtime = createClient({destinationPort: 47811});
    sendWrite(runtime.client, '192.0.2.71', {invokeId: 71}, () => {});

    expect(runtime.transport.sent[0].context.destinationPort).to.equal(47811);
    expect(() => sendWrite(
      runtime.client,
      {ip: '192.0.2.71', port: 0},
      {invokeId: 72},
      () => {}
    )).to.throw().with.property('code', 'ERR_INVALID_PORT');
    expect(() => sendWrite(
      runtime.client,
      {ip: '192.0.2.71', port: 65536},
      {invokeId: 72},
      () => {}
    )).to.throw().with.property('code', 'ERR_INVALID_PORT');
  });

  it('delivers BACnet/SC link context as the callback third argument', () => {
    const runtime = createClient({}, {addressKind: 'vmac'});
    const peer = '02000000002c';
    const metadata = Object.freeze({
      transport: 'bacnet-sc',
      messageId: '001122334455',
      originating: peer,
      destination: '020000000001',
      dataOptions: Object.freeze([])
    });
    const calls = [];
    sendWrite(runtime.client, peer, {invokeId: 61},
      (error, value, linkContext) => calls.push({
        error: error,
        linkContext: linkContext,
        value: value
      }));

    runtime.transport.emit('message', encodeResponse({invokeId: 61}), peer, 0, metadata);

    expect(calls).to.deep.equal([{
      error: null,
      linkContext: metadata,
      value: undefined
    }]);
  });

  it('publishes decoded unconfirmed event and private-transfer payloads', () => {
    const runtime = createClient();
    const events = [];
    const transfers = [];
    runtime.client.on('eventNotify', (event) => events.push(event));
    runtime.client.on('privateTransfer', (event) => transfers.push(event));
    const date = new Date(2024, 0, 2, 3, 4, 5, 60);

    runtime.transport.emit('message', encodeUnconfirmedRequest(
      baEnum.UnconfirmedServiceChoice.UNCONFIRMED_EVENT_NOTIFICATION,
      (buffer) => baServices.eventNotifyData.encode(buffer, {
        processId: 3,
        initiatingObjectId: {type: baEnum.ObjectType.DEVICE, instance: 12},
        eventObjectId: {type: baEnum.ObjectType.ANALOG_INPUT, instance: 1121},
        timeStamp: {type: baEnum.TimeStamp.DATETIME, value: date},
        notificationClass: 9,
        priority: 7,
        eventType: baEnum.EventType.UNSIGNED_RANGE,
        messageText: 'received',
        notifyType: baEnum.NotifyType.EVENT,
        ackRequired: false,
        fromState: baEnum.EventState.NORMAL,
        toState: baEnum.EventState.OFFNORMAL,
        unsignedRangeExceedingValue: 101,
        unsignedRangeStatusFlags: {bitsUsed: 4, value: [5]},
        unsignedRangeExceededLimit: 100
      })
    ), '192.0.2.90', 47809);
    runtime.transport.emit('message', encodeUnconfirmedRequest(
      baEnum.UnconfirmedServiceChoice.UNCONFIRMED_PRIVATE_TRANSFER,
      (buffer) => baServices.privateTransfer.encode(buffer, 255, 8, [1, 2, 3])
    ), '192.0.2.91', 47810);

    expect(events).to.have.length(1);
    expect(events[0]).to.deep.include({address: '192.0.2.90'});
    expect(events[0].sourceAddress).to.deep.equal({
      ip: '192.0.2.90',
      port: 47809
    });
    expect(events[0].eventData).to.deep.include({
      messageText: 'received',
      unsignedRangeExceedingValue: 101,
      unsignedRangeExceededLimit: 100
    });
    expect(events[0].eventData.len).to.be.greaterThan(0);
    expect(transfers).to.have.length(1);
    expect(transfers[0]).to.deep.include({address: '192.0.2.91'});
    expect(transfers[0].eventData).to.deep.include({vendorId: 255, serviceNumber: 8});
    expect(transfers[0].eventData.data).to.deep.equal(Buffer.from([1, 2, 3]));
  });
});
