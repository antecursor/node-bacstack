'use strict';

const baEnum = require('../enum');
const {
  addressKey,
  linkKey,
  normalizeAddress
} = require('./address');

const MIN_INVOKE_ID = 0;
const MAX_INVOKE_ID = 0xFF;
const MAX_TIMER_DELAY = 0x7FFFFFFF;
const PDU_TYPE_MASK = 0xF0;
const DEFAULT_MAX_TRANSACTIONS = 1024;
const DEFAULT_MAX_PEER_STATES = 1024;
const TERMINAL_PDU_TYPES = new Set([
  baEnum.PduTypes.SIMPLE_ACK,
  baEnum.PduTypes.COMPLEX_ACK,
  baEnum.PduTypes.ERROR,
  baEnum.PduTypes.REJECT,
  baEnum.PduTypes.ABORT
]);
const SERVICE_PDU_TYPES = new Set([
  baEnum.PduTypes.SIMPLE_ACK,
  baEnum.PduTypes.COMPLEX_ACK,
  baEnum.PduTypes.ERROR
]);
const FAILURE_PDU_TYPES = new Set([
  baEnum.PduTypes.ERROR,
  baEnum.PduTypes.REJECT,
  baEnum.PduTypes.ABORT
]);

function makeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertInvokeId(invokeId) {
  if (!Number.isInteger(invokeId) || invokeId < MIN_INVOKE_ID || invokeId > MAX_INVOKE_ID) {
    throw makeError('ERR_INVALID_INVOKE_ID');
  }
  return invokeId;
}

function assertService(service) {
  if (!Number.isInteger(service) || service < 0 || service > 0xFF) {
    throw makeError('ERR_INVALID_SERVICE');
  }
  return service;
}

function normalizePduType(pduType) {
  if (!Number.isInteger(pduType) || pduType < 0 || pduType > 0xFF) {
    throw makeError('ERR_INVALID_PDU_TYPE');
  }
  const normalized = pduType & PDU_TYPE_MASK;
  if (!TERMINAL_PDU_TYPES.has(normalized)) throw makeError('ERR_INVALID_PDU_TYPE');
  return normalized;
}

function normalizeAcceptedPdus(value) {
  let values;
  if (value instanceof Set) {
    values = Array.from(value);
  } else if (Array.isArray(value)) {
    values = value;
  } else if (Number.isInteger(value)) {
    values = [value];
  } else {
    throw makeError('ERR_INVALID_ACCEPTED_PDUS');
  }

  const normalized = Array.from(new Set(Array.from(values, normalizePduType)));
  if (normalized.length === 0) throw makeError('ERR_INVALID_ACCEPTED_PDUS');
  return Object.freeze(normalized);
}

function assertTimeout(timeout) {
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMER_DELAY) {
    throw makeError('ERR_INVALID_TIMEOUT');
  }
  return timeout;
}

function assertPositiveLimit(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw makeError(code);
  return value;
}

function transactionKey(peerKey, invokeId) {
  return JSON.stringify([peerKey, invokeId]);
}

function fallbackKey(peerLinkKey, invokeId) {
  return JSON.stringify([peerLinkKey, invokeId]);
}

function cancellationError(error, defaultCode) {
  if (error == null) return makeError(defaultCode);
  if (error instanceof Error) return error;
  const normalized = new Error(String(error));
  normalized.code = defaultCode;
  return normalized;
}

/**
 * Owns confirmed-request invoke IDs and response correlation. A transaction is
 * registered synchronously by begin() before its handle is returned, allowing
 * callers to encode and send only after correlation state exists.
 */
