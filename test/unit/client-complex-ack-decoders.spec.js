'use strict';

const EventEmitter = require('events').EventEmitter;
const expect = require('chai').expect;
const Client = require('../../lib/client');
const baApdu = require('../../lib/apdu');
const baBvlc = require('../../lib/bvlc');
const baEnum = require('../../lib/enum');
const baNpdu = require('../../lib/npdu');
const baServices = require('../../lib/services');

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

  send(buffer, offset) {
    this.sent.push(Buffer.from(buffer.subarray(0, offset)));
  }
}

const decodeRequest = (packet) => {
  const bvlc = baBvlc.decode(packet, 0);
  const npdu = baNpdu.decode(packet, bvlc.len, packet.length - bvlc.len);
  const offset = bvlc.len + npdu.len;
  return baApdu.decodeConfirmedServiceRequest(packet, offset, packet.length - offset);
};

const encodeComplexAck = (service, invokeId, encodePayload) => {
  const packet = Buffer.alloc(2048);
  const writer = {buffer: packet, offset: baEnum.BVLC_HEADER_LENGTH};
  baNpdu.encode(writer, baEnum.NpduControlPriority.NORMAL_MESSAGE);
  baApdu.encodeComplexAck(writer, baEnum.PduTypes.COMPLEX_ACK, service, invokeId);
  encodePayload(writer);
  baBvlc.encode(packet, baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU, writer.offset);
  return Buffer.from(packet.subarray(0, writer.offset));
};

const deliverLastResponse = (transport, service, encodePayload) => {
  const request = decodeRequest(transport.sent[transport.sent.length - 1]);
  const response = encodeComplexAck(service, request.invokeId, encodePayload);
  transport.emit('message', response, '192.0.2.1', 47808);
};

describe('bacstack - public ComplexACK decoders', () => {
  it('returns the object identifier assigned by CreateObject', (next) => {
    const transport = new FakeTransport();
    const client = new Client({transport: transport});
    const assignedObjectId = {type: baEnum.ObjectType.ANALOG_VALUE, instance: 47};

    client.createObject(
      '192.0.2.1',
      {type: baEnum.ObjectType.ANALOG_VALUE},
      [],
      (err, result) => {
        expect(err).to.equal(null);
        expect(result.objectId).to.deep.equal(assignedObjectId);
        client.close();
        next();
      }
    );
    deliverLastResponse(
      transport,
      baEnum.ConfirmedServiceChoice.CREATE_OBJECT,
      (writer) => baServices.createObject.encodeAcknowledge(writer, assignedObjectId)
    );
  });

  it('returns a decoded GetEventInformation acknowledgement', (next) => {
    const transport = new FakeTransport();
    const client = new Client({transport: transport});
    const timestamp = new Date(1, 1, 1, 3, 4, 5, 60);
    const events = [{
      objectId: {type: baEnum.ObjectType.ANALOG_INPUT, instance: 17},
      eventState: baEnum.EventState.OFFNORMAL,
      acknowledgedTransitions: {value: [5], bitsUsed: 3},
      eventTimeStamps: [
        {value: timestamp, type: baEnum.TimeStamp.DATETIME},
        {value: 5, type: baEnum.TimeStamp.SEQUENCE_NUMBER},
        {value: timestamp, type: baEnum.TimeStamp.TIME}
      ],
      notifyType: baEnum.NotifyType.EVENT,
      eventEnable: {value: [5], bitsUsed: 3},
      eventPriorities: [1, 2, 3]
    }];

    client.getEventInformation('192.0.2.1', (err, result) => {
      expect(err).to.equal(null);
      expect(result).to.include({moreEvents: true});
      expect(result.events).to.deep.equal(events);
      client.close();
      next();
    });
    deliverLastResponse(
      transport,
      baEnum.ConfirmedServiceChoice.GET_EVENT_INFORMATION,
      (writer) => baServices.getEventInformation.encodeAcknowledge(writer, events, true)
    );
  });

  it('returns a decoded GetAlarmSummary acknowledgement', (next) => {
    const transport = new FakeTransport();
    const client = new Client({transport: transport});
    const alarms = [{
      objectId: {type: baEnum.ObjectType.ANALOG_INPUT, instance: 21},
      alarmState: baEnum.EventState.OFFNORMAL,
      acknowledgedTransitions: {value: [5], bitsUsed: 3}
    }];

    client.getAlarmSummary('192.0.2.1', (err, result) => {
      expect(err).to.equal(null);
      expect(result.alarms).to.deep.equal(alarms);
      client.close();
      next();
    });
    deliverLastResponse(
      transport,
      baEnum.ConfirmedServiceChoice.GET_ALARM_SUMMARY,
      (writer) => baServices.alarmSummary.encode(writer, alarms)
    );
  });

  it('returns a decoded ConfirmedPrivateTransfer acknowledgement', (next) => {
    const transport = new FakeTransport();
    const client = new Client({transport: transport});

    client.confirmedPrivateTransfer(
      '192.0.2.1',
      255,
      8,
      Buffer.from([1]),
      (err, result) => {
        expect(err).to.equal(null);
        expect(result).to.include({vendorId: 255, serviceNumber: 9});
        expect(result.data).to.deep.equal(Buffer.from([0, 127, 255]));
        client.close();
        next();
      }
    );
    deliverLastResponse(
      transport,
      baEnum.ConfirmedServiceChoice.CONFIRMED_PRIVATE_TRANSFER,
      (writer) => baServices.privateTransfer.encode(writer, 255, 9, Buffer.from([0, 127, 255]))
    );
  });
});
