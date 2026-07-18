'use strict';

const iconv       = require('iconv-lite');
const baEnum      = require('./enum');

const MAX_DECODE_NESTING = 32;

const isNonNegativeSafeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

const isDecodeRangeValid = (buffer, offset, length, maxLength) => {
  if (!Buffer.isBuffer(buffer) || !isNonNegativeSafeInteger(offset) || !isNonNegativeSafeInteger(length)) return false;
  if (offset > buffer.length || length > buffer.length - offset) return false;
  if (maxLength === undefined) return true;
  return isNonNegativeSafeInteger(maxLength) && length <= maxLength;
};

const getRemainingDecodeLength = (buffer, offset, maxOffset) => {
  if (!Buffer.isBuffer(buffer) || !isNonNegativeSafeInteger(offset) || offset > buffer.length) return 0;
  if (!isNonNegativeSafeInteger(maxOffset) || maxOffset < offset) return 0;
  return Math.min(buffer.length, maxOffset) - offset;
};

const getBuffer = () => {
  return {
    buffer: Buffer.alloc(1472),
    offset: 0
  };
};

const getSignedLength = (value) => {
  if ((value >= -128) && (value < 128)) return 1;
  else if ((value >= -32768) && (value < 32768)) return 2;
  else if ((value > -8388608) && (value < 8388608)) return 3;
  else return 4;
};

const getUnsignedLength = (value) => {
  if (value < 0x100) return 1;
  else if (value < 0x10000) return 2;
  else if (value < 0x1000000) return 3;
  else return 4;
};

const getEncodingType = (encoding, decodingBuffer, decodingOffset) => {
  switch (encoding) {
    case baEnum.CharacterStringEncoding.UTF_8:
      return 'utf8';
    case baEnum.CharacterStringEncoding.UCS_2:
      if (decodingBuffer && decodingBuffer[decodingOffset] === 0xFF && decodingBuffer[decodingOffset + 1] === 0xFE) {
        return 'ucs2';
      }
      return 'UTF-16BE';  // Default to big-endian
    case baEnum.CharacterStringEncoding.ISO_8859_1:
      return 'latin1';
    case baEnum.CharacterStringEncoding.UCS_4:
      return 'utf8';      // HACK: There is currently no support for UTF-32
    case baEnum.CharacterStringEncoding.MICROSOFT_DBCS:
      return 'cp850';
    case baEnum.CharacterStringEncoding.JIS_X_0208:
      return 'Shift_JIS';
    default:
      return 'utf8';
  }
};

const encodeUnsigned = (buffer, value, length) => {
  buffer.buffer.writeUIntBE(value, buffer.offset, length, true);
  buffer.offset += length;
};

const encodeBacnetUnsigned = (buffer, value) => {
  encodeUnsigned(buffer, value, getUnsignedLength(value));
};

const encodeSigned = (buffer, value, length) => {
  buffer.buffer.writeIntBE(value, buffer.offset, length, true);
  buffer.offset += length;
};

const encodeBacnetSigned = (buffer, value) => {
  encodeSigned(buffer, value, getSignedLength(value));
};

const encodeBacnetReal = (buffer, value) => {
  buffer.buffer.writeFloatBE(value, buffer.offset, true);
  buffer.offset += 4;
};

const encodeBacnetDouble = (buffer, value) => {
  buffer.buffer.writeDoubleBE(value, buffer.offset, true);
  buffer.offset += 8;
};

const decodeUnsigned = module.exports.decodeUnsigned = (buffer, offset, length) => {
  return {
    len: length,
    value: length < 1 || length > 4 || !isDecodeRangeValid(buffer, offset, length) ? NaN : buffer.readUIntBE(offset, length, true)
  };
};

const decodeEnumerated = module.exports.decodeEnumerated = (buffer, offset, lenValue) => {
  return decodeUnsigned(buffer, offset, lenValue);
};

const encodeBacnetObjectId = module.exports.encodeBacnetObjectId = (buffer, objectType, instance) => {
  const value = (((objectType & baEnum.ASN1_MAX_OBJECT) << baEnum.ASN1_INSTANCE_BITS) | (instance & baEnum.ASN1_MAX_INSTANCE))>>>0;
  encodeUnsigned(buffer, value, 4);
};

const encodeTag = module.exports.encodeTag = (buffer, tagNumber, contextSpecific, lenValueType) => {
  let len = 1;
  const tmp = new Array(3);
  tmp[0] = 0;
  if (contextSpecific) {
    tmp[0] |= 0x8;
  }
  if (tagNumber <= 14) {
    tmp[0] |= (tagNumber << 4);
  } else {
    tmp[0] |= 0xF0;
    tmp[1] = tagNumber;
    len++;
  }
  if (lenValueType <= 4) {
    tmp[0] |= lenValueType;
    Buffer.from(tmp).copy(buffer.buffer, buffer.offset, 0, len);
    buffer.offset += len;
  } else {
    tmp[0] |= 5;
    if (lenValueType <= 253) {
      tmp[len++] = lenValueType;
      Buffer.from(tmp).copy(buffer.buffer, buffer.offset, 0, len);
      buffer.offset += len;
    } else if (lenValueType <= 65535) {
      tmp[len++] = 254;
      Buffer.from(tmp).copy(buffer.buffer, buffer.offset, 0, len);
      buffer.offset += len;
      encodeUnsigned(buffer, lenValueType, 2);
    } else {
      tmp[len++] = 255;
      Buffer.from(tmp).copy(buffer.buffer, buffer.offset, 0, len);
      buffer.offset += len;
      encodeUnsigned(buffer, lenValueType, 4);
    }
  }
};

const encodeBacnetEnumerated = (buffer, value) => {
  encodeBacnetUnsigned(buffer, value);
};

const isExtendedTagNumber = (x) => {
  return (x & 0xF0) === 0xF0;
};

const isExtendedValue = (x) => {
  return (x & 0x07) === 5;
};

const isContextSpecific = (x) => {
  return (x & 0x8) === 0x8;
};

const isOpeningTag = (x) => {
  return (x & 0x07) === 6;
};

const isClosingTag = (x) => {
  return (x & 0x07) === 7;
};

const encodeContextReal = module.exports.encodeContextReal = (buffer, tagNumber, value) => {
  encodeTag(buffer, tagNumber, true, 4);
  encodeBacnetReal(buffer, value);
};

const encodeContextUnsigned = module.exports.encodeContextUnsigned = (buffer, tagNumber, value) => {
  encodeTag(buffer, tagNumber, true, getUnsignedLength(value));
  encodeBacnetUnsigned(buffer, value);
};

const encodeContextEnumerated = module.exports.encodeContextEnumerated = (buffer, tagNumber, value) => {
  encodeContextUnsigned(buffer, tagNumber, value);
};

const encodeOctetString = (buffer, octetString, octetOffset, octetCount) => {
  if (octetString) {
    for (let i = octetOffset; i < (octetOffset + octetCount); i++) {
      buffer.buffer[buffer.offset++] = octetString[i];
    }
  }
};

const encodeApplicationOctetString = module.exports.encodeApplicationOctetString = (buffer, octetString, octetOffset, octetCount) => {
  encodeTag(buffer, baEnum.ApplicationTags.OCTET_STRING, false, octetCount);
  encodeOctetString(buffer, octetString, octetOffset, octetCount);
};

const encodeApplicationNull = (buffer) => {
  buffer.buffer[buffer.offset++] = baEnum.ApplicationTags.NULL;
};

const encodeApplicationBoolean = module.exports.encodeApplicationBoolean = (buffer, booleanValue) => {
  encodeTag(buffer, baEnum.ApplicationTags.BOOLEAN, false, booleanValue ? 1 : 0);
};

const encodeApplicationReal = (buffer, value) => {
  encodeTag(buffer, baEnum.ApplicationTags.REAL, false, 4);
  encodeBacnetReal(buffer, value);
};

const encodeApplicationDouble = (buffer, value) => {
  encodeTag(buffer, baEnum.ApplicationTags.DOUBLE, false, 8);
  encodeBacnetDouble(buffer, value);
};

const bitstringBytesUsed = (bitString) => {
  let len = 0;
  if (bitString.bitsUsed > 0) {
    const lastBit = bitString.bitsUsed - 1;
    const usedBytes = (lastBit / 8) + 1;
    len = Math.floor(usedBytes);
  }
  return len;
};

const encodeApplicationObjectId = module.exports.encodeApplicationObjectId = (buffer, objectType, instance) => {
  const tmp = getBuffer();
  encodeBacnetObjectId(tmp, objectType, instance);
  encodeTag(buffer, baEnum.ApplicationTags.OBJECTIDENTIFIER, false, tmp.offset);
  tmp.buffer.copy(buffer.buffer, buffer.offset, 0, tmp.offset);
  buffer.offset += tmp.offset;
};

