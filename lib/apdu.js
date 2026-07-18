'use strict';

const baEnum      = require('./enum');

const hasBytes = (buffer, offset, required, length) => {
  if (!buffer || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(required) || required < 0) return false;
  const available = length == null ? buffer.length - offset : length;
  return Number.isInteger(available) && available >= required && available <= buffer.length - offset;
};

const getDecodedType = module.exports.getDecodedType = (buffer, offset) => {
  if (!hasBytes(buffer, offset, 1)) return;
  return buffer[offset];
};

module.exports.setDecodedType = (buffer, offset, type) => {
  buffer[offset] = type;
};

module.exports.getDecodedInvokeId = (buffer, offset) => {
  const type = getDecodedType(buffer, offset);
  if (type == null) return;
  switch (type & baEnum.PDU_TYPE_MASK) {
    case baEnum.PduTypes.SIMPLE_ACK:
    case baEnum.PduTypes.COMPLEX_ACK:
    case baEnum.PduTypes.ERROR:
    case baEnum.PduTypes.REJECT:
    case baEnum.PduTypes.ABORT:
      if (!hasBytes(buffer, offset, 2)) return;
      return buffer[offset + 1];
    case baEnum.PduTypes.CONFIRMED_REQUEST:
      if (!hasBytes(buffer, offset, 3)) return;
      return buffer[offset + 2];
    default:
      return;
  }
};

module.exports.encodeConfirmedServiceRequest = (buffer, type, service, maxSegments, maxApdu, invokeId, sequencenumber, proposedWindowSize) => {
  buffer.buffer[buffer.offset++] = type;
  buffer.buffer[buffer.offset++] = maxSegments | maxApdu;
  buffer.buffer[buffer.offset++] = invokeId;
  if ((type & baEnum.PduConReqBits.SEGMENTED_MESSAGE) > 0) {
    buffer.buffer[buffer.offset++] = sequencenumber;
    buffer.buffer[buffer.offset++] = proposedWindowSize;
  }
  buffer.buffer[buffer.offset++] = service;
};

module.exports.decodeConfirmedServiceRequest = (buffer, offset, length) => {
  if (!hasBytes(buffer, offset, 1, length)) return;
  const segmented = (buffer[offset] & baEnum.PduConReqBits.SEGMENTED_MESSAGE) > 0;
  if (!hasBytes(buffer, offset, segmented ? 6 : 4, length)) return;

  const orgOffset = offset;
  const type = buffer[offset++];
  const maxSegments = buffer[offset] & 0xF0;
  const maxApdu = buffer[offset++] & 0x0F;
  const invokeId = buffer[offset++];
  let sequencenumber = 0;
  let proposedWindowNumber = 0;
  if ((type & baEnum.PduConReqBits.SEGMENTED_MESSAGE) > 0) {
    sequencenumber = buffer[offset++];
    proposedWindowNumber = buffer[offset++];
  }
  const service = buffer[offset++];
  return {
    len: offset - orgOffset,
    type: type,
    service: service,
    maxSegments: maxSegments,
    maxApdu: maxApdu,
    invokeId: invokeId,
    sequencenumber: sequencenumber,
    proposedWindowNumber: proposedWindowNumber
  };
};

module.exports.encodeUnconfirmedServiceRequest = (buffer, type, service) => {
  buffer.buffer[buffer.offset++] = type;
  buffer.buffer[buffer.offset++] = service;
};

module.exports.decodeUnconfirmedServiceRequest = (buffer, offset, length) => {
  if (!hasBytes(buffer, offset, 2, length)) return;
  const orgOffset = offset;
  const type = buffer[offset++];
  const service = buffer[offset++];
  return {
    len: offset - orgOffset,
    type: type,
    service: service
  };
};

module.exports.encodeSimpleAck = (buffer, type, service, invokeId) => {
  buffer.buffer[buffer.offset++] = type;
  buffer.buffer[buffer.offset++] = invokeId;
  buffer.buffer[buffer.offset++] = service;
};

