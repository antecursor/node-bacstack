'use strict';

const expect      = require('chai').expect;
const utils       = require('./utils');
const baServices  = require('../../lib/services');

describe('bacstack - Services layer CreateObject unit', () => {
  it('encodes and decodes the object-type choice without empty initial values', () => {
    const buffer = utils.getBuffer();
    baServices.createObject.encode(buffer, {type: 0}, []);

    expect(Buffer.from(buffer.buffer.subarray(0, buffer.offset)).toString('hex')).to.equal('0e09000f');
    expect(baServices.createObject.decode(buffer.buffer, 0, buffer.offset)).to.deep.equal({
      len: buffer.offset,
      objectId: {type: 0},
      values: []
    });
  });

  it('should successfully encode and decode', () => {
    const buffer = utils.getBuffer();
    const date = new Date(1, 1, 1);
    const time = new Date(1, 1, 1);
    time.setMilliseconds(990);
    baServices.createObject.encode(buffer, {type: 1, instance: 10}, [
      {property: {id: 81, index: 0xFFFFFFFF}, value: [
        {type: 0},
        {type: 1, value: null},
        {type: 1, value: true},
        {type: 1, value: false},
        {type: 2, value: 1},
        {type: 2, value: 1000},
        {type: 2, value: 1000000},
        {type: 2, value: 1000000000},
        {type: 3, value: -1},
        {type: 3, value: -1000},
        {type: 3, value: -1000000},
        {type: 3, value: -1000000000},
        {type: 4, value: 0.1},
        {type: 5, value: 100.121212},
        {type: 6, value: [1, 2, 100, 200]},
        {type: 7, value: 'Test1234$'},
        {type: 8, value: {bitsUsed: 0, value: []}},
        {type: 8, value: {bitsUsed: 24, value: [0xAA, 0xAA, 0xAA]}},
        {type: 9, value: 4},
        {type: 10, value: date},
        {type: 11, value: time}
      ], priority: 0},
      {property: {id: 82, index: 0}, value: [
        {type: 12, value: {type: 3, instance: 0}}
      ], priority: 0}
    ]);
    const result = baServices.createObject.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    result.values[0].value[12].value = Math.floor(result.values[0].value[12].value * 1000) / 1000;
    expect(result).to.deep.equal({
      objectId: {
        type: 1,
        instance: 10
      },
      values: [
        {
          property: {
            index: 0xFFFFFFFF,
            id: 81
          },
          value: [
            {type: 0, value: null},
            {type: 0, value: null},
            {type: 1, value: true},
            {type: 1, value: false},
            {type: 2, value: 1},
            {type: 2, value: 1000},
            {type: 2, value: 1000000},
            {type: 2, value: 1000000000},
            {type: 3, value: -1},
            {type: 3, value: -1000},
            {type: 3, value: -1000000},
            {type: 3, value: -1000000000},
            {type: 4, value: 0.1},
            {type: 5, value: 100.121212},
            {type: 6, value: [1, 2, 100, 200]},
            {type: 7, value: 'Test1234$', encoding: 0},
            {type: 8, value: {bitsUsed: 0, value: []}},
            {type: 8, value: {bitsUsed: 24, value: [0xAA, 0xAA, 0xAA]}},
            {type: 9, value: 4},
            {type: 10, value: date},
            {type: 11, value: time}
          ]
        },
        {
          property: {
            index: 0,
            id: 82
          },
          value: [
            {type: 12, value: {type: 3, instance: 0}}
          ]
        }
      ]
    });
  });

  it('should reject a property value with a missing closing tag', () => {
    const buffer = utils.getBuffer();
    baServices.createObject.encode(buffer, {type: 1, instance: 10}, [{
      property: {id: 81, index: 0xFFFFFFFF},
      value: [{type: 2, value: 1}],
      priority: 0
    }]);
    const truncated = Buffer.from(buffer.buffer.subarray(0, buffer.offset - 2));
    const decode = () => baServices.createObject.decode(truncated, 0, truncated.length);
    expect(decode).not.to.throw();
    expect(decode()).to.equal(undefined);
  });

  it('encodes and exactly decodes the assigned object identifier acknowledgement', () => {
    const buffer = utils.getBuffer();
    baServices.createObject.encodeAcknowledge(buffer, {type: 2, instance: 47});
    const encoded = Buffer.from(buffer.buffer.subarray(0, buffer.offset));

    expect(baServices.createObject.decodeAcknowledge(encoded, 0, encoded.length)).to.deep.equal({
      len: encoded.length,
      objectId: {type: 2, instance: 47}
    });
    for (let length = 0; length < encoded.length; length++) {
      expect(baServices.createObject.decodeAcknowledge(encoded, 0, length)).to.equal(undefined);
    }
    const wrapped = Buffer.concat([Buffer.from([0xAA]), encoded, Buffer.from([0xBB])]);
    expect(baServices.createObject.decodeAcknowledge(wrapped, 1, encoded.length)).to.include({
      len: encoded.length
    });
    expect(baServices.createObject.decodeAcknowledge(wrapped, 1, encoded.length + 1)).to.equal(undefined);
  });

  it('rejects malformed object specifiers and acknowledgement tag classes', () => {
    expect(baServices.createObject.decode(Buffer.from('0e09000e', 'hex'), 0, 4)).to.equal(undefined);
    expect(baServices.createObject.decode(Buffer.from('0e0d000000000f', 'hex'), 0, 7)).to.equal(undefined);

    const buffer = utils.getBuffer();
    baServices.createObject.encodeAcknowledge(buffer, {type: 2, instance: 47});
    const wrongClass = Buffer.from(buffer.buffer.subarray(0, buffer.offset));
    wrongClass[0] |= 0x08;
    expect(baServices.createObject.decodeAcknowledge(wrongClass, 0, wrongClass.length)).to.equal(undefined);
  });
});
