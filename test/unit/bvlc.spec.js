'use strict';

const expect      = require('chai').expect;
const utils       = require('./utils');
const baBvlc      = require('../../lib/bvlc');

describe('bacstack - BVLC layer', () => {
  it('should expose and enforce the BVLC header length', () => {
    expect(baBvlc.BVLC_HEADER_LENGTH).to.equal(4);
    const packet = Buffer.from([0x81, 0x0A, 0x00, 0x04]);
    for (let length = 0; length < packet.length; length++) {
      expect(baBvlc.decode(packet.subarray(0, length), 0)).to.equal(undefined);
    }
  });

  it('should successfuly encode and decode a package', () => {
    const buffer = utils.getBuffer();
    baBvlc.encode(buffer.buffer, 10, 1482);
    const result = baBvlc.decode(buffer.buffer, 0);
    expect(result).to.deep.equal({
      len: 4,
      func: 10,
      msgLength: 1482
    });
  });

  it('should successfuly encode and decode a forwarded package', () => {
    const packet = Buffer.from([
      0x81, 0x04, 0x00, 0x0C,
      0xC0, 0x00, 0x02, 0x2A, 0xBA, 0xC0,
      0x01, 0x00
    ]);
    const result = baBvlc.decode(packet, 0);
    expect(result).to.deep.equal({
      len: 10,
      func: 4,
      msgLength: 12,
      originatingAddress: {
        ip: '192.0.2.42',
        port: 47808
      }
    });
  });

  it('should decode a forwarded origin relative to the requested offset', () => {
    const packet = Buffer.from([
      0xFF, 0xFF,
      0x81, 0x04, 0x00, 0x0B,
      0xCB, 0x00, 0x71, 0x07, 0x12, 0x34,
      0x01
    ]);
    const result = baBvlc.decode(packet, 2);
    expect(result).to.deep.equal({
      len: 10,
      func: 4,
      msgLength: 11,
      originatingAddress: {
        ip: '203.0.113.7',
        port: 0x1234
      }
    });
  });

  it('should reject a forwarded package shorter than its function header', () => {
    for (let length = 4; length < 10; length++) {
      const packet = Buffer.alloc(length);
      packet[0] = 0x81;
      packet[1] = 0x04;
      packet.writeUInt16BE(length, 2);
      expect(baBvlc.decode(packet, 0)).to.equal(undefined);
    }
  });

  it('should fail if invalid BVLC type', () => {
    const buffer = utils.getBuffer();
    baBvlc.encode(buffer.buffer, 10, 1482);
    buffer.buffer[0] = 8;
    const result = baBvlc.decode(buffer.buffer, 0);
    expect(result).to.equal(undefined);
  });

  it('should fail if invalid length', () => {
    const buffer = utils.getBuffer();
    baBvlc.encode(buffer.buffer, 10, 1481);
    buffer.buffer[0] = 8;
    const result = baBvlc.decode(buffer.buffer, 0);
    expect(result).to.equal(undefined);
  });

  it('should fail if invalid function', () => {
    const buffer = utils.getBuffer();
    baBvlc.encode(buffer.buffer, 100, 1482);
    const result = baBvlc.decode(buffer.buffer, 0);
    expect(result).to.equal(undefined);
  });

  it('should fail if unsuported function', () => {
    const buffer = utils.getBuffer();
    baBvlc.encode(buffer.buffer, 5, 1482);
    const result = baBvlc.decode(buffer.buffer, 0);
    expect(result).to.equal(undefined);
  });
});