module.exports.decodeSimpleAck = (buffer, offset, length) => {
  if (!hasBytes(buffer, offset, 3, length)) return;
  const orgOffset = offset;
  const type = buffer[offset++];
  const invokeId = buffer[offset++];
  const service = buffer[offset++];
  return {
    len: offset - orgOffset,
    type: type,
    service: service,
    invokeId: invokeId
  };
};

module.exports.encodeComplexAck = (buffer, type, service, invokeId, sequencenumber, proposedWindowNumber) => {
  let len = 3;
  buffer.buffer[buffer.offset++] = type;
  buffer.buffer[buffer.offset++] = invokeId;
  if ((type & baEnum.PduConReqBits.SEGMENTED_MESSAGE) > 0) {
    buffer.buffer[buffer.offset++] = sequencenumber;
    buffer.buffer[buffer.offset++] = proposedWindowNumber;
    len += 2;
  }
  buffer.buffer[buffer.offset++] = service;
  return len;
};

module.exports.decodeComplexAck = (buffer, offset, length) => {
  if (!hasBytes(buffer, offset, 1, length)) return;
  const segmented = (buffer[offset] & baEnum.PduConReqBits.SEGMENTED_MESSAGE) > 0;
  if (!hasBytes(buffer, offset, segmented ? 5 : 3, length)) return;

  const orgOffset = offset;
  const type = buffer[offset++];
  const invokeId = buffer[offset++];
  let sequencenumber = 0;
  let proposedWindowNumber = 0;
  if ((type & baEnum.PduConReqBits.SEGMENTED_MESSAGE) > 0) {
    sequencenumber = buffer[offset++];
    proposedWindowNumber = buffer[offset++];
  }
  const service = buffer[offset++];
  return {
    len: offset - orgOffset,
    type: type,
    service: service,
    invokeId: invokeId,
    sequencenumber: sequencenumber,
    proposedWindowNumber: proposedWindowNumber
  };
};

module.exports.encodeSegmentAck = (buffer, type, originalInvokeId, sequencenumber, actualWindowSize) => {
  buffer.buffer[buffer.offset++] = type;
  buffer.buffer[buffer.offset++] = originalInvokeId;
  buffer.buffer[buffer.offset++] = sequencenumber;
  buffer.buffer[buffer.offset++] = actualWindowSize;
};

module.exports.decodeSegmentAck = (buffer, offset, length) => {
  if (!hasBytes(buffer, offset, 4, length)) return;
  const orgOffset = offset;
  const type = buffer[offset++];
  const originalInvokeId = buffer[offset++];
  const sequencenumber = buffer[offset++];
  const actualWindowSize = buffer[offset++];
  return {
    len: offset - orgOffset,
    type: type,
    originalInvokeId: originalInvokeId,
    sequencenumber: sequencenumber,
    actualWindowSize: actualWindowSize
  };
};

module.exports.encodeError = (buffer, type, service, invokeId) => {
  buffer.buffer[buffer.offset++] = type;
  buffer.buffer[buffer.offset++] = invokeId;
  buffer.buffer[buffer.offset++] = service;
};

module.exports.decodeError = (buffer, offset, length) => {
  if (!hasBytes(buffer, offset, 3, length)) return;
  const orgOffset = offset;
  const type = buffer[offset++];
  const invokeId = buffer[offset++];
  const service = buffer[offset++];
  return {
    len: offset - orgOffset,
    type: type,
    service: service,
    invokeId: invokeId
  };
};

module.exports.encodeAbort = (buffer, type, invokeId, reason) => {
  buffer.buffer[buffer.offset++] = type;
  buffer.buffer[buffer.offset++] = invokeId;
  buffer.buffer[buffer.offset++] = reason;
};

module.exports.decodeAbort = (buffer, offset, length) => {
  if (!hasBytes(buffer, offset, 3, length)) return;
  const orgOffset = offset;
  const type = buffer[offset++];
  const invokeId = buffer[offset++];
  const reason = buffer[offset++];
  return {
    len: offset - orgOffset,
    type: type,
    invokeId: invokeId,
    reason: reason
  };
};