const encodeApplicationUnsigned = module.exports.encodeApplicationUnsigned = (buffer, value) => {
  const tmp = getBuffer();
  encodeBacnetUnsigned(tmp, value);
  encodeTag(buffer, baEnum.ApplicationTags.UNSIGNED_INTEGER, false, tmp.offset);
  tmp.buffer.copy(buffer.buffer, buffer.offset, 0, tmp.offset);
  buffer.offset += tmp.offset;
};

const encodeApplicationEnumerated = module.exports.encodeApplicationEnumerated = (buffer, value) => {
  const tmp = getBuffer();
  encodeBacnetEnumerated(tmp, value);
  encodeTag(buffer, baEnum.ApplicationTags.ENUMERATED, false, tmp.offset);
  tmp.buffer.copy(buffer.buffer, buffer.offset, 0, tmp.offset);
  buffer.offset += tmp.offset;
};

const encodeApplicationSigned = module.exports.encodeApplicationSigned = (buffer, value) => {
  const tmp = getBuffer();
  encodeBacnetSigned(tmp, value);
  encodeTag(buffer, baEnum.ApplicationTags.SIGNED_INTEGER, false, tmp.offset);
  tmp.buffer.copy(buffer.buffer, buffer.offset, 0, tmp.offset);
  buffer.offset += tmp.offset;
};

const byteReverseBits = (inByte) => {
  let outByte = 0;
  if ((inByte & 1) > 0) {
    outByte |= 0x80;
  }
  if ((inByte & 2) > 0) {
    outByte |= 0x40;
  }
  if ((inByte & 4) > 0) {
    outByte |= 0x20;
  }
  if ((inByte & 8) > 0) {
    outByte |= 0x10;
  }
  if ((inByte & 16) > 0) {
    outByte |= 0x8;
  }
  if ((inByte & 32) > 0) {
    outByte |= 0x4;
  }
  if ((inByte & 64) > 0) {
    outByte |= 0x2;
  }
  if ((inByte & 128) > 0) {
    outByte |= 1;
  }
  return outByte;
};

const bitstringOctet = (bitString, octetIndex) => {
  let octet = 0;
  if (bitString.value) {
    if (octetIndex < baEnum.ASN1_MAX_BITSTRING_BYTES) {
      octet = bitString.value[octetIndex];
    }
  }
  return octet;
};

const encodeBitstring = (buffer, bitString) => {
  if (bitString.bitsUsed === 0) {
    buffer.buffer[buffer.offset++] = 0;
  } else {
    const usedBytes = bitstringBytesUsed(bitString);
    const remainingUsedBits = bitString.bitsUsed - ((usedBytes - 1) * 8);
    buffer.buffer[buffer.offset++] = 8 - remainingUsedBits;
    for (let i = 0; i < usedBytes; i++) {
      buffer.buffer[buffer.offset++] = byteReverseBits(bitstringOctet(bitString, i));
    }
  }
};

const encodeApplicationBitstring = module.exports.encodeApplicationBitstring = (buffer, bitString) => {
  let bitStringEncodedLength = 1;
  bitStringEncodedLength += bitstringBytesUsed(bitString);
  encodeTag(buffer, baEnum.ApplicationTags.BIT_STRING, false, bitStringEncodedLength);
  encodeBitstring(buffer, bitString);
};

const encodeBacnetDate = (buffer, value, useUtc) => {
  if (value === new Date(1, 1, 1)) {
    buffer.buffer[buffer.offset++] = 0xFF;
    buffer.buffer[buffer.offset++] = 0xFF;
    buffer.buffer[buffer.offset++] = 0xFF;
    buffer.buffer[buffer.offset++] = 0xFF;
    return;
  }
  const year = useUtc ? value.getUTCFullYear() : value.getFullYear();
  const month = useUtc ? value.getUTCMonth() : value.getMonth();
  const day = useUtc ? value.getUTCDate() : value.getDate();
  const weekDay = useUtc ? value.getUTCDay() : value.getDay();
  if (year >= 1900) {
    buffer.buffer[buffer.offset++] = (year - 1900);
  } else if (year < 0x100) {
    buffer.buffer[buffer.offset++] = year;
  } else {
    return;
  }
  // BACnet months are encoded from 1 (January) through 12 (December), while
  // JavaScript Date months are zero-based.
  buffer.buffer[buffer.offset++] = month + 1;
  buffer.buffer[buffer.offset++] = day;
  buffer.buffer[buffer.offset++] = (weekDay === 0) ? 7 : weekDay;
};

const encodeApplicationDate = module.exports.encodeApplicationDate = (buffer, value) => {
  encodeTag(buffer, baEnum.ApplicationTags.DATE, false, 4);
  encodeBacnetDate(buffer, value, false);
};

module.exports.encodeApplicationDateUTC = (buffer, value) => {
  encodeTag(buffer, baEnum.ApplicationTags.DATE, false, 4);
  encodeBacnetDate(buffer, value, true);
};

const encodeBacnetTime = (buffer, value, useUtc) => {
  buffer.buffer[buffer.offset++] = useUtc ? value.getUTCHours() : value.getHours();
  buffer.buffer[buffer.offset++] = useUtc ? value.getUTCMinutes() : value.getMinutes();
  buffer.buffer[buffer.offset++] = useUtc ? value.getUTCSeconds() : value.getSeconds();
  buffer.buffer[buffer.offset++] = (useUtc ? value.getUTCMilliseconds() : value.getMilliseconds()) / 10;
};

const encodeApplicationTime = module.exports.encodeApplicationTime = (buffer, value) => {
  encodeTag(buffer, baEnum.ApplicationTags.TIME, false, 4);
  encodeBacnetTime(buffer, value, false);
};

module.exports.encodeApplicationTimeUTC = (buffer, value) => {
  encodeTag(buffer, baEnum.ApplicationTags.TIME, false, 4);
  encodeBacnetTime(buffer, value, true);
};

const bacappEncodeDatetime = (buffer, value) => {
  if (value !== new Date(1, 1, 1)) {
    encodeApplicationDate(buffer, value);
    encodeApplicationTime(buffer, value);
  }
};

const encodeContextObjectId = module.exports.encodeContextObjectId = (buffer, tagNumber, objectType, instance) => {
  encodeTag(buffer, tagNumber, true, 4);
  encodeBacnetObjectId(buffer, objectType, instance);
};

const encodeOpeningTag = module.exports.encodeOpeningTag = (buffer, tagNumber) => {
  let len = 1;
  const tmp = new Array(2);
  tmp[0] = 0x8;
  if (tagNumber <= 14) {
    tmp[0] |= (tagNumber << 4);
  } else {
    tmp[0] |= 0xF0;
    tmp[1] = tagNumber;
    len++;
  }
  tmp[0] |= 6;
  Buffer.from(tmp).copy(buffer.buffer, buffer.offset, 0, len);
  buffer.offset += len;
};

const encodeClosingTag = module.exports.encodeClosingTag = (buffer, tagNumber) => {
  let len = 1;
  const tmp = new Array(2);
  tmp[0] = 0x8;
  if (tagNumber <= 14) {
    tmp[0] |= (tagNumber << 4);
  } else {
    tmp[0] |= 0xF0;
    tmp[1] = tagNumber;
    len++;
  }
  tmp[0] |= 7;
  Buffer.from(tmp).copy(buffer.buffer, buffer.offset, 0, len);
  buffer.offset += len;
};

const encodeReadAccessSpecification = module.exports.encodeReadAccessSpecification = (buffer, value) => {
  encodeContextObjectId(buffer, 0, value.objectId.type, value.objectId.instance);
  encodeOpeningTag(buffer, 1);
  value.properties.forEach((p) => {
    encodeContextEnumerated(buffer, 0, p.id);
    if (p.index && p.index !== baEnum.ASN1_ARRAY_ALL) {
      encodeContextUnsigned(buffer, 1, p.index);
    }
  });
  encodeClosingTag(buffer, 1);
};

const encodeContextBoolean = module.exports.encodeContextBoolean = (buffer, tagNumber, booleanValue) => {
  encodeTag(buffer, tagNumber, true, 1);
  buffer.buffer.writeUInt8(booleanValue ? 1 : 0, buffer.offset, true);
  buffer.offset += 1;
};

