'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

const statusFlagsField = (eventType) => {
  switch (eventType) {
    case baEnum.EventType.CHANGE_OF_BITSTRING:
      return 'changeOfBitstringStatusFlags';
    case baEnum.EventType.CHANGE_OF_STATE:
      return 'changeOfStateStatusFlags';
    case baEnum.EventType.CHANGE_OF_VALUE:
      return 'changeOfValueStatusFlags';
    case baEnum.EventType.FLOATING_LIMIT:
      return 'floatingLimitStatusFlags';
    case baEnum.EventType.OUT_OF_RANGE:
      return 'outOfRangeStatusFlags';
    case baEnum.EventType.CHANGE_OF_LIFE_SAFETY:
      return 'changeOfLifeSafetyStatusFlags';
    case baEnum.EventType.UNSIGNED_RANGE:
      return 'unsignedRangeStatusFlags';
    default:
      return;
  }
};

const validateStatusFlags = (data) => {
  if (data.notifyType !== baEnum.NotifyType.ALARM && data.notifyType !== baEnum.NotifyType.EVENT) return;
  const fieldName = statusFlagsField(data.eventType);
  if (!fieldName) return;
  const flags = data[fieldName];
  if (!flags || flags.bitsUsed !== 4 || !Array.isArray(flags.value) || flags.value.length !== 1) {
    throw new RangeError(`${fieldName} must contain exactly four bits`);
  }
};

