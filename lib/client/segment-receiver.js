'use strict';

const crypto = require('crypto');

const DEFAULT_MAX_TRANSFERS = 32;
const DEFAULT_MAX_TRANSFERS_PER_PEER = 8;
const DEFAULT_MAX_SEGMENTS = 1024;
const DEFAULT_MAX_BYTES_PER_TRANSFER = 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT = 3000;
const DEFAULT_ABSOLUTE_TIMEOUT = 30000;
const MAX_TIMER_DELAY = 0x7FFFFFFF;

function positiveInteger(value, fallback, name) {
  value = value == null ? fallback : value;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(name + ' must be a positive integer');
  }
  return value;
}

function nonNegativeInteger(value, fallback, name) {
  value = value == null ? fallback : value;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(name + ' must be a non-negative integer');
  }
  return value;
}

function transferKey(direction, peerKey, invokeId) {
  return JSON.stringify([direction, peerKey, invokeId]);
}

function peerTransferKey(direction, peerKey) {
  return JSON.stringify([direction, peerKey]);
}

function invalid(reason, details) {
  return Object.assign({status: 'reject', reason: reason}, details);
}

function optionalPositiveInteger(value, name) {
  if (value == null) return null;
  return positiveInteger(value, value, name);
}

function normalizedContextKey(value) {
  return value == null ? null : value;
}

