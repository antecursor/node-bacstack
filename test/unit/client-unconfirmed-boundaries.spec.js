'use strict';

const EventEmitter = require('events').EventEmitter;
const expect = require('chai').expect;

const Client = require('../../lib/client');
const baBvlc = require('../../lib/bvlc');
const baEnum = require('../../lib/enum');
const baServices = require('../../lib/services');

const encode = (callback) => {
  const writer = {buffer: Buffer.alloc(4096), offset: 0};
  callback(writer);
  return Buffer.from(writer.buffer.subarray(0, writer.offset));
};

const objectId = {type: baEnum.ObjectType.ANALOG_VALUE, instance: 17};
const timestamp = new Date(2024, 0, 2, 3, 4, 5, 60);
const statusFlags = {bitsUsed: 4, value: [0x05]};
const propertyValues = [{
  property: {id: baEnum.PropertyIdentifier.PRESENT_VALUE, index: baEnum.ASN1_ARRAY_ALL},
  value: [{type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 42}],
  priority: baEnum.ASN1_NO_PRIORITY
}];
const eventNotification = {
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
};

class FakeTransport extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  getAddressKind() {
    return 'ip';
  }

  getBroadcastAddress() {
    return '255.255.255.255';
  }

  getMaxPayload() {
    return 1482;
  }

  open() {}

  close() {}

  send(buffer, offset, receiver) {
    this.sent.push({
      buffer: Buffer.from(buffer.subarray(0, offset)),
      receiver: receiver
    });
    return true;
  }
}

const unconfirmedServiceCases = () => [
  {
    name: 'I-Am',
    event: 'iAm',
    service: baEnum.UnconfirmedServiceChoice.I_AM,
    payload: encode((writer) => baServices.iAmBroadcast.encode(
      writer, 12, 1476, baEnum.Segmentation.NO_SEGMENTATION, 999
    ))
  },
  {
    name: 'Who-Is',
    event: 'whoIs',
    service: baEnum.UnconfirmedServiceChoice.WHO_IS,
    payload: encode((writer) => baServices.whoIs.encode(writer))
  },
  {
    name: 'Who-Has',
    event: 'whoHas',
    service: baEnum.UnconfirmedServiceChoice.WHO_HAS,
    payload: encode((writer) => baServices.whoHas.encode(writer, null, null, objectId))
  },
  {
    name: 'UnconfirmedCOVNotification',
    event: 'covNotifyUnconfirmed',
    service: baEnum.UnconfirmedServiceChoice.UNCONFIRMED_COV_NOTIFICATION,
    payload: encode((writer) => baServices.covNotify.encode(
      writer, 7, 12, objectId, 120, propertyValues
    ))
  },
  {
    name: 'TimeSynchronization',
    event: 'timeSync',
    service: baEnum.UnconfirmedServiceChoice.TIME_SYNCHRONIZATION,
    payload: encode((writer) => baServices.timeSync.encode(writer, timestamp))
  },
  {
    name: 'UtcTimeSynchronization',
    event: 'timeSyncUTC',
    service: baEnum.UnconfirmedServiceChoice.UTC_TIME_SYNCHRONIZATION,
    payload: encode((writer) => baServices.timeSync.encodeUTC(writer, timestamp))
  },
  {
    name: 'UnconfirmedEventNotification',
    event: 'eventNotify',
    service: baEnum.UnconfirmedServiceChoice.UNCONFIRMED_EVENT_NOTIFICATION,
    payload: encode((writer) => baServices.eventNotifyData.encode(writer, eventNotification))
  },
  {
    name: 'I-Have',
    event: 'iHave',
    service: baEnum.UnconfirmedServiceChoice.I_HAVE,
    payload: encode((writer) => baServices.iHaveBroadcast.encode(
      writer,
      {type: baEnum.ObjectType.DEVICE, instance: 12},
      objectId,
      'release-gate-object'
    ))
  },
  {
    name: 'UnconfirmedPrivateTransfer',
    event: 'privateTransfer',
    service: baEnum.UnconfirmedServiceChoice.UNCONFIRMED_PRIVATE_TRANSFER,
    payload: encode((writer) => baServices.privateTransfer.encode(
      writer, 999, 8, Buffer.from([0, 127, 255])
    ))
  }
];

describe('bacstack - unconfirmed service boundaries', () => {
  const clients = [];

  const createClient = () => {
    const transport = new FakeTransport();
    const client = new Client({transport: transport});
    clients.push(client);
    return {client: client, transport: transport};
  };

  afterEach(() => {
    while (clients.length > 0) clients.pop().close();
  });

  const cases = unconfirmedServiceCases();

  it('covers every supported inbound unconfirmed service exactly once', () => {
    expect(cases).to.have.length(9);
    expect(new Set(cases.map((testCase) => testCase.service)).size).to.equal(cases.length);
  });

  cases.forEach((testCase) => {
    it(`publishes an exact encoder-produced ${testCase.name} payload`, () => {
      const runtime = createClient();
      const wrapped = Buffer.concat([
        Buffer.from([0xAA]),
        testCase.payload,
        Buffer.from([0xBB])
      ]);
      let emitted = 0;
      runtime.client.on(testCase.event, () => emitted++);

      runtime.client._processUnconfirmedServiceRequest(
        '192.0.2.10',
        baEnum.PduTypes.UNCONFIRMED_REQUEST,
        testCase.service,
        wrapped,
        1,
        testCase.payload.length
      );

      expect(emitted).to.equal(1);
    });

    it(`rejects a trailing byte after ${testCase.name}`, () => {
      const runtime = createClient();
      const trailing = Buffer.concat([testCase.payload, Buffer.from([0x00])]);
      let emitted = 0;
      runtime.client.on(testCase.event, () => emitted++);

      runtime.client._processUnconfirmedServiceRequest(
        '192.0.2.10',
        baEnum.PduTypes.UNCONFIRMED_REQUEST,
        testCase.service,
        trailing,
        0,
        trailing.length
      );

      expect(emitted).to.equal(0);
    });
  });

  [
    {
      name: 'UnconfirmedPrivateTransfer',
      send: (client, address) => client.unconfirmedPrivateTransfer(
        address, 999, 8, Buffer.from([0, 127, 255])
      )
    },
    {
      name: 'UnconfirmedEventNotification',
      send: (client, address) => client.unconfirmedEventNotification(
        address, eventNotification
      )
    }
  ].forEach((testCase) => {
    it(`encodes ${testCase.name} as a BACnet/IP broadcast for a broadcast target`, () => {
      const runtime = createClient();

      testCase.send(runtime.client, '255.255.255.255');

      expect(runtime.transport.sent).to.have.length(1);
      expect(runtime.transport.sent[0].receiver).to.equal('255.255.255.255');
      expect(baBvlc.decode(runtime.transport.sent[0].buffer, 0).func)
        .to.equal(baEnum.BvlcResultPurpose.ORIGINAL_BROADCAST_NPDU);
    });

    it(`retains ${testCase.name} unicast framing for a unicast target`, () => {
      const runtime = createClient();

      testCase.send(runtime.client, '192.0.2.10');

      expect(runtime.transport.sent).to.have.length(1);
      expect(runtime.transport.sent[0].receiver).to.equal('192.0.2.10');
      expect(baBvlc.decode(runtime.transport.sent[0].buffer, 0).func)
        .to.equal(baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU);
    });
  });
});
