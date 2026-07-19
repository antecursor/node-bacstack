'use strict';

const baAsn1      = require('../asn1');

const isValidDecodeWindow = (buffer, offset, apduLen) => {
  return Buffer.isBuffer(buffer) && Number.isSafeInteger(offset) && offset >= 0 &&
    Number.isSafeInteger(apduLen) && apduLen > 0 && offset <= buffer.length &&
    apduLen <= buffer.length - offset;
};

const hasInvalidDecodedValue = (value, seen = new Set()) => {
  if (value === undefined || (typeof value === 'number' && Number.isNaN(value)) ||
      (value instanceof Date && Number.isNaN(value.getTime()))) return true;
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => hasInvalidDecodedValue(child, seen));
};

const decodeList = (buffer, offset, apduLen, decode) => {
  if (!isValidDecodeWindow(buffer, offset, apduLen)) return;
  let len = 0;
  const values = [];
  while (len < apduLen) {
    let result;
    try {
      result = decode(buffer, offset + len, apduLen - len);
    } catch {
      return;
    }
    if (!result || !Number.isSafeInteger(result.len) || result.len <= 0 ||
        result.len > apduLen - len || hasInvalidDecodedValue(result.value)) return;
    len += result.len;
    values.push(result.value);
  }
  if (len !== apduLen) return;
  return {len: len, values: values};
};

module.exports.encode = (buffer, properties) => {
  properties.forEach((value) => {
    baAsn1.encodeReadAccessSpecification(buffer, value);
  });
};

module.exports.decode = (buffer, offset, apduLen) => {
  const result = decodeList(buffer, offset, apduLen, baAsn1.decodeReadAccessSpecification);
  if (!result) return;
  return {
    len: result.len,
    properties: result.values
  };
};

module.exports.encodeAcknowledge = (buffer, values) => {
  values.forEach((value) => {
    baAsn1.encodeReadAccessResult(buffer, value);
  });
};

module.exports.decodeAcknowledge = (buffer, offset, apduLen) => {
  const result = decodeList(
    buffer,
    offset,
    apduLen,
    (source, sourceOffset, sourceLength) => baAsn1.decodeReadAccessResult(
      source,
      sourceOffset,
      sourceLength,
      0,
      true
    )
  );
  if (!result) return;
  return {
    len: result.len,
    values: result.values
  };
};
