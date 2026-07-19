'use strict';

const baAsn1      = require('../asn1');

const normalizeData = (data) => {
  if (data == null) return;
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array) && !Array.isArray(data)) {
    throw new TypeError('PrivateTransfer data must be a Buffer, Uint8Array, or array of octets');
  }
  const normalized = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    if (!Number.isInteger(data[i]) || data[i] < 0 || data[i] > 0xFF) {
      throw new RangeError('PrivateTransfer data must contain only integer octets');
    }
    normalized[i] = data[i];
  }
  return normalized;
};

module.exports.encode = (buffer, vendorId, serviceNumber, data) => {
  const normalizedData = normalizeData(data);
  baAsn1.encodeContextUnsigned(buffer, 0, vendorId);
  baAsn1.encodeContextUnsigned(buffer, 1, serviceNumber);
  if (normalizedData) {
    baAsn1.encodeOpeningTag(buffer, 2);
    normalizedData.copy(buffer.buffer, buffer.offset);
    buffer.offset += normalizedData.length;
    baAsn1.encodeClosingTag(buffer, 2);
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
  value.vendorId = decodedValue.value;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || !baAsn1.decodeIsContextTag(buffer, offset + len, 1)) return;
  len += result.len;
  decodedValue = baAsn1.decodeUnsigned(buffer, offset + len, result.value);
  if (!decodedValue || Number.isNaN(decodedValue.value) || decodedValue.len > endOffset - (offset + len)) return;
  len += decodedValue.len;
  value.serviceNumber = decodedValue.value;
  value.data = Buffer.alloc(0);
  if (len === apduLen) {
    value.len = len;
    return value;
  }
  if (!baAsn1.decodeIsOpeningTagNumber(buffer, offset + len, 2)) return;
  len++;
  const size = endOffset - (offset + len) - 1;
  if (size < 0) return;
  value.data = Buffer.from(buffer.subarray(offset + len, offset + len + size));
  len += size;
  if (!baAsn1.decodeIsClosingTagNumber(buffer, offset + len, 2)) return;
  len++;
  if (len !== apduLen) return;
  value.len = len;
  return value;
};
