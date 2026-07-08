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

function normalizeVmac(value) {
  let bytes;
  let text;

  if (value == null) return null;
  if (Buffer.isBuffer(value)) {
    if (value.length !== 6) throw new Error('BACNET_SC_INVALID_VMAC');
    return Buffer.from(value);
  }
  if (Array.isArray(value)) {
    if (value.length !== 6) throw new Error('BACNET_SC_INVALID_VMAC');
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

function optionLength(options) {
  if (!options || options.length === 0) return 0;
  return options.reduce((total, option) => {
    return total + 1 + (option.data ? 2 + option.data.length : 0);
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
    more = (marker & OPTION_MORE) !== 0;
    if (hasData) {
      if (offset + 2 > buffer.length) throw new Error('BACNET_SC_TRUNCATED_OPTION');
      const length = buffer.readUInt16BE(offset);
      offset += 2;
      if (offset + length > buffer.length) throw new Error('BACNET_SC_TRUNCATED_OPTION');
      option.data = buffer.slice(offset, offset + length);
      offset += length;
    }
    options.push(option);
  }

  return {options: options, offset: offset};
}

function encode(functionCode, options) {
  options = options || {};
  const originating = normalizeVmac(options.originating);
  const destination = normalizeVmac(options.destination);
  const destOptions = options.destOptions || null;
  const dataOptions = options.dataOptions || null;
  const payload = options.payload ? Buffer.from(options.payload) : Buffer.alloc(0);
  let control = 0;
  let offset = 4;
  const length = 4 + (originating ? 6 : 0) + (destination ? 6 : 0) +
    optionLength(destOptions) + optionLength(dataOptions) + payload.length;
  const buffer = Buffer.alloc(length);

  if (originating) control |= CONTROL_ORIGINATING;
  if (destination) control |= CONTROL_DESTINATION;
  if (destOptions && destOptions.length > 0) control |= CONTROL_DEST_OPTIONS;
  if (dataOptions && dataOptions.length > 0) control |= CONTROL_DATA_OPTIONS;

  buffer[0] = functionCode;
  buffer[1] = control;
  buffer.writeUInt16BE((options.id || 0) & 0xFFFF, 2);
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
  const control = buffer[1];
  const message = {};

  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 4) throw new Error('BACNET_SC_TRUNCATED_MESSAGE');
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
  const buffer = Buffer.alloc(26);
  normalizeVmac(options.vmac).copy(buffer, 0);
  uuidToBuffer(options.uuid).copy(buffer, 6);
  buffer.writeUInt16BE(options.maxBvlc || options.maxBVLC || 1600, 22);
  buffer.writeUInt16BE(options.maxNpdu || options.maxNPDU || 1497, 24);
  return buffer;
}

function decodeConnectPayload(payload) {
  if (!payload || payload.length < 26) throw new Error('BACNET_SC_INVALID_CONNECT_PAYLOAD');
  return {
    vmac: payload.slice(0, 6).toString('hex'),
    uuid: bufferToUuid(payload, 6),
    maxBvlc: payload.readUInt16BE(22),
    maxNpdu: payload.readUInt16BE(24)
  };
}

function encodeBvlcResultPayload(options) {
  const details = options.errorDetails ? Buffer.from(String(options.errorDetails), 'utf8') : Buffer.alloc(0);
  const resultCode = options.resultCode == null ? 0 : options.resultCode;
  const length = resultCode === 0 ? 2 : 7 + details.length;
  const buffer = Buffer.alloc(length);

  buffer[0] = options.forFunction || 0;
  buffer[1] = resultCode;
  if (resultCode !== 0) {
    buffer[2] = options.errorHeaderMarker || 0;
    buffer.writeUInt16BE(options.errorClass || 0, 3);
    buffer.writeUInt16BE(options.errorCode || 0, 5);
    details.copy(buffer, 7);
  }
  return buffer;
}

function decodeBvlcResultPayload(payload) {
  if (!payload || payload.length < 2) throw new Error('BACNET_SC_INVALID_BVLC_RESULT');
  const result = {
    forFunction: payload[0],
    resultCode: payload[1]
  };
  if (result.resultCode !== 0) {
    if (payload.length < 7) throw new Error('BACNET_SC_INVALID_BVLC_RESULT');
    result.errorHeaderMarker = payload[2];
    result.errorClass = payload.readUInt16BE(3);
    result.errorCode = payload.readUInt16BE(5);
    result.errorDetails = payload.slice(7).toString('utf8');
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
