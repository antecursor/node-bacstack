'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

module.exports.encode = (buffer, time, useUtc) => {
  const encodeDate = useUtc ? baAsn1.encodeApplicationDateUTC : baAsn1.encodeApplicationDate;
  const encodeTime = useUtc ? baAsn1.encodeApplicationTimeUTC : baAsn1.encodeApplicationTime;
  encodeDate(buffer, time);
  encodeTime(buffer, time);
};

module.exports.encodeUTC = (buffer, time) => module.exports.encode(buffer, time, true);

module.exports.decode = (buffer, offset, length, useUtc) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length < 0 ||
      offset > buffer.length || length > buffer.length - offset) return;
  let len = 0;
  let result;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || result.value !== 4 || result.len + result.value > length) return;
  len += result.len;
  if (result.tagNumber !== baEnum.ApplicationTags.DATE) return;
  const decodeDate = useUtc ? baAsn1.decodeDateUTC : baAsn1.decodeDate;
  const date = decodeDate(buffer, offset + len);
  if (!date) return;
  len += date.len;
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || result.value !== 4 || len + result.len + result.value > length) return;
  len += result.len;
  if (result.tagNumber !== baEnum.ApplicationTags.TIME) return;
  const decodeTime = useUtc ? baAsn1.decodeBacnetTimeUTC : baAsn1.decodeBacnetTime;
  const time = decodeTime(buffer, offset + len);
  if (!time) return;
  len += time.len;
  if (len !== length) return;
  const value = useUtc ?
    new Date(Date.UTC(date.value.getUTCFullYear(), date.value.getUTCMonth(), date.value.getUTCDate(), time.value.getUTCHours(), time.value.getUTCMinutes(), time.value.getUTCSeconds(), time.value.getUTCMilliseconds())) :
    new Date(date.value.getFullYear(), date.value.getMonth(), date.value.getDate(), time.value.getHours(), time.value.getMinutes(), time.value.getSeconds(), time.value.getMilliseconds());
  return {
    len: len,
    value: value
  };
};

module.exports.decodeUTC = (buffer, offset, length) => module.exports.decode(buffer, offset, length, true);
