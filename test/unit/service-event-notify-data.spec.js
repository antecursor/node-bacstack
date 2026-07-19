'use strict';

const expect      = require('chai').expect;
const utils       = require('./utils');
const baServices  = require('../../lib/services');
const baEnum      = require('../../lib/enum');

describe('bacstack - Services layer EventNotifyData unit', () => {
  it('should successfully encode and decode a change of bitstring event', () => {
    const buffer = utils.getBuffer();
    const date = new Date();
    date.setMilliseconds(880);
    baServices.eventNotifyData.encode(buffer, {
      processId: 3,
      initiatingObjectId: {type: 60, instance: 12},
      eventObjectId: {type: 61, instance: 1121},
      timeStamp: {type: 2, value: date},
      notificationClass: 9,
      priority: 7,
      eventType: 0,
      messageText: 'Test1234$',
      notifyType: 1,
      ackRequired: true,
      fromState: 5,
      toState: 6,
      changeOfBitstringReferencedBitString: {bitsUsed: 24, value: [0xaa, 0xaa, 0xaa]},
      changeOfBitstringStatusFlags: {bitsUsed: 4, value: [0x0a]}
    });
    const result = baServices.eventNotifyData.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      processId: 3,
      initiatingObjectId: {type: 60, instance: 12},
      eventObjectId: {type: 61, instance: 1121},
      timeStamp: date,
      notificationClass: 9,
      priority: 7,
      eventType: 0,
      messageText: 'Test1234$',
      notifyType: 1,
      ackRequired: true,
      fromState: 5,
      toState: 6,
      changeOfBitstringReferencedBitString: {bitsUsed: 24, value: [0xaa, 0xaa, 0xaa]},
      changeOfBitstringStatusFlags: {bitsUsed: 4, value: [0x0a]}
    });
  });

  it('should successfully encode and decode a change of state event', () => {
    const buffer = utils.getBuffer();
    const date = new Date();
    date.setMilliseconds(880);
    baServices.eventNotifyData.encode(buffer, {
      processId: 3,
      initiatingObjectId: {},
      eventObjectId: {},
      timeStamp: {type: 2, value: date},
      notificationClass: 9,
      priority: 7,
      eventType: 1,
      messageText: 'Test1234$',
      notifyType: 1,
      ackRequired: false,
      fromState: 1,
      toState: 2,
      changeOfStateNewState: {type: 2, state: 2},
      changeOfStateStatusFlags: {bitsUsed: 4, value: [0x0a]}
    });
    const result = baServices.eventNotifyData.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      processId: 3,
      initiatingObjectId: {type: 0, instance: 0},
      eventObjectId: {type: 0, instance: 0},
      timeStamp: date,
      notificationClass: 9,
      priority: 7,
      eventType: 1,
      messageText: 'Test1234$',
      notifyType: 1,
      ackRequired: false,
      fromState: 1,
      toState: 2,
      changeOfStateNewState: {type: 2, state: 2},
      changeOfStateStatusFlags: {bitsUsed: 4, value: [0x0a]}
    });
  });

  it('should successfully encode and decode a change of value event', () => {
    const buffer = utils.getBuffer();
    const date = new Date();
    date.setMilliseconds(880);
    baServices.eventNotifyData.encode(buffer, {
      processId: 3,
      initiatingObjectId: {},
      eventObjectId: {},
      timeStamp: {type: 2, value: date},
      notificationClass: 9,
      priority: 7,
      eventType: 2,
      messageText: 'Test1234$',
      notifyType: 1,
      changeOfValueTag: baEnum.CovTypes.REAL,
      changeOfValueChangeValue: 90,
      changeOfValueStatusFlags: {bitsUsed: 4, value: [0x0a]}
    });
    const result = baServices.eventNotifyData.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      processId: 3,
      initiatingObjectId: {type: 0, instance: 0},
      eventObjectId: {type: 0, instance: 0},
      timeStamp: date,
      notificationClass: 9,
      priority: 7,
      eventType: 2,
      messageText: 'Test1234$',
      notifyType: 1,
      ackRequired: false,
      fromState: 0,
      toState: 0,
      changeOfValueTag: baEnum.CovTypes.REAL,
      changeOfValueChangeValue: 90,
      changeOfValueStatusFlags: {bitsUsed: 4, value: [0x0a]}
    });
  });

  it('should successfully encode and decode a floating limit event', () => {
    const buffer = utils.getBuffer();
    const date = new Date();
    date.setMilliseconds(880);
    baServices.eventNotifyData.encode(buffer, {
      processId: 3,
      initiatingObjectId: {},
      eventObjectId: {},
      timeStamp: {type: 2, value: date},
      notificationClass: 9,
      priority: 7,
      eventType: 4,
      messageText: 'Test1234$',
      notifyType: 1,
      ackRequired: true,
      fromState: 19,
      toState: 12,
      floatingLimitReferenceValue: 121,
      floatingLimitStatusFlags: {bitsUsed: 4, value: [0x0a]},
      floatingLimitSetPointValue: 120,
      floatingLimitErrorLimit: 120
    });
    const result = baServices.eventNotifyData.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      processId: 3,
      initiatingObjectId: {type: 0, instance: 0},
      eventObjectId: {type: 0, instance: 0},
      timeStamp: date,
      notificationClass: 9,
      priority: 7,
      eventType: 4,
      messageText: 'Test1234$',
      notifyType: 1,
      ackRequired: true,
      fromState: 19,
      toState: 12,
      floatingLimitReferenceValue: 121,
      floatingLimitStatusFlags: {bitsUsed: 4, value: [0x0a]},
      floatingLimitSetPointValue: 120,
      floatingLimitErrorLimit: 120
    });
  });

  it('should successfully encode and decode an out of range event', () => {
    const buffer = utils.getBuffer();
    const date = new Date();
    date.setMilliseconds(880);
    baServices.eventNotifyData.encode(buffer, {
      processId: 3,
      initiatingObjectId: {},
      eventObjectId: {},
      timeStamp: {type: 2, value: date},
      notificationClass: 9,
      priority: 7,
      eventType: 5,
      messageText: 'Test1234$',
      notifyType: 1,
      outOfRangeExceedingValue: 155,
      outOfRangeStatusFlags: {bitsUsed: 4, value: [0x0a]},
      outOfRangeDeadband: 50,
      outOfRangeExceededLimit: 150
    });
    const result = baServices.eventNotifyData.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      processId: 3,
      initiatingObjectId: {type: 0, instance: 0},
      eventObjectId: {type: 0, instance: 0},
      timeStamp: date,
      notificationClass: 9,
      priority: 7,
      eventType: 5,
      messageText: 'Test1234$',
      notifyType: 1,
      ackRequired: false,
      fromState: 0,
      toState: 0,
      outOfRangeExceedingValue: 155,
      outOfRangeStatusFlags: {bitsUsed: 4, value: [0x0a]},
      outOfRangeDeadband: 50,
      outOfRangeExceededLimit: 150
    });
  });

  it('should successfully encode and decode a change of life-safety event', () => {
    const buffer = utils.getBuffer();
    const date = new Date();
    date.setMilliseconds(880);
    baServices.eventNotifyData.encode(buffer, {
      processId: 3,
      initiatingObjectId: {},
      eventObjectId: {},
      timeStamp: {type: 2, value: date},
      notificationClass: 9,
      priority: 7,
      eventType: 8,
      messageText: 'Test1234$',
      notifyType: 1,
      changeOfLifeSafetyNewState: 8,
      changeOfLifeSafetyNewMode: 9,
      changeOfLifeSafetyStatusFlags: {bitsUsed: 4, value: [0x0a]},
      changeOfLifeSafetyOperationExpected: 2
    });
    const result = baServices.eventNotifyData.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      processId: 3,
      initiatingObjectId: {type: 0, instance: 0},
      eventObjectId: {type: 0, instance: 0},
      timeStamp: date,
      notificationClass: 9,
      priority: 7,
      eventType: 8,
      messageText: 'Test1234$',
      notifyType: 1,
      ackRequired: false,
      fromState: 0,
      toState: 0,
      changeOfLifeSafetyNewState: 8,
      changeOfLifeSafetyNewMode: 9,
      changeOfLifeSafetyStatusFlags: {bitsUsed: 4, value: [0x0a]},
      changeOfLifeSafetyOperationExpected: 2
    });
  });

  it('should successfully encode and decode a buffer ready event', () => {
    const buffer = utils.getBuffer();
    const date = new Date();
    date.setMilliseconds(880);
    baServices.eventNotifyData.encode(buffer, {
      processId: 3,
      initiatingObjectId: {},
      eventObjectId: {},
      timeStamp: {type: 2, value: date},
      notificationClass: 9,
      priority: 7,
      eventType: 10,
      messageText: 'Test1234$',
      notifyType: 1,
      bufferReadyBufferProperty: {
        objectId: {type: 65, instance: 2},
        id: 85,
        arrayIndex: 3,
        deviceIndentifier: {type: 8, instance: 443}
      },
      bufferReadyPreviousNotification: 121,
      bufferReadyCurrentNotification: 281
    });
    const result = baServices.eventNotifyData.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      processId: 3,
      initiatingObjectId: {type: 0, instance: 0},
      eventObjectId: {type: 0, instance: 0},
      timeStamp: date,
      notificationClass: 9,
      priority: 7,
      eventType: 10,
      messageText: 'Test1234$',
      notifyType: 1,
      ackRequired: false,
      fromState: 0,
      toState: 0,
      bufferReadyBufferProperty: {
        objectId: {type: 65, instance: 2},
        id: 85,
        arrayIndex: 3,
        deviceIndentifier: {type: 8, instance: 443}
      },
      bufferReadyPreviousNotification: 121,
      bufferReadyCurrentNotification: 281
    });
  });

  it('should successfully encode and decode a unsigned range event', () => {
    const buffer = utils.getBuffer();
    const date = new Date();
    date.setMilliseconds(880);
    baServices.eventNotifyData.encode(buffer, {
      processId: 3,
      initiatingObjectId: {},
      eventObjectId: {},
      timeStamp: {type: 2, value: date},
      notificationClass: 9,
      priority: 7,
      eventType: 11,
      messageText: 'Test1234$',
      notifyType: 1,
      unsignedRangeExceedingValue: 101,
      unsignedRangeStatusFlags: {bitsUsed: 4, value: [0x0a]},
      unsignedRangeExceededLimit: 100
    });
    const result = baServices.eventNotifyData.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      processId: 3,
      initiatingObjectId: {type: 0, instance: 0},
      eventObjectId: {type: 0, instance: 0},
      timeStamp: date,
      notificationClass: 9,
      priority: 7,
      eventType: 11,
      messageText: 'Test1234$',
      notifyType: 1,
      ackRequired: false,
      fromState: 0,
      toState: 0,
      unsignedRangeExceedingValue: 101,
      unsignedRangeStatusFlags: {bitsUsed: 4, value: [0x0a]},
      unsignedRangeExceededLimit: 100
    });
  });

  it('should consume unsupported or invalid Message Text characters', () => {
    const makePayload = () => {
      const buffer = utils.getBuffer();
      const date = new Date(2024, 0, 2, 3, 4, 5, 60);
      baServices.eventNotifyData.encode(buffer, {
        processId: 3,
        initiatingObjectId: {type: 8, instance: 12},
        eventObjectId: {type: 0, instance: 1121},
        timeStamp: {type: baEnum.TimeStamp.DATETIME, value: date},
        notificationClass: 9,
        priority: 7,
        eventType: baEnum.EventType.CHANGE_OF_BITSTRING,
        messageText: 'A',
        notifyType: baEnum.NotifyType.EVENT,
        ackRequired: true,
        fromState: 5,
        toState: 0,
        changeOfBitstringReferencedBitString: {bitsUsed: 1, value: [1]},
        changeOfBitstringStatusFlags: {bitsUsed: 4, value: [1]}
      });
      return Buffer.from(buffer.buffer.subarray(0, buffer.offset));
    };

    const unsupported = makePayload();
    const messageOffset = unsupported.indexOf(Buffer.from([0x7A, 0x00, 0x41]));
    expect(messageOffset).to.be.at.least(0);
    unsupported[messageOffset + 1] = baEnum.CharacterStringEncoding.MICROSOFT_DBCS;
    expect(baServices.eventNotifyData.decode(unsupported, 0, unsupported.length))
      .to.include({messageText: '', len: unsupported.length});

    const invalid = makePayload();
    invalid[messageOffset + 2] = 0xC0;
    expect(baServices.eventNotifyData.decode(invalid, 0, invalid.length))
      .to.include({messageText: '', len: invalid.length});
  });

  it('should enforce every declared EventNotifyData boundary', () => {
    const buffer = utils.getBuffer();
    const date = new Date(2024, 0, 2, 3, 4, 5, 60);
    baServices.eventNotifyData.encode(buffer, {
      processId: 3,
      initiatingObjectId: {type: 8, instance: 12},
      eventObjectId: {type: 0, instance: 1121},
      timeStamp: {type: baEnum.TimeStamp.DATETIME, value: date},
      notificationClass: 9,
      priority: 7,
      eventType: baEnum.EventType.UNSIGNED_RANGE,
      messageText: 'bounded',
      notifyType: baEnum.NotifyType.EVENT,
      ackRequired: false,
      fromState: 0,
      toState: 2,
      unsignedRangeExceedingValue: 101,
      unsignedRangeStatusFlags: {bitsUsed: 4, value: [5]},
      unsignedRangeExceededLimit: 100
    });
    const payload = Buffer.from(buffer.buffer.subarray(0, buffer.offset));

    for (let length = 0; length < payload.length; length++) {
      const longerBacking = Buffer.concat([payload, Buffer.from([0xEE])]);
      expect(() => baServices.eventNotifyData.decode(longerBacking, 0, length)).not.to.throw();
      expect(baServices.eventNotifyData.decode(longerBacking, 0, length)).to.equal(undefined);
    }

    const displaced = Buffer.concat([Buffer.from([0xAA]), payload, Buffer.from([0xEE])]);
    expect(baServices.eventNotifyData.decode(displaced, 1, payload.length))
      .to.include({len: payload.length});
    expect(baServices.eventNotifyData.decode(displaced, 1, payload.length + 1))
      .to.equal(undefined);
  });

  it('requires exactly four BACnetStatusFlags bits on encode and decode', () => {
    const buffer = utils.getBuffer();
    const data = {
      processId: 3,
      initiatingObjectId: {type: 8, instance: 12},
      eventObjectId: {type: 0, instance: 1121},
      timeStamp: {type: baEnum.TimeStamp.SEQUENCE_NUMBER, value: 7},
      notificationClass: 9,
      priority: 7,
      eventType: baEnum.EventType.UNSIGNED_RANGE,
      notifyType: baEnum.NotifyType.EVENT,
      ackRequired: false,
      fromState: 0,
      toState: 2,
      unsignedRangeExceedingValue: 101,
      unsignedRangeStatusFlags: {bitsUsed: 4, value: [5]},
      unsignedRangeExceededLimit: 100
    };
    baServices.eventNotifyData.encode(buffer, data);
    const malformed = Buffer.from(buffer.buffer.subarray(0, buffer.offset));
    const statusTag = malformed.lastIndexOf(0x1A);
    malformed[statusTag + 1] = 3;
    expect(baServices.eventNotifyData.decode(malformed, 0, malformed.length)).to.equal(undefined);

    const invalid = Object.assign({}, data, {
      unsignedRangeStatusFlags: {bitsUsed: 3, value: [5]}
    });
    const destination = utils.getBuffer();
    expect(() => baServices.eventNotifyData.encode(destination, invalid)).to.throw(RangeError);
    expect(destination.offset).to.equal(0);
  });
});
