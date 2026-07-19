'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

module.exports.encode = (buffer, deviceId, maxApdu, segmentation, vendorId) => {
  baAsn1.encodeApplicationObjectId(buffer, baEnum.ObjectType.DEVICE, deviceId);
  baAsn1.encodeApplicationUnsigned(buffer, maxApdu);
  baAsn1.encodeApplicationEnumerated(buffer, segmentation);
  baAsn1.encodeApplicationUnsigned(buffer, vendorId);
};

module.exports.decode = (buffer, offset, length) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      offset > buffer.length || (length !== undefined &&
      (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - offset))) return;
  let result;
  let apduLen = 0;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + apduLen);
  if (!result || result.value !== 4 || baAsn1.decodeIsContextTag(buffer, offset + apduLen, result.tagNumber)) return;
  apduLen += result.len;
  if (result.tagNumber !== baEnum.ApplicationTags.OBJECTIDENTIFIER) return;
  result = baAsn1.decodeObjectId(buffer, offset + apduLen);
  if (!result) return;
  apduLen += result.len;
  if (result.objectType !== baEnum.ObjectType.DEVICE) return;
  const deviceId = result.instance;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + apduLen);
  if (!result || baAsn1.decodeIsContextTag(buffer, offset + apduLen, result.tagNumber)) return;
  apduLen += result.len;
  if (result.tagNumber !== baEnum.ApplicationTags.UNSIGNED_INTEGER) return;
  result = baAsn1.decodeUnsigned(buffer, offset + apduLen, result.value);
  if (!result || Number.isNaN(result.value) || (length !== undefined && result.len > length - apduLen)) return;
  apduLen += result.len;
  const maxApdu = result.value;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + apduLen);
  if (!result || baAsn1.decodeIsContextTag(buffer, offset + apduLen, result.tagNumber)) return;
  apduLen += result.len;
  if (result.tagNumber !== baEnum.ApplicationTags.ENUMERATED) return;
  result = baAsn1.decodeEnumerated(buffer, offset + apduLen, result.value);
  if (!result || Number.isNaN(result.value) || (length !== undefined && result.len > length - apduLen)) return;
  apduLen += result.len;
  if (result.value > baEnum.Segmentation.NO_SEGMENTATION) return;
  const segmentation = result.value;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + apduLen);
  if (!result || baAsn1.decodeIsContextTag(buffer, offset + apduLen, result.tagNumber)) return;
  apduLen += result.len;
  if (result.tagNumber !== baEnum.ApplicationTags.UNSIGNED_INTEGER) return;
  result = baAsn1.decodeUnsigned(buffer, offset + apduLen, result.value);
  if (!result || Number.isNaN(result.value) || (length !== undefined && result.len > length - apduLen)) return;
  apduLen += result.len;
  if (result.value > 0xFFFF) return;
  const vendorId = result.value;
  if (length !== undefined && apduLen !== length) return;
  return {
    len: apduLen,
    deviceId: deviceId,
    maxApdu: maxApdu,
    segmentation: segmentation,
    vendorId: vendorId
  };
};
