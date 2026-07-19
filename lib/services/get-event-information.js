'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

const MAX_EVENT_PRIORITY = 0xFF;

const validateTransitionBits = (value, fieldName) => {
  if (!value || value.bitsUsed !== 3 || !Array.isArray(value.value) || value.value.length !== 1) {
    throw new RangeError(`GetEventInformation ${fieldName} must contain exactly three bits`);
  }
};

const getDecodeWindow = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length) return;
  const length = apduLen === undefined ? buffer.length - offset : apduLen;
  if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - offset) return;
  return {start: offset, end: offset + length};
};

const decodeTagHeader = (buffer, offset, end) => {
  if (offset >= end) return;
  const first = buffer[offset];
  let cursor = offset + 1;
  let tagNumber = first >> 4;
  if (tagNumber === 0x0F) {
    if (cursor >= end) return;
    tagNumber = buffer[cursor++];
  }
  const isContext = (first & 0x08) !== 0;
  const lenValueType = first & 0x07;
  const isOpening = isContext && lenValueType === 6;
  const isClosing = isContext && lenValueType === 7;
  let value = lenValueType;
  if (!isOpening && !isClosing && lenValueType === 5) {
    if (cursor >= end) return;
    const extendedLength = buffer[cursor++];
    if (extendedLength === 254) {
      if (end - cursor < 2) return;
      value = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (extendedLength === 255) {
      if (end - cursor < 4) return;
      value = buffer.readUInt32BE(cursor);
      cursor += 4;
    } else {
      value = extendedLength;
    }
  }
  return {
    tagNumber: tagNumber,
    isContext: isContext,
    isOpening: isOpening,
    isClosing: isClosing,
    value: value,
    len: cursor - offset
  };
};

const decodePrimitive = (buffer, offset, end, tagNumber, isContext, minLength, maxLength) => {
  const tag = decodeTagHeader(buffer, offset, end);
  if (!tag || tag.isOpening || tag.isClosing || tag.tagNumber !== tagNumber ||
      tag.isContext !== isContext || tag.value < minLength || tag.value > maxLength ||
      tag.value > end - offset - tag.len) return;
  return {len: tag.len + tag.value, dataOffset: offset + tag.len, dataLength: tag.value};
};

const decodeUnsignedPrimitive = (buffer, offset, end, tagNumber, isContext) => {
  const primitive = decodePrimitive(buffer, offset, end, tagNumber, isContext, 1, 4);
  if (!primitive) return;
  return {
    len: primitive.len,
    value: buffer.readUIntBE(primitive.dataOffset, primitive.dataLength)
  };
};

const decodeConstructedTag = (buffer, offset, end, tagNumber, opening) => {
  const tag = decodeTagHeader(buffer, offset, end);
  if (!tag || tag.tagNumber !== tagNumber || tag.isOpening !== opening || tag.isClosing === opening) return;
  return tag.len;
};

const decodeTimestamp = (buffer, offset, end) => {
  const tag = decodeTagHeader(buffer, offset, end);
  if (!tag || !tag.isContext) return;
  if (tag.tagNumber === baEnum.TimeStamp.TIME) {
    const primitive = decodePrimitive(buffer, offset, end, baEnum.TimeStamp.TIME, true, 4, 4);
    if (!primitive) return;
    const decoded = baAsn1.decodeBacnetTime(buffer, primitive.dataOffset);
    if (!decoded) return;
    return {len: primitive.len, value: {value: decoded.value, type: baEnum.TimeStamp.TIME}};
  }
  if (tag.tagNumber === baEnum.TimeStamp.SEQUENCE_NUMBER) {
    const decoded = decodeUnsignedPrimitive(buffer, offset, end, baEnum.TimeStamp.SEQUENCE_NUMBER, true);
    if (!decoded) return;
    return {len: decoded.len, value: {value: decoded.value, type: baEnum.TimeStamp.SEQUENCE_NUMBER}};
  }
  if (tag.tagNumber !== baEnum.TimeStamp.DATETIME || !tag.isOpening) return;

  let cursor = offset + tag.len;
  const date = decodePrimitive(buffer, cursor, end, baEnum.ApplicationTags.DATE, false, 4, 4);
  if (!date) return;
  const decodedDate = baAsn1.decodeDate(buffer, date.dataOffset);
  if (!decodedDate) return;
  cursor += date.len;
  const time = decodePrimitive(buffer, cursor, end, baEnum.ApplicationTags.TIME, false, 4, 4);
  if (!time) return;
  const decodedTime = baAsn1.decodeBacnetTime(buffer, time.dataOffset);
  if (!decodedTime) return;
  cursor += time.len;
  const closingLength = decodeConstructedTag(buffer, cursor, end, baEnum.TimeStamp.DATETIME, false);
  if (!closingLength) return;
  cursor += closingLength;
  const dateValue = decodedDate.value;
  const timeValue = decodedTime.value;
  return {
    len: cursor - offset,
    value: {
      value: new Date(dateValue.getFullYear(), dateValue.getMonth(), dateValue.getDate(), timeValue.getHours(), timeValue.getMinutes(), timeValue.getSeconds(), timeValue.getMilliseconds()),
      type: baEnum.TimeStamp.DATETIME
    }
  };
};

module.exports.encode = (buffer, lastReceivedObjectId) => {
  if (lastReceivedObjectId != null) {
    baAsn1.encodeContextObjectId(buffer, 0, lastReceivedObjectId.type, lastReceivedObjectId.instance);
  }
};

module.exports.decode = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      offset > buffer.length || (apduLen !== undefined &&
      (!Number.isSafeInteger(apduLen) || apduLen < 0 || apduLen > buffer.length - offset))) return;
  let len = 0;
  let result;
  let decodedValue;
  let value = {};
  if (apduLen === 0 || (apduLen === undefined && offset === buffer.length)) {
    value.len = 0;
    return value;
  }
  result = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
  if (!result || !baAsn1.decodeIsContextTag(buffer, offset + len, 0) || result.value !== 4) return;
  len += result.len;
  decodedValue = baAsn1.decodeObjectId(buffer, offset + len);
  if (!decodedValue || (apduLen !== undefined && decodedValue.len > apduLen - len)) return;
  len += decodedValue.len;
  if (apduLen !== undefined && len !== apduLen) return;
  value.lastReceivedObjectId = {type: decodedValue.objectType, instance: decodedValue.instance};
  value.len = len;
  return value;
};

