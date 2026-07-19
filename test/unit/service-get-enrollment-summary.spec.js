'use strict';

const expect      = require('chai').expect;
const baAsn1      = require('../../lib/asn1');
const utils       = require('./utils');
const baServices  = require('../../lib/services');

const STANDARD_REQUEST = Buffer.from(
  '09021e0e0c014000210f19071f290139034e090119414f5905',
  'hex'
);
const STANDARD_ACK_WITHOUT_NOTIFICATION_CLASS = Buffer.from(
  'c403000078910391022112',
  'hex'
);
const STANDARD_ACK_WITH_NOTIFICATION_CLASS = Buffer.from(
  'c403000078910391022112210b',
  'hex'
);

const encodePriorityFilterRequest = (acknowledgmentFilter, min, max) => {
  const buffer = utils.getBuffer();
  baAsn1.encodeContextEnumerated(buffer, 0, acknowledgmentFilter);
  baAsn1.encodeOpeningTag(buffer, 4);
  baAsn1.encodeContextUnsigned(buffer, 0, min);
  baAsn1.encodeContextUnsigned(buffer, 1, max);
  baAsn1.encodeClosingTag(buffer, 4);
  return Buffer.from(buffer.buffer.subarray(0, buffer.offset));
};

describe('bacstack - Services layer GetEnrollmentSummary unit', () => {
  it('should successfully encode and decode', () => {
    const buffer = utils.getBuffer();
    baServices.getEnrollmentSummary.encode(buffer, 2);
    const result = baServices.getEnrollmentSummary.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      acknowledgmentFilter: 2
    });
  });

  it('should successfully encode and decode full payload', () => {
    const buffer = utils.getBuffer();
    baServices.getEnrollmentSummary.encode(buffer, 2, {objectId: {type: 5, instance: 33}, processId: 7}, 1, 3, {min: 1, max: 65}, 5);
    expect(Buffer.from(buffer.buffer.subarray(0, buffer.offset))).to.deep.equal(STANDARD_REQUEST);
    const result = baServices.getEnrollmentSummary.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      acknowledgmentFilter: 2,
      enrollmentFilter: {objectId: {type: 5, instance: 33}, processId: 7},
      eventStateFilter: 1,
      eventTypeFilter: 3,
      priorityFilter: {min: 1, max: 65},
      notificationClassFilter: 5
    });
  });

  it('decodes an independent standards-shaped fixture within its exact window', () => {
    const framed = Buffer.concat([
      Buffer.from([0xAA]),
      STANDARD_REQUEST,
      Buffer.from([0x2E, 0xFF, 0xFF])
    ]);
    const result = baServices.getEnrollmentSummary.decode(
      framed,
      1,
      STANDARD_REQUEST.length
    );
    delete result.len;
    expect(result).to.deep.equal({
      acknowledgmentFilter: 2,
      enrollmentFilter: {objectId: {type: 5, instance: 33}, processId: 7},
      eventStateFilter: 1,
      eventTypeFilter: 3,
      priorityFilter: {min: 1, max: 65},
      notificationClassFilter: 5
    });
  });

  it('encodes zero-valued primitive filters instead of treating them as absent', () => {
    const buffer = utils.getBuffer();
    baServices.getEnrollmentSummary.encode(buffer, 0, null, 0, 0, null, 0);
    expect(Buffer.from(buffer.buffer.subarray(0, buffer.offset))).to.deep.equal(
      Buffer.from('0900290039005900', 'hex')
    );
  });

  it('decodes the legacy constructed primitive-filter shape for compatibility', () => {
    const legacy = Buffer.from(
      '09021e0e0c014000210f19071f2e09012f3e09033f4e090119414f5e09055f',
      'hex'
    );
    const result = baServices.getEnrollmentSummary.decode(legacy, 0, legacy.length);
    expect(result).to.deep.include({
      len: legacy.length,
      eventStateFilter: 1,
      eventTypeFilter: 3,
      notificationClassFilter: 5
    });
  });

  it('rejects acknowledgment filter values outside the standard enumeration', () => {
    const buffer = utils.getBuffer();
    baAsn1.encodeContextEnumerated(buffer, 0, 3);
    expect(baServices.getEnrollmentSummary.decode(
      buffer.buffer,
      0,
      buffer.offset
    )).to.equal(undefined);
  });

  it('rejects invalid acknowledgment and priority filters before encoding', () => {
    [
      {acknowledgmentFilter: -1},
      {acknowledgmentFilter: 3},
      {acknowledgmentFilter: 1.5},
      {acknowledgmentFilter: 0, priorityFilter: {min: -1, max: 10}},
      {acknowledgmentFilter: 0, priorityFilter: {min: 0, max: 0x100}},
      {acknowledgmentFilter: 0, priorityFilter: {min: 10, max: 9}}
    ].forEach(({acknowledgmentFilter, priorityFilter}) => {
      const buffer = utils.getBuffer();
      expect(() => baServices.getEnrollmentSummary.encode(
        buffer,
        acknowledgmentFilter,
        null,
        null,
        null,
        priorityFilter
      )).to.throw(RangeError);
      expect(buffer.offset).to.equal(0);
    });
  });

  it('accepts the full 0..255 event-priority filter range', () => {
    const payload = encodePriorityFilterRequest(0, 0, 0xFF);
    expect(baServices.getEnrollmentSummary.decode(payload, 0, payload.length)).to.deep.equal({
      len: payload.length,
      acknowledgmentFilter: 0,
      priorityFilter: {min: 0, max: 0xFF}
    });
  });

  it('rejects out-of-range or reversed event-priority filters', () => {
    [
      {min: 0, max: 0x100},
      {min: 0x100, max: 0x100},
      {min: 100, max: 99}
    ].forEach(({min, max}) => {
      const payload = encodePriorityFilterRequest(0, min, max);
      expect(baServices.getEnrollmentSummary.decode(
        payload,
        0,
        payload.length
      )).to.equal(undefined);
    });
  });
});