module.exports.encode = (buffer, data) => {
  validateStatusFlags(data);
  baAsn1.encodeContextUnsigned(buffer, 0, data.processId);
  baAsn1.encodeContextObjectId(buffer, 1, data.initiatingObjectId.type, data.initiatingObjectId.instance);
  baAsn1.encodeContextObjectId(buffer, 2, data.eventObjectId.type, data.eventObjectId.instance);
  baAsn1.bacappEncodeContextTimestamp(buffer, 3, data.timeStamp);
  baAsn1.encodeContextUnsigned(buffer, 4, data.notificationClass);
  baAsn1.encodeContextUnsigned(buffer, 5, data.priority);
  baAsn1.encodeContextEnumerated(buffer, 6, data.eventType);
  if (data.messageText && data.messageText !== '') {
    baAsn1.encodeContextCharacterString(buffer, 7, data.messageText);
  }
  baAsn1.encodeContextEnumerated(buffer, 8, data.notifyType);
  switch (data.notifyType) {
    case baEnum.NotifyType.ALARM:
    case baEnum.NotifyType.EVENT:
      baAsn1.encodeContextBoolean(buffer, 9, data.ackRequired);
      baAsn1.encodeContextEnumerated(buffer, 10, data.fromState);
      break;
    default:
      break;
  }
  baAsn1.encodeContextEnumerated(buffer, 11, data.toState);
  switch (data.notifyType) {
    case baEnum.NotifyType.ALARM:
    case baEnum.NotifyType.EVENT:
      baAsn1.encodeOpeningTag(buffer, 12);
      switch (data.eventType) {
        case baEnum.EventType.CHANGE_OF_BITSTRING:
          baAsn1.encodeOpeningTag(buffer, 0);
          baAsn1.encodeContextBitstring(buffer, 0, data.changeOfBitstringReferencedBitString);
          baAsn1.encodeContextBitstring(buffer, 1, data.changeOfBitstringStatusFlags);
          baAsn1.encodeClosingTag(buffer, 0);
          break;
        case baEnum.EventType.CHANGE_OF_STATE:
          baAsn1.encodeOpeningTag(buffer, 1);
          baAsn1.encodeOpeningTag(buffer, 0);
          baAsn1.bacappEncodePropertyState(buffer, data.changeOfStateNewState);
          baAsn1.encodeClosingTag(buffer, 0);
          baAsn1.encodeContextBitstring(buffer, 1, data.changeOfStateStatusFlags);
          baAsn1.encodeClosingTag(buffer, 1);
          break;
        case baEnum.EventType.CHANGE_OF_VALUE:
          baAsn1.encodeOpeningTag(buffer, 2);
          baAsn1.encodeOpeningTag(buffer, 0);
          switch (data.changeOfValueTag) {
            case baEnum.CovTypes.REAL:
              baAsn1.encodeContextReal(buffer, 1, data.changeOfValueChangeValue);
              break;
            case baEnum.CovTypes.BIT_STRING:
              baAsn1.encodeContextBitstring(buffer, 0, data.changeOfValueChangedBits);
              break;
            default:
              throw new Error('NotImplemented');
          }
          baAsn1.encodeClosingTag(buffer, 0);
          baAsn1.encodeContextBitstring(buffer, 1, data.changeOfValueStatusFlags);
          baAsn1.encodeClosingTag(buffer, 2);
          break;
        case baEnum.EventType.FLOATING_LIMIT:
          baAsn1.encodeOpeningTag(buffer, 4);
          baAsn1.encodeContextReal(buffer, 0, data.floatingLimitReferenceValue);
          baAsn1.encodeContextBitstring(buffer, 1, data.floatingLimitStatusFlags);
          baAsn1.encodeContextReal(buffer, 2, data.floatingLimitSetPointValue);
          baAsn1.encodeContextReal(buffer, 3, data.floatingLimitErrorLimit);
          baAsn1.encodeClosingTag(buffer, 4);
          break;
        case baEnum.EventType.OUT_OF_RANGE:
          baAsn1.encodeOpeningTag(buffer, 5);
          baAsn1.encodeContextReal(buffer, 0, data.outOfRangeExceedingValue);
          baAsn1.encodeContextBitstring(buffer, 1, data.outOfRangeStatusFlags);
          baAsn1.encodeContextReal(buffer, 2, data.outOfRangeDeadband);
          baAsn1.encodeContextReal(buffer, 3, data.outOfRangeExceededLimit);
          baAsn1.encodeClosingTag(buffer, 5);
          break;
        case baEnum.EventType.CHANGE_OF_LIFE_SAFETY:
          baAsn1.encodeOpeningTag(buffer, 8);
          baAsn1.encodeContextEnumerated(buffer, 0, data.changeOfLifeSafetyNewState);
          baAsn1.encodeContextEnumerated(buffer, 1, data.changeOfLifeSafetyNewMode);
          baAsn1.encodeContextBitstring(buffer, 2, data.changeOfLifeSafetyStatusFlags);
          baAsn1.encodeContextEnumerated(buffer, 3, data.changeOfLifeSafetyOperationExpected);
          baAsn1.encodeClosingTag(buffer, 8);
          break;
        case baEnum.EventType.BUFFER_READY:
          baAsn1.encodeOpeningTag(buffer, 10);
          baAsn1.bacappEncodeContextDeviceObjPropertyRef(buffer, 0, data.bufferReadyBufferProperty);
          baAsn1.encodeContextUnsigned(buffer, 1, data.bufferReadyPreviousNotification);
          baAsn1.encodeContextUnsigned(buffer, 2, data.bufferReadyCurrentNotification);
          baAsn1.encodeClosingTag(buffer, 10);
          break;
        case baEnum.EventType.UNSIGNED_RANGE:
          baAsn1.encodeOpeningTag(buffer, 11);
          baAsn1.encodeContextUnsigned(buffer, 0, data.unsignedRangeExceedingValue);
          baAsn1.encodeContextBitstring(buffer, 1, data.unsignedRangeStatusFlags);
          baAsn1.encodeContextUnsigned(buffer, 2, data.unsignedRangeExceededLimit);
          baAsn1.encodeClosingTag(buffer, 11);
          break;
        case baEnum.EventType.EXTENDED:
        case baEnum.EventType.COMMAND_FAILURE:
          throw new Error('NotImplemented');
        default:
          throw new Error('NotImplemented');
      }
      baAsn1.encodeClosingTag(buffer, 12);
      break;
    case baEnum.NotifyType.ACK_NOTIFICATION:
      throw new Error('NotImplemented');
    default:
      break;
  }
};

