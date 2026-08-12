'use strict';

const crypto = require('crypto');

const baEnum = require('../enum');
const {
  addressKey,
  normalizeAddress
} = require('./address');

const DEFAULT_MAX_ENTRIES = 1024;
const DEFAULT_MAX_ENTRIES_PER_PEER = 64;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1482;
const DEFAULT_TIMEOUT = 30000;
const FINGERPRINT_BYTES = 32;
const MAX_TIMER_DELAY = 0x7FFFFFFF;

function makeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function positiveInteger(value, fallback, code) {
  value = value == null ? fallback : value;
  if (!Number.isSafeInteger(value) || value <= 0) throw makeError(code);
  return value;
}

function assertByte(value, code) {
  if (!Number.isInteger(value) || value < 0 || value > 0xFF) throw makeError(code);
  return value;
}

function assertInvokeId(value) {
  return assertByte(value, 'ERR_INVALID_INVOKE_ID');
}

function transactionScopeKey(scope) {
  if (scope == null) return null;
  if (!scope || typeof scope !== 'object' || !Number.isInteger(scope.net) ||
      scope.net <= 0 || scope.net >= 0xFFFF || !Array.isArray(scope.adr) ||
      scope.adr.length === 0 || scope.adr.length > 0xFF || scope.adr.some((octet) =>
    !Number.isInteger(octet) || octet < 0 || octet > 0xFF)) {
    throw makeError('ERR_INVALID_SERVER_TRANSACTION_SCOPE');
  }
  return JSON.stringify(['route', scope.net, scope.adr]);
}

function entryKey(peerKey, invokeId, scopeKey) {
  return JSON.stringify([peerKey, invokeId, scopeKey]);
}

function fingerprint(request) {
  const payload = request.payload;
  if (!Buffer.isBuffer(payload)) throw makeError('ERR_INVALID_REQUEST_PAYLOAD');
  const canonicalType = assertByte(request.type, 'ERR_INVALID_PDU_TYPE') &
    ~(baEnum.PduConReqBits.SEGMENTED_MESSAGE | baEnum.PduConReqBits.MORE_FOLLOWS);
  const header = Buffer.from([
    canonicalType,
    assertByte(request.maxSegments, 'ERR_INVALID_MAX_SEGMENTS'),
    assertByte(request.maxApdu, 'ERR_INVALID_MAX_APDU'),
    assertByte(request.service, 'ERR_INVALID_SERVICE')
  ]);
  return crypto.createHash('sha256').update(header).update(payload).digest();
}

/**
 * Bounds the lifetime and memory used by inbound confirmed-request state. The
 * first terminal response encoded by a public response helper is retained
 * byte-for-byte before delivery, so a requester retry cannot cause the
 * application operation to run again when the transport rejects that send.
 */
class ServerTransactionManager {
  constructor(options) {
    options = options || {};
    this._timeout = positiveInteger(
      options.timeout,
      DEFAULT_TIMEOUT,
      'ERR_INVALID_SERVER_TRANSACTION_TIMEOUT'
    );
    if (this._timeout > MAX_TIMER_DELAY) {
      throw makeError('ERR_INVALID_SERVER_TRANSACTION_TIMEOUT');
    }
    this._maxEntries = positiveInteger(
      options.maxEntries,
      DEFAULT_MAX_ENTRIES,
      'ERR_INVALID_SERVER_TRANSACTION_LIMIT'
    );
    this._maxEntriesPerPeer = positiveInteger(
      options.maxEntriesPerPeer,
      DEFAULT_MAX_ENTRIES_PER_PEER,
      'ERR_INVALID_SERVER_TRANSACTION_PEER_LIMIT'
    );
    this._maxBytes = positiveInteger(
      options.maxBytes,
      DEFAULT_MAX_BYTES,
      'ERR_INVALID_SERVER_TRANSACTION_BYTE_LIMIT'
    );
    this._maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      'ERR_INVALID_SERVER_RESPONSE_LIMIT'
    );
    this._reservationBytes = FINGERPRINT_BYTES + this._maxResponseBytes;
    if (this._maxBytes < this._reservationBytes) {
      throw makeError('ERR_INVALID_SERVER_TRANSACTION_BYTE_LIMIT');
    }