class TransactionManager {
  constructor(options) {
    options = options || {};
    this._defaultTimeout = assertTimeout(options.defaultTimeout == null ? 3000 : options.defaultTimeout);
    this._allowRoutedResponseFallback = options.allowRoutedResponseFallback === true;
    this._stringAddressKind = options.stringAddressKind || 'ip';
    if (this._stringAddressKind !== 'ip' && this._stringAddressKind !== 'vmac') {
      throw makeError('ERR_INVALID_ADDRESS_KIND');
    }
    this._maxTransactions = assertPositiveLimit(
      options.maxTransactions == null ? DEFAULT_MAX_TRANSACTIONS : options.maxTransactions,
      'ERR_INVALID_TRANSACTION_LIMIT'
    );
    this._maxPeerStates = assertPositiveLimit(
      options.maxPeerStates == null ? DEFAULT_MAX_PEER_STATES : options.maxPeerStates,
      'ERR_INVALID_PEER_LIMIT'
    );
    this._now = options.now || Date.now;
    this._setTimeout = options.setTimeout || setTimeout;
    this._clearTimeout = options.clearTimeout || clearTimeout;
    if (typeof this._now !== 'function' || typeof this._setTimeout !== 'function' ||
        typeof this._clearTimeout !== 'function') {
      throw makeError('ERR_INVALID_TIMER_FUNCTION');
    }

    this._entries = new Map();
    this._fallbackEntries = new Map();
    this._peerStates = new Map();
    this._cancelling = false;
    this._closed = false;
  }

  get size() {
    return this._entries.size;
  }

  /**
   * Allocate and register a transaction in one synchronous operation.
   *
   * @param {object} options transaction options
   * @returns {object} immutable transaction handle
   */
  begin(options) {
    if (this._closed) throw makeError('ERR_TRANSACTION_MANAGER_CLOSED');
    if (this._cancelling) throw makeError('ERR_TRANSACTION_MANAGER_CANCELLING');
    if (this._entries.size >= this._maxTransactions) throw makeError('ERR_TRANSACTION_LIMIT');
    if (!options || typeof options !== 'object') throw makeError('ERR_INVALID_TRANSACTION');
    if (typeof options.callback !== 'function') throw makeError('ERR_INVALID_CALLBACK');

    const address = this._normalizeAddress(options.address);
    const peerKey = addressKey(address);
    const peerLinkKey = linkKey(address);
    const allocationKey = this._allowRoutedResponseFallback && peerLinkKey != null ? peerLinkKey : peerKey;
    const service = assertService(options.service);
    const acceptedPdus = normalizeAcceptedPdus(options.acceptedPdus);
    const timeout = assertTimeout(options.timeout == null ? this._defaultTimeout : options.timeout);
    const startedAt = this._readClock();
    const deadline = startedAt + timeout;
    if (!Number.isSafeInteger(deadline)) throw makeError('ERR_INVALID_TIMEOUT');
    const invokeId = this._reserveInvokeId(allocationKey, options.requestedInvokeId, startedAt);

    const key = transactionKey(peerKey, invokeId);
    const controller = new AbortController();
    const entry = {
      acceptedPdus,
      active: true,
      address,
      allocationKey,
      callback: options.callback,
      controller,
      deadline,
      invokeId,
      key,
      peerKey,
      peerLinkKey,
      service,
      timeout,
      timer: null,
      transaction: null
    };

    const transaction = {
      acceptedPdus,
      address,
      cancel: (error) => this._finish(entry, cancellationError(error, 'ERR_TRANSACTION_CANCELLED'), undefined, true),
      deadline,
      invokeId,
      key,
      peerKey,
      service,
      settle: (error, result) => this._finish(entry, error, result, false),
      signal: controller.signal
    };
    Object.defineProperty(transaction, 'active', {
      enumerable: true,
      get: () => entry.active
    });
    entry.transaction = Object.freeze(transaction);

    this._entries.set(key, entry);
    this._addFallbackEntry(entry);
    try {
      const timer = this._setTimeout(() => this._timeout(entry), timeout);
      entry.timer = timer;
      if (!entry.active) this._clearTimeout(timer);
    } catch (error) {
      this._deactivate(entry, error, true, false);
      throw error;
    }
    return entry.transaction;
  }

