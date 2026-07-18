'use strict';

const net = require('node:net');

const NORMALIZED_ADDRESS = Symbol('normalizedAddress');
const MAX_NETWORK_NUMBER = 0xFFFF;
const MAX_MAC_LENGTH = 0xFF;
const VMAC_LENGTH = 6;

function makeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeIp(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw makeError('ERR_INVALID_ADDRESS');
  }
  const text = value.trim();
  const version = net.isIP(text);
  if (version === 4) return text;
  if (version !== 6) throw makeError('ERR_INVALID_ADDRESS');
  try {
    return new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    throw makeError('ERR_INVALID_ADDRESS');
  }
}

function normalizeOctets(value, maximumLength, code) {
  let octets;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    octets = Array.from(value);
  } else if (value instanceof ArrayBuffer) {
    octets = Array.from(new Uint8Array(value));
  } else if (Array.isArray(value)) {
    octets = value.slice();
  } else {
    throw makeError(code);
  }

  if (octets.length > maximumLength || octets.some((octet) =>
    !Number.isInteger(octet) || octet < 0 || octet > 0xFF)) {
    throw makeError(code);
  }
  return Object.freeze(octets);
}

function normalizeVmac(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array ||
      value instanceof ArrayBuffer || Array.isArray(value)) {
    const octets = normalizeOctets(value, VMAC_LENGTH, 'ERR_INVALID_VMAC');
    if (octets.length !== VMAC_LENGTH) throw makeError('ERR_INVALID_VMAC');
    return Buffer.from(octets).toString('hex');
  }

  if (typeof value !== 'string') throw makeError('ERR_INVALID_VMAC');
  let text = value.trim().toLowerCase();
  if (text === 'broadcast') return 'ffffffffffff';
  if (text.includes('.')) {
    const parts = text.split('.');
    if (parts.length !== VMAC_LENGTH || parts.some((part) => !/^\d+$/.test(part))) {
      throw makeError('ERR_INVALID_VMAC');
    }
    const octets = parts.map(Number);
    if (octets.some((octet) => octet < 0 || octet > 0xFF)) {
      throw makeError('ERR_INVALID_VMAC');
    }
    return Buffer.from(octets).toString('hex');
  }

  text = text.replace(/[:-]/g, '');
  if (!/^[0-9a-f]{12}$/.test(text)) throw makeError('ERR_INVALID_VMAC');
  return text;
}

function freezeAddress(address) {
  Object.defineProperty(address, NORMALIZED_ADDRESS, {value: true});
  return Object.freeze(address);
}

/**
 * Return an immutable, canonical representation of a BACnet peer address.
 * Routed addresses retain both the link-layer IP and the complete BACnet
 * network/MAC identity; BACnet/SC VMACs are represented as lower-case hex.
 *
 * @param {string|object} value peer address
 * @returns {object} canonical address
 */
function normalizeAddress(value, stringAddressKind) {
  stringAddressKind = stringAddressKind || 'ip';
  if (stringAddressKind !== 'ip' && stringAddressKind !== 'vmac') {
    throw makeError('ERR_INVALID_ADDRESS_KIND');
  }
  if (value && value[NORMALIZED_ADDRESS]) return value;

  if (typeof value === 'string') {
    if (stringAddressKind === 'vmac') {
      const vmac = normalizeVmac(value);
      return freezeAddress({kind: 'vmac', vmac, linkIp: null, linkVmac: vmac});
    }
    const ip = normalizeIp(value);
    return freezeAddress({kind: 'ip', ip, linkIp: ip, linkVmac: null});
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw makeError('ERR_INVALID_ADDRESS');
  }

  if (value.vmac != null) {
    if (value.ip != null) throw makeError('ERR_INVALID_ADDRESS');
    const vmac = normalizeVmac(value.vmac);
    const hasNet = value.net != null;
    const hasAdr = value.adr != null;
    if (!hasNet && !hasAdr) {
      return freezeAddress({kind: 'vmac', vmac, linkIp: null, linkVmac: vmac});
    }
    if (!hasNet || !hasAdr || !Number.isInteger(value.net) ||
        value.net < 0 || value.net > MAX_NETWORK_NUMBER) {
      throw makeError('ERR_INVALID_ADDRESS');
    }
    const adr = normalizeOctets(value.adr, MAX_MAC_LENGTH, 'ERR_INVALID_ADDRESS');
    if (adr.length === 0) throw makeError('ERR_INVALID_ADDRESS');
    return freezeAddress({kind: 'vmac-routed', vmac, net: value.net, adr, linkIp: null, linkVmac: vmac});
  }

  const ip = normalizeIp(value.ip);
  const hasNet = value.net != null;
  const hasAdr = value.adr != null;
  if (!hasNet && !hasAdr) return freezeAddress({kind: 'ip', ip, linkIp: ip, linkVmac: null});
  if (!hasNet || !hasAdr || !Number.isInteger(value.net) ||
      value.net < 0 || value.net > MAX_NETWORK_NUMBER) {
    throw makeError('ERR_INVALID_ADDRESS');
  }

  const adr = normalizeOctets(value.adr, MAX_MAC_LENGTH, 'ERR_INVALID_ADDRESS');
  if (adr.length === 0) throw makeError('ERR_INVALID_ADDRESS');
  return freezeAddress({kind: 'routed', ip, net: value.net, adr, linkIp: ip, linkVmac: null});
}

/**
 * Return a collision-safe key for the complete peer identity.
 *
 * @param {string|object} value peer address
 * @returns {string} exact peer key
 */
function addressKey(value, stringAddressKind) {
  const address = normalizeAddress(value, stringAddressKind);
  switch (address.kind) {
    case 'ip':
      return JSON.stringify(['ip', address.ip]);
    case 'routed':
      return JSON.stringify(['routed', address.ip, address.net, address.adr]);
    case 'vmac':
      return JSON.stringify(['vmac', address.vmac]);
    case 'vmac-routed':
      return JSON.stringify(['vmac-routed', address.vmac, address.net, address.adr]);
    default:
      throw makeError('ERR_INVALID_ADDRESS');
  }
}

/**
 * Return the router/link IP for an address, or null for non-IP transports.
 * This value is intentionally separate from the exact key so callers can use
 * it only for explicitly enabled, ambiguity-checked fallback matching.
 *
 * @param {string|object} value peer address
 * @returns {string|null} link IP
 */
function getLinkIp(value, stringAddressKind) {
  return normalizeAddress(value, stringAddressKind).linkIp;
}

/**
 * Return a collision-safe IP or VMAC link key.
 *
 * @param {string|object} value peer address
 * @returns {string|null} link key
 */
function linkKey(value, stringAddressKind) {
  const address = normalizeAddress(value, stringAddressKind);
  if (address.linkIp != null) return JSON.stringify(['link-ip', address.linkIp]);
  if (address.linkVmac != null) return JSON.stringify(['link-vmac', address.linkVmac]);
  return null;
}

module.exports = {
  addressKey,
  getLinkIp,
  linkKey,
  normalizeAddress
};
