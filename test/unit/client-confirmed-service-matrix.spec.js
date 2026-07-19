'use strict';

const expect = require('chai').expect;

const Client = require('../../lib/client');
const baEnum = require('../../lib/enum');
const baServices = require('../../lib/services');

const encode = (callback) => {
  const writer = {buffer: Buffer.alloc(4096), offset: 0};
  callback(writer);
  return Buffer.from(writer.buffer.subarray(0, writer.offset));
};

const applicationUnsigned = (value) => ({
  type: baEnum.ApplicationTags.UNSIGNED_INTEGER,
  value: value
});

const propertyValue = (id, index, value, priority) => ({
  property: {id: id, index: index},
  value: [applicationUnsigned(value)],
  priority: priority
});

const confirmedServiceCases = () => {
  const objectId = {type: baEnum.ObjectType.ANALOG_VALUE, instance: 17};
  const propertyId = baEnum.PropertyIdentifier.PRESENT_VALUE;
  const arrayIndex = 2;
  const timestamp = new Date(2024, 0, 2, 3, 4, 5, 60);
  const statusFlags = {bitsUsed: 4, value: [0x05]};

  return [
    {
      name: 'ReadProperty',
      service: baEnum.ConfirmedServiceChoice.READ_PROPERTY,
      payload: encode((writer) => baServices.readProperty.encode(
        writer, objectId.type, objectId.instance, propertyId, arrayIndex
      ))
    },
    {
      name: 'WriteProperty',
      service: baEnum.ConfirmedServiceChoice.WRITE_PROPERTY,
      payload: encode((writer) => baServices.writeProperty.encode(
        writer,
        objectId.type,
        objectId.instance,
        propertyId,
        arrayIndex,
        8,
        [applicationUnsigned(42)]
      ))
    },
    {
      name: 'ReadPropertyMultiple',
      service: baEnum.ConfirmedServiceChoice.READ_PROPERTY_MULTIPLE,
      payload: encode((writer) => baServices.readPropertyMultiple.encode(writer, [{
        objectId: objectId,
        properties: [
          {id: propertyId, index: baEnum.ASN1_ARRAY_ALL},
          {id: baEnum.PropertyIdentifier.STATUS_FLAGS, index: arrayIndex}
        ]
      }]))
    },
    {
      name: 'WritePropertyMultiple',
      service: baEnum.ConfirmedServiceChoice.WRITE_PROPERTY_MULTIPLE,
      payload: encode((writer) => baServices.writePropertyMultiple.encode(
        writer,
        objectId,
        [
          propertyValue(propertyId, arrayIndex, 42, 8),
          propertyValue(baEnum.PropertyIdentifier.COV_INCREMENT, baEnum.ASN1_ARRAY_ALL, 3)
        ]
      ))
    },
    {
      name: 'ConfirmedCOVNotification',
      service: baEnum.ConfirmedServiceChoice.CONFIRMED_COV_NOTIFICATION,
      payload: encode((writer) => baServices.covNotify.encode(
        writer,
        7,
        443,
        objectId,
        120,
        [propertyValue(propertyId, arrayIndex, 42, 8)]
      ))
    },
    {
      name: 'AtomicWriteFile',
      service: baEnum.ConfirmedServiceChoice.ATOMIC_WRITE_FILE,
      payload: encode((writer) => baServices.atomicWriteFile.encode(
        writer,
        false,
        {type: baEnum.ObjectType.FILE, instance: 51},
        5,
        [Buffer.from([1, 2]), Buffer.from([3, 4, 5])]
      ))
    },
    {
      name: 'AtomicReadFile',
      service: baEnum.ConfirmedServiceChoice.ATOMIC_READ_FILE,
      payload: encode((writer) => baServices.atomicReadFile.encode(
        writer,
        false,
        {type: baEnum.ObjectType.FILE, instance: 51},
        5,
        2
      ))
    },
    {
      name: 'SubscribeCOV',
      service: baEnum.ConfirmedServiceChoice.SUBSCRIBE_COV,
      payload: encode((writer) => baServices.subscribeCov.encode(
        writer, 11, objectId, false, true, 5000
      ))
    },
    {
      name: 'SubscribeCOVProperty',
      service: baEnum.ConfirmedServiceChoice.SUBSCRIBE_COV_PROPERTY,
      payload: encode((writer) => baServices.subscribeProperty.encode(
        writer,
        12,
        objectId,
        false,
        true,
        5000,
        {id: propertyId, index: arrayIndex},
        true,
        1.5
      ))
    },
    {
      name: 'DeviceCommunicationControl',
      service: baEnum.ConfirmedServiceChoice.DEVICE_COMMUNICATION_CONTROL,
      payload: encode((writer) => baServices.deviceCommunicationControl.encode(
        writer, 30, 1, 'release-gate'
      ))
    },
    {
      name: 'ReinitializeDevice',
      service: baEnum.ConfirmedServiceChoice.REINITIALIZE_DEVICE,
      payload: encode((writer) => baServices.reinitializeDevice.encode(
        writer, 5, 'release-gate'
      ))
    },
    {
      name: 'ConfirmedEventNotification',
      service: baEnum.ConfirmedServiceChoice.CONFIRMED_EVENT_NOTIFICATION,
      payload: encode((writer) => baServices.eventNotifyData.encode(writer, {
        processId: 3,
        initiatingObjectId: {type: baEnum.ObjectType.DEVICE, instance: 12},
        eventObjectId: objectId,
        timeStamp: {type: baEnum.TimeStamp.DATETIME, value: timestamp},
        notificationClass: 9,
        priority: 7,
        eventType: baEnum.EventType.UNSIGNED_RANGE,
        messageText: 'release gate',
        notifyType: baEnum.NotifyType.EVENT,
        ackRequired: true,
        fromState: baEnum.EventState.NORMAL,
        toState: baEnum.EventState.OFFNORMAL,
        unsignedRangeExceedingValue: 101,
        unsignedRangeStatusFlags: statusFlags,
        unsignedRangeExceededLimit: 100
      }))
    },
    {
      name: 'ReadRange',
      service: baEnum.ConfirmedServiceChoice.READ_RANGE,
      payload: encode((writer) => baServices.readRange.encode(
        writer,
        {type: baEnum.ObjectType.TREND_LOG, instance: 7},
        baEnum.PropertyIdentifier.LOG_BUFFER,
        arrayIndex,
        baEnum.ReadRangeType.BY_TIME_REFERENCE_TIME_COUNT,
        null,
        timestamp,
        -32
      ))
    },
    {
      name: 'CreateObject',
      service: baEnum.ConfirmedServiceChoice.CREATE_OBJECT,
      payload: encode((writer) => baServices.createObject.encode(
        writer,
        objectId,
        [propertyValue(propertyId, arrayIndex, 42, 8)]
      ))
    },
    {
      name: 'DeleteObject',
      service: baEnum.ConfirmedServiceChoice.DELETE_OBJECT,
      payload: encode((writer) => baServices.deleteObject.encode(writer, objectId))
    },
    {
      name: 'AcknowledgeAlarm',
      service: baEnum.ConfirmedServiceChoice.ACKNOWLEDGE_ALARM,
      payload: encode((writer) => baServices.alarmAcknowledge.encode(
        writer,
        57,
        objectId,
        baEnum.EventState.OFFNORMAL,
        'release gate',
        {type: baEnum.TimeStamp.DATETIME, value: timestamp},
        {type: baEnum.TimeStamp.SEQUENCE_NUMBER, value: 19}
      ))
    },
    {
      name: 'GetAlarmSummary',
      service: baEnum.ConfirmedServiceChoice.GET_ALARM_SUMMARY,
      payload: Buffer.alloc(0)
    },
    {
      name: 'GetEnrollmentSummary',
      service: baEnum.ConfirmedServiceChoice.GET_ENROLLMENT_SUMMARY,
      payload: encode((writer) => baServices.getEnrollmentSummary.encode(
        writer,
        2,
        {objectId: objectId, processId: 7},
        baEnum.EventState.OFFNORMAL,
        baEnum.EventType.OUT_OF_RANGE,
        {min: 1, max: 65},
        5
      ))
    },
    {
      name: 'GetEventInformation',
      service: baEnum.ConfirmedServiceChoice.GET_EVENT_INFORMATION,
      payload: encode((writer) => baServices.getEventInformation.encode(writer, objectId))
    },
    {
      name: 'LifeSafetyOperation',
      service: baEnum.ConfirmedServiceChoice.LIFE_SAFETY_OPERATION,
      payload: encode((writer) => baServices.lifeSafetyOperation.encode(
        writer, 8, 'release gate', 7, objectId
      ))
    },
    {
      name: 'AddListElement',
      service: baEnum.ConfirmedServiceChoice.ADD_LIST_ELEMENT,
      payload: encode((writer) => baServices.addListElement.encode(
        writer,
        objectId,
        propertyId,
        arrayIndex,
        [applicationUnsigned(42), applicationUnsigned(43)]
      ))
    },
    {
      name: 'RemoveListElement',
      service: baEnum.ConfirmedServiceChoice.REMOVE_LIST_ELEMENT,
      payload: encode((writer) => baServices.addListElement.encode(
        writer,
        objectId,
        propertyId,
        arrayIndex,
        [applicationUnsigned(42), applicationUnsigned(43)]
      ))
    },
    {
      name: 'ConfirmedPrivateTransfer',
      service: baEnum.ConfirmedServiceChoice.CONFIRMED_PRIVATE_TRANSFER,
      payload: encode((writer) => baServices.privateTransfer.encode(
        writer, 255, 8, Buffer.from([0, 127, 255])
      ))
    }
  ];
};

