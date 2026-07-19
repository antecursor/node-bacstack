'use strict';

const EventEmitter = require('events').EventEmitter;
const expect = require('chai').expect;
const bacnet = require('../../');
const baApdu = require('../../lib/apdu');
const baAsn1 = require('../../lib/asn1');
const baBvlc = require('../../lib/bvlc');
const baEnum = require('../../lib/enum');
const baNpdu = require('../../lib/npdu');
const baServices = require('../../lib/services');

const CORPUS_SIZE = 1024;
const MAX_INPUT_LENGTH = 128;
const LARGE_CORPUS_SIZE = 64;
const MAX_LARGE_INPUT_LENGTH = 2048;

const makeCorpus = () => {
  let state = 0x6D2B79F5;
  const nextByte = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
  const completePackets = [
    Buffer.from([0x81, 0x0A, 0x00, 0x08, 0x01, 0x00, 0x10, 0x08]),
    Buffer.from([0x01, 0x28, 0x03, 0xE8, 0x03, 0x01, 0x02, 0x03,
      0x03, 0xE8, 0x03, 0x01, 0x02, 0x03, 0xFF, 0x10, 0x08]),
    Buffer.from([0x01, 0x0F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
  ];
  const corpus = completePackets.flatMap((packet) => Array.from(
    {length: packet.length + 1},
    (unused, length) => Buffer.from(packet.subarray(0, length))
  ));
  corpus.push(
    Buffer.alloc(0),
    Buffer.from([0xF5]),
    Buffer.from([0xF5, 0xFF]),
    Buffer.from([0xF5, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
    Buffer.alloc(MAX_INPUT_LENGTH, 0x0E),
    Buffer.alloc(MAX_INPUT_LENGTH, 0x0F),
    Buffer.alloc(MAX_INPUT_LENGTH, 0xFF)
  );

  for (let iteration = corpus.length; iteration < CORPUS_SIZE; iteration++) {
    const buffer = Buffer.alloc(nextByte() % MAX_INPUT_LENGTH);
    for (let index = 0; index < buffer.length; index++) buffer[index] = nextByte();
    corpus.push(buffer);
  }
  return corpus;
};

const corpus = makeCorpus();

const makeLargeCorpus = () => {
  let state = 0xA5A5F00D;
  const nextByte = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state >>> 24;
  };
  return Array.from({length: LARGE_CORPUS_SIZE}, (unused, index) => {
    const length = MAX_INPUT_LENGTH + 1 +
      ((index * 131) % (MAX_LARGE_INPUT_LENGTH - MAX_INPUT_LENGTH));
    const buffer = Buffer.alloc(length);
    for (let byteIndex = 0; byteIndex < length; byteIndex++) buffer[byteIndex] = nextByte();
    return buffer;
  });
};

const largeCorpus = makeLargeCorpus();

const containsNaN = (value, seen) => {
  if (typeof value === 'number') return Number.isNaN(value);
  if (value instanceof Date) return Number.isNaN(value.getTime());
  if (value == null || typeof value !== 'object' || Buffer.isBuffer(value)) return false;
  const visited = seen || new Set();
  if (visited.has(value)) return false;
  visited.add(value);
  return Object.values(value).some((child) => containsNaN(child, visited));
};

const invokeBoundedDecoder = (name, decode, buffer, offset, length) => {
  const before = Buffer.from(buffer);
  const result = invoke(name, () => decode(buffer, offset, length));
  expect(buffer.equals(before), `${name} input mutation`).to.equal(true);
  if (result !== undefined) {
    expect(result, name).to.be.an('object');
    expect(result.len, `${name} len`).to.be.a('number');
    expect(Number.isFinite(result.len), `${name} finite len`).to.equal(true);
    expect(Number.isInteger(result.len), `${name} integer len`).to.equal(true);
    expect(result.len, `${name} nonnegative len`).to.be.at.least(0);
    expect(result.len, `${name} bounded len`).to.be.at.most(length);
    if (length > 0) expect(result.len, `${name} progress`).to.be.greaterThan(0);
    expect(containsNaN(result), `${name} NaN output`).to.equal(false);
  }
  return result;
};

const invoke = (name, callback) => {
  try {
    return callback();
  } catch (err) {
    err.message = `${name}: ${err.message}`;
    throw err;
  }
};

const invokeWithControlledRejection = (name, callback) => {
  try {
    callback();
  } catch (err) {
    expect(err, name).to.be.an.instanceof(Error);
    expect(err.name, name).to.equal('Error');
  }
};

const frame = (payload, func) => {
  const packet = Buffer.alloc(baBvlc.BVLC_HEADER_LENGTH + payload.length);
  baBvlc.encode(packet, func, packet.length);
  payload.copy(packet, baBvlc.BVLC_HEADER_LENGTH);
  return packet;
};

const encodePayload = (callback) => {
  const buffer = {buffer: Buffer.alloc(2048), offset: 0};
  callback(buffer);
  return Buffer.from(buffer.buffer.subarray(0, buffer.offset));
};

const serviceFrame = (kind, service, payload, invokeId) => {
  const buffer = {buffer: Buffer.alloc(2048 + payload.length), offset: 0};
  baNpdu.encode(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE);
  if (kind === 'confirmed') {
    baApdu.encodeConfirmedServiceRequest(
      buffer,
      baEnum.PduTypes.CONFIRMED_REQUEST,
      service,
      baEnum.MaxSegmentsAccepted.SEGMENTS_0,
      baEnum.MaxApduLengthAccepted.OCTETS_1476,
      invokeId == null ? 1 : invokeId
    );
  } else if (kind === 'unconfirmed') {
    baApdu.encodeUnconfirmedServiceRequest(
      buffer,
      baEnum.PduTypes.UNCONFIRMED_REQUEST,
      service
    );
  } else if (kind === 'complexAck') {
    baApdu.encodeComplexAck(
      buffer,
      baEnum.PduTypes.COMPLEX_ACK,
      service,
      invokeId
    );
  } else if (kind === 'error') {
    baApdu.encodeError(buffer, baEnum.PduTypes.ERROR, service, invokeId == null ? 1 : invokeId);
  } else {
    throw new Error(`Unsupported service frame kind: ${kind}`);
  }
  payload.copy(buffer.buffer, buffer.offset);
  buffer.offset += payload.length;
  return frame(
    buffer.buffer.subarray(0, buffer.offset),
    baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU
  );
};

class FuzzTransport extends EventEmitter {
  constructor(addressKind) {
    super();
    this._addressKind = addressKind;
  }

  getAddressKind() {
    return this._addressKind;
  }

  getBroadcastAddress() {
    return this._addressKind === 'vmac' ? bacnet.bacnetSc.BROADCAST_VMAC : '255.255.255.255';
  }

  getMaxPayload() {
    return 1482;
  }

  send() {}
  open() {}
  close() {}
}

describe('bacstack - deterministic decoder fuzzing', function() {
  this.timeout(5000);

  it('keeps BACnet/IP framing decoders total for arbitrary bounded windows', () => {
    const apduDecoders = [
      baApdu.decodeConfirmedServiceRequest,
      baApdu.decodeUnconfirmedServiceRequest,
      baApdu.decodeSimpleAck,
      baApdu.decodeComplexAck,
      baApdu.decodeSegmentAck,
      baApdu.decodeError,
      baApdu.decodeAbort
    ];

    corpus.forEach((buffer, corpusIndex) => {
      const offsets = [-1, 0, Math.floor(buffer.length / 2), buffer.length, buffer.length + 1];
      offsets.forEach((offset) => {
        const remaining = Math.max(0, buffer.length - Math.max(0, offset));
        const lengths = [-1, 0, remaining, remaining + 1];
        const label = `corpus ${corpusIndex}, offset ${offset}`;

        invoke(`BVLC ${label}`, () => baBvlc.decode(buffer, offset));
        invoke(`NPDU function ${label}`, () => baNpdu.decodeFunction(buffer, offset));
        invoke(`APDU type ${label}`, () => baApdu.getDecodedType(buffer, offset));
        invoke(`APDU invoke ID ${label}`, () => baApdu.getDecodedInvokeId(buffer, offset));
        lengths.forEach((length) => {
          invoke(`NPDU ${label}, length ${length}`, () => baNpdu.decode(buffer, offset, length));
          apduDecoders.forEach((decode, decoderIndex) => invoke(
            `APDU ${decoderIndex}, ${label}, length ${length}`,
            () => decode(buffer, offset, length)
          ));
        });
      });
    });
  });

  it('keeps bounded ASN.1 decoder entry points total for arbitrary input', () => {
    corpus.forEach((buffer, corpusIndex) => {
      const offset = buffer.length === 0 ? 0 : corpusIndex % (buffer.length + 1);
      const remaining = buffer.length - offset;
      const end = offset + remaining;
      const scalarLength = Math.min(remaining, 4);
      const label = `ASN.1 corpus ${corpusIndex}`;
      const decoders = [
        () => baAsn1.decodeUnsigned(buffer, offset, scalarLength),
        () => baAsn1.decodeEnumerated(buffer, offset, scalarLength),
        () => baAsn1.decodeTagNumber(buffer, offset),
        () => baAsn1.decodeIsContextTag(buffer, offset, 0),
        () => baAsn1.decodeIsOpeningTagNumber(buffer, offset, 0),
        () => baAsn1.decodeIsClosingTagNumber(buffer, offset, 0),
        () => baAsn1.decodeIsClosingTag(buffer, offset),
        () => baAsn1.decodeIsOpeningTag(buffer, offset),
        () => baAsn1.decodeObjectId(buffer, offset),
        () => baAsn1.decodeTagNumberAndValue(buffer, offset),
        () => baAsn1.bacappDecodeApplicationData(buffer, offset, end, 0, 0),
        () => baAsn1.decodeReadAccessResult(buffer, offset, remaining),
        () => baAsn1.decodeSigned(buffer, offset, scalarLength),
        () => baAsn1.decodeReal(buffer, offset),
        () => baAsn1.decodeOctetString(buffer, offset, remaining, 0, remaining),
        () => baAsn1.decodeCharacterString(buffer, offset, remaining, remaining),
        () => baAsn1.decodeBitstring(buffer, offset, remaining),
        () => baAsn1.decodeDate(buffer, offset),
        () => baAsn1.decodeDateUTC(buffer, offset),
        () => baAsn1.decodeApplicationDate(buffer, offset),
        () => baAsn1.decodeApplicationDateUTC(buffer, offset),
        () => baAsn1.decodeBacnetTime(buffer, offset),
        () => baAsn1.decodeBacnetTimeUTC(buffer, offset),
        () => baAsn1.decodeApplicationTime(buffer, offset),
        () => baAsn1.decodeApplicationTimeUTC(buffer, offset),
        () => baAsn1.decodeReadAccessSpecification(buffer, offset, remaining),
        () => baAsn1.decodeContextCharacterString(buffer, offset, remaining, 0),
        () => baAsn1.decodeContextObjectId(buffer, offset, 0)
      ];

      decoders.forEach((decode, decoderIndex) => invoke(
        `${label}, decoder ${decoderIndex}`,
        decode
      ));
    });
  });

  it('keeps complex service decoders total within deterministic declared windows', () => {
    const decoders = [
      ['AlarmSummary acknowledgement', baServices.alarmSummary.decode],
      ['CreateObject acknowledgement', baServices.createObject.decodeAcknowledge],
      ['ReadProperty acknowledgement', baServices.readProperty.decodeAcknowledge],
      ['EventNotifyData', baServices.eventNotifyData.decode],
      ['ReadPropertyMultiple request', baServices.readPropertyMultiple.decode],
      ['ReadPropertyMultiple acknowledgement', baServices.readPropertyMultiple.decodeAcknowledge],
      ['ReadRange request', baServices.readRange.decode],
      ['ReadRange acknowledgement', baServices.readRange.decodeAcknowledge],
      ['GetEventInformation acknowledgement', baServices.getEventInformation.decodeAcknowledge]
    ];

    corpus.concat(largeCorpus).forEach((payload, corpusIndex) => {
      const buffer = Buffer.concat([Buffer.from([0xAA, 0xBB, 0xCC]), payload, Buffer.from([0xDD])]);
      const lengths = Array.from(new Set([0, Math.floor(payload.length / 2), payload.length]));
      decoders.forEach(([name, decode]) => {
        lengths.forEach((length) => invokeBoundedDecoder(
          `${name}, corpus ${corpusIndex}, length ${length}`,
          decode,
          buffer,
          3,
          length
        ));
      });
    });
  });

  it('routes valid service skeleton mutations through every hardened decoder', () => {
    const tracked = [
      ['alarmSummary.decode', baServices.alarmSummary, 'decode'],
      ['addListElement.decode', baServices.addListElement, 'decode'],
      ['atomicReadFile.decode', baServices.atomicReadFile, 'decode'],
      ['atomicReadFile.decodeAcknowledge', baServices.atomicReadFile, 'decodeAcknowledge'],
      ['atomicWriteFile.decode', baServices.atomicWriteFile, 'decode'],
      ['atomicWriteFile.decodeAcknowledge', baServices.atomicWriteFile, 'decodeAcknowledge'],
      ['createObject.decode', baServices.createObject, 'decode'],
      ['createObject.decodeAcknowledge', baServices.createObject, 'decodeAcknowledge'],
      ['deleteObject.decode', baServices.deleteObject, 'decode'],
      ['error.decode', baServices.error, 'decode'],
      ['eventNotifyData.decode', baServices.eventNotifyData, 'decode'],
      ['getEnrollmentSummary.decode', baServices.getEnrollmentSummary, 'decode'],
      [
        'getEnrollmentSummary.decodeAcknowledge',
        baServices.getEnrollmentSummary,
        'decodeAcknowledge'
      ],
      ['getEventInformation.decode', baServices.getEventInformation, 'decode'],
      [
        'getEventInformation.decodeAcknowledge',
        baServices.getEventInformation,
        'decodeAcknowledge'
      ],
      ['iAmBroadcast.decode', baServices.iAmBroadcast, 'decode'],
      ['iHaveBroadcast.decode', baServices.iHaveBroadcast, 'decode'],
      ['lifeSafetyOperation.decode', baServices.lifeSafetyOperation, 'decode'],
      ['privateTransfer.decode', baServices.privateTransfer, 'decode'],
      ['readProperty.decode', baServices.readProperty, 'decode'],
      ['readProperty.decodeAcknowledge', baServices.readProperty, 'decodeAcknowledge'],
      ['readPropertyMultiple.decode', baServices.readPropertyMultiple, 'decode'],
      ['readPropertyMultiple.decodeAcknowledge', baServices.readPropertyMultiple, 'decodeAcknowledge'],
      ['readRange.decode', baServices.readRange, 'decode'],
      ['readRange.decodeAcknowledge', baServices.readRange, 'decodeAcknowledge'],
      ['whoHas.decode', baServices.whoHas, 'decode'],
      ['writePropertyMultiple.decode', baServices.writePropertyMultiple, 'decode']
    ];
    const counts = Object.fromEntries(tracked.map(([name]) => [name, 0]));
    const originals = tracked.map(([name, owner, method]) => {
      const original = owner[method];
      owner[method] = (...args) => {
        counts[name]++;
        return original(...args);
      };
      return {owner: owner, method: method, original: original};
    });
    const transport = new FuzzTransport('ip');
    const client = new bacnet({transport: transport, apduTimeout: 1000});
    const remoteAddress = '192.0.2.1';
    const objectId = {type: baEnum.ObjectType.FILE, instance: 7};

    try {
      const requestCases = [
        {
          kind: 'confirmed',
          service: baEnum.ConfirmedServiceChoice.ADD_LIST_ELEMENT,
          payload: encodePayload((buffer) => baServices.addListElement.encode(
            buffer,
            {type: 2, instance: 7},
            85,
            3,
            [{type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 9}]
          ))
        },
        {
          kind: 'confirmed',
          service: baEnum.ConfirmedServiceChoice.ATOMIC_READ_FILE,
          payload: encodePayload((buffer) => baServices.atomicReadFile.encode(
            buffer,
            true,
            objectId,
            0,
            8
          ))
        },
        {
          kind: 'confirmed',
          service: baEnum.ConfirmedServiceChoice.ATOMIC_WRITE_FILE,
          payload: encodePayload((buffer) => baServices.atomicWriteFile.encode(
            buffer,
            false,
            objectId,
            0,
            [[1, 2]]
          ))
        },
        {
          kind: 'confirmed',
          service: baEnum.ConfirmedServiceChoice.DELETE_OBJECT,
          payload: encodePayload((buffer) => baServices.deleteObject.encode(
            buffer,
            {type: 2, instance: 7}
          ))
        },
        {
          kind: 'confirmed',
          service: baEnum.ConfirmedServiceChoice.GET_ENROLLMENT_SUMMARY,
          payload: encodePayload((buffer) => baServices.getEnrollmentSummary.encode(
            buffer,
            0,
            null,
            0,
            0,
            {min: 0, max: 255},
            0
          ))
        },
        {
          kind: 'confirmed',
          service: baEnum.ConfirmedServiceChoice.GET_EVENT_INFORMATION,
          payload: Buffer.alloc(0)
        },
        {
          kind: 'confirmed',
          service: baEnum.ConfirmedServiceChoice.READ_PROPERTY,
          payload: encodePayload((buffer) => baServices.readProperty.encode(
            buffer,
            baEnum.ObjectType.ANALOG_VALUE,
            7,
            baEnum.PropertyIdentifier.PRESENT_VALUE,
            baEnum.ASN1_ARRAY_ALL
          ))
        },
        {
          kind: 'confirmed',
          service: baEnum.ConfirmedServiceChoice.READ_PROPERTY_MULTIPLE,
          payload: encodePayload((buffer) => baServices.readPropertyMultiple.encode(buffer, [{
            objectId: {type: 2, instance: 7},
            properties: [{id: baEnum.PropertyIdentifier.PRESENT_VALUE, index: 2}]
          }]))
        },
        {
          kind: 'confirmed',
          service: baEnum.ConfirmedServiceChoice.READ_RANGE,
          payload: encodePayload((buffer) => baServices.readRange.encode(
            buffer,
            {type: baEnum.ObjectType.TREND_LOG, instance: 7},
            baEnum.PropertyIdentifier.LOG_BUFFER,
            baEnum.ASN1_ARRAY_ALL,
            baEnum.ReadRangeType.BY_POSITION,
            1,
            null,
            4
          ))
        },
        {
          kind: 'confirmed',
          service: baEnum.ConfirmedServiceChoice.CREATE_OBJECT,
          payload: encodePayload((buffer) => baServices.createObject.encode(
            buffer,
            {type: baEnum.ObjectType.ANALOG_VALUE},
            []
          ))
        },
        {
          kind: 'confirmed',
          service: baEnum.ConfirmedServiceChoice.LIFE_SAFETY_OPERATION,
          payload: encodePayload((buffer) => baServices.lifeSafetyOperation.encode(
            buffer,
            8,
            'User01',
            7
          ))
        },
        {
          kind: 'confirmed',
          service: baEnum.ConfirmedServiceChoice.CONFIRMED_PRIVATE_TRANSFER,
          payload: encodePayload((buffer) => baServices.privateTransfer.encode(buffer, 255, 8))
        },
        {
          kind: 'confirmed',
          service: baEnum.ConfirmedServiceChoice.WRITE_PROPERTY_MULTIPLE,
          payload: encodePayload((buffer) => baServices.writePropertyMultiple.encode(
            buffer,
            {type: 2, instance: 7},
            [{
              property: {id: 85, index: 2},
              value: [{type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 9}],
              priority: 8
            }]
          ))
        },
        {
          kind: 'unconfirmed',
          service: baEnum.UnconfirmedServiceChoice.I_AM,
          payload: encodePayload((buffer) => baServices.iAmBroadcast.encode(
            buffer,
            47,
            1476,
            1,
            7
          ))
        },
        {
          kind: 'unconfirmed',
          service: baEnum.UnconfirmedServiceChoice.I_HAVE,
          payload: encodePayload((buffer) => baServices.iHaveBroadcast.encode(
            buffer,
            {type: 8, instance: 443},
            {type: 0, instance: 4},
            'LgtCmd01'
          ))
        },
        {
          kind: 'unconfirmed',
          service: baEnum.UnconfirmedServiceChoice.WHO_HAS,
          payload: encodePayload((buffer) => baServices.whoHas.encode(
            buffer,
            3,
            4000,
            {type: 3, instance: 15}
          ))
        },
        {
          kind: 'unconfirmed',
          service: baEnum.UnconfirmedServiceChoice.UNCONFIRMED_EVENT_NOTIFICATION,
          payload: encodePayload((buffer) => baServices.eventNotifyData.encode(buffer, {
            processId: 3,
            initiatingObjectId: {type: baEnum.ObjectType.DEVICE, instance: 12},
            eventObjectId: {type: baEnum.ObjectType.ANALOG_INPUT, instance: 1121},
            timeStamp: {
              type: baEnum.TimeStamp.DATETIME,
              value: new Date(2024, 0, 2, 3, 4, 5, 60)
            },
            notificationClass: 9,
            priority: 7,
            eventType: baEnum.EventType.UNSIGNED_RANGE,
            messageText: 'fuzz-seed',
            notifyType: baEnum.NotifyType.EVENT,
            ackRequired: false,
            fromState: baEnum.EventState.NORMAL,
            toState: baEnum.EventState.OFFNORMAL,
            unsignedRangeExceedingValue: 101,
            unsignedRangeStatusFlags: {bitsUsed: 4, value: [5]},
            unsignedRangeExceededLimit: 100
          }))
        },
        {
          kind: 'unconfirmed',
          service: baEnum.UnconfirmedServiceChoice.UNCONFIRMED_PRIVATE_TRANSFER,
          payload: encodePayload((buffer) => baServices.privateTransfer.encode(buffer, 255, 8))
        }
      ];
      const requestDecoders = new Map([
        [`confirmed:${baEnum.ConfirmedServiceChoice.ADD_LIST_ELEMENT}`, baServices.addListElement.decode],
        [`confirmed:${baEnum.ConfirmedServiceChoice.ATOMIC_READ_FILE}`, baServices.atomicReadFile.decode],
        [`confirmed:${baEnum.ConfirmedServiceChoice.ATOMIC_WRITE_FILE}`, baServices.atomicWriteFile.decode],
        [`confirmed:${baEnum.ConfirmedServiceChoice.CREATE_OBJECT}`, baServices.createObject.decode],
        [`confirmed:${baEnum.ConfirmedServiceChoice.DELETE_OBJECT}`, baServices.deleteObject.decode],
        [
          `confirmed:${baEnum.ConfirmedServiceChoice.GET_ENROLLMENT_SUMMARY}`,
          baServices.getEnrollmentSummary.decode
        ],
        [
          `confirmed:${baEnum.ConfirmedServiceChoice.GET_EVENT_INFORMATION}`,
          baServices.getEventInformation.decode
        ],
        [`confirmed:${baEnum.ConfirmedServiceChoice.READ_PROPERTY}`, baServices.readProperty.decode],
        [
          `confirmed:${baEnum.ConfirmedServiceChoice.READ_PROPERTY_MULTIPLE}`,
          baServices.readPropertyMultiple.decode
        ],
        [`confirmed:${baEnum.ConfirmedServiceChoice.READ_RANGE}`, baServices.readRange.decode],
        [
          `confirmed:${baEnum.ConfirmedServiceChoice.LIFE_SAFETY_OPERATION}`,
          baServices.lifeSafetyOperation.decode
        ],
        [
          `confirmed:${baEnum.ConfirmedServiceChoice.CONFIRMED_PRIVATE_TRANSFER}`,
          baServices.privateTransfer.decode
        ],
        [
          `confirmed:${baEnum.ConfirmedServiceChoice.WRITE_PROPERTY_MULTIPLE}`,
          baServices.writePropertyMultiple.decode
        ],
        [`unconfirmed:${baEnum.UnconfirmedServiceChoice.I_AM}`, baServices.iAmBroadcast.decode],
        [`unconfirmed:${baEnum.UnconfirmedServiceChoice.I_HAVE}`, baServices.iHaveBroadcast.decode],
        [`unconfirmed:${baEnum.UnconfirmedServiceChoice.WHO_HAS}`, baServices.whoHas.decode],
        [
          `unconfirmed:${baEnum.UnconfirmedServiceChoice.UNCONFIRMED_EVENT_NOTIFICATION}`,
          baServices.eventNotifyData.decode
        ],
        [
          `unconfirmed:${baEnum.UnconfirmedServiceChoice.UNCONFIRMED_PRIVATE_TRANSFER}`,
          baServices.privateTransfer.decode
        ]
      ]);

      requestCases.forEach((testCase, caseIndex) => {
        const prefixLength = Math.max(0, testCase.payload.length - 1);
        const mutations = [
          testCase.payload,
          Buffer.from(testCase.payload.subarray(0, prefixLength)),
          Buffer.concat([testCase.payload, Buffer.from([0xF5])]),
          Buffer.from([0xF5, 0xFF])
        ];
        mutations.forEach((payload, mutationIndex) => {
          const uniqueIndex = caseIndex * mutations.length + mutationIndex + 1;
          const mutationAddress = `192.0.2.${uniqueIndex}`;
          const decode = requestDecoders.get(`${testCase.kind}:${testCase.service}`);
          invokeBoundedDecoder(
            `direct service ${caseIndex}, mutation ${mutationIndex}`,
            decode,
            payload,
            0,
            payload.length
          );
          invoke(
            `service ingress ${caseIndex}, mutation ${mutationIndex}`,
            () => transport.emit(
              'message',
              serviceFrame(testCase.kind, testCase.service, payload, uniqueIndex),
              mutationAddress,
              47808
            )
          );
        });
      });

      const rangeData = encodePayload((buffer) => baAsn1.encodeApplicationOctetString(
        buffer,
        Buffer.from([0x11, 0x5F, 0x22]),
        0,
        3
      ));
      const directAcknowledgements = [
        {
          name: 'AlarmSummary acknowledgement',
          decode: baServices.alarmSummary.decode,
          payload: encodePayload((buffer) => baServices.alarmSummary.encode(buffer, [{
            objectId: {type: baEnum.ObjectType.ANALOG_INPUT, instance: 17},
            alarmState: baEnum.EventState.OFFNORMAL,
            acknowledgedTransitions: {bitsUsed: 3, value: [5]}
          }]))
        },
        {
          name: 'CreateObject acknowledgement',
          decode: baServices.createObject.decodeAcknowledge,
          payload: encodePayload((buffer) => baServices.createObject.encodeAcknowledge(
            buffer,
            {type: baEnum.ObjectType.ANALOG_VALUE, instance: 47}
          ))
        },
        {
          name: 'ReadProperty acknowledgement',
          decode: baServices.readProperty.decodeAcknowledge,
          payload: encodePayload((buffer) => baServices.readProperty.encodeAcknowledge(
            buffer,
            {type: baEnum.ObjectType.ANALOG_VALUE, instance: 7},
            baEnum.PropertyIdentifier.PRESENT_VALUE,
            baEnum.ASN1_ARRAY_ALL,
            [{type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 42}]
          ))
        },
        {
          name: 'ReadPropertyMultiple acknowledgement',
          decode: baServices.readPropertyMultiple.decodeAcknowledge,
          payload: encodePayload((buffer) => baServices.readPropertyMultiple.encodeAcknowledge(buffer, [{
            objectId: {type: 2, instance: 7},
            values: [{
              property: {id: baEnum.PropertyIdentifier.PRESENT_VALUE, index: 2},
              value: [{type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 9}]
            }]
          }]))
        },
        {
          name: 'ReadRange acknowledgement',
          decode: baServices.readRange.decodeAcknowledge,
          payload: encodePayload((buffer) => baServices.readRange.encodeAcknowledge(
            buffer,
            {type: baEnum.ObjectType.TREND_LOG, instance: 7},
            baEnum.PropertyIdentifier.LOG_BUFFER,
            baEnum.ASN1_ARRAY_ALL,
            {bitsUsed: 3, value: [5]},
            1,
            rangeData,
            baEnum.ReadRangeType.BY_SEQUENCE_NUMBER,
            17
          ))
        },
        {
          name: 'GetEventInformation acknowledgement',
          decode: baServices.getEventInformation.decodeAcknowledge,
          payload: encodePayload((buffer) => {
            const timestamp = new Date(2024, 0, 2, 3, 4, 5, 60);
            baServices.getEventInformation.encodeAcknowledge(buffer, [{
              objectId: {type: baEnum.ObjectType.ANALOG_INPUT, instance: 17},
              eventState: baEnum.EventState.OFFNORMAL,
              acknowledgedTransitions: {bitsUsed: 3, value: [5]},
              eventTimeStamps: [
                {type: baEnum.TimeStamp.DATETIME, value: timestamp},
                {type: baEnum.TimeStamp.SEQUENCE_NUMBER, value: 5},
                {type: baEnum.TimeStamp.TIME, value: timestamp}
              ],
              notifyType: baEnum.NotifyType.EVENT,
              eventEnable: {bitsUsed: 3, value: [5]},
              eventPriorities: [1, 2, 3]
            }], false);
          })
        }
      ];
      directAcknowledgements.forEach((testCase) => {
        const prefixLength = Math.max(0, testCase.payload.length - 1);
        [
          testCase.payload,
          Buffer.from(testCase.payload.subarray(0, prefixLength)),
          Buffer.concat([testCase.payload, Buffer.from([0xF5])]),
          Buffer.from([0xF5, 0xFF])
        ].forEach((payload, mutationIndex) => invokeBoundedDecoder(
          `${testCase.name}, mutation ${mutationIndex}`,
          testCase.decode,
          payload,
          0,
          payload.length
        ));
      });

      const errorPayload = encodePayload((buffer) => baServices.error.encode(buffer, 2, 32));
      invokeBoundedDecoder(
        'Error service payload',
        baServices.error.decode,
        errorPayload,
        0,
        errorPayload.length
      );
      transport.emit(
        'message',
        serviceFrame('error', baEnum.ConfirmedServiceChoice.READ_PROPERTY, errorPayload, 200),
        remoteAddress,
        47808
      );

      let acknowledgementCallbacks = 0;
      client.readFile(remoteAddress, objectId, 0, 8, {invokeId: 220}, (err) => {
        expect(err).to.equal(null);
        acknowledgementCallbacks++;
      });
      const readAck = encodePayload((buffer) => baServices.atomicReadFile.encodeAcknowledge(
        buffer,
        true,
        false,
        0,
        0,
        [[1, 2]],
        [2]
      ));
      transport.emit(
        'message',
        serviceFrame(
          'complexAck',
          baEnum.ConfirmedServiceChoice.ATOMIC_READ_FILE,
          readAck,
          220
        ),
        remoteAddress,
        47808
      );

      client.writeFile(remoteAddress, objectId, 0, [[1, 2]], {invokeId: 221}, (err) => {
        expect(err).to.equal(null);
        acknowledgementCallbacks++;
      });
      const writeAck = encodePayload((buffer) => baServices.atomicWriteFile.encodeAcknowledge(
        buffer,
        false,
        0
      ));
      transport.emit(
        'message',
        serviceFrame(
          'complexAck',
          baEnum.ConfirmedServiceChoice.ATOMIC_WRITE_FILE,
          writeAck,
          221
        ),
        remoteAddress,
        47808
      );

      client.getEnrollmentSummary(remoteAddress, 0, {invokeId: 222}, (err) => {
        expect(err).to.equal(null);
        acknowledgementCallbacks++;
      });
      const enrollmentAck = Buffer.from('c403000078910391022112', 'hex');
      transport.emit(
        'message',
        serviceFrame(
          'complexAck',
          baEnum.ConfirmedServiceChoice.GET_ENROLLMENT_SUMMARY,
          enrollmentAck,
          222
        ),
        remoteAddress,
        47808
      );

      expect(acknowledgementCallbacks).to.equal(3);
      Object.entries(counts).forEach(([name, count]) => {
        expect(count, name).to.be.greaterThan(0);
      });
    } finally {
      client.close();
      originals.forEach(({owner, method, original}) => {
        owner[method] = original;
      });
    }
  });

  it('contains arbitrary service payload failures at each public client ingress', () => {
    const transports = [new FuzzTransport('ip'), new FuzzTransport('vmac')];
    const clients = transports.map((transport) => new bacnet({
      transport: transport,
      maxSegmentedTransfers: 8,
      maxSegmentedTransfersPerPeer: 4,
      maxSegmentsPerTransfer: 16,
      maxSegmentedBytesPerTransfer: 2048,
      maxSegmentedTotalBytes: 4096
    }));

    try {
      corpus.forEach((payload, corpusIndex) => {
        const ipPacket = frame(payload, baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU);
        const forwardedPayload = Buffer.concat([
          Buffer.from([192, 0, 2, 99, 0xBA, 0xC0]),
          payload
        ]);
        const forwardedPacket = frame(forwardedPayload, baEnum.BvlcResultPurpose.FORWARDED_NPDU);
        invoke(`IP client corpus ${corpusIndex}`, () => {
          transports[0].emit('message', payload, '192.0.2.1', 47808);
          transports[0].emit('message', ipPacket, '192.0.2.1', 47808);
          transports[0].emit('message', forwardedPacket, '192.0.2.2', 47808);
        });
        invoke(`SC client corpus ${corpusIndex}`, () => transports[1].emit(
          'message',
          ipPacket,
          '020000000001',
          0,
          Object.freeze({transport: 'bacnet-sc', messageId: corpusIndex & 0xFFFF})
        ));
      });
    } finally {
      clients.forEach((client) => client.close());
    }
  });

  it('terminates BACnet/SC decoding with controlled validation errors', () => {
    const decoders = [
      bacnet.bacnetSc.decode,
      bacnet.bacnetSc.decodeConnectPayload,
      bacnet.bacnetSc.decodeBvlcResultPayload
    ];

    corpus.forEach((buffer, corpusIndex) => {
      decoders.forEach((decode, decoderIndex) => {
        const label = `BACnet/SC decoder ${decoderIndex}, corpus ${corpusIndex}`;
        invokeWithControlledRejection(label, () => decode(buffer));
        invokeWithControlledRejection(`${label}, typed array`, () => decode(new Uint8Array(buffer)));
      });
    });
    invokeWithControlledRejection(
      'oversized BACnet/SC envelope',
      () => bacnet.bacnetSc.decode(Buffer.alloc(0x10000))
    );
  });
});
