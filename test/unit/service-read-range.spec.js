'use strict';

const expect      = require('chai').expect;
const utils       = require('./utils');
const baServices  = require('../../lib/services');
const baEnum      = require('../../lib/enum');

describe('bacstack - Services layer ReadRange unit', () => {
  const encodeRequest = (requestType = baEnum.ReadRangeType.BY_POSITION) => {
    const buffer = utils.getBuffer();
    baServices.readRange.encode(buffer, {type: 61, instance: 35}, 85, baEnum.ASN1_ARRAY_ALL, requestType, 10, new Date(2026, 6, 18, 3, 4, 5, 670), -2);
    return Buffer.from(buffer.buffer.subarray(0, buffer.offset));
  };

  it('should successfully encode and decode by position', () => {
    const buffer = utils.getBuffer();
    baServices.readRange.encode(buffer, {type: 61, instance: 35}, 85, 0xFFFFFFFF, baEnum.ReadRangeType.BY_POSITION, 10, null, 0);
    const result = baServices.readRange.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      count: 0,
      objectId: {type: 61, instance: 35},
      position: 10,
      property: {
        index: 0xFFFFFFFF,
        id: 85
      },
      requestType: baEnum.ReadRangeType.BY_POSITION,
      time: undefined
    });
  });

  it('should successfully encode and decode by position with array index', () => {
    const buffer = utils.getBuffer();
    baServices.readRange.encode(buffer, {type: 61, instance: 35}, 12, 2, baEnum.ReadRangeType.BY_SEQUENCE_NUMBER, 10, null, 0);
    const result = baServices.readRange.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      count: 0,
      objectId: {type: 61, instance: 35},
      position: 10,
      property: {
        index: 2,
        id: 12
      },
      requestType: baEnum.ReadRangeType.BY_SEQUENCE_NUMBER,
      time: undefined
    });
  });

  it('should successfully encode and decode by sequence', () => {
    const buffer = utils.getBuffer();
    baServices.readRange.encode(buffer, {type: 61, instance: 35}, 85, 0xFFFFFFFF, baEnum.ReadRangeType.BY_SEQUENCE_NUMBER, 11, null, 1111);
    const result = baServices.readRange.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      count: 1111,
      objectId: {type: 61, instance: 35},
      position: 11,
      property: {
        index: 0xFFFFFFFF,
        id: 85
      },
      requestType: baEnum.ReadRangeType.BY_SEQUENCE_NUMBER,
      time: undefined
    });
  });

  it('should successfully encode and decode by time', () => {
    const buffer = utils.getBuffer();
    const date = new Date(1, 1, 1);
    date.setMilliseconds(990);
    baServices.readRange.encode(buffer, {type: 61, instance: 35}, 85, 0xFFFFFFFF, baEnum.ReadRangeType.BY_TIME_REFERENCE_TIME_COUNT, null, date, -1111);
    const result = baServices.readRange.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      count: -1111,
      objectId: {type: 61, instance: 35},
      position: undefined,
      property: {
        index: 0xFFFFFFFF,
        id: 85
      },
      requestType: baEnum.ReadRangeType.BY_TIME_REFERENCE_TIME_COUNT,
      time: date
    });
  });

  it('decodes a read-all request without a range choice', () => {
    const buffer = utils.getBuffer();
    baServices.readRange.encode(buffer, {type: 61, instance: 35}, 85, baEnum.ASN1_ARRAY_ALL);

    expect(baServices.readRange.decode(buffer.buffer, 0, buffer.offset)).to.deep.equal({
      len: buffer.offset,
      count: undefined,
      objectId: {type: 61, instance: 35},
      position: undefined,
      property: {index: baEnum.ASN1_ARRAY_ALL, id: 85},
      requestType: undefined,
      time: undefined
    });
  });

  it('honors nonzero offsets and the declared APDU window', () => {
    const request = encodeRequest();
    const wrapped = Buffer.concat([Buffer.from([0xAA, 0xBB]), request, Buffer.from([0xCC])]);

    expect(baServices.readRange.decode(wrapped, 2, request.length)).to.include({len: request.length, count: -2});
    expect(baServices.readRange.decode(wrapped, 2, request.length + 1)).to.equal(undefined);
    expect(baServices.readRange.decode(wrapped, 2, request.length - 1)).to.equal(undefined);
  });

  it('rejects malformed and truncated range choices without throwing', () => {
    const request = encodeRequest(baEnum.ReadRangeType.BY_SEQUENCE_NUMBER);
    for (let length = 8; length < request.length; length++) {
      const decode = () => baServices.readRange.decode(request, 0, length);
      expect(decode).not.to.throw();
      const result = decode();
      if (result) {
        expect(result.len).to.be.a('number').and.to.be.at.most(length);
      }
    }

    const wrongClass = Buffer.from(request);
    wrongClass[7] &= ~0x08;
    expect(baServices.readRange.decode(wrongClass, 0, wrongClass.length)).to.equal(undefined);
  });
});

