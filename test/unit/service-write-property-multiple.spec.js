'use strict';

const expect      = require('chai').expect;
const baAsn1      = require('../../lib/asn1');
const baEnum      = require('../../lib/enum');
const utils       = require('./utils');
const baServices  = require('../../lib/services');

const encodeRawRequest = ({includeProperty = true, includeValue = true, priority} = {}) => {
  const buffer = utils.getBuffer();
  baAsn1.encodeContextObjectId(buffer, 0, 39, 2400);
  baAsn1.encodeOpeningTag(buffer, 1);
  if (includeProperty) {
    baAsn1.encodeContextEnumerated(buffer, 0, 81);
    baAsn1.encodeOpeningTag(buffer, 2);
    if (includeValue) {
      baAsn1.bacappEncodeApplicationData(buffer, {type: 2, value: 1});
    }
    baAsn1.encodeClosingTag(buffer, 2);
    if (priority !== undefined) {
      baAsn1.encodeContextUnsigned(buffer, 3, priority);
    }
  }
  baAsn1.encodeClosingTag(buffer, 1);
  return Buffer.from(buffer.buffer.subarray(0, buffer.offset));
};

describe('bacstack - Services layer WritePropertyMultiple unit', () => {
  it('should successfully encode and decode', () => {
    const buffer = utils.getBuffer();
    const date = new Date(1, 1, 1);
    const time = new Date(1, 1, 1);
    time.setMilliseconds(990);
    baServices.writePropertyMultiple.encode(buffer, {type: 39, instance: 2400}, [
      {property: {id: 81, index: 0xFFFFFFFF}, value: [
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
        {type: 7, value: 'Test1234$'},
        {type: 8, value: {bitsUsed: 0, value: []}},
        {type: 8, value: {bitsUsed: 24, value: [0xAA, 0xAA, 0xAA]}},
        {type: 9, value: 4},
        {type: 10, value: date},
        {type: 11, value: time},
        {type: 12, value: {type: 3, instance: 0}}
      ], priority: 0}
    ]);
    const result = baServices.writePropertyMultiple.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    result.values[0].value[12].value = Math.floor(result.values[0].value[12].value * 1000) / 1000;
    expect(result).to.deep.equal({
      objectId: {
        type: 39,
        instance: 2400
      },
      values: [
        {
          priority: 0,
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
            {type: 11, value: time},
            {type: 12, value: {type: 3, instance: 0}}
          ]
        }
      ]
    });
  });

  it('should successfully encode and decode with defined priority', () => {
    const buffer = utils.getBuffer();
    const time = new Date(1, 1, 1);
    time.setMilliseconds(990);
    baServices.writePropertyMultiple.encode(buffer, {type: 39, instance: 2400}, [
      {property: {id: 81, index: 0xFFFFFFFF}, value: [
        {type: 7, value: 'Test1234$'}
      ], priority: 12}
    ]);
    const result = baServices.writePropertyMultiple.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      objectId: {
        type: 39,
        instance: 2400
      },
      values: [
        {
          priority: 12,
          property: {
            index: 0xFFFFFFFF,
            id: 81
          },
          value: [
            {type: 7, value: 'Test1234$', encoding: 0}
          ]
        }
      ]
    });
  });

  it('should successfully encode and decode with defined array index', () => {
    const buffer = utils.getBuffer();
    const time = new Date(1, 1, 1);
    time.setMilliseconds(990);
    baServices.writePropertyMultiple.encode(buffer, {type: 39, instance: 2400}, [
      {property: {id: 81, index: 414141}, value: [
        {type: 7, value: 'Test1234$'}
      ], priority: 0}
    ]);
    const result = baServices.writePropertyMultiple.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      objectId: {
        type: 39,
        instance: 2400
      },
      values: [
        {
          priority: 0,
          property: {
            index: 414141,
            id: 81
          },
          value: [
            {type: 7, value: 'Test1234$', encoding: 0}
          ]
        }
      ]
    });
  });

  it('treats an omitted encoder priority as the priority-0 compatibility sentinel', () => {
    const buffer = utils.getBuffer();
    baServices.writePropertyMultiple.encode(buffer, {type: 39, instance: 2400}, [{
      property: {id: 81, index: baEnum.ASN1_ARRAY_ALL},
      value: [{type: 2, value: 1}]
    }]);
    const result = baServices.writePropertyMultiple.decode(buffer.buffer, 0, buffer.offset);
    expect(result.values[0].priority).to.equal(baEnum.ASN1_NO_PRIORITY);
  });

  it('accepts only priorities 1 through 16 when the priority tag is present', () => {
    [baEnum.ASN1_MIN_PRIORITY, baEnum.ASN1_MAX_PRIORITY].forEach((priority) => {
      const payload = encodeRawRequest({priority: priority});
      const result = baServices.writePropertyMultiple.decode(payload, 0, payload.length);
      expect(result.values[0].priority).to.equal(priority);
    });
    [baEnum.ASN1_NO_PRIORITY, baEnum.ASN1_MAX_PRIORITY + 1].forEach((priority) => {
      const payload = encodeRawRequest({priority: priority});
      expect(baServices.writePropertyMultiple.decode(
        payload,
        0,
        payload.length
      )).to.equal(undefined);
    });
  });

  it('rejects invalid encoder priorities before writing service data', () => {
    [-1, 17, 1.5].forEach((priority) => {
      const buffer = utils.getBuffer();
      expect(() => baServices.writePropertyMultiple.encode(
        buffer,
        {type: 39, instance: 2400},
        [{
          property: {id: 81, index: baEnum.ASN1_ARRAY_ALL},
          value: [{type: 2, value: 1}],
          priority: priority
        }]
      )).to.throw(RangeError);
      expect(buffer.offset).to.equal(0);
    });
  });

  it('rejects empty outer and property-level value lists', () => {
    const emptyRequest = encodeRawRequest({includeProperty: false});
    expect(baServices.writePropertyMultiple.decode(
      emptyRequest,
      0,
      emptyRequest.length
    )).to.equal(undefined);
    const emptyProperty = encodeRawRequest({includeValue: false});
    expect(baServices.writePropertyMultiple.decode(
      emptyProperty,
      0,
      emptyProperty.length
    )).to.equal(undefined);

    expect(() => baServices.writePropertyMultiple.encode(
      utils.getBuffer(),
      {type: 39, instance: 2400},
      []
    )).to.throw(RangeError);
    expect(() => baServices.writePropertyMultiple.encode(
      utils.getBuffer(),
      {type: 39, instance: 2400},
      [{
        property: {id: 81, index: baEnum.ASN1_ARRAY_ALL},
        value: [],
        priority: 0
      }]
    )).to.throw(RangeError);
    expect(() => baServices.writePropertyMultiple.encodeObject(
      utils.getBuffer(),
      []
    )).to.throw(RangeError);
  });
});