module.exports.encodeAcknowledge = (buffer, events, moreEvents) => {
  events.forEach((eventData) => {
    if (!Array.isArray(eventData.eventPriorities) || eventData.eventPriorities.length !== 3 ||
        eventData.eventPriorities.some((priority) => !Number.isSafeInteger(priority) ||
          priority < 0 || priority > MAX_EVENT_PRIORITY)) {
      throw new RangeError('GetEventInformation event priorities must contain three values between 0 and 255');
    }
    validateTransitionBits(eventData.acknowledgedTransitions, 'acknowledgedTransitions');
    validateTransitionBits(eventData.eventEnable, 'eventEnable');
  });
  baAsn1.encodeOpeningTag(buffer, 0);
  events.forEach((eventData) => {
    baAsn1.encodeContextObjectId(buffer, 0, eventData.objectId.type, eventData.objectId.instance);
    baAsn1.encodeContextEnumerated(buffer, 1, eventData.eventState);
    baAsn1.encodeContextBitstring(buffer, 2, eventData.acknowledgedTransitions);
    baAsn1.encodeOpeningTag(buffer, 3);
    for (let i = 0; i < 3; i++) {
      baAsn1.bacappEncodeTimestamp(buffer, eventData.eventTimeStamps[i]);
    }
    baAsn1.encodeClosingTag(buffer, 3);
    baAsn1.encodeContextEnumerated(buffer, 4, eventData.notifyType);
    baAsn1.encodeContextBitstring(buffer, 5, eventData.eventEnable);
    baAsn1.encodeOpeningTag(buffer, 6);
    for (let i = 0; i < 3; i++) {
      baAsn1.encodeApplicationUnsigned(buffer, eventData.eventPriorities[i]);
    }
    baAsn1.encodeClosingTag(buffer, 6);
  });
  baAsn1.encodeClosingTag(buffer, 0);
  baAsn1.encodeContextBoolean(buffer, 1, moreEvents);
};

