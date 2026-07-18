'use strict';

const crypto = require('crypto');

const FUNCTIONS = {
  BVLC_RESULT: 0,
  ENCAPSULATED_NPDU: 1,
  ADDRESS_RESOLUTION: 2,
  ADDRESS_RESOLUTION_ACK: 3,
  ADVERTISEMENT: 4,
  ADVERTISEMENT_SOLICITATION: 5,
  CONNECT_REQUEST: 6,
  CONNECT_ACCEPT: 7,
  DISCONNECT_REQUEST: 8,
  DISCONNECT_ACK: 9,
  HEARTBEAT_REQUEST: 10,
  HEARTBEAT_ACK: 11,
  PROPRIETARY_MESSAGE: 12
};

const CONTROL_ORIGINATING = 0x08;
const CONTROL_DESTINATION = 0x04;
const CONTROL_DEST_OPTIONS = 0x02;
const CONTROL_DATA_OPTIONS = 0x01;
const CONTROL_MASK = 0x0F;
const OPTION_MORE = 0x80;
const OPTION_MUST_UNDERSTAND = 0x40;
const OPTION_DATA = 0x20;
const OPTION_TYPE_MASK = 0x1F;
const BROADCAST_VMAC = 'ffffffffffff';
const MAX_UINT8 = 0xFF;
const MAX_UINT16 = 0xFFFF;
const MIN_CONNECT_BVLC_LENGTH = 30;

function makeError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function assertInteger(value, minimum, maximum, code) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw makeError(code);
  return value;
}

function toOctetBuffer(value, code) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Array.isArray(value)) {
    value.forEach((octet) => assertInteger(octet, 0, MAX_UINT8, code));
    return Buffer.from(value);
  }
  throw makeError(code);
}

function normalizeVmac(value) {
  let bytes;
  let text;

  if (value == null) return null;
  if (Buffer.isBuffer(value)) {
    if (value.length !== 6) throw new Error('BACNET_SC_INVALID_VMAC');
    return Buffer.from(value);
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength !== 6) throw makeError('BACNET_SC_INVALID_VMAC');
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) {
    if (value.length !== 6) throw new Error('BACNET_SC_INVALID_VMAC');
    value.forEach((octet) => assertInteger(octet, 0, MAX_UINT8, 'BACNET_SC_INVALID_VMAC'));
    return Buffer.from(value);
  }
  if (typeof value === 'object') {
    if (value.vmac != null) return normalizeVmac(value.vmac);
    if (value.adr != null) return normalizeVmac(value.adr);
  }

  text = String(value).trim();
  if (/^broadcast$/i.test(text)) return Buffer.from(BROADCAST_VMAC, 'hex');
  if (text.indexOf('.') !== -1) {
    bytes = text.split('.').map((part) => {
      const octet = Number(part);
      if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
        throw new Error('BACNET_SC_INVALID_VMAC');
      }
      return octet;
    });
    if (bytes.length !== 6) throw new Error('BACNET_SC_INVALID_VMAC');
    return Buffer.from(bytes);
  }

  text = text.replace(/[:-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(text)) throw new Error('BACNET_SC_INVALID_VMAC');
  return Buffer.from(text, 'hex');
}

function formatVmac(value) {
  return normalizeVmac(value).toString('hex');
}

function makeRandomVmac() {
  const bytes = crypto.randomBytes(6);
  bytes[0] = (bytes[0] & 0xF0) | 0x02;
  return bytes.toString('hex');
}

function uuidToBuffer(uuid) {
  const text = String(uuid).toLowerCase();
  const hex = text.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('BACNET_SC_INVALID_UUID');
  return Buffer.from(hex, 'hex');
}

function bufferToUuid(buffer, offset) {
  buffer = toOctetBuffer(buffer, 'BACNET_SC_INVALID_UUID');
  offset = offset == null ? 0 : offset;
  if (!Number.isInteger(offset) || offset < 0 || buffer.length - offset < 16) {
    throw makeError('BACNET_SC_INVALID_UUID');
  }
  const hex = buffer.slice(offset, offset + 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-');
}

function randomUuid() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0F) | 0x40;
  bytes[8] = (bytes[8] & 0x3F) | 0x80;
  return bufferToUuid(bytes, 0);
}