const decodeEventValues = (eventData, reader) => {
  if (!reader.opening(12) || !reader.opening(eventData.eventType)) return false;
  switch (eventData.eventType) {
    case baEnum.EventType.CHANGE_OF_BITSTRING:
      eventData.changeOfBitstringReferencedBitString = reader.bitstring(0);
      eventData.changeOfBitstringStatusFlags = reader.statusFlags(1);
      if (!eventData.changeOfBitstringReferencedBitString ||
          !eventData.changeOfBitstringStatusFlags) return false;
      break;
    case baEnum.EventType.CHANGE_OF_STATE:
      if (!reader.opening(0)) return false;
      eventData.changeOfStateNewState = reader.propertyState();
      if (!eventData.changeOfStateNewState || !reader.closing(0)) return false;
      eventData.changeOfStateStatusFlags = reader.statusFlags(1);
      if (!eventData.changeOfStateStatusFlags) return false;
      break;
    case baEnum.EventType.CHANGE_OF_VALUE:
      if (!reader.opening(0)) return false;
      if (reader.isPrimitive(0)) {
        eventData.changeOfValueTag = baEnum.CovTypes.BIT_STRING;
        eventData.changeOfValueChangedBits = reader.bitstring(0);
        if (!eventData.changeOfValueChangedBits) return false;
      } else if (reader.isPrimitive(1)) {
        eventData.changeOfValueTag = baEnum.CovTypes.REAL;
        eventData.changeOfValueChangeValue = reader.real(1);
        if (eventData.changeOfValueChangeValue === undefined) return false;
      } else {
        return false;
      }
      if (!reader.closing(0)) return false;
      eventData.changeOfValueStatusFlags = reader.statusFlags(1);
      if (!eventData.changeOfValueStatusFlags) return false;
      break;
    case baEnum.EventType.FLOATING_LIMIT:
      eventData.floatingLimitReferenceValue = reader.real(0);
      eventData.floatingLimitStatusFlags = reader.statusFlags(1);
      eventData.floatingLimitSetPointValue = reader.real(2);
      eventData.floatingLimitErrorLimit = reader.real(3);
      if (eventData.floatingLimitReferenceValue === undefined ||
          !eventData.floatingLimitStatusFlags ||
          eventData.floatingLimitSetPointValue === undefined ||
          eventData.floatingLimitErrorLimit === undefined) return false;
      break;
    case baEnum.EventType.OUT_OF_RANGE:
      eventData.outOfRangeExceedingValue = reader.real(0);
      eventData.outOfRangeStatusFlags = reader.statusFlags(1);
      eventData.outOfRangeDeadband = reader.real(2);
      eventData.outOfRangeExceededLimit = reader.real(3);
      if (eventData.outOfRangeExceedingValue === undefined ||
          !eventData.outOfRangeStatusFlags ||
          eventData.outOfRangeDeadband === undefined ||
          eventData.outOfRangeExceededLimit === undefined) return false;
      break;
    case baEnum.EventType.CHANGE_OF_LIFE_SAFETY:
      eventData.changeOfLifeSafetyNewState = reader.enumerated(0);
      eventData.changeOfLifeSafetyNewMode = reader.enumerated(1);
      eventData.changeOfLifeSafetyStatusFlags = reader.statusFlags(2);
      eventData.changeOfLifeSafetyOperationExpected = reader.enumerated(3);
      if (eventData.changeOfLifeSafetyNewState === undefined ||
          eventData.changeOfLifeSafetyNewMode === undefined ||
          !eventData.changeOfLifeSafetyStatusFlags ||
          eventData.changeOfLifeSafetyOperationExpected === undefined) return false;
      break;
    case baEnum.EventType.BUFFER_READY:
      eventData.bufferReadyBufferProperty = reader.deviceObjectPropertyReference();
      eventData.bufferReadyPreviousNotification = reader.unsigned(1);
      eventData.bufferReadyCurrentNotification = reader.unsigned(2);
      if (!eventData.bufferReadyBufferProperty ||
          eventData.bufferReadyPreviousNotification === undefined ||
          eventData.bufferReadyCurrentNotification === undefined) return false;
      break;
    case baEnum.EventType.UNSIGNED_RANGE:
      eventData.unsignedRangeExceedingValue = reader.unsigned(0);
      eventData.unsignedRangeStatusFlags = reader.statusFlags(1);
      eventData.unsignedRangeExceededLimit = reader.unsigned(2);
      if (eventData.unsignedRangeExceedingValue === undefined ||
          !eventData.unsignedRangeStatusFlags ||
          eventData.unsignedRangeExceededLimit === undefined) return false;
      break;
    default:
      return false;
  }
  return reader.closing(eventData.eventType) && reader.closing(12);
};

