'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

module.exports.encode = (buffer, deviceId, objectId, objectName) => {
  if (!deviceId || deviceId.type !== baEnum.ObjectType.DEVICE) {
    throw new RangeError('I-Have device identifier must have object type Device');
  }
  baAsn1.encodeApplicationObjectId(buffer, deviceId.type, deviceId.instance);
  baAsn1.encodeApplicationObjectId(buffer, objectId.type, objectId.instance);
  baAsn1.encodeApplicationCharacterString(buffer, objectName);
};

module.exports.decode = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(apduLen) || apduLen < 0 || offset > buffer.length ||
      apduLen > buffer.length - offset) return;
  const endOffset = offset + apduLen;
  let len = 0;
  let result;
  let decodedValue;
  let value = {};
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || result.tagNumber !== 12 || result.value !== 4 ||
      baAsn1.decodeIsContextTag(buffer, offset + len, result.tagNumber)) return;
  len += result.len;
  decodedValue = baAsn1.decodeObjectId(buffer, offset + len);
  if (!decodedValue || decodedValue.len > endOffset - (offset + len)) return;
  if (decodedValue.objectType !== baEnum.ObjectType.DEVICE) return;
  len += decodedValue.len;
  value.deviceId = {type: decodedValue.objectType, instance: decodedValue.instance};
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || result.tagNumber !== 12 || result.value !== 4 ||
      baAsn1.decodeIsContextTag(buffer, offset + len, result.tagNumber)) return;
  len += result.len;
  decodedValue = baAsn1.decodeObjectId(buffer, offset + len);
  if (!decodedValue || decodedValue.len > endOffset - (offset + len)) return;
  len += decodedValue.len;
  value.objectId = {type: decodedValue.objectType, instance: decodedValue.instance};
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || result.tagNumber !== 7 || baAsn1.decodeIsContextTag(buffer, offset + len, result.tagNumber)) return;
  len += result.len;
  decodedValue = baAsn1.decodeCharacterString(buffer, offset + len, endOffset - (offset + len), result.value);
  if (!decodedValue) return;
  len += decodedValue.len;
  if (len !== apduLen) return;
  value.objectName = decodedValue.value;
  value.len = len;
  return value;
};
