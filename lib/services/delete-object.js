'use strict';

const baAsn1      = require('../asn1');

module.exports.decode = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(apduLen) || apduLen < 0 || offset > buffer.length ||
      apduLen > buffer.length - offset) return;
  const result = baAsn1.decodeTagNumberAndValue(buffer, offset);
  if (!result || result.tagNumber !== 12 || result.value !== 4 ||
      baAsn1.decodeIsContextTag(buffer, offset, 12)) return;
  let len = result.len;
  const value = baAsn1.decodeObjectId(buffer, offset + len);
  if (!value || value.len > apduLen - len) return;
  len += value.len;
  if (len !== apduLen) return;
  value.len = len;
  return value;
};

module.exports.encode = (buffer, objectId) => {
  baAsn1.encodeApplicationObjectId(buffer, objectId.type, objectId.instance);
};
