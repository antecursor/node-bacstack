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
    it('preserves tag metadata for 16-bit and 32-bit extended lengths', () => {
      expect(baAsn1.decodeTagNumberAndValue(
        Buffer.from([0x75, 0xFE, 0x00, 0xFE]),
        0,
        4
      )).to.deep.equal({len: 4, tagNumber: baEnum.ApplicationTags.CHARACTER_STRING, value: 254});
      expect(baAsn1.decodeTagNumberAndValue(
        Buffer.from([0x75, 0xFF, 0x00, 0x01, 0x00, 0x00]),
        0,
        6
      )).to.deep.equal({len: 6, tagNumber: baEnum.ApplicationTags.CHARACTER_STRING, value: 65536});
    });

    it('requires context class for opening and closing tag matches', () => {
      expect(baAsn1.decodeIsOpeningTagNumber(Buffer.from([0x0E]), 0, 0)).to.equal(true);
      expect(baAsn1.decodeIsClosingTagNumber(Buffer.from([0x0F]), 0, 0)).to.equal(true);
      expect(baAsn1.decodeIsOpeningTagNumber(Buffer.from([0x06]), 0, 0)).to.equal(false);
      expect(baAsn1.decodeIsClosingTagNumber(Buffer.from([0x07]), 0, 0)).to.equal(false);
    });

    it('round-trips a CharacterString whose tag uses a 16-bit extended length', () => {
      const writer = utils.getBuffer();
      const value = 'A'.repeat(253);
      baAsn1.encodeApplicationCharacterString(writer, value);
      const encoded = Buffer.from(writer.buffer.subarray(0, writer.offset));

      expect(encoded.subarray(0, 4)).to.deep.equal(Buffer.from([0x75, 0xFE, 0x00, 0xFE]));
      expect(baAsn1.bacappDecodeApplicationData(
        encoded,
        0,
        encoded.length,
        baEnum.ASN1_MAX_OBJECT_TYPE,
        baEnum.ASN1_MAX_PROPERTY_ID
      )).to.deep.equal({
        len: encoded.length,
        type: baEnum.ApplicationTags.CHARACTER_STRING,
        value: value,
        encoding: baEnum.CharacterStringEncoding.UTF_8
      });
    });

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

    it('rejects invalid BACnet date and time fields instead of normalizing them', () => {
      [
        [126, 0, 18, 6],
        [126, 2, 30, 1],
        [126, 7, 18, 0],
        [0xFF, 7, 18, 6]
      ].forEach((value) => expect(baAsn1.decodeDate(Buffer.from(value), 0)).to.equal(undefined));
      [
        [24, 0, 0, 0],
        [0, 60, 0, 0],
        [0, 0, 60, 0],
        [0, 0, 0, 100],
        [0xFF, 0, 0, 0]
      ].forEach((value) => expect(baAsn1.decodeBacnetTime(Buffer.from(value), 0)).to.equal(undefined));

      expect(baAsn1.decodeDate(Buffer.from([126, 7, 18, 0xFF]), 0)).to.have.nested.property(
        'value.getFullYear'
      );
      expect(baAsn1.decodeDate(Buffer.alloc(4, 0xFF), 0)).to.have.property('len', 4);
      expect(baAsn1.decodeBacnetTime(Buffer.alloc(4, 0xFF), 0)).to.have.property('len', 4);
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

    [
      {name: 'null', value: {type: baEnum.ApplicationTags.NULL, value: null}},
      {name: 'Boolean', value: {type: baEnum.ApplicationTags.BOOLEAN, value: true}},
      {name: 'unsigned integer', value: {type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 0x12345678}},
      {name: 'signed integer', value: {type: baEnum.ApplicationTags.SIGNED_INTEGER, value: -0x123456}},
      {name: 'real', value: {type: baEnum.ApplicationTags.REAL, value: 1.25}},
      {name: 'double', value: {type: baEnum.ApplicationTags.DOUBLE, value: Math.PI}},
      {name: 'octet string', value: {type: baEnum.ApplicationTags.OCTET_STRING, value: [1, 2, 3, 4, 5]}},
      {name: 'character string', value: {type: baEnum.ApplicationTags.CHARACTER_STRING, value: 'bounded'}},
      {name: 'bit string', value: {type: baEnum.ApplicationTags.BIT_STRING, value: {bitsUsed: 9, value: [0xAA, 0x01]}}},
      {name: 'enumerated', value: {type: baEnum.ApplicationTags.ENUMERATED, value: 0x1234}},
      {name: 'date', value: {type: baEnum.ApplicationTags.DATE, value: new Date(2026, 6, 18)}},
      {name: 'time', value: {type: baEnum.ApplicationTags.TIME, value: new Date(2026, 6, 18, 12, 34, 56, 780)}},
      {name: 'object identifier', value: {type: baEnum.ApplicationTags.OBJECTIDENTIFIER, value: {type: 8, instance: 1234}}}
    ].forEach((testCase) => {
      it(`honors every declared maxOffset prefix for application ${testCase.name}`, () => {
        const writer = utils.getBuffer();
        baAsn1.bacappEncodeApplicationData(writer, testCase.value);
        const encoded = Buffer.from(writer.buffer.subarray(0, writer.offset));
        const displaced = Buffer.concat([Buffer.from([0xAA]), encoded, Buffer.alloc(16, 0x55)]);

        for (let prefixLength = 0; prefixLength < encoded.length; prefixLength++) {
          const before = Buffer.from(displaced);
          const result = baAsn1.bacappDecodeApplicationData(
            displaced,
            1,
            1 + prefixLength,
            baEnum.ASN1_MAX_OBJECT_TYPE,
            baEnum.ASN1_MAX_PROPERTY_ID
          );
          expect(result, `${testCase.name} prefix ${prefixLength}`).to.equal(undefined);
          expect(displaced.equals(before), `${testCase.name} prefix ${prefixLength} input mutation`).to.equal(true);
        }

        const result = baAsn1.bacappDecodeApplicationData(
          displaced,
          1,
          1 + encoded.length,
          baEnum.ASN1_MAX_OBJECT_TYPE,
          baEnum.ASN1_MAX_PROPERTY_ID
        );
        expect(result).to.include({len: encoded.length, type: testCase.value.type});
      });
    });

    it('returns an owned Buffer for context-specific fallback data', () => {
      const input = Buffer.from([0xD9, 0x42]);
      const result = baAsn1.bacappDecodeApplicationData(
        input,
        0,
        input.length,
        baEnum.ASN1_MAX_OBJECT_TYPE,
        baEnum.ASN1_MAX_PROPERTY_ID
      );
      expect(result.value.value).to.deep.equal(Buffer.from([0x42]));

      input[1] = 0x24;
      expect(result.value.value).to.deep.equal(Buffer.from([0x42]));
      result.value.value[0] = 0x18;
      expect(input[1]).to.equal(0x24);
    });
  });

  describe('CharacterString interoperability', () => {
    const decode = (hex) => {
      const buffer = Buffer.from(hex, 'hex');
      return baAsn1.decodeCharacterString(buffer, 0, buffer.length, buffer.length);
    };

    [
      {name: 'UTF-8', hex: '00e282ac', value: '€', encoding: baEnum.CharacterStringEncoding.UTF_8},
      {name: 'ISO-8859-1', hex: '05e4f6fc', value: 'äöü', encoding: baEnum.CharacterStringEncoding.ISO_8859_1},
      {name: 'UCS-2 big-endian', hex: '04004103a9', value: 'AΩ', encoding: baEnum.CharacterStringEncoding.UCS_2},
      {name: 'UCS-2 big-endian BOM', hex: '04feff004103a9', value: 'AΩ', encoding: baEnum.CharacterStringEncoding.UCS_2},
      {name: 'UCS-4 network byte order', hex: '03000000410001f600', value: 'A😀', encoding: baEnum.CharacterStringEncoding.UCS_4},
      {name: 'JIS X 0208 row/cell', hex: '022447242d245e2439', value: 'できます', encoding: baEnum.CharacterStringEncoding.JIS_X_0208}
    ].forEach((testCase) => {
      it(`decodes the independent ${testCase.name} vector`, () => {
        expect(decode(testCase.hex)).to.deep.equal({
          value: testCase.value,
          len: Buffer.from(testCase.hex, 'hex').length,
          encoding: testCase.encoding
        });
      });
    });

    [
      {name: 'overlong UTF-8', hex: '00c0af'},
      {name: 'odd-length UCS-2', hex: '04004100'},
      {name: 'little-endian UCS-2 BOM', hex: '04fffe4100a903'},
      {name: 'UCS-2 surrogate', hex: '04d800'},
      {name: 'short UCS-4', hex: '03000000'},
      {name: 'out-of-range UCS-4', hex: '0300110000'},
      {name: 'Shift-JIS mislabeled as JIS X 0208', hex: '0282c582ab82dc82b7'},
      {name: 'odd-length JIS X 0208', hex: '0224'},
      {name: 'non-row/cell JIS X 0208', hex: '022420'},
      {name: 'vendor-extension JIS row', hex: '022d21'},
      {name: 'half-width Shift-JIS mislabeled as JIS X 0208', hex: '02b1b1'},
      {name: 'Microsoft DBCS without a code-page identifier', hex: '0141'},
      {name: 'unknown encoding identifier', hex: '0641'}
    ].forEach((testCase) => {
      it(`rejects ${testCase.name}`, () => {
        expect(decode(testCase.hex)).to.equal(undefined);
      });
    });

    [
      {name: 'UTF-8', value: '€', encoding: baEnum.CharacterStringEncoding.UTF_8, hex: '7400e282ac'},
      {name: 'ISO-8859-1', value: 'ä', encoding: baEnum.CharacterStringEncoding.ISO_8859_1, hex: '7205e4'},
      {name: 'UCS-2', value: 'AΩ', encoding: baEnum.CharacterStringEncoding.UCS_2, hex: '750504004103a9'},
      {name: 'UCS-4', value: 'A😀', encoding: baEnum.CharacterStringEncoding.UCS_4, hex: '750903000000410001f600'},
      {name: 'JIS X 0208', value: 'できます', encoding: baEnum.CharacterStringEncoding.JIS_X_0208, hex: '7509022447242d245e2439'}
    ].forEach((testCase) => {
      it(`encodes the independent ${testCase.name} vector`, () => {
        const buffer = utils.getBuffer();
        baAsn1.encodeApplicationCharacterString(buffer, testCase.value, testCase.encoding);
        expect(buffer.buffer.subarray(0, buffer.offset)).to.deep.equal(Buffer.from(testCase.hex, 'hex'));
      });
    });

    it('rejects the installation-specific Microsoft DBCS identifier when encoding', () => {
      const buffer = utils.getBuffer();
      const encode = () => baAsn1.encodeApplicationCharacterString(buffer, 'test', baEnum.CharacterStringEncoding.MICROSOFT_DBCS);
      expect(encode).to.throw().with.property('code', 'ERR_UNSUPPORTED_CHARACTER_STRING_ENCODING');
    });

    [
      {name: 'ASCII shortcut', value: 'A'},
      {name: 'half-width kana', value: 'ｱ'},
      {name: 'vendor extension', value: '①'}
    ].forEach((testCase) => {
      it(`rejects ${testCase.name} outside the JIS X 0208 row/cell repertoire`, () => {
        const buffer = utils.getBuffer();
        expect(() => baAsn1.encodeApplicationCharacterString(
          buffer,
          testCase.value,
          baEnum.CharacterStringEncoding.JIS_X_0208
        )).to.throw(TypeError, 'Value cannot be represented as JIS X 0208');
      });
    });

    [
      {
        name: 'application',
        encode: (buffer) => baAsn1.encodeApplicationCharacterString(buffer, 'ABC')
      },
      {
        name: 'context',
        encode: (buffer) => baAsn1.encodeContextCharacterString(buffer, 2, 'ABC')
      }
    ].forEach((testCase) => {
      it(`preflights the ${testCase.name} destination before writing a CharacterString`, () => {
        const buffer = {buffer: Buffer.alloc(4, 0xA5), offset: 1};
        const before = Buffer.from(buffer.buffer);
        expect(() => testCase.encode(buffer)).to.throw(RangeError, 'BACnet CharacterString exceeds the encode buffer');
        expect(buffer.offset).to.equal(1);
        expect(buffer.buffer).to.deep.equal(before);
      });
    });

    it('rejects an oversized UCS-4 value before allocating relative to a small destination', () => {
      const buffer = {buffer: Buffer.alloc(8, 0xA5), offset: 0};
      const before = Buffer.from(buffer.buffer);
      const originalAlloc = Buffer.alloc;
      let madeOversizedAllocation = false;
      Buffer.alloc = (size, ...args) => {
        if (size > buffer.buffer.length) madeOversizedAllocation = true;
        return originalAlloc(size, ...args);
      };
      try {
        expect(() => baAsn1.encodeApplicationCharacterString(
          buffer,
          '😀'.repeat(4096),
          baEnum.CharacterStringEncoding.UCS_4
        )).to.throw(RangeError, 'BACnet CharacterString exceeds the encode buffer');
      } finally {
        Buffer.alloc = originalAlloc;
      }
      expect(madeOversizedAllocation).to.equal(false);
      expect(buffer.offset).to.equal(0);
      expect(buffer.buffer).to.deep.equal(before);
    });
  });

  describe('application Boolean validation', () => {
    const decode = (byte) => baAsn1.bacappDecodeApplicationData(
      Buffer.from([byte]),
      0,
      1,
      baEnum.ASN1_MAX_OBJECT_TYPE,
      baEnum.ASN1_MAX_PROPERTY_ID
    );

    it('accepts only LVT zero and one', () => {
      expect(decode(0x10)).to.include({len: 1, value: false});
      expect(decode(0x11)).to.include({len: 1, value: true});
      expect(decode(0x12)).to.equal(undefined);
      expect(decode(0x15)).to.equal(undefined);
    });
  });
});