describe('bacstack - confirmed service decoder matrix', () => {
  const client = Object.create(Client.prototype);
  const cases = confirmedServiceCases();
  const prepare = (testCase, buffer, offset, length) =>
    client._prepareConfirmedServiceRequest(
      testCase.service,
      baEnum.MaxSegmentsAccepted.SEGMENTS_8,
      baEnum.MaxApduLengthAccepted.OCTETS_1476,
      buffer,
      offset,
      length
    );

  it('covers every inbound confirmed-service definition exactly once', () => {
    expect(cases).to.have.length(23);
    expect(new Set(cases.map((testCase) => testCase.service)).size).to.equal(cases.length);
  });

  cases.forEach((testCase) => {
    it(`fully consumes an encoder-produced ${testCase.name} payload`, () => {
      const wrapped = Buffer.concat([
        Buffer.from([0xAA]),
        testCase.payload,
        Buffer.from([0xBB])
      ]);

      const prepared = prepare(testCase, wrapped, 1, testCase.payload.length);

      expect(prepared.status).to.equal('ready');
      if (prepared.result) expect(prepared.result.len).to.equal(testCase.payload.length);
    });

    it(`rejects a trailing byte after ${testCase.name}`, () => {
      const trailing = Buffer.concat([testCase.payload, Buffer.from([0x00])]);

      expect(prepare(testCase, trailing, 0, trailing.length).status).to.equal('malformed');
    });
  });
});
