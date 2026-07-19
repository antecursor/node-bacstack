'use strict';

const expect = require('chai').expect;
const baAsn1 = require('../../lib/asn1');
const baEnum = require('../../lib/enum');
const utils = require('./utils');

const UNKNOWN_OBJECT_TYPE = baEnum.ASN1_MAX_OBJECT_TYPE;
const UNKNOWN_PROPERTY_ID = baEnum.ASN1_MAX_PROPERTY_ID;
const DISPLACEMENT = Buffer.from([0xAA, 0x55, 0xC3]);
const TRAILING_BYTES = Buffer.from([0x5A, 0xA5, 0x3C, 0xC3]);

const encode = (callback) => {
  const writer = utils.getBuffer();
  callback(writer);
  return Buffer.from(writer.buffer.subarray(0, writer.offset));
};

const decode = (buffer, offset, maxOffset, propertyId, objectType = UNKNOWN_OBJECT_TYPE) =>
  baAsn1.bacappDecodeApplicationData(buffer, offset, maxOffset, objectType, propertyId);

const placeInLargerBuffer = (encoded) => ({
  buffer: Buffer.concat([DISPLACEMENT, encoded, TRAILING_BYTES]),
  offset: DISPLACEMENT.length,
  maxOffset: DISPLACEMENT.length + encoded.length
});

const decodeExactlyAtDisplacedOffset = (encoded, propertyId, objectType) => {
  const placed = placeInLargerBuffer(encoded);
  const before = Buffer.from(placed.buffer);
  const result = decode(
    placed.buffer,
    placed.offset,
    placed.maxOffset,
    propertyId,
    objectType
  );

  expect(result).not.to.equal(undefined);
  expect(result.len).to.equal(encoded.length);
  expect(result.len).to.be.at.most(placed.maxOffset - placed.offset);
  expect(placed.buffer.equals(before)).to.equal(true);
  return {result, ...placed};
};

const expectEveryIncompletePrefixRejected = (encoded, propertyId, objectType) => {
  const placed = placeInLargerBuffer(encoded);
  for (let prefixLength = 0; prefixLength < encoded.length; prefixLength++) {
    const before = Buffer.from(placed.buffer);
    const result = decode(
      placed.buffer,
      placed.offset,
      placed.offset + prefixLength,
      propertyId,
      objectType
    );
    expect(result, `declared prefix ${prefixLength}/${encoded.length}`).to.equal(undefined);
    expect(
      placed.buffer.equals(before),
      `input mutation at declared prefix ${prefixLength}/${encoded.length}`
    ).to.equal(true);
  }
};

const expectRejected = (encoded, propertyId, label, objectType) => {
  const placed = placeInLargerBuffer(encoded);
  const before = Buffer.from(placed.buffer);
  const result = decode(
    placed.buffer,
    placed.offset,
    placed.maxOffset,
    propertyId,
    objectType
  );
  expect(result, label).to.equal(undefined);
  expect(placed.buffer.equals(before), `${label} input mutation`).to.equal(true);
};

const encodeCovSubscription = (value) => encode((writer) => {
  baAsn1.bacappEncodeApplicationData(writer, {
    type: baEnum.ApplicationTags.COV_SUBSCRIPTION,
    value: value
  });
});

const encodeObjectPropertyReference = (value) => {
  const wrapped = encode((writer) => {
    baAsn1.bacappEncodeContextDeviceObjPropertyRef(writer, 9, value);
  });
  expect(wrapped[0]).to.equal(0x9E);
  expect(wrapped[wrapped.length - 1]).to.equal(0x9F);
  return Buffer.from(wrapped.subarray(1, wrapped.length - 1));
};

const encodeApplicationDate = (value) => encode((writer) => {
  baAsn1.encodeApplicationDate(writer, value);
});

const encodeCalendarDate = (value) => Buffer.concat([
  Buffer.from([0x0C]),
  encodeApplicationDate(value).subarray(1)
]);

const encodeCalendarDateRange = (startDate, endDate) => Buffer.concat([
  Buffer.from([0x1E]),
  encodeApplicationDate(startDate),
  encodeApplicationDate(endDate),
  Buffer.from([0x1F])
]);

const encodeTimestamp = (value) => encode((writer) => {
  baAsn1.bacappEncodeTimestamp(writer, value);
});

