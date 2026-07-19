'use strict';

const expect      = require('chai').expect;
const utils       = require('./utils');
const baServices  = require('../../lib/services');

describe('bacstack - Services layer LifeSafetyOperation unit', () => {
  it('should successfully encode and decode', () => {
    const buffer = utils.getBuffer();
    baServices.lifeSafetyOperation.encode(buffer, 8, 'User01', 7, {type: 0, instance: 77});
    const result = baServices.lifeSafetyOperation.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      processId: 8,
      requestingSource: 'User01',
      operation: 7,
      targetObjectId: {type: 0, instance: 77}
    });
  });

  it('should reject a truncated target object identifier', () => {
    const buffer = utils.getBuffer();
    baServices.lifeSafetyOperation.encode(buffer, 8, 'User01', 7, {type: 0, instance: 77});
    const truncated = Buffer.from(buffer.buffer.subarray(0, buffer.offset - 1));
    expect(() => baServices.lifeSafetyOperation.decode(truncated, 0, truncated.length)).not.to.throw();
    expect(baServices.lifeSafetyOperation.decode(truncated, 0, truncated.length)).to.equal(undefined);
  });

  it('encodes and decodes the optional all-objects form without a target', () => {
    const buffer = utils.getBuffer();
    baServices.lifeSafetyOperation.encode(buffer, 8, 'User01', 7);
    const result = baServices.lifeSafetyOperation.decode(buffer.buffer, 0, buffer.offset);
    expect(result).to.deep.equal({
      len: buffer.offset,
      processId: 8,
      requestingSource: 'User01',
      operation: 7
    });
  });
});