function normalizeOptions(options) {
  if (options == null) return null;
  if (!Array.isArray(options)) throw makeError('BACNET_SC_INVALID_OPTIONS');
  return options.map((option) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) {
      throw makeError('BACNET_SC_INVALID_OPTION');
    }
    const normalized = {
      type: assertInteger(option.type, 1, OPTION_TYPE_MASK, 'BACNET_SC_INVALID_OPTION_TYPE'),
      mustUnderstand: option.mustUnderstand === true
    };
    if (option.mustUnderstand != null && typeof option.mustUnderstand !== 'boolean') {
      throw makeError('BACNET_SC_INVALID_OPTION');
    }
    if (option.data != null) {
      normalized.data = toOctetBuffer(option.data, 'BACNET_SC_INVALID_OPTION_DATA');
      if (normalized.data.length > MAX_UINT16) throw makeError('BACNET_SC_OPTION_TOO_LARGE');
    }
    if (normalized.type === 1 && (!normalized.mustUnderstand || normalized.data)) {
      throw makeError('BACNET_SC_INVALID_SECURE_PATH_OPTION');
    }
    if (normalized.type === 31 && (!normalized.data || normalized.data.length < 3)) {
      throw makeError('BACNET_SC_INVALID_PROPRIETARY_OPTION');
    }
    return normalized;
  });
}

function optionLength(options) {
  if (!options || options.length === 0) return 0;
  return options.reduce((total, option) => {
    const length = total + 1 + (option.data ? 2 + option.data.length : 0);
    if (!Number.isSafeInteger(length) || length > MAX_UINT16) throw makeError('BACNET_SC_OPTIONS_TOO_LARGE');
    return length;
  }, 0);
}

function writeOptions(buffer, options, offset) {
  if (!options || options.length === 0) return offset;
  options.forEach((option, index) => {
    let marker = option.type & OPTION_TYPE_MASK;
    const data = option.data ? Buffer.from(option.data) : null;
    if (index < options.length - 1) marker |= OPTION_MORE;
    if (option.mustUnderstand) marker |= OPTION_MUST_UNDERSTAND;
    if (data) marker |= OPTION_DATA;
    buffer[offset++] = marker;
    if (data) {
      buffer.writeUInt16BE(data.length, offset);
      offset += 2;
      data.copy(buffer, offset);
      offset += data.length;
    }
  });
  return offset;
}

function readOptions(buffer, offset) {
  const options = [];
  let more = true;

  while (more) {
    if (offset >= buffer.length) throw new Error('BACNET_SC_TRUNCATED_OPTION');
    const marker = buffer[offset++];
    const hasData = (marker & OPTION_DATA) !== 0;
    const option = {
      marker: marker,
      type: marker & OPTION_TYPE_MASK,
      mustUnderstand: (marker & OPTION_MUST_UNDERSTAND) !== 0
    };
    if (option.type === 0) throw makeError('BACNET_SC_INVALID_OPTION_TYPE');
    more = (marker & OPTION_MORE) !== 0;
    if (hasData) {
      if (offset + 2 > buffer.length) throw new Error('BACNET_SC_TRUNCATED_OPTION');
      const length = buffer.readUInt16BE(offset);
      offset += 2;
      if (offset + length > buffer.length) throw new Error('BACNET_SC_TRUNCATED_OPTION');
      option.data = buffer.slice(offset, offset + length);
      offset += length;
    }
    if (option.type === 1 && (!option.mustUnderstand || option.data)) {
      throw makeError('BACNET_SC_INVALID_SECURE_PATH_OPTION');
    }
    if (option.type === 31 && (!option.data || option.data.length < 3)) {
      throw makeError('BACNET_SC_INVALID_PROPRIETARY_OPTION');
    }
    options.push(option);
  }

  return {options: options, offset: offset};
}