const encodeCovSubscription = (buffer, value) => {
  encodeOpeningTag(buffer, 0);
  encodeOpeningTag(buffer, 0);
  encodeOpeningTag(buffer, 1);
  encodeApplicationUnsigned(buffer, value.recipient.network);
  if (value.recipient.network === 0xFFFF) {
    encodeApplicationOctetString(buffer, 0, 0, 0);
  } else {
    encodeApplicationOctetString(buffer, value.recipient.address, 0, value.recipient.address.length);
  }
  encodeClosingTag(buffer, 1);
  encodeClosingTag(buffer, 0);
  encodeContextUnsigned(buffer, 1, value.subscriptionProcessId);
  encodeClosingTag(buffer, 0);
  encodeOpeningTag(buffer, 1);
  encodeContextObjectId(buffer, 0, value.monitoredObjectId.type, value.monitoredObjectId.instance);
  encodeContextEnumerated(buffer, 1, value.monitoredProperty.id);
  if (value.monitoredProperty.index !== baEnum.ASN1_ARRAY_ALL) {
    encodeContextUnsigned(buffer, 2, value.monitoredProperty.index);
  }
  encodeClosingTag(buffer, 1);
  encodeContextBoolean(buffer, 2, value.issueConfirmedNotifications);
  encodeContextUnsigned(buffer, 3, value.timeRemaining);
  if (value.covIncrement > 0) {
    encodeContextReal(buffer, 4, value.covIncrement);
  }
};

const bacappEncodeApplicationData = module.exports.bacappEncodeApplicationData = (buffer, value) => {
  if (value.value === null) {
    value.type = baEnum.ApplicationTags.NULL;
  }
  switch (value.type) {
    case baEnum.ApplicationTags.NULL:
      encodeApplicationNull(buffer);
      break;
    case baEnum.ApplicationTags.BOOLEAN:
      encodeApplicationBoolean(buffer, value.value);
      break;
    case baEnum.ApplicationTags.UNSIGNED_INTEGER:
      encodeApplicationUnsigned(buffer, value.value);
      break;
    case baEnum.ApplicationTags.SIGNED_INTEGER:
      encodeApplicationSigned(buffer, value.value);
      break;
    case baEnum.ApplicationTags.REAL:
      encodeApplicationReal(buffer, value.value);
      break;
    case baEnum.ApplicationTags.DOUBLE:
      encodeApplicationDouble(buffer, value.value);
      break;
    case baEnum.ApplicationTags.OCTET_STRING:
      encodeApplicationOctetString(buffer, value.value, 0, value.value.length);
      break;
    case baEnum.ApplicationTags.CHARACTER_STRING:
      encodeApplicationCharacterString(buffer, value.value, value.encoding);
      break;
    case baEnum.ApplicationTags.BIT_STRING:
      encodeApplicationBitstring(buffer, value.value);
      break;
    case baEnum.ApplicationTags.ENUMERATED:
      encodeApplicationEnumerated(buffer, value.value);
      break;
    case baEnum.ApplicationTags.DATE:
      encodeApplicationDate(buffer, value.value);
      break;
    case baEnum.ApplicationTags.TIME:
      encodeApplicationTime(buffer, value.value);
      break;
    case baEnum.ApplicationTags.TIMESTAMP:
      bacappEncodeTimestamp(buffer, value.value);
      break;
    case baEnum.ApplicationTags.DATETIME:
      bacappEncodeDatetime(buffer, value.value);
      break;
    case baEnum.ApplicationTags.OBJECTIDENTIFIER:
      encodeApplicationObjectId(buffer, (value.value).type, (value.value).instance);
      break;
    case baEnum.ApplicationTags.COV_SUBSCRIPTION:
      encodeCovSubscription(buffer, value.value);
      break;
    case baEnum.ApplicationTags.READ_ACCESS_RESULT:
      encodeReadAccessResult(buffer, value.value);
      break;
    case baEnum.ApplicationTags.READ_ACCESS_SPECIFICATION:
      encodeReadAccessSpecification(buffer, value.value);
      break;
    case baEnum.ApplicationTags.WEEKLY_SCHEDULE:
      encodeWeeklySchedule(buffer, value.value);
      break;
    default:
      throw 'Unknown type';
  }
};

const bacappEncodeDeviceObjPropertyRef = (buffer, value) => {
  encodeContextObjectId(buffer, 0, value.objectId.type, value.objectId.instance);
  encodeContextEnumerated(buffer, 1, value.id);
  if (value.arrayIndex !== baEnum.ASN1_ARRAY_ALL) {
    encodeContextUnsigned(buffer, 2, value.arrayIndex);
  }
  if (value.deviceIndentifier.type === baEnum.ObjectType.DEVICE) {
    encodeContextObjectId(buffer, 3, value.deviceIndentifier.type, value.deviceIndentifier.instance);
  }
};

const bacappEncodeContextDeviceObjPropertyRef = module.exports.bacappEncodeContextDeviceObjPropertyRef = (buffer, tagNumber, value) => {
  encodeOpeningTag(buffer, tagNumber);
  bacappEncodeDeviceObjPropertyRef(buffer, value);
  encodeClosingTag(buffer, tagNumber);
};

const bacappEncodePropertyState = module.exports.bacappEncodePropertyState = (buffer, value) => {
  switch (value.type) {
    case baEnum.PropertyStates.BOOLEAN_VALUE:
      encodeContextBoolean(buffer, 0, value.state === 1 ? true : false);
      break;
    case baEnum.PropertyStates.BINARY_VALUE:
      encodeContextEnumerated(buffer, 1, value.state);
      break;
    case baEnum.PropertyStates.EVENT_TYPE:
      encodeContextEnumerated(buffer, 2, value.state);
      break;
    case baEnum.PropertyStates.POLARITY:
      encodeContextEnumerated(buffer, 3, value.state);
      break;
    case baEnum.PropertyStates.PROGRAM_CHANGE:
      encodeContextEnumerated(buffer, 4, value.state);
      break;
    case baEnum.PropertyStates.PROGRAM_STATE:
      encodeContextEnumerated(buffer, 5, value.state);
      break;
    case baEnum.PropertyStates.REASON_FOR_HALT:
      encodeContextEnumerated(buffer, 6, value.state);
      break;
    case baEnum.PropertyStates.RELIABILITY:
      encodeContextEnumerated(buffer, 7, value.state);
      break;
    case baEnum.PropertyStates.STATE:
      encodeContextEnumerated(buffer, 8, value.state);
      break;
    case baEnum.PropertyStates.SYSTEM_STATUS:
      encodeContextEnumerated(buffer, 9, value.state);
      break;
    case baEnum.PropertyStates.UNITS:
      encodeContextEnumerated(buffer, 10, value.state);
      break;
    case baEnum.PropertyStates.UNSIGNED_VALUE:
      encodeContextUnsigned(buffer, 11, value.state);
      break;
    case baEnum.PropertyStates.LIFE_SAFETY_MODE:
      encodeContextEnumerated(buffer, 12, value.state);
      break;
    case baEnum.PropertyStates.LIFE_SAFETY_STATE:
      encodeContextEnumerated(buffer, 13, value.state);
      break;
    default:
      break;
  }
};

const encodeContextBitstring = module.exports.encodeContextBitstring = (buffer, tagNumber, bitString) => {
  let bitStringEncodedLength = 1;
  bitStringEncodedLength += bitstringBytesUsed(bitString);
  encodeTag(buffer, tagNumber, true, bitStringEncodedLength);
  encodeBitstring(buffer, bitString);
};

const encodeContextSigned = module.exports.encodeContextSigned = (buffer, tagNumber, value) => {
  encodeTag(buffer, tagNumber, true, getSignedLength(value));
  encodeBacnetSigned(buffer, value);
};

const encodeContextTime = (buffer, tagNumber, value) => {
  encodeTag(buffer, tagNumber, true, 4);
  encodeBacnetTime(buffer, value);
};

const bacappEncodeContextDatetime = (buffer, tagNumber, value) => {
  if (value !== new Date(1, 1, 1)) {
    encodeOpeningTag(buffer, tagNumber);
    bacappEncodeDatetime(buffer, value);
    encodeClosingTag(buffer, tagNumber);
  }
};

const decodeTagNumber = module.exports.decodeTagNumber = (buffer, offset) => {
  if (!isDecodeRangeValid(buffer, offset, 1)) return;
  let len = 1;
  let tagNumber;
  if (isExtendedTagNumber(buffer[offset])) {
    if (!isDecodeRangeValid(buffer, offset, 2)) return;
    tagNumber = buffer[offset + 1];
    len++;
  } else {
    tagNumber = buffer[offset] >> 4;
  }
  return {
    len: len,
    tagNumber: tagNumber
  };
};

const decodeIsContextTag = module.exports.decodeIsContextTag = (buffer, offset, tagNumber) => {
  const result = decodeTagNumber(buffer, offset);
  return !!result && isContextSpecific(buffer[offset]) && result.tagNumber === tagNumber;
};

