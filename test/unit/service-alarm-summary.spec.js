'use strict';

const expect = require('chai').expect;
const utils = require('./utils');
const baServices = require('../../lib/services');

const ALARMS = [
  {
    objectId: {type: 12, instance: 12},
    alarmState: 2,
    acknowledgedTransitions: {value: [5], bitsUsed: 3}
  },
  {
    objectId: {type: 13, instance: 13},
    alarmState: 3,
    acknowledgedTransitions: {value: [7], bitsUsed: 3}
  }
];

const encode = (alarms = ALARMS) => {
  const buffer = utils.getBuffer();
  baServices.alarmSummary.encode(buffer, alarms);
  return Buffer.from(buffer.buffer.subarray(0, buffer.offset));
};

describe('bacstack - Services layer AlarmSummary unit', () => {
  it('encodes the BACnet context-tag wire layout and round-trips alarms', () => {
    const encoded = encode([ALARMS[0]]);

    expect(encoded.toString('hex')).to.equal('0c0300000c19022a05a0');
    expect(baServices.alarmSummary.decode(encoded, 0, encoded.length)).to.deep.equal({
      len: encoded.length,
      alarms: [ALARMS[0]]
    });
  });

  it('decodes multiple alarms and the valid empty acknowledgement', () => {
    const encoded = encode();

    expect(baServices.alarmSummary.decode(encoded, 0, encoded.length)).to.deep.equal({
      len: encoded.length,
      alarms: ALARMS
    });
    expect(baServices.alarmSummary.decode(Buffer.alloc(0), 0, 0)).to.deep.equal({
      len: 0,
      alarms: []
    });
  });

  it('honors nonzero offsets and the exact declared window', () => {
    const encoded = encode([ALARMS[0]]);
    const wrapped = Buffer.concat([Buffer.from([0xAA, 0xBB]), encoded, Buffer.from([0xCC])]);

    expect(baServices.alarmSummary.decode(wrapped, 2, encoded.length)).to.deep.equal({
      len: encoded.length,
      alarms: [ALARMS[0]]
    });
    expect(baServices.alarmSummary.decode(wrapped, 2, encoded.length - 1)).to.equal(undefined);
    expect(baServices.alarmSummary.decode(wrapped, 2, encoded.length + 1)).to.equal(undefined);
  });

  it('rejects every nonempty truncation without throwing or returning a partial alarm', () => {
    const encoded = encode([ALARMS[0]]);
    for (let length = 1; length < encoded.length; length++) {
      const decode = () => baServices.alarmSummary.decode(encoded, 0, length);
      expect(decode).not.to.throw();
      expect(decode()).to.equal(undefined);
    }
  });

  it('rejects wrong tags, invalid states, and non-three-bit transition fields', () => {
    const encoded = encode([ALARMS[0]]);
    const wrongTag = Buffer.from(encoded);
    wrongTag[0] = 0x1C;
    expect(baServices.alarmSummary.decode(wrongTag, 0, wrongTag.length)).to.equal(undefined);

    const wrongClass = Buffer.from(encoded);
    wrongClass[0] &= ~0x08;
    expect(baServices.alarmSummary.decode(wrongClass, 0, wrongClass.length)).to.equal(undefined);

    const invalidState = Buffer.from(encoded);
    invalidState[6] = 6;
    expect(baServices.alarmSummary.decode(invalidState, 0, invalidState.length)).to.equal(undefined);

    const invalidBits = Buffer.from(encoded);
    invalidBits[8] = 4;
    expect(baServices.alarmSummary.decode(invalidBits, 0, invalidBits.length)).to.equal(undefined);
  });

  it('validates every transition field before writing the response', () => {
    [
      {value: [], bitsUsed: 0},
      {value: [1], bitsUsed: 4},
      {value: [1, 2], bitsUsed: 3}
    ].forEach((acknowledgedTransitions) => {
      const buffer = utils.getBuffer();
      const alarms = [ALARMS[0], Object.assign({}, ALARMS[1], {
        acknowledgedTransitions: acknowledgedTransitions
      })];

      expect(() => baServices.alarmSummary.encode(buffer, alarms)).to.throw(RangeError);
      expect(buffer.offset).to.equal(0);
    });
  });
});