  /**
   * Settle the transaction matching an inbound APDU. Mismatched service/PDU
   * metadata and ambiguous routed fallbacks are ignored without consuming any
   * transaction.
   *
   * @param {object} response decoded response metadata
   * @returns {boolean} true when a transaction was settled
   */
  settle(response) {
    if (this._closed || !response || typeof response !== 'object') return false;

    let address;
    let invokeId;
    let pduType;
    let service;
    try {
      address = this._normalizeAddress(response.address);
      invokeId = assertInvokeId(response.invokeId);
      pduType = normalizePduType(response.pduType);
      if (SERVICE_PDU_TYPES.has(pduType)) {
        service = assertService(response.service);
      } else if (response.service != null) {
        service = assertService(response.service);
      } else {
        service = null;
      }
    } catch {
      return false;
    }

    if (FAILURE_PDU_TYPES.has(pduType) && !(response.error instanceof Error)) return false;
    const entry = this._findEntry(address, invokeId);
    if (!entry || !entry.active) return false;
    if (!entry.acceptedPdus.includes(pduType)) return false;
    if (service != null && entry.service !== service) return false;
    return this._finish(entry, response.error, response.result, false);
  }

  /**
   * Test whether an exact peer/invoke-ID pair is currently registered.
   *
   * @param {string|object} address exact peer address
   * @param {number} invokeId invoke ID
   * @returns {boolean} registration status
   */
  has(address, invokeId) {
    try {
      const key = transactionKey(addressKey(this._normalizeAddress(address)), assertInvokeId(invokeId));
      const entry = this._entries.get(key);
      return !!(entry && entry.active);
    } catch {
      return false;
    }
  }

  /**
   * Cancel every active transaction. New transactions are rejected during
   * callbacks so this method always returns with an empty active set.
   *
   * @param {Error=} error cancellation reason
   * @returns {number} number of transactions cancelled
   */
  cancelAll(error) {
    if (this._cancelling) return 0;
    const reason = cancellationError(error, 'ERR_CLIENT_CLOSED');
    const entries = Array.from(this._entries.values());
    const cancelledEntries = [];
    let callbackError;
    this._cancelling = true;
    try {
      entries.forEach((entry) => {
        if (this._deactivate(entry, reason, true, true)) cancelledEntries.push(entry);
      });
      cancelledEntries.forEach((entry) => {
        try {
          entry.callback(reason, undefined);
        } catch (err) {
          callbackError = callbackError || err;
        }
      });
    } finally {
      this._cancelling = false;
    }
    if (callbackError) throw callbackError;
    return cancelledEntries.length;
  }

  /**
   * Permanently reject new transactions and cancel all active work.
   *
   * @param {Error=} error cancellation reason
   * @returns {number} number of transactions cancelled
   */
  close(error) {
    if (this._closed) return 0;
    this._closed = true;
    let cancelled;
    try {
      cancelled = this.cancelAll(error);
    } finally {
      this._peerStates.clear();
      this._fallbackEntries.clear();
    }
    return cancelled;
  }

  _normalizeAddress(address) {
    return normalizeAddress(address, this._stringAddressKind);
  }

  _readClock() {
    const now = this._now();
    if (!Number.isSafeInteger(now) || now < 0) throw makeError('ERR_INVALID_CLOCK');
    return now;
  }

  _reserveInvokeId(allocationKey, requestedInvokeId, now) {
    const explicitInvokeId = requestedInvokeId == null ? null : assertInvokeId(requestedInvokeId);
    const state = this._getPeerState(allocationKey, now);
    this._pruneQuarantine(state, now);
    if (explicitInvokeId != null) {
      if (state.active.has(explicitInvokeId)) throw makeError('ERR_INVOKE_ID_IN_USE');
      if (state.quarantine.has(explicitInvokeId)) throw makeError('ERR_INVOKE_ID_QUARANTINED');
      state.active.add(explicitInvokeId);
      return explicitInvokeId;
    }

    const start = state.nextInvokeId;
    for (let offset = 0; offset <= MAX_INVOKE_ID; offset++) {
      const invokeId = (start + offset) & MAX_INVOKE_ID;
      if (!state.active.has(invokeId) && !state.quarantine.has(invokeId)) {
        state.nextInvokeId = (invokeId + 1) & MAX_INVOKE_ID;
        state.active.add(invokeId);
        return invokeId;
      }
    }
    throw makeError('ERR_INVOKE_ID_EXHAUSTED');
  }

