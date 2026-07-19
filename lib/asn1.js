'use strict';

const iconv       = require('iconv-lite');
const {TextDecoder} = require('util');
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

const containsInvalidUnicodeScalar = (value) => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint >= 0xD800 && codePoint <= 0xDFFF) return true;
  }
  return false;
};

const decodeUtf8 = (buffer) => {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(buffer);
  } catch {
    return;
  }
};

const decodeUcs2 = (buffer) => {
  if ((buffer.length & 1) !== 0) return;
  let offset = 0;
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    offset = 2;
  } else if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    // BACnet transmits the most-significant octet first. A little-endian BOM
    // therefore identifies a non-conforming UCS-2 payload.
    return;
  }
  let value = '';
  for (; offset < buffer.length; offset += 2) {
    const codePoint = buffer.readUInt16BE(offset);
    // BACnet character-set 4 is UCS-2, not UTF-16: surrogate code units are
    // not scalar values and must not be combined into supplementary points.
    if (codePoint >= 0xD800 && codePoint <= 0xDFFF) return;
    value += String.fromCharCode(codePoint);
  }
  return value;
};

const isJisX0208Row = (octet) =>
  (octet >= 0x21 && octet <= 0x28) || (octet >= 0x30 && octet <= 0x74);

const decodeJisX0208 = (buffer) => {
  if ((buffer.length & 1) !== 0) return;
  const eucJp = Buffer.alloc(buffer.length);
  for (let offset = 0; offset < buffer.length; offset++) {
    // JIS X 0208 wire values are two 7-bit row/cell octets. Shift-JIS,
    // half-width kana, and vendor extensions are different encodings.
    if ((offset & 1) === 0 ?
      !isJisX0208Row(buffer[offset]) :
      buffer[offset] < 0x21 || buffer[offset] > 0x7E) return;
    eucJp[offset] = buffer[offset] | 0x80;
  }
  const value = iconv.decode(eucJp, 'EUC-JP');
  return iconv.encode(value, 'EUC-JP').equals(eucJp) ? value : undefined;
};

const decodeUcs4 = (buffer) => {
  if ((buffer.length & 3) !== 0) return;
  let value = '';
  for (let offset = 0; offset < buffer.length; offset += 4) {
    const codePoint = buffer.readUInt32BE(offset);
    if (codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) return;
    value += String.fromCodePoint(codePoint);
  }
  return value;
};

const decodeCharacterContent = (buffer, encoding) => {
  switch (encoding) {
    case baEnum.CharacterStringEncoding.UTF_8:
      return decodeUtf8(buffer);
    case baEnum.CharacterStringEncoding.JIS_X_0208:
      return decodeJisX0208(buffer);
    case baEnum.CharacterStringEncoding.UCS_4:
      return decodeUcs4(buffer);
    case baEnum.CharacterStringEncoding.UCS_2:
      return decodeUcs2(buffer);
    case baEnum.CharacterStringEncoding.ISO_8859_1:
      return buffer.toString('latin1');
    case baEnum.CharacterStringEncoding.MICROSOFT_DBCS:
    default:
      return;
  }
};

const unsupportedCharacterEncoding = (encoding) => {
  const error = new Error(`Unsupported BACnet CharacterString encoding: ${encoding}`);
  error.code = 'ERR_UNSUPPORTED_CHARACTER_STRING_ENCODING';
  return error;
};