const decodeIsOpeningTagNumber = module.exports.decodeIsOpeningTagNumber = (buffer, offset, tagNumber) => {
  const result = decodeTagNumber(buffer, offset);
  return !!result && isOpeningTag(buffer[offset]) && result.tagNumber === tagNumber;
};

const decodeIsClosingTagNumber = module.exports.decodeIsClosingTagNumber = (buffer, offset, tagNumber) => {
  const result = decodeTagNumber(buffer, offset);
  return !!result && isClosingTag(buffer[offset]) && result.tagNumber === tagNumber;
};

const decodeIsClosingTag = module.exports.decodeIsClosingTag = (buffer, offset) => {
  return isDecodeRangeValid(buffer, offset, 1) && (buffer[offset] & 0x07) === 7;
};

const decodeIsOpeningTag = module.exports.decodeIsOpeningTag = (buffer, offset) => {
  return isDecodeRangeValid(buffer, offset, 1) && (buffer[offset] & 0x07) === 6;
};

const decodeObjectId = module.exports.decodeObjectId = (buffer, offset) => {
  if (!isDecodeRangeValid(buffer, offset, 4)) return;
  const result = decodeUnsigned(buffer, offset, 4);
  const objectType = (result.value >> baEnum.ASN1_INSTANCE_BITS) & baEnum.ASN1_MAX_OBJECT;
  const instance = result.value & baEnum.ASN1_MAX_INSTANCE;
  return {
    len: result.len,
    objectType: objectType,
    instance: instance
  };
};

const decodeObjectIdSafe = (buffer, offset, lenValue) => {
  if (lenValue !== 4 || !isDecodeRangeValid(buffer, offset, 4)) return;
  return decodeObjectId(buffer, offset);
};

const decodeTagNumberAndValue = module.exports.decodeTagNumberAndValue = (buffer, offset) => {
  let value;
  let result = decodeTagNumber(buffer, offset);
  if (!result) return;
  let len = result.len;
  if (isExtendedValue(buffer[offset])) {
    if (!isDecodeRangeValid(buffer, offset + len, 1)) return;
    if (buffer[offset + len] === 255) {
      len++;
      if (!isDecodeRangeValid(buffer, offset + len, 4)) return;
      result = decodeUnsigned(buffer, offset + len, 4);
      len += result.len;
      value = result.value;
    } else if (buffer[offset + len] === 254) {
      len++;
      if (!isDecodeRangeValid(buffer, offset + len, 2)) return;
      result = decodeUnsigned(buffer, offset + len, 2);
      len += result.len;
      value = result.value;
    } else {
      value = buffer[offset + len];
      len++;
    }
  } else if (isOpeningTag(buffer[offset])) {
    value = 0;
  } else if (isClosingTag(buffer[offset])) {
    value = 0;
  } else {
    value = buffer[offset] & 0x07;
  }
  return {
    len: len,
    tagNumber: result.tagNumber,
    value: value
  };
};

const bacappDecodeApplicationData = module.exports.bacappDecodeApplicationData = (buffer, offset, maxOffset, objectType, propertyId, decodeDepth = 0) => {
  if (!isNonNegativeSafeInteger(decodeDepth) || decodeDepth > MAX_DECODE_NESTING) return;
  if (!Buffer.isBuffer(buffer) || !isNonNegativeSafeInteger(offset) || !isNonNegativeSafeInteger(maxOffset)) return;
  if (offset >= Math.min(buffer.length, maxOffset) || !isDecodeRangeValid(buffer, offset, 1)) return;
  if (!isContextSpecific(buffer[offset])) {
    let result = decodeTagNumberAndValue(buffer, offset);
    if (result) {
      let len = result.len;
      result = bacappDecodeData(buffer, offset + len, maxOffset, result.tagNumber, result.value);
      if (!result) return;
      let resObj = {
        len: len + result.len,
        type: result.type,
        value: result.value
      };
      // HACK: Drop string specific handling ASAP
      if (result.encoding !== undefined) resObj.encoding = result.encoding;
      return resObj;
    }
  } else {
    return bacappDecodeContextApplicationData(buffer, offset, maxOffset, objectType, propertyId, decodeDepth);
  }
};

const encodeReadAccessResult = module.exports.encodeReadAccessResult = (buffer, value) => {
  encodeContextObjectId(buffer, 0, value.objectId.type, value.objectId.instance);
  encodeOpeningTag(buffer, 1);
  value.values.forEach((item) => {
    encodeContextEnumerated(buffer, 2, item.property.id);
    if (item.property.index !== baEnum.ASN1_ARRAY_ALL) {
      encodeContextUnsigned(buffer, 3, item.property.index);
    }
    if (item.value && item.value[0] && item.value[0].value && item.value[0].value.type === 'BacnetError') {
      encodeOpeningTag(buffer, 5);
      encodeApplicationEnumerated(buffer, item.value[0].value.errorClass);
      encodeApplicationEnumerated(buffer, item.value[0].value.errorCode);
      encodeClosingTag(buffer, 5);
    } else {
      encodeOpeningTag(buffer, 4);
      item.value.forEach((subItem) => {
        bacappEncodeApplicationData(buffer, subItem);
      });
      encodeClosingTag(buffer, 4);
    }
  });
  encodeClosingTag(buffer, 1);
};

const decodeReadAccessResult = module.exports.decodeReadAccessResult = (buffer, offset, apduLen, decodeDepth = 0) => {
  if (!isNonNegativeSafeInteger(decodeDepth) || decodeDepth >= MAX_DECODE_NESTING) return;
  let len = 0;
  let value = {};
  if (!decodeIsContextTag(buffer, offset + len, 0)) return;
  len++;
  let result = decodeObjectId(buffer, offset + len);
  if (!result) return;
  value.objectId = {
    type: result.objectType,
    instance: result.instance
  };
  len += result.len;
  if (!decodeIsOpeningTagNumber(buffer, offset + len, 1)) return -1;
  len++;

  const values = [];
  while ((apduLen - len) > 0) {
    let newEntry = {};
    if (decodeIsClosingTagNumber(buffer, offset + len, 1)) {
      len++;
      break;
    }
    result = decodeTagNumberAndValue(buffer, offset + len);
    len += result.len;
    if (result.tagNumber !== 2) return;
    result = decodeEnumerated(buffer, offset + len, result.value);
    newEntry.id = result.value;
    len += result.len;

    result = decodeTagNumberAndValue(buffer, offset + len);
    if (result.tagNumber === 3) {
      len += result.len;
      result = decodeUnsigned(buffer, offset + len, result.value);
      newEntry.index = result.value;
      len += result.len;
    } else {
      newEntry.index = baEnum.ASN1_ARRAY_ALL;
    }
    result = decodeTagNumberAndValue(buffer, offset + len);
    len += result.len;
    if (result.tagNumber === 4) {
      const localValues = [];
      while ((len + offset) <= buffer.length && !decodeIsClosingTagNumber(buffer, offset + len, 4)) {
        let localResult = bacappDecodeApplicationData(buffer, offset + len, apduLen + offset - 1, value.objectId.type, newEntry.id, decodeDepth + 1);
        if (!localResult) return;
        len += localResult.len;
        let resObj = {
          value: localResult.value,
          type: localResult.type
        };
        // HACK: Drop string specific handling ASAP
        if (localResult.encoding !== undefined) resObj.encoding = localResult.encoding;
        localValues.push(resObj);
      }
      if (!decodeIsClosingTagNumber(buffer, offset + len, 4)) return;
      if ((localValues.count === 2) && (localValues[0].type === baEnum.ApplicationTags.DATE) && (localValues[1].type === baEnum.ApplicationTags.TIME)) {
        const date = localValues[0].value;
        const time = localValues[1].value;
        const bdatetime = new Date(date.year, date.month, date.day, time.hour, time.minute, time.second, time.millisecond);
        newEntry.value = [
          {type: baEnum.ApplicationTags.DATETIME, value: bdatetime}
        ];
      } else {
        newEntry.value = localValues;
      }
      len++;
    } else if (result.tagNumber === 5) {
      let err = {};
      result = decodeTagNumberAndValue(buffer, offset + len);
      len += result.len;
      result = decodeEnumerated(buffer, offset + len, result.value);
      len += result.len;
      err.errorClass = result.value;
      result = decodeTagNumberAndValue(buffer, offset + len);
      len += result.len;
      result = decodeEnumerated(buffer, offset + len, result.value);
      len += result.len;
      err.errorCode = result.value;
      if (!decodeIsClosingTagNumber(buffer, offset + len, 5)) return;
      len++;
      newEntry.value = [{
        type: baEnum.ApplicationTags.ERROR,
        value: err
      }];
    }
    values.push(newEntry);
  }
  value.values = values;
  return {
    len: len,
    value: value
  };
};

