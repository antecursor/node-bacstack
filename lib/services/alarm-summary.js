'use strict';

const baAsn1 = require('../asn1');
const baEnum = require('../enum');

const validateTransitionBits = (transitions) => {
  if (!transitions || transitions.bitsUsed !== 3 || !Array.isArray(transitions.value) ||
      transitions.value.length !== 1) {
    throw new RangeError('AlarmSummary acknowledgedTransitions must contain exactly three bits');
  }
};

module.exports.encode = (buffer, alarms) => {
  alarms.forEach((alarm) => validateTransitionBits(alarm.acknowledgedTransitions));
  alarms.forEach((alarm) => {
    baAsn1.encodeContextObjectId(buffer, 0, alarm.objectId.type, alarm.objectId.instance);
    baAsn1.encodeContextEnumerated(buffer, 1, alarm.alarmState);
    baAsn1.encodeContextBitstring(buffer, 2, alarm.acknowledgedTransitions);
  });
};

module.exports.decode = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(apduLen) || apduLen < 0 || offset > buffer.length ||
      apduLen > buffer.length - offset) return;
  const endOffset = offset + apduLen;
  let cursor = offset;
  const alarms = [];

  const readPrimitive = (tagNumber, decode, minLength, maxLength) => {
    const tag = baAsn1.decodeTagNumberAndValue(buffer, cursor, endOffset);
    if (!tag || tag.tagNumber !== tagNumber ||
        !baAsn1.decodeIsContextTag(buffer, cursor, tagNumber) ||
        baAsn1.decodeIsOpeningTag(buffer, cursor) ||
        baAsn1.decodeIsClosingTag(buffer, cursor) ||
        tag.value < minLength || tag.value > maxLength ||
        tag.value > endOffset - cursor - tag.len) return;
    const decoded = decode(buffer, cursor + tag.len, tag.value);
    if (!decoded || decoded.len !== tag.value || Number.isNaN(decoded.value)) return;
    cursor += tag.len + tag.value;
    return decoded;
  };

  while (cursor < endOffset) {
    const objectId = readPrimitive(0, baAsn1.decodeObjectId, 4, 4);
    if (!objectId) return;
    const alarmState = readPrimitive(1, baAsn1.decodeEnumerated, 1, 4);
    if (!alarmState || alarmState.value > baEnum.EventState.LIFE_SAFETY_ALARM) return;
    const acknowledgedTransitions = readPrimitive(2, baAsn1.decodeBitstring, 2, 2);
    if (!acknowledgedTransitions || acknowledgedTransitions.value.bitsUsed !== 3) return;
    alarms.push({
      objectId: {type: objectId.objectType, instance: objectId.instance},
      alarmState: alarmState.value,
      acknowledgedTransitions: acknowledgedTransitions.value
    });
  }

  return {
    len: cursor - offset,
    alarms: alarms
  };
};
