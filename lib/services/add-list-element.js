'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

module.exports.encode = (buffer, objectId, propertyId, arrayIndex, values) => {
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
  if (!result || !baAsn1.decodeIsContextTag(buffer, offset + len, 0) || result.value !== 4) return;
  len += result.len;
  decodedValue = baAsn1.decodeObjectId(buffer, offset + len);
  if (!decodedValue || decodedValue.len > endOffset - (offset + len)) return;
  len += decodedValue.len;
  value.objectId = {type: decodedValue.objectType, instance: decodedValue.instance};
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || !baAsn1.decodeIsContextTag(buffer, offset + len, 1)) return;
  len += result.len;
  decodedValue = baAsn1.decodeEnumerated(buffer, offset + len, result.value);
  if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
  len += decodedValue.len;
  value.property = {id: decodedValue.value};
  if (len < apduLen && baAsn1.decodeIsContextTag(buffer, offset + len, 2)) {
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!result) return;
    len += result.len;
    decodedValue = baAsn1.decodeUnsigned(buffer, offset + len, result.value);
    if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
    len += decodedValue.len;
    value.property.index = decodedValue.value;
  } else {
    value.property.index = baEnum.ASN1_ARRAY_ALL;
  }
  const values = [];
  if (!baAsn1.decodeIsOpeningTagNumber(buffer, offset + len, 3)) return;
  len++;
  while ((endOffset - (offset + len)) > 1) {
    result = baAsn1.bacappDecodeApplicationData(buffer, offset + len, endOffset, value.objectId.type, value.property.id);
    if (!result || result.len < 1 || result.len > endOffset - (offset + len)) return;
    len += result.len;
    delete result.len;
    values.push(result);
  }
  value.values = values;
  if (!baAsn1.decodeIsClosingTagNumber(buffer, offset + len, 3)) return;
  len++;
  if (len !== apduLen) return;
  value.len = len;
  return value;
};
