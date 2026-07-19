'use strict';

const expect      = require('chai').expect;
const utils       = require('./utils');
const baServices  = require('../../lib/services');

describe('bacstack - Services layer PrivateTransfer unit', () => {
  it('should successfully encode and decode', () => {
    const buffer = utils.getBuffer();
    baServices.privateTransfer.encode(buffer, 255, 8, [1, 2, 3, 4, 5]);
    const result = baServices.privateTransfer.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      vendorId: 255,
      serviceNumber: 8,
      data: Buffer.from([1, 2, 3, 4, 5])
    });
  });

  [
    {name: 'Buffer', data: Buffer.from([0, 127, 255])},
    {name: 'Uint8Array', data: new Uint8Array([0, 127, 255])},
    {name: 'array', data: [0, 127, 255]}
  ].forEach((testCase) => {
    it(`accepts ${testCase.name} encoder data`, () => {
      const buffer = utils.getBuffer();
      baServices.privateTransfer.encode(buffer, 255, 8, testCase.data);

      expect(baServices.privateTransfer.decode(buffer.buffer, 0, buffer.offset).data).to.deep.equal(Buffer.from([0, 127, 255]));
    });
  });

  it('returns an owned payload Buffer', () => {
    const buffer = utils.getBuffer();
    baServices.privateTransfer.encode(buffer, 255, 8, [1, 2, 3]);
    const result = baServices.privateTransfer.decode(buffer.buffer, 0, buffer.offset);
    buffer.buffer.fill(0, 0, buffer.offset);

    expect(result.data).to.deep.equal(Buffer.from([1, 2, 3]));
  });

  [
    {name: 'a string', data: '123'},
    {name: 'negative values', data: [1, -1]},
    {name: 'values above 255', data: [256]},
    {name: 'fractional values', data: [1.5]},
    {name: 'array holes', data: new Array(1)}
  ].forEach((testCase) => {
    it(`rejects ${testCase.name} before writing`, () => {
      const buffer = utils.getBuffer();

      expect(() => baServices.privateTransfer.encode(buffer, 255, 8, testCase.data)).to.throw();
      expect(buffer.offset).to.equal(0);
    });
  });

  it('encodes and decodes omitted service parameters', () => {
    const buffer = utils.getBuffer();
    baServices.privateTransfer.encode(buffer, 255, 8);
    expect(Buffer.from(buffer.buffer.subarray(0, buffer.offset))).to.deep.equal(
      Buffer.from('09ff1908', 'hex')
    );
    expect(baServices.privateTransfer.decode(buffer.buffer, 0, buffer.offset)).to.deep.equal({
      len: buffer.offset,
      vendorId: 255,
      serviceNumber: 8,
      data: Buffer.alloc(0)
    });
  });

  it('encodes and decodes explicit empty service parameters', () => {
    const buffer = utils.getBuffer();
    baServices.privateTransfer.encode(buffer, 255, 8, Buffer.alloc(0));

    expect(baServices.privateTransfer.decode(buffer.buffer, 0, buffer.offset).data).to.deep.equal(Buffer.alloc(0));
  });
});
