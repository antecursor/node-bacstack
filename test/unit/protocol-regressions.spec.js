'use strict';

const EventEmitter = require('events').EventEmitter;
const expect = require('chai').expect;

const Client = require('../../lib/client');
const baAsn1 = require('../../lib/asn1');
const baEnum = require('../../lib/enum');
const baServices = require('../../lib/services');
const utils = require('./utils');

class CaptureTransport extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
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
    this.sent.push({buffer: Buffer.from(buffer.subarray(0, offset)), receiver: receiver});
  }
}

const createClient = () => {
  const transport = new CaptureTransport();
  const client = new Client({transport: transport});
  return {client: client, transport: transport};
};

describe('BACnet protocol regression vectors', () => {
  describe('date and time', () => {
    it('encodes and decodes the BACnet one-based wire month', () => {
      const buffer = utils.getBuffer();
      const value = new Date(2026, 0, 15);
      const golden = Buffer.from([0xA4, 0x7E, 0x01, 0x0F, 0x04]);

      baAsn1.encodeApplicationDate(buffer, value);

      expect(buffer.buffer.subarray(0, buffer.offset)).to.deep.equal(golden);
      expect(baAsn1.decodeApplicationDate(golden, 0).value.value).to.deep.equal(value);
    });

    it('uses UTC fields for a UTC time synchronization value', () => {
      const previousTimezone = process.env.TZ;
      process.env.TZ = 'America/New_York';
      try {
        const utcBuffer = utils.getBuffer();
        const localBuffer = utils.getBuffer();
        const value = new Date('2026-07-18T03:04:05.670Z');
        const utcGolden = Buffer.from('a47e071206b403040543', 'hex');
        const localGolden = Buffer.from('a47e071105b417040543', 'hex');

        baServices.timeSync.encodeUTC(utcBuffer, value);
        baServices.timeSync.encode(localBuffer, value);

        expect(utcBuffer.buffer.subarray(0, utcBuffer.offset)).to.deep.equal(utcGolden);
        expect(localBuffer.buffer.subarray(0, localBuffer.offset)).to.deep.equal(localGolden);
        expect(baServices.timeSync.decodeUTC(utcGolden, 0, utcGolden.length).value).to.deep.equal(value);
      } finally {
        if (previousTimezone === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = previousTimezone;
        }
      }
    });
  });

  describe('ReadRange by time', () => {
    const golden = Buffer.from('0c0500000119837ea47e071206b40304054331fe7f', 'hex');
    const value = new Date(2026, 6, 18, 3, 4, 5, 670);

    it('decodes a modern four-digit year', () => {
      const result = baServices.readRange.decode(golden, 0, golden.length);

      expect(result.time).to.deep.equal(value);
      expect(result.time.getFullYear()).to.equal(2026);
    });

    it('encodes the independent golden vector', () => {
      const buffer = utils.getBuffer();

      baServices.readRange.encode(buffer, {type: 20, instance: 1}, 131, baEnum.ASN1_ARRAY_ALL, baEnum.ReadRangeType.BY_TIME_REFERENCE_TIME_COUNT, null, value, -2);

      expect(buffer.buffer.subarray(0, buffer.offset)).to.deep.equal(golden);
    });
  });

  describe('COV property references', () => {
    const golden = Buffer.from('09071c020001bb2c0080000c39784e095519002e21012f39084f', 'hex');
    const values = [{
      property: {id: 85, index: 0},
      value: [{type: baEnum.ApplicationTags.UNSIGNED_INTEGER, value: 1}],
      priority: 8
    }];

    it('decodes array index zero and priority eight', () => {
      const result = baServices.covNotify.decode(golden, 0, golden.length);

      expect(result.len).to.equal(golden.length);
      expect(result.values).to.deep.equal(values);
    });

    it('encodes array index zero and priority eight', () => {
      const buffer = utils.getBuffer();

      baServices.covNotify.encode(buffer, 7, 443, {type: 2, instance: 12}, 120, values);

      expect(buffer.buffer.subarray(0, buffer.offset)).to.deep.equal(golden);
    });
  });

  describe('discovery announcements', () => {
    it('matches the I-Have golden vector', () => {
      const golden = Buffer.from('c4020001bbc4000000047509004c6774436d643031', 'hex');
      const result = baServices.iHaveBroadcast.decode(golden, 0, golden.length);
      const buffer = utils.getBuffer();

      expect(result).to.include({len: golden.length, objectName: 'LgtCmd01'});
      expect(result.deviceId).to.deep.equal({type: baEnum.ObjectType.DEVICE, instance: 443});
      expect(result.objectId).to.deep.equal({type: 0, instance: 4});

      baServices.iHaveBroadcast.encode(buffer, result.deviceId, result.objectId, result.objectName);
      expect(buffer.buffer.subarray(0, buffer.offset)).to.deep.equal(golden);
    });

    it('matches the I-Am vector with a 1476-octet maximum APDU', () => {
      const golden = Buffer.from('c40200002f2205c491032107', 'hex');
      const result = baServices.iAmBroadcast.decode(golden, 0);
      const buffer = utils.getBuffer();

      expect(result).to.deep.equal({
        len: golden.length,
        deviceId: 47,
        maxApdu: 1476,
        segmentation: baEnum.Segmentation.NO_SEGMENTATION,
        vendorId: 7
      });

      baServices.iAmBroadcast.encode(buffer, 47, 1476, baEnum.Segmentation.NO_SEGMENTATION, 7);
      expect(buffer.buffer.subarray(0, buffer.offset)).to.deep.equal(golden);
    });
  });
});