const decodeSigned = module.exports.decodeSigned = (buffer, offset, length) => {
  if (length < 1 || length > 4 || !isDecodeRangeValid(buffer, offset, length)) return;
  return {
    len: length,
    value: buffer.readIntBE(offset, length, true)
  };
};

const decodeReal = module.exports.decodeReal = (buffer, offset) => {
  if (!isDecodeRangeValid(buffer, offset, 4)) return;
  return {
    len: 4,
    value: buffer.readFloatBE(offset, true)
  };
};

const decodeRealSafe = (buffer, offset, lenValue) => {
  if (lenValue !== 4) return;
  return decodeReal(buffer, offset);
};

const decodeDouble = (buffer, offset) => {
  if (!isDecodeRangeValid(buffer, offset, 8)) return;
  return {
    len: 8,
    value: buffer.readDoubleBE(offset, true)
  };
};

const decodeDoubleSafe = (buffer, offset, lenValue) => {
  if (lenValue !== 8) return;
  return decodeDouble(buffer, offset);
};

const decodeOctetString = module.exports.decodeOctetString = (buffer, offset, maxLength, octetStringOffset, octetStringLength) => {
  if (!isNonNegativeSafeInteger(octetStringOffset) || !isNonNegativeSafeInteger(octetStringLength)) return;
  if (octetStringOffset > Number.MAX_SAFE_INTEGER - octetStringLength) return;
  const totalLength = octetStringOffset + octetStringLength;
  if (!isDecodeRangeValid(buffer, offset, totalLength, maxLength)) return;
  const valueOffset = offset + octetStringOffset;
  const octetString = Array.from(buffer.subarray(valueOffset, valueOffset + octetStringLength));
  return {
    len: octetStringLength,
    value: octetString
  };
};

const multiCharsetCharacterstringDecode = (buffer, offset, maxLength, encoding, length) => {
  if (!isDecodeRangeValid(buffer, offset, length, maxLength)) return;
  const stringBuf = buffer.subarray(offset, offset + length);
  return {
    value: iconv.decode(stringBuf, getEncodingType(encoding, buffer, offset)),
    len: length + 1,
    encoding: encoding
  };
};

const decodeCharacterString = module.exports.decodeCharacterString = (buffer, offset, maxLength, lenValue) => {
  if (!isNonNegativeSafeInteger(lenValue) || lenValue < 1 || !isDecodeRangeValid(buffer, offset, lenValue, maxLength)) return;
  const contentMaxLength = maxLength === undefined ? undefined : maxLength - 1;
  return multiCharsetCharacterstringDecode(buffer, offset + 1, contentMaxLength, buffer[offset], lenValue - 1);
};

const bitstringSetBitsUsed = (bitString, bytesUsed, unusedBits) => {
  bitString.bitsUsed = bytesUsed * 8;
  bitString.bitsUsed -= unusedBits;
};

const decodeBitstring = module.exports.decodeBitstring = (buffer, offset, lenValue) => {
  if (!isNonNegativeSafeInteger(lenValue) || lenValue < 1 ||
      lenValue > baEnum.ASN1_MAX_BITSTRING_BYTES + 1 ||
      !isDecodeRangeValid(buffer, offset, lenValue)) return;
  const bytesUsed = lenValue - 1;
  const unusedBits = buffer[offset];
  if (unusedBits > 7 || unusedBits > bytesUsed * 8) return;
  const bitString = {value: []};
  for (let i = 0; i < bytesUsed; i++) {
    bitString.value.push(byteReverseBits(buffer[offset + 1 + i]));
  }
  bitstringSetBitsUsed(bitString, bytesUsed, unusedBits);
  return {
    len: lenValue,
    value: bitString
  };
};

const decodeDateValue = (buffer, offset, useUtc) => {
  if (!isDecodeRangeValid(buffer, offset, 4)) return;
  let date;
  const year = buffer[offset] + 1900;
  const month = buffer[offset + 1];
  const day = buffer[offset + 2];
  const wday = buffer[offset + 3];
  if (month === 0xFF && day === 0xFF && wday === 0xFF && (year - 1900) === 0xFF) {
    date = new Date(1, 1, 1);
  } else {
    date = useUtc ? new Date(Date.UTC(year, month - 1, day)) : new Date(year, month - 1, day);
  }
  return {
    len: 4,
    value: date
  };
};

const decodeDate = module.exports.decodeDate = (buffer, offset) => decodeDateValue(buffer, offset, false);

module.exports.decodeDateUTC = (buffer, offset) => decodeDateValue(buffer, offset, true);

const decodeDateSafe = (buffer, offset, lenValue) => {
  if (lenValue !== 4) return;
  return decodeDate(buffer, offset);
};

const decodeApplicationDateValue = (buffer, offset, useUtc) => {
  const result = decodeTagNumberAndValue(buffer, offset);
  if (result && result.tagNumber === baEnum.ApplicationTags.DATE && result.value === 4) {
    const value = decodeDateValue(buffer, offset + result.len, useUtc);
    if (!value) return;
    return {
      len: value.len + result.len,
      value: value
    };
  } else {
    return;
  }
};

const decodeApplicationDate = module.exports.decodeApplicationDate = (buffer, offset) => decodeApplicationDateValue(buffer, offset, false);

module.exports.decodeApplicationDateUTC = (buffer, offset) => decodeApplicationDateValue(buffer, offset, true);

const decodeBacnetTimeValue = (buffer, offset, useUtc) => {
  if (!isDecodeRangeValid(buffer, offset, 4)) return;
  let value;
  const hour = buffer[offset + 0];
  const min = buffer[offset + 1];
  const sec = buffer[offset + 2];
  let hundredths = buffer[offset + 3];
  if (hour === 0xFF && min === 0xFF && sec === 0xFF && hundredths === 0xFF) {
    value = new Date(1, 1, 1);
  } else {
    if (hundredths > 100) hundredths = 0;
    value = useUtc ? new Date(Date.UTC(1901, 1, 1, hour, min, sec, hundredths * 10)) : new Date(1, 1, 1, hour, min, sec, hundredths * 10);
  }
  return {
    len: 4,
    value: value
  };
};

const decodeBacnetTime = module.exports.decodeBacnetTime = (buffer, offset) => decodeBacnetTimeValue(buffer, offset, false);

module.exports.decodeBacnetTimeUTC = (buffer, offset) => decodeBacnetTimeValue(buffer, offset, true);

const decodeBacnetTimeSafe = (buffer, offset, lenValue) => {
  if (lenValue !== 4) return;
  return decodeBacnetTime(buffer, offset);
};

const decodeApplicationTimeValue = (buffer, offset, useUtc) => {
  const result = decodeTagNumberAndValue(buffer, offset);
  if (result && result.tagNumber === baEnum.ApplicationTags.TIME && result.value === 4) {
    const value = decodeBacnetTimeValue(buffer, offset + result.len, useUtc);
    if (!value) return;
    return {
      len: value.len + result.len,
      value: value
    };
  } else {
    return;
  }
};

const decodeApplicationTime = module.exports.decodeApplicationTime = (buffer, offset) => decodeApplicationTimeValue(buffer, offset, false);

module.exports.decodeApplicationTimeUTC = (buffer, offset) => decodeApplicationTimeValue(buffer, offset, true);

const decodeBacnetDatetime = (buffer, offset) => {
  let len = 0;
  const date = decodeApplicationDate(buffer, offset + len);
  if (!date) return;
  len += date.len;
  const time = decodeApplicationTime(buffer, offset + len);
  if (!time) return;
  len += time.len;
  const dateValue = date.value.value;
  const timeValue = time.value.value;
  return {
    len: len,
    value: new Date(
      dateValue.getFullYear(),
      dateValue.getMonth(),
      dateValue.getDate(),
      timeValue.getHours(),
      timeValue.getMinutes(),
      timeValue.getSeconds(),
      timeValue.getMilliseconds()
    )
  };
};