const encodeCharacterContent = (value, encoding, maxEncodedLength) => {
  if (typeof value !== 'string') throw new TypeError('BACnet CharacterString value must be a string');
  if (containsInvalidUnicodeScalar(value)) throw new TypeError('BACnet CharacterString contains an unpaired surrogate');
  switch (encoding) {
    case baEnum.CharacterStringEncoding.UTF_8:
      if (maxEncodedLength !== undefined && Buffer.byteLength(value, 'utf8') > maxEncodedLength) {
        throw new RangeError('BACnet CharacterString exceeds the encode buffer');
      }
      return Buffer.from(value, 'utf8');
    case baEnum.CharacterStringEncoding.JIS_X_0208: {
      if (maxEncodedLength !== undefined && value.length > Math.floor(maxEncodedLength / 2)) {
        throw new RangeError('BACnet CharacterString exceeds the encode buffer');
      }
      const eucJp = iconv.encode(value, 'EUC-JP');
      if (iconv.decode(eucJp, 'EUC-JP') !== value || (eucJp.length & 1) !== 0) {
        throw new TypeError('Value cannot be represented as JIS X 0208');
      }
      const encoded = Buffer.alloc(eucJp.length);
      for (let offset = 0; offset < eucJp.length; offset++) {
        const rowOrCell = eucJp[offset] & 0x7F;
        if ((offset & 1) === 0 ?
          !isJisX0208Row(rowOrCell) :
          rowOrCell < 0x21 || rowOrCell > 0x7E) {
          throw new TypeError('Value cannot be represented as JIS X 0208');
        }
        encoded[offset] = rowOrCell;
      }
      return encoded;
    }
    case baEnum.CharacterStringEncoding.UCS_4: {
      let encodedLength = 0;
      for (let stringOffset = 0; stringOffset < value.length;) {
        stringOffset += value.codePointAt(stringOffset) > 0xFFFF ? 2 : 1;
        if (encodedLength > Number.MAX_SAFE_INTEGER - 4) throw new RangeError('BACnet CharacterString exceeds the encode buffer');
        encodedLength += 4;
        if (maxEncodedLength !== undefined && encodedLength > maxEncodedLength) {
          throw new RangeError('BACnet CharacterString exceeds the encode buffer');
        }
      }
      const encoded = Buffer.alloc(encodedLength);
      let offset = 0;
      for (const character of value) {
        encoded.writeUInt32BE(character.codePointAt(0), offset);
        offset += 4;
      }
      return encoded;
    }
    case baEnum.CharacterStringEncoding.UCS_2: {
      if (maxEncodedLength !== undefined && value.length > Math.floor(maxEncodedLength / 2)) {
        throw new RangeError('BACnet CharacterString exceeds the encode buffer');
      }
      const encoded = Buffer.alloc(value.length * 2);
      for (let offset = 0; offset < value.length; offset++) {
        const codePoint = value.charCodeAt(offset);
        if (codePoint >= 0xD800 && codePoint <= 0xDFFF) throw new TypeError('Value cannot be represented as UCS-2');
        encoded.writeUInt16BE(codePoint, offset * 2);
      }
      return encoded;
    }
    case baEnum.CharacterStringEncoding.ISO_8859_1:
      if (maxEncodedLength !== undefined && value.length > maxEncodedLength) {
        throw new RangeError('BACnet CharacterString exceeds the encode buffer');
      }
      for (const character of value) {
        if (character.codePointAt(0) > 0xFF) throw new TypeError('Value cannot be represented as ISO-8859-1');
      }
      return Buffer.from(value, 'latin1');
    case baEnum.CharacterStringEncoding.MICROSOFT_DBCS:
    default:
      throw unsupportedCharacterEncoding(encoding);
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
  encodeApplicationDate(buffer, value);
  encodeApplicationTime(buffer, value);
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
  const network = value.recipient.net == null ? value.recipient.network : value.recipient.net;
  const address = value.recipient.adr == null ? value.recipient.address : value.recipient.adr;
  encodeOpeningTag(buffer, 0);
  encodeOpeningTag(buffer, 0);
  encodeOpeningTag(buffer, 1);
  encodeApplicationUnsigned(buffer, network);
  if (network === 0xFFFF) {
    encodeApplicationOctetString(buffer, 0, 0, 0);
  } else {
    encodeApplicationOctetString(buffer, address, 0, address.length);
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
  if (value.deviceIndentifier && value.deviceIndentifier.type === baEnum.ObjectType.DEVICE) {
    encodeContextObjectId(buffer, 3, value.deviceIndentifier.type, value.deviceIndentifier.instance);
  }
};

module.exports.bacappEncodeContextDeviceObjPropertyRef = (buffer, tagNumber, value) => {
  encodeOpeningTag(buffer, tagNumber);
  bacappEncodeDeviceObjPropertyRef(buffer, value);
  encodeClosingTag(buffer, tagNumber);
};

module.exports.bacappEncodePropertyState = (buffer, value) => {
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

module.exports.encodeContextBitstring = (buffer, tagNumber, bitString) => {
  let bitStringEncodedLength = 1;
  bitStringEncodedLength += bitstringBytesUsed(bitString);
  encodeTag(buffer, tagNumber, true, bitStringEncodedLength);
  encodeBitstring(buffer, bitString);
};

module.exports.encodeContextSigned = (buffer, tagNumber, value) => {
  encodeTag(buffer, tagNumber, true, getSignedLength(value));
  encodeBacnetSigned(buffer, value);
};

const encodeContextTime = (buffer, tagNumber, value) => {
  encodeTag(buffer, tagNumber, true, 4);
  encodeBacnetTime(buffer, value);
};

const bacappEncodeContextDatetime = (buffer, tagNumber, value) => {
  encodeOpeningTag(buffer, tagNumber);
  bacappEncodeDatetime(buffer, value);
  encodeClosingTag(buffer, tagNumber);
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

module.exports.decodeIsOpeningTagNumber = (buffer, offset, tagNumber) => {
  const result = decodeTagNumber(buffer, offset);
  return !!result && isContextSpecific(buffer[offset]) && isOpeningTag(buffer[offset]) &&
    result.tagNumber === tagNumber;
};

module.exports.decodeIsClosingTagNumber = (buffer, offset, tagNumber) => {
  const result = decodeTagNumber(buffer, offset);
  return !!result && isContextSpecific(buffer[offset]) && isClosingTag(buffer[offset]) &&
    result.tagNumber === tagNumber;
};

module.exports.decodeIsClosingTag = (buffer, offset) => {
  return isDecodeRangeValid(buffer, offset, 1) && (buffer[offset] & 0x07) === 7;
};

module.exports.decodeIsOpeningTag = (buffer, offset) => {
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

const decodeTagNumberAndValue = module.exports.decodeTagNumberAndValue = (buffer, offset, maxOffset) => {
  if (maxOffset !== undefined && (!isNonNegativeSafeInteger(maxOffset) || maxOffset < offset)) return;
  const remainingLength = maxOffset === undefined ? undefined : maxOffset - offset;
  if (!isDecodeRangeValid(buffer, offset, 1, remainingLength)) return;
  if (remainingLength !== undefined && remainingLength < 2 && isExtendedTagNumber(buffer[offset])) return;
  let value;
  let result = decodeTagNumber(buffer, offset);
  if (!result) return;
  const tagNumber = result.tagNumber;
  let len = result.len;
  if (remainingLength !== undefined && len > remainingLength) return;
  if (isExtendedValue(buffer[offset])) {
    if (!isDecodeRangeValid(buffer, offset + len, 1,
      remainingLength === undefined ? undefined : remainingLength - len)) return;
    if (buffer[offset + len] === 255) {
      len++;
      if (!isDecodeRangeValid(buffer, offset + len, 4,
        remainingLength === undefined ? undefined : remainingLength - len)) return;
      result = decodeUnsigned(buffer, offset + len, 4);
      len += result.len;
      value = result.value;
    } else if (buffer[offset + len] === 254) {
      len++;
      if (!isDecodeRangeValid(buffer, offset + len, 2,
        remainingLength === undefined ? undefined : remainingLength - len)) return;
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
    tagNumber: tagNumber,
    value: value
  };
};

const bacappDecodeApplicationData = module.exports.bacappDecodeApplicationData = (buffer, offset, maxOffset, objectType, propertyId, decodeDepth = 0) => {
  if (!isNonNegativeSafeInteger(decodeDepth) || decodeDepth > MAX_DECODE_NESTING) return;
  if (!Buffer.isBuffer(buffer) || !isNonNegativeSafeInteger(offset) || !isNonNegativeSafeInteger(maxOffset)) return;
  if (offset >= Math.min(buffer.length, maxOffset) || !isDecodeRangeValid(buffer, offset, 1)) return;
  if (!isContextSpecific(buffer[offset])) {
    let result = decodeTagNumberAndValue(buffer, offset, maxOffset);
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

const decodeBoundedTag = (buffer, offset, endOffset) => {
  if (!isNonNegativeSafeInteger(endOffset) || offset >= endOffset || endOffset > buffer.length) return;
  const result = decodeTagNumberAndValue(buffer, offset, endOffset);
  if (!result) return;
  return result;
};

const isPrimitiveTag = (buffer, offset, result, tagNumber, contextSpecific) => {
  return !!result && result.tagNumber === tagNumber &&
    isContextSpecific(buffer[offset]) === contextSpecific &&
    !isOpeningTag(buffer[offset]) && !isClosingTag(buffer[offset]);
};

const decodeBoundedUnsignedTag = (buffer, offset, endOffset, tagNumber, contextSpecific) => {
  const tag = decodeBoundedTag(buffer, offset, endOffset);
  if (!isPrimitiveTag(buffer, offset, tag, tagNumber, contextSpecific) ||
      tag.value < 1 || tag.value > 4 || tag.value > endOffset - (offset + tag.len)) return;
  const decodedValue = decodeUnsigned(buffer, offset + tag.len, tag.value);
  if (Number.isNaN(decodedValue.value)) return;
  return {
    len: tag.len + decodedValue.len,
    value: decodedValue.value
  };
};

const isConstructedTag = (buffer, offset, result, tagNumber, opening) => {
  return !!result && result.tagNumber === tagNumber && isContextSpecific(buffer[offset]) &&
    (opening ? isOpeningTag(buffer[offset]) : isClosingTag(buffer[offset]));
};

const hasInvalidReadAccessValue = (value, seen = new Set()) => {
  if (value === undefined || (typeof value === 'number' && Number.isNaN(value)) ||
      (value instanceof Date && Number.isNaN(value.getTime()))) return true;
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => hasInvalidReadAccessValue(child, seen));
};

const decodeReadAccessResult = module.exports.decodeReadAccessResult = (buffer, offset, apduLen, decodeDepth = 0, allowTrailing = false) => {
  if (!Buffer.isBuffer(buffer) || !isNonNegativeSafeInteger(offset) ||
      !isNonNegativeSafeInteger(apduLen) || offset > buffer.length ||
      apduLen > buffer.length - offset || !isNonNegativeSafeInteger(decodeDepth) ||
      decodeDepth >= MAX_DECODE_NESTING || typeof allowTrailing !== 'boolean') return;
  const endOffset = offset + apduLen;
  let len = 0;
  const objectTag = decodeBoundedTag(buffer, offset + len, endOffset);
  if (!isPrimitiveTag(buffer, offset + len, objectTag, 0, true) || objectTag.value !== 4) return;
  len += objectTag.len;
  const objectId = decodeObjectIdSafe(buffer, offset + len, objectTag.value);
  if (!objectId || objectId.len > endOffset - (offset + len)) return;
  len += objectId.len;

  let result = decodeBoundedTag(buffer, offset + len, endOffset);
  if (!isConstructedTag(buffer, offset + len, result, 1, true)) return;
  len += result.len;

  const value = {
    objectId: {
      type: objectId.objectType,
      instance: objectId.instance
    }
  };
  const values = [];
  while (len < apduLen) {
    result = decodeBoundedTag(buffer, offset + len, endOffset);
    if (!result) return;
    if (isConstructedTag(buffer, offset + len, result, 1, false)) {
      len += result.len;
      if (!allowTrailing && len !== apduLen) return;
      value.values = values;
      return {
        len: len,
        value: value
      };
    }

    const propertyId = decodeBoundedUnsignedTag(buffer, offset + len, endOffset, 2, true);
    if (!propertyId) return;
    len += propertyId.len;
    const newEntry = {
      id: propertyId.value,
      index: baEnum.ASN1_ARRAY_ALL
    };

    result = decodeBoundedTag(buffer, offset + len, endOffset);
    if (!result) return;
    if (isPrimitiveTag(buffer, offset + len, result, 3, true)) {
      const arrayIndex = decodeBoundedUnsignedTag(buffer, offset + len, endOffset, 3, true);
      if (!arrayIndex) return;
      newEntry.index = arrayIndex.value;
      len += arrayIndex.len;
      result = decodeBoundedTag(buffer, offset + len, endOffset);
      if (!result) return;
    }

    const choiceOffset = offset + len;
    if (isConstructedTag(buffer, choiceOffset, result, 4, true)) {
      len += result.len;
      const localValues = [];
      let hasClosingTag = false;
      while (len < apduLen) {
        result = decodeBoundedTag(buffer, offset + len, endOffset);
        if (!result) return;
        if (isClosingTag(buffer[offset + len])) {
          if (!isConstructedTag(buffer, offset + len, result, 4, false)) return;
          len += result.len;
          hasClosingTag = true;
          break;
        }
        let localResult;
        try {
          localResult = bacappDecodeApplicationData(buffer, offset + len, endOffset, value.objectId.type, newEntry.id, decodeDepth + 1);
        } catch {
          return;
        }
        if (!localResult || !isNonNegativeSafeInteger(localResult.len) || localResult.len === 0 ||
            localResult.len > apduLen - len || hasInvalidReadAccessValue(localResult.value)) return;
        len += localResult.len;
        const resObj = {
          value: localResult.value,
          type: localResult.type
        };
        // HACK: Drop string specific handling ASAP
        if (localResult.encoding !== undefined) resObj.encoding = localResult.encoding;
        localValues.push(resObj);
      }
      if (!hasClosingTag) return;
      newEntry.value = localValues;
    } else if (isConstructedTag(buffer, choiceOffset, result, 5, true)) {
      len += result.len;
      const errorClass = decodeBoundedUnsignedTag(buffer, offset + len, endOffset, baEnum.ApplicationTags.ENUMERATED, false);
      if (!errorClass) return;
      len += errorClass.len;
      const errorCode = decodeBoundedUnsignedTag(buffer, offset + len, endOffset, baEnum.ApplicationTags.ENUMERATED, false);
      if (!errorCode) return;
      len += errorCode.len;
      result = decodeBoundedTag(buffer, offset + len, endOffset);
      if (!isConstructedTag(buffer, offset + len, result, 5, false)) return;
      len += result.len;
      newEntry.value = [{
        type: baEnum.ApplicationTags.ERROR,
        value: {
          errorClass: errorClass.value,
          errorCode: errorCode.value
        }
      }];
    } else {
      return;
    }
    values.push(newEntry);
  }
  return;
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
  const value = decodeCharacterContent(stringBuf, encoding);
  if (value === undefined) return;
  return {
    value: value,
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
  const encodedYear = buffer[offset];
  const year = encodedYear + 1900;
  const month = buffer[offset + 1];
  const day = buffer[offset + 2];
  const wday = buffer[offset + 3];
  if (encodedYear === 0xFF && month === 0xFF && day === 0xFF && wday === 0xFF) {
    date = new Date(1, 1, 1);
  } else {
    if (encodedYear === 0xFF || month < 1 || month > 12 || day < 1 ||
        day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
        (wday !== 0xFF && (wday < 1 || wday > 7))) return;
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

module.exports.decodeApplicationDate = (buffer, offset) => decodeApplicationDateValue(buffer, offset, false);

module.exports.decodeApplicationDateUTC = (buffer, offset) => decodeApplicationDateValue(buffer, offset, true);

const decodeBacnetTimeValue = (buffer, offset, useUtc) => {
  if (!isDecodeRangeValid(buffer, offset, 4)) return;
  let value;
  const hour = buffer[offset + 0];
  const min = buffer[offset + 1];
  const sec = buffer[offset + 2];
  const hundredths = buffer[offset + 3];
  if (hour === 0xFF && min === 0xFF && sec === 0xFF && hundredths === 0xFF) {
    value = new Date(1, 1, 1);
  } else {
    if (hour > 23 || min > 59 || sec > 59 || hundredths > 99) return;
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

module.exports.decodeApplicationTime = (buffer, offset) => decodeApplicationTimeValue(buffer, offset, false);

module.exports.decodeApplicationTimeUTC = (buffer, offset) => decodeApplicationTimeValue(buffer, offset, true);

const bacappDecodeData = (buffer, offset, maxLength, tagDataType, lenValueType) => {
  let result;
  const remainingLength = getRemainingDecodeLength(buffer, offset, maxLength);
  if (!isNonNegativeSafeInteger(lenValueType)) return;
  if (tagDataType !== baEnum.ApplicationTags.NULL && tagDataType !== baEnum.ApplicationTags.BOOLEAN &&
      !isDecodeRangeValid(buffer, offset, lenValueType, remainingLength)) return;
  let value = {
    len: 0,
    type: tagDataType
  };
  switch (tagDataType) {
    case baEnum.ApplicationTags.NULL:
      if (lenValueType !== 0) return;
      value.value = null;
      break;
    case baEnum.ApplicationTags.BOOLEAN:
      if (lenValueType !== 0 && lenValueType !== 1) return;
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
      return;
  }
  return value;
};

const bacappContextTagType = (property, tagNumber) => {
  let tag = baEnum.ASN1_MAX_APPLICATION_TAG;
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

const decodeDeviceObjPropertyRef = (buffer, offset, maxOffset) => {
  if (!Buffer.isBuffer(buffer) || !isNonNegativeSafeInteger(offset) ||
      !isNonNegativeSafeInteger(maxOffset) || offset >= maxOffset ||
      maxOffset > buffer.length) return;
  let cursor = offset;

  const objectTag = decodeBoundedTag(buffer, cursor, maxOffset);
  if (!isPrimitiveTag(buffer, cursor, objectTag, 0, true) || objectTag.value !== 4) return;
  const decodedObjectId = decodeObjectIdSafe(buffer, cursor + objectTag.len, objectTag.value);
  if (!decodedObjectId || objectTag.len + objectTag.value > maxOffset - cursor) return;
  cursor += objectTag.len + objectTag.value;

  const propertyId = decodeBoundedUnsignedTag(buffer, cursor, maxOffset, 1, true);
  if (!propertyId) return;
  cursor += propertyId.len;
  const value = {
    objectId: {type: decodedObjectId.objectType, instance: decodedObjectId.instance},
    id: propertyId.value,
    arrayIndex: baEnum.ASN1_ARRAY_ALL
  };

  let tag = decodeBoundedTag(buffer, cursor, maxOffset);
  if (isPrimitiveTag(buffer, cursor, tag, 2, true)) {
    const arrayIndex = decodeBoundedUnsignedTag(buffer, cursor, maxOffset, 2, true);
    if (!arrayIndex) return;
    value.arrayIndex = arrayIndex.value;
    cursor += arrayIndex.len;
    tag = decodeBoundedTag(buffer, cursor, maxOffset);
  }

  if (isPrimitiveTag(buffer, cursor, tag, 3, true)) {
    if (tag.value !== 4 || tag.value > maxOffset - cursor - tag.len) return;
    const device = decodeObjectIdSafe(buffer, cursor + tag.len, tag.value);
    if (!device || device.objectType !== baEnum.ObjectType.DEVICE) return;
    value.deviceIndentifier = {type: device.objectType, instance: device.instance};
    cursor += tag.len + tag.value;
  }

  return {
    len: cursor - offset,
    value: value
  };
};

const decodeReadAccessSpecification = module.exports.decodeReadAccessSpecification = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !isNonNegativeSafeInteger(offset) ||
      !isNonNegativeSafeInteger(apduLen) || offset > buffer.length ||
      apduLen > buffer.length - offset) return;
  const endOffset = offset + apduLen;
  let len = 0;
  const objectTag = decodeBoundedTag(buffer, offset + len, endOffset);
  if (!isPrimitiveTag(buffer, offset + len, objectTag, 0, true) || objectTag.value !== 4) return;
  len += objectTag.len;
  const objectId = decodeObjectIdSafe(buffer, offset + len, objectTag.value);
  if (!objectId || objectId.len > endOffset - (offset + len)) return;
  len += objectId.len;

  let result = decodeBoundedTag(buffer, offset + len, endOffset);
  if (!isConstructedTag(buffer, offset + len, result, 1, true)) return;
  len += result.len;

  const properties = [];
  while (len < apduLen) {
    result = decodeBoundedTag(buffer, offset + len, endOffset);
    if (!result) return;
    if (isConstructedTag(buffer, offset + len, result, 1, false)) {
      len += result.len;
      return {
        len: len,
        value: {
          objectId: {type: objectId.objectType, instance: objectId.instance},
          properties: properties
        }
      };
    }

    const propertyId = decodeBoundedUnsignedTag(buffer, offset + len, endOffset, 0, true);
    if (!propertyId) return;
    len += propertyId.len;
    const property = {
      id: propertyId.value,
      index: baEnum.ASN1_ARRAY_ALL
    };

    result = decodeBoundedTag(buffer, offset + len, endOffset);
    if (!result) return;
    if (isPrimitiveTag(buffer, offset + len, result, 1, true)) {
      const arrayIndex = decodeBoundedUnsignedTag(buffer, offset + len, endOffset, 1, true);
      if (!arrayIndex) return;
      property.index = arrayIndex.value;
      len += arrayIndex.len;
    }
    properties.push(property);
  }
  return;
};

const decodeCovSubscription = (buffer, offset, maxOffset) => {
  if (!Buffer.isBuffer(buffer) || !isNonNegativeSafeInteger(offset) ||
      !isNonNegativeSafeInteger(maxOffset) || offset >= maxOffset ||
      maxOffset > buffer.length) return;
  let cursor = offset;

  const readConstructed = (tagNumber, opening) => {
    const tag = decodeBoundedTag(buffer, cursor, maxOffset);
    if (!isConstructedTag(buffer, cursor, tag, tagNumber, opening)) return false;
    cursor += tag.len;
    return true;
  };
  const readObjectId = (tagNumber) => {
    const tag = decodeBoundedTag(buffer, cursor, maxOffset);
    if (!isPrimitiveTag(buffer, cursor, tag, tagNumber, true) || tag.value !== 4 ||
        tag.value > maxOffset - cursor - tag.len) return;
    const decoded = decodeObjectIdSafe(buffer, cursor + tag.len, tag.value);
    if (!decoded) return;
    cursor += tag.len + tag.value;
    return {type: decoded.objectType, instance: decoded.instance};
  };
  const readUnsigned = (tagNumber, contextSpecific) => {
    const decoded = decodeBoundedUnsignedTag(
      buffer,
      cursor,
      maxOffset,
      tagNumber,
      contextSpecific
    );
    if (!decoded) return;
    cursor += decoded.len;
    return decoded.value;
  };

  if (!readConstructed(0, true) || !readConstructed(0, true) ||
      !readConstructed(1, true)) return;
  const network = readUnsigned(baEnum.ApplicationTags.UNSIGNED_INTEGER, false);
  if (network === undefined) return;
  let tag = decodeBoundedTag(buffer, cursor, maxOffset);
  if (!isPrimitiveTag(buffer, cursor, tag, baEnum.ApplicationTags.OCTET_STRING, false) ||
      tag.value > maxOffset - cursor - tag.len) return;
  const address = decodeOctetString(
    buffer,
    cursor + tag.len,
    maxOffset - cursor - tag.len,
    0,
    tag.value
  );
  if (!address || address.len !== tag.value) return;
  cursor += tag.len + tag.value;
  if (!readConstructed(1, false) || !readConstructed(0, false)) return;
  const subscriptionProcessId = readUnsigned(1, true);
  if (subscriptionProcessId === undefined || !readConstructed(0, false) ||
      !readConstructed(1, true)) return;
  const monitoredObjectId = readObjectId(0);
  const propertyId = readUnsigned(1, true);
  if (!monitoredObjectId || propertyId === undefined) return;
  const monitoredProperty = {id: propertyId, index: baEnum.ASN1_ARRAY_ALL};
  tag = decodeBoundedTag(buffer, cursor, maxOffset);
  if (isPrimitiveTag(buffer, cursor, tag, 2, true)) {
    const index = readUnsigned(2, true);
    if (index === undefined) return;
    monitoredProperty.index = index;
  }
  if (!readConstructed(1, false)) return;

  tag = decodeBoundedTag(buffer, cursor, maxOffset);
  if (!isPrimitiveTag(buffer, cursor, tag, 2, true) || tag.value !== 1 ||
      tag.value > maxOffset - cursor - tag.len) return;
  const booleanValue = buffer[cursor + tag.len];
  if (booleanValue !== 0 && booleanValue !== 1) return;
  cursor += tag.len + tag.value;
  const timeRemaining = readUnsigned(3, true);
  if (timeRemaining === undefined) return;

  const value = {
    recipient: {net: network, adr: address.value},
    subscriptionProcessId: subscriptionProcessId,
    monitoredObjectId: monitoredObjectId,
    monitoredProperty: monitoredProperty,
    issueConfirmedNotifications: booleanValue === 1,
    timeRemaining: timeRemaining
  };
  tag = decodeBoundedTag(buffer, cursor, maxOffset);
  if (isPrimitiveTag(buffer, cursor, tag, 4, true)) {
    if (tag.value !== 4 || tag.value > maxOffset - cursor - tag.len) return;
    const increment = decodeRealSafe(buffer, cursor + tag.len, tag.value);
    if (!increment || !Number.isFinite(increment.value)) return;
    value.covIncrement = increment.value;
    cursor += tag.len + tag.value;
  }
  return {
    len: cursor - offset,
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

const decodeCalendarWeekDay = (buffer, offset) => {
  if (!isDecodeRangeValid(buffer, offset, 3)) return;
  return {
    len: 3,
    month: buffer[offset],
    week: buffer[offset + 1],
    wday: buffer[offset + 2]
  };
};

const decodeCalendar = (buffer, offset, maxOffset) => {
  if (!Buffer.isBuffer(buffer) || !isNonNegativeSafeInteger(offset) ||
      !isNonNegativeSafeInteger(maxOffset) || offset >= maxOffset ||
      maxOffset > buffer.length) return;
  let cursor = offset;
  const entries = [];
  while (cursor < maxOffset) {
    const tag = decodeBoundedTag(buffer, cursor, maxOffset);
    if (!tag) return;
    if (isClosingTag(buffer[cursor])) break;
    let decodedValue;
    switch (tag.tagNumber) {
      case 0:
        if (!isPrimitiveTag(buffer, cursor, tag, 0, true) || tag.value !== 4 ||
            tag.value > maxOffset - cursor - tag.len) return;
        decodedValue = decodeCalendarDate(buffer, cursor + tag.len);
        if (!decodedValue || decodedValue.len !== tag.value) return;
        cursor += tag.len + tag.value;
        entries.push(decodedValue);
        break;
      case 1:
        if (!isConstructedTag(buffer, cursor, tag, 1, true)) return;
        {
          const entryOffset = cursor;
          cursor += tag.len;
          const dates = [];
          for (let index = 0; index < 2; index++) {
            const dateTag = decodeBoundedTag(buffer, cursor, maxOffset);
            if (!isPrimitiveTag(
              buffer,
              cursor,
              dateTag,
              baEnum.ApplicationTags.DATE,
              false
            ) || dateTag.value !== 4 || dateTag.value > maxOffset - cursor - dateTag.len) return;
            const date = decodeDateSafe(buffer, cursor + dateTag.len, dateTag.value);
            if (!date) return;
            dates.push(date);
            cursor += dateTag.len + dateTag.value;
          }
          const closing = decodeBoundedTag(buffer, cursor, maxOffset);
          if (!isConstructedTag(buffer, cursor, closing, 1, false)) return;
          cursor += closing.len;
          entries.push({
            len: cursor - entryOffset - tag.len,
            startDate: dates[0],
            endDate: dates[1]
          });
        }
        break;
      case 2:
        if (!isPrimitiveTag(buffer, cursor, tag, 2, true) || tag.value !== 3 ||
            tag.value > maxOffset - cursor - tag.len) return;
        decodedValue = decodeCalendarWeekDay(buffer, cursor + tag.len);
        if (!decodedValue || decodedValue.len !== tag.value) return;
        cursor += tag.len + tag.value;
        entries.push(decodedValue);
        break;
      default:
        return;
    }
  }
  if (entries.length === 0) return;
  return {
    len: cursor - offset,
    value: entries
  };
};

const decodeWeeklySchedule = (buffer, offset, maxOffset) => {
  if (!Buffer.isBuffer(buffer) || !isNonNegativeSafeInteger(offset) ||
      !isNonNegativeSafeInteger(maxOffset) || offset >= maxOffset ||
      maxOffset > buffer.length) return;
  const weekdays = [[],[],[],[],[],[],[]];
  let cursor = offset;

  for (let day = 0; day < weekdays.length; day++) {
    let tag = decodeBoundedTag(buffer, cursor, maxOffset);
    if (!isConstructedTag(buffer, cursor, tag, 0, true)) return;
    cursor += tag.len;
    while (true) {
      tag = decodeBoundedTag(buffer, cursor, maxOffset);
      if (!tag) return;
      if (isConstructedTag(buffer, cursor, tag, 0, false)) {
        cursor += tag.len;
        break;
      }
      if (!isPrimitiveTag(buffer, cursor, tag, baEnum.ApplicationTags.TIME, false) ||
          tag.value !== 4 || tag.value > maxOffset - cursor - tag.len) return;
      const decodedTime = decodeBacnetTimeSafe(buffer, cursor + tag.len, tag.value);
      if (!decodedTime) return;
      cursor += tag.len + tag.value;

      const valueTag = decodeBoundedTag(buffer, cursor, maxOffset);
      if (!valueTag || isContextSpecific(buffer[cursor]) || isOpeningTag(buffer[cursor]) ||
          isClosingTag(buffer[cursor]) || valueTag.value > maxOffset - cursor - valueTag.len) return;
      const decodedValue = bacappDecodeData(
        buffer,
        cursor + valueTag.len,
        maxOffset,
        valueTag.tagNumber,
        valueTag.value
      );
      if (!decodedValue || decodedValue.len !== valueTag.value) return;
      cursor += valueTag.len + valueTag.value;
      weekdays[day].push({time: decodedTime, value: decodedValue});
    }
  }

  return {
    len: cursor - offset,
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

const decodeEventTimestampProperty = (buffer, offset, decodeLimit) => {
  const tag = decodeBoundedTag(buffer, offset, decodeLimit);
  if (!tag || !isContextSpecific(buffer[offset])) return;
  if (tag.tagNumber === baEnum.TimeStamp.TIME) {
    if (!isPrimitiveTag(buffer, offset, tag, baEnum.TimeStamp.TIME, true) ||
        tag.value !== 4 || tag.value > decodeLimit - offset - tag.len) return;
    const time = decodeBacnetTimeSafe(buffer, offset + tag.len, tag.value);
    if (!time) return;
    return {
      type: baEnum.ApplicationTags.TIMESTAMP,
      value: time.value,
      len: tag.len + time.len
    };
  }
  if (tag.tagNumber === baEnum.TimeStamp.SEQUENCE_NUMBER) {
    const sequence = decodeBoundedUnsignedTag(
      buffer,
      offset,
      decodeLimit,
      baEnum.TimeStamp.SEQUENCE_NUMBER,
      true
    );
    if (!sequence) return;
    return {
      type: baEnum.ApplicationTags.UNSIGNED_INTEGER,
      value: sequence.value,
      len: sequence.len
    };
  }
  if (!isConstructedTag(
    buffer,
    offset,
    tag,
    baEnum.TimeStamp.DATETIME,
    true
  )) return;
  let cursor = offset + tag.len;
  const dateTag = decodeBoundedTag(buffer, cursor, decodeLimit);
  if (!isPrimitiveTag(buffer, cursor, dateTag, baEnum.ApplicationTags.DATE, false) ||
      dateTag.value !== 4 || dateTag.value > decodeLimit - cursor - dateTag.len) return;
  const date = decodeDateSafe(buffer, cursor + dateTag.len, dateTag.value);
  if (!date) return;
  cursor += dateTag.len + dateTag.value;
  const timeTag = decodeBoundedTag(buffer, cursor, decodeLimit);
  if (!isPrimitiveTag(buffer, cursor, timeTag, baEnum.ApplicationTags.TIME, false) ||
      timeTag.value !== 4 || timeTag.value > decodeLimit - cursor - timeTag.len) return;
  const time = decodeBacnetTimeSafe(buffer, cursor + timeTag.len, timeTag.value);
  if (!time) return;
  cursor += timeTag.len + timeTag.value;
  const closingTag = decodeBoundedTag(buffer, cursor, decodeLimit);
  if (!isConstructedTag(
    buffer,
    cursor,
    closingTag,
    baEnum.TimeStamp.DATETIME,
    false
  )) return;
  cursor += closingTag.len;
  const dateValue = date.value;
  const timeValue = time.value;
  return {
    type: baEnum.ApplicationTags.TIMESTAMP,
    value: new Date(
      dateValue.getFullYear(),
      dateValue.getMonth(),
      dateValue.getDate(),
      timeValue.getHours(),
      timeValue.getMinutes(),
      timeValue.getSeconds(),
      timeValue.getMilliseconds()
    ),
    len: cursor - offset
  };
};

const bacappDecodeContextApplicationData = (buffer, offset, maxOffset, objectType, propertyId, decodeDepth) => {
  let result;
  const decodeLimit = Math.min(buffer.length, maxOffset);
  if (decodeDepth >= MAX_DECODE_NESTING || offset >= decodeLimit || !isDecodeRangeValid(buffer, offset, 1)) return;
  if (isContextSpecific(buffer[offset])) {
    if (propertyId === baEnum.PropertyIdentifier.LIST_OF_GROUP_MEMBERS) {
      result = decodeReadAccessSpecification(buffer, offset, maxOffset - offset);
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
      result = decodeReadAccessResult(buffer, offset, maxOffset - offset, decodeDepth + 1, true);
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
      return decodeEventTimestampProperty(buffer, offset, decodeLimit);
    }
    const tagResult = decodeBoundedTag(buffer, offset, decodeLimit);
    if (!tagResult || !isContextSpecific(buffer[offset]) || isClosingTag(buffer[offset])) return;
    if (!isOpeningTag(buffer[offset])) {
      const dataOffset = offset + tagResult.len;
      if (tagResult.value > decodeLimit - dataOffset) return;
      const overrideTagNumber = bacappContextTagType(propertyId, tagResult.tagNumber);
      let bacappResult;
      if (overrideTagNumber === baEnum.ApplicationTags.BOOLEAN) {
        if (tagResult.value !== 1) return;
        const booleanValue = buffer[dataOffset];
        if (booleanValue !== 0 && booleanValue !== 1) return;
        bacappResult = {len: 1, type: overrideTagNumber, value: booleanValue === 1};
      } else if (overrideTagNumber !== baEnum.ASN1_MAX_APPLICATION_TAG) {
        bacappResult = bacappDecodeData(
          buffer,
          dataOffset,
          decodeLimit,
          overrideTagNumber,
          tagResult.value
        );
      }
      let decoded;
      if (bacappResult && bacappResult.len === tagResult.value) {
        decoded = {value: bacappResult.value, type: bacappResult.type};
        if (bacappResult.encoding !== undefined) decoded.encoding = bacappResult.encoding;
      } else {
        decoded = {
          value: Buffer.from(buffer.subarray(dataOffset, dataOffset + tagResult.value)),
          type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_ENCODED,
          tagNumber: tagResult.tagNumber
        };
      }
      return {
        len: tagResult.len + tagResult.value,
        value: decoded,
        type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_DECODED
      };
    }

    let cursor = offset + tagResult.len;
    const list = [];
    while (cursor < decodeLimit) {
      const childTag = decodeBoundedTag(buffer, cursor, decodeLimit);
      if (!childTag) return;
      if (isClosingTag(buffer[cursor])) {
        if (!isConstructedTag(
          buffer,
          cursor,
          childTag,
          tagResult.tagNumber,
          false
        )) return;
        cursor += childTag.len;
        return {
          len: cursor - offset,
          value: list,
          type: baEnum.ApplicationTags.CONTEXT_SPECIFIC_DECODED
        };
      }
      const child = bacappDecodeApplicationData(
        buffer,
        cursor,
        decodeLimit,
        objectType,
        propertyId,
        decodeDepth + 1
      );
      if (!child || !isNonNegativeSafeInteger(child.len) || child.len === 0 ||
          child.len > decodeLimit - cursor) return;
      const decodedChild = {value: child.value, type: child.type};
      if (child.encoding !== undefined) decodedChild.encoding = child.encoding;
      list.push(decodedChild);
      cursor += child.len;
    }
    return;
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

module.exports.bacappEncodeContextTimestamp = (buffer, tagNumber, value) => {
  encodeOpeningTag(buffer, tagNumber);
  bacappEncodeTimestamp(buffer, value);
  encodeClosingTag(buffer, tagNumber);
};

module.exports.decodeContextCharacterString = (buffer, offset, maxLength, tagNumber) => {
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

const getEncodedTagLength = (tagNumber, lenValueType) => {
  let len = tagNumber <= 14 ? 1 : 2;
  if (lenValueType > 4) {
    if (lenValueType <= 253) len++;
    else if (lenValueType <= 65535) len += 3;
    else len += 5;
  }
  return len;
};

const encodeCharacterStringWithTag = (buffer, tagNumber, contextSpecific, value, encoding) => {
  if (!buffer || !Buffer.isBuffer(buffer.buffer) || !isNonNegativeSafeInteger(buffer.offset) ||
      buffer.offset > buffer.buffer.length) throw new RangeError('Invalid BACnet encode buffer');
  if (encoding === undefined) encoding = baEnum.CharacterStringEncoding.UTF_8;
  const remainingLength = buffer.buffer.length - buffer.offset;
  const encoded = encodeCharacterContent(value, encoding, remainingLength);
  const stringLength = encoded.length + 1;
  const requiredLength = getEncodedTagLength(tagNumber, stringLength) + stringLength;
  if (requiredLength > remainingLength) throw new RangeError('BACnet CharacterString exceeds the encode buffer');

  encodeTag(buffer, tagNumber, contextSpecific, stringLength);
  buffer.buffer[buffer.offset++] = encoding;
  buffer.offset += encoded.copy(buffer.buffer, buffer.offset);
};

const encodeApplicationCharacterString = module.exports.encodeApplicationCharacterString = (buffer, value, encoding) => {
  encodeCharacterStringWithTag(buffer, baEnum.ApplicationTags.CHARACTER_STRING, false, value, encoding);
};

module.exports.encodeContextCharacterString = (buffer, tagNumber, value, encoding) => {
  encodeCharacterStringWithTag(buffer, tagNumber, true, value, encoding);
};