module.exports.decodeAcknowledge = (buffer, offset, apduLen) => {
  const window = getDecodeWindow(buffer, offset, apduLen);
  if (!window) return;
  let cursor = window.start;
  const openingLength = decodeConstructedTag(buffer, cursor, window.end, 0, true);
  if (!openingLength) return;
  cursor += openingLength;
  const events = [];

  while (true) {
    const closingLength = decodeConstructedTag(buffer, cursor, window.end, 0, false);
    if (closingLength) {
      cursor += closingLength;
      break;
    }

    const event = {};
    const object = decodePrimitive(buffer, cursor, window.end, 0, true, 4, 4);
    if (!object) return;
    const objectValue = buffer.readUInt32BE(object.dataOffset);
    event.objectId = {
      type: (objectValue >>> baEnum.ASN1_INSTANCE_BITS) & baEnum.ASN1_MAX_OBJECT,
      instance: objectValue & baEnum.ASN1_MAX_INSTANCE
    };
    cursor += object.len;

    let decodedValue = decodeUnsignedPrimitive(buffer, cursor, window.end, 1, true);
    if (!decodedValue || decodedValue.value > baEnum.EventState.LIFE_SAFETY_ALARM) return;
    event.eventState = decodedValue.value;
    cursor += decodedValue.len;

    const acknowledgedTransitions = decodePrimitive(buffer, cursor, window.end, 2, true, 2, 2);
    if (!acknowledgedTransitions) return;
    decodedValue = baAsn1.decodeBitstring(buffer, acknowledgedTransitions.dataOffset, acknowledgedTransitions.dataLength);
    if (!decodedValue || decodedValue.value.bitsUsed !== 3) return;
    event.acknowledgedTransitions = decodedValue.value;
    cursor += acknowledgedTransitions.len;

    let tagLength = decodeConstructedTag(buffer, cursor, window.end, 3, true);
    if (!tagLength) return;
    cursor += tagLength;
    event.eventTimeStamps = [];
    for (let i = 0; i < 3; i++) {
      decodedValue = decodeTimestamp(buffer, cursor, window.end);
      if (!decodedValue) return;
      event.eventTimeStamps.push(decodedValue.value);
      cursor += decodedValue.len;
    }
    tagLength = decodeConstructedTag(buffer, cursor, window.end, 3, false);
    if (!tagLength) return;
    cursor += tagLength;

    decodedValue = decodeUnsignedPrimitive(buffer, cursor, window.end, 4, true);
    if (!decodedValue || decodedValue.value > baEnum.NotifyType.ACK_NOTIFICATION) return;
    event.notifyType = decodedValue.value;
    cursor += decodedValue.len;

    const eventEnable = decodePrimitive(buffer, cursor, window.end, 5, true, 2, 2);
    if (!eventEnable) return;
    decodedValue = baAsn1.decodeBitstring(buffer, eventEnable.dataOffset, eventEnable.dataLength);
    if (!decodedValue || decodedValue.value.bitsUsed !== 3) return;
    event.eventEnable = decodedValue.value;
    cursor += eventEnable.len;

    tagLength = decodeConstructedTag(buffer, cursor, window.end, 6, true);
    if (!tagLength) return;
    cursor += tagLength;
    event.eventPriorities = [];
    for (let i = 0; i < 3; i++) {
      decodedValue = decodeUnsignedPrimitive(buffer, cursor, window.end, baEnum.ApplicationTags.UNSIGNED_INTEGER, false);
      if (!decodedValue || decodedValue.value > MAX_EVENT_PRIORITY) return;
      event.eventPriorities.push(decodedValue.value);
      cursor += decodedValue.len;
    }
    tagLength = decodeConstructedTag(buffer, cursor, window.end, 6, false);
    if (!tagLength) return;
    cursor += tagLength;
    events.push(event);
  }

  const moreEvents = decodePrimitive(buffer, cursor, window.end, 1, true, 1, 1);
  if (!moreEvents || (buffer[moreEvents.dataOffset] !== 0 && buffer[moreEvents.dataOffset] !== 1)) return;
  cursor += moreEvents.len;
  if (cursor !== window.end) return;
  return {
    events: events,
    moreEvents: buffer[moreEvents.dataOffset] === 1,
    len: cursor - window.start
  };
};
