'use strict';

const DEFAULT_MAX_TRANSFERS = 32;
const DEFAULT_MAX_TRANSFERS_PER_PEER = 8;
const DEFAULT_MAX_SEGMENTS = 1024;
const DEFAULT_MAX_BYTES_PER_TRANSFER = 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT = 3000;
const DEFAULT_ABSOLUTE_TIMEOUT = 30000;

function positiveInteger(value, fallback, name) {
  value = value == null ? fallback : value;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(name + ' must be a positive integer');
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

class SegmentReceiver {
  constructor(options) {
    options = options || {};
    this._maxTransfers = positiveInteger(options.maxTransfers, DEFAULT_MAX_TRANSFERS, 'maxTransfers');
    this._maxTransfersPerPeer = positiveInteger(options.maxTransfersPerPeer, DEFAULT_MAX_TRANSFERS_PER_PEER, 'maxTransfersPerPeer');
    this._maxSegments = positiveInteger(options.maxSegments, DEFAULT_MAX_SEGMENTS, 'maxSegments');
    this._maxBytesPerTransfer = positiveInteger(options.maxBytesPerTransfer, DEFAULT_MAX_BYTES_PER_TRANSFER, 'maxBytesPerTransfer');
    this._maxTotalBytes = positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 'maxTotalBytes');
    this._idleTimeout = positiveInteger(options.idleTimeout, DEFAULT_IDLE_TIMEOUT, 'idleTimeout');
    this._absoluteTimeout = positiveInteger(options.absoluteTimeout, DEFAULT_ABSOLUTE_TIMEOUT, 'absoluteTimeout');
    this._now = options.now || Date.now;
    this._setTimeout = options.setTimeout || setTimeout;
    this._clearTimeout = options.clearTimeout || clearTimeout;
    this._onExpire = options.onExpire || (() => {});
    this._transfers = new Map();
    this._peerCounts = new Map();
    this._totalBytes = 0;
  }

  accept(segment) {
    const validation = this._validateSegment(segment);
    if (validation) return validation;

    const key = transferKey(segment.direction, segment.peerKey, segment.invokeId);
    let transfer = this._transfers.get(key);

    if (!transfer) {
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
      if (segment.sequenceNumber === transfer.lastSequenceNumber) {
        this._refreshIdleTimer(transfer);
        return {
          status: 'duplicate',
          ack: true,
          negativeAck: false,
          sequenceNumber: transfer.lastSequenceNumber,
          expectedSequenceNumber: transfer.expectedSequenceNumber,
          windowSize: transfer.windowSize
        };
      }
      if (segment.sequenceNumber !== transfer.expectedSequenceNumber) {
        return {
          status: 'out-of-order',
          reason: 'UNEXPECTED_SEQUENCE_NUMBER',
          negativeAck: true,
          sequenceNumber: transfer.lastSequenceNumber,
          expectedSequenceNumber: transfer.expectedSequenceNumber,
          windowSize: transfer.windowSize
        };
      }
    }

    const limitError = this._append(transfer, segment.payload);
    if (limitError) {
      this._removeTransfer(key);
      return limitError;
    }

    transfer.lastSequenceNumber = segment.sequenceNumber;
    transfer.expectedSequenceNumber = (segment.sequenceNumber + 1) & 0xFF;
    transfer.segmentsSinceAck++;
    transfer.updatedAt = this._now();
    this._refreshIdleTimer(transfer);

    if (!segment.moreFollows) {
      const payload = Buffer.concat(transfer.chunks, transfer.bytes);
      const result = {
        status: 'complete',
        ack: true,
        negativeAck: false,
        sequenceNumber: transfer.lastSequenceNumber,
        expectedSequenceNumber: transfer.expectedSequenceNumber,
        windowSize: transfer.windowSize,
        direction: transfer.direction,
        peerKey: transfer.peerKey,
        invokeId: transfer.invokeId,
        type: transfer.type,
        service: transfer.service,
        segmentCount: transfer.segmentCount,
        payload: payload,
        context: transfer.context
      };
      this._removeTransfer(key);
      return result;
    }

    const shouldAck = transfer.segmentsSinceAck >= transfer.windowSize;
    if (shouldAck) transfer.segmentsSinceAck = 0;
    return {
      status: 'pending',
      ack: shouldAck,
      negativeAck: false,
      sequenceNumber: transfer.lastSequenceNumber,
      expectedSequenceNumber: transfer.expectedSequenceNumber,
      windowSize: transfer.windowSize,
      segmentCount: transfer.segmentCount,
      bytes: transfer.bytes
    };
  }

  cancel(direction, peerKey, invokeId) {
    return this._removeTransfer(transferKey(direction, peerKey, invokeId));
  }

  cancelAll() {
    Array.from(this._transfers.keys()).forEach((key) => this._removeTransfer(key));
  }

  get size() {
    return this._transfers.size;
  }

  get totalBytes() {
    return this._totalBytes;
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
  }

  _capacityError(segment) {
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
    const transfer = {
      key: key,
      direction: segment.direction,
      peerKey: segment.peerKey,
      invokeId: segment.invokeId,
      type: segment.type,
      service: segment.service,
      windowSize: segment.windowSize,
      lastSequenceNumber: null,
      expectedSequenceNumber: 0,
      segmentsSinceAck: 0,
      segmentCount: 0,
      chunks: [],
      bytes: 0,
      createdAt: now,
      updatedAt: now,
      context: segment.context,
      idleTimer: null,
      absoluteTimer: null
    };
    const peerKey = peerTransferKey(segment.direction, segment.peerKey);
    this._transfers.set(key, transfer);
    this._peerCounts.set(peerKey, (this._peerCounts.get(peerKey) || 0) + 1);
    transfer.absoluteTimer = this._setTimeout(() => this._expire(key, 'ABSOLUTE_TIMEOUT'), this._absoluteTimeout);
    if (transfer.absoluteTimer && transfer.absoluteTimer.unref) transfer.absoluteTimer.unref();
    return transfer;
  }

  _checkInvariants(transfer, segment) {
    if (segment.type !== transfer.type || segment.service !== transfer.service) {
      return invalid('TRANSFER_MISMATCH', {abort: true});
    }
    if (segment.windowSize !== transfer.windowSize) {
      return invalid('WINDOW_SIZE_CHANGED', {abort: true});
    }
    return null;
  }

  _append(transfer, payload) {
    const bytes = transfer.bytes + payload.length;
    const totalBytes = this._totalBytes + payload.length;
    const segmentCount = transfer.segmentCount + 1;
    if (segmentCount > this._maxSegments) return invalid('SEGMENT_LIMIT', {abort: true});
    if (bytes > this._maxBytesPerTransfer) return invalid('TRANSFER_BYTE_LIMIT', {abort: true});
    if (totalBytes > this._maxTotalBytes) return invalid('TOTAL_BYTE_LIMIT', {abort: true});
    transfer.chunks.push(Buffer.from(payload));
    transfer.bytes = bytes;
    transfer.segmentCount = segmentCount;
    this._totalBytes = totalBytes;
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
      windowSize: transfer.windowSize,
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
    const peerKey = peerTransferKey(transfer.direction, transfer.peerKey);
    const count = (this._peerCounts.get(peerKey) || 1) - 1;
    if (count === 0) this._peerCounts.delete(peerKey);
    else this._peerCounts.set(peerKey, count);
    return true;
  }
}

module.exports = SegmentReceiver;
