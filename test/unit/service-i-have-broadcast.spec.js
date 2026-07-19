'use strict';

const expect      = require('chai').expect;
const baAsn1      = require('../../lib/asn1');
const baEnum      = require('../../lib/enum');
const utils       = require('./utils');
const baServices  = require('../../lib/services');

describe('bacstack - Services layer IhaveBroadcast unit', () => {
  it('should successfully encode and decode', () => {
    const buffer = utils.getBuffer();
    baServices.iHaveBroadcast.encode(buffer, {type: 8, instance: 443}, {type: 0, instance: 4}, 'LgtCmd01');
    const result = baServices.iHaveBroadcast.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      deviceId: {type: 8, instance: 443},
      objectId: {type: 0, instance: 4},
      objectName: 'LgtCmd01'
    });
  });

  it('rejects a non-Device object identifier in the device field', () => {
    const buffer = utils.getBuffer();
    baAsn1.encodeApplicationObjectId(buffer, 0, 443);
    baAsn1.encodeApplicationObjectId(buffer, 0, 4);
    baAsn1.encodeApplicationCharacterString(buffer, 'LgtCmd01');
    expect(baServices.iHaveBroadcast.decode(
      buffer.buffer,
      0,
      buffer.offset
    )).to.equal(undefined);
  });

  it('rejects a non-Device encoder identifier before writing', () => {
    const buffer = utils.getBuffer();
    expect(() => baServices.iHaveBroadcast.encode(
      buffer,
      {type: baEnum.ObjectType.ANALOG_INPUT, instance: 443},
      {type: baEnum.ObjectType.ANALOG_INPUT, instance: 4},
      'LgtCmd01'
    )).to.throw(RangeError);
    expect(buffer.offset).to.equal(0);
  });
});