const bacappDecodeData = (buffer, offset, maxLength, tagDataType, lenValueType) => {
  let result;
  const remainingLength = getRemainingDecodeLength(buffer, offset, maxLength);
  let value = {
    len: 0,
    type: tagDataType
  };
  switch (tagDataType) {
    case baEnum.ApplicationTags.NULL:
      value.value = null;
      break;
    case baEnum.ApplicationTags.BOOLEAN:
      value.value = lenValueType > 0 ? true : false;
      break;
    case baEnum.ApplicationTags.UNSIGNED_INTEGER:
      result = decodeUnsigned(buffer, offset, lenValueType);
      if (Number.isNaN(result.value)) return;
      value.len += result.len;
      value.value = result.value;
      break;
    case baEnum.ApplicationTags.SIGNED_INTEGER:
      result = decodeSigned(buffer, offset, lenValueType);
      if (!result) return;
      value.len += result.len;
      value.value = result.value;
      break;
    case baEnum.ApplicationTags.REAL:
      result = decodeRealSafe(buffer, offset, lenValueType);
      if (!result) return;
      value.len += result.len;
      value.value = result.value;
      break;
    case baEnum.ApplicationTags.DOUBLE:
      result = decodeDoubleSafe(buffer, offset, lenValueType);
      if (!result) return;
      value.len += result.len;
      value.value = result.value;
      break;
    case baEnum.ApplicationTags.OCTET_STRING:
      result = decodeOctetString(buffer, offset, remainingLength, 0, lenValueType);
      if (!result) return;
      value.len += result.len;
      value.value = result.value;
      break;
    case baEnum.ApplicationTags.CHARACTER_STRING:
      result = decodeCharacterString(buffer, offset, remainingLength, lenValueType);
      if (!result) return;
      value.len += result.len;
      value.value = result.value;
      value.encoding = result.encoding;
      break;
    case baEnum.ApplicationTags.BIT_STRING:
      if (!isDecodeRangeValid(buffer, offset, lenValueType, remainingLength)) return;
      result = decodeBitstring(buffer, offset, lenValueType);
      if (!result) return;
      value.len += result.len;
      value.value = result.value;
      break;
    case baEnum.ApplicationTags.ENUMERATED:
      result = decodeEnumerated(buffer, offset, lenValueType);
      if (Number.isNaN(result.value)) return;
      value.len += result.len;
      value.value = result.value;
      break;
    case baEnum.ApplicationTags.DATE:
      result = decodeDateSafe(buffer, offset, lenValueType);
      if (!result) return;
      value.len += result.len;
      value.value = result.value;
      break;
    case baEnum.ApplicationTags.TIME:
      result = decodeBacnetTimeSafe(buffer, offset, lenValueType);
      if (!result) return;
      value.len += result.len;
      value.value = result.value;
      break;
    case baEnum.ApplicationTags.OBJECTIDENTIFIER:
      result = decodeObjectIdSafe(buffer, offset, lenValueType);
      if (!result || Number.isNaN(result.instance)) return;
      value.len += result.len;
      value.value = {type: result.objectType, instance: result.instance};
      break;
    default:
      break;
  }
  return value;
};

const bacappContextTagType = (property, tagNumber) => {
  let tag = 0;
  switch (property) {
    case baEnum.PropertyIdentifier.ACTUAL_SHED_LEVEL:
    case baEnum.PropertyIdentifier.REQUESTED_SHED_LEVEL:
    case baEnum.PropertyIdentifier.EXPECTED_SHED_LEVEL:
      switch (tagNumber) {
        case 0:
        case 1:
          tag = baEnum.ApplicationTags.UNSIGNED_INTEGER;
          break;
        case 2:
          tag = baEnum.ApplicationTags.REAL;
          break;
        default:
          break;
      }
      break;
    case baEnum.PropertyIdentifier.ACTION:
      switch (tagNumber) {
        case 0:
        case 1:
          tag = baEnum.ApplicationTags.OBJECTIDENTIFIER;
          break;
        case 2:
          tag = baEnum.ApplicationTags.ENUMERATED;
          break;
        case 3:
        case 5:
        case 6:
          tag = baEnum.ApplicationTags.UNSIGNED_INTEGER;
          break;
        case 7:
        case 8:
          tag = baEnum.ApplicationTags.BOOLEAN;
          break;
        default:
          break;
      }
      break;
    case baEnum.PropertyIdentifier.LIST_OF_GROUP_MEMBERS:
      switch (tagNumber) {
        case 0:
          tag = baEnum.ApplicationTags.OBJECTIDENTIFIER;
          break;
        default:
          break;
      }
      break;
    case baEnum.PropertyIdentifier.EXCEPTION_SCHEDULE:
      switch (tagNumber) {
        case 1:
          tag = baEnum.ApplicationTags.OBJECTIDENTIFIER;
          break;
        case 3:
          tag = baEnum.ApplicationTags.UNSIGNED_INTEGER;
          break;
        default:
          break;
      }
      break;
    case baEnum.PropertyIdentifier.LOG_DEVICE_OBJECT_PROPERTY:
      switch (tagNumber) {
        case 0:
        case 3:
          tag = baEnum.ApplicationTags.OBJECTIDENTIFIER;
          break;
        case 1:
          tag = baEnum.ApplicationTags.ENUMERATED;
          break;
        case 2:
          tag = baEnum.ApplicationTags.UNSIGNED_INTEGER;
          break;
        default:
          break;
      }
      break;
    case baEnum.PropertyIdentifier.SUBORDINATE_LIST:
      switch (tagNumber) {
        case 0:
        case 1:
          tag = baEnum.ApplicationTags.OBJECTIDENTIFIER;
          break;
        default:
          break;
      }
      break;
    case baEnum.PropertyIdentifier.RECIPIENT_LIST:
      switch (tagNumber) {
        case 0:
          tag = baEnum.ApplicationTags.OBJECTIDENTIFIER;
          break;
        default:
          break;
      }
      break;
    case baEnum.PropertyIdentifier.ACTIVE_COV_SUBSCRIPTIONS:
      switch (tagNumber) {
        case 0:
        case 1:
          break;
        case 2:
          tag = baEnum.ApplicationTags.BOOLEAN;
          break;
        case 3:
          tag = baEnum.ApplicationTags.UNSIGNED_INTEGER;
          break;
        case 4:
          tag = baEnum.ApplicationTags.REAL;
          break;
        default:
          break;
      }
      break;
    default:
      break;
  }
  return tag;
};

const decodeDeviceObjPropertyRef = (buffer, offset) => {
  let len = 0;
  let arrayIndex = baEnum.ASN1_ARRAY_ALL;
  if (!decodeIsContextTag(buffer, offset + len, 0)) return;
  len++;
  let objectId = decodeObjectId(buffer, offset + len);
  if (!objectId) return;
  len += objectId.len;
  let result = decodeTagNumberAndValue(buffer, offset + len);
  if (!result) return;
  len += result.len;
  if (result.tagNumber !== 1) return;
  let id = decodeEnumerated(buffer, offset + len, result.value);
  len += id.len;
  result = decodeTagNumberAndValue(buffer, offset + len);
  if (result.tagNumber === 2) {
    len += result.len;
    arrayIndex = decodeUnsigned(buffer, offset + len, result.value);
    len += arrayIndex.len;
  }
  if (decodeIsContextTag(buffer, offset + len, 3)) {
    if (!isClosingTag(buffer[offset + len])) {
      len++;
      objectId = decodeObjectId(buffer, offset + len);
      if (!objectId) return;
      len += objectId.len;
    }
  }
  return {
    len: len,
    value: {
      objectId: objectId,
      id: id
    }
  };
};

const decodeReadAccessSpecification = module.exports.decodeReadAccessSpecification = (buffer, offset, apduLen) => {
  let len = 0;
  let value = {};
  if (!decodeIsContextTag(buffer, offset + len, 0)) return;
  len++;
  let decodedValue = decodeObjectId(buffer, offset + len);
  if (!decodedValue) return;
  value.objectId = {
    type: decodedValue.objectType,
    instance: decodedValue.instance
  };
  len += decodedValue.len;
  if (!decodeIsOpeningTagNumber(buffer, offset + len, 1)) return;
  len++;
  const propertyIdAndArrayIndex = [];
  while ((apduLen - len) > 1 && !decodeIsClosingTagNumber(buffer, offset + len, 1)) {
    let propertyRef = {};
    if (!isContextSpecific(buffer[offset + len])) return;
    let result = decodeTagNumberAndValue(buffer, offset + len);
    len += result.len;
    if (result.tagNumber !== 0) return;
    if ((len + result.value) >= apduLen) return;
    decodedValue = decodeEnumerated(buffer, offset + len, result.value);
    propertyRef.id = decodedValue.value;
    len += decodedValue.len;
    propertyRef.index = baEnum.ASN1_ARRAY_ALL;
    if (isContextSpecific(buffer[offset + len]) && !isClosingTag(buffer[offset + len])) {
      const tmp = decodeTagNumberAndValue(buffer, offset + len);
      if (tmp.tagNumber === 1) {
        len += tmp.len;
        if ((len + tmp.value) >= apduLen) return;
        decodedValue = decodeUnsigned(buffer, offset + len, tmp.value);
        propertyRef.index = decodedValue.value;
        len += decodedValue.len;
      }
    }
    propertyIdAndArrayIndex.push(propertyRef);
  }
  if (!decodeIsClosingTagNumber(buffer, offset + len, 1)) return;
  len++;
  value.properties = propertyIdAndArrayIndex;
  return {
    len: len,
    value: value
  };
};

