'use strict';

const baAsn1      = require('../asn1');
const baEnum      = require('../enum');

const MAX_ACKNOWLEDGMENT_FILTER = 2;
const MAX_EVENT_PRIORITY = 0xFF;

const validateAcknowledgmentFilter = (acknowledgmentFilter) => {
  if (!Number.isSafeInteger(acknowledgmentFilter) || acknowledgmentFilter < 0 ||
      acknowledgmentFilter > MAX_ACKNOWLEDGMENT_FILTER) {
    throw new RangeError('GetEnrollmentSummary acknowledgment filter must be between 0 and 2');
  }
};

const validatePriorityFilter = (priorityFilter) => {
  if (priorityFilter == null) return;
  if (!Number.isSafeInteger(priorityFilter.min) || priorityFilter.min < 0 ||
      priorityFilter.min > MAX_EVENT_PRIORITY || !Number.isSafeInteger(priorityFilter.max) ||
      priorityFilter.max < 0 || priorityFilter.max > MAX_EVENT_PRIORITY ||
      priorityFilter.min > priorityFilter.max) {
    throw new RangeError('GetEnrollmentSummary priority filter must be an ordered pair between 0 and 255');
  }
};

const validateSummaryPriority = (priority) => {
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > MAX_EVENT_PRIORITY) {
    throw new RangeError('GetEnrollmentSummary priority must be between 0 and 255');
  }
};

const decodeContextValue = (buffer, offset, endOffset, tagNumber, decoder, expectedLength) => {
  const tag = baAsn1.decodeTagNumberAndValue(buffer, offset);
  if (!tag || !baAsn1.decodeIsContextTag(buffer, offset, tagNumber) ||
      tag.len > endOffset - offset ||
      (expectedLength !== undefined && tag.value !== expectedLength)) return;
  const decoded = decoder(buffer, offset + tag.len, tag.value);
  if (!decoded || Number.isNaN(decoded.value) || decoded.len > endOffset - (offset + tag.len)) return;
  return {decoded: decoded, len: tag.len + decoded.len};
};

const decodeOptionalContextValue = (buffer, offset, endOffset, tagNumber, decoder) => {
  if (offset >= endOffset || !baAsn1.decodeIsContextTag(buffer, offset, tagNumber)) return;
  if (!baAsn1.decodeIsOpeningTagNumber(buffer, offset, tagNumber)) {
    return decodeContextValue(buffer, offset, endOffset, tagNumber, decoder);
  }

  // Releases before 0.0.1 encoded these primitive filters in a constructed
  // wrapper. Continue to decode that shape, but only emit the standard direct
  // context tag from encode().
  let len = 1;
  const result = decodeContextValue(buffer, offset + len, endOffset, 0, decoder);
  if (!result) return;
  len += result.len;
  if (offset + len >= endOffset ||
      !baAsn1.decodeIsClosingTagNumber(buffer, offset + len, tagNumber)) return;
  len++;
  return {decoded: result.decoded, len: len};
};

const isApplicationTag = (buffer, offset, result, tagNumber) => {
  return !!result && result.tagNumber === tagNumber &&
    !baAsn1.decodeIsContextTag(buffer, offset, tagNumber);
};

const decodeApplicationValue = (buffer, offset, endOffset, tagNumber, decoder, expectedLength) => {
  const tag = baAsn1.decodeTagNumberAndValue(buffer, offset);
  if (!isApplicationTag(buffer, offset, tag, tagNumber) || tag.len > endOffset - offset ||
      (expectedLength !== undefined && tag.value !== expectedLength)) return;
  const decoded = decoder(buffer, offset + tag.len, tag.value);
  if (!decoded || Number.isNaN(decoded.value) || decoded.len > endOffset - (offset + tag.len)) return;
  return {decoded: decoded, len: tag.len + decoded.len};
};

