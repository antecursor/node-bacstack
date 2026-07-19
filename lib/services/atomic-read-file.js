'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

const isApplicationTag = (buffer, offset, result, tagNumber) => {
  return !!result && result.tagNumber === tagNumber &&
    !baAsn1.decodeIsContextTag(buffer, offset, tagNumber);
};

module.exports.encode = (buffer, isStream, objectId, position, count) => {
  baAsn1.encodeApplicationObjectId(buffer, objectId.type, objectId.instance);
  if (isStream) {
    baAsn1.encodeOpeningTag(buffer, 0);
    baAsn1.encodeApplicationSigned(buffer, position);
    baAsn1.encodeApplicationUnsigned(buffer, count);
    baAsn1.encodeClosingTag(buffer, 0);
  } else {
    baAsn1.encodeOpeningTag(buffer, 1);
    baAsn1.encodeApplicationSigned(buffer, position);
    baAsn1.encodeApplicationUnsigned(buffer, count);
    baAsn1.encodeClosingTag(buffer, 1);
  }
};

module.exports.decode = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      offset > buffer.length || (apduLen !== undefined &&
      (!Number.isSafeInteger(apduLen) || apduLen < 0 || apduLen > buffer.length - offset))) return;
  const endOffset = apduLen === undefined ? buffer.length : offset + apduLen;
  let len = 0;
  let result;
  let decodedValue;
  let isStream;
  let objectId;
  let position;
  let count;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!isApplicationTag(buffer, offset + len, result, baEnum.ApplicationTags.OBJECTIDENTIFIER) ||
      result.value !== 4) return;
  len += result.len;
  decodedValue = baAsn1.decodeObjectId(buffer, offset + len);
  if (!decodedValue || decodedValue.len > endOffset - (offset + len)) return;
  len += decodedValue.len;
  objectId = {type: decodedValue.objectType, instance: decodedValue.instance};
  if (baAsn1.decodeIsOpeningTagNumber(buffer, offset + len, 0)) {
    isStream = true;
    len++;
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!isApplicationTag(buffer, offset + len, result, baEnum.ApplicationTags.SIGNED_INTEGER)) return;
    len += result.len;
    decodedValue = baAsn1.decodeSigned(buffer, offset + len, result.value);
    if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
    len += decodedValue.len;
    position = decodedValue.value;
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!isApplicationTag(buffer, offset + len, result, baEnum.ApplicationTags.UNSIGNED_INTEGER)) return;
    len += result.len;
    decodedValue = baAsn1.decodeUnsigned(buffer, offset + len, result.value);
    if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
    len += decodedValue.len;
    count = decodedValue.value;
    if (!baAsn1.decodeIsClosingTagNumber(buffer, offset + len, 0)) return;
    len++;
  } else if (baAsn1.decodeIsOpeningTagNumber(buffer, offset + len, 1)) {
    isStream = false;
    len++;
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!isApplicationTag(buffer, offset + len, result, baEnum.ApplicationTags.SIGNED_INTEGER)) return;
    len += result.len;
    decodedValue = baAsn1.decodeSigned(buffer, offset + len, result.value);
    if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
    len += decodedValue.len;
    position = decodedValue.value;
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!isApplicationTag(buffer, offset + len, result, baEnum.ApplicationTags.UNSIGNED_INTEGER)) return;
    len += result.len;
    decodedValue = baAsn1.decodeUnsigned(buffer, offset + len, result.value);
    if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
    len += decodedValue.len;
    count = decodedValue.value;
    if (!baAsn1.decodeIsClosingTagNumber(buffer, offset + len, 1)) return;
    len++;
  } else {
    return;
  }
  if (apduLen !== undefined && len !== apduLen) return;
  return {
    len: len,
    isStream: isStream,
    objectId: objectId,
    position: position,
    count: count
  };
};