describe('bacstack - ASN1 special property decoders', () => {
  describe('ACTIVE_COV_SUBSCRIPTIONS', () => {
    const propertyId = baEnum.PropertyIdentifier.ACTIVE_COV_SUBSCRIPTIONS;
    const fullValue = {
      recipient: {network: 5, address: [0xAA, 0xBB, 0xCC]},
      subscriptionProcessId: 9,
      monitoredObjectId: {type: baEnum.ObjectType.ANALOG_INPUT, instance: 42},
      monitoredProperty: {id: baEnum.PropertyIdentifier.PRESENT_VALUE, index: 3},
      issueConfirmedNotifications: true,
      timeRemaining: 300,
      covIncrement: 1.5
    };

    it('decodes the complete canonical shape, including optional fields and owned address data', () => {
      const encoded = encodeCovSubscription(fullValue);
      const decoded = decodeExactlyAtDisplacedOffset(encoded, propertyId);
      const expected = {
        recipient: {net: 5, adr: [0xAA, 0xBB, 0xCC]},
        subscriptionProcessId: 9,
        monitoredObjectId: {type: baEnum.ObjectType.ANALOG_INPUT, instance: 42},
        monitoredProperty: {id: baEnum.PropertyIdentifier.PRESENT_VALUE, index: 3},
        issueConfirmedNotifications: true,
        timeRemaining: 300,
        covIncrement: 1.5
      };

      expect(decoded.result).to.deep.equal({
        len: encoded.length,
        type: baEnum.ApplicationTags.COV_SUBSCRIPTION,
        value: expected
      });

      const before = Buffer.from(decoded.buffer);
      decoded.result.value.recipient.adr[0] = 0x11;
      expect(decoded.buffer.equals(before)).to.equal(true);
      decoded.buffer.fill(0, decoded.offset, decoded.maxOffset);
      expect(decoded.result.value.recipient.adr).to.deep.equal([0x11, 0xBB, 0xCC]);
    });

    it('rejects every incomplete prefix of the mandatory canonical form', () => {
      const encoded = encodeCovSubscription({
        recipient: {network: 0xFFFF, address: []},
        subscriptionProcessId: 1,
        monitoredObjectId: {type: baEnum.ObjectType.BINARY_INPUT, instance: 7},
        monitoredProperty: {
          id: baEnum.PropertyIdentifier.OBJECT_NAME,
          index: baEnum.ASN1_ARRAY_ALL
        },
        issueConfirmedNotifications: false,
        timeRemaining: 1,
        covIncrement: 0
      });

      expectEveryIncompletePrefixRejected(encoded, propertyId);
      expect(decodeExactlyAtDisplacedOffset(encoded, propertyId).result.value).to.deep.equal({
        recipient: {net: 0xFFFF, adr: []},
        subscriptionProcessId: 1,
        monitoredObjectId: {type: baEnum.ObjectType.BINARY_INPUT, instance: 7},
        monitoredProperty: {
          id: baEnum.PropertyIdentifier.OBJECT_NAME,
          index: baEnum.ASN1_ARRAY_ALL
        },
        issueConfirmedNotifications: false,
        timeRemaining: 1
      });
    });

    it('rejects wrong-class, closing, mismatched, and invalid Boolean forms', () => {
      const encoded = encodeCovSubscription(fullValue);
      const wrongClass = Buffer.from(encoded);
      wrongClass[1] = 0x06;

      const mismatchedClose = Buffer.from(encoded);
      mismatchedClose[mismatchedClose.indexOf(0x1F)] = 0x2F;

      const invalidBoolean = Buffer.from(encoded);
      const booleanHeader = invalidBoolean.indexOf(Buffer.from([0x29, 0x01]));
      invalidBoolean[booleanHeader + 1] = 2;

      [
        {name: 'wrong-class nested opener', value: wrongClass},
        {name: 'standalone closing tag', value: Buffer.from([0x0F])},
        {name: 'mismatched constructed close', value: mismatchedClose},
        {name: 'non-binary context Boolean', value: invalidBoolean}
      ].forEach((testCase) => {
        expectRejected(testCase.value, propertyId, testCase.name);
      });
    });
  });

  describe('OBJECT_PROPERTY_REFERENCE', () => {
    const propertyId = baEnum.PropertyIdentifier.OBJECT_PROPERTY_REFERENCE;
    const fullValue = {
      objectId: {type: baEnum.ObjectType.ANALOG_VALUE, instance: 99},
      id: baEnum.PropertyIdentifier.PRESENT_VALUE,
      arrayIndex: 7,
      deviceIndentifier: {type: baEnum.ObjectType.DEVICE, instance: 123}
    };

    it('decodes the complete canonical compatibility shape', () => {
      const encoded = encodeObjectPropertyReference(fullValue);
      const decoded = decodeExactlyAtDisplacedOffset(encoded, propertyId);

      expect(decoded.result).to.deep.equal({
        len: encoded.length,
        type: baEnum.ApplicationTags.OBJECT_PROPERTY_REFERENCE,
        value: fullValue
      });
    });

    it('defaults the array index and rejects every incomplete mandatory prefix', () => {
      const encoded = encodeObjectPropertyReference({
        objectId: {type: baEnum.ObjectType.BINARY_VALUE, instance: 12},
        id: baEnum.PropertyIdentifier.OBJECT_NAME,
        arrayIndex: baEnum.ASN1_ARRAY_ALL
      });

      expectEveryIncompletePrefixRejected(encoded, propertyId);
      expect(decodeExactlyAtDisplacedOffset(encoded, propertyId).result.value).to.deep.equal({
        objectId: {type: baEnum.ObjectType.BINARY_VALUE, instance: 12},
        id: baEnum.PropertyIdentifier.OBJECT_NAME,
        arrayIndex: baEnum.ASN1_ARRAY_ALL
      });
    });

    it('rejects wrong-class fields, closing tags, and non-device identifiers', () => {
      const minimal = encodeObjectPropertyReference({
        objectId: {type: baEnum.ObjectType.BINARY_VALUE, instance: 12},
        id: baEnum.PropertyIdentifier.OBJECT_NAME,
        arrayIndex: baEnum.ASN1_ARRAY_ALL
      });
      const wrongClassProperty = Buffer.from(minimal);
      wrongClassProperty[5] = 0x91;

      const closingInsteadOfProperty = Buffer.concat([
        minimal.subarray(0, 5),
        Buffer.from([0x1F])
      ]);

      const invalidDevice = encodeObjectPropertyReference(fullValue);
      const deviceHeader = invalidDevice.lastIndexOf(0x3C);
      invalidDevice[deviceHeader + 1] = 0;

      [
        {name: 'wrong-class property identifier', value: wrongClassProperty},
        {name: 'closing tag instead of property identifier', value: closingInsteadOfProperty},
        {name: 'standalone closing tag', value: Buffer.from([0x0F])},
        {name: 'non-device optional device identifier', value: invalidDevice}
      ].forEach((testCase) => {
        expectRejected(testCase.value, propertyId, testCase.name);
      });
    });
  });

  describe('DATE_LIST', () => {
    const propertyId = baEnum.PropertyIdentifier.DATE_LIST;
    const singleDate = new Date(2026, 6, 18);
    const rangeStart = new Date(2026, 6, 20);
    const rangeEnd = new Date(2026, 6, 25);

    it('decodes calendar dates, date ranges, and week-and-day entries with their live shapes', () => {
      const encoded = Buffer.concat([
        encodeCalendarDate(singleDate),
        encodeCalendarDateRange(rangeStart, rangeEnd),
        Buffer.from([0x2B, 12, 5, 7])
      ]);
      const decoded = decodeExactlyAtDisplacedOffset(encoded, propertyId);

      expect(decoded.result).to.deep.equal({
        len: encoded.length,
        type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_DECODED,
        value: [
          {len: 4, year: 126, month: 7, day: 18, wday: 6},
          {
            len: 11,
            startDate: {len: 4, value: rangeStart},
            endDate: {len: 4, value: rangeEnd}
          },
          {len: 3, month: 12, week: 5, wday: 7}
        ]
      });

      decoded.buffer.fill(0, decoded.offset, decoded.maxOffset);
      expect(decoded.result.value[1].startDate.value).to.deep.equal(rangeStart);
      expect(decoded.result.value[1].endDate.value).to.deep.equal(rangeEnd);
    });

    it('rejects every incomplete prefix of a constructed date range', () => {
      const encoded = encodeCalendarDateRange(rangeStart, rangeEnd);
      expectEveryIncompletePrefixRejected(encoded, propertyId);
      expect(decodeExactlyAtDisplacedOffset(encoded, propertyId).result.len).to.equal(encoded.length);
    });

    it('rejects wrong-class entries, closing tags, bad lengths, and mismatched ranges', () => {
      const contextDate = encodeCalendarDate(singleDate);
      const wrongClassEntry = Buffer.concat([contextDate, encodeApplicationDate(rangeStart)]);
      const badLength = Buffer.from(contextDate);
      badLength[0] = 0x0B;

      const mismatchedRange = encodeCalendarDateRange(rangeStart, rangeEnd);
      mismatchedRange[mismatchedRange.length - 1] = 0x2F;

      const invalidRangeDate = encodeCalendarDateRange(rangeStart, rangeEnd);
      invalidRangeDate[3] = 13;

      [
        {name: 'application-class entry after a context entry', value: wrongClassEntry},
        {name: 'standalone closing tag', value: Buffer.from([0x0F])},
        {name: 'calendar date with the wrong length', value: badLength},
        {name: 'mismatched date-range close', value: mismatchedRange},
        {name: 'invalid application date in a range', value: invalidRangeDate}
      ].forEach((testCase) => {
        expectRejected(testCase.value, propertyId, testCase.name);
      });
    });
  });

  describe('WEEKLY_SCHEDULE', () => {
    const propertyId = baEnum.PropertyIdentifier.WEEKLY_SCHEDULE;
    const morning = new Date(2026, 0, 1, 6, 7, 8, 90);
    const evening = new Date(2026, 0, 1, 22, 30, 0, 0);
    const schedule = [
      [{time: morning, value: 17}],
      [],
      [],
      [],
      [],
      [],
      [{time: evening, value: 3}]
    ];

    it('decodes all seven canonical weekdays and their application values', () => {
      const encoded = encode((writer) => baAsn1.encodeWeeklySchedule(writer, schedule));
      const decoded = decodeExactlyAtDisplacedOffset(encoded, propertyId);

      expect(decoded.result).to.deep.equal({
        len: encoded.length,
        type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_DECODED,
        value: [
          [{
            time: {len: 4, value: new Date(1, 1, 1, 6, 7, 8, 90)},
            value: {len: 1, type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 17}
          }],
          [],
          [],
          [],
          [],
          [],
          [{
            time: {len: 4, value: new Date(1, 1, 1, 22, 30, 0, 0)},
            value: {len: 1, type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 3}
          }]
        ]
      });

      const firstEventTime = decoded.result.value[0][0].time.value;
      decoded.buffer.fill(0, decoded.offset, decoded.maxOffset);
      expect(firstEventTime).to.deep.equal(new Date(1, 1, 1, 6, 7, 8, 90));
    });

    it('rejects every incomplete prefix, including otherwise complete early weekdays', () => {
      const encoded = encode((writer) => baAsn1.encodeWeeklySchedule(writer, schedule));
      expectEveryIncompletePrefixRejected(encoded, propertyId);
      expect(decodeExactlyAtDisplacedOffset(encoded, propertyId).result.len).to.equal(encoded.length);
    });

    it('rejects wrong-class time/value tags and malformed weekday boundaries', () => {
      const encoded = encode((writer) => baAsn1.encodeWeeklySchedule(writer, schedule));
      const wrongClassTime = Buffer.from(encoded);
      wrongClassTime[wrongClassTime.indexOf(0xB4)] = 0xBC;

      const wrongClassValue = Buffer.from(encoded);
      wrongClassValue[wrongClassValue.indexOf(0x21)] = 0x29;

      const mismatchedDayClose = Buffer.from(encoded);
      mismatchedDayClose[mismatchedDayClose.indexOf(0x0F)] = 0x1F;

      [
        {name: 'standalone weekday close', value: Buffer.from([0x0F])},
        {name: 'context-class time', value: wrongClassTime},
        {name: 'context-class schedule value', value: wrongClassValue},
        {name: 'mismatched weekday close', value: mismatchedDayClose}
      ].forEach((testCase) => {
        expectRejected(testCase.value, propertyId, testCase.name);
      });
    });
  });

  describe('EVENT_TIME_STAMPS', () => {
    const propertyId = baEnum.PropertyIdentifier.EVENT_TIME_STAMPS;
    const timestamp = new Date(2026, 6, 18, 14, 35, 27, 420);
    const cases = [
      {
        name: 'time',
        input: {type: baEnum.TimeStamp.TIME, value: timestamp},
        expectedType: baEnum.ApplicationTags.TIMESTAMP,
        expectedValue: new Date(1, 1, 1, 14, 35, 27, 420)
      },
      {
        name: 'sequence number',
        input: {type: baEnum.TimeStamp.SEQUENCE_NUMBER, value: 300},
        expectedType: baEnum.ApplicationTags.UNSIGNED_INTEGER,
        expectedValue: 300
      },
      {
        name: 'datetime',
        input: {type: baEnum.TimeStamp.DATETIME, value: timestamp},
        expectedType: baEnum.ApplicationTags.TIMESTAMP,
        expectedValue: timestamp
      }
    ];

    cases.forEach((testCase) => {
      it(`decodes the canonical ${testCase.name} shape at a displaced offset`, () => {
        const encoded = encodeTimestamp(testCase.input);
        const result = decodeExactlyAtDisplacedOffset(encoded, propertyId).result;

        expect(result).to.deep.equal({
          len: encoded.length,
          type: testCase.expectedType,
          value: testCase.expectedValue
        });
      });

      it(`rejects every incomplete declared ${testCase.name} prefix`, () => {
        const encoded = encodeTimestamp(testCase.input);
        expectEveryIncompletePrefixRejected(encoded, propertyId);
      });
    });

    it('returns timestamp dates independently of the encoded buffer', () => {
      const encoded = encodeTimestamp({type: baEnum.TimeStamp.DATETIME, value: timestamp});
      const decoded = decodeExactlyAtDisplacedOffset(encoded, propertyId);
      decoded.buffer.fill(0, decoded.offset, decoded.maxOffset);
      expect(decoded.result.value).to.deep.equal(timestamp);
    });

    it('rejects unknown variants, wrong-class members, bad lengths, and closing tags', () => {
      const badTimeLength = encodeTimestamp({type: baEnum.TimeStamp.TIME, value: timestamp});
      badTimeLength[0] = 0x0B;

      const invalidTime = encodeTimestamp({type: baEnum.TimeStamp.TIME, value: timestamp});
      invalidTime[1] = 24;

      const wrongClassDate = encodeTimestamp({type: baEnum.TimeStamp.DATETIME, value: timestamp});
      wrongClassDate[1] = 0xAC;

      const mismatchedDatetimeClose = encodeTimestamp({
        type: baEnum.TimeStamp.DATETIME,
        value: timestamp
      });
      mismatchedDatetimeClose[mismatchedDatetimeClose.length - 1] = 0x1F;

      [
        {name: 'unknown timestamp choice', value: Buffer.from([0x39, 0])},
        {name: 'zero-length sequence number', value: Buffer.from([0x18])},
        {name: 'time with wrong declared length', value: badTimeLength},
        {name: 'time with an invalid hour', value: invalidTime},
        {name: 'context-class date member', value: wrongClassDate},
        {name: 'mismatched datetime close', value: mismatchedDatetimeClose},
        {name: 'standalone closing tag', value: Buffer.from([0x2F])}
      ].forEach((testCase) => {
        expectRejected(testCase.value, propertyId, testCase.name);
      });
    });
  });

  describe('generic context values', () => {
    it('decodes canonical context Booleans using the property tag mapping', () => {
      [false, true].forEach((value) => {
        const encoded = encode((writer) => baAsn1.encodeContextBoolean(writer, 7, value));
        expectEveryIncompletePrefixRejected(encoded, baEnum.PropertyIdentifier.ACTION);
        expect(decodeExactlyAtDisplacedOffset(
          encoded,
          baEnum.PropertyIdentifier.ACTION
        ).result).to.deep.equal({
          len: encoded.length,
          value: {value: value, type: baEnum.ApplicationTags.BOOLEAN},
          type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_DECODED
        });
      });
    });

    it('rejects non-binary, empty, and closing forms of a mapped context Boolean', () => {
      [
        {name: 'non-binary Boolean content', value: Buffer.from([0x79, 2])},
        {name: 'zero-length context Boolean', value: Buffer.from([0x78])},
        {name: 'closing tag in place of a Boolean', value: Buffer.from([0x7F])}
      ].forEach((testCase) => {
        expectRejected(
          testCase.value,
          baEnum.PropertyIdentifier.ACTION,
          testCase.name
        );
      });
    });

    it('preserves an unknown empty context tag and its tag number', () => {
      const encoded = Buffer.from([0xD8]);
      expectEveryIncompletePrefixRejected(encoded, UNKNOWN_PROPERTY_ID);
      const decoded = decodeExactlyAtDisplacedOffset(encoded, UNKNOWN_PROPERTY_ID);

      expect(decoded.result).to.deep.equal({
        len: 1,
        value: {
          value: Buffer.alloc(0),
          type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_ENCODED,
          tagNumber: 13
        },
        type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_DECODED
      });
      expect(Buffer.isBuffer(decoded.result.value.value)).to.equal(true);
      expect(decoded.result.value.value.buffer).not.to.equal(decoded.buffer.buffer);
    });

    it('returns owned data for an unknown non-empty context tag', () => {
      const encoded = Buffer.from([0xD9, 0x42]);
      const decoded = decodeExactlyAtDisplacedOffset(encoded, UNKNOWN_PROPERTY_ID);
      const ownedValue = decoded.result.value.value;
      const before = Buffer.from(decoded.buffer);

      ownedValue[0] = 0x24;
      expect(decoded.buffer.equals(before)).to.equal(true);
      decoded.buffer[decoded.offset + 1] = 0x18;
      expect(ownedValue).to.deep.equal(Buffer.from([0x24]));
    });

    it('rejects truncated, opening-only, and closing unknown context tags', () => {
      [
        {name: 'declared content without content', value: Buffer.from([0xD9])},
        {name: 'opening tag without a close', value: Buffer.from([0xDE])},
        {name: 'standalone close', value: Buffer.from([0xDF])},
        {name: 'truncated extended tag number', value: Buffer.from([0xF8])}
      ].forEach((testCase) => {
        expectRejected(testCase.value, UNKNOWN_PROPERTY_ID, testCase.name);
      });
    });

    it('decodes an extended constructed tag 15 with exact length and owned nested data', () => {
      const encoded = encode((writer) => {
        baAsn1.encodeOpeningTag(writer, 15);
        baAsn1.bacappEncodeApplicationData(writer, {
          type: baEnum.ApplicationTags.UNSIGNED_INTEGER,
          value: 7
        });
        writer.buffer[writer.offset++] = 0xD9;
        writer.buffer[writer.offset++] = 0x42;
        baAsn1.encodeClosingTag(writer, 15);
      });

      expectEveryIncompletePrefixRejected(encoded, UNKNOWN_PROPERTY_ID);
      const decoded = decodeExactlyAtDisplacedOffset(encoded, UNKNOWN_PROPERTY_ID);
      expect(decoded.result).to.deep.equal({
        len: encoded.length,
        value: [
          {value: 7, type: baEnum.ApplicationTags.UNSIGNED_INTEGER},
          {
            value: {
              value: Buffer.from([0x42]),
              type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_ENCODED,
              tagNumber: 13
            },
            type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_DECODED
          }
        ],
        type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_DECODED
      });

      const nestedBuffer = decoded.result.value[1].value.value;
      const before = Buffer.from(decoded.buffer);
      nestedBuffer[0] = 0x24;
      expect(decoded.buffer.equals(before)).to.equal(true);
      decoded.buffer[decoded.offset + 5] = 0x18;
      expect(nestedBuffer).to.deep.equal(Buffer.from([0x24]));
    });

    it('rejects wrong-class, mismatched, and standalone extended constructed tags', () => {
      const wrongClassOpening = Buffer.from([0xF6, 15, 0x21, 7, 0xFF, 15]);
      const mismatchedClosing = Buffer.from([0xFE, 15, 0x21, 7, 0xEF]);
      [
        {name: 'application-class opening form', value: wrongClassOpening},
        {name: 'mismatched closing tag', value: mismatchedClosing},
        {name: 'standalone extended close', value: Buffer.from([0xFF, 15])}
      ].forEach((testCase) => {
        expectRejected(testCase.value, UNKNOWN_PROPERTY_ID, testCase.name);
      });
    });
  });
});