function payloadHash(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function descriptorMatches(descriptor, segment, hash) {
  return descriptor.sequenceNumber === segment.sequenceNumber &&
    descriptor.moreFollows === segment.moreFollows &&
    descriptor.contextKey === normalizedContextKey(segment.contextKey) &&
    descriptor.firstContextKey === normalizedContextKey(segment.firstContextKey) &&
    descriptor.payloadHash === hash;
}

class SegmentReceiver {
  constructor(options) {
    options = options || {};
    this._maxTransfers = positiveInteger(options.maxTransfers, DEFAULT_MAX_TRANSFERS, 'maxTransfers');
    this._maxTransfersPerPeer = positiveInteger(options.maxTransfersPerPeer, DEFAULT_MAX_TRANSFERS_PER_PEER, 'maxTransfersPerPeer');
    this._maxSegments = positiveInteger(options.maxSegments, DEFAULT_MAX_SEGMENTS, 'maxSegments');
    this._maxBytesPerTransfer = positiveInteger(options.maxBytesPerTransfer, DEFAULT_MAX_BYTES_PER_TRANSFER, 'maxBytesPerTransfer');
    this._maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 'maxTotalBytes');
    this._maxRequestTransfers = nonNegativeInteger(
      options.maxRequestTransfers,
      Math.max(0, this._maxTransfers - 1),
      'maxRequestTransfers'
    );
    this._maxRequestBytes = nonNegativeInteger(
      options.maxRequestBytes,
      Math.max(0, this._maxTotalBytes - this._maxBytesPerTransfer),
      'maxRequestBytes'
    );
    if (this._maxRequestTransfers > this._maxTransfers ||
        this._maxRequestBytes > this._maxTotalBytes) {
      throw new TypeError('request limits must not exceed global limits');
    }
    this._idleTimeout = positiveInteger(options.idleTimeout, DEFAULT_IDLE_TIMEOUT, 'idleTimeout');
    this._absoluteTimeout = positiveInteger(options.absoluteTimeout, DEFAULT_ABSOLUTE_TIMEOUT, 'absoluteTimeout');
    this._completedRetentionTimeout = positiveInteger(
      options.completedRetentionTimeout,
      this._idleTimeout,
      'completedRetentionTimeout'
    );
    this._maxCompletedTransfers = positiveInteger(
      options.maxCompletedTransfers,
      this._maxTransfers,
      'maxCompletedTransfers'
    );
    this._maxCompletedTransfersPerPeer = positiveInteger(
      options.maxCompletedTransfersPerPeer,
      this._maxTransfersPerPeer,
      'maxCompletedTransfersPerPeer'
    );
    this._maxCompletedRequestTransfers = nonNegativeInteger(
      options.maxCompletedRequestTransfers,
      Math.max(0, this._maxCompletedTransfers - 1),
      'maxCompletedRequestTransfers'
    );
    if (this._maxCompletedRequestTransfers > this._maxCompletedTransfers) {
      throw new TypeError('completed request limit must not exceed global limit');
    }
    if (this._idleTimeout > MAX_TIMER_DELAY || this._absoluteTimeout > MAX_TIMER_DELAY ||
        this._completedRetentionTimeout > MAX_TIMER_DELAY) {
      throw new TypeError('timeouts must not exceed the native timer limit');
    }
    this._now = options.now || Date.now;
    this._setTimeout = options.setTimeout || setTimeout;
    this._clearTimeout = options.clearTimeout || clearTimeout;
    this._onExpire = options.onExpire || (() => {});
    this._transfers = new Map();
    this._peerCounts = new Map();
    this._completed = new Map();
    this._completedAliases = new Map();
    this._completedPeerCounts = new Map();
    this._completedRequestTransfers = 0;
    this._totalBytes = 0;
    this._requestTransfers = 0;
    this._requestBytes = 0;
  }

  accept(segment) {
    const validation = this._validateSegment(segment);
    if (validation) return validation;

    const key = transferKey(segment.direction, segment.peerKey, segment.invokeId);
    let transfer = this._transfers.get(key);

    if (!transfer) {
      const completed = this._completed.get(key) ||
        this._completed.get(this._completedAliases.get(key));
      if (completed) {
        const replay = this._completedReplay(completed, segment);
        if (replay) return replay;
        if (segment.sequenceNumber === 0) this._removeCompleted(key);
      }
      if (segment.sequenceNumber !== 0) {
        return invalid('SEQUENCE_START_REQUIRED', {
          negativeAck: true,
          expectedSequenceNumber: 0,
          sequenceNumber: 0,
          windowSize: segment.windowSize
        });
      }
      const capacityError = this._capacityError(segment);
      if (capacityError) return capacityError;
      transfer = this._createTransfer(key, segment);
    } else {
      const invariantError = this._checkInvariants(transfer, segment);
      if (invariantError) {
        this._removeTransfer(key);
        return invariantError;
      }
      if (this._isDuplicate(transfer, segment.sequenceNumber)) {
        this._refreshIdleTimer(transfer);
        transfer.duplicateCount++;
        if (transfer.duplicateCount > transfer.actualWindowSize) {
          transfer.duplicateCount = 0;
          transfer.initialSequenceNumber = transfer.lastSequenceNumber;
          return {
            status: 'duplicate-limit',
            reason: 'DUPLICATE_LIMIT',
            ack: false,
            negativeAck: true,
            sequenceNumber: transfer.lastSequenceNumber,
            expectedSequenceNumber: transfer.expectedSequenceNumber,
            windowSize: transfer.actualWindowSize,
            absoluteDeadline: transfer.absoluteDeadline
          };
        }
        return {
          status: 'duplicate',
          ack: false,
          negativeAck: false,
          sequenceNumber: transfer.lastSequenceNumber,
          expectedSequenceNumber: transfer.expectedSequenceNumber,
          windowSize: transfer.actualWindowSize,
          duplicateCount: transfer.duplicateCount,
          absoluteDeadline: transfer.absoluteDeadline
        };
      }
      if (segment.sequenceNumber !== transfer.expectedSequenceNumber) {
        this._refreshIdleTimer(transfer);
        transfer.duplicateCount = 0;
        transfer.initialSequenceNumber = transfer.lastSequenceNumber;
        return {
          status: 'out-of-order',
          reason: 'UNEXPECTED_SEQUENCE_NUMBER',
          negativeAck: true,
          sequenceNumber: transfer.lastSequenceNumber,
          expectedSequenceNumber: transfer.expectedSequenceNumber,
          windowSize: transfer.actualWindowSize,
          absoluteDeadline: transfer.absoluteDeadline
        };
      }
    }

    const limitError = this._append(transfer, segment);
    if (limitError) {
      this._removeTransfer(key);
      return limitError;
    }

    transfer.lastSequenceNumber = segment.sequenceNumber;
    transfer.expectedSequenceNumber = (segment.sequenceNumber + 1) & 0xFF;
    transfer.duplicateCount = 0;
    transfer.updatedAt = this._now();
    this._refreshIdleTimer(transfer);

    const firstSegment = transfer.segmentCount === 1;
    const windowBoundary = !firstSegment && segment.sequenceNumber ===
      ((transfer.initialSequenceNumber + transfer.actualWindowSize) & 0xFF);
    const shouldAck = firstSegment || !segment.moreFollows || windowBoundary;
    if (windowBoundary && segment.moreFollows) {
      transfer.initialSequenceNumber = segment.sequenceNumber;
    }
    transfer.descriptors.push(Object.freeze({
      ack: shouldAck,
      contextKey: normalizedContextKey(segment.contextKey),
      firstContextKey: normalizedContextKey(segment.firstContextKey),
      moreFollows: segment.moreFollows,
      payloadHash: payloadHash(segment.payload),
      sequenceNumber: segment.sequenceNumber
    }));
    if (shouldAck && segment.moreFollows) {
      transfer.replayWindowStartIndex = transfer.descriptors.length;
    }

    if (!segment.moreFollows) {
      const payload = Buffer.concat(transfer.chunks, transfer.bytes);
      const result = {
        status: 'complete',
        ack: true,
        negativeAck: false,
        sequenceNumber: transfer.lastSequenceNumber,
        expectedSequenceNumber: transfer.expectedSequenceNumber,
        windowSize: transfer.actualWindowSize,
        direction: transfer.direction,
        peerKey: transfer.peerKey,
        invokeId: transfer.invokeId,
        type: transfer.type,
        service: transfer.service,
        segmentCount: transfer.segmentCount,
        payload: payload,
        context: transfer.context,
        contextIds: Object.freeze(transfer.contextIds.slice()),
        absoluteDeadline: transfer.absoluteDeadline
      };
      this._rememberCompleted(transfer);
      this._removeTransfer(key);
      return result;
    }

    return {
      status: 'pending',
      ack: shouldAck,
      negativeAck: false,
      sequenceNumber: transfer.lastSequenceNumber,
      expectedSequenceNumber: transfer.expectedSequenceNumber,
      windowSize: transfer.actualWindowSize,
      segmentCount: transfer.segmentCount,
      bytes: transfer.bytes,
      absoluteDeadline: transfer.absoluteDeadline
    };
  }

  replay(segment) {
    const validation = this._validateSegment(segment);
    if (validation) return null;
    const key = transferKey(segment.direction, segment.peerKey, segment.invokeId);
    const completed = this._completed.get(key) ||
      this._completed.get(this._completedAliases.get(key));
    return completed ? this._completedReplay(completed, segment) : null;
  }

  cancel(direction, peerKey, invokeId) {
    return this._removeTransfer(transferKey(direction, peerKey, invokeId));
  }

  discard(direction, peerKey, invokeId) {
    const key = transferKey(direction, peerKey, invokeId);
    const active = this._removeTransfer(key);
    const completed = this._removeCompleted(key);
    return active || completed;
  }

  forgetCompleted(direction, peerKey, invokeId) {
    return this._removeCompleted(transferKey(direction, peerKey, invokeId));
  }

  cancelAll() {
    Array.from(this._transfers.keys()).forEach((key) => this._removeTransfer(key));
    Array.from(this._completed.keys()).forEach((key) => this._removeCompleted(key));
  }

  get size() {
    return this._transfers.size;
  }

  get totalBytes() {
    return this._totalBytes;
  }

  get completedSize() {
    return this._completed.size;
  }

  get requestSize() {
    return this._requestTransfers;
  }

  get requestBytes() {
    return this._requestBytes;
  }

  _validateSegment(segment) {
    if (!segment || typeof segment !== 'object') return invalid('INVALID_SEGMENT');
    if (segment.direction !== 'request' && segment.direction !== 'response') return invalid('INVALID_DIRECTION');
    if (typeof segment.peerKey !== 'string' || segment.peerKey.length === 0) return invalid('INVALID_PEER');
    if (!Number.isInteger(segment.invokeId) || segment.invokeId < 0 || segment.invokeId > 0xFF) return invalid('INVALID_INVOKE_ID');
    if (!Number.isInteger(segment.type) || segment.type < 0 || segment.type > 0xFF) return invalid('INVALID_PDU_TYPE');
    if (!Number.isInteger(segment.service) || segment.service < 0 || segment.service > 0xFF) return invalid('INVALID_SERVICE');
    if (!Number.isInteger(segment.sequenceNumber) || segment.sequenceNumber < 0 || segment.sequenceNumber > 0xFF) return invalid('INVALID_SEQUENCE_NUMBER');
    if (!Number.isInteger(segment.windowSize) || segment.windowSize < 1 || segment.windowSize > 0x7F) return invalid('INVALID_WINDOW_SIZE');
    if (typeof segment.moreFollows !== 'boolean') return invalid('INVALID_MORE_FOLLOWS');
    if (!Buffer.isBuffer(segment.payload)) return invalid('INVALID_PAYLOAD');
    if (segment.contextKey != null && typeof segment.contextKey !== 'string') return invalid('INVALID_CONTEXT_KEY');
    if (segment.firstContextKey != null && typeof segment.firstContextKey !== 'string') {
      return invalid('INVALID_FIRST_CONTEXT_KEY');
    }
    if (segment.replayPeerKey != null &&
        (typeof segment.replayPeerKey !== 'string' || segment.replayPeerKey.length === 0)) {
      return invalid('INVALID_REPLAY_PEER');
    }
    if (segment.contextId != null &&
        !(typeof segment.contextId === 'string' || Number.isSafeInteger(segment.contextId))) {
      return invalid('INVALID_CONTEXT_ID');
    }
    try {
      optionalPositiveInteger(segment.segmentLimit, 'segmentLimit');
      optionalPositiveInteger(segment.byteLimit, 'byteLimit');
      optionalPositiveInteger(segment.segmentByteLimit, 'segmentByteLimit');
    } catch {
      return invalid('INVALID_TRANSFER_LIMIT');
    }
  }

  _capacityError(segment) {
    if (segment.direction === 'request' &&
        this._requestTransfers >= this._maxRequestTransfers) {
      return invalid('REQUEST_TRANSFER_LIMIT', {abort: true});
    }
    if (this._transfers.size >= this._maxTransfers) {
      return invalid('TRANSFER_LIMIT', {abort: true});
    }
    const peerKey = peerTransferKey(segment.direction, segment.peerKey);
    if ((this._peerCounts.get(peerKey) || 0) >= this._maxTransfersPerPeer) {
      return invalid('PEER_TRANSFER_LIMIT', {abort: true});
    }
    return null;
  }

  _createTransfer(key, segment) {
    const now = this._now();
    if (!Number.isSafeInteger(now) || now < 0 ||
        now > Number.MAX_SAFE_INTEGER - this._absoluteTimeout) {
      throw new TypeError('now must be a non-negative safe integer');
    }
    const transfer = {
      key: key,
      direction: segment.direction,
      peerKey: segment.peerKey,
      invokeId: segment.invokeId,
      type: segment.type,
      service: segment.service,
      actualWindowSize: segment.windowSize,
      initialSequenceNumber: 0,
      lastSequenceNumber: null,
      expectedSequenceNumber: 0,
      duplicateCount: 0,
      segmentCount: 0,
      chunks: [],
      descriptors: [],
      replayWindowStartIndex: 0,
      bytes: 0,
      segmentLimit: Math.min(
        this._maxSegments,
        optionalPositiveInteger(segment.segmentLimit, 'segmentLimit') || this._maxSegments
      ),
      byteLimit: Math.min(
        this._maxBytesPerTransfer,
        optionalPositiveInteger(segment.byteLimit, 'byteLimit') || this._maxBytesPerTransfer
      ),
      segmentByteLimit: optionalPositiveInteger(segment.segmentByteLimit, 'segmentByteLimit'),
      createdAt: now,
      updatedAt: now,
      absoluteDeadline: now + this._absoluteTimeout,
      context: segment.context,
      contextKey: segment.contextKey == null ? null : segment.contextKey,
      firstContextKey: segment.firstContextKey == null ? null : segment.firstContextKey,
      contextIds: [],
      replayAliasKey: segment.replayPeerKey && segment.replayPeerKey !== segment.peerKey ?
        transferKey(segment.direction, segment.replayPeerKey, segment.invokeId) : null,
      idleTimer: null,
      absoluteTimer: null
    };
    const peerKey = peerTransferKey(segment.direction, segment.peerKey);
    this._transfers.set(key, transfer);
    if (segment.direction === 'request') this._requestTransfers++;
    this._peerCounts.set(peerKey, (this._peerCounts.get(peerKey) || 0) + 1);
    transfer.absoluteTimer = this._setTimeout(
      () => this._expire(key, 'ABSOLUTE_TIMEOUT'),
      this._absoluteTimeout
    );
    if (transfer.absoluteTimer && transfer.absoluteTimer.unref) transfer.absoluteTimer.unref();
    return transfer;
  }

  _checkInvariants(transfer, segment) {
    if (segment.type !== transfer.type || segment.service !== transfer.service) {
      return invalid('TRANSFER_MISMATCH', {abort: true});
    }
    const firstContextKey = normalizedContextKey(segment.firstContextKey);
    const retransmittedFirstSegment = segment.sequenceNumber === 0 &&
      segment.sequenceNumber !== transfer.expectedSequenceNumber;
    const firstContextMismatch = retransmittedFirstSegment ?
      firstContextKey !== transfer.firstContextKey : firstContextKey != null;
    if (normalizedContextKey(segment.contextKey) !== transfer.contextKey ||
        firstContextMismatch) {
      return invalid('INCONSISTENT_ATTRIBUTES', {abort: true});
    }
    if (segment.windowSize !== transfer.actualWindowSize) {
      return invalid('WINDOW_SIZE_CHANGED', {abort: true});
    }
    const segmentLimit = optionalPositiveInteger(segment.segmentLimit, 'segmentLimit');
    const byteLimit = optionalPositiveInteger(segment.byteLimit, 'byteLimit');
    const segmentByteLimit = optionalPositiveInteger(segment.segmentByteLimit, 'segmentByteLimit');
    if ((segmentLimit != null && Math.min(this._maxSegments, segmentLimit) !== transfer.segmentLimit) ||
        (byteLimit != null && Math.min(this._maxBytesPerTransfer, byteLimit) !== transfer.byteLimit) ||
        segmentByteLimit !== transfer.segmentByteLimit) {
      return invalid('TRANSFER_MISMATCH', {abort: true});
    }
    return null;
  }

  _append(transfer, segment) {
    const payload = segment.payload;
    const contextId = segment.contextId;
    const bytes = transfer.bytes + payload.length;
    const totalBytes = this._totalBytes + payload.length;
    const requestBytes = transfer.direction === 'request' ?
      this._requestBytes + payload.length : this._requestBytes;
    const segmentCount = transfer.segmentCount + 1;
    if (segmentCount > transfer.segmentLimit) return invalid('SEGMENT_LIMIT', {abort: true});
    if (bytes > transfer.byteLimit) return invalid('TRANSFER_BYTE_LIMIT', {abort: true});
    if (transfer.segmentByteLimit != null && payload.length > transfer.segmentByteLimit) {
      return invalid('SEGMENT_BYTE_LIMIT', {abort: true});
    }
    if (totalBytes > this._maxTotalBytes) return invalid('TOTAL_BYTE_LIMIT', {abort: true});
    if (requestBytes > this._maxRequestBytes) {
      return invalid('REQUEST_BYTE_LIMIT', {abort: true});
    }
    transfer.chunks.push(Buffer.from(payload));
    if (contextId != null) transfer.contextIds.push(contextId);
    transfer.bytes = bytes;
    transfer.segmentCount = segmentCount;
    this._totalBytes = totalBytes;
    this._requestBytes = requestBytes;
    return null;
  }

  _refreshIdleTimer(transfer) {
    if (transfer.idleTimer) this._clearTimeout(transfer.idleTimer);
    transfer.idleTimer = this._setTimeout(() => this._expire(transfer.key, 'IDLE_TIMEOUT'), this._idleTimeout);
    if (transfer.idleTimer && transfer.idleTimer.unref) transfer.idleTimer.unref();
  }

  _expire(key, reason) {
    const transfer = this._transfers.get(key);
    if (!transfer) return;
    const event = {
      reason: reason,
      direction: transfer.direction,
      peerKey: transfer.peerKey,
      invokeId: transfer.invokeId,
      type: transfer.type,
      service: transfer.service,
      sequenceNumber: transfer.lastSequenceNumber,
      windowSize: transfer.actualWindowSize,
      context: transfer.context
    };
    this._removeTransfer(key);
    this._onExpire(event);
  }

  _removeTransfer(key) {
    const transfer = this._transfers.get(key);
    if (!transfer) return false;
    this._transfers.delete(key);
    if (transfer.idleTimer) this._clearTimeout(transfer.idleTimer);
    if (transfer.absoluteTimer) this._clearTimeout(transfer.absoluteTimer);
    this._totalBytes -= transfer.bytes;
    if (transfer.direction === 'request') {
      this._requestTransfers--;
      this._requestBytes -= transfer.bytes;
    }
    const peerKey = peerTransferKey(transfer.direction, transfer.peerKey);
    const count = (this._peerCounts.get(peerKey) || 1) - 1;
    if (count === 0) this._peerCounts.delete(peerKey);
    else this._peerCounts.set(peerKey, count);
    return true;
  }

  _isDuplicate(transfer, sequenceNumber) {
    if (transfer.lastSequenceNumber == null) return false;
    if (transfer.initialSequenceNumber === transfer.lastSequenceNumber) return false;
    const acceptedDistance =
      (transfer.lastSequenceNumber - transfer.initialSequenceNumber) & 0xFF;
    const sequenceDistance =
      (sequenceNumber - transfer.initialSequenceNumber) & 0xFF;
    return sequenceDistance > 0 && sequenceDistance <= acceptedDistance;
  }

  _completedReplay(completed, segment) {
    const now = this._now();
    if (Number.isSafeInteger(now) && now >= completed.expiresAt) {
      this._removeCompleted(completed.key);
      return null;
    }
    if (segment.type !== completed.type || segment.service !== completed.service ||
        segment.windowSize !== completed.actualWindowSize) return null;
    const hash = payloadHash(segment.payload);
    const descriptor = completed.descriptors.find((candidate) =>
      descriptorMatches(candidate, segment, hash)
    );
    if (!descriptor) return null;
    return {
      status: 'replay',
      ack: descriptor.ack,
      negativeAck: false,
      sequenceNumber: descriptor.sequenceNumber,
      expectedSequenceNumber: (completed.lastSequenceNumber + 1) & 0xFF,
      windowSize: completed.actualWindowSize,
      absoluteDeadline: completed.expiresAt,
      address: completed.address
    };
  }

  _rememberCompleted(transfer) {
    this._removeCompleted(transfer.key);
    if (transfer.direction === 'request' && this._maxCompletedRequestTransfers === 0) {
      return false;
    }
    const peerKey = peerTransferKey(transfer.direction, transfer.peerKey);
    while ((this._completedPeerCounts.get(peerKey) || 0) >=
        this._maxCompletedTransfersPerPeer) {
      const oldest = Array.from(this._completed.values()).find((completed) =>
        completed.peerCountKey === peerKey
      );
      if (!oldest) break;
      this._removeCompleted(oldest.key);
    }
    if (transfer.direction === 'request') {
      while (this._completedRequestTransfers >= this._maxCompletedRequestTransfers) {
        const oldestRequest = Array.from(this._completed.values()).find((completed) =>
          completed.direction === 'request'
        );
        if (!oldestRequest) break;
        this._removeCompleted(oldestRequest.key);
      }
    }
    while (this._completed.size >= this._maxCompletedTransfers) {
      const oldestRequest = Array.from(this._completed.values()).find((completed) =>
        completed.direction === 'request'
      );
      const oldestKey = oldestRequest ?
        oldestRequest.key : this._completed.keys().next().value;
      if (oldestKey == null) break;
      this._removeCompleted(oldestKey);
    }

    const now = this._now();
    if (!Number.isSafeInteger(now) || now < 0 ||
        now > Number.MAX_SAFE_INTEGER - this._completedRetentionTimeout) return false;
    const completed = {
      key: transfer.key,
      peerCountKey: peerKey,
      direction: transfer.direction,
      type: transfer.type,
      service: transfer.service,
      actualWindowSize: transfer.actualWindowSize,
      lastSequenceNumber: transfer.lastSequenceNumber,
      descriptors: Object.freeze(
        transfer.descriptors.slice(transfer.replayWindowStartIndex)
      ),
      address: transfer.context && transfer.context.address,
      aliasKey: transfer.replayAliasKey,
      expiresAt: now + this._completedRetentionTimeout,
      timer: null
    };
    this._completed.set(completed.key, completed);
    if (completed.aliasKey) this._completedAliases.set(completed.aliasKey, completed.key);
    this._completedPeerCounts.set(peerKey, (this._completedPeerCounts.get(peerKey) || 0) + 1);
    if (completed.direction === 'request') this._completedRequestTransfers++;
    try {
      completed.timer = this._setTimeout(
        () => this._removeCompleted(completed.key),
        this._completedRetentionTimeout
      );
    } catch {
      this._removeCompleted(completed.key);
      return false;
    }
    if (completed.timer && completed.timer.unref) completed.timer.unref();
  }

  _removeCompleted(key) {
    const primaryKey = this._completedAliases.get(key);
    if (!this._completed.has(key) && primaryKey) key = primaryKey;
    const completed = this._completed.get(key);
    if (!completed) return false;
    this._completed.delete(key);
    if (completed.aliasKey && this._completedAliases.get(completed.aliasKey) === key) {
      this._completedAliases.delete(completed.aliasKey);
    }
    if (completed.timer) {
      try {
        this._clearTimeout(completed.timer);
      } catch {
        // Bounded map cleanup must not depend on an injected timer adapter.
      }
    }
    const count = (this._completedPeerCounts.get(completed.peerCountKey) || 1) - 1;
    if (count === 0) this._completedPeerCounts.delete(completed.peerCountKey);
    else this._completedPeerCounts.set(completed.peerCountKey, count);
    if (completed.direction === 'request') this._completedRequestTransfers--;
    return true;
  }
}

module.exports = SegmentReceiver;
