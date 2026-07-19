'use strict';

const expect      = require('chai').expect;
const utils       = require('./utils');
const baServices  = require('../../lib/services');
const baEnum      = require('../../lib/enum');

describe('bacstack - Services layer AlarmAcknowledge unit', () => {
  it('should successfully encode and decode with time timestamp', () => {
    const buffer = utils.getBuffer();
    const eventTime = new Date(1, 1, 1);
    eventTime.setMilliseconds(990);
    const ackTime = new Date(1, 1, 1);
    ackTime.setMilliseconds(880);
    baServices.alarmAcknowledge.encode(buffer, 57, {type: 0, instance: 33}, 5, 'Alarm Acknowledge Test', {value: eventTime, type: baEnum.TimeStamp.TIME}, {value: ackTime, type: baEnum.TimeStamp.TIME});
    const result = baServices.alarmAcknowledge.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      acknowledgedProcessId: 57,
      eventObjectId: {
        type: 0,
        instance: 33
      },
      eventStateAcknowledged: 5,
      acknowledgeSource: 'Alarm Acknowledge Test',
      eventTimeStamp: eventTime,
      acknowledgeTimeStamp: ackTime
    });
  });

  it('should successfully encode and decode with sequence timestamp', () => {
    const buffer = utils.getBuffer();
    const eventTime = 5;
    const ackTime = 6;
    baServices.alarmAcknowledge.encode(buffer, 57, {type: 0, instance: 33}, 5, 'Alarm Acknowledge Test', {value: eventTime, type: baEnum.TimeStamp.SEQUENCE_NUMBER}, {value: ackTime, type: baEnum.TimeStamp.SEQUENCE_NUMBER});
    const result = baServices.alarmAcknowledge.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      acknowledgedProcessId: 57,
      eventObjectId: {
        type: 0,
        instance: 33
      },
      eventStateAcknowledged: 5,
      acknowledgeSource: 'Alarm Acknowledge Test',
      eventTimeStamp: eventTime,
      acknowledgeTimeStamp: ackTime
    });
  });

  it('should successfully encode and decode with datetime timestamp', () => {
    const buffer = utils.getBuffer();
    const eventTime = new Date(1, 1, 1);
    eventTime.setMilliseconds(990);
    const ackTime = new Date(1, 1, 2);
    ackTime.setMilliseconds(880);
    baServices.alarmAcknowledge.encode(buffer, 57, {type: 0, instance: 33}, 5, 'Alarm Acknowledge Test', {value: eventTime, type: baEnum.TimeStamp.DATETIME}, {value: ackTime, type: baEnum.TimeStamp.DATETIME});
    const result = baServices.alarmAcknowledge.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      acknowledgedProcessId: 57,
      eventObjectId: {
        type: 0,
        instance: 33
      },
      eventStateAcknowledged: 5,
      acknowledgeSource: 'Alarm Acknowledge Test',
      eventTimeStamp: eventTime,
      acknowledgeTimeStamp: ackTime
    });
  });

  it('should reject every truncated datetime payload without throwing', () => {
    const buffer = utils.getBuffer();
    const eventTime = new Date(2017, 7, 21, 15, 13, 34, 0);
    const ackTime = new Date(2017, 7, 21, 16, 14, 35, 0);
    baServices.alarmAcknowledge.encode(
      buffer,
      57,
      {type: 0, instance: 33},
      5,
      'Alarm Acknowledge Test',
      {value: eventTime, type: baEnum.TimeStamp.DATETIME},
      {value: ackTime, type: baEnum.TimeStamp.DATETIME}
    );

    for (let length = 0; length < buffer.offset; length++) {
      const truncated = Buffer.from(buffer.buffer.subarray(0, length));
      expect(() => baServices.alarmAcknowledge.decode(truncated, 0, truncated.length)).not.to.throw();
      expect(baServices.alarmAcknowledge.decode(truncated, 0, truncated.length)).to.equal(undefined);
    }
  });

  it('should consume an unsupported Ack Source character set', () => {
    // ASHRAE 135-2016bu requires this field to be consumed without failing
    // the service, even when the receiver cannot interpret its characters.
    const payload = Buffer.from(
      '09011c0080000329043e19013f4c0103a4415e19015f',
      'hex'
    );
    const result = baServices.alarmAcknowledge.decode(payload, 0, payload.length);
    expect(result).to.deep.equal({
      acknowledgedProcessId: 1,
      eventObjectId: {type: 2, instance: 3},
      eventStateAcknowledged: 4,
      eventTimeStamp: 1,
      acknowledgeSource: '',
      acknowledgeTimeStamp: 1,
      len: payload.length
    });
  });
});