function encode(functionCode, options) {
  options = options || {};
  assertInteger(functionCode, 0, MAX_UINT8, 'BACNET_SC_INVALID_FUNCTION');
  const id = options.id == null ? 0 : assertInteger(options.id, 0, MAX_UINT16, 'BACNET_SC_INVALID_MESSAGE_ID');
  const originating = normalizeVmac(options.originating);
  const destination = normalizeVmac(options.destination);
  const destOptions = normalizeOptions(options.destOptions);
  const dataOptions = normalizeOptions(options.dataOptions);
  const payload = options.payload == null ? Buffer.alloc(0) : toOctetBuffer(options.payload, 'BACNET_SC_INVALID_PAYLOAD');
  let control = 0;
  let offset = 4;
  const length = 4 + (originating ? 6 : 0) + (destination ? 6 : 0) +
    optionLength(destOptions) + optionLength(dataOptions) + payload.length;
  if (!Number.isSafeInteger(length) || length > MAX_UINT16) throw makeError('BACNET_SC_MESSAGE_TOO_LARGE');
  const buffer = Buffer.alloc(length);

  if (originating) control |= CONTROL_ORIGINATING;
  if (destination) control |= CONTROL_DESTINATION;
  if (destOptions && destOptions.length > 0) control |= CONTROL_DEST_OPTIONS;
  if (dataOptions && dataOptions.length > 0) control |= CONTROL_DATA_OPTIONS;

  buffer[0] = functionCode;
  buffer[1] = control;
  buffer.writeUInt16BE(id, 2);
  if (originating) {
    originating.copy(buffer, offset);
    offset += 6;
  }
  if (destination) {
    destination.copy(buffer, offset);
    offset += 6;
  }
  offset = writeOptions(buffer, destOptions, offset);
  offset = writeOptions(buffer, dataOptions, offset);
  payload.copy(buffer, offset);
  return buffer;
}

function decode(buffer) {
  let offset = 4;
  let result;
  const message = {};

  buffer = toOctetBuffer(buffer, 'BACNET_SC_INVALID_MESSAGE');
  if (buffer.length < 4) throw new Error('BACNET_SC_TRUNCATED_MESSAGE');
  if (buffer.length > MAX_UINT16) throw makeError('BACNET_SC_MESSAGE_TOO_LARGE');
  const control = buffer[1];
  if ((control & ~CONTROL_MASK) !== 0) throw new Error('BACNET_SC_INVALID_CONTROL');

  message.function = buffer[0];
  message.control = control;
  message.id = buffer.readUInt16BE(2);
  if (control & CONTROL_ORIGINATING) {
    if (offset + 6 > buffer.length) throw new Error('BACNET_SC_TRUNCATED_MESSAGE');
    message.originating = buffer.slice(offset, offset + 6).toString('hex');
    offset += 6;
  }
  if (control & CONTROL_DESTINATION) {
    if (offset + 6 > buffer.length) throw new Error('BACNET_SC_TRUNCATED_MESSAGE');
    message.destination = buffer.slice(offset, offset + 6).toString('hex');
    offset += 6;
  }
  if (control & CONTROL_DEST_OPTIONS) {
    result = readOptions(buffer, offset);
    message.destOptions = result.options;
    offset = result.offset;
  }
  if (control & CONTROL_DATA_OPTIONS) {
    result = readOptions(buffer, offset);
    message.dataOptions = result.options;
    offset = result.offset;
  }
  message.payload = buffer.slice(offset);
  return message;
}

function encodeConnectPayload(options) {
  options = options || {};
  const maxBvlc = options.maxBvlc ?? options.maxBVLC ?? 1600;
  const maxNpdu = options.maxNpdu ?? options.maxNPDU ?? 1497;
  assertInteger(maxBvlc, MIN_CONNECT_BVLC_LENGTH, MAX_UINT16, 'BACNET_SC_INVALID_MAX_BVLC');
  assertInteger(maxNpdu, 1, MAX_UINT16, 'BACNET_SC_INVALID_MAX_NPDU');
  if (maxNpdu + 4 > maxBvlc) throw makeError('BACNET_SC_INCONSISTENT_MAX_LENGTHS');
  const buffer = Buffer.alloc(26);
  normalizeVmac(options.vmac).copy(buffer, 0);
  uuidToBuffer(options.uuid).copy(buffer, 6);
  buffer.writeUInt16BE(maxBvlc, 22);
  buffer.writeUInt16BE(maxNpdu, 24);
  return buffer;
}

