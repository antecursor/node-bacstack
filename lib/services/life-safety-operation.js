'use strict';

const baAsn1      = require('../asn1');

module.exports.encode = (buffer, processId, requestingSource, operation, targetObjectId) => {
  baAsn1.encodeContextUnsigned(buffer, 0, processId);
  baAsn1.encodeContextCharacterString(buffer, 1, requestingSource);
  baAsn1.encodeContextEnumerated(buffer, 2, operation);
  if (targetObjectId != null) {
    baAsn1.encodeContextObjectId(buffer, 3, targetObjectId.type, targetObjectId.instance);
  }
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
  if (!result || !baAsn1.decodeIsContextTag(buffer, offset + len, 0)) return;
  len += result.len;
  decodedValue = baAsn1.decodeUnsigned(buffer, offset + len, result.value);
  if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
  len += decodedValue.len;
  value.processId = decodedValue.value;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || !baAsn1.decodeIsContextTag(buffer, offset + len, 1)) return;
  len += result.len;
  decodedValue = baAsn1.decodeCharacterString(buffer, offset + len, endOffset - (offset + len), result.value);
  if (!decodedValue) return;
  len += decodedValue.len;
  value.requestingSource = decodedValue.value;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || !baAsn1.decodeIsContextTag(buffer, offset + len, 2)) return;
  len += result.len;
  decodedValue = baAsn1.decodeEnumerated(buffer, offset + len, result.value);
  if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
  len += decodedValue.len;
  value.operation = decodedValue.value;
  if (len === apduLen) {
    value.len = len;
    return value;
  }
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || !baAsn1.decodeIsContextTag(buffer, offset + len, 3) || result.value !== 4) return;
  len += result.len;
  decodedValue = baAsn1.decodeObjectId(buffer, offset + len);
  if (!decodedValue || decodedValue.len > endOffset - (offset + len)) return;
  len += decodedValue.len;
  if (len !== apduLen) return;
  value.targetObjectId = {type: decodedValue.objectType, instance: decodedValue.instance};
  value.len = len;
  return value;
};
