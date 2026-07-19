'use strict';

const EventEmitter = require('events').EventEmitter;
const expect = require('chai').expect;
const Client = require('../../lib/client');
const baApdu = require('../../lib/apdu');
const baBvlc = require('../../lib/bvlc');
const baEnum = require('../../lib/enum');
const baNpdu = require('../../lib/npdu');

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

const decodeRequest = (packet) => {
  const bvlc = baBvlc.decode(packet, 0);
  const npdu = baNpdu.decode(packet, bvlc.len, packet.length - bvlc.len);
  const apduOffset = bvlc.len + npdu.len;
  const apdu = baApdu.decodeConfirmedServiceRequest(
    packet,
    apduOffset,
    packet.length - apduOffset
  );
  return {
    apdu: apdu,
    payloadLength: packet.length - apduOffset - apdu.len
  };
};

describe('bacstack - GetEventInformation request overloads', () => {
  it('sends an empty first-page request when the object identifier is omitted', () => {
    const transport = new FakeTransport();
    const client = new Client({transport: transport});

    client.getEventInformation('192.0.2.1', () => {});

    expect(transport.sent).to.have.length(1);
    const request = decodeRequest(transport.sent[0]);
    expect(request.apdu.service).to.equal(baEnum.ConfirmedServiceChoice.GET_EVENT_INFORMATION);
    expect(request.payloadLength).to.equal(0);
    client.close();
  });

  it('accepts request options as the second argument for a first-page request', () => {
    const transport = new FakeTransport();
    const client = new Client({transport: transport});

    client.getEventInformation('192.0.2.1', {invokeId: 0}, () => {});

    const request = decodeRequest(transport.sent[0]);
    expect(request.apdu.invokeId).to.equal(0);
    expect(request.payloadLength).to.equal(0);
    client.close();
  });
});
