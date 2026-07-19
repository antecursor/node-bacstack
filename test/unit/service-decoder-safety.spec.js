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

const containsNaN = (value, seen) => {
  if (typeof value === 'number') return Number.isNaN(value);
  if (value instanceof Date) return Number.isNaN(value.getTime());
  if (value == null || typeof value !== 'object' || Buffer.isBuffer(value)) return false;
  const visited = seen || new Set();
  if (visited.has(value)) return false;
  visited.add(value);
  return Object.values(value).some((child) => containsNaN(child, visited));
};

const expectSafeDecode = (label, decode, buffer, length, offset = 0) => {
  const before = Buffer.from(buffer);
  let result;
  expect(() => {
    result = decode(buffer, offset, length);
  }, label).not.to.throw();
  expect(buffer.equals(before), `${label} input mutation`).to.equal(true);
  if (result !== undefined) {
    expect(result, label).to.be.an('object');
    expect(result.len, `${label} len`).to.be.a('number');
    expect(Number.isFinite(result.len), `${label} finite len`).to.equal(true);
    expect(Number.isInteger(result.len), `${label} integer len`).to.equal(true);
    expect(result.len, `${label} nonnegative len`).to.be.at.least(0);
    expect(result.len, `${label} bounded len`).to.be.at.most(length);
    if (length > 0) expect(result.len, `${label} progress`).to.be.greaterThan(0);
    expect(containsNaN(result), `${label} NaN output`).to.equal(false);
  }
  return result;
};

const expectPrefixResult = (testCase, result, length, label) => {
  if (testCase.validPrefixLengths && testCase.validPrefixLengths.includes(length)) {
    expect(result, label).to.include({len: length});
  } else {
    expect(result, label).to.equal(undefined);
  }
};

const expectEveryTruncationRejected = (testCase) => {
  for (let length = 0; length < testCase.payload.length; length++) {
    const prefix = Buffer.from(testCase.payload.subarray(0, length));
    const result = expectSafeDecode(`${testCase.name} prefix ${length}`, testCase.decode, prefix, length);
    expectPrefixResult(testCase, result, length, `${testCase.name} prefix ${length}`);

    const longerBacking = Buffer.concat([testCase.payload, Buffer.from([0xEE])]);
    const boundedResult = expectSafeDecode(
      `${testCase.name} declared prefix ${length}`,
      testCase.decode,
      longerBacking,
      length
    );
    expectPrefixResult(testCase, boundedResult, length, `${testCase.name} declared prefix ${length}`);

    const displaced = Buffer.concat([Buffer.from([0xAA]), testCase.payload, Buffer.from([0xEE])]);
    const displacedResult = expectSafeDecode(
      `${testCase.name} displaced declared prefix ${length}`,
      testCase.decode,
      displaced,
      length,
      1
    );
    expectPrefixResult(
      testCase,
      displacedResult,
      length,
      `${testCase.name} displaced declared prefix ${length}`
    );
  }

  const decoded = expectSafeDecode(testCase.name, testCase.decode, testCase.payload, testCase.payload.length);
  expect(decoded, testCase.name).to.include({len: testCase.payload.length});

  const displaced = Buffer.concat([Buffer.from([0xAA]), testCase.payload, Buffer.from([0xEE])]);
  const displacedDecoded = expectSafeDecode(
    `${testCase.name} displaced full window`,
    testCase.decode,
    displaced,
    testCase.payload.length,
    1
  );
  expect(displacedDecoded, `${testCase.name} displaced full window`).to.include({
    len: testCase.payload.length
  });

  if (testCase.exactWindow) {
    const trailing = Buffer.concat([testCase.payload, Buffer.from([0x00])]);
    const boundedBeforeTrailing = expectSafeDecode(
      `${testCase.name} bounded before trailing byte`,
      testCase.decode,
      trailing,
      testCase.payload.length
    );
    expect(boundedBeforeTrailing, `${testCase.name} bounded before trailing byte`).to.include({
      len: testCase.payload.length
    });
    expect(
      expectSafeDecode(
        `${testCase.name} trailing byte`,
        testCase.decode,
        trailing,
        trailing.length
      ),
      `${testCase.name} trailing byte`
    ).to.equal(undefined);
  }
};