  _getPeerState(allocationKey, now) {
    let state = this._peerStates.get(allocationKey);
    if (state) return state;
    this._prunePeerStates(now);
    if (this._peerStates.size >= this._maxPeerStates) throw makeError('ERR_TRANSACTION_PEER_LIMIT');
    state = {active: new Set(), nextInvokeId: MIN_INVOKE_ID, quarantine: new Map()};
    this._peerStates.set(allocationKey, state);
    return state;
  }

  _pruneQuarantine(state, now) {
    state.quarantine.forEach((expiresAt, invokeId) => {
      if (expiresAt <= now) state.quarantine.delete(invokeId);
    });
  }

  _prunePeerStates(now) {
    this._peerStates.forEach((state, allocationKey) => {
      this._pruneQuarantine(state, now);
      if (state.active.size === 0 && state.quarantine.size === 0) {
        this._peerStates.delete(allocationKey);
      }
    });
  }

  _addFallbackEntry(entry) {
    if (entry.peerLinkKey == null) return;
    const key = fallbackKey(entry.peerLinkKey, entry.invokeId);
    let entries = this._fallbackEntries.get(key);
    if (!entries) {
      entries = new Set();
      this._fallbackEntries.set(key, entries);
    }
    entries.add(entry.key);
  }

  _findEntry(address, invokeId) {
    const exact = this._entries.get(transactionKey(addressKey(address), invokeId));
    const isLinkOnly = address.kind === 'ip' || address.kind === 'vmac';
    if (!this._allowRoutedResponseFallback || !isLinkOnly) return exact || null;

    const peerLinkKey = linkKey(address);
    const keys = this._fallbackEntries.get(fallbackKey(peerLinkKey, invokeId));
    if (!keys || keys.size !== 1) return null;
    const fallback = this._entries.get(keys.values().next().value) || null;
    if (exact && fallback !== exact) return null;
    return fallback;
  }

  _timeout(entry) {
    if (!entry.active) return false;
    return this._finish(entry, makeError('ERR_TIMEOUT'), undefined, true);
  }

  _deactivate(entry, error, cancelled, quarantine) {
    if (!entry.active) return false;
    const quarantineUntil = quarantine ? this._quarantineExpiration(entry) : null;
    entry.active = false;
    this._entries.delete(entry.key);
    if (entry.peerLinkKey != null) {
      const key = fallbackKey(entry.peerLinkKey, entry.invokeId);
      const entries = this._fallbackEntries.get(key);
      if (entries) {
        entries.delete(entry.key);
        if (entries.size === 0) this._fallbackEntries.delete(key);
      }
    }

    const state = this._peerStates.get(entry.allocationKey);
    if (state) {
      state.active.delete(entry.invokeId);
      if (quarantine) {
        state.quarantine.set(entry.invokeId, quarantineUntil);
      }
      if (state.active.size === 0 && state.quarantine.size === 0) {
        this._peerStates.delete(entry.allocationKey);
      }
    }
    if (entry.timer != null) {
      try {
        this._clearTimeout(entry.timer);
      } catch {
        // Completion is authoritative even if an injected timer adapter fails.
      }
      entry.timer = null;
    }
    if (cancelled && !entry.controller.signal.aborted) {
      try {
        entry.controller.abort(error);
      } catch {
        // Callback delivery must not be skipped because signal cleanup failed.
      }
    }
    return true;
  }

  _quarantineExpiration(entry) {
    let now;
    try {
      now = this._now();
    } catch {
      now = entry.deadline;
    }
    if (!Number.isSafeInteger(now) || now < 0) now = entry.deadline;
    return now > Number.MAX_SAFE_INTEGER - entry.timeout ?
      Number.MAX_SAFE_INTEGER : now + entry.timeout;
  }

  _finish(entry, error, result, cancelled) {
    if (!this._deactivate(entry, error, cancelled, true)) return false;
    entry.callback(error, result);
    return true;
  }
}

module.exports = TransactionManager;
module.exports.TransactionManager = TransactionManager;
