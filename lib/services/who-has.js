'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

module.exports.encode = (buffer, lowLimit, highLimit, objectId, objectName) => {
  const hasLowLimit = lowLimit != null;
  const hasHighLimit = highLimit != null;
  if (hasLowLimit !== hasHighLimit || (hasLowLimit &&
      (!Number.isSafeInteger(lowLimit) || lowLimit < 0 || lowLimit > baEnum.ASN1_MAX_INSTANCE ||
       !Number.isSafeInteger(highLimit) || highLimit < 0 || highLimit > baEnum.ASN1_MAX_INSTANCE ||
       lowLimit > highLimit))) {
    throw new RangeError('Who-Has limits must be an ordered pair of BACnet device instances');
  }
  if (hasLowLimit) {
    baAsn1.encodeContextUnsigned(buffer, 0, lowLimit);
    baAsn1.encodeContextUnsigned(buffer, 1, highLimit);
  }
  if (objectName && objectName !== '') {
    baAsn1.encodeContextCharacterString(buffer, 3, objectName);
  } else {
    baAsn1.encodeContextObjectId(buffer, 2, objectId.type, objectId.instance);
  }
};

module.exports.decode = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(apduLen) || apduLen < 0 || offset > buffer.length ||
      apduLen > buffer.length - offset) return;
  const endOffset = offset + apduLen;
  let len = 0;
  let value = {};
  let decodedValue;
  let result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result) return;
  len += result.len;
  if (result.tagNumber === 0) {
    if (!baAsn1.decodeIsContextTag(buffer, offset, 0)) return;
    decodedValue = baAsn1.decodeUnsigned(buffer, offset + len, result.value);
    if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
    len += decodedValue.len;
    if (decodedValue.value > baEnum.ASN1_MAX_INSTANCE) return;
    value.lowLimit = decodedValue.value;
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!result) return;
    len += result.len;
    if (result.tagNumber !== 1) return;
    if (!baAsn1.decodeIsContextTag(buffer, offset + len - result.len, 1)) return;
    decodedValue = baAsn1.decodeUnsigned(buffer, offset + len, result.value);
    if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
    len += decodedValue.len;
    if (decodedValue.value > baEnum.ASN1_MAX_INSTANCE || value.lowLimit > decodedValue.value) return;
    value.highLimit = decodedValue.value;
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!result) return;
    len += result.len;
  } else if (result.tagNumber === 1) {
    return;
  }
  if (result.tagNumber === 2) {
    if (!baAsn1.decodeIsContextTag(buffer, offset + len - result.len, 2) || result.value !== 4) return;
    decodedValue = baAsn1.decodeObjectId(buffer, offset + len);
    if (!decodedValue || decodedValue.len > endOffset - (offset + len)) return;
    len += decodedValue.len;
    value.objectId = {type: decodedValue.objectType, instance: decodedValue.instance};
  } else if (result.tagNumber === 3) {
    if (!baAsn1.decodeIsContextTag(buffer, offset + len - result.len, 3)) return;
    decodedValue = baAsn1.decodeCharacterString(buffer, offset + len, endOffset - (offset + len), result.value);
    if (!decodedValue) return;
    len += decodedValue.len;
    value.objectName = decodedValue.value;
  } else {
    return;
  }
  if (len !== apduLen) return;
  value.len = len;
  return value;
};
