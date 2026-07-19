'use strict';

const EventEmitter = require('events').EventEmitter;
const expect = require('chai').expect;

const Client = require('../../lib/client');
const baApdu = require('../../lib/apdu');
const baBvlc = require('../../lib/bvlc');
const baEnum = require('../../lib/enum');
const baNpdu = require('../../lib/npdu');
const baServices = require('../../lib/services');

class FakeTransport extends EventEmitter {
  constructor() {
    super();
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

  open() {}
  close() {}

  send(buffer, offset) {
    this.sent.push(Buffer.from(buffer.subarray(0, offset)));
  }
}

const decodeAcknowledgeAlarmRequest = (packet) => {
  const bvlc = baBvlc.decode(packet, 0);
  const npdu = baNpdu.decode(packet, bvlc.len, packet.length - bvlc.len);
  const apduOffset = bvlc.len + npdu.len;
  const apdu = baApdu.decodeConfirmedServiceRequest(
    packet,
    apduOffset,
    packet.length - apduOffset
  );
  const payloadOffset = apduOffset + apdu.len;
  return {
    apdu: apdu,
    request: baServices.alarmAcknowledge.decode(
      packet,
      payloadOffset,
      packet.length - payloadOffset
    )
  };
};

const acknowledgeAlarm = (client, options) => {
  const timestamp = {type: baEnum.TimeStamp.SEQUENCE_NUMBER, value: 5};
  client.acknowledgeAlarm(
    '192.0.2.1',
    {type: baEnum.ObjectType.ANALOG_INPUT, instance: 17},
    baEnum.EventState.OFFNORMAL,
    'confirmed boundary test',
    timestamp,
    timestamp,
    options,
    () => {}
  );
};

describe('bacstack - confirmed client boundaries', () => {
  it('requires a decoder to consume the exact ComplexACK payload', () => {
    const client = Object.create(Client.prototype);
    const payload = {
      buffer: Buffer.from([0x01, 0x02]),
      length: 2,
      metadata: {transport: 'test'},
      offset: 0
    };
    [
      {},
      {len: 1},
      {len: 3},
      {len: 1.5}
    ].forEach((decoded) => {
      let callbackResult;
      client._confirmedCallback((err, value, metadata) => {
        callbackResult = {err: err, metadata: metadata, value: value};
      }, () => decoded)(null, payload);
      expect(callbackResult.err).to.have.property('code', 'INVALID_DECODING');
      expect(callbackResult.value).to.equal(undefined);
      expect(callbackResult.metadata).to.equal(payload.metadata);
    });

    let callbackResult;
    const decoded = {len: payload.length, value: 42};
    client._confirmedCallback((err, value, metadata) => {
      callbackResult = {err: err, metadata: metadata, value: value};
    }, () => decoded)(null, payload);
    expect(callbackResult).to.deep.equal({
      err: null,
      metadata: payload.metadata,
      value: decoded
    });
  });

  it('retains acknowledging process identifier 57 as the default', () => {
    const transport = new FakeTransport();
    const client = new Client({transport: transport});
    acknowledgeAlarm(client, {invokeId: 7});

    const decoded = decodeAcknowledgeAlarmRequest(transport.sent[0]);
    expect(decoded.apdu.service).to.equal(baEnum.ConfirmedServiceChoice.ACKNOWLEDGE_ALARM);
    expect(decoded.request.acknowledgedProcessId).to.equal(57);
    client.close();
  });

  it('encodes an explicit acknowledging process identifier including zero', () => {
    [0, 0x10203040].forEach((acknowledgingProcessIdentifier, index) => {
      const transport = new FakeTransport();
      const client = new Client({transport: transport});
      acknowledgeAlarm(client, {
        acknowledgingProcessIdentifier: acknowledgingProcessIdentifier,
        invokeId: index
      });

      const decoded = decodeAcknowledgeAlarmRequest(transport.sent[0]);
      expect(decoded.request.acknowledgedProcessId).to.equal(acknowledgingProcessIdentifier);
      client.close();
    });
  });

  it('rejects invalid acknowledging process identifiers before sending', () => {
    const transport = new FakeTransport();
    const client = new Client({transport: transport});

    [-1, 0x100000000, 1.5, NaN, '57', null].forEach((value) => {
      expect(() => acknowledgeAlarm(client, {acknowledgingProcessIdentifier: value}))
        .to.throw('acknowledgingProcessIdentifier must be an integer from 0 through 4294967295')
        .with.property('code', 'ERR_INVALID_ACKNOWLEDGING_PROCESS_IDENTIFIER');
    });
    expect(transport.sent).to.have.length(0);
    expect(client._transactions.size).to.equal(0);
    client.close();
  });
});
