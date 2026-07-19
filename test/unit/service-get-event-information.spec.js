'use strict';

const expect      = require('chai').expect;
const utils       = require('./utils');
const baServices  = require('../../lib/services');
const baEnum      = require('../../lib/enum');

describe('bacstack - Services layer GetEventInformation unit', () => {
  it('should successfully encode and decode', () => {
    const buffer = utils.getBuffer();
    baServices.getEventInformation.encode(buffer, {type: 8, instance: 15});
    const result = baServices.getEventInformation.decode(buffer.buffer, 0);
    delete result.len;
    expect(result).to.deep.equal({
      lastReceivedObjectId: {type: 8, instance: 15}
    });
  });

  it('encodes and decodes an empty first-page request', () => {
    const buffer = utils.getBuffer();
    baServices.getEventInformation.encode(buffer);
    expect(buffer.offset).to.equal(0);
    expect(baServices.getEventInformation.decode(buffer.buffer, 0, 0)).to.deep.equal({
      len: 0
    });
  });
});

describe('GetEventInformationAcknowledge', () => {
  const encodeAcknowledge = (moreEvents = false) => {
    const timeStamp = new Date(1, 1, 1);
    timeStamp.setMilliseconds(990);
    const buffer = utils.getBuffer();
    baServices.getEventInformation.encodeAcknowledge(buffer, [
      {
        objectId: {type: 2, instance: 17},
        eventState: 3,
        acknowledgedTransitions: {value: [5], bitsUsed: 3},
        eventTimeStamps: [{value: timeStamp, type: baEnum.TimeStamp.DATETIME}, {value: 5, type: baEnum.TimeStamp.SEQUENCE_NUMBER}, {value: timeStamp, type: baEnum.TimeStamp.TIME}],
        notifyType: baEnum.NotifyType.ACK_NOTIFICATION,
        eventEnable: {value: [5], bitsUsed: 3},
        eventPriorities: [1, 2, 3]
      }
    ], moreEvents);
    return {encoded: Buffer.from(buffer.buffer.subarray(0, buffer.offset)), timeStamp: timeStamp};
  };

  it('should successfully encode and decode', () => {
    const {encoded, timeStamp} = encodeAcknowledge();
    const result = baServices.getEventInformation.decodeAcknowledge(encoded, 0, encoded.length);
    delete result.len;
    expect(result).to.deep.equal({
      events: [
        {
          objectId: {type: 2, instance: 17},
          eventState: 3,
          acknowledgedTransitions: {value: [5], bitsUsed: 3}, eventTimeStamps: [{value: timeStamp, type: baEnum.TimeStamp.DATETIME}, {value: 5, type: baEnum.TimeStamp.SEQUENCE_NUMBER}, {value: timeStamp, type: baEnum.TimeStamp.TIME}],
          notifyType: baEnum.NotifyType.ACK_NOTIFICATION,
          eventEnable: {value: [5], bitsUsed: 3},
          eventPriorities: [1, 2, 3]
        }
      ],
      moreEvents: false
    });
  });

  it('should successfully encode and decode empty payload', () => {
    const buffer = utils.getBuffer();
    baServices.getEventInformation.encodeAcknowledge(buffer, [], true);
    const result = baServices.getEventInformation.decodeAcknowledge(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      events: [],
      moreEvents: true
    });
  });

  it('honors nonzero offsets and the exact declared window', () => {
    const {encoded} = encodeAcknowledge();
    const wrapped = Buffer.concat([Buffer.from([0xAA, 0xBB]), encoded, Buffer.from([0xCC])]);

    expect(baServices.getEventInformation.decodeAcknowledge(wrapped, 2, encoded.length)).to.include({len: encoded.length, moreEvents: false});
    expect(baServices.getEventInformation.decodeAcknowledge(wrapped, 2, encoded.length - 1)).to.equal(undefined);
    expect(baServices.getEventInformation.decodeAcknowledge(wrapped, 2, encoded.length + 1)).to.equal(undefined);
  });

  it('rejects every truncation without throwing or returning a partial event', () => {
    const {encoded} = encodeAcknowledge(true);
    for (let length = 0; length < encoded.length; length++) {
      const decode = () => baServices.getEventInformation.decodeAcknowledge(encoded, 0, length);
      expect(decode).not.to.throw();
      expect(decode()).to.equal(undefined);
    }
  });

  it('rejects wrong tag classes and out-of-range enumerations', () => {
    const {encoded} = encodeAcknowledge();
    const wrongClass = Buffer.from(encoded);
    wrongClass[1] &= ~0x08;
    expect(baServices.getEventInformation.decodeAcknowledge(wrongClass, 0, wrongClass.length)).to.equal(undefined);

    const invalidEventState = Buffer.from(encoded);
    invalidEventState[7] = baEnum.EventState.LIFE_SAFETY_ALARM + 1;
    expect(baServices.getEventInformation.decodeAcknowledge(invalidEventState, 0, invalidEventState.length)).to.equal(undefined);
  });

  it('requires exactly three timestamps and three priorities', () => {
    const {encoded} = encodeAcknowledge();
    const timestampClosing = encoded.indexOf(0x3F);
    const extraTimestamp = Buffer.concat([
      encoded.subarray(0, timestampClosing),
      Buffer.from([0x19, 0x00]),
      encoded.subarray(timestampClosing)
    ]);
    expect(baServices.getEventInformation.decodeAcknowledge(extraTimestamp, 0, extraTimestamp.length)).to.equal(undefined);

    const prioritiesClosing = encoded.indexOf(0x6F);
    const extraPriority = Buffer.concat([
      encoded.subarray(0, prioritiesClosing),
      Buffer.from([0x21, 0x04]),
      encoded.subarray(prioritiesClosing)
    ]);
    expect(baServices.getEventInformation.decodeAcknowledge(extraPriority, 0, extraPriority.length)).to.equal(undefined);
  });

  it('accepts only zero or one for the final context Boolean', () => {
    const {encoded} = encodeAcknowledge();
    const invalidBoolean = Buffer.from(encoded);
    invalidBoolean[invalidBoolean.length - 1] = 2;

    expect(baServices.getEventInformation.decodeAcknowledge(invalidBoolean, 0, invalidBoolean.length)).to.equal(undefined);
  });

  it('accepts only event priorities from 0 through 255 on encode and decode', () => {
    const {encoded, timeStamp} = encodeAcknowledge();
    const prioritiesOpening = encoded.indexOf(0x6E);
    const boundaryPriorities = Buffer.from(encoded);
    boundaryPriorities[prioritiesOpening + 2] = 0;
    boundaryPriorities[prioritiesOpening + 4] = 0xFF;
    expect(baServices.getEventInformation.decodeAcknowledge(
      boundaryPriorities,
      0,
      boundaryPriorities.length
    ).events[0].eventPriorities).to.deep.equal([0, 0xFF, 3]);

    const invalidPriority = Buffer.concat([
      encoded.subarray(0, prioritiesOpening + 1),
      Buffer.from([0x22, 0x01, 0x00]),
      encoded.subarray(prioritiesOpening + 3)
    ]);
    expect(baServices.getEventInformation.decodeAcknowledge(
      invalidPriority,
      0,
      invalidPriority.length
    )).to.equal(undefined);

    [-1, 0x100, 1.5].forEach((priority) => {
      const buffer = utils.getBuffer();
      expect(() => baServices.getEventInformation.encodeAcknowledge(buffer, [{
        objectId: {type: 2, instance: 17},
        eventState: 3,
        acknowledgedTransitions: {value: [5], bitsUsed: 3},
        eventTimeStamps: [
          {value: timeStamp, type: baEnum.TimeStamp.TIME},
          {value: timeStamp, type: baEnum.TimeStamp.TIME},
          {value: timeStamp, type: baEnum.TimeStamp.TIME}
        ],
        notifyType: baEnum.NotifyType.ALARM,
        eventEnable: {value: [5], bitsUsed: 3},
        eventPriorities: [0, priority, 0xFF]
      }], false)).to.throw(RangeError);
      expect(buffer.offset).to.equal(0);
    });
  });

  it('requires exactly three acknowledged-transition and event-enable bits', () => {
    const {encoded, timeStamp} = encodeAcknowledge();
    const invalidAcknowledged = Buffer.from(encoded);
    const acknowledgedTag = invalidAcknowledged.indexOf(0x2A);
    invalidAcknowledged[acknowledgedTag + 1] = 4;
    expect(baServices.getEventInformation.decodeAcknowledge(
      invalidAcknowledged,
      0,
      invalidAcknowledged.length
    )).to.equal(undefined);

    ['acknowledgedTransitions', 'eventEnable'].forEach((fieldName) => {
      const buffer = utils.getBuffer();
      const event = {
        objectId: {type: 2, instance: 17},
        eventState: 3,
        acknowledgedTransitions: {value: [5], bitsUsed: 3},
        eventTimeStamps: [
          {value: timeStamp, type: baEnum.TimeStamp.TIME},
          {value: timeStamp, type: baEnum.TimeStamp.TIME},
          {value: timeStamp, type: baEnum.TimeStamp.TIME}
        ],
        notifyType: baEnum.NotifyType.ALARM,
        eventEnable: {value: [5], bitsUsed: 3},
        eventPriorities: [1, 2, 3]
      };
      event[fieldName] = {value: [5], bitsUsed: 4};

      expect(() => baServices.getEventInformation.encodeAcknowledge(
        buffer,
        [event],
        false
      )).to.throw(RangeError);
      expect(buffer.offset).to.equal(0);
    });
  });
});
