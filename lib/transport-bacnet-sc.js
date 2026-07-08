'use strict';

const crypto = require('crypto');
const EventEmitter = require('events').EventEmitter;
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const url = require('url');

const baBvlc = require('./bvlc');
const baEnum = require('./enum');
const baScMessage = require('./bacnet-sc/message');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_OPCODE_CLOSE = 0x08;
const WS_OPCODE_PING = 0x09;
const WS_OPCODE_PONG = 0x0A;
const WS_OPCODE_BINARY = 0x02;
const SUBPROTOCOL_HUB = 'hub.bsc.bacnet.org';

function readConfigValue(value) {
  if (!value || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(readConfigValue);
  if (typeof value !== 'string') return value;
  if (value.indexOf('-----BEGIN ') === 0) return value;
  return fs.readFileSync(value);
}

function makeError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeHubUrls(settings) {
  const urls = [];
  function add(value) {
    asArray(value).forEach((item) => {
      if (item && urls.indexOf(item) === -1) urls.push(item);
    });
  }

  add(settings.hubUrls);
  add(settings.hubs);
  add(settings.hubUrl || settings.primaryHubUrl);
  add(settings.failoverHubUrl);
  return urls;
}

function hostHeader(parsed) {
  const host = net.isIP(parsed.hostname) === 6 ? '[' + parsed.hostname + ']' : parsed.hostname;
  return host + (parsed.port ? ':' + parsed.port : '');
}

function removeUndefinedOptions(options) {
  Object.keys(options).forEach((key) => {
    if (options[key] === undefined) delete options[key];
  });
  return options;
}

function websocketAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

class BacnetScTransport extends EventEmitter {
  constructor(settings) {
    super();
    settings = settings || {};

    this._settings = {
      hubUrl: settings.hubUrl || settings.primaryHubUrl,
      failoverHubUrl: settings.failoverHubUrl,
      cert: settings.cert,
      key: settings.key,
      pfx: settings.pfx,
      ca: settings.ca,
      passphrase: settings.passphrase,
      rejectUnauthorized: settings.rejectUnauthorized !== false,
      requireClientCertificate: settings.requireClientCertificate !== false,
      emitTransientErrors: settings.emitTransientErrors === true,
      servername: settings.servername,
      tlsOptions: settings.tlsOptions || {},
      tlsVersion: settings.tlsVersion,
      tlsMinVersion: settings.tlsMinVersion || settings.minVersion,
      tlsMaxVersion: settings.tlsMaxVersion || settings.maxVersion,
      allowPlain: settings.allowPlain || false,
      vmac: settings.vmac || baScMessage.makeRandomVmac(),
      uuid: settings.uuid || baScMessage.randomUuid(),
      maxBvlc: settings.maxBvlc || settings.maxBVLC || 1600,
      maxNpdu: settings.maxNpdu || settings.maxNPDU || 1497,
      connectionWaitTimeout: settings.connectionWaitTimeout || settings.connectTimeout || 10000,
      webSocketWaitTimeout: settings.webSocketWaitTimeout || settings.websocketWaitTimeout || 30000,
      heartbeatInterval: settings.heartbeatInterval || 30000,
      disconnectTimeout: settings.disconnectTimeout || 1000,
      reconnect: settings.reconnect !== false,
      reconnectMin: settings.reconnectMin || 1000,
      reconnectMax: settings.reconnectMax || 30000,
      sendQueueLimit: settings.sendQueueLimit || 100
    };

    this._socket = null;
    this._state = 'idle';
    this._manualClose = false;
    this._connected = false;
    this._webSocketReady = false;
    this._handshakeBuffer = Buffer.alloc(0);
    this._frameBuffer = Buffer.alloc(0);
    this._pendingSends = [];
    this._messageId = 1;
    this._connectRequestId = 0;
    this._peer = null;
    this._lastDiagnostic = null;
    this._lastError = null;
    this._lastConnectedAt = null;
    this._lastDisconnectedAt = null;
    this._reconnectAttempts = 0;
    this._heartbeatTimer = null;
    this._connectionTimer = null;
    this._disconnectTimer = null;
    this._reconnectTimer = null;
    this._reconnectDelay = this._settings.reconnectMin;
    this._hubIndex = 0;
    this._hubs = normalizeHubUrls(settings);
  }

  getBroadcastAddress() {
    return baScMessage.BROADCAST_VMAC;
  }

  getMaxPayload() {
    return this._settings.maxNpdu;
  }

  getState() {
    return this._state;
  }

  getStatus() {
    return {
      state: this._state,
      connected: this._connected,
      webSocketReady: this._webSocketReady,
      hubUrl: this._hubs[this._hubIndex] || null,
      hubIndex: this._hubIndex,
      hubs: this._hubs.slice(),
      vmac: baScMessage.formatVmac(this._settings.vmac),
      uuid: this._settings.uuid,
      peer: this._peer,
      pendingSends: this._pendingSends.length,
      reconnectDelay: this._reconnectDelay,
      reconnectAttempts: this._reconnectAttempts,
      lastConnectedAt: this._lastConnectedAt,
      lastDisconnectedAt: this._lastDisconnectedAt,
      lastError: this._lastError,
      lastDiagnostic: this._lastDiagnostic
    };
  }

  open() {
    this._manualClose = false;
    if (this._socket || this._state !== 'idle') return;
    if (this._hubs.length === 0) {
      return this._emitError('BACNET_SC_NO_HUB_URL', 'BACnet/SC hubUrl is required');
    }
    this._connect(this._hubs[this._hubIndex]);
  }

  send(buffer, offset, receiver) {
    const payload = Buffer.from(buffer.slice(baEnum.BVLC_HEADER_LENGTH, offset));
    const item = {
      payload: payload,
      receiver: receiver
    };

    if (!this._connected) {
      if (this._pendingSends.length >= this._settings.sendQueueLimit) {
        this._emitError('BACNET_SC_SEND_QUEUE_FULL', 'BACnet/SC send queue is full');
        return;
      }
      this._pendingSends.push(item);
      this._emitDiagnostic('queued', 'Queued BACnet/SC NPDU until the hub connection is ready');
      return;
    }
    this._sendNpdu(item);
  }

  close() {
    this._manualClose = true;
    this._clearReconnectTimer();
    this._clearConnectionTimer();
    this._clearHeartbeatTimer();
    this._clearDisconnectTimer();

    if (this._connected) {
      this._state = 'disconnecting';
      this._sendScMessage(baScMessage.FUNCTIONS.DISCONNECT_REQUEST, {});
      this._startDisconnectTimer();
      return;
    }
    this._closeSocket();
  }

  _connect(hubUrl) {
    let parsed;
    let socket;
    let tlsOptions;

    this._state = 'connecting';
    this._peer = null;
    this._emitDiagnostic('connecting', 'Connecting to BACnet/SC hub', {hubUrl: hubUrl});

    try {
      parsed = url.parse(hubUrl);
      if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
        throw makeError('BACNET_SC_BAD_HUB_URL', 'BACnet/SC hubUrl must use ws:// or wss://');
      }
      if (parsed.protocol === 'ws:' && !this._settings.allowPlain) {
        throw makeError('BACNET_SC_PLAIN_WS_DISABLED', 'Plain BACnet/SC WebSocket connections are disabled');
      }
      if (parsed.protocol === 'wss:') {
        if (this._settings.requireClientCertificate && !this._settings.pfx && (!this._settings.cert || !this._settings.key)) {
          throw makeError('BACNET_SC_CLIENT_CERT_REQUIRED', 'BACnet/SC requires a client certificate and key');
        }
        tlsOptions = Object.assign({}, this._settings.tlsOptions, {
          host: parsed.hostname,
          port: Number(parsed.port || 443),
          servername: this._settings.servername || (net.isIP(parsed.hostname) ? undefined : parsed.hostname),
          cert: readConfigValue(this._settings.cert),
          key: readConfigValue(this._settings.key),
          pfx: readConfigValue(this._settings.pfx),
          ca: readConfigValue(this._settings.ca),
          passphrase: this._settings.passphrase,
          rejectUnauthorized: this._settings.rejectUnauthorized
        });
        if (this._settings.tlsVersion) {
          tlsOptions.minVersion = this._settings.tlsVersion;
          tlsOptions.maxVersion = this._settings.tlsVersion;
        }
        if (this._settings.tlsMinVersion) tlsOptions.minVersion = this._settings.tlsMinVersion;
        if (this._settings.tlsMaxVersion) tlsOptions.maxVersion = this._settings.tlsMaxVersion;
        tlsOptions = removeUndefinedOptions(tlsOptions);
        socket = tls.connect(tlsOptions, () => this._sendWebSocketHandshake(parsed));
      } else {
        socket = net.connect(Number(parsed.port || 80), parsed.hostname, () => this._sendWebSocketHandshake(parsed));
      }
    } catch (err) {
      return this._failConnection(err, err.code || 'BACNET_SC_CONNECT_SETUP_FAILED', {
        retryable: err.code !== 'BACNET_SC_BAD_HUB_URL' &&
          err.code !== 'BACNET_SC_PLAIN_WS_DISABLED' &&
          err.code !== 'BACNET_SC_CLIENT_CERT_REQUIRED'
      });
    }

    this._socket = socket;
    this._webSocketReady = false;
    this._connected = false;
    this._handshakeBuffer = Buffer.alloc(0);
    this._frameBuffer = Buffer.alloc(0);

    if (socket.setNoDelay) socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onSocketData(chunk));
    socket.on('error', (err) => this._failConnection(err, 'BACNET_SC_SOCKET_ERROR'));
    socket.on('close', () => this._onSocketClose());
    this._startConnectionTimer('BACNET_SC_WEBSOCKET_TIMEOUT', this._settings.webSocketWaitTimeout);
  }

  _sendWebSocketHandshake(parsed) {
    const key = crypto.randomBytes(16).toString('base64');
    const path = (parsed.path && parsed.path !== '') ? parsed.path : '/';
    const headers = [
      'GET ' + path + ' HTTP/1.1',
      'Host: ' + hostHeader(parsed),
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + key,
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Protocol: ' + SUBPROTOCOL_HUB,
      '\r\n'
    ];

    this._expectedAccept = websocketAccept(key);
    this._socket.write(headers.join('\r\n'));
  }

  _onSocketData(chunk) {
    if (!this._webSocketReady) return this._readHandshake(chunk);
    this._frameBuffer = Buffer.concat([this._frameBuffer, chunk]);
    this._readFrames();
  }

  _readHandshake(chunk) {
    const marker = '\r\n\r\n';
    let headerEnd;
    let headerText;
    let remaining;
    let lines;
    let status;
    const headers = {};

    this._handshakeBuffer = Buffer.concat([this._handshakeBuffer, chunk]);
    headerEnd = this._handshakeBuffer.indexOf(marker);
    if (headerEnd === -1) return;

    headerText = this._handshakeBuffer.slice(0, headerEnd).toString('utf8');
    remaining = this._handshakeBuffer.slice(headerEnd + marker.length);
    lines = headerText.split('\r\n');
    status = lines.shift();
    lines.forEach((line) => {
      const index = line.indexOf(':');
      if (index !== -1) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
    });

    if (!/^HTTP\/1\.[01] 101\b/.test(status || '')) {
      return this._failConnection(new Error('BACNET_SC_WEBSOCKET_REJECTED'), 'BACNET_SC_WEBSOCKET_REJECTED');
    }
    if (headers['sec-websocket-accept'] !== this._expectedAccept) {
      return this._failConnection(new Error('BACNET_SC_WEBSOCKET_ACCEPT_MISMATCH'), 'BACNET_SC_WEBSOCKET_ACCEPT_MISMATCH');
    }
    if (headers['sec-websocket-protocol'] && headers['sec-websocket-protocol'] !== SUBPROTOCOL_HUB) {
      return this._failConnection(new Error('BACNET_SC_WEBSOCKET_PROTOCOL_MISMATCH'), 'BACNET_SC_WEBSOCKET_PROTOCOL_MISMATCH');
    }

    this._webSocketReady = true;
    this._state = 'awaiting-accept';
    this._connectRequestId = this._nextMessageId();
    this._sendScMessage(baScMessage.FUNCTIONS.CONNECT_REQUEST, {
      id: this._connectRequestId,
      payload: baScMessage.encodeConnectPayload({
        vmac: this._settings.vmac,
        uuid: this._settings.uuid,
        maxBvlc: this._settings.maxBvlc,
        maxNpdu: this._settings.maxNpdu
      })
    });
    this._startConnectionTimer('BACNET_SC_CONNECT_TIMEOUT', this._settings.connectionWaitTimeout);
    this._emitDiagnostic('websocket-open', 'BACnet/SC WebSocket established');
    if (remaining.length > 0) this._onSocketData(remaining);
  }

  _readFrames() {
    while (this._frameBuffer.length >= 2) {
      let offset = 2;
      const first = this._frameBuffer[0];
      const second = this._frameBuffer[1];
      const opcode = first & 0x0F;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7F;
      let mask;
      let payload;

      if (length === 126) {
        if (this._frameBuffer.length < offset + 2) return;
        length = this._frameBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this._frameBuffer.length < offset + 8) return;
        if (this._frameBuffer.readUInt32BE(offset) !== 0) {
          this._emitError('BACNET_SC_FRAME_TOO_LARGE', 'BACnet/SC WebSocket frame is too large');
          return this._closeSocket();
        }
        length = this._frameBuffer.readUInt32BE(offset + 4);
        offset += 8;
      }
      if (masked) {
        if (this._frameBuffer.length < offset + 4) return;
        mask = this._frameBuffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (this._frameBuffer.length < offset + length) return;
      payload = Buffer.from(this._frameBuffer.slice(offset, offset + length));
      this._frameBuffer = this._frameBuffer.slice(offset + length);
      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this._handleFrame(opcode, payload);
    }
  }

  _handleFrame(opcode, payload) {
    if (opcode === WS_OPCODE_BINARY) return this._handleScMessage(payload);
    if (opcode === WS_OPCODE_PING) return this._writeFrame(WS_OPCODE_PONG, payload);
    if (opcode === WS_OPCODE_CLOSE) {
      this._writeFrame(WS_OPCODE_CLOSE, payload);
      return this._closeSocket();
    }
    if (opcode !== WS_OPCODE_PONG) {
      this._emitDiagnostic('unsupported-frame', 'Ignoring unsupported BACnet/SC WebSocket frame', {opcode: opcode});
    }
  }

  _handleScMessage(payload) {
    let message;
    let connect;
    let result;

    try {
      message = baScMessage.decode(payload);
    } catch (err) {
      return this._emitError('BACNET_SC_MALFORMED_MESSAGE', 'Malformed BACnet/SC message: ' + err.message);
    }

    switch (message.function) {
      case baScMessage.FUNCTIONS.CONNECT_ACCEPT:
        if (this._state !== 'awaiting-accept' || message.id !== this._connectRequestId) {
          return this._emitError('BACNET_SC_UNEXPECTED_CONNECT_ACCEPT', 'Unexpected BACnet/SC Connect-Accept');
        }
        try {
          connect = baScMessage.decodeConnectPayload(message.payload);
        } catch (err) {
          return this._emitError('BACNET_SC_MALFORMED_CONNECT_ACCEPT', err.message);
        }
        this._peer = connect;
        this._connected = true;
        this._state = 'connected';
        this._reconnectDelay = this._settings.reconnectMin;
        this._reconnectAttempts = 0;
        this._lastConnectedAt = new Date().toISOString();
        this._clearConnectionTimer();
        this._startHeartbeat();
        this._emitDiagnostic('connected', 'BACnet/SC hub connection accepted', connect);
        this.emit('open', connect);
        this._flushPendingSends();
        break;
      case baScMessage.FUNCTIONS.BVLC_RESULT:
        try {
          result = baScMessage.decodeBvlcResultPayload(message.payload);
        } catch (err) {
          return this._emitError('BACNET_SC_MALFORMED_BVLC_RESULT', err.message);
        }
        if (result.resultCode !== 0) {
          this._emitError('BACNET_SC_BVLC_RESULT_NAK', 'BACnet/SC BVLC-Result NAK', result);
        } else {
          this._emitDiagnostic('bvlc-result', 'BACnet/SC BVLC-Result ACK', result);
        }
        break;
      case baScMessage.FUNCTIONS.ENCAPSULATED_NPDU:
        this._emitNpdu(message);
        break;
      case baScMessage.FUNCTIONS.HEARTBEAT_REQUEST:
        this._sendScMessage(baScMessage.FUNCTIONS.HEARTBEAT_ACK, {id: message.id});
        break;
      case baScMessage.FUNCTIONS.HEARTBEAT_ACK:
        this._emitDiagnostic('heartbeat-ack', 'BACnet/SC heartbeat acknowledged');
        break;
      case baScMessage.FUNCTIONS.DISCONNECT_REQUEST:
        this._sendScMessage(baScMessage.FUNCTIONS.DISCONNECT_ACK, {id: message.id});
        this._closeSocket();
        break;
      case baScMessage.FUNCTIONS.DISCONNECT_ACK:
        this._clearDisconnectTimer();
        this._closeSocket();
        break;
      default:
        this._emitDiagnostic('unsupported-service', 'Ignoring unsupported BACnet/SC service', {function: message.function});
        break;
    }
  }

  _emitNpdu(message) {
    const func = message.destination === baScMessage.BROADCAST_VMAC ?
      baEnum.BvlcResultPurpose.ORIGINAL_BROADCAST_NPDU :
      baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU;
    const framed = Buffer.alloc(baEnum.BVLC_HEADER_LENGTH + message.payload.length);
    const remoteAddress = message.originating || (this._peer && this._peer.vmac) || 'bacnet-sc';

    baBvlc.encode(framed, func, framed.length);
    message.payload.copy(framed, baEnum.BVLC_HEADER_LENGTH);
    this.emit('message', framed, remoteAddress, 0);
  }

  _sendNpdu(item) {
    const destination = this._receiverToVmac(item.receiver);
    this._sendScMessage(baScMessage.FUNCTIONS.ENCAPSULATED_NPDU, {
      id: this._nextMessageId(),
      destination: destination,
      payload: item.payload
    });
  }

  _receiverToVmac(receiver) {
    if (!receiver) return baScMessage.BROADCAST_VMAC;
    if (typeof receiver === 'object') {
      if (receiver.vmac) return baScMessage.formatVmac(receiver.vmac);
      if (receiver.adr) return baScMessage.formatVmac(receiver.adr);
      if (receiver.ip) return baScMessage.formatVmac(receiver.ip);
    }
    if (String(receiver) === this.getBroadcastAddress()) return baScMessage.BROADCAST_VMAC;
    return baScMessage.formatVmac(receiver);
  }

  _sendScMessage(functionCode, options) {
    if (!this._socket || !this._webSocketReady && functionCode !== baScMessage.FUNCTIONS.CONNECT_REQUEST) return;
    const payload = baScMessage.encode(functionCode, options || {});
    this._writeFrame(WS_OPCODE_BINARY, payload);
  }

  _writeFrame(opcode, payload) {
    let header;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload || Buffer.alloc(0));

    if (!this._socket || this._socket.destroyed) return;
    if (masked.length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | masked.length;
    } else if (masked.length <= 0xFFFF) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(masked.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(masked.length, 6);
    }
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this._socket.write(Buffer.concat([header, mask, masked]));
  }

  _flushPendingSends() {
    const pending = this._pendingSends.slice();
    this._pendingSends = [];
    pending.forEach((item) => this._sendNpdu(item));
  }

  _nextMessageId() {
    const id = this._messageId++;
    if (this._messageId > 0xFFFF) this._messageId = 1;
    return id;
  }

  _startHeartbeat() {
    this._clearHeartbeatTimer();
    if (!this._settings.heartbeatInterval) return;
    this._heartbeatTimer = setInterval(() => {
      if (!this._connected) return;
      this._sendScMessage(baScMessage.FUNCTIONS.HEARTBEAT_REQUEST, {id: this._nextMessageId()});
    }, this._settings.heartbeatInterval);
  }

  _startConnectionTimer(code, timeout) {
    this._clearConnectionTimer();
    this._connectionTimer = setTimeout(() => {
      this._failConnection(new Error(code), code);
    }, timeout || this._settings.connectionWaitTimeout);
  }

  _startDisconnectTimer() {
    this._clearDisconnectTimer();
    this._disconnectTimer = setTimeout(() => {
      this._disconnectTimer = null;
      this._closeSocket();
    }, this._settings.disconnectTimeout);
  }

  _clearHeartbeatTimer() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  _clearConnectionTimer() {
    if (this._connectionTimer) clearTimeout(this._connectionTimer);
    this._connectionTimer = null;
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
  }

  _clearDisconnectTimer() {
    if (this._disconnectTimer) clearTimeout(this._disconnectTimer);
    this._disconnectTimer = null;
  }

  _failConnection(err, code, options) {
    let retryable;
    let hadSocket;
    let details;
    let message;

    options = options || {};
    code = code || err.code || 'BACNET_SC_CONNECTION_FAILED';
    message = err.message || String(err);
    details = {
      hubUrl: this._hubs[this._hubIndex],
      hubIndex: this._hubIndex,
      authorizationError: this._socket && this._socket.authorizationError
    };
    retryable = this._settings.reconnect && !this._manualClose;
    if (options.retryable === false) retryable = false;

    if (this._manualClose || this._state === 'disconnecting') {
      this._emitDiagnostic(code, message, details);
      this._closeSocket();
      return;
    }

    if (retryable && !this._settings.emitTransientErrors) {
      this._lastError = {
        code: code,
        message: message,
        details: details,
        timestamp: new Date().toISOString()
      };
      this._emitDiagnostic(code, message, details);
    } else {
      this._emitError(code, message, details);
    }

    hadSocket = !!this._socket;
    this._closeSocket();
    if (!hadSocket && retryable) this._scheduleReconnect(code);
  }

  _onSocketClose() {
    const wasConnected = this._connected;
    this._connected = false;
    this._webSocketReady = false;
    this._socket = null;
    this._peer = null;
    if (wasConnected) this._lastDisconnectedAt = new Date().toISOString();
    this._clearConnectionTimer();
    this._clearHeartbeatTimer();
    this._clearDisconnectTimer();

    if (this._manualClose || this._state === 'disconnecting') {
      this._state = 'idle';
      this.emit('close');
      return;
    }

    if (wasConnected) this.emit('close');
    this._scheduleReconnect('socket closed');
  }

  _closeSocket() {
    const socket = this._socket;
    if (!socket) return;
    this._socket = null;
    try {
      socket.end();
      socket.destroy();
    } catch (err) {
      this._emitDiagnostic('close-error', 'Error while closing BACnet/SC socket', {error: err.message});
    }
  }

  _scheduleReconnect(reason) {
    if (!this._settings.reconnect || this._manualClose) {
      this._state = 'idle';
      return;
    }
    this._state = 'reconnecting';
    this._hubIndex = (this._hubIndex + 1) % this._hubs.length;
    this._reconnectAttempts++;
    this.emit('reconnect', {
      attempt: this._reconnectAttempts,
      delay: this._reconnectDelay,
      reason: reason,
      hubUrl: this._hubs[this._hubIndex],
      hubIndex: this._hubIndex
    });
    this._emitDiagnostic('reconnect', 'Scheduling BACnet/SC reconnect', {
      attempt: this._reconnectAttempts,
      delay: this._reconnectDelay,
      reason: reason,
      hubUrl: this._hubs[this._hubIndex],
      hubIndex: this._hubIndex
    });
    this._clearReconnectTimer();
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect(this._hubs[this._hubIndex]);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._settings.reconnectMax);
    }, this._reconnectDelay);
  }

  _emitDiagnostic(code, message, details) {
    const event = {
      code: code,
      message: message,
      state: this._state,
      hubUrl: this._hubs[this._hubIndex] || null,
      hubIndex: this._hubIndex,
      timestamp: new Date().toISOString(),
      details: details || {}
    };
    this._lastDiagnostic = event;
    this.emit('diagnostic', event);
  }

  _emitError(code, message, details) {
    const err = new Error(message);
    err.code = code;
    err.details = details || {};
    this._lastError = {
      code: code,
      message: message,
      details: err.details,
      timestamp: new Date().toISOString()
    };
    this._emitDiagnostic(code, message, details);
    process.nextTick(() => this.emit('error', err));
  }
}

module.exports = BacnetScTransport;
