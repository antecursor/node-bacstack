'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

module.exports.encode = (buffer, ackProcessId, eventObjectId, eventStateAcknowledged, ackSource, eventTimeStamp, ackTimeStamp) => {
  baAsn1.encodeContextUnsigned(buffer, 0, ackProcessId);
  baAsn1.encodeContextObjectId(buffer, 1, eventObjectId.type, eventObjectId.instance);
  baAsn1.encodeContextEnumerated(buffer, 2, eventStateAcknowledged);
  baAsn1.bacappEncodeContextTimestamp(buffer, 3, eventTimeStamp);
  baAsn1.encodeContextCharacterString(buffer, 4, ackSource);
  baAsn1.bacappEncodeContextTimestamp(buffer, 5, ackTimeStamp);
};

module.exports.decode = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(apduLen) || apduLen < 0 ||
      offset > buffer.length || apduLen > buffer.length - offset) return;
  let len = 0;
  let value = {};
  let result;
  let decodedValue;

  const decodeTimestamp = (outerTagNumber) => {
    if (!baAsn1.decodeIsOpeningTagNumber(buffer, offset + len, outerTagNumber)) return;
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!result || len + result.len > apduLen) return;
    len += result.len;

    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!result || len + result.len + result.value > apduLen) return;
    len += result.len;
    let timestamp;
    if (result.tagNumber === baEnum.TimeStamp.TIME && result.value === 4) {
      decodedValue = baAsn1.decodeBacnetTime(buffer, offset + len);
      if (!decodedValue) return;
      len += decodedValue.len;
      timestamp = decodedValue.value;
    } else if (result.tagNumber === baEnum.TimeStamp.SEQUENCE_NUMBER) {
      decodedValue = baAsn1.decodeUnsigned(buffer, offset + len, result.value);
      if (Number.isNaN(decodedValue.value)) return;
      len += decodedValue.len;
      timestamp = decodedValue.value;
    } else if (result.tagNumber === baEnum.TimeStamp.DATETIME &&
        baAsn1.decodeIsOpeningTagNumber(buffer, offset + len - result.len, baEnum.TimeStamp.DATETIME)) {
      const date = baAsn1.decodeApplicationDate(buffer, offset + len);
      if (!date || len + date.len > apduLen) return;
      len += date.len;
      const time = baAsn1.decodeApplicationTime(buffer, offset + len);
      if (!time || len + time.len > apduLen) return;
      len += time.len;
      if (!baAsn1.decodeIsClosingTagNumber(buffer, offset + len, baEnum.TimeStamp.DATETIME)) return;
      const closingTag = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
      if (!closingTag || len + closingTag.len > apduLen) return;
      len += closingTag.len;
      const dateValue = date.value.value;
      const timeValue = time.value.value;
      timestamp = new Date(
        dateValue.getFullYear(),
        dateValue.getMonth(),
        dateValue.getDate(),
        timeValue.getHours(),
        timeValue.getMinutes(),
        timeValue.getSeconds(),
        timeValue.getMilliseconds()
      );
    } else {
      return;
    }

    if (!baAsn1.decodeIsClosingTagNumber(buffer, offset + len, outerTagNumber)) return;
    const closingTag = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!closingTag || len + closingTag.len > apduLen) return;
    len += closingTag.len;
    return {value: timestamp};
  };

  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || result.tagNumber !== 0 || len + result.len + result.value > apduLen) return;
  len += result.len;
  decodedValue = baAsn1.decodeUnsigned(buffer, offset + len, result.value);
  if (Number.isNaN(decodedValue.value)) return;
  len += decodedValue.len;
  value.acknowledgedProcessId = decodedValue.value;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || result.tagNumber !== 1 || result.value !== 4 || len + result.len + 4 > apduLen) return;
  len += result.len;
  decodedValue = baAsn1.decodeObjectId(buffer, offset + len);
  if (!decodedValue) return;
  len += decodedValue.len;
  value.eventObjectId = {type: decodedValue.objectType, instance: decodedValue.instance};
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || result.tagNumber !== 2 || len + result.len + result.value > apduLen) return;
  len += result.len;
  decodedValue = baAsn1.decodeEnumerated(buffer, offset + len, result.value);
  if (Number.isNaN(decodedValue.value)) return;
  len += decodedValue.len;
  value.eventStateAcknowledged = decodedValue.value;
  const eventTimestamp = decodeTimestamp(3);
  if (!eventTimestamp) return;
  value.eventTimeStamp = eventTimestamp.value;

  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || !baAsn1.decodeIsContextTag(buffer, offset + len, 4) ||
      baAsn1.decodeIsOpeningTag(buffer, offset + len) ||
      baAsn1.decodeIsClosingTag(buffer, offset + len) ||
      len + result.len + result.value > apduLen) return;
  len += result.len;
  decodedValue = baAsn1.decodeCharacterString(buffer, offset + len, apduLen - len, result.value);
  // Addendum 135-2016bu requires receivers to consume Ack Source even when
  // its character set is unsupported or its character content is invalid.
  value.acknowledgeSource = decodedValue ? decodedValue.value : '';
  len += result.value;
  const acknowledgeTimestamp = decodeTimestamp(5);
  if (!acknowledgeTimestamp) return;
  value.acknowledgeTimeStamp = acknowledgeTimestamp.value;
  if (len !== apduLen) return;
  value.len = len;
  return value;
};
