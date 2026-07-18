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
    const buffer = utils.getBuffer();
    baBvlc.encode(buffer.buffer, 4, 1482);
    const result = baBvlc.decode(buffer.buffer, 0);
    expect(result).to.deep.equal({
      len: 10,
      func: 4,
      msgLength: 1482
    });
  });

  it('should reject a forwarded package shorter than its function header', () => {
    const packet = Buffer.from([0x81, 0x04, 0x00, 0x04]);
    expect(baBvlc.decode(packet, 0)).to.equal(undefined);
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