const decodeCovSubscription = (buffer, offset, apduLen) => {
  let len = 0;
  let value = {};
  let result;
  let decodedValue;
  value.recipient = {};
  if (!decodeIsOpeningTagNumber(buffer, offset + len, 0)) return;
  len++;
  if (!decodeIsOpeningTagNumber(buffer, offset + len, 0)) return;
  len++;
  if (!decodeIsOpeningTagNumber(buffer, offset + len, 1)) return;
  len++;
  result = decodeTagNumberAndValue(buffer, offset + len);
  len += result.len;
  if (result.tagNumber !== baEnum.ApplicationTags.UNSIGNED_INTEGER) return;
  decodedValue = decodeUnsigned(buffer, offset + len, result.value);
  len += decodedValue.len;
  value.recipient.net = decodedValue.value;
  result = decodeTagNumberAndValue(buffer, offset + len);
  len += result.len;
  if (result.tagNumber !== baEnum.ApplicationTags.OCTET_STRING) return;
  decodedValue = decodeOctetString(buffer, offset + len, apduLen - (offset + len), 0, result.value);
  if (!decodedValue) return;
  len += decodedValue.len;
  value.recipient.adr = decodedValue.value;
  if (!decodeIsClosingTagNumber(buffer, offset + len, 1)) return;
  len++;
  if (!decodeIsClosingTagNumber(buffer, offset + len, 0)) return;
  len++;
  result = decodeTagNumberAndValue(buffer, offset + len);
  len += result.len;
  if (result.tagNumber !== 1) return;
  decodedValue = decodeUnsigned(buffer, offset + len, result.value);
  len += decodedValue.len;
  value.subscriptionProcessId = decodedValue.value;
  if (!decodeIsClosingTagNumber(buffer, offset + len, 0)) return;
  len++;
  if (!decodeIsOpeningTagNumber(buffer, offset + len, 1)) return;
  len++;
  result = decodeTagNumberAndValue(buffer, offset + len);
  len += result.len;
  if (result.tagNumber !== 0) return;
  decodedValue = decodeObjectId(buffer, offset + len);
  if (!decodedValue) return;
  len += decodedValue.len;
  value.monitoredObjectId = {
    type: decodedValue.objectType,
    instance: decodedValue.instance
  };
  result = decodeTagNumberAndValue(buffer, offset + len);
  len += result.len;
  if (result.tagNumber !== 1) return;
  decodedValue = decodeEnumerated(buffer, offset + len, result.value);
  len += decodedValue.len;
  value.monitoredProperty = {};
  value.monitoredProperty.id = decodedValue.value;
  result = decodeTagNumberAndValue(buffer, offset + len);
  if (result.tagNumber === 2) {
    len += result.len;
    decodedValue = decodeUnsigned(buffer, offset + len, result.value);
    len += decodedValue.len;
    value.monitoredProperty.index = decodedValue.value;
  } else {
    value.monitoredProperty.index = baEnum.ASN1_ARRAY_ALL;
  }
  if (!decodeIsClosingTagNumber(buffer, offset + len, 1)) return;
  len++;
  result = decodeTagNumberAndValue(buffer, offset + len);
  len += result.len;
  if (result.tagNumber !== 2) return;
  value.issueConfirmedNotifications = buffer[offset + len] > 0 ? true : false;
  len++;
  result = decodeTagNumberAndValue(buffer, offset + len);
  len += result.len;
  if (result.tagNumber !== 3) return;
  decodedValue = decodeUnsigned(buffer, offset + len, result.value);
  len += decodedValue.len;
  value.timeRemaining = decodedValue.value;
  if (len < apduLen && !isClosingTag(buffer[offset + len])) {
    result = decodeTagNumberAndValue(buffer, offset + len);
    len += result.len;
    if (result.tagNumber !== 4) return;
    decodedValue = decodeReal(buffer, offset + len);
    if (!decodedValue) return;
    len += decodedValue.len;
    value.covIncrement = decodedValue.value;
  }
  return {
    len: len,
    value: value
  };
};

const decodeCalendarDate = (buffer, offset) => {
  if (!isDecodeRangeValid(buffer, offset, 4)) return;
  return {
    len: 4,
    year: buffer[offset],
    month: buffer[offset + 1],
    day: buffer[offset + 2],
    wday: buffer[offset + 3]
  };
};

const decodeCalendarDateRange = (buffer, offset) => {
  let len = 1;
  const startDate = decodeDate(buffer, offset + len);
  if (!startDate) return;
  len += startDate.len + 1;
  const endDate = decodeDate(buffer, offset + len);
  if (!endDate) return;
  len += endDate.len + 1;
  return {
    len: len,
    startDate: startDate,
    endDate: endDate
  };
};

const decodeCalendarWeekDay = (buffer, offset) => {
  if (!isDecodeRangeValid(buffer, offset, 3)) return;
  return {
    len: 3,
    month: buffer[offset],
    week: buffer[offset + 1],
    wday: buffer[offset + 2]
  };
};

const decodeCalendar = (buffer, offset, apduLen) => {
  let len = 0;
  const entries = [];
  let decodedValue;
  while (len < apduLen) {
    const result = decodeTagNumber(buffer, offset + len);
    if (!result) return;
    len += result.len;
    switch (result.tagNumber) {
      case 0:
        decodedValue = decodeCalendarDate(buffer, offset + len);
        if (!decodedValue) return;
        len += decodedValue.len;
        entries.push(decodedValue);
        break;
      case 1:
        decodedValue = decodeCalendarDateRange(buffer, offset + len);
        if (!decodedValue) return;
        len += decodedValue.len;
        entries.push(decodedValue);
        break;
      case 2:
        decodedValue = decodeCalendarWeekDay(buffer, offset + len);
        if (!decodedValue) return;
        len += decodedValue.len;
        entries.push(decodedValue);
        break;
      default:
        return {
          len: len - 1,
          value: entries
        };
    }
  }
};

const decodeWeeklySchedule = (buffer, offset, apduLen) => {
  const weekdays = [[],[],[],[],[],[],[]];
  let len = 0;
  let day = 0;

  while (len < (apduLen - offset)) {
    if (!isDecodeRangeValid(buffer, offset + len, 1) || day >= weekdays.length) return;
    if (isOpeningTag(buffer[offset + len])) {
      const openingTag = decodeTagNumberAndValue(buffer, offset + len);
      if (!openingTag) return;
      len += openingTag.len;
    } else if (isClosingTag(buffer[offset + len])) {
      day += 1;
      const closingTag = decodeTagNumberAndValue(buffer, offset + len);
      if (!closingTag) return;
      len += closingTag.len;
    } else {
      let decodedTime = decodeBacnetTime(buffer, offset + (len + 1));
      if (!decodedTime) return;
      len += 5;
      let valueTag =  decodeTagNumberAndValue(buffer, offset + len);
      if (!valueTag) return;
      len += valueTag.len;
      let decodedValue = bacappDecodeData(buffer, offset + len, apduLen - 1, valueTag.tagNumber, valueTag.value);
      if (!decodedValue) return;
      weekdays[day].push({time: decodedTime, value: decodedValue});
      len += decodedValue.len;
    }
  }

  return {
    len: len - 1,
    value: weekdays
  };
};


const encodeWeeklySchedule = module.exports.encodeWeeklySchedule = (buffer, value) => {
  let len = 0;
  while (len < 7) {
    let day = value[len];
    encodeOpeningTag(buffer, 0);
    day.forEach(function (event) {
      encodeTag(buffer, baEnum.ApplicationTags.TIME, false, 4);
      encodeBacnetTime(buffer, event.time);
      encodeTag(buffer, baEnum.ApplicationTags.UNSIGNED_INTEGER, false, 1);
      encodeBacnetUnsigned(buffer, event.value);
    });
    encodeClosingTag(buffer, 0);
    len ++;
  }
};