describe('ReadRangeAcknowledge', () => {
  const encodeAcknowledge = (applicationData, itemCount = 1, requestType = baEnum.ReadRangeType.BY_POSITION, firstSequence = 2) => {
    const buffer = utils.getBuffer();
    baServices.readRange.encodeAcknowledge(buffer, {type: 12, instance: 500}, 5048, baEnum.ASN1_ARRAY_ALL, {bitsUsed: 3, value: [5]}, itemCount, applicationData, requestType, firstSequence);
    return Buffer.from(buffer.buffer.subarray(0, buffer.offset));
  };

  it('should successfully encode and decode', () => {
    const applicationData = Buffer.from([0x21, 0x01, 0x21, 0x02]);
    const encoded = encodeAcknowledge(applicationData, 2, baEnum.ReadRangeType.BY_SEQUENCE_NUMBER, 7);
    const result = baServices.readRange.decodeAcknowledge(encoded, 0, encoded.length);
    delete result.len;
    expect(result).to.deep.equal({
      objectId: {type: 12, instance: 500},
      itemCount: 2,
      property: {id: 5048, index: 0xFFFFFFFF},
      resultFlag: {bitsUsed: 3, value: [5]},
      rangeBuffer: applicationData,
      firstSequence: 7
    });
  });

  [
    {name: 'OCTET STRING', data: Buffer.from([0x63, 0x11, 0x5F, 0x22])},
    {name: 'CharacterString', data: Buffer.from([0x72, baEnum.CharacterStringEncoding.ISO_8859_1, 0x5F])},
    {name: 'context primitive', data: Buffer.from([0x59, 0x5F])},
    {name: 'nested constructed value', data: Buffer.from([0x1E, 0x63, 0x11, 0x5F, 0x22, 0x1F])}
  ].forEach((testCase) => {
    it(`does not mistake 0x5f inside ${testCase.name} data for the range closing tag`, () => {
      const encoded = encodeAcknowledge(testCase.data);
      const result = baServices.readRange.decodeAcknowledge(encoded, 0, encoded.length);

      expect(result.len).to.equal(encoded.length);
      expect(result.rangeBuffer).to.deep.equal(testCase.data);
    });
  });

  it('returns an owned copy of the range data', () => {
    const encoded = encodeAcknowledge(Buffer.from([0x21, 0x2A]));
    const result = baServices.readRange.decodeAcknowledge(encoded, 0, encoded.length);
    encoded.fill(0);

    expect(result.rangeBuffer).to.deep.equal(Buffer.from([0x21, 0x2A]));
  });

  it('honors offsets and does not inspect outside the declared window', () => {
    const encoded = encodeAcknowledge(Buffer.from([0x21, 0x2A]));
    const wrapped = Buffer.concat([Buffer.from([0xAA, 0xBB]), encoded, Buffer.from([0xCC, 0xDD])]);

    expect(baServices.readRange.decodeAcknowledge(wrapped, 2, encoded.length)).to.include({len: encoded.length, itemCount: 1});
    expect(baServices.readRange.decodeAcknowledge(wrapped, 2, encoded.length - 1)).to.equal(undefined);
    expect(baServices.readRange.decodeAcknowledge(wrapped, 2, encoded.length + 1)).to.equal(undefined);
  });

  it('rejects every truncation of a valid acknowledgment without throwing', () => {
    const encoded = encodeAcknowledge(Buffer.from([0x21, 0x2A]), 1, baEnum.ReadRangeType.BY_SEQUENCE_NUMBER, 9);
    const acknowledgmentWithoutOptionalSequence = encoded.length - 2;
    for (let length = 0; length < encoded.length; length++) {
      const decode = () => baServices.readRange.decodeAcknowledge(encoded, 0, length);
      expect(decode).not.to.throw();
      if (length === acknowledgmentWithoutOptionalSequence) {
        expect(decode()).to.include({len: length, itemCount: 1});
      } else {
        expect(decode()).to.equal(undefined);
      }
    }
  });

  it('rejects mismatched nested tags and invalid item-count payload combinations', () => {
    const mismatched = encodeAcknowledge(Buffer.from([0x1E, 0x21, 0x01, 0x2F]));
    expect(baServices.readRange.decodeAcknowledge(mismatched, 0, mismatched.length)).to.equal(undefined);

    const emptyWithItems = encodeAcknowledge(Buffer.alloc(0), 1);
    expect(baServices.readRange.decodeAcknowledge(emptyWithItems, 0, emptyWithItems.length)).to.equal(undefined);
  });

  it('requires exactly three result flag bits on encode and decode', () => {
    const invalid = encodeAcknowledge(Buffer.from([0x21, 0x2A]));
    const flagTag = invalid.indexOf(0x3A);
    invalid[flagTag + 1] = 4;
    expect(baServices.readRange.decodeAcknowledge(invalid, 0, invalid.length)).to.equal(undefined);

    [{bitsUsed: 4, value: [5]}, {bitsUsed: 3, value: [5, 1]}].forEach((resultFlags) => {
      const buffer = utils.getBuffer();
      expect(() => baServices.readRange.encodeAcknowledge(
        buffer,
        {type: 12, instance: 500},
        5048,
        baEnum.ASN1_ARRAY_ALL,
        resultFlags,
        1,
        Buffer.from([0x21, 0x2A]),
        baEnum.ReadRangeType.BY_POSITION,
        2
      )).to.throw(RangeError);
      expect(buffer.offset).to.equal(0);
    });
  });
});