const makeCases = () => {
  const rangeOctets = Buffer.alloc(384);
  for (let index = 0; index < rangeOctets.length; index++) {
    rangeOctets[index] = (index * 73 + 0x5F) & 0xFF;
  }
  const rangeData = encode((buffer) => baAsn1.encodeApplicationOctetString(
    buffer,
    rangeOctets,
    0,
    rangeOctets.length
  ));
  const events = Array.from({length: 8}, (unused, index) => {
    const timestamp = new Date(2024, index % 12, index + 1, 3, 4, 5, index * 10);
    return {
      objectId: {type: baEnum.ObjectType.ANALOG_INPUT, instance: index + 1},
      eventState: index % 6,
      acknowledgedTransitions: {value: [index & 0x07], bitsUsed: 3},
      eventTimeStamps: [
        {value: timestamp, type: baEnum.TimeStamp.DATETIME},
        {value: index + 1, type: baEnum.TimeStamp.SEQUENCE_NUMBER},
        {value: timestamp, type: baEnum.TimeStamp.TIME}
      ],
      notifyType: index % 3,
      eventEnable: {value: [(index + 1) & 0x07], bitsUsed: 3},
      eventPriorities: [index + 1, index + 2, index + 3]
    };
  });
  const readRangeBaseWithoutArrayIndex = encode((buffer) => baServices.readRange.encode(
    buffer,
    {type: baEnum.ObjectType.TREND_LOG, instance: 7},
    baEnum.PropertyIdentifier.LOG_BUFFER,
    baEnum.ASN1_ARRAY_ALL
  ));
  const readRangeBaseRequest = encode((buffer) => baServices.readRange.encode(
    buffer,
    {type: baEnum.ObjectType.TREND_LOG, instance: 7},
    baEnum.PropertyIdentifier.LOG_BUFFER,
    2
  ));
  const readRangeRequest = encode((buffer) => baServices.readRange.encode(
    buffer,
    {type: baEnum.ObjectType.TREND_LOG, instance: 7},
    baEnum.PropertyIdentifier.LOG_BUFFER,
    2,
    baEnum.ReadRangeType.BY_TIME_REFERENCE_TIME_COUNT,
    null,
    new Date(2024, 0, 2, 3, 4, 5, 60),
    -32
  ));
  const readRangeAckWithoutSequence = encode((buffer) => baServices.readRange.encodeAcknowledge(
    buffer,
    {type: baEnum.ObjectType.TREND_LOG, instance: 7},
    baEnum.PropertyIdentifier.LOG_BUFFER,
    2,
    {value: [5], bitsUsed: 3},
    1,
    rangeData,
    baEnum.ReadRangeType.BY_POSITION
  ));
  const readRangeAck = encode((buffer) => baServices.readRange.encodeAcknowledge(
    buffer,
    {type: baEnum.ObjectType.TREND_LOG, instance: 7},
    baEnum.PropertyIdentifier.LOG_BUFFER,
    2,
    {value: [5], bitsUsed: 3},
    1,
    rangeData,
    baEnum.ReadRangeType.BY_SEQUENCE_NUMBER,
    1234
  ));
  const eventNotify = encode((buffer) => baServices.eventNotifyData.encode(buffer, {
    processId: 3,
    initiatingObjectId: {type: baEnum.ObjectType.DEVICE, instance: 12},
    eventObjectId: {type: baEnum.ObjectType.ANALOG_INPUT, instance: 1121},
    timeStamp: {type: baEnum.TimeStamp.DATETIME, value: new Date(2024, 0, 2, 3, 4, 5, 60)},
    notificationClass: 9,
    priority: 7,
    eventType: baEnum.EventType.UNSIGNED_RANGE,
    messageText: 'bounded',
    notifyType: baEnum.NotifyType.EVENT,
    ackRequired: false,
    fromState: baEnum.EventState.NORMAL,
    toState: baEnum.EventState.OFFNORMAL,
    unsignedRangeExceedingValue: 101,
    unsignedRangeStatusFlags: {bitsUsed: 4, value: [5]},
    unsignedRangeExceededLimit: 100
  }));

  return buildCases({
    eventNotify: eventNotify,
    events: events,
    readRangeAck: readRangeAck,
    readRangeAckWithoutSequence: readRangeAckWithoutSequence,
    readRangeBaseRequest: readRangeBaseRequest,
    readRangeBaseWithoutArrayIndex: readRangeBaseWithoutArrayIndex,
    readRangeRequest: readRangeRequest
  });
};