describe('BACnet client protocol regressions', () => {
  it('encodes UTC synchronization from UTC Date fields', () => {
    const context = createClient();
    const value = new Date('2026-07-18T03:04:05.670Z');

    context.client.timeSyncUTC('192.0.2.1', value);

    expect(context.transport.sent[0].buffer.subarray(8)).to.deep.equal(Buffer.from('a47e071206b403040543', 'hex'));
  });

  it('publishes the decoded UTC synchronization value', () => {
    const context = createClient();
    const golden = Buffer.from('a47e071206b403040543', 'hex');
    let event;
    context.client.once('timeSyncUTC', (value) => event = value);

    context.client._processUnconfirmedServiceRequest('192.0.2.1', baEnum.PduTypes.UNCONFIRMED_REQUEST, baEnum.UnconfirmedServiceChoice.UTC_TIME_SYNCHRONIZATION, golden, 0, golden.length);

    expect(event).to.deep.equal({
      address: '192.0.2.1',
      sourceAddress: '192.0.2.1',
      dateTime: new Date('2026-07-18T03:04:05.670Z')
    });
  });

  it('sends and publishes complete I-Have data through both event aliases', () => {
    const context = createClient();
    const golden = Buffer.from('c4020001bbc4000000047509004c6774436d643031', 'hex');
    let legacyEvent;
    let canonicalEvent;
    context.client.once('ihaveBroadcast', (value) => legacyEvent = value);
    context.client.once('iHave', (value) => canonicalEvent = value);

    context.client.iHaveResponse(443, {type: 0, instance: 4}, 'LgtCmd01');
    context.client._processUnconfirmedServiceRequest('192.0.2.1', baEnum.PduTypes.UNCONFIRMED_REQUEST, baEnum.UnconfirmedServiceChoice.I_HAVE, golden, 0, golden.length);

    expect(context.transport.sent[0].buffer.subarray(8)).to.deep.equal(golden);
    expect(legacyEvent).to.equal(canonicalEvent);
    expect(legacyEvent).to.include({address: '192.0.2.1', objectName: 'LgtCmd01'});
    expect(legacyEvent.deviceId).to.deep.equal({type: baEnum.ObjectType.DEVICE, instance: 443});
    expect(legacyEvent.objectId).to.deep.equal({type: 0, instance: 4});
    expect(legacyEvent.eventData.objectName).to.equal('LgtCmd01');
  });

  it('advertises 1476 as the default I-Am maximum APDU', () => {
    const context = createClient();

    context.client.iAmResponse(47, baEnum.Segmentation.NO_SEGMENTATION, 7);

    expect(baServices.iAmBroadcast.decode(context.transport.sent[0].buffer, 8).maxApdu).to.equal(1476);
  });

  it('preserves explicit zero-valued confirmed-request options', () => {
    const context = createClient();
    context.client._addCallback = () => {};

    context.client.readProperty('192.0.2.1', {type: 8, instance: 47}, 85, {
      maxSegments: 0,
      maxApdu: 0,
      invokeId: 0,
      arrayIndex: 0
    }, () => {});

    const packet = context.transport.sent[0].buffer;
    expect(packet.subarray(6, 10)).to.deep.equal(Buffer.from([0x00, 0x00, 0x00, baEnum.ConfirmedServiceChoice.READ_PROPERTY]));
    expect(baServices.readProperty.decode(packet, 10, packet.length - 10).property.index).to.equal(0);
  });
});
