'use strict';

const expect      = require('chai').expect;
const utils       = require('./utils');
const baAsn1      = require('../../lib/asn1');
const baEnum      = require('../../lib/enum');

describe('bacstack - ASN1 layer', () => {
  describe('decodeUnsigned', () => {
    it('should fail if unsuport length', () => {
      const result = baAsn1.decodeUnsigned(Buffer.from([0xFF, 0xFF]), 0, 5);
      expect(result).to.deep.equal({len: 5, value: NaN});
    });

    it('should successfully decode 8-bit unsigned integer', () => {
      const result = baAsn1.decodeUnsigned(Buffer.from([0x00, 0xFF, 0xFF, 0xFF, 0xFF]), 1, 1);
      expect(result).to.deep.equal({len: 1, value: 255});
    });

    it('should successfully decode 16-bit unsigned integer', () => {
      const result = baAsn1.decodeUnsigned(Buffer.from([0x00, 0xFF, 0xFF, 0xFF, 0xFF]), 1, 2);
      expect(result).to.deep.equal({len: 2, value: 65535});
    });

    it('should successfully decode 24-bit unsigned integer', () => {
      const result = baAsn1.decodeUnsigned(Buffer.from([0x00, 0xFF, 0xFF, 0xFF, 0xFF]), 1, 3);
      expect(result).to.deep.equal({len: 3, value: 16777215});
    });

    it('should successfully decode 32-bit unsigned integer', () => {
      const result = baAsn1.decodeUnsigned(Buffer.from([0x00, 0xFF, 0xFF, 0xFF, 0xFF]), 1, 4);
      expect(result).to.deep.equal({len: 4, value: 4294967295});
    });
  });

  describe('malformed input bounds', () => {
    it('should reject an octet string length larger than the available buffer', () => {
      const result = baAsn1.decodeOctetString(Buffer.from([0x01]), 0, Number.MAX_SAFE_INTEGER, 0, 0xFFFFFFFF);
      expect(result).to.equal(undefined);
    });

    it('should reject an application bit string larger than the supported limit', () => {
      const buffer = Buffer.from([0x85, 17, ...new Array(17).fill(0)]);
      const result = baAsn1.bacappDecodeApplicationData(
        buffer,
        0,
        buffer.length,
        baEnum.ASN1_MAX_OBJECT_TYPE,
        baEnum.ASN1_MAX_PROPERTY_ID
      );
      expect(result).to.equal(undefined);
    });

    it('should return undefined for truncated primitive values', () => {
      expect(baAsn1.decodeSigned(Buffer.from([0x01]), 0, 2)).to.equal(undefined);
      expect(baAsn1.decodeReal(Buffer.alloc(3), 0)).to.equal(undefined);
      expect(baAsn1.decodeCharacterString(Buffer.from([0x00, 0x41]), 0, 2, 3)).to.equal(undefined);
      expect(baAsn1.decodeDate(Buffer.alloc(3), 0)).to.equal(undefined);
      expect(baAsn1.decodeBacnetTime(Buffer.alloc(3), 0)).to.equal(undefined);
      expect(baAsn1.decodeObjectId(Buffer.alloc(3), 0)).to.equal(undefined);
      expect(baAsn1.decodeBitstring(Buffer.from([0]), 0, 2)).to.equal(undefined);
    });

    [
      {name: 'signed integer', bytes: [0x32, 0x01]},
      {name: 'real', bytes: [0x44, 0x00, 0x00, 0x00]},
      {name: 'double', bytes: [0x55, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]},
      {name: 'character string', bytes: [0x73, 0x00, 0x41]},
      {name: 'date', bytes: [0xA4, 0x7C, 0x01, 0x01]},
      {name: 'time', bytes: [0xB4, 0x00, 0x00, 0x00]}
    ].forEach((testCase) => {
      it(`should reject a truncated application ${testCase.name}`, () => {
        const buffer = Buffer.from(testCase.bytes);
        const result = baAsn1.bacappDecodeApplicationData(buffer, 0, buffer.length, baEnum.ASN1_MAX_OBJECT_TYPE, baEnum.ASN1_MAX_PROPERTY_ID);
        expect(result).to.equal(undefined);
      });
    });

    it('should reject excessive context nesting without overflowing the call stack', () => {
      const buffer = Buffer.alloc(10000, 0x0E);
      const decode = () => baAsn1.bacappDecodeApplicationData(buffer, 0, buffer.length, baEnum.ASN1_MAX_OBJECT_TYPE, baEnum.ASN1_MAX_PROPERTY_ID);
      expect(decode).not.to.throw();
      expect(decode()).to.equal(undefined);
    });

    it('should decode a context datetime timestamp without producing an invalid date', () => {
      const buffer = utils.getBuffer();
      const timestamp = new Date(2026, 6, 18, 14, 35, 27, 420);
      baAsn1.bacappEncodeTimestamp(buffer, {type: baEnum.TimeStamp.DATETIME, value: timestamp});

      const result = baAsn1.bacappDecodeApplicationData(
        buffer.buffer,
        0,
        buffer.offset,
        baEnum.ASN1_MAX_OBJECT_TYPE,
        baEnum.PropertyIdentifier.EVENT_TIME_STAMPS
      );

      expect(result.value).to.deep.equal(timestamp);
    });
  });
});