const buildCases = ({
  eventNotify,
  events,
  readRangeAck,
  readRangeAckWithoutSequence,
  readRangeBaseRequest,
  readRangeBaseWithoutArrayIndex,
  readRangeRequest
}) => [
  {
    name: 'alarmSummary acknowledgement',
    decode: baServices.alarmSummary.decode,
    payload: encode((buffer) => baServices.alarmSummary.encode(buffer, [{
      objectId: {type: baEnum.ObjectType.ANALOG_INPUT, instance: 17},
      alarmState: baEnum.EventState.OFFNORMAL,
      acknowledgedTransitions: {value: [5], bitsUsed: 3}
    }])),
    validPrefixLengths: [0],
    exactWindow: true
  },
  {
    name: 'createObject',
    decode: baServices.createObject.decode,
    payload: encode((buffer) => baServices.createObject.encode(
      buffer,
      {type: baEnum.ObjectType.ANALOG_VALUE},
      []
    )),
    exactWindow: true
  },
  {
    name: 'createObject acknowledgement',
    decode: baServices.createObject.decodeAcknowledge,
    payload: encode((buffer) => baServices.createObject.encodeAcknowledge(
      buffer,
      {type: baEnum.ObjectType.ANALOG_VALUE, instance: 47}
    )),
    exactWindow: true
  },
  {
    name: 'addListElement',
    decode: baServices.addListElement.decode,
    payload: encode((buffer) => baServices.addListElement.encode(
      buffer,
      {type: 2, instance: 7},
      85,
      3,
      [{type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 9}]
    ))
  },
  {
    name: 'atomicReadFile stream request',
    decode: baServices.atomicReadFile.decode,
    payload: encode((buffer) => baServices.atomicReadFile.encode(buffer, true, {type: 10, instance: 11}, -2, 3))
  },
  {
    name: 'atomicReadFile record request',
    decode: baServices.atomicReadFile.decode,
    payload: encode((buffer) => baServices.atomicReadFile.encode(buffer, false, {type: 10, instance: 11}, 2, 3))
  },
  {
    name: 'atomicReadFile stream acknowledgement',
    decode: baServices.atomicReadFile.decodeAcknowledge,
    payload: encode((buffer) => baServices.atomicReadFile.encodeAcknowledge(
      buffer, true, false, 12, 0, [[1, 2, 3]], [3]
    ))
  },
  {
    name: 'atomicReadFile record acknowledgement',
    decode: baServices.atomicReadFile.decodeAcknowledge,
    payload: encode((buffer) => baServices.atomicReadFile.encodeAcknowledge(
      buffer, false, false, 12, 2, [[1], [2, 3]], [1, 2]
    ))
  },
  {
    name: 'atomicWriteFile stream request',
    decode: baServices.atomicWriteFile.decode,
    payload: encode((buffer) => baServices.atomicWriteFile.encode(
      buffer, true, {type: 10, instance: 11}, -2, [[1, 2, 3]]
    ))
  },
  {
    name: 'atomicWriteFile record request',
    decode: baServices.atomicWriteFile.decode,
    payload: encode((buffer) => baServices.atomicWriteFile.encode(
      buffer, false, {type: 10, instance: 11}, 2, [[1], [2, 3]]
    ))
  },
  {
    name: 'atomicWriteFile acknowledgement',
    decode: baServices.atomicWriteFile.decodeAcknowledge,
    payload: encode((buffer) => baServices.atomicWriteFile.encodeAcknowledge(buffer, false, 12))
  },
  {
    name: 'deleteObject',
    decode: baServices.deleteObject.decode,
    payload: encode((buffer) => baServices.deleteObject.encode(buffer, {type: 2, instance: 7}))
  },
  {
    name: 'error',
    decode: baServices.error.decode,
    payload: encode((buffer) => baServices.error.encode(buffer, 15, 25))
  },
  {
    name: 'eventNotifyData',
    decode: baServices.eventNotifyData.decode,
    payload: eventNotify,
    exactWindow: true
  },
  {
    name: 'getEnrollmentSummary',
    decode: baServices.getEnrollmentSummary.decode,
    payload: encode((buffer) => baServices.getEnrollmentSummary.encode(
      buffer,
      2,
      {objectId: {type: 5, instance: 33}, processId: 7},
      1,
      3,
      {min: 1, max: 65},
      5
    )),
    validPrefixLengths: [2, 13, 15, 17, 23]
  },
  {
    name: 'getEnrollmentSummary acknowledgement',
    decode: baServices.getEnrollmentSummary.decodeAcknowledge,
    payload: encode((buffer) => baServices.getEnrollmentSummary.encodeAcknowledge(buffer, [{
      objectId: {type: 12, instance: 120},
      eventType: 3,
      eventState: 2,
      priority: 18,
      notificationClass: 11
    }])),
    validPrefixLengths: [0, 11]
  },
  {
    name: 'getEventInformation',
    decode: baServices.getEventInformation.decode,
    payload: encode((buffer) => baServices.getEventInformation.encode(buffer, {type: 8, instance: 15})),
    validPrefixLengths: [0]
  },
  {
    name: 'getEventInformation acknowledgement',
    decode: baServices.getEventInformation.decodeAcknowledge,
    payload: encode((buffer) => baServices.getEventInformation.encodeAcknowledge(
      buffer,
      events,
      true
    )),
    exactWindow: true
  },
  {
    name: 'iAmBroadcast',
    decode: baServices.iAmBroadcast.decode,
    payload: encode((buffer) => baServices.iAmBroadcast.encode(buffer, 47, 1476, 1, 7))
  },
  {
    name: 'iHaveBroadcast',
    decode: baServices.iHaveBroadcast.decode,
    payload: encode((buffer) => baServices.iHaveBroadcast.encode(
      buffer, {type: 8, instance: 443}, {type: 0, instance: 4}, 'LgtCmd01'
    ))
  },
  {
    name: 'lifeSafetyOperation',
    decode: baServices.lifeSafetyOperation.decode,
    payload: encode((buffer) => baServices.lifeSafetyOperation.encode(
      buffer, 8, 'User01', 7, {type: 0, instance: 77}
    )),
    validPrefixLengths: [13]
  },
  {
    name: 'privateTransfer',
    decode: baServices.privateTransfer.decode,
    payload: encode((buffer) => baServices.privateTransfer.encode(buffer, 255, 8, [1, 2, 3, 4, 5])),
    validPrefixLengths: [4]
  },
  {
    name: 'readProperty',
    decode: baServices.readProperty.decode,
    payload: encode((buffer) => baServices.readProperty.encode(
      buffer,
      baEnum.ObjectType.ANALOG_VALUE,
      7,
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      baEnum.ASN1_ARRAY_ALL
    )),
    exactWindow: true
  },
  {
    name: 'readProperty acknowledgement',
    decode: baServices.readProperty.decodeAcknowledge,
    payload: encode((buffer) => baServices.readProperty.encodeAcknowledge(
      buffer,
      {type: baEnum.ObjectType.ANALOG_VALUE, instance: 7},
      baEnum.PropertyIdentifier.PRESENT_VALUE,
      baEnum.ASN1_ARRAY_ALL,
      [{type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 42}]
    )),
    exactWindow: true
  },
  {
    name: 'readRange by time request',
    decode: baServices.readRange.decode,
    payload: readRangeRequest,
    validPrefixLengths: [readRangeBaseWithoutArrayIndex.length, readRangeBaseRequest.length],
    exactWindow: true
  },
  {
    name: 'readRange acknowledgement',
    decode: baServices.readRange.decodeAcknowledge,
    payload: readRangeAck,
    validPrefixLengths: [readRangeAckWithoutSequence.length],
    exactWindow: true
  },
  {
    name: 'readPropertyMultiple',
    decode: baServices.readPropertyMultiple.decode,
    payload: encode((buffer) => baServices.readPropertyMultiple.encode(buffer, [{
      objectId: {type: 2, instance: 7},
      properties: [{id: baEnum.PropertyIdentifier.PRESENT_VALUE, index: 2}]
    }])),
    exactWindow: true
  },
  {
    name: 'readPropertyMultiple acknowledgement',
    decode: baServices.readPropertyMultiple.decodeAcknowledge,
    payload: encode((buffer) => baServices.readPropertyMultiple.encodeAcknowledge(buffer, [{
      objectId: {type: 2, instance: 7},
      values: [{
        property: {id: baEnum.PropertyIdentifier.PRESENT_VALUE, index: 2},
        value: [{type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 9}]
      }]
    }])),
    exactWindow: true
  },
  {
    name: 'whoHas object identifier',
    decode: baServices.whoHas.decode,
    payload: encode((buffer) => baServices.whoHas.encode(
      buffer, 3, 4000, {type: 3, instance: 15}
    ))
  },
  {
    name: 'whoHas object name',
    decode: baServices.whoHas.decode,
    payload: encode((buffer) => baServices.whoHas.encode(
      buffer, 3, 4000, {}, 'analog-output-1'
    ))
  },
  {
    name: 'writePropertyMultiple',
    decode: baServices.writePropertyMultiple.decode,
    payload: encode((buffer) => baServices.writePropertyMultiple.encode(buffer, {type: 2, instance: 7}, [{
      property: {id: 85, index: 2},
      value: [{type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 9}],
      priority: 8
    }]))
  }
];