    this._stringAddressKind = options.stringAddressKind || 'ip';
    if (this._stringAddressKind !== 'ip' && this._stringAddressKind !== 'vmac') {
      throw makeError('ERR_INVALID_ADDRESS_KIND');
    }
    this._defaultPort = options.defaultPort;
    this._now = options.now || Date.now;
    this._setTimeout = options.setTimeout || setTimeout;
    this._clearTimeout = options.clearTimeout || clearTimeout;
    this._onExpire = options.onExpire || null;
    if (typeof this._now !== 'function' || typeof this._setTimeout !== 'function' ||
        typeof this._clearTimeout !== 'function' ||
        (this._onExpire != null && typeof this._onExpire !== 'function')) {
      throw makeError('ERR_INVALID_TIMER_FUNCTION');
    }

    this._entries = new Map();
    this._generationEntries = new WeakMap();
    this._peerCounts = new Map();
    this._totalBytes = 0;
    this._closed = false;
  }

  get size() {
    return this._entries.size;
  }

  get totalBytes() {
    return this._totalBytes;
  }

  accept(request) {
    if (this._closed) return {status: 'closed'};
    this._sweepExpired();
    const address = normalizeAddress(
      request.address,
      this._stringAddressKind,
      this._defaultPort
    );
    const peerKey = addressKey(address);
    const invokeId = assertInvokeId(request.invokeId);
    const service = assertByte(request.service, 'ERR_INVALID_SERVICE');
    const scopeKey = transactionScopeKey(request.scope);
    const requestFingerprint = fingerprint(request);
    const key = entryKey(peerKey, invokeId, scopeKey);
    let entry = this._entries.get(key);

    if (entry && this._expired(entry)) this._expire(entry);
    entry = this._entries.get(key);
    if (entry) {
      if (!entry.fingerprint.equals(requestFingerprint)) {
        if (entry.state === 'pending') {
          return {status: 'collision', address: address};
        }
        if (!this._hasCapacity(peerKey, this._reservationBytes, entry)) {
          return {status: 'out-of-resources', address: address};
        }
        this._remove(entry);
      } else {
        if (entry.state === 'completed') {
          return {
            status: 'completed',
            address: entry.address,
            frame: Buffer.from(entry.frame)
          };
        }
        return {status: 'pending', address: entry.address};
      }
    }

    if (!this._hasCapacity(peerKey, this._reservationBytes)) {
      return {status: 'out-of-resources', address: address};
    }

    const now = this._now();
    if (!Number.isSafeInteger(now) || now < 0 ||
        now > Number.MAX_SAFE_INTEGER - this._timeout) {
      return {status: 'out-of-resources', address: address};
    }
    entry = {
      key: key,
      peerKey: peerKey,
      address: address,
      invokeId: invokeId,
      service: service,
      fingerprint: requestFingerprint,
      generation: Object.freeze(Object.create(null)),
      responseMaxApdu: request.responseMaxApdu,
      state: 'pending',
      frame: null,
      bytes: this._reservationBytes,
      expiresAt: now + this._timeout,
      expiring: false,
      timer: null
    };
    this._entries.set(key, entry);
    this._generationEntries.set(entry.generation, entry);
    this._peerCounts.set(peerKey, (this._peerCounts.get(peerKey) || 0) + 1);
    this._totalBytes += entry.bytes;
    if (!this._schedule(entry)) {
      this._remove(entry);
      return {status: 'out-of-resources', address: address};
    }
    return {
      status: 'new',
      address: address,
      expiresAt: entry.expiresAt,
      generation: entry.generation,
      invokeId: entry.invokeId,
      responseMaxApdu: entry.responseMaxApdu,
      service: entry.service
    };
  }

  bindResponse(options) {
    const address = normalizeAddress(
      options.address,
      this._stringAddressKind,
      this._defaultPort
    );
    const invokeId = assertInvokeId(options.invokeId);
    const service = assertByte(options.service, 'ERR_INVALID_SERVICE');
    if (!Buffer.isBuffer(options.frame) || options.frame.length === 0 ||
        options.frame.length > this._maxResponseBytes) {
      throw makeError('ERR_SERVER_RESPONSE_TOO_LARGE');
    }
    const peerKey = addressKey(address);
    const key = entryKey(peerKey, invokeId, null);
    let entry = options.generation == null ?
      this._entries.get(key) : this._generationEntries.get(options.generation);
    if (entry && (entry.peerKey !== peerKey || entry.invokeId !== invokeId)) {
      throw makeError('ERR_SERVER_RESPONSE_MISMATCH');
    }
    if (entry && this._expired(entry) &&
        !(entry.expiring && options.allowExpired === true &&
          options.generation === entry.generation)) {
      this._expire(entry);
      entry = options.generation == null ?
        this._entries.get(key) : this._generationEntries.get(options.generation);
    }
    if (!entry) {
      if (options.generation != null) throw makeError('ERR_STALE_SERVER_REPLY');
      return {status: 'untracked', frame: Buffer.from(options.frame)};
    }
    if (options.generation == null) throw makeError('ERR_SERVER_REPLY_REQUIRED');
    if (options.generation !== entry.generation) throw makeError('ERR_STALE_SERVER_REPLY');
    if (entry.service !== service) throw makeError('ERR_SERVER_RESPONSE_MISMATCH');

    if (entry.state === 'completed') {
      throw makeError('ERR_SERVER_REPLY_COMPLETED');
    }
    const frame = Buffer.from(options.frame);
    const now = this._now();
    if (!Number.isSafeInteger(now) || now < 0 ||
        now > Number.MAX_SAFE_INTEGER - this._timeout) {
      this._remove(entry);
      throw makeError('ERR_INVALID_SERVER_TRANSACTION_TIME');
    }
    this._cancelTimer(entry);
    this._totalBytes -= entry.bytes;
    entry.state = 'completed';
    entry.frame = frame;
    entry.bytes = FINGERPRINT_BYTES + entry.frame.length;
    entry.expiresAt = now + this._timeout;
    this._totalBytes += entry.bytes;
    this._entries.delete(entry.key);
    this._entries.set(entry.key, entry);
    if (!this._schedule(entry)) {
      this._remove(entry);
      throw makeError('ERR_SERVER_TRANSACTION_TIMER');
    }
    return {status: 'completed', frame: Buffer.from(entry.frame)};
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    Array.from(this._entries.values()).forEach((entry) => this._remove(entry));
  }

  _expired(entry) {
    const now = this._now();
    return Number.isSafeInteger(now) && now >= entry.expiresAt;
  }

  _hasCapacity(peerKey, bytes, replacing) {
    const entryCount = this._entries.size - (replacing ? 1 : 0);
    const peerCount = (this._peerCounts.get(peerKey) || 0) -
      (replacing && replacing.peerKey === peerKey ? 1 : 0);
    const totalBytes = this._totalBytes - (replacing ? replacing.bytes : 0);
    return entryCount < this._maxEntries &&
      peerCount < this._maxEntriesPerPeer &&
      totalBytes + bytes <= this._maxBytes;
  }

  _sweepExpired() {
    Array.from(this._entries.values()).forEach((entry) => {
      if (this._expired(entry)) this._expire(entry);
    });
  }

  _expire(entry) {
    if (!entry || this._entries.get(entry.key) !== entry) return false;
    if (entry.state !== 'pending' || !this._onExpire || entry.expiring) {
      return this._remove(entry);
    }
    entry.expiring = true;
    try {
      this._onExpire(Object.freeze({
        address: entry.address,
        expiresAt: entry.expiresAt,
        generation: entry.generation,
        invokeId: entry.invokeId,
        responseMaxApdu: entry.responseMaxApdu,
        service: entry.service
      }));
    } finally {
      entry.expiring = false;
    }
    if (this._entries.get(entry.key) === entry && entry.state === 'pending') {
      return this._remove(entry);
    }
    return true;
  }

  _schedule(entry) {
    try {
      const expiresAt = entry.expiresAt;
      entry.timer = this._setTimeout(() => {
        if (entry.expiresAt === expiresAt) this._expire(entry);
      }, this._timeout);
      if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
      return true;
    } catch {
      entry.timer = null;
      return false;
    }
  }

  _cancelTimer(entry) {
    if (!entry.timer) return;
    try {
      this._clearTimeout(entry.timer);
    } catch {
      // State cleanup must not depend on a custom timer adapter.
    }
    entry.timer = null;
  }

  _remove(entry) {
    if (!entry || this._entries.get(entry.key) !== entry) return false;
    this._entries.delete(entry.key);
    this._generationEntries.delete(entry.generation);
    this._cancelTimer(entry);
    this._totalBytes -= entry.bytes;
    const peerCount = (this._peerCounts.get(entry.peerKey) || 1) - 1;
    if (peerCount === 0) this._peerCounts.delete(entry.peerKey);
    else this._peerCounts.set(entry.peerKey, peerCount);
    entry.frame = null;
    return true;
  }
}

module.exports = ServerTransactionManager;
