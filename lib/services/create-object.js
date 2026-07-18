'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

module.exports.encode = (buffer, objectId, values) => {
  baAsn1.encodeOpeningTag(buffer, 0);
  baAsn1.encodeContextObjectId(buffer, 1, objectId.type, objectId.instance);
  baAsn1.encodeClosingTag(buffer, 0);
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
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(apduLen) || apduLen < 0 || offset > buffer.length) return;
  const endOffset = apduLen > buffer.length - offset ? buffer.length : offset + apduLen;
  let len = 0;
  let result;
  let decodedValue;
  let objectId;
  const valueList = [];
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result) return;
  len += result.len;
  if ((result.tagNumber === 0) && (apduLen > len)) {
    apduLen -= len;
    if (apduLen < 4) return;
    decodedValue = baAsn1.decodeContextObjectId(buffer, offset + len, 1);
    if (!decodedValue) return;
    len += decodedValue.len;
    objectId = {type: decodedValue.objectType, instance: decodedValue.instance};
  } else {
    return;
  }
  if (!baAsn1.decodeIsClosingTagNumber(buffer, offset + len, 0)) return;
  len++;
  if (!baAsn1.decodeIsOpeningTagNumber(buffer, offset + len, 1)) return;
  len++;
  while ((endOffset - (offset + len)) > 1) {
    let newEntry = {};
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!result) return;
    len += result.len;
    if (result.tagNumber !== 0) return;
    decodedValue = baAsn1.decodeEnumerated(buffer, offset + len, result.value);
    if (Number.isNaN(decodedValue.value)) return;
    len += decodedValue.len;
    let propertyId = decodedValue.value;
    let arraIndex = baEnum.ASN1_ARRAY_ALL;
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!result) return;
    len += result.len;
    if (result.tagNumber === 1) {
      decodedValue = baAsn1.decodeUnsigned(buffer, offset + len, result.value);
      if (Number.isNaN(decodedValue.value)) return;
      len += decodedValue.len;
      arraIndex += decodedValue.value;
      result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
      if (!result) return;
      len += result.len;
    }
    newEntry.property = {id: propertyId, index: arraIndex};
    if ((result.tagNumber === 2) && (baAsn1.decodeIsOpeningTag(buffer, offset + len - 1))) {
      const values = [];
      while ((offset + len) < endOffset && !baAsn1.decodeIsClosingTag(buffer, offset + len)) {
        decodedValue = baAsn1.bacappDecodeApplicationData(buffer, offset + len, endOffset, objectId.type, propertyId);
        if (!decodedValue || decodedValue.len < 1 || decodedValue.len > endOffset - (offset + len)) return;
        len += decodedValue.len;
        delete decodedValue.len;
        values.push(decodedValue);
      }
      if (!baAsn1.decodeIsClosingTagNumber(buffer, offset + len, 2)) return;
      len++;
      newEntry.value = values;
    } else {
      return;
    }
    valueList.push(newEntry);
  }
  if (!baAsn1.decodeIsClosingTagNumber(buffer, offset + len, 1)) return;
  len++;
  return {
    len: len,
    objectId: objectId,
    values: valueList
  };
};

module.exports.encodeAcknowledge = (buffer, objectId) => {
  baAsn1.encodeApplicationObjectId(buffer, objectId.type, objectId.instance);
};