const bacappDecodeContextApplicationData = (buffer, offset, maxOffset, objectType, propertyId, decodeDepth) => {
  let len = 0;
  let result;
  const decodeLimit = Math.min(buffer.length, maxOffset);
  if (decodeDepth >= MAX_DECODE_NESTING || offset >= decodeLimit || !isDecodeRangeValid(buffer, offset, 1)) return;
  if (isContextSpecific(buffer[offset])) {
    if (propertyId === baEnum.PropertyIdentifier.LIST_OF_GROUP_MEMBERS) {
      result = decodeReadAccessSpecification(buffer, offset, maxOffset);
      if (!result) return;
      return {
        type: baEnum.ApplicationTags.READ_ACCESS_SPECIFICATION,
        value: result.value,
        len: result.len
      };
    } else if (propertyId === baEnum.PropertyIdentifier.ACTIVE_COV_SUBSCRIPTIONS) {
      result = decodeCovSubscription(buffer, offset, maxOffset);
      if (!result) return;
      return {
        type: baEnum.ApplicationTags.COV_SUBSCRIPTION,
        value: result.value,
        len: result.len
      };
    } else if (objectType === baEnum.ObjectType.GROUP && propertyId === baEnum.PropertyIdentifier.PRESENT_VALUE) {
      result = decodeReadAccessResult(buffer, offset, maxOffset, decodeDepth + 1);
      if (!result) return;
      return {
        type: baEnum.ApplicationTags.READ_ACCESS_RESULT,
        value: result.value,
        len: result.len
      };
    } else if (propertyId === baEnum.PropertyIdentifier.LIST_OF_OBJECT_PROPERTY_REFERENCES || propertyId === baEnum.PropertyIdentifier.LOG_DEVICE_OBJECT_PROPERTY  || propertyId === baEnum.PropertyIdentifier.OBJECT_PROPERTY_REFERENCE) {
      result = decodeDeviceObjPropertyRef(buffer, offset, maxOffset);
      if (!result) return;
      return {
        type: baEnum.ApplicationTags.OBJECT_PROPERTY_REFERENCE,
        value: result.value,
        len: result.len
      };
    } else if (propertyId === baEnum.PropertyIdentifier.DATE_LIST) {
      result = decodeCalendar(buffer, offset, maxOffset);
      if (!result) return;
      return {
        type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_DECODED,
        value: result.value,
        len: result.len
      };
    } else if (propertyId === baEnum.PropertyIdentifier.WEEKLY_SCHEDULE) {
      result = decodeWeeklySchedule(buffer, offset, maxOffset);
      if (!result) return;
      return {
        type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_DECODED,
        value: result.value,
        len: result.len
      };
    } else if (propertyId === baEnum.PropertyIdentifier.EVENT_TIME_STAMPS) {
      let subEvtResult;
      let evtResult = decodeTagNumberAndValue(buffer, offset + len);
      if (!evtResult) return;
      len += 1;
      if (evtResult.tagNumber === 0) {
        subEvtResult = decodeBacnetTime(buffer, offset + 1);
        if (!subEvtResult) return;
        return {
          type: baEnum.ApplicationTags.TIMESTAMP,
          value: subEvtResult.value,
          len: subEvtResult.len + 1
        };
      } else if (evtResult.tagNumber === 1) {
        subEvtResult = decodeUnsigned(buffer, offset + len, evtResult.value);
        return {
          type: baEnum.ApplicationTags.UNSIGNED_INTEGER,
          value: subEvtResult.value,
          len: subEvtResult.len + 1
        };
      } else if (evtResult.tagNumber === 2) {
        subEvtResult = decodeBacnetDatetime(buffer, offset + len);
        if (!subEvtResult) return;
        return {
          type: baEnum.ApplicationTags.TIMESTAMP,
          value: subEvtResult.value,
          len: subEvtResult.len + 2
        };
      } else {
        return;
      }
    }
    const list = [];
    let tagResult = decodeTagNumberAndValue(buffer, offset + len);
    if (!tagResult) return;
    let multipleValues = isOpeningTag(buffer[offset + len]);
    while (((len + offset) < decodeLimit) && !isClosingTag(buffer[offset + len])) {
      let subResult = decodeTagNumberAndValue(buffer, offset + len);
      if (!subResult) return;
      if (subResult.value === 0) {
        len += subResult.len;
        result = bacappDecodeApplicationData(buffer, offset + len, maxOffset, baEnum.ASN1_MAX_OBJECT_TYPE, baEnum.ASN1_MAX_PROPERTY_ID, decodeDepth + 1);
        if (!result) return;
        list.push(result);
        len += result.len;
      } else {
        const overrideTagNumber = bacappContextTagType(propertyId, subResult.tagNumber);
        if (overrideTagNumber !== baEnum.ASN1_MAX_APPLICATION_TAG) {
          subResult.tagNumber = overrideTagNumber;
        }
        let bacappResult = bacappDecodeData(buffer, offset + len + subResult.len, maxOffset, subResult.tagNumber, subResult.value);
        if (!bacappResult) return;
        if (bacappResult.len === subResult.value) {
          let resObj = {
            value: bacappResult.value,
            type: bacappResult.type
          };
          // HACK: Drop string specific handling ASAP
          if (bacappResult.encoding !== undefined) resObj.encoding = bacappResult.encoding;
          list.push(resObj);
          len += subResult.len + subResult.value;
        } else {
          list.push({
            value: buffer.slice(offset + len + subResult.len, offset + len + subResult.len + subResult.value),
            type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_ENCODED
          });
          len += subResult.len + subResult.value;
        }
      }
      if (multipleValues === false) {
        return {
          len: len,
          value: list[0],
          type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_DECODED
        };
      }
    }
    if ((len + offset) >= decodeLimit) return;
    if (decodeIsClosingTagNumber(buffer, offset + len, tagResult.tagNumber)) {
      len++;
    } else if (multipleValues) {
      return;
    }
    return {
      len: len,
      value: list,
      type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_DECODED
    };
  } else {
    return;
  }
};

const bacappEncodeTimestamp = module.exports.bacappEncodeTimestamp = (buffer, value) => {
  switch (value.type) {
    case baEnum.TimeStamp.TIME:
      encodeContextTime(buffer, 0, value.value);
      break;
    case baEnum.TimeStamp.SEQUENCE_NUMBER:
      encodeContextUnsigned(buffer, 1, value.value);
      break;
    case baEnum.TimeStamp.DATETIME:
      bacappEncodeContextDatetime(buffer, 2, value.value);
      break;
    default:
      throw new Error('NOT_IMPLEMENTED');
  }
};

const bacappEncodeContextTimestamp = module.exports.bacappEncodeContextTimestamp = (buffer, tagNumber, value) => {
  encodeOpeningTag(buffer, tagNumber);
  bacappEncodeTimestamp(buffer, value);
  encodeClosingTag(buffer, tagNumber);
};

const decodeContextCharacterString = module.exports.decodeContextCharacterString = (buffer, offset, maxLength, tagNumber) => {
  let len = 0;
  if (!decodeIsContextTag(buffer, offset + len, tagNumber)) return;
  const result = decodeTagNumberAndValue(buffer, offset + len);
  if (!result) return;
  len += result.len;
  if (!isNonNegativeSafeInteger(maxLength) || len > maxLength) return;
  const decodedValue = decodeCharacterString(buffer, offset + len, maxLength - len, result.value);
  if (!decodedValue) return;
  len += result.value;
  return {
    len: len,
    value: decodedValue.value,
    encoding: decodedValue.encoding
  };
};

const decodeIsContextTagWithLength = (buffer, offset, tagNumber) => {
  const result = decodeTagNumberAndValue(buffer, offset);
  if (!result) return;
  return {
    len: result.len,
    dataLength: result.value,
    value: isContextSpecific(buffer[offset]) && (result.tagNumber === tagNumber)
  };
};

module.exports.decodeContextObjectId = (buffer, offset, tagNumber) => {
  const result = decodeIsContextTagWithLength(buffer, offset, tagNumber);
  if (!result || !result.value || result.dataLength !== 4 || !isDecodeRangeValid(buffer, offset + result.len, 4)) return;
  const decodedValue = decodeObjectId(buffer, offset + result.len);
  if (!decodedValue) return;
  decodedValue.len = decodedValue.len + result.len;
  return decodedValue;
};

const encodeBacnetCharacterString = (buffer, value, encoding) => {
  encoding = encoding || baEnum.CharacterStringEncoding.UTF_8;
  buffer.buffer[buffer.offset++] = encoding;
  const bufEncoded = iconv.encode(value, getEncodingType(encoding));
  buffer.offset += bufEncoded.copy(buffer.buffer, buffer.offset);
};

const encodeApplicationCharacterString = module.exports.encodeApplicationCharacterString = (buffer, value, encoding) => {
  const tmp = getBuffer();
  encodeBacnetCharacterString(tmp, value, encoding);
  encodeTag(buffer, baEnum.ApplicationTags.CHARACTER_STRING, false, tmp.offset);
  tmp.buffer.copy(buffer.buffer, buffer.offset, 0, tmp.offset);
  buffer.offset += tmp.offset;
};

const encodeContextCharacterString = module.exports.encodeContextCharacterString = (buffer, tagNumber, value, encoding) => {
  const tmp = getBuffer();
  encodeBacnetCharacterString(tmp, value, encoding);
  encodeTag(buffer, tagNumber, true, tmp.offset);
  tmp.buffer.copy(buffer.buffer, buffer.offset, 0, tmp.offset);
  buffer.offset += tmp.offset;
};
