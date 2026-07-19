'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

const MAX_CONSTRUCTED_DEPTH = 32;

const getDecodeWindow = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length) return;
  const length = apduLen === undefined ? buffer.length - offset : apduLen;
  if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - offset) return;
  return {start: offset, end: offset + length};
};

// Decode a tag header without ever looking beyond the APDU window. This is
// deliberately local: the generic ASN.1 helpers are bounded by the backing
// Buffer, which may be longer than the APDU passed to a service decoder.
const decodeTagHeader = (buffer, offset, end) => {
  if (offset >= end) return;
  const first = buffer[offset];
  let cursor = offset + 1;
  let tagNumber = first >> 4;
  if (tagNumber === 0x0F) {
    if (cursor >= end) return;
    tagNumber = buffer[cursor++];
  }

  const isContext = (first & 0x08) !== 0;
  const lenValueType = first & 0x07;
  const isOpening = isContext && lenValueType === 6;
  const isClosing = isContext && lenValueType === 7;
  let value = lenValueType;
  if (!isOpening && !isClosing && lenValueType === 5) {
    if (cursor >= end) return;
    const extendedLength = buffer[cursor++];
    if (extendedLength === 254) {
      if (end - cursor < 2) return;
      value = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (extendedLength === 255) {
      if (end - cursor < 4) return;
      value = buffer.readUInt32BE(cursor);
      cursor += 4;
    } else {
      value = extendedLength;
    }
  }

  return {
    tagNumber: tagNumber,
    isContext: isContext,
    isOpening: isOpening,
    isClosing: isClosing,
    lenValueType: lenValueType,
    value: value,
    len: cursor - offset
  };
};

const decodePrimitive = (buffer, offset, end, tagNumber, isContext, minLength, maxLength) => {
  const tag = decodeTagHeader(buffer, offset, end);
  if (!tag || tag.isOpening || tag.isClosing || tag.tagNumber !== tagNumber ||
      tag.isContext !== isContext || tag.value < minLength || tag.value > maxLength ||
      tag.value > end - offset - tag.len) return;
  return {
    len: tag.len + tag.value,
    dataOffset: offset + tag.len,
    dataLength: tag.value
  };
};

const decodeUnsignedPrimitive = (buffer, offset, end, tagNumber, isContext) => {
  const primitive = decodePrimitive(buffer, offset, end, tagNumber, isContext, 1, 4);
  if (!primitive) return;
  return {
    len: primitive.len,
    value: buffer.readUIntBE(primitive.dataOffset, primitive.dataLength)
  };
};

const decodeSignedPrimitive = (buffer, offset, end, tagNumber, isContext) => {
  const primitive = decodePrimitive(buffer, offset, end, tagNumber, isContext, 1, 4);
  if (!primitive) return;
  return {
    len: primitive.len,
    value: buffer.readIntBE(primitive.dataOffset, primitive.dataLength)
  };
};

const decodeConstructedTag = (buffer, offset, end, tagNumber, opening) => {
  const tag = decodeTagHeader(buffer, offset, end);
  if (!tag || tag.tagNumber !== tagNumber || tag.isOpening !== opening ||
      tag.isClosing === opening) return;
  return tag.len;
};

// Find the matching closing tag while skipping complete primitive values.
// A closing-tag byte inside an OCTET STRING or CharacterString is data, not
// structure, and therefore cannot terminate the range prematurely.
const decodeConstructedContents = (buffer, offset, end, outerTagNumber) => {
  const stack = [outerTagNumber];
  const contentStart = offset;
  let cursor = offset;
  while (cursor < end) {
    const tagOffset = cursor;
    const tag = decodeTagHeader(buffer, cursor, end);
    if (!tag) return;
    cursor += tag.len;

    if (tag.isOpening) {
      if (stack.length >= MAX_CONSTRUCTED_DEPTH) return;
      stack.push(tag.tagNumber);
      continue;
    }
    if (tag.isClosing) {
      if (stack[stack.length - 1] !== tag.tagNumber) return;
      stack.pop();
      if (stack.length === 0) {
        return {contentStart: contentStart, contentEnd: tagOffset, end: cursor};
      }
      continue;
    }

    let dataLength = tag.value;
    if (!tag.isContext && tag.tagNumber === baEnum.ApplicationTags.NULL) {
      if (tag.lenValueType !== 0) return;
      dataLength = 0;
    } else if (!tag.isContext && tag.tagNumber === baEnum.ApplicationTags.BOOLEAN) {
      if (tag.lenValueType !== 0 && tag.lenValueType !== 1) return;
      dataLength = 0;
    } else if (!tag.isContext && (tag.lenValueType === 6 || tag.lenValueType === 7)) {
      return;
    }
    if (dataLength > end - cursor) return;
    cursor += dataLength;
  }
};

module.exports.encode = (buffer, objectId, propertyId, arrayIndex, requestType, position, time, count) => {
  baAsn1.encodeContextObjectId(buffer, 0, objectId.type, objectId.instance);
  baAsn1.encodeContextEnumerated(buffer, 1, propertyId);
  if (arrayIndex !== baEnum.ASN1_ARRAY_ALL) {
    baAsn1.encodeContextUnsigned(buffer, 2, arrayIndex);
  }
  switch (requestType) {
    case baEnum.ReadRangeType.BY_POSITION:
      baAsn1.encodeOpeningTag(buffer, 3);
      baAsn1.encodeApplicationUnsigned(buffer, position);
      baAsn1.encodeApplicationSigned(buffer, count);
      baAsn1.encodeClosingTag(buffer, 3);
      break;
    case baEnum.ReadRangeType.BY_SEQUENCE_NUMBER:
      baAsn1.encodeOpeningTag(buffer, 6);
      baAsn1.encodeApplicationUnsigned(buffer, position);
      baAsn1.encodeApplicationSigned(buffer, count);
      baAsn1.encodeClosingTag(buffer, 6);
      break;
    case baEnum.ReadRangeType.BY_TIME_REFERENCE_TIME_COUNT:
      baAsn1.encodeOpeningTag(buffer, 7);
      baAsn1.encodeApplicationDate(buffer, time);
      baAsn1.encodeApplicationTime(buffer, time);
      baAsn1.encodeApplicationSigned(buffer, count);
      baAsn1.encodeClosingTag(buffer, 7);
      break;
    default:
      break;
  }
};

module.exports.decode = (buffer, offset, apduLen) => {
  const window = getDecodeWindow(buffer, offset, apduLen);
  if (!window) return;
  let cursor = window.start;
  let requestType;
  let position;
  let time;
  let count;
  const object = decodePrimitive(buffer, cursor, window.end, 0, true, 4, 4);
  if (!object) return;
  const objectValue = buffer.readUInt32BE(object.dataOffset);
  const objectId = {
    type: (objectValue >>> baEnum.ASN1_INSTANCE_BITS) & baEnum.ASN1_MAX_OBJECT,
    instance: objectValue & baEnum.ASN1_MAX_INSTANCE
  };
  cursor += object.len;

  let decodedValue = decodeUnsignedPrimitive(buffer, cursor, window.end, 1, true);
  if (!decodedValue) return;
  const property = {id: decodedValue.value, index: baEnum.ASN1_ARRAY_ALL};
  cursor += decodedValue.len;

  let tag = decodeTagHeader(buffer, cursor, window.end);
  if (tag && tag.isContext && !tag.isOpening && !tag.isClosing && tag.tagNumber === 2) {
    decodedValue = decodeUnsignedPrimitive(buffer, cursor, window.end, 2, true);
    if (!decodedValue) return;
    property.index = decodedValue.value;
    cursor += decodedValue.len;
  }

  if (cursor < window.end) {
    tag = decodeTagHeader(buffer, cursor, window.end);
    if (!tag || !tag.isOpening || (tag.tagNumber !== 3 && tag.tagNumber !== 6 && tag.tagNumber !== 7)) return;
    const rangeTagNumber = tag.tagNumber;
    cursor += tag.len;

    if (rangeTagNumber === 3 || rangeTagNumber === 6) {
      requestType = rangeTagNumber === 3 ? baEnum.ReadRangeType.BY_POSITION : baEnum.ReadRangeType.BY_SEQUENCE_NUMBER;
      decodedValue = decodeUnsignedPrimitive(buffer, cursor, window.end, baEnum.ApplicationTags.UNSIGNED_INTEGER, false);
      if (!decodedValue) return;
      position = decodedValue.value;
      cursor += decodedValue.len;
      decodedValue = decodeSignedPrimitive(buffer, cursor, window.end, baEnum.ApplicationTags.SIGNED_INTEGER, false);
      if (!decodedValue) return;
      count = decodedValue.value;
      cursor += decodedValue.len;
    } else {
      requestType = baEnum.ReadRangeType.BY_TIME_REFERENCE_TIME_COUNT;
      const date = decodePrimitive(buffer, cursor, window.end, baEnum.ApplicationTags.DATE, false, 4, 4);
      if (!date) return;
      const decodedDate = baAsn1.decodeDate(buffer, date.dataOffset);
      if (!decodedDate) return;
      cursor += date.len;
      const clock = decodePrimitive(buffer, cursor, window.end, baEnum.ApplicationTags.TIME, false, 4, 4);
      if (!clock) return;
      const decodedTime = baAsn1.decodeBacnetTime(buffer, clock.dataOffset);
      if (!decodedTime) return;
      cursor += clock.len;
      const dateValue = decodedDate.value;
      const timeValue = decodedTime.value;
      time = new Date(dateValue.getFullYear(), dateValue.getMonth(), dateValue.getDate(), timeValue.getHours(), timeValue.getMinutes(), timeValue.getSeconds(), timeValue.getMilliseconds());
      decodedValue = decodeSignedPrimitive(buffer, cursor, window.end, baEnum.ApplicationTags.SIGNED_INTEGER, false);
      if (!decodedValue) return;
      count = decodedValue.value;
      cursor += decodedValue.len;
    }

    const closingLength = decodeConstructedTag(buffer, cursor, window.end, rangeTagNumber, false);
    if (!closingLength) return;
    cursor += closingLength;
  }
  if (cursor !== window.end) return;
  return {
    len: cursor - window.start,
    objectId: objectId,
    property: property,
    requestType: requestType,
    position: position,
    time: time,
    count: count
  };
};

module.exports.encodeAcknowledge = (buffer, objectId, propertyId, arrayIndex, resultFlags, itemCount, applicationData, requestType, firstSequence) => {
  if (!resultFlags || resultFlags.bitsUsed !== 3 || !Array.isArray(resultFlags.value) ||
      resultFlags.value.length !== 1) {
    throw new RangeError('ReadRange resultFlags must contain exactly three bits');
  }
  baAsn1.encodeContextObjectId(buffer, 0, objectId.type, objectId.instance);
  baAsn1.encodeContextEnumerated(buffer, 1, propertyId);
  if (arrayIndex !== baEnum.ASN1_ARRAY_ALL) {
    baAsn1.encodeContextUnsigned(buffer, 2, arrayIndex);
  }
  baAsn1.encodeContextBitstring(buffer, 3, resultFlags);
  baAsn1.encodeContextUnsigned(buffer, 4, itemCount);
  baAsn1.encodeOpeningTag(buffer, 5);
  if (itemCount !== 0) {
    applicationData.copy(buffer.buffer, buffer.offset, 0, applicationData.length);
    buffer.offset += applicationData.length;
  }
  baAsn1.encodeClosingTag(buffer, 5);
  if (itemCount !== 0 && requestType && requestType !== baEnum.ReadRangeType.BY_POSITION) {
    baAsn1.encodeContextUnsigned(buffer, 6, firstSequence);
  }
};

module.exports.decodeAcknowledge = (buffer, offset, apduLen) => {
  const window = getDecodeWindow(buffer, offset, apduLen);
  if (!window) return;
  let cursor = window.start;
  const object = decodePrimitive(buffer, cursor, window.end, 0, true, 4, 4);
  if (!object) return;
  const objectValue = buffer.readUInt32BE(object.dataOffset);
  const objectId = {
    type: (objectValue >>> baEnum.ASN1_INSTANCE_BITS) & baEnum.ASN1_MAX_OBJECT,
    instance: objectValue & baEnum.ASN1_MAX_INSTANCE
  };
  cursor += object.len;

  const property = {index: baEnum.ASN1_ARRAY_ALL};
  let decodedValue = decodeUnsignedPrimitive(buffer, cursor, window.end, 1, true);
  if (!decodedValue) return;
  property.id = decodedValue.value;
  cursor += decodedValue.len;

  let tag = decodeTagHeader(buffer, cursor, window.end);
  if (tag && tag.isContext && !tag.isOpening && !tag.isClosing && tag.tagNumber === 2) {
    decodedValue = decodeUnsignedPrimitive(buffer, cursor, window.end, 2, true);
    if (!decodedValue) return;
    property.index = decodedValue.value;
    cursor += decodedValue.len;
  }

  const flags = decodePrimitive(buffer, cursor, window.end, 3, true, 2, 2);
  if (!flags) return;
  decodedValue = baAsn1.decodeBitstring(buffer, flags.dataOffset, flags.dataLength);
  if (!decodedValue || decodedValue.value.bitsUsed !== 3) return;
  const resultFlag = decodedValue.value;
  cursor += flags.len;

  decodedValue = decodeUnsignedPrimitive(buffer, cursor, window.end, 4, true);
  if (!decodedValue) return;
  const itemCount = decodedValue.value;
  cursor += decodedValue.len;

  const openingLength = decodeConstructedTag(buffer, cursor, window.end, 5, true);
  if (!openingLength) return;
  cursor += openingLength;
  const range = decodeConstructedContents(buffer, cursor, window.end, 5);
  if (!range) return;
  const rangeBuffer = Buffer.from(buffer.subarray(range.contentStart, range.contentEnd));
  if ((itemCount === 0) !== (rangeBuffer.length === 0)) return;
  cursor = range.end;

  let firstSequence;
  if (cursor < window.end) {
    decodedValue = decodeUnsignedPrimitive(buffer, cursor, window.end, 6, true);
    if (!decodedValue || itemCount === 0) return;
    firstSequence = decodedValue.value;
    cursor += decodedValue.len;
  }
  if (cursor !== window.end) return;

  const value = {
    objectId: objectId,
    property: property,
    resultFlag: resultFlag,
    itemCount: itemCount,
    rangeBuffer: rangeBuffer,
    len: cursor - window.start
  };
  if (firstSequence !== undefined) value.firstSequence = firstSequence;
  return value;
};
