'use strict';

const EventEmitter      = require('events').EventEmitter;
const expect            = require('chai').expect;
const bacnet            = require('../../');

class Transport extends EventEmitter {
  getBroadcastAddress() {
    return '255.255.255.255';
  }

  getMaxPayload() {
    return 1482;
  }

  send() {}
  open() {}
  close() {}
}

const frame = (payload, func) => {
  const packet = Buffer.alloc(4 + payload.length);
  packet[0] = 0x81;
  packet[1] = func == null ? 0x0A : func;
  packet.writeUInt16BE(packet.length, 2);
  payload.copy(packet, 4);
  return packet;
};

describe('bacstack - malformed inbound packets', () => {
  let client;
  let transport;

  beforeEach(() => {
    transport = new Transport();
    client = new bacnet({transport: transport});
  });

  afterEach(() => client.close());

  it('drops non-buffer and truncated link-layer input without throwing', () => {
    const inputs = [undefined, null, {}, 'not a packet', new Uint8Array(4)];
    const packet = frame(Buffer.from([1, 0, 16, 8]));
    for (let length = 0; length < packet.length; length++) {
      inputs.push(packet.subarray(0, length));
    }

    inputs.forEach((input) => {
      expect(() => transport.emit('message', input, '192.0.2.1', 47808)).not.to.throw();
    });
  });

  it('drops every truncated APDU header without throwing', () => {
    const headers = [
      [0, 0, 1, 12],
      [8, 0, 1, 2, 3, 12],
      [16, 8],
      [32, 1, 12],
      [48, 1, 12],
      [56, 1, 2, 3, 12],
      [64, 1, 2, 3],
      [80, 1, 12],
      [112, 1, 2]
    ];

    headers.forEach((header) => {
      for (let length = 0; length < header.length; length++) {
        const npduAndApdu = Buffer.from([1, 0].concat(header.slice(0, length)));
        expect(() => transport.emit('message', frame(npduAndApdu), '192.0.2.1', 47808)).not.to.throw();
      }
    });
  });

  it('contains decoder exceptions caused by malformed service payloads', () => {
    const packet = Buffer.from('8104001f23b979835a3801505bf314c95c8e05f8b2816c6f73b12cdb0f4e5a', 'hex');
    expect(() => transport.emit('message', packet, '192.0.2.1', 47808)).not.to.throw();
  });

  it('does not swallow exceptions thrown by application event listeners', () => {
    const expected = new Error('listener failed');
    client.on('whoIs', () => {
      throw expected;
    });

    expect(() => transport.emit('message', frame(Buffer.from([1, 0, 16, 8])), '192.0.2.1', 47808)).to.throw(expected);
  });

  it('preserves transport failures on the client error event', () => {
    const expected = new Error('transport failed');
    let actual;
    client.on('error', (err) => actual = err);

    transport.emit('error', expected);

    expect(actual).to.equal(expected);
  });

  it('drops deterministic arbitrary framed input without throwing', () => {
    let state = 0x12345678;
    const nextByte = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state >>> 24;
    };

    for (let iteration = 0; iteration < 10000; iteration++) {
      const payload = Buffer.alloc(nextByte() % 128);
      for (let index = 0; index < payload.length; index++) payload[index] = nextByte();
      expect(() => transport.emit('message', frame(payload), '192.0.2.1', 47808)).not.to.throw();
    }
  });
});