function decodeConnectPayload(payload) {
  payload = toOctetBuffer(payload, 'BACNET_SC_INVALID_CONNECT_PAYLOAD');
  if (payload.length !== 26) throw new Error('BACNET_SC_INVALID_CONNECT_PAYLOAD');
  const result = {
    vmac: payload.slice(0, 6).toString('hex'),
    uuid: bufferToUuid(payload, 6),
    maxBvlc: payload.readUInt16BE(22),
    maxNpdu: payload.readUInt16BE(24)
  };
  assertInteger(result.maxBvlc, MIN_CONNECT_BVLC_LENGTH, MAX_UINT16, 'BACNET_SC_INVALID_MAX_BVLC');
  assertInteger(result.maxNpdu, 1, MAX_UINT16, 'BACNET_SC_INVALID_MAX_NPDU');
  if (result.maxNpdu + 4 > result.maxBvlc) throw makeError('BACNET_SC_INCONSISTENT_MAX_LENGTHS');
  return result;
}

function encodeBvlcResultPayload(options) {
  options = options || {};
  const details = options.errorDetails ? Buffer.from(String(options.errorDetails), 'utf8') : Buffer.alloc(0);
  const resultCode = options.resultCode == null ? 0 : options.resultCode;
  const forFunction = options.forFunction == null ? 0 : options.forFunction;
  assertInteger(forFunction, 0, MAX_UINT8, 'BACNET_SC_INVALID_FUNCTION');
  assertInteger(resultCode, 0, 1, 'BACNET_SC_INVALID_RESULT_CODE');
  if (details.length > MAX_UINT16 - 7) throw makeError('BACNET_SC_RESULT_TOO_LARGE');
  const length = resultCode === 0 ? 2 : 7 + details.length;
  const buffer = Buffer.alloc(length);

  buffer[0] = forFunction;
  buffer[1] = resultCode;
  if (resultCode !== 0) {
    buffer[2] = assertInteger(options.errorHeaderMarker ?? 0, 0, MAX_UINT8, 'BACNET_SC_INVALID_ERROR_HEADER');
    buffer.writeUInt16BE(assertInteger(options.errorClass ?? 0, 0, MAX_UINT16, 'BACNET_SC_INVALID_ERROR_CLASS'), 3);
    buffer.writeUInt16BE(assertInteger(options.errorCode ?? 0, 0, MAX_UINT16, 'BACNET_SC_INVALID_ERROR_CODE'), 5);
    details.copy(buffer, 7);
  }
  return buffer;
}

function decodeBvlcResultPayload(payload) {
  payload = toOctetBuffer(payload, 'BACNET_SC_INVALID_BVLC_RESULT');
  if (payload.length < 2) throw new Error('BACNET_SC_INVALID_BVLC_RESULT');
  const result = {
    forFunction: payload[0],
    resultCode: payload[1]
  };
  if (result.resultCode === 0) {
    if (payload.length !== 2) throw makeError('BACNET_SC_INVALID_BVLC_RESULT');
  } else if (result.resultCode === 1) {
    if (payload.length < 7) throw new Error('BACNET_SC_INVALID_BVLC_RESULT');
    result.errorHeaderMarker = payload[2];
    result.errorClass = payload.readUInt16BE(3);
    result.errorCode = payload.readUInt16BE(5);
    try {
      result.errorDetails = new TextDecoder('utf-8', {fatal: true}).decode(payload.slice(7));
    } catch {
      throw makeError('BACNET_SC_INVALID_ERROR_DETAILS');
    }
  } else {
    throw makeError('BACNET_SC_INVALID_RESULT_CODE');
  }
  return result;
}

module.exports = {
  FUNCTIONS: FUNCTIONS,
  BROADCAST_VMAC: BROADCAST_VMAC,
  normalizeVmac: normalizeVmac,
  formatVmac: formatVmac,
  makeRandomVmac: makeRandomVmac,
  randomUuid: randomUuid,
  uuidToBuffer: uuidToBuffer,
  bufferToUuid: bufferToUuid,
  encode: encode,
  decode: decode,
  encodeConnectPayload: encodeConnectPayload,
  decodeConnectPayload: decodeConnectPayload,
  encodeBvlcResultPayload: encodeBvlcResultPayload,
  decodeBvlcResultPayload: decodeBvlcResultPayload
};
