'use strict';

const baAsn1      = require('../asn1');

module.exports.encode = (buffer, errorClass, errorCode) => {
  baAsn1.encodeApplicationEnumerated(buffer, errorClass);
  baAsn1.encodeApplicationEnumerated(buffer, errorCode);
};

module.exports.decode = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      offset > buffer.length || (apduLen !== undefined &&
      (!Number.isSafeInteger(apduLen) || apduLen < 0 || apduLen > buffer.length - offset))) return;
  const orgOffset = offset;
  let result;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset);
  if (!result || result.tagNumber !== 9 || baAsn1.decodeIsContextTag(buffer, offset, 9)) return;
  offset += result.len;
  const errorClass = baAsn1.decodeEnumerated(buffer, offset, result.value);
  if (!errorClass || Number.isNaN(errorClass.value) ||
      (apduLen !== undefined && errorClass.len > apduLen - (offset - orgOffset))) return;
  offset += errorClass.len;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset);
  if (!result || result.tagNumber !== 9 || baAsn1.decodeIsContextTag(buffer, offset, 9)) return;
  offset += result.len;
  const errorCode = baAsn1.decodeEnumerated(buffer, offset, result.value);
  if (!errorCode || Number.isNaN(errorCode.value) ||
      (apduLen !== undefined && errorCode.len > apduLen - (offset - orgOffset))) return;
  offset += errorCode.len;
  if (apduLen !== undefined && offset - orgOffset !== apduLen) return;
  return {
    len: offset - orgOffset,
    class: errorClass.value,
    code: errorCode.value
  };
};