module.exports.encode = (buffer, acknowledgmentFilter, enrollmentFilter, eventStateFilter, eventTypeFilter, priorityFilter, notificationClassFilter) => {
  validateAcknowledgmentFilter(acknowledgmentFilter);
  validatePriorityFilter(priorityFilter);
  baAsn1.encodeContextEnumerated(buffer, 0, acknowledgmentFilter);
  if (enrollmentFilter) {
    baAsn1.encodeOpeningTag(buffer, 1);
    baAsn1.encodeOpeningTag(buffer, 0);
    baAsn1.encodeContextObjectId(buffer, 0, enrollmentFilter.objectId.type, enrollmentFilter.objectId.instance);
    baAsn1.encodeClosingTag(buffer, 0);
    baAsn1.encodeContextUnsigned(buffer, 1, enrollmentFilter.processId);
    baAsn1.encodeClosingTag(buffer, 1);
  }
  if (eventStateFilter != null) {
    baAsn1.encodeContextEnumerated(buffer, 2, eventStateFilter);
  }
  if (eventTypeFilter != null) {
    baAsn1.encodeContextEnumerated(buffer, 3, eventTypeFilter);
  }
  if (priorityFilter) {
    baAsn1.encodeOpeningTag(buffer, 4);
    baAsn1.encodeContextUnsigned(buffer, 0, priorityFilter.min);
    baAsn1.encodeContextUnsigned(buffer, 1, priorityFilter.max);
    baAsn1.encodeClosingTag(buffer, 4);
  }
  if (notificationClassFilter != null) {
    baAsn1.encodeContextUnsigned(buffer, 5, notificationClassFilter);
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
  result = decodeContextValue(buffer, offset + len, endOffset, 0, baAsn1.decodeEnumerated);
  if (!result) return;
  len += result.len;
  value.acknowledgmentFilter = result.decoded.value;
  if (value.acknowledgmentFilter > MAX_ACKNOWLEDGMENT_FILTER) return;
  if (len < apduLen && baAsn1.decodeIsOpeningTagNumber(buffer, offset + len, 1)) {
    len++;
    value.enrollmentFilter = {};
    if (len >= apduLen || !baAsn1.decodeIsOpeningTagNumber(buffer, offset + len, 0)) return;
    len++;
    result = decodeContextValue(buffer, offset + len, endOffset, 0, baAsn1.decodeObjectId, 4);
    if (!result) return;
    len += result.len;
    decodedValue = result.decoded;
    value.enrollmentFilter.objectId = {type: decodedValue.objectType, instance: decodedValue.instance};
    if (len >= apduLen || !baAsn1.decodeIsClosingTagNumber(buffer, offset + len, 0)) return;
    len++;
    result = decodeContextValue(buffer, offset + len, endOffset, 1, baAsn1.decodeUnsigned);
    if (!result) return;
    len += result.len;
    value.enrollmentFilter.processId = result.decoded.value;
    if (len >= apduLen || !baAsn1.decodeIsClosingTagNumber(buffer, offset + len, 1)) return;
    len++;
  }
  if (len < apduLen && baAsn1.decodeIsContextTag(buffer, offset + len, 2)) {
    result = decodeOptionalContextValue(
      buffer,
      offset + len,
      endOffset,
      2,
      baAsn1.decodeEnumerated
    );
    if (!result) return;
    len += result.len;
    value.eventStateFilter = result.decoded.value;
  }
  if (len < apduLen && baAsn1.decodeIsContextTag(buffer, offset + len, 3)) {
    result = decodeOptionalContextValue(
      buffer,
      offset + len,
      endOffset,
      3,
      baAsn1.decodeEnumerated
    );
    if (!result) return;
    len += result.len;
    value.eventTypeFilter = result.decoded.value;
  }
  if (len < apduLen && baAsn1.decodeIsOpeningTagNumber(buffer, offset + len, 4)) {
    len++;
    value.priorityFilter = {};
    result = decodeContextValue(buffer, offset + len, endOffset, 0, baAsn1.decodeUnsigned);
    if (!result) return;
    len += result.len;
    value.priorityFilter.min = result.decoded.value;
    result = decodeContextValue(buffer, offset + len, endOffset, 1, baAsn1.decodeUnsigned);
    if (!result) return;
    len += result.len;
    value.priorityFilter.max = result.decoded.value;
    if (value.priorityFilter.min > MAX_EVENT_PRIORITY ||
        value.priorityFilter.max > MAX_EVENT_PRIORITY ||
        value.priorityFilter.min > value.priorityFilter.max) return;
    if (len >= apduLen || !baAsn1.decodeIsClosingTagNumber(buffer, offset + len, 4)) return;
    len++;
  }
  if (len < apduLen && baAsn1.decodeIsContextTag(buffer, offset + len, 5)) {
    result = decodeOptionalContextValue(
      buffer,
      offset + len,
      endOffset,
      5,
      baAsn1.decodeUnsigned
    );
    if (!result) return;
    len += result.len;
    value.notificationClassFilter = result.decoded.value;
  }
  if (len !== apduLen) return;
  value.len = len;
  return value;
};

module.exports.encodeAcknowledge = (buffer, enrollmentSummaries) => {
  enrollmentSummaries.forEach((enrollmentSummary) => validateSummaryPriority(enrollmentSummary.priority));
  enrollmentSummaries.forEach((enrollmentSummary) => {
    baAsn1.encodeApplicationObjectId(buffer, enrollmentSummary.objectId.type, enrollmentSummary.objectId.instance);
    baAsn1.encodeApplicationEnumerated(buffer, enrollmentSummary.eventType);
    baAsn1.encodeApplicationEnumerated(buffer, enrollmentSummary.eventState);
    baAsn1.encodeApplicationUnsigned(buffer, enrollmentSummary.priority);
    if (enrollmentSummary.notificationClass != null) {
      baAsn1.encodeApplicationUnsigned(buffer, enrollmentSummary.notificationClass);
    }
  });
};

module.exports.decodeAcknowledge = (buffer, offset, apduLen) => {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(apduLen) || apduLen < 0 || offset > buffer.length ||
      apduLen > buffer.length - offset) return;
  const endOffset = offset + apduLen;
  let len = 0;
  let result;
  const enrollmentSummaries = [];
  while (offset + len < endOffset) {
    const enrollmentSummary = {};
    result = decodeApplicationValue(
      buffer,
      offset + len,
      endOffset,
      baEnum.ApplicationTags.OBJECTIDENTIFIER,
      baAsn1.decodeObjectId,
      4
    );
    if (!result) return;
    len += result.len;
    enrollmentSummary.objectId = {
      type: result.decoded.objectType,
      instance: result.decoded.instance
    };
    result = decodeApplicationValue(
      buffer,
      offset + len,
      endOffset,
      baEnum.ApplicationTags.ENUMERATED,
      baAsn1.decodeEnumerated
    );
    if (!result) return;
    len += result.len;
    enrollmentSummary.eventType = result.decoded.value;
    result = decodeApplicationValue(
      buffer,
      offset + len,
      endOffset,
      baEnum.ApplicationTags.ENUMERATED,
      baAsn1.decodeEnumerated
    );
    if (!result) return;
    len += result.len;
    enrollmentSummary.eventState = result.decoded.value;
    result = decodeApplicationValue(
      buffer,
      offset + len,
      endOffset,
      baEnum.ApplicationTags.UNSIGNED_INTEGER,
      baAsn1.decodeUnsigned
    );
    if (!result) return;
    len += result.len;
    enrollmentSummary.priority = result.decoded.value;
    if (enrollmentSummary.priority > MAX_EVENT_PRIORITY) return;

    if (offset + len < endOffset) {
      const nextTag = baAsn1.decodeTagNumberAndValue(buffer, offset + len);
      if (!nextTag || nextTag.len > endOffset - (offset + len)) return;
      if (isApplicationTag(
        buffer,
        offset + len,
        nextTag,
        baEnum.ApplicationTags.UNSIGNED_INTEGER
      )) {
        result = decodeApplicationValue(
          buffer,
          offset + len,
          endOffset,
          baEnum.ApplicationTags.UNSIGNED_INTEGER,
          baAsn1.decodeUnsigned
        );
        if (!result) return;
        len += result.len;
        enrollmentSummary.notificationClass = result.decoded.value;
      } else if (!isApplicationTag(
        buffer,
        offset + len,
        nextTag,
        baEnum.ApplicationTags.OBJECTIDENTIFIER
      )) {
        return;
      }
    }
    enrollmentSummaries.push(enrollmentSummary);
  }
  return {
    enrollmentSummaries: enrollmentSummaries,
    len: len
  };
};
