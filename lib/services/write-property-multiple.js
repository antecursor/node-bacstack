'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

const validateValues = (values) => {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError('WritePropertyMultiple requires at least one property value');
  }
  values.forEach((pValue) => {
    if (!Array.isArray(pValue.value) || pValue.value.length === 0) {
      throw new RangeError('WritePropertyMultiple property values must not be empty');
    }
    const priority = pValue.priority == null ? baEnum.ASN1_NO_PRIORITY : pValue.priority;
    if (priority !== baEnum.ASN1_NO_PRIORITY &&
        (!Number.isSafeInteger(priority) || priority < baEnum.ASN1_MIN_PRIORITY ||
         priority > baEnum.ASN1_MAX_PRIORITY)) {
      throw new RangeError('WritePropertyMultiple priority must be omitted, 0, or between 1 and 16');
    }
  });
};

const encode = module.exports.encode = (buffer, objectId, values) => {
  validateValues(values);
  baAsn1.encodeContextObjectId(buffer, 0, objectId.type, objectId.instance);
  baAsn1.encodeOpeningTag(buffer, 1);
  values.forEach((pValue) => {
    baAsn1.encodeContextEnumerated(buffer, 0, pValue.property.id);
    if (pValue.property.index !== baEnum.ASN1_ARRAY_ALL) {
      baAsn1.encodeContextUnsigned(buffer, 1, pValue.property.index);
    }
    baAsn1.encodeOpeningTag(buffer, 2);
    pValue.value.forEach((value) => {
      baAsn1.bacappEncodeApplicationData(buffer, value);
    });
    baAsn1.encodeClosingTag(buffer, 2);
    const priority = pValue.priority == null ? baEnum.ASN1_NO_PRIORITY : pValue.priority;
    if (priority !== baEnum.ASN1_NO_PRIORITY) {
      baAsn1.encodeContextUnsigned(buffer, 3, priority);
    }
  });
  baAsn1.encodeClosingTag(buffer, 1);
};

module.exports.decode = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(apduLen) || apduLen < 0 || offset > buffer.length ||
      apduLen > buffer.length - offset) return;
  const endOffset = offset + apduLen;
  let len = 0;
  let result;
  let decodedValue;
  let objectId;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || !baAsn1.decodeIsContextTag(buffer, offset + len, 0) || result.value !== 4) return;
  len += result.len;
  decodedValue = baAsn1.decodeObjectId(buffer, offset + len);
  if (!decodedValue || decodedValue.len > endOffset - (offset + len)) return;
  len += decodedValue.len;
  objectId = {
    type: decodedValue.objectType,
    instance: decodedValue.instance
  };
  if (!baAsn1.decodeIsOpeningTagNumber(buffer, offset + len, 1)) return;
  len++;
  const _values = [];
  while ((endOffset - (offset + len)) > 1) {
    let newEntry = {};
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!result || !baAsn1.decodeIsContextTag(buffer, offset + len, 0)) return;
    len += result.len;
    decodedValue = baAsn1.decodeEnumerated(buffer, offset + len, result.value);
    if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
    len += decodedValue.len;
    let propertyId = decodedValue.value;
    let arrayIndex = baEnum.ASN1_ARRAY_ALL;
    result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
    if (!result) return;
    len += result.len;
    if (result.tagNumber === 1) {
      if (!baAsn1.decodeIsContextTag(buffer, offset + len - result.len, 1)) return;
      decodedValue = baAsn1.decodeUnsigned(buffer, offset + len, result.value);
      if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
      len += decodedValue.len;
      arrayIndex = decodedValue.value;
      result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
      if (!result) return;
      len += result.len;
    }
    newEntry.property = {id: propertyId, index: arrayIndex};
    if (!baAsn1.decodeIsOpeningTagNumber(buffer, offset + len - result.len, 2)) return;
    const values = [];
    while ((offset + len) < endOffset && !baAsn1.decodeIsClosingTag(buffer, offset + len)) {
      let value = baAsn1.bacappDecodeApplicationData(buffer, offset + len, endOffset, objectId.type, propertyId);
      if (!value || value.len < 1 || value.len > endOffset - (offset + len)) return;
      len += value.len;
      delete value.len;
      values.push(value);
    }
    if (!baAsn1.decodeIsClosingTagNumber(buffer, offset + len, 2)) return;
    if (values.length === 0) return;
    len++;
    newEntry.value = values;
    let priority = baEnum.ASN1_NO_PRIORITY;
    if (baAsn1.decodeIsContextTag(buffer, offset + len, 3)) {
      result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
      if (!result) return;
      len += result.len;
      decodedValue = baAsn1.decodeUnsigned(buffer, offset + len, result.value);
      if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
      len += decodedValue.len;
      priority = decodedValue.value;
      if (priority < baEnum.ASN1_MIN_PRIORITY || priority > baEnum.ASN1_MAX_PRIORITY) return;
    }
    newEntry.priority = priority;
    _values.push(newEntry);
  }
  if (_values.length === 0) return;
  if (!baAsn1.decodeIsClosingTagNumber(buffer, offset + len, 1)) return;
  len++;
  if (len !== apduLen) return;
  return {
    len: len,
    objectId: objectId,
    values: _values
  };
};

module.exports.encodeObject = (buffer, values) => {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError('WritePropertyMultiple requires at least one write access specification');
  }
  values.forEach((object) => validateValues(object.values));
  values.forEach((object) => {
    encode(buffer, object.objectId, object.values);
  });
};