module.exports.encodeAcknowledge = (buffer, isStream, endOfFile, position, blockCount, blocks, counts) => {
  baAsn1.encodeApplicationBoolean(buffer, endOfFile);
  if (isStream) {
    baAsn1.encodeOpeningTag(buffer, 0);
    baAsn1.encodeApplicationSigned(buffer, position);
    baAsn1.encodeApplicationOctetString(buffer, blocks[0], 0, counts[0]);
    baAsn1.encodeClosingTag(buffer, 0);
  } else {
    baAsn1.encodeOpeningTag(buffer, 1);
    baAsn1.encodeApplicationSigned(buffer, position);
    baAsn1.encodeApplicationUnsigned(buffer, blockCount);
    for (let i = 0; i < blockCount; i++) {
      baAsn1.encodeApplicationOctetString(buffer, blocks[i], 0, counts[i]);
    }
    baAsn1.encodeClosingTag(buffer, 1);
  }
};

module.exports.decodeAcknowledge = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      offset > buffer.length || (apduLen !== undefined &&
      (!Number.isSafeInteger(apduLen) || apduLen < 0 || apduLen > buffer.length - offset))) return;
  const endOffset = apduLen === undefined ? buffer.length : offset + apduLen;
  let len = 0;
  let result;
  let decodedValue;
  let endOfFile;
  let isStream;
  let position;
  let targetBuffer;
  let blocks;
  let blockCount;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!isApplicationTag(buffer, offset + len, result, baEnum.ApplicationTags.BOOLEAN)) return;
  len += result.len;
  endOfFile = result.value > 0;
  if (baAsn1.decodeIsOpeningTagNumber(buffer, offset + len, 0)) {
    isStream = true;
    len++;
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!isApplicationTag(buffer, offset + len, result, baEnum.ApplicationTags.SIGNED_INTEGER)) return;
    len += result.len;
    decodedValue = baAsn1.decodeSigned(buffer, offset + len, result.value);
    if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
    len += decodedValue.len;
    position = decodedValue.value;
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!isApplicationTag(buffer, offset + len, result, baEnum.ApplicationTags.OCTET_STRING)) return;
    len += result.len;
    if (!Number.isSafeInteger(result.value) || result.value < 0 || result.value > endOffset - (offset + len)) return;
    targetBuffer = Buffer.from(buffer.subarray(offset + len, offset + len + result.value));
    len += result.value;
    if (!baAsn1.decodeIsClosingTagNumber(buffer, offset + len, 0)) return;
    len++;
  } else if (baAsn1.decodeIsOpeningTagNumber(buffer, offset + len, 1)) {
    isStream = false;
    len++;
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!isApplicationTag(buffer, offset + len, result, baEnum.ApplicationTags.SIGNED_INTEGER)) return;
    len += result.len;
    decodedValue = baAsn1.decodeSigned(buffer, offset + len, result.value);
    if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
    len += decodedValue.len;
    position = decodedValue.value;
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!isApplicationTag(buffer, offset + len, result, baEnum.ApplicationTags.UNSIGNED_INTEGER)) return;
    len += result.len;
    decodedValue = baAsn1.decodeUnsigned(buffer, offset + len, result.value);
    if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
    len += decodedValue.len;
    blockCount = decodedValue.value;
    if (blockCount > endOffset - (offset + len)) return;
    blocks = [];
    for (let i = 0; i < blockCount; i++) {
      result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
      if (!isApplicationTag(buffer, offset + len, result, baEnum.ApplicationTags.OCTET_STRING)) return;
      len += result.len;
      if (!Number.isSafeInteger(result.value) || result.value < 0 || result.value > endOffset - (offset + len)) return;
      blocks.push(Buffer.from(buffer.subarray(offset + len, offset + len + result.value)));
      len += result.value;
    }
    if (!baAsn1.decodeIsClosingTagNumber(buffer, offset + len, 1)) return;
    len++;
    if (apduLen !== undefined && len !== apduLen) return;
  } else {
    return;
  }
  if (apduLen !== undefined && len !== apduLen) return;
  const value = {
    len: len,
    endOfFile: endOfFile,
    isStream: isStream,
    position: position
  };
  if (isStream) value.buffer = targetBuffer;
  else {
    value.blockCount = blockCount;
    value.blocks = blocks;
  }
  return value;
};
