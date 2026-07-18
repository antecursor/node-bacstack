'use strict';

const expect      = require('chai').expect;
const utils       = require('./utils');
const baServices  = require('../../lib/services');

describe('bacstack - Services layer WhoHas unit', () => {
  it('should successfully encode and decode by id', () => {
    const buffer = utils.getBuffer();
    baServices.whoHas.encode(buffer, 3, 4000, {type: 3, instance: 15});
    const result = baServices.whoHas.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      lowLimit: 3,
      highLimit: 4000,
      objectId: {
        type: 3,
        instance: 15
      }
    });
  });

  it('should successfully encode and decode by name', () => {
    const buffer = utils.getBuffer();
    baServices.whoHas.encode(buffer, 3, 4000, {}, 'analog-output-1');
    const result = baServices.whoHas.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      lowLimit: 3,
      highLimit: 4000,
      objectName: 'analog-output-1'
    });
  });

  it('should decode a character string from a non-zero APDU offset', () => {
    const buffer = utils.getBuffer();
    const offset = 11;
    buffer.offset = offset;
    baServices.whoHas.encode(buffer, 3, 4000, {}, 'analog-output-1');
    const result = baServices.whoHas.decode(buffer.buffer, offset, buffer.offset - offset);
    delete result.len;
    expect(result).to.deep.equal({
      lowLimit: 3,
      highLimit: 4000,
      objectName: 'analog-output-1'
    });
  });

  it('should reject a truncated object identifier', () => {
    const buffer = utils.getBuffer();
    baServices.whoHas.encode(buffer, undefined, undefined, {type: 3, instance: 15});
    const truncated = Buffer.from(buffer.buffer.subarray(0, buffer.offset - 1));
    expect(() => baServices.whoHas.decode(truncated, 0, truncated.length)).not.to.throw();
    expect(baServices.whoHas.decode(truncated, 0, truncated.length)).to.equal(undefined);
  });
});