describe('GetEnrollmentSummaryAcknowledge', () => {
  it('should successfully encode and decode', () => {
    const buffer = utils.getBuffer();
    baServices.getEnrollmentSummary.encodeAcknowledge(buffer, [
      {objectId: {type: 12, instance: 120}, eventType: 3, eventState: 2, priority: 18, notificationClass: 11}
    ]);
    const result = baServices.getEnrollmentSummary.decodeAcknowledge(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      enrollmentSummaries: [{objectId: {type: 12, instance: 120}, eventType: 3, eventState: 2, priority: 18, notificationClass: 11}]
    });
  });

  it('encodes and decodes the optional notification class using independent fixtures', () => {
    const withoutNotificationClass = utils.getBuffer();
    baServices.getEnrollmentSummary.encodeAcknowledge(withoutNotificationClass, [
      {objectId: {type: 12, instance: 120}, eventType: 3, eventState: 2, priority: 18}
    ]);
    expect(Buffer.from(withoutNotificationClass.buffer.subarray(
      0,
      withoutNotificationClass.offset
    ))).to.deep.equal(STANDARD_ACK_WITHOUT_NOTIFICATION_CLASS);
    expect(baServices.getEnrollmentSummary.decodeAcknowledge(
      STANDARD_ACK_WITHOUT_NOTIFICATION_CLASS,
      0,
      STANDARD_ACK_WITHOUT_NOTIFICATION_CLASS.length
    )).to.deep.equal({
      len: STANDARD_ACK_WITHOUT_NOTIFICATION_CLASS.length,
      enrollmentSummaries: [{
        objectId: {type: 12, instance: 120},
        eventType: 3,
        eventState: 2,
        priority: 18
      }]
    });
    expect(baServices.getEnrollmentSummary.decodeAcknowledge(
      STANDARD_ACK_WITH_NOTIFICATION_CLASS,
      0,
      STANDARD_ACK_WITH_NOTIFICATION_CLASS.length
    ).enrollmentSummaries[0].notificationClass).to.equal(11);
  });

  it('rejects a tag-only optional notification class without returning NaN', () => {
    const malformed = Buffer.concat([
      STANDARD_ACK_WITHOUT_NOTIFICATION_CLASS,
      Buffer.from([0x21])
    ]);
    expect(() => baServices.getEnrollmentSummary.decodeAcknowledge(
      malformed,
      0,
      malformed.length
    )).not.to.throw();
    expect(baServices.getEnrollmentSummary.decodeAcknowledge(
      malformed,
      0,
      malformed.length
    )).to.equal(undefined);
  });

  it('uses the next object identifier to delimit an omitted notification class', () => {
    const secondSummary = Buffer.from('c40300007991049101210a2100', 'hex');
    const payload = Buffer.concat([
      STANDARD_ACK_WITHOUT_NOTIFICATION_CLASS,
      secondSummary
    ]);
    const result = baServices.getEnrollmentSummary.decodeAcknowledge(
      payload,
      0,
      payload.length
    );
    expect(result.enrollmentSummaries).to.deep.equal([
      {
        objectId: {type: 12, instance: 120},
        eventType: 3,
        eventState: 2,
        priority: 18
      },
      {
        objectId: {type: 12, instance: 121},
        eventType: 4,
        eventState: 1,
        priority: 10,
        notificationClass: 0
      }
    ]);
  });

  it('accepts only event priorities from 0 through 255 on encode and decode', () => {
    [0, 0xFF].forEach((priority) => {
      const buffer = utils.getBuffer();
      baServices.getEnrollmentSummary.encodeAcknowledge(buffer, [{
        objectId: {type: 12, instance: 120},
        eventType: 3,
        eventState: 2,
        priority: priority
      }]);
      expect(baServices.getEnrollmentSummary.decodeAcknowledge(
        buffer.buffer,
        0,
        buffer.offset
      ).enrollmentSummaries[0].priority).to.equal(priority);
    });

    [-1, 0x100, 1.5].forEach((priority) => {
      const buffer = utils.getBuffer();
      expect(() => baServices.getEnrollmentSummary.encodeAcknowledge(buffer, [{
        objectId: {type: 12, instance: 120},
        eventType: 3,
        eventState: 2,
        priority: priority
      }])).to.throw(RangeError);
      expect(buffer.offset).to.equal(0);
    });

    const invalidPriority = Buffer.from('c40300007891039102220100', 'hex');
    expect(baServices.getEnrollmentSummary.decodeAcknowledge(
      invalidPriority,
      0,
      invalidPriority.length
    )).to.equal(undefined);
  });
});
