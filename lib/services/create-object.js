'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

module.exports.encode = (buffer, objectId, values) => {
  baAsn1.encodeOpeningTag(buffer, 0);
  if (objectId.instance === undefined) {
    baAsn1.encodeContextEnumerated(buffer, 0, objectId.type);
  } else {
    baAsn1.encodeContextObjectId(buffer, 1, objectId.type, objectId.instance);
  }
  baAsn1.encodeClosingTag(buffer, 0);
  if (!values || values.length === 0) return;
  baAsn1.encodeOpeningTag(buffer, 1);
  values.forEach((propertyValue) => {
    baAsn1.encodeContextEnumerated(buffer, 0, propertyValue.property.id);
    if (propertyValue.property.index !== baEnum.ASN1_ARRAY_ALL) {
      baAsn1.encodeContextUnsigned(buffer, 1, propertyValue.property.index);
    }
    baAsn1.encodeOpeningTag(buffer, 2);
    propertyValue.value.forEach((value) => {
      baAsn1.bacappEncodeApplicationData(buffer, value);
    });
    baAsn1.encodeClosingTag(buffer, 2);
    if (propertyValue.priority !== baEnum.ASN1_NO_PRIORITY) {
      baAsn1.encodeContextUnsigned(buffer, 3, propertyValue.priority);
    }
  });
  baAsn1.encodeClosingTag(buffer, 1);
};

module.exports.decode = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(apduLen) || apduLen < 0 || offset > buffer.length ||
      apduLen > buffer.length - offset) return;
  const endOffset = offset + apduLen;
  let cursor = offset;

  const readConstructedTag = (tagNumber, opening) => {
    const result = baAsn1.decodeTagNumberAndValue(buffer, cursor);
    if (!result || result.len > endOffset - cursor) return false;
    const matches = opening ?
      baAsn1.decodeIsOpeningTagNumber(buffer, cursor, tagNumber) :
      baAsn1.decodeIsClosingTagNumber(buffer, cursor, tagNumber);
    if (!matches) return false;
    cursor += result.len;
    return true;
  };

  const readPrimitive = (tagNumber, decode, expectedLength) => {
    const result = baAsn1.decodeTagNumberAndValue(buffer, cursor);
    if (!result || !baAsn1.decodeIsContextTag(buffer, cursor, tagNumber) ||
        baAsn1.decodeIsOpeningTag(buffer, cursor) ||
        baAsn1.decodeIsClosingTag(buffer, cursor) ||
        (expectedLength !== undefined && result.value !== expectedLength) ||
        result.len > endOffset - cursor ||
        result.value > endOffset - cursor - result.len) return;
    const decoded = decode(buffer, cursor + result.len, result.value);
    if (!decoded || decoded.len !== result.value || Number.isNaN(decoded.value)) return;
    cursor += result.len + result.value;
    return decoded;
  };

  if (!readConstructedTag(0, true)) return;
  let objectId;
  if (baAsn1.decodeIsContextTag(buffer, cursor, 0)) {
    const decodedObjectType = readPrimitive(0, baAsn1.decodeEnumerated);
    if (!decodedObjectType || decodedObjectType.value > baEnum.ASN1_MAX_OBJECT) return;
    objectId = {type: decodedObjectType.value};
  } else {
    const decodedObjectId = readPrimitive(1, baAsn1.decodeObjectId, 4);
    if (!decodedObjectId) return;
    objectId = {
      type: decodedObjectId.objectType,
      instance: decodedObjectId.instance
    };
  }
  if (!readConstructedTag(0, false)) return;
  const values = [];

  if (cursor === endOffset) {
    return {len: apduLen, objectId: objectId, values: values};
  }
  if (!readConstructedTag(1, true)) return;

  while (!baAsn1.decodeIsClosingTagNumber(buffer, cursor, 1)) {
    const property = readPrimitive(0, baAsn1.decodeEnumerated);
    if (!property) return;
    let arrayIndex = baEnum.ASN1_ARRAY_ALL;
    if (baAsn1.decodeIsContextTag(buffer, cursor, 1)) {
      const decodedArrayIndex = readPrimitive(1, baAsn1.decodeUnsigned);
      if (!decodedArrayIndex) return;
      arrayIndex = decodedArrayIndex.value;
    }
    if (!readConstructedTag(2, true)) return;

    const propertyValues = [];
    while (!baAsn1.decodeIsClosingTagNumber(buffer, cursor, 2)) {
      if (cursor >= endOffset) return;
      const decodedValue = baAsn1.bacappDecodeApplicationData(
        buffer,
        cursor,
        endOffset,
        objectId.type,
        property.value
      );
      if (!decodedValue || !Number.isSafeInteger(decodedValue.len) ||
          decodedValue.len < 1 || decodedValue.len > endOffset - cursor) return;
      cursor += decodedValue.len;
      const value = Object.assign({}, decodedValue);
      delete value.len;
      propertyValues.push(value);
    }
    if (!readConstructedTag(2, false)) return;

    const entry = {
      property: {id: property.value, index: arrayIndex},
      value: propertyValues
    };
    if (baAsn1.decodeIsContextTag(buffer, cursor, 3)) {
      const priority = readPrimitive(3, baAsn1.decodeUnsigned);
      if (!priority || priority.value < baEnum.ASN1_MIN_PRIORITY ||
          priority.value > baEnum.ASN1_MAX_PRIORITY) return;
      entry.priority = priority.value;
    }
    values.push(entry);
  }

  if (!readConstructedTag(1, false) || cursor !== endOffset) return;
  return {
    len: cursor - offset,
    objectId: objectId,
    values: values
  };
};

module.exports.encodeAcknowledge = (buffer, objectId) => {
  baAsn1.encodeApplicationObjectId(buffer, objectId.type, objectId.instance);
};

module.exports.decodeAcknowledge = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(apduLen) || apduLen < 0 || offset > buffer.length ||
      apduLen > buffer.length - offset) return;
  const endOffset = offset + apduLen;
  const tag = baAsn1.decodeTagNumberAndValue(buffer, offset, endOffset);
  if (!tag || tag.tagNumber !== baEnum.ApplicationTags.OBJECTIDENTIFIER ||
      baAsn1.decodeIsContextTag(buffer, offset, tag.tagNumber) || tag.value !== 4 ||
      tag.len + tag.value !== apduLen) return;
  const decoded = baAsn1.decodeObjectId(buffer, offset + tag.len);
  if (!decoded) return;
  return {
    len: apduLen,
    objectId: {type: decoded.objectType, instance: decoded.instance}
  };
};