describe('bacstack - service decoder safety', () => {
  const cases = makeCases();

  cases.forEach((testCase) => {
    it(`rejects every truncated ${testCase.name} window`, () => {
      expectEveryTruncationRejected(testCase);
    });
  });

  it('rejects invalid decode windows and malformed extended tags without throwing', () => {
    const malformed = [
      Buffer.alloc(0),
      Buffer.from([0xF5]),
      Buffer.from([0xF5, 0xFF]),
      Buffer.from([0xF5, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
      Buffer.alloc(16, 0xFF)
    ];

    cases.forEach((testCase) => {
      const invalidCalls = [
        () => testCase.decode(null, 0, 0),
        () => testCase.decode(Buffer.alloc(1), -1, 1),
        () => testCase.decode(Buffer.alloc(1), 2, 0),
        () => testCase.decode(Buffer.alloc(1), 0, -1),
        () => testCase.decode(Buffer.alloc(1), 0, 2),
        () => testCase.decode(Buffer.alloc(1), 0, 0.5)
      ];
      invalidCalls.forEach((decode, index) => {
        expect(decode, `${testCase.name} invalid window ${index}`).not.to.throw();
        expect(decode(), `${testCase.name} invalid window ${index}`).to.equal(undefined);
      });
      malformed.forEach((payload, index) => {
        const result = expectSafeDecode(
          `${testCase.name} malformed input ${index}`,
          testCase.decode,
          payload,
          payload.length
        );
        if (payload.length === 0 && testCase.validPrefixLengths &&
            testCase.validPrefixLengths.includes(0)) {
          expect(result, `${testCase.name} empty payload`).to.include({len: 0});
        } else {
          expect(result, `${testCase.name} malformed input ${index}`).to.equal(undefined);
        }
      });
    });
  });

  it('decodes bounded record acknowledgements after rejecting every truncation', () => {
    const payload = encode((buffer) => baServices.atomicReadFile.encodeAcknowledge(
      buffer, false, false, 12, 2, [[1], [2, 3]], [1, 2]
    ));
    for (let length = 0; length < payload.length; length++) {
      const prefix = Buffer.from(payload.subarray(0, length));
      expect(
        () => baServices.atomicReadFile.decodeAcknowledge(prefix, 0, length),
        `record acknowledgement prefix ${length}`
      ).not.to.throw();
      expect(baServices.atomicReadFile.decodeAcknowledge(prefix, 0, length)).to.equal(undefined);
    }
    expect(baServices.atomicReadFile.decodeAcknowledge(payload, 0, payload.length)).to.deep.include({
      len: payload.length,
      isStream: false,
      position: 12,
      blockCount: 2
    });
  });
});
