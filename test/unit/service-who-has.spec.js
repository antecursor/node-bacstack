'use strict';

const expect      = require('chai').expect;
const baAsn1      = require('../../lib/asn1');
const baEnum      = require('../../lib/enum');
const utils       = require('./utils');
const baServices  = require('../../lib/services');

const encodeRequest = (lowLimit, highLimit) => {
  const buffer = utils.getBuffer();
  if (lowLimit != null) baAsn1.encodeContextUnsigned(buffer, 0, lowLimit);
  if (highLimit != null) baAsn1.encodeContextUnsigned(buffer, 1, highLimit);
  baAsn1.encodeContextObjectId(buffer, 2, 3, 15);
  return Buffer.from(buffer.buffer.subarray(0, buffer.offset));
};

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

  it('rejects invalid limit pairs before encoding any service data', () => {
    [
      [1, undefined],
      [undefined, 1],
      [-1, 1],
      [0, baEnum.ASN1_MAX_INSTANCE + 1],
      [2, 1]
    ].forEach(([lowLimit, highLimit]) => {
      const buffer = utils.getBuffer();
      expect(() => baServices.whoHas.encode(
        buffer,
        lowLimit,
        highLimit,
        {type: 3, instance: 15}
      )).to.throw(RangeError);
      expect(buffer.offset).to.equal(0);
    });
  });

  it('rejects incomplete, out-of-range, or reversed encoded limit pairs', () => {
    [
      encodeRequest(1, undefined),
      encodeRequest(undefined, 1),
      encodeRequest(0, baEnum.ASN1_MAX_INSTANCE + 1),
      encodeRequest(2, 1)
    ].forEach((payload) => {
      expect(baServices.whoHas.decode(payload, 0, payload.length)).to.equal(undefined);
    });
  });

  it('accepts the inclusive BACnet device-instance boundaries', () => {
    const payload = encodeRequest(0, baEnum.ASN1_MAX_INSTANCE);
    expect(baServices.whoHas.decode(payload, 0, payload.length)).to.deep.equal({
      len: payload.length,
      lowLimit: 0,
      highLimit: baEnum.ASN1_MAX_INSTANCE,
      objectId: {type: 3, instance: 15}
    });
  });
});