module.exports.decode = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      offset > buffer.length) return;
  if (apduLen === undefined) apduLen = buffer.length - offset;
  if (!Number.isSafeInteger(apduLen) || apduLen < 0 ||
      apduLen > buffer.length - offset) return;

  const endOffset = offset + apduLen;
  let cursor = offset;

  const readTag = () => {
    if (cursor >= endOffset) return;
    const tag = baAsn1.decodeTagNumberAndValue(buffer, cursor);
    if (!tag || !Number.isSafeInteger(tag.len) || tag.len < 1 ||
        tag.len > endOffset - cursor) return;
    return tag;
  };

  const isPrimitiveContextTag = (tagNumber) =>
    baAsn1.decodeIsContextTag(buffer, cursor, tagNumber) &&
    !baAsn1.decodeIsOpeningTag(buffer, cursor) &&
    !baAsn1.decodeIsClosingTag(buffer, cursor);

  const readOpeningTag = (tagNumber) => {
    if (!baAsn1.decodeIsOpeningTagNumber(buffer, cursor, tagNumber)) return false;
    const tag = readTag();
    if (!tag) return false;
    cursor += tag.len;
    return true;
  };

  const readClosingTag = (tagNumber) => {
    if (!baAsn1.decodeIsClosingTagNumber(buffer, cursor, tagNumber)) return false;
    const tag = readTag();
    if (!tag) return false;
    cursor += tag.len;
    return true;
  };

  const readPrimitive = (tagNumber, decode) => {
    if (!isPrimitiveContextTag(tagNumber)) return;
    const tag = readTag();
    if (!tag || !Number.isSafeInteger(tag.value) || tag.value < 0) return;
    const valueOffset = cursor + tag.len;
    if (tag.value > endOffset - valueOffset) return;
    const decoded = decode(valueOffset, tag.value);
    if (!decoded || decoded.len !== tag.value || Number.isNaN(decoded.value)) return;
    cursor = valueOffset + tag.value;
    return decoded.value;
  };

  const readUnsigned = (tagNumber) => readPrimitive(
    tagNumber,
    (valueOffset, length) => baAsn1.decodeUnsigned(buffer, valueOffset, length)
  );
  const readEnumerated = (tagNumber) => readPrimitive(
    tagNumber,
    (valueOffset, length) => baAsn1.decodeEnumerated(buffer, valueOffset, length)
  );
  const readReal = (tagNumber) => readPrimitive(tagNumber, (valueOffset, length) => {
    if (length !== 4) return;
    return baAsn1.decodeReal(buffer, valueOffset);
  });
  const readBitstring = (tagNumber) => readPrimitive(
    tagNumber,
    (valueOffset, length) => baAsn1.decodeBitstring(buffer, valueOffset, length)
  );
  const readStatusFlags = (tagNumber) => {
    const value = readBitstring(tagNumber);
    return value && value.bitsUsed === 4 ? value : undefined;
  };
  const readObjectId = (tagNumber) => readPrimitive(tagNumber, (valueOffset, length) => {
    if (length !== 4) return;
    const decoded = baAsn1.decodeObjectId(buffer, valueOffset);
    if (!decoded) return;
    return {
      len: decoded.len,
      value: {type: decoded.objectType, instance: decoded.instance}
    };
  });
  const readBoolean = (tagNumber) => {
    const value = readPrimitive(tagNumber, (valueOffset, length) => {
      if (length !== 1 || buffer[valueOffset] > 1) return;
      return {len: 1, value: buffer[valueOffset]};
    });
    if (value === undefined) return;
    return value === 1;
  };

  // Addendum 135-2016bu requires receivers to consume Message Text even when
  // its character set is unsupported or its character content is invalid.
  const readAdvisoryCharacterString = (tagNumber) => {
    if (!isPrimitiveContextTag(tagNumber)) return;
    const tag = readTag();
    if (!tag || !Number.isSafeInteger(tag.value) || tag.value < 0) return;
    const valueOffset = cursor + tag.len;
    if (tag.value > endOffset - valueOffset) return;
    const decoded = baAsn1.decodeCharacterString(
      buffer,
      valueOffset,
      tag.value,
      tag.value
    );
    cursor = valueOffset + tag.value;
    return decoded ? decoded.value : '';
  };

  const readTimestamp = (outerTagNumber) => {
    if (!readOpeningTag(outerTagNumber)) return;
    let timestamp;
    if (isPrimitiveContextTag(baEnum.TimeStamp.TIME)) {
      timestamp = readPrimitive(baEnum.TimeStamp.TIME, (valueOffset, length) => {
        if (length !== 4) return;
        return baAsn1.decodeBacnetTime(buffer, valueOffset);
      });
    } else if (isPrimitiveContextTag(baEnum.TimeStamp.SEQUENCE_NUMBER)) {
      timestamp = readUnsigned(baEnum.TimeStamp.SEQUENCE_NUMBER);
    } else if (readOpeningTag(baEnum.TimeStamp.DATETIME)) {
      const dateTag = readTag();
      if (!dateTag || dateTag.tagNumber !== baEnum.ApplicationTags.DATE ||
          dateTag.value !== 4 || dateTag.len + 4 > endOffset - cursor) return;
      const date = baAsn1.decodeApplicationDate(buffer, cursor);
      if (!date || date.len !== dateTag.len + 4) return;
      cursor += date.len;
      const timeTag = readTag();
      if (!timeTag || timeTag.tagNumber !== baEnum.ApplicationTags.TIME ||
          timeTag.value !== 4 || timeTag.len + 4 > endOffset - cursor) return;
      const time = baAsn1.decodeApplicationTime(buffer, cursor);
      if (!time || time.len !== timeTag.len + 4) return;
      cursor += time.len;
      if (!readClosingTag(baEnum.TimeStamp.DATETIME)) return;
      const dateValue = date.value.value;
      const timeValue = time.value.value;
      timestamp = new Date(
        dateValue.getFullYear(),
        dateValue.getMonth(),
        dateValue.getDate(),
        timeValue.getHours(),
        timeValue.getMinutes(),
        timeValue.getSeconds(),
        timeValue.getMilliseconds()
      );
    } else {
      return;
    }
    if (timestamp === undefined || !readClosingTag(outerTagNumber)) return;
    return timestamp;
  };

  const readPropertyState = () => {
    const tag = readTag();
    if (!tag || baAsn1.decodeIsOpeningTag(buffer, cursor) ||
        baAsn1.decodeIsClosingTag(buffer, cursor) || tag.tagNumber > 13) return;
    const type = tag.tagNumber;
    if (type === baEnum.PropertyStates.BOOLEAN_VALUE) {
      const state = readBoolean(type);
      if (state === undefined) return;
      return {type: type, state: state ? 1 : 0};
    }
    const state = type === baEnum.PropertyStates.UNSIGNED_VALUE ?
      readUnsigned(type) : readEnumerated(type);
    if (state === undefined) return;
    return {type: type, state: state};
  };

  const readDeviceObjectPropertyReference = () => {
    if (!readOpeningTag(0)) return;
    const objectId = readObjectId(0);
    const id = readEnumerated(1);
    if (!objectId || id === undefined) return;
    const value = {
      objectId: objectId,
      id: id,
      arrayIndex: baEnum.ASN1_ARRAY_ALL
    };
    if (isPrimitiveContextTag(2)) {
      value.arrayIndex = readUnsigned(2);
      if (value.arrayIndex === undefined) return;
    }
    if (isPrimitiveContextTag(3)) {
      value.deviceIndentifier = readObjectId(3);
      if (!value.deviceIndentifier) return;
    }
    if (!readClosingTag(0)) return;
    return value;
  };

  const eventData = {};
  eventData.processId = readUnsigned(0);
  eventData.initiatingObjectId = readObjectId(1);
  eventData.eventObjectId = readObjectId(2);
  eventData.timeStamp = readTimestamp(3);
  eventData.notificationClass = readUnsigned(4);
  eventData.priority = readUnsigned(5);
  eventData.eventType = readEnumerated(6);
  if (eventData.processId === undefined || !eventData.initiatingObjectId ||
      !eventData.eventObjectId || eventData.timeStamp === undefined ||
      eventData.notificationClass === undefined || eventData.priority === undefined ||
      eventData.priority > 0xFF || eventData.eventType === undefined) return;

  if (isPrimitiveContextTag(7)) {
    eventData.messageText = readAdvisoryCharacterString(7);
    if (eventData.messageText === undefined) return;
  }
  eventData.notifyType = readEnumerated(8);
  if (eventData.notifyType === undefined || eventData.notifyType > baEnum.NotifyType.ACK_NOTIFICATION) return;
  if (eventData.notifyType === baEnum.NotifyType.ALARM ||
      eventData.notifyType === baEnum.NotifyType.EVENT) {
    eventData.ackRequired = readBoolean(9);
    eventData.fromState = readEnumerated(10);
    if (eventData.ackRequired === undefined || eventData.fromState === undefined) return;
  }
  eventData.toState = readEnumerated(11);
  if (eventData.toState === undefined) return;

  if (eventData.notifyType === baEnum.NotifyType.ALARM ||
      eventData.notifyType === baEnum.NotifyType.EVENT) {
    const reader = {
      bitstring: readBitstring,
      closing: readClosingTag,
      deviceObjectPropertyReference: readDeviceObjectPropertyReference,
      enumerated: readEnumerated,
      isPrimitive: isPrimitiveContextTag,
      opening: readOpeningTag,
      propertyState: readPropertyState,
      real: readReal,
      statusFlags: readStatusFlags,
      unsigned: readUnsigned
    };
    if (!decodeEventValues(eventData, reader)) return;
  }

  if (cursor !== endOffset) return;
  eventData.len = cursor - offset;
  return eventData;
};
