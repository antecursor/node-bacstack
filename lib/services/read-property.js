'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

module.exports.encode = (buffer, objectType, objectInstance, propertyId, arrayIndex) => {
  if (objectType <= baEnum.ASN1_MAX_OBJECT) {
    baAsn1.encodeContextObjectId(buffer, 0, objectType, objectInstance);
  }
  if (propertyId <= baEnum.ASN1_MAX_PROPERTY_ID) {
    baAsn1.encodeContextEnumerated(buffer, 1, propertyId);
  }
  if (arrayIndex !== baEnum.ASN1_ARRAY_ALL) {
    baAsn1.encodeContextUnsigned(buffer, 2, arrayIndex);
  }
};

module.exports.decode = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(apduLen) || apduLen < 0 || offset > buffer.length ||
      apduLen > buffer.length - offset) return;
  const endOffset = offset + apduLen;
  let cursor = offset;
  const readPrimitive = (tagNumber, minLength, maxLength, decode) => {
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

  const decodedObject = readPrimitive(0, 4, 4, baAsn1.decodeObjectId);
  if (!decodedObject) return;
  const decodedProperty = readPrimitive(1, 1, 4, baAsn1.decodeEnumerated);
  if (!decodedProperty || decodedProperty.value > baEnum.ASN1_MAX_PROPERTY_ID) return;
  const objectId = {type: decodedObject.objectType, instance: decodedObject.instance};
  const property = {id: decodedProperty.value, index: baEnum.ASN1_ARRAY_ALL};
  if (cursor < endOffset) {
    const arrayIndex = readPrimitive(2, 1, 4, baAsn1.decodeUnsigned);
    if (!arrayIndex) return;
    property.index = arrayIndex.value;
  }
  if (cursor !== endOffset) return;
  return {
    len: cursor - offset,
    objectId: objectId,
    property: property
  };
};

module.exports.encodeAcknowledge = (buffer, objectId, propertyId, arrayIndex, values) => {
  baAsn1.encodeContextObjectId(buffer, 0, objectId.type, objectId.instance);
  baAsn1.encodeContextEnumerated(buffer, 1, propertyId);
  if (arrayIndex !== baEnum.ASN1_ARRAY_ALL) {
    baAsn1.encodeContextUnsigned(buffer, 2, arrayIndex);
  }
  baAsn1.encodeOpeningTag(buffer, 3);
  values.forEach((value) => {
    baAsn1.bacappEncodeApplicationData(buffer, value);
  });
  baAsn1.encodeClosingTag(buffer, 3);
};

const decodeContextPrimitive = (buffer, offset, endOffset, tagNumber, minLength, maxLength, decode) => {
  const tag = baAsn1.decodeTagNumberAndValue(buffer, offset, endOffset);
  if (!tag || tag.tagNumber !== tagNumber ||
      !baAsn1.decodeIsContextTag(buffer, offset, tagNumber) ||
      baAsn1.decodeIsOpeningTag(buffer, offset) ||
      baAsn1.decodeIsClosingTag(buffer, offset) ||
      tag.value < minLength || tag.value > maxLength ||
      tag.value > endOffset - offset - tag.len) return;
  const decoded = decode(buffer, offset + tag.len, tag.value);
  if (!decoded || decoded.len !== tag.value || Number.isNaN(decoded.value)) return;
  return {
    decoded: decoded,
    len: tag.len + tag.value
  };
};

const decodeConstructedTag = (buffer, offset, endOffset, tagNumber, opening) => {
  const tag = baAsn1.decodeTagNumberAndValue(buffer, offset, endOffset);
  if (!tag || tag.tagNumber !== tagNumber || tag.len > endOffset - offset) return;
  const matches = opening ?
    baAsn1.decodeIsOpeningTagNumber(buffer, offset, tagNumber) :
    baAsn1.decodeIsClosingTagNumber(buffer, offset, tagNumber);
  return matches ? tag.len : undefined;
};

const hasInvalidDecodedValue = (value, seen = new Set()) => {
  if (value === undefined || (typeof value === 'number' && Number.isNaN(value)) ||
      (value instanceof Date && Number.isNaN(value.getTime()))) return true;
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => hasInvalidDecodedValue(child, seen));
};

const copyDecodedValue = (value) => {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(copyDecodedValue);
  if (value === null || typeof value !== 'object') return value;
  const copy = {};
  Object.entries(value).forEach(([key, child]) => {
    copy[key] = copyDecodedValue(child);
  });
  return copy;
};

module.exports.decodeAcknowledge = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(apduLen) || apduLen < 0 || offset > buffer.length ||
      apduLen > buffer.length - offset) return;
  const endOffset = offset + apduLen;
  let cursor = offset;

  let result = decodeContextPrimitive(
    buffer,
    cursor,
    endOffset,
    0,
    4,
    4,
    baAsn1.decodeObjectId
  );
  if (!result) return;
  cursor += result.len;
  const objectId = {
    type: result.decoded.objectType,
    instance: result.decoded.instance
  };

  result = decodeContextPrimitive(
    buffer,
    cursor,
    endOffset,
    1,
    1,
    4,
    baAsn1.decodeEnumerated
  );
  if (!result || result.decoded.value > baEnum.ASN1_MAX_PROPERTY_ID) return;
  cursor += result.len;
  const property = {
    id: result.decoded.value,
    index: baEnum.ASN1_ARRAY_ALL
  };

  if (baAsn1.decodeIsContextTag(buffer, cursor, 2)) {
    result = decodeContextPrimitive(
      buffer,
      cursor,
      endOffset,
      2,
      1,
      4,
      baAsn1.decodeUnsigned
    );
    if (!result) return;
    cursor += result.len;
    property.index = result.decoded.value;
  }

  const openingLength = decodeConstructedTag(buffer, cursor, endOffset, 3, true);
  if (!openingLength) return;
  cursor += openingLength;
  const values = [];
  while (cursor < endOffset) {
    const closingLength = decodeConstructedTag(buffer, cursor, endOffset, 3, false);
    if (closingLength) {
      cursor += closingLength;
      if (cursor !== endOffset) return;
      return {
        len: cursor - offset,
        objectId: objectId,
        property: property,
        values: values
      };
    }
    if (baAsn1.decodeIsClosingTag(buffer, cursor)) return;
    try {
      result = baAsn1.bacappDecodeApplicationData(
        buffer,
        cursor,
        endOffset,
        objectId.type,
        property.id
      );
    } catch {
      return;
    }
    if (!result || !Number.isSafeInteger(result.len) || result.len <= 0 ||
        result.len > endOffset - cursor || hasInvalidDecodedValue(result.value)) return;
    cursor += result.len;
    const value = {
      type: result.type,
      value: copyDecodedValue(result.value)
    };
    if (result.encoding !== undefined) value.encoding = result.encoding;
    values.push(value);
  }
  return;
};
