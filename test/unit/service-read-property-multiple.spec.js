'use strict';

const expect      = require('chai').expect;
const utils       = require('./utils');
const baAsn1      = require('../../lib/asn1');
const baEnum      = require('../../lib/enum');
const baServices  = require('../../lib/services');

const encode = (callback) => {
  const writer = utils.getBuffer();
  callback(writer);
  return Buffer.from(writer.buffer.subarray(0, writer.offset));
};

const expectCleanRejection = (decode, payload, label) => {
  const input = Buffer.concat([Buffer.from([0xAA]), payload, Buffer.from([0xBB])]);
  const before = Buffer.from(input);
  let result;
  expect(() => {
    result = decode(input, 1, payload.length);
  }, label).not.to.throw();
  expect(result, label).to.equal(undefined);
  expect(input.equals(before), `${label} input mutation`).to.equal(true);
};

describe('bacstack - Services layer ReadPropertyMultiple unit', () => {
  it('should successfully encode and decode', () => {
    const buffer = utils.getBuffer();
    baServices.readPropertyMultiple.encode(buffer, [
      {objectId: {type: 51, instance: 1}, properties: [
        {id: 85, index: 0xFFFFFFFF},
        {id: 85, index: 4}
      ]}
    ]);
    const result = baServices.readPropertyMultiple.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({properties: [{objectId: {type: 51, instance: 1}, properties: [
      {id: 85, index: 0xFFFFFFFF},
      {id: 85, index: 4}
    ]}]});
  });

  it('rejects missing, wrong, and trailing request tags cleanly', () => {
    const payload = encode((buffer) => baServices.readPropertyMultiple.encode(buffer, [{
      objectId: {type: 2, instance: 7},
      properties: [{id: 85, index: baEnum.ASN1_ARRAY_ALL}]
    }]));
    const mutations = [
      payload.subarray(0, payload.length - 1),
      Buffer.concat([payload, Buffer.from([0x00])]),
      Buffer.from(payload),
      Buffer.from(payload),
      Buffer.from(payload),
      Buffer.from(payload)
    ];
    mutations[2][0] = 0xC4;
    mutations[3][5] = 0x1F;
    mutations[4][6] = 0x19;
    mutations[5][8] = 0x2F;
    mutations.forEach((mutation, index) => expectCleanRejection(
      baServices.readPropertyMultiple.decode,
      mutation,
      `request mutation ${index}`
    ));
  });
});

describe('ReadPropertyMultipleAcknowledge', () => {
  it('should successfully encode and decode', () => {
    const buffer = utils.getBuffer();
    const date = new Date(1, 1, 1);
    const time = new Date(1, 1, 1);
    time.setMilliseconds(990);
    baServices.readPropertyMultiple.encodeAcknowledge(buffer, [
      {objectId: {type: 9, instance: 50000}, values: [
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
          {type: 11, value: time},
          {type: 12, value: {type: 3, instance: 0}}
        ]}
      ]}
    ]);
    const result = baServices.readPropertyMultiple.decodeAcknowledge(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(Math.floor(0.1 * 10000)).to.equal(Math.floor(result.values[0].values[0].value[12].value * 10000));
    result.values[0].values[0].value[12].value = 0;
    expect(result).to.deep.equal({
      values: [{
        objectId: {
          type: 9,
          instance: 50000
        },
        values: [{
          index: 4294967295,
          id: 81,
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
            {type: 4, value: 0},
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
        }]
      }]
    });
  });

  it('should successfully encode and decode an error', () => {
    const buffer = utils.getBuffer();
    baServices.readPropertyMultiple.encodeAcknowledge(buffer, [
      {objectId: {type: 9, instance: 50000}, values: [
        {property: {id: 81, index: 0xFFFFFFFF}, value: [
          {type: 0, value: {type: 'BacnetError', errorClass: 12, errorCode: 13}}
        ]}
      ]}
    ]);
    const result = baServices.readPropertyMultiple.decodeAcknowledge(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      values: [{
        objectId: {
          type: 9,
          instance: 50000
        },
        values: [{
          index: 4294967295,
          id: 81,
          value: [{
            type: 105,
            value: {
              errorClass: 12,
              errorCode: 13
            }
          }]
        }]
      }]
    });
  });

  it('honors every acknowledgement prefix in a displaced declared window', () => {
    const payload = encode((buffer) => baServices.readPropertyMultiple.encodeAcknowledge(buffer, [{
      objectId: {type: 2, instance: 7},
      values: [{
        property: {id: 85, index: baEnum.ASN1_ARRAY_ALL},
        value: [{type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 9}]
      }]
    }]));
    const input = Buffer.concat([Buffer.from([0xAA]), payload, Buffer.alloc(8, 0x55)]);
    for (let length = 0; length < payload.length; length++) {
      const before = Buffer.from(input);
      let result;
      expect(() => {
        result = baServices.readPropertyMultiple.decodeAcknowledge(input, 1, length);
      }, `acknowledgement prefix ${length}`).not.to.throw();
      expect(result, `acknowledgement prefix ${length}`).to.equal(undefined);
      expect(input.equals(before), `acknowledgement prefix ${length} input mutation`).to.equal(true);
    }
    expect(baServices.readPropertyMultiple.decodeAcknowledge(input, 1, payload.length)).to.deep.include({
      len: payload.length
    });
  });

  it('rejects missing, wrong, and trailing acknowledgement tags cleanly', () => {
    const payload = encode((buffer) => baServices.readPropertyMultiple.encodeAcknowledge(buffer, [{
      objectId: {type: 2, instance: 7},
      values: [{
        property: {id: 85, index: baEnum.ASN1_ARRAY_ALL},
        value: [{type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 9}]
      }]
    }]));
    const mutations = [
      payload.subarray(0, payload.length - 1),
      Buffer.concat([payload, Buffer.from([0x00])]),
      Buffer.from(payload),
      Buffer.from(payload),
      Buffer.from(payload),
      Buffer.from(payload),
      Buffer.from(payload)
    ];
    mutations[2][5] = 0x1F;
    mutations[3][6] = 0x19;
    mutations[4][6] = 0x28;
    mutations[5][8] = 0x3E;
    mutations[6][11] = 0x5F;
    mutations.forEach((mutation, index) => expectCleanRejection(
      baServices.readPropertyMultiple.decodeAcknowledge,
      mutation,
      `acknowledgement mutation ${index}`
    ));
    const trailing = Buffer.concat([payload, Buffer.from([0x00])]);
    expect(baAsn1.decodeReadAccessResult(trailing, 0, trailing.length)).to.equal(undefined);
  });

  it('rejects wrong application error tags without NaN or partial values', () => {
    const payload = encode((buffer) => baServices.readPropertyMultiple.encodeAcknowledge(buffer, [{
      objectId: {type: 2, instance: 7},
      values: [{
        property: {id: 85, index: baEnum.ASN1_ARRAY_ALL},
        value: [{type: baEnum.ApplicationTags.NULL, value: {
          type: 'BacnetError', errorClass: 12, errorCode: 13
        }}]
      }]
    }]));
    payload[9] = 0x99;
    expectCleanRejection(
      baServices.readPropertyMultiple.decodeAcknowledge,
      payload,
      'context-specific error class'
    );

    const directResult = baAsn1.decodeReadAccessResult(payload, 0, payload.length);
    expect(directResult).to.equal(undefined);
  });
});
