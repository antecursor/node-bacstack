'use strict';

const EventEmitter = require('events').EventEmitter;
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const WebSocket = require('ws');

const baBvlc = require('./bvlc');
const baEnum = require('./enum');
const baScMessage = require('./bacnet-sc/message');

const SUBPROTOCOL_HUB = 'hub.bsc.bacnet.org';
const DEFAULT_HANDSHAKE_LIMIT = 16 * 1024;
const DEFAULT_BUFFER_LIMIT = 64 * 1024;
const DEFAULT_MAX_BVLC = 5705;
const MAX_TIMER_DELAY = 0x7FFFFFFF;
const MAX_RECONNECT_DELAY = 600000;
const MAX_BVLC_LENGTH = 0xFFFF;
const ENCAPSULATED_NPDU_HEADER_LENGTH = 10;
const PRIMARY_PROBE_TOKEN = Symbol('BACnet/SC primary probe');
const CONTROL_ORIGINATING = 0x08;
const CONTROL_DESTINATION = 0x04;
const KNOWN_FUNCTIONS = new Set(Object.keys(baScMessage.FUNCTIONS).map((key) => baScMessage.FUNCTIONS[key]));
const FUNCTIONS_WITHOUT_PEER_ADDRESSES = new Set([
  baScMessage.FUNCTIONS.CONNECT_REQUEST,
  baScMessage.FUNCTIONS.CONNECT_ACCEPT,
  baScMessage.FUNCTIONS.DISCONNECT_REQUEST,
  baScMessage.FUNCTIONS.DISCONNECT_ACK,
  baScMessage.FUNCTIONS.HEARTBEAT_REQUEST,
  baScMessage.FUNCTIONS.HEARTBEAT_ACK
]);
const FUNCTIONS_WITHOUT_DATA_OPTIONS = new Set([
  baScMessage.FUNCTIONS.BVLC_RESULT,
  baScMessage.FUNCTIONS.ADDRESS_RESOLUTION,
  baScMessage.FUNCTIONS.ADDRESS_RESOLUTION_ACK,
  baScMessage.FUNCTIONS.ADVERTISEMENT,
  baScMessage.FUNCTIONS.ADVERTISEMENT_SOLICITATION,
  baScMessage.FUNCTIONS.CONNECT_REQUEST,
  baScMessage.FUNCTIONS.CONNECT_ACCEPT,
  baScMessage.FUNCTIONS.DISCONNECT_REQUEST,
  baScMessage.FUNCTIONS.DISCONNECT_ACK,
  baScMessage.FUNCTIONS.HEARTBEAT_REQUEST,
  baScMessage.FUNCTIONS.HEARTBEAT_ACK,
  baScMessage.FUNCTIONS.PROPRIETARY_MESSAGE
]);
const RESPONSE_FUNCTIONS = new Set([
  baScMessage.FUNCTIONS.BVLC_RESULT,
  baScMessage.FUNCTIONS.ADDRESS_RESOLUTION_ACK,
  baScMessage.FUNCTIONS.CONNECT_ACCEPT,
  baScMessage.FUNCTIONS.DISCONNECT_ACK,
  baScMessage.FUNCTIONS.HEARTBEAT_ACK
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function stripIpv6Brackets(hostname) {
  return hostname[0] === '[' && hostname[hostname.length - 1] === ']' ?
    hostname.slice(1, -1) : hostname;
}

function skipServerIdentityCheck() {
  return undefined;
}

function flattenCertificateValues(value, target) {
  if (Array.isArray(value)) {
    value.forEach((entry) => flattenCertificateValues(entry, target));
  } else if (value !== undefined && value !== null) {
    target.push(value);
  }
}

function parseConfiguredCaCertificates(value) {
  const values = [];
  const certificates = [];
  flattenCertificateValues(value, values);
  if (values.length === 0) {
    throw makeError(
      'BACNET_SC_CA_REQUIRED',
      'BACnet/SC requires an explicitly configured site CA certificate store'
    );
  }

  try {
    values.forEach((value) => {
      const encoded = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const text = encoded.toString('utf8');
      const pemBlocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
      const entries = pemBlocks || [encoded];
      entries.forEach((entry) => {
        const certificate = new crypto.X509Certificate(entry);
        if (certificate.ca !== true) {
          throw new Error('the configured certificate is not a CA certificate');
        }
        certificates.push(certificate);
      });
    });
  } catch (err) {
    throw makeError(
      'BACNET_SC_INVALID_CA',
      'Invalid BACnet/SC site CA certificate store: ' + err.message
    );
  }

  if (certificates.length === 0) {
    throw makeError('BACNET_SC_CA_REQUIRED', 'BACnet/SC requires at least one site CA certificate');
  }
  return certificates;
}

function directlySignedByConfiguredCa(certificate, configuredCas) {
  let leaf;
  try {
    if (!certificate || !certificate.raw) throw new Error('the peer did not provide a leaf certificate');
    leaf = new crypto.X509Certificate(certificate.raw);
  } catch (err) {
    return makeError(
      'BACNET_SC_PEER_CERTIFICATE_INVALID',
      'Invalid BACnet/SC peer operational certificate: ' + err.message
    );
  }

  const directlySigned = configuredCas.some((ca) => {
    try {
      return leaf.checkIssued(ca) && leaf.verify(ca.publicKey);
    } catch {
      return false;
    }
  });
  if (!directlySigned) {
    return makeError(
      'BACNET_SC_CA_DIRECT_SIGNER_MISMATCH',
      'BACnet/SC peer certificate was not directly signed by a configured site CA'
    );
  }
  return undefined;
}

function createServerIdentityCheck(configuredCas, verifyServerIdentity, customCheck) {
  return (hostname, certificate) => {
    const signerError = directlySignedByConfiguredCa(certificate, configuredCas);
    if (signerError) return signerError;
    if (customCheck) return customCheck(hostname, certificate);
    if (verifyServerIdentity) return tls.checkServerIdentity(hostname, certificate);
    return undefined;
  };
}

function copyEvent(event) {
  if (!event) return null;
  const copy = Object.assign({}, event);
  if (event.details && typeof event.details === 'object') {
    copy.details = Object.assign({}, event.details);
  }
  return copy;
}

function readConfigValue(value) {
  if (!value || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(readConfigValue);
  if (typeof value !== 'string') return value;
  if (value.indexOf('-----BEGIN ') !== -1) return value;
  return fs.readFileSync(value);
}

function makeError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function invalidConfig(name, message) {
  const err = makeError('BACNET_SC_INVALID_CONFIG', 'Invalid BACnet/SC ' + name + ': ' + message);
  err.setting = name;
  return err;
}

function firstDefined(settings, names, fallback) {
  for (let i = 0; i < names.length; i++) {
    if (settings[names[i]] !== undefined) return settings[names[i]];
  }
  return fallback;
}

function integerSetting(settings, names, fallback, min, max) {
  const value = firstDefined(settings, names, fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalidConfig(names[0], 'expected an integer from ' + min + ' through ' + max);
  }
  return value;
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
  add(firstDefined(settings, ['hubUrl', 'primaryHubUrl']));
  add(settings.failoverHubUrl);
  return urls;
}

function assignDefined(target, source) {
  Object.keys(source).forEach((key) => {
    if (source[key] !== undefined) target[key] = source[key];
  });
  return target;
}

function monotonicNow() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function validatePeerLimits(peer) {
  return Number.isInteger(peer.maxBvlc) && peer.maxBvlc >= 30 && peer.maxBvlc <= 0xFFFF &&
    Number.isInteger(peer.maxNpdu) && peer.maxNpdu >= 1 && peer.maxNpdu + 4 <= peer.maxBvlc;
}

/**
 * BACnet/SC initiating-peer transport options. The default security profile
 * requires TLS 1.3, an operational client certificate, and an explicitly
 * configured site CA. Insecure compatibility switches must be deliberate.
 *
 * @typedef {object} BacnetScTransportOptions
 * @property {string=} hubUrl primary BACnet/SC hub WebSocket URL
 * @property {string[]} [hubUrls] ordered hub URLs used for failover
 * @property {string=} failoverHubUrl compatibility shortcut for one failover hub
 * @property {string=} vmac local VMAC as 12 hexadecimal characters; random by default
 * @property {string=} uuid local UUID; random version-4 UUID by default
 * @property {(string|Buffer)=} cert operational certificate or file path
 * @property {(string|Buffer)=} key operational private key or file path
 * @property {(string|Buffer)=} pfx operational PKCS#12 bundle or file path
 * @property {(string|Buffer|Array<(string|Buffer)>)=} ca explicit site CA store
 * @property {(string|Buffer)=} passphrase private-key or PKCS#12 passphrase
 * @property {boolean=} requireClientCertificate require operational credentials; defaults to true
 * @property {boolean=} rejectUnauthorized validate the peer certificate; defaults to true
 * @property {boolean=} allowSystemTrust allow the host CA store in addition to `ca`; defaults to false
 * @property {boolean=} verifyServerIdentity verify the hub hostname when a name is configured
 * @property {string=} servername TLS server name used for hostname verification and SNI
 * @property {function(string, object): (Error|undefined)=} checkServerIdentity custom identity check
 * @property {object=} tlsOptions additional Node.js TLS/WebSocket connection options
 * @property {string=} tlsVersion fixed TLS version; TLS 1.3 is required by default
 * @property {string=} tlsMinVersion minimum TLS version; TLS 1.3 is required by default
 * @property {string=} tlsMaxVersion maximum TLS version; TLS 1.3 is required by default
 * @property {boolean=} allowInsecureTls allow non-TLS-1.3 settings; defaults to false
 * @property {boolean=} allowPlain allow `ws://` hub URLs; defaults to false
 * @property {number=} apduTimeout upper bound used for queued send lifetime; defaults to 3000 ms
 * @property {number=} connectionWaitTimeout Connect-Accept timeout; defaults to 10000 ms
 * @property {number=} webSocketWaitTimeout WebSocket handshake timeout; defaults to 30000 ms
 * @property {number=} heartbeatInterval idle heartbeat interval; defaults to 30000 ms
 * @property {number=} heartbeatTimeout heartbeat acknowledgement timeout; defaults to twice the interval
 * @property {number=} disconnectTimeout graceful disconnect timeout; defaults to 1000 ms
 * @property {boolean=} reconnect reconnect after retryable closure; defaults to true
 * @property {number=} reconnectMin minimum reconnect delay; defaults to 1000 ms
 * @property {number=} reconnectMax maximum reconnect delay; defaults to 30000 ms
 * @property {number=} sendQueueLimit maximum disconnected sends retained; defaults to 100
 * @property {number=} sendQueueTimeout maximum disconnected-send lifetime; capped by `apduTimeout`
 * @property {number=} maxBvlc maximum local BVLC message length; defaults to 5705
 * @property {number=} maxNpdu maximum local NPDU length; defaults to 1497
 * @property {number=} maxHandshakeBytes maximum WebSocket handshake bytes; defaults to 16384
 * @property {number=} maxBufferedAmount maximum WebSocket buffered bytes; defaults to 65536
 * @property {boolean=} emitTransientErrors emit retryable failures as errors; defaults to false
 */

/**
 * Optional deadline and cancellation state for a transport send.
 *
 * @typedef {object} BacnetScSendContext
 * @property {(number|Date)=} deadline absolute send deadline
 * @property {AbortSignal=} signal cancellation signal
 */

/**
 * Detached BACnet/SC connection status returned by `getStatus()`.
 *
 * @typedef {object} BacnetScTransportStatus
 * @property {string} state transport lifecycle state
 * @property {boolean} connected whether Connect-Accept completed
 * @property {boolean} webSocketReady whether the WebSocket is open
 * @property {?string} hubUrl active or selected hub URL
 * @property {string[]} hubs configured hub URLs
 * @property {string} vmac local VMAC
 * @property {string} uuid local UUID
 * @property {?object} peer negotiated peer identity and size limits
 * @property {number} pendingSends number of queued NPDUs
 * @property {number} bufferedAmount WebSocket buffered bytes
 * @property {number} reconnectAttempts consecutive reconnect attempts
 * @property {?object} lastError last emitted error summary
 * @property {?object} lastDiagnostic last diagnostic summary
 */

/**
 * BACnet/SC initiating-peer transport for a hub connection.
 *
 * The transport owns one active WebSocket generation at a time. Every async
 * callback is generation-checked so a late event from a replaced socket cannot
 * mutate connection state or deliver an NPDU. Protocol errors are answered or
 * discarded at the BVLC layer; socket failures take the reconnect path.
 *
 * Exported as `require('bacstack').transport.BacnetSc`. Applications normally
 * select it with `new Client({transport: 'bacnet-sc', ...options})`; direct
 * transport users must attach event listeners and call `open()` themselves.
 *
 * @class BacnetScTransport
 * @param {BacnetScTransportOptions=} settings transport and trust settings
 */
class BacnetScTransport extends EventEmitter {
  constructor(settings, internalToken) {
    super();
    settings = settings || {};
    const isPrimaryProbe = internalToken === PRIMARY_PROBE_TOKEN;

    if (settings.tlsOptions != null &&
      (typeof settings.tlsOptions !== 'object' || Array.isArray(settings.tlsOptions))) {
      throw invalidConfig('tlsOptions', 'expected an object');
    }

    const tlsOptions = Object.assign({}, settings.tlsOptions || {});
    if (settings.verifyServerIdentity != null && typeof settings.verifyServerIdentity !== 'boolean') {
      throw invalidConfig('verifyServerIdentity', 'expected a boolean');
    }
    const checkServerIdentity = settings.checkServerIdentity === undefined ?
      tlsOptions.checkServerIdentity : settings.checkServerIdentity;
    if (checkServerIdentity !== undefined && typeof checkServerIdentity !== 'function') {
      throw invalidConfig('checkServerIdentity', 'expected a function');
    }
    const hasExplicitServername = settings.servername !== undefined || hasOwn(tlsOptions, 'servername');
    const verifyServerIdentity = settings.verifyServerIdentity === undefined ?
      hasExplicitServername || checkServerIdentity !== undefined : settings.verifyServerIdentity;
    if (settings.allowSystemTrust != null && typeof settings.allowSystemTrust !== 'boolean') {
      throw invalidConfig('allowSystemTrust', 'expected a boolean');
    }
    const allowInsecureTls = settings.allowInsecureTls === true;
    const tlsVersion = settings.tlsVersion;
    let tlsMinVersion = firstDefined(settings, ['tlsMinVersion', 'minVersion'], tlsOptions.minVersion);
    let tlsMaxVersion = firstDefined(settings, ['tlsMaxVersion', 'maxVersion'], tlsOptions.maxVersion);
    if (!allowInsecureTls) {
      if ((tlsVersion !== undefined && tlsVersion !== 'TLSv1.3') ||
        (tlsMinVersion !== undefined && tlsMinVersion !== 'TLSv1.3') ||
        (tlsMaxVersion !== undefined && tlsMaxVersion !== 'TLSv1.3')) {
        throw invalidConfig('tlsVersion', 'TLS 1.3 is required unless allowInsecureTls is explicitly enabled');
      }
      tlsMinVersion = 'TLSv1.3';
      tlsMaxVersion = 'TLSv1.3';
    }
    const apduTimeout = integerSetting(settings, ['apduTimeout'], 3000, 1, MAX_TIMER_DELAY);
    const heartbeatInterval = integerSetting(
      settings,
      ['heartbeatInterval'],
      30000,
      isPrimaryProbe ? 0 : 1,
      MAX_TIMER_DELAY
    );
    const heartbeatTimeout = integerSetting(
      settings,
      ['heartbeatTimeout'],
      heartbeatInterval === 0 ? 0 : Math.min(heartbeatInterval * 2, MAX_TIMER_DELAY),
      heartbeatInterval === 0 ? 0 : 1,
      MAX_TIMER_DELAY
    );
    const maxBvlc = integerSetting(settings, ['maxBvlc', 'maxBVLC'], DEFAULT_MAX_BVLC, 30, 0xFFFF);
    const maxNpdu = integerSetting(settings, ['maxNpdu', 'maxNPDU'], 1497, 1, 0xFFFF);
    const reconnectMin = integerSetting(settings, ['reconnectMin'], 1000, 1, MAX_RECONNECT_DELAY);
    const reconnectMax = integerSetting(settings, ['reconnectMax'], 30000, 1, MAX_RECONNECT_DELAY);
    const configuredQueueTimeout = integerSetting(
      settings,
      ['sendQueueTimeout'],
      apduTimeout,
      0,
      MAX_TIMER_DELAY
    );
    const maxBufferedAmount = integerSetting(
      settings,
      ['maxBufferedAmount', 'maxBufferedBytes'],
      DEFAULT_BUFFER_LIMIT,
      4,
      Number.MAX_SAFE_INTEGER
    );

    if (maxNpdu + 4 > maxBvlc) {
      throw invalidConfig('maxNpdu', 'must not exceed maxBvlc minus the BACnet/SC header');
    }
    if (reconnectMax < reconnectMin) {
      throw invalidConfig('reconnectMax', 'must be greater than or equal to reconnectMin');
    }
    if (maxBufferedAmount < maxBvlc) {
      throw invalidConfig('maxBufferedAmount', 'must be greater than or equal to maxBvlc');
    }

    const vmac = firstDefined(settings, ['vmac'], baScMessage.makeRandomVmac());
    const uuid = firstDefined(settings, ['uuid'], baScMessage.randomUuid());
    try {
      baScMessage.formatVmac(vmac);
      baScMessage.uuidToBuffer(uuid);
      baScMessage.encodeConnectPayload({
        vmac: vmac,
        uuid: uuid,
        maxBvlc: maxBvlc,
        maxNpdu: maxNpdu
      });
    } catch (err) {
      throw invalidConfig('identity', err.message);
    }

    this._settings = {
      cert: settings.cert,
      key: settings.key,
      pfx: settings.pfx,
      ca: settings.ca,
      passphrase: settings.passphrase,
      rejectUnauthorized: settings.rejectUnauthorized === undefined ?
        tlsOptions.rejectUnauthorized !== false : settings.rejectUnauthorized !== false,
      requireClientCertificate: settings.requireClientCertificate !== false,
      emitTransientErrors: settings.emitTransientErrors === true,
      servername: settings.servername,
      checkServerIdentity: checkServerIdentity,
      verifyServerIdentity: verifyServerIdentity,
      allowSystemTrust: settings.allowSystemTrust === true,
      tlsOptions: tlsOptions,
      tlsVersion: tlsVersion,
      tlsMinVersion: tlsMinVersion,
      tlsMaxVersion: tlsMaxVersion,
      allowInsecureTls: allowInsecureTls,
      allowPlain: settings.allowPlain === true,
      vmac: vmac,
      uuid: uuid,
      maxBvlc: maxBvlc,
      maxNpdu: maxNpdu,
      connectionWaitTimeout: integerSetting(
        settings,
        ['connectionWaitTimeout', 'connectTimeout'],
        10000,
        1,
        MAX_TIMER_DELAY
      ),
      webSocketWaitTimeout: integerSetting(
        settings,
        ['webSocketWaitTimeout', 'websocketWaitTimeout'],
        30000,
        1,
        MAX_TIMER_DELAY
      ),
      heartbeatInterval: heartbeatInterval,
      heartbeatTimeout: heartbeatTimeout,
      disconnectTimeout: integerSetting(settings, ['disconnectTimeout'], 1000, 1, MAX_TIMER_DELAY),
      reconnect: settings.reconnect !== false,
      reconnectMin: reconnectMin,
      reconnectMax: reconnectMax,
      sendQueueLimit: integerSetting(settings, ['sendQueueLimit'], 100, 0, 1000000),
      sendQueueTimeout: Math.min(configuredQueueTimeout, apduTimeout),
      maxHandshakeBytes: integerSetting(
        settings,
        ['maxHandshakeBytes'],
        DEFAULT_HANDSHAKE_LIMIT,
        1024,
        1024 * 1024
      ),
      maxBufferedAmount: maxBufferedAmount
    };

    this._socket = null;
    this._socketGeneration = 0;
    this._failureGeneration = null;
    this._retryOnClose = false;
    this._state = 'idle';
    this._manualClose = false;
    this._connected = false;
    this._webSocketReady = false;
    this._pendingSends = [];
    this._messageId = 1;
    this._connectRequestId = null;
    this._disconnectRequestId = null;
    this._peer = null;
    this._lastDiagnostic = null;
    this._lastError = null;
    this._lastClose = null;
    this._lastConnectedAt = null;
    this._lastDisconnectedAt = null;
    this._reconnectAttempts = 0;
    this._heartbeatTimer = null;
    this._connectionTimer = null;
    this._disconnectTimer = null;
    this._reconnectTimer = null;
    this._reconnectDelay = this._settings.reconnectMin;
    this._nextReconnectHubIndex = null;
    this._primaryProbeTimer = null;
    this._primaryProbe = null;
    this._primaryProbeDelay = this._settings.reconnectMin;
    this._hubIndex = 0;
    this._hubs = normalizeHubUrls(settings);
    this._lastBvlcActivityAt = null;
    this._heartbeatPendingAt = null;
    this._heartbeatRequestId = null;
  }

  /**
   * Returns the BACnet/SC broadcast VMAC.
   *
   * @function BacnetScTransport#getBroadcastAddress
   * @returns {string} `ffffffffffff`
   */
  getBroadcastAddress() {
    return baScMessage.BROADCAST_VMAC;
  }

  /**
   * Returns the string-address kind consumed by this transport.
   *
   * @function BacnetScTransport#getAddressKind
   * @returns {string} `vmac`
   */
  getAddressKind() {
    return 'vmac';
  }

  /**
   * Returns the current outbound working-buffer capacity, including the
   * four-byte adapter header reserve. Negotiated peer limits are applied once
   * connected.
   *
   * @function BacnetScTransport#getMaxPayload
   * @returns {number} maximum working-buffer bytes
   */
  getMaxPayload() {
    return this._getOutboundNpduLimit() + baEnum.BVLC_HEADER_LENGTH;
  }

  _getOutboundNpduLimit() {
    const limits = [
      this._settings.maxNpdu,
      this._settings.maxBvlc - ENCAPSULATED_NPDU_HEADER_LENGTH
    ];
    if (this._peer) {
      limits.push(this._peer.maxNpdu, this._peer.maxBvlc - ENCAPSULATED_NPDU_HEADER_LENGTH);
    }
    return Math.max(0, Math.min(...limits));
  }

  /**
   * Returns the current transport lifecycle state.
   *
   * @function BacnetScTransport#getState
   * @returns {string} lifecycle state such as `idle`, `connecting`, or `connected`
   */
  getState() {
    return this._state;
  }

  /**
   * Returns a detached snapshot of connection, peer, queue, reconnect, and
   * diagnostic state.
   *
   * @function BacnetScTransport#getStatus
   * @returns {BacnetScTransportStatus} detached status snapshot
   */
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
      peer: this._peer ? Object.assign({}, this._peer) : null,
      pendingSends: this._pendingSends.length,
      bufferedAmount: this._socket ? this._socket.bufferedAmount || 0 : 0,
      reconnectDelay: this._reconnectDelay,
      reconnectAttempts: this._reconnectAttempts,
      primaryProbe: this._primaryProbe ? this._primaryProbe.getState() :
        (this._primaryProbeTimer ? 'scheduled' : null),
      lastConnectedAt: this._lastConnectedAt,
      lastDisconnectedAt: this._lastDisconnectedAt,
      lastClose: this._lastClose ? Object.assign({}, this._lastClose) : null,
      lastError: copyEvent(this._lastError),
      lastDiagnostic: copyEvent(this._lastDiagnostic)
    };
  }

  /**
   * Starts the hub connection. Calling while a socket or connection attempt is
   * active is a no-op.
   *
   * @function BacnetScTransport#open
   * @returns {boolean} true when a new connection attempt was started
   */
  open() {
    this._manualClose = false;
    if (this._socket || this._state !== 'idle') return false;
    if (this._hubs.length === 0) {
      this._emitError('BACNET_SC_NO_HUB_URL', 'BACnet/SC hubUrl is required');
      return false;
    }
    this._connect(this._hubs[this._hubIndex]);
    return true;
  }

  /**
   * Sends or queues the NPDU contained in a BACstack transport working buffer.
   * This is the low-level transport-adapter API; application code normally uses
   * Client service methods instead.
   *
   * @function BacnetScTransport#send
   * @param {Buffer} buffer BACstack working buffer
   * @param {number} offset encoded packet length
   * @param {(string|object)=} receiver destination VMAC or VMAC-bearing address
   * @param {BacnetScSendContext=} context optional deadline and cancellation state
   * @returns {boolean} whether the packet was sent or accepted into the bounded queue
   */
  send(buffer, offset, receiver, context) {
    if (this._manualClose || this._state === 'disconnecting') {
      this._emitDiagnostic('BACNET_SC_CLOSED', 'Ignored a BACnet/SC send after the transport was closed');
      return false;
    }
    if (!Buffer.isBuffer(buffer) || !Number.isInteger(offset) ||
      offset < baEnum.BVLC_HEADER_LENGTH || offset > buffer.length) {
      this._emitError('BACNET_SC_INVALID_SEND', 'BACnet/SC send requires a valid encoded BACnet packet');
      return false;
    }

    const sendContext = this._normalizeSendContext(context);
    if (!sendContext) return false;
    if (sendContext.signal && sendContext.signal.aborted) {
      this._emitDiagnostic('send-aborted', 'Dropped an aborted BACnet/SC send');
      return false;
    }
    if (sendContext.deadline !== null && Date.now() >= sendContext.deadline) {
      this._emitDiagnostic('send-expired', 'Dropped an expired BACnet/SC send');
      return false;
    }

    const payload = Buffer.from(buffer.slice(baEnum.BVLC_HEADER_LENGTH, offset));
    if (payload.length > this._settings.maxNpdu) {
      this._emitError('BACNET_SC_NPDU_TOO_LARGE', 'BACnet/SC NPDU exceeds the configured payload limit');
      return false;
    }
    if (payload.length + ENCAPSULATED_NPDU_HEADER_LENGTH > this._settings.maxBvlc) {
      this._emitError('BACNET_SC_BVLC_TOO_LARGE', 'BACnet/SC NPDU exceeds the configured BVLC limit');
      return false;
    }
    if (this._peer && payload.length > this._peer.maxNpdu) {
      this._emitError('BACNET_SC_PEER_NPDU_TOO_LARGE', 'BACnet/SC NPDU exceeds the peer payload limit');
      return false;
    }
    if (this._peer && payload.length + ENCAPSULATED_NPDU_HEADER_LENGTH > this._peer.maxBvlc) {
      this._emitError('BACNET_SC_PEER_BVLC_TOO_LARGE', 'BACnet/SC NPDU exceeds the peer BVLC limit');
      return false;
    }

    const queueLifetime = sendContext.deadline === null ? this._settings.sendQueueTimeout :
      Math.min(this._settings.sendQueueTimeout, Math.max(0, sendContext.deadline - Date.now()));
    const item = {
      payload: payload,
      receiver: receiver,
      queuedAt: new Date().toISOString(),
      expiresAt: monotonicNow() + queueLifetime,
      deadline: sendContext.deadline,
      signal: sendContext.signal,
      abortHandler: null,
      timeout: null,
      settled: false
    };

    if (!this._connected) return this._queueSend(item);
    return this._sendNpdu(item);
  }

  /**
   * Stops reconnect activity, cancels queued sends, and gracefully disconnects
   * the active hub session when possible. Repeated calls are safe.
   *
   * @function BacnetScTransport#close
   */
  close() {
    if (this._manualClose) return;
    if (this._state === 'disconnecting') {
      this._manualClose = true;
      this._clearPendingSends('BACNET_SC_SEND_CANCELLED');
      this._clearReconnectTimer();
      this._clearPrimaryProbe();
      return;
    }
    this._manualClose = true;
    this._clearPendingSends('BACNET_SC_SEND_CANCELLED');
    this._clearReconnectTimer();
    this._clearPrimaryProbe();
    this._clearConnectionTimer();
    this._clearHeartbeatTimer();
    this._clearDisconnectTimer();

    const socket = this._socket;
    const generation = this._socketGeneration;
    if (this._connected && this._isCurrentSocket(socket, generation)) {
      this._state = 'disconnecting';
      this._retryOnClose = false;
      this._disconnectRequestId = this._nextMessageId();
      const sent = this._sendScMessage(
        baScMessage.FUNCTIONS.DISCONNECT_REQUEST,
        {id: this._disconnectRequestId},
        socket,
        generation,
        true
      );
      if (sent) {
        this._startDisconnectTimer(socket, generation);
      } else {
        this._closeSocket(socket, generation, false);
        this._startDisconnectTimer(socket, generation);
      }
      return;
    }

    if (this._isCurrentSocket(socket, generation)) {
      this._state = 'disconnecting';
      this._retryOnClose = false;
      this._closeSocket(socket, generation, false);
      this._startDisconnectTimer(socket, generation);
    } else {
      this._state = 'idle';
    }
  }

  _queueSend(item) {
    if (this._pendingSends.length >= this._settings.sendQueueLimit) {
      this._emitError('BACNET_SC_SEND_QUEUE_FULL', 'BACnet/SC send queue is full');
      return false;
    }
    const timeout = Math.max(0, item.expiresAt - monotonicNow());
    if (timeout === 0 || item.deadline !== null && Date.now() >= item.deadline) {
      this._emitDiagnostic('send-expired', 'Dropped a BACnet/SC NPDU because disconnected sends are not queued');
      return false;
    }
    this._pendingSends.push(item);
    if (item.signal) {
      item.abortHandler = () => this._abortPendingSend(item);
      item.signal.addEventListener('abort', item.abortHandler, {once: true});
      if (item.signal.aborted) {
        this._abortPendingSend(item);
        return false;
      }
    }
    item.timeout = setTimeout(() => this._expirePendingSend(item), Math.max(1, Math.ceil(timeout)));
    if (item.timeout.unref) item.timeout.unref();
    this._emitDiagnostic('queued', 'Queued BACnet/SC NPDU until the hub connection is ready');
    return true;
  }

  _normalizeSendContext(context) {
    if (context == null) return {signal: null, deadline: null};
    if (typeof context !== 'object' || Array.isArray(context)) {
      this._emitError('BACNET_SC_INVALID_SEND_CONTEXT', 'BACnet/SC send context must be an object');
      return null;
    }

    let deadline = null;
    if (context.deadline !== undefined && context.deadline !== null) {
      deadline = context.deadline instanceof Date ? context.deadline.getTime() : context.deadline;
      if (!Number.isFinite(deadline)) {
        this._emitError('BACNET_SC_INVALID_SEND_CONTEXT', 'BACnet/SC send deadline must be an absolute timestamp');
        return null;
      }
    }

    let signal = context.signal;
    if (signal == null) signal = null;
    if (signal && (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
      this._emitError('BACNET_SC_INVALID_SEND_CONTEXT', 'BACnet/SC send signal must be an AbortSignal');
      return null;
    }
    return {signal: signal, deadline: deadline};
  }

  _connect(hubUrl) {
    let parsed;
    let socket;
    let options;

    if (this._manualClose || this._socket) return;
    this._state = 'connecting';
    this._peer = null;
    this._emitDiagnostic('connecting', 'Connecting to BACnet/SC hub', {hubUrl: hubUrl});
    if (this._manualClose || this._state !== 'connecting' || this._socket) return;

    try {
      parsed = new URL(hubUrl);
      if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
        throw makeError('BACNET_SC_BAD_HUB_URL', 'BACnet/SC hubUrl must use ws:// or wss://');
      }
      if (parsed.protocol === 'ws:' && !this._settings.allowPlain) {
        throw makeError('BACNET_SC_PLAIN_WS_DISABLED', 'Plain BACnet/SC WebSocket connections are disabled');
      }
      options = this._createWebSocketOptions(parsed);
      socket = new WebSocket(parsed.href, SUBPROTOCOL_HUB, options);
    } catch (err) {
      this._failConnection(err, err.code || 'BACNET_SC_CONNECT_SETUP_FAILED', {
        retryable: err.code !== 'BACNET_SC_BAD_HUB_URL' &&
          err.code !== 'BACNET_SC_PLAIN_WS_DISABLED' &&
          err.code !== 'BACNET_SC_CLIENT_CERT_REQUIRED' &&
          err.code !== 'BACNET_SC_CA_REQUIRED' &&
          err.code !== 'BACNET_SC_INVALID_CA'
      });
      return;
    }

    const generation = ++this._socketGeneration;
    this._socket = socket;
    this._failureGeneration = null;
    this._retryOnClose = false;
    this._webSocketReady = false;
    this._connected = false;
    this._connectRequestId = null;
    this._disconnectRequestId = null;

    socket.binaryType = 'nodebuffer';
    socket.on('open', () => this._onSocketOpen(socket, generation));
    socket.on('message', (data, isBinary) => this._onSocketMessage(socket, generation, data, isBinary));
    socket.on('error', (err) => this._onSocketError(socket, generation, err));
    socket.on('close', (code, reason) => this._onSocketClose(socket, generation, code, reason));
    this._startConnectionTimer(
      'BACNET_SC_WEBSOCKET_TIMEOUT',
      this._settings.webSocketWaitTimeout,
      socket,
      generation
    );
  }

  _createWebSocketOptions(parsed) {
    const nested = this._settings.tlsOptions;
    const options = Object.assign({}, nested);

    options.followRedirects = false;
    options.handshakeTimeout = this._settings.webSocketWaitTimeout;
    options.maxHeaderSize = this._settings.maxHandshakeBytes;
    // Let the WebSocket implementation reject only messages that cannot be
    // represented by BACnet/SC at all. A locally configured smaller limit is
    // enforced after reassembly so an over-limit BVLC can be discarded while
    // preserving the connection, as required by the protocol.
    options.maxPayload = MAX_BVLC_LENGTH;
    options.perMessageDeflate = false;
    options.protocolVersion = 13;

    if (parsed.protocol === 'ws:') return options;

    const pfx = this._settings.pfx === undefined ? nested.pfx : this._settings.pfx;
    const cert = this._settings.cert === undefined ? nested.cert : this._settings.cert;
    const key = this._settings.key === undefined ? nested.key : this._settings.key;
    const ca = this._settings.ca === undefined ? nested.ca : this._settings.ca;
    const passphrase = this._settings.passphrase === undefined ? nested.passphrase : this._settings.passphrase;
    const resolvedPfx = readConfigValue(pfx);
    const resolvedCert = readConfigValue(cert);
    const resolvedKey = readConfigValue(key);
    const resolvedCa = readConfigValue(ca);
    const tlsHostname = stripIpv6Brackets(parsed.hostname);
    const servername = this._settings.servername !== undefined ? this._settings.servername :
      (hasOwn(nested, 'servername') ? nested.servername :
        (net.isIP(tlsHostname) ? undefined : tlsHostname));
    let checkServerIdentity;

    if (this._settings.requireClientCertificate && !pfx && (!cert || !key)) {
      throw makeError('BACNET_SC_CLIENT_CERT_REQUIRED', 'BACnet/SC requires a client certificate and key');
    }

    if (this._settings.rejectUnauthorized && !this._settings.allowSystemTrust) {
      const configuredCas = parseConfiguredCaCertificates(resolvedCa);
      checkServerIdentity = createServerIdentityCheck(
        configuredCas,
        this._settings.verifyServerIdentity,
        this._settings.checkServerIdentity
      );
    } else {
      checkServerIdentity = this._settings.checkServerIdentity ||
        (this._settings.verifyServerIdentity ? undefined : skipServerIdentityCheck);
    }

    assignDefined(options, {
      pfx: resolvedPfx,
      cert: resolvedCert,
      key: resolvedKey,
      ca: resolvedCa,
      passphrase: passphrase,
      servername: servername,
      checkServerIdentity: checkServerIdentity,
      rejectUnauthorized: this._settings.rejectUnauthorized
    });

    if (this._settings.tlsVersion !== undefined) {
      options.minVersion = this._settings.tlsVersion;
      options.maxVersion = this._settings.tlsVersion;
    } else {
      assignDefined(options, {
        minVersion: this._settings.tlsMinVersion,
        maxVersion: this._settings.tlsMaxVersion
      });
    }
    return options;
  }

  _onSocketOpen(socket, generation) {
    if (!this._isCurrentSocket(socket, generation) || this._failureGeneration === generation ||
      this._manualClose || this._state !== 'connecting') return;
    if (socket.protocol !== SUBPROTOCOL_HUB) {
      this._failConnection(
        makeError('BACNET_SC_WEBSOCKET_PROTOCOL_MISMATCH', 'BACnet/SC hub selected an invalid WebSocket subprotocol'),
        'BACNET_SC_WEBSOCKET_PROTOCOL_MISMATCH',
        {closeCode: 1002, closeReason: 'Invalid WebSocket subprotocol'},
        socket,
        generation
      );
      return;
    }

    let connectPayload;
    try {
      connectPayload = baScMessage.encodeConnectPayload({
        vmac: this._settings.vmac,
        uuid: this._settings.uuid,
        maxBvlc: this._settings.maxBvlc,
        maxNpdu: this._settings.maxNpdu
      });
    } catch (err) {
      this._failConnection(err, 'BACNET_SC_INVALID_CONFIG', {retryable: false}, socket, generation);
      return;
    }

    this._webSocketReady = true;
    this._state = 'awaiting-accept';
    this._connectRequestId = this._nextMessageId();
    const sent = this._sendScMessage(
      baScMessage.FUNCTIONS.CONNECT_REQUEST,
      {
        id: this._connectRequestId,
        payload: connectPayload
      },
      socket,
      generation
    );
    if (!sent) return;

    this._startConnectionTimer(
      'BACNET_SC_CONNECT_TIMEOUT',
      this._settings.connectionWaitTimeout,
      socket,
      generation
    );
    this._emitDiagnostic('websocket-open', 'BACnet/SC WebSocket established');
  }

  _onSocketMessage(socket, generation, data, isBinary) {
    if (!this._isCurrentSocket(socket, generation) || this._failureGeneration === generation ||
      !this._webSocketReady) return;
    if (this._manualClose && this._state !== 'disconnecting') return;
    if (!isBinary) {
      this._failConnection(
        makeError('BACNET_SC_TEXT_MESSAGE', 'BACnet/SC accepts only binary WebSocket messages'),
        'BACNET_SC_TEXT_MESSAGE',
        {closeCode: 1003, closeReason: 'Binary messages required'},
        socket,
        generation
      );
      return;
    }

    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (payload.length > this._settings.maxBvlc) {
      this._emitDiagnostic(
        'BACNET_SC_MESSAGE_TOO_LARGE',
        'Discarded a BACnet/SC message that exceeds the configured BVLC limit',
        {length: payload.length, maximum: this._settings.maxBvlc}
      );
      return;
    }
    this._handleScMessage(payload, socket, generation);
  }

  _onSocketError(socket, generation, err) {
    if (!this._isCurrentSocket(socket, generation)) return;
    let code = 'BACNET_SC_SOCKET_ERROR';
    if (err && typeof err.code === 'string' && err.code.indexOf('BACNET_SC_') === 0) {
      code = err.code;
    } else if (err && (err.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ||
      /Max payload size exceeded/i.test(err.message))) {
      code = 'BACNET_SC_MESSAGE_TOO_LARGE';
    } else if (err && /Unexpected server response/i.test(err.message)) {
      code = 'BACNET_SC_WEBSOCKET_REJECTED';
    } else if (err && /Invalid Sec-WebSocket-Accept/i.test(err.message)) {
      code = 'BACNET_SC_WEBSOCKET_ACCEPT_MISMATCH';
    } else if (err && /subprotocol/i.test(err.message)) {
      code = 'BACNET_SC_WEBSOCKET_PROTOCOL_MISMATCH';
    } else if (err && /handshake.*timed out/i.test(err.message)) {
      code = 'BACNET_SC_WEBSOCKET_TIMEOUT';
    }
    this._failConnection(err, code, {force: true}, socket, generation);
  }

  _decodeEnvelope(payload) {
    if (!Buffer.isBuffer(payload) || payload.length < 4) return null;
    const message = {
      function: payload[0],
      control: payload[1],
      id: payload.readUInt16BE(2)
    };
    let offset = 4;
    if (message.control & CONTROL_ORIGINATING) {
      if (offset + 6 > payload.length) return message;
      message.originating = payload.slice(offset, offset + 6).toString('hex');
      offset += 6;
    }
    if (message.control & CONTROL_DESTINATION) {
      if (offset + 6 > payload.length) return message;
      message.destination = payload.slice(offset, offset + 6).toString('hex');
    }
    return message;
  }

  _isBroadcastMessage(message) {
    return message && message.destination === baScMessage.BROADCAST_VMAC;
  }

  _dropMisroutedMessage(message) {
    if (!message || !message.destination || message.destination === baScMessage.BROADCAST_VMAC) {
      return false;
    }
    this._emitDiagnostic('misrouted-message', 'Discarded a BACnet/SC hub message for another node', {
      function: message.function,
      messageId: message.id,
      destination: message.destination
    });
    return true;
  }

  _sendBvlcNak(message, errorCode, errorHeaderMarker, socket, generation) {
    if (!message || RESPONSE_FUNCTIONS.has(message.function)) return false;
    if (this._isBroadcastMessage(message)) {
      this._emitDiagnostic('broadcast-rejected', 'Discarded an invalid broadcast BACnet/SC message', {
        function: message.function,
        messageId: message.id,
        errorCode: errorCode
      });
      return false;
    }

    const payload = baScMessage.encodeBvlcResultPayload({
      forFunction: message.function,
      resultCode: 1,
      errorHeaderMarker: errorHeaderMarker || 0,
      errorClass: baEnum.ErrorClass.COMMUNICATION,
      errorCode: errorCode,
      // Error details are optional. Keeping protocol-generated NAKs compact
      // guarantees they fit even when a peer advertises the minimum BVLC size.
      errorDetails: ''
    });
    const options = {
      id: message.id,
      payload: payload
    };
    if (message.originating) options.destination = message.originating;
    return this._sendScMessage(
      baScMessage.FUNCTIONS.BVLC_RESULT,
      options,
      socket,
      generation,
      true
    );
  }

  _rejectMessage(message, errorCode, diagnosticCode, details, errorHeaderMarker, socket, generation) {
    this._emitDiagnostic(diagnosticCode, details, {
      function: message && message.function,
      messageId: message && message.id,
      errorCode: errorCode,
      errorHeaderMarker: errorHeaderMarker || 0
    });
    this._sendBvlcNak(message, errorCode, errorHeaderMarker, socket, generation);
    return false;
  }

  _decodeErrorCode(err) {
    const code = err && (err.code || err.message) || '';
    if (/TRUNCATED/.test(code)) return baEnum.ErrorCode.MESSAGE_INCOMPLETE;
    if (/INVALID_CONTROL|INVALID_OPTION_TYPE|OPTION_TOO_LARGE/.test(code)) {
      return baEnum.ErrorCode.PARAMETER_OUT_OF_RANGE;
    }
    if (/INVALID_SECURE_PATH_OPTION|INVALID_PROPRIETARY_OPTION/.test(code)) {
      return baEnum.ErrorCode.INCONSISTENT_PARAMETERS;
    }
    return baEnum.ErrorCode.HEADER_ENCODING_ERROR;
  }

  _findUnsupportedMustUnderstand(message) {
    const destinationOptions = message.destOptions || [];
    for (let i = 0; i < destinationOptions.length; i++) {
      if (destinationOptions[i].mustUnderstand) return destinationOptions[i];
    }
    return null;
  }

  _validateMessageShape(message) {
    const hasOriginating = hasOwn(message, 'originating');
    const hasDestination = hasOwn(message, 'destination');
    const hasDataOptions = hasOwn(message, 'dataOptions');
    const payloadLength = message.payload.length;
    if (FUNCTIONS_WITHOUT_PEER_ADDRESSES.has(message.function) && (hasOriginating || hasDestination)) {
      return {
        errorCode: baEnum.ErrorCode.PARAMETER_OUT_OF_RANGE,
        code: 'invalid-control-flags',
        details: 'BACnet/SC peer control message contains a forbidden virtual address'
      };
    }
    if (FUNCTIONS_WITHOUT_DATA_OPTIONS.has(message.function) && hasDataOptions) {
      return {
        errorCode: baEnum.ErrorCode.PARAMETER_OUT_OF_RANGE,
        code: 'invalid-control-flags',
        details: 'BACnet/SC message contains forbidden data options'
      };
    }

    let expectedLength = null;
    let minimumLength = null;
    switch (message.function) {
      case baScMessage.FUNCTIONS.BVLC_RESULT:
        minimumLength = 2;
        break;
      case baScMessage.FUNCTIONS.ENCAPSULATED_NPDU:
        minimumLength = 1;
        break;
      case baScMessage.FUNCTIONS.ADDRESS_RESOLUTION:
      case baScMessage.FUNCTIONS.ADVERTISEMENT_SOLICITATION:
      case baScMessage.FUNCTIONS.DISCONNECT_REQUEST:
      case baScMessage.FUNCTIONS.DISCONNECT_ACK:
      case baScMessage.FUNCTIONS.HEARTBEAT_REQUEST:
      case baScMessage.FUNCTIONS.HEARTBEAT_ACK:
        expectedLength = 0;
        break;
      case baScMessage.FUNCTIONS.ADVERTISEMENT:
        expectedLength = 6;
        break;
      case baScMessage.FUNCTIONS.CONNECT_REQUEST:
      case baScMessage.FUNCTIONS.CONNECT_ACCEPT:
        expectedLength = 26;
        break;
      case baScMessage.FUNCTIONS.PROPRIETARY_MESSAGE:
        minimumLength = 3;
        break;
      default:
        break;
    }

    if ((minimumLength !== null && payloadLength < minimumLength) ||
      (expectedLength !== null && expectedLength > 0 && payloadLength === 0)) {
      return {
        errorCode: payloadLength === 0 ?
          baEnum.ErrorCode.PAYLOAD_EXPECTED : baEnum.ErrorCode.MESSAGE_INCOMPLETE,
        code: 'invalid-payload-length',
        details: 'BACnet/SC message is missing required payload data'
      };
    }
    if (expectedLength !== null && payloadLength < expectedLength) {
      return {
        errorCode: baEnum.ErrorCode.MESSAGE_INCOMPLETE,
        code: 'invalid-payload-length',
        details: 'BACnet/SC message payload is incomplete'
      };
    }
    if (expectedLength !== null && payloadLength > expectedLength) {
      return {
        errorCode: baEnum.ErrorCode.UNEXPECTED_DATA,
        code: 'invalid-payload-length',
        details: 'BACnet/SC message contains unexpected payload data'
      };
    }
    return null;
  }

  _handleScMessage(payload, socket, generation) {
    socket = socket || this._socket;
    generation = generation === undefined ? this._socketGeneration : generation;
    if (!this._isCurrentSocket(socket, generation)) return false;

    let message;
    try {
      message = baScMessage.decode(payload);
    } catch (err) {
      const envelope = this._decodeEnvelope(payload);
      if (this._dropMisroutedMessage(envelope)) return false;
      return this._rejectMessage(
        envelope,
        this._decodeErrorCode(err),
        'malformed-message',
        'Discarded a malformed BACnet/SC message',
        0,
        socket,
        generation
      );
    }

    if (this._dropMisroutedMessage(message)) return false;

    if (!KNOWN_FUNCTIONS.has(message.function)) {
      return this._rejectMessage(
        message,
        baEnum.ErrorCode.BVLC_FUNCTION_UNKNOWN,
        'unknown-function',
        'Discarded an unknown BACnet/SC BVLC function',
        0,
        socket,
        generation
      );
    }

    const shapeError = this._validateMessageShape(message);
    if (shapeError) {
      return this._rejectMessage(
        message,
        shapeError.errorCode,
        shapeError.code,
        shapeError.details,
        0,
        socket,
        generation
      );
    }

    const unsupportedOption = this._findUnsupportedMustUnderstand(message);
    if (unsupportedOption) {
      return this._rejectMessage(
        message,
        baEnum.ErrorCode.HEADER_NOT_UNDERSTOOD,
        'unsupported-header-option',
        'Discarded a BACnet/SC message with an unsupported Must-Understand option',
        unsupportedOption.marker,
        socket,
        generation
      );
    }

    if (this._state === 'disconnecting') {
      if (message.function === baScMessage.FUNCTIONS.DISCONNECT_ACK &&
        message.id === this._disconnectRequestId) {
        this._recordBvlcActivity();
        this._disconnectRequestId = null;
        this._closeSocket(socket, generation, false);
        return true;
      }
      if (message.function === baScMessage.FUNCTIONS.BVLC_RESULT &&
        message.id === this._disconnectRequestId) {
        const result = this._decodeBvlcResult(message);
        if (result && result.resultCode === 1 &&
          result.forFunction === baScMessage.FUNCTIONS.DISCONNECT_REQUEST) {
          this._recordBvlcActivity();
          this._disconnectRequestId = null;
          this._closeSocket(socket, generation, false);
          return true;
        }
      }
      this._emitDiagnostic('unexpected-disconnect-message', 'Ignored a BACnet/SC message while disconnecting', {
        function: message.function,
        messageId: message.id
      });
      return false;
    }

    if (this._state === 'awaiting-accept') {
      if (message.function === baScMessage.FUNCTIONS.BVLC_RESULT) {
        if (message.id === this._connectRequestId) {
          return this._handleConnectResult(message, socket, generation);
        }
        this._emitDiagnostic('unexpected-connect-result', 'Ignored an unmatched BACnet/SC Connect result', {
          messageId: message.id,
          expectedMessageId: this._connectRequestId
        });
        return false;
      }
      if (message.function !== baScMessage.FUNCTIONS.CONNECT_ACCEPT || message.id !== this._connectRequestId) {
        this._failConnection(
          makeError('BACNET_SC_UNEXPECTED_CONNECT_MESSAGE', 'Unexpected BACnet/SC message before Connect-Accept'),
          'BACNET_SC_UNEXPECTED_CONNECT_MESSAGE',
          {closeCode: 1002, closeReason: 'Unexpected BACnet/SC message'},
          socket,
          generation
        );
        return false;
      }
      return this._acceptConnection(message, socket, generation);
    }

    if (this._state !== 'connected' || !this._connected || this._manualClose) return false;

    switch (message.function) {
      case baScMessage.FUNCTIONS.CONNECT_REQUEST:
      case baScMessage.FUNCTIONS.CONNECT_ACCEPT:
        this._failConnection(
          makeError('BACNET_SC_UNEXPECTED_CONNECT_MESSAGE', 'Unexpected BACnet/SC connect message'),
          'BACNET_SC_UNEXPECTED_CONNECT_MESSAGE',
          {closeCode: 1002, closeReason: 'Unexpected BACnet/SC connect message'},
          socket,
          generation
        );
        return false;
      case baScMessage.FUNCTIONS.BVLC_RESULT:
        return this._handleBvlcResult(message, socket, generation);
      case baScMessage.FUNCTIONS.ENCAPSULATED_NPDU:
        if (message.payload.length > this._settings.maxNpdu) {
          return this._rejectMessage(
            message,
            baEnum.ErrorCode.PARAMETER_OUT_OF_RANGE,
            'npdu-too-large',
            'Discarded a BACnet/SC NPDU over the configured payload limit',
            0,
            socket,
            generation
          );
        }
        this._recordBvlcActivity();
        this._emitNpdu(message);
        return true;
      case baScMessage.FUNCTIONS.HEARTBEAT_REQUEST:
        this._recordBvlcActivity();
        return this._sendScMessage(
          baScMessage.FUNCTIONS.HEARTBEAT_ACK,
          {id: message.id},
          socket,
          generation
        );
      case baScMessage.FUNCTIONS.HEARTBEAT_ACK:
        if (message.id === this._heartbeatRequestId && this._heartbeatPendingAt !== null) {
          this._recordBvlcActivity(true);
          this._emitDiagnostic('heartbeat-ack', 'BACnet/SC heartbeat acknowledged');
          return true;
        }
        this._emitDiagnostic('unexpected-heartbeat-ack', 'Ignoring an unmatched BACnet/SC heartbeat acknowledgment', {
          messageId: message.id
        });
        return false;
      case baScMessage.FUNCTIONS.DISCONNECT_REQUEST:
        this._recordBvlcActivity();
        this._state = 'disconnecting';
        this._retryOnClose = this._settings.reconnect && !this._manualClose;
        this._clearHeartbeatTimer();
        this._sendScMessage(
          baScMessage.FUNCTIONS.DISCONNECT_ACK,
          {id: message.id},
          socket,
          generation,
          true
        );
        this._closeSocket(socket, generation, false);
        this._startDisconnectTimer(socket, generation);
        return true;
      case baScMessage.FUNCTIONS.DISCONNECT_ACK:
        this._emitDiagnostic('unexpected-disconnect-ack', 'Ignoring an unmatched BACnet/SC Disconnect-Ack', {
          messageId: message.id
        });
        return false;
      case baScMessage.FUNCTIONS.ADDRESS_RESOLUTION:
        this._recordBvlcActivity();
        return this._rejectAddressResolution(message, socket, generation);
      case baScMessage.FUNCTIONS.ADDRESS_RESOLUTION_ACK:
        return this._handleAddressResolutionAck(message, socket, generation);
      case baScMessage.FUNCTIONS.ADVERTISEMENT:
        return this._handleAdvertisement(message, socket, generation);
      case baScMessage.FUNCTIONS.ADVERTISEMENT_SOLICITATION:
        this._recordBvlcActivity();
        return this._sendAdvertisement(message, socket, generation);
      case baScMessage.FUNCTIONS.PROPRIETARY_MESSAGE:
        this._recordBvlcActivity();
        return this._rejectMessage(
          message,
          baEnum.ErrorCode.BVLC_PROPRIETARY_FUNCTION_UNKNOWN,
          'unsupported-proprietary-function',
          'Discarded an unsupported BACnet/SC proprietary function',
          0,
          socket,
          generation
        );
      default:
        this._recordBvlcActivity();
        this._emitDiagnostic('unsupported-service', 'Ignoring unsupported BACnet/SC service', {
          function: message.function
        });
        return true;
    }
  }

  _rejectAddressResolution(message, socket, generation) {
    return this._rejectMessage(
      message,
      baEnum.ErrorCode.OPTIONAL_FUNCTIONALITY_NOT_SUPPORTED,
      'direct-connect-unsupported',
      'BACnet/SC Direct Connect is not supported by this transport',
      0,
      socket,
      generation
    );
  }

  _handleAddressResolutionAck(message, socket, generation) {
    let text;
    let uris;
    try {
      text = new TextDecoder('utf-8', {fatal: true}).decode(message.payload);
      uris = text === '' ? [] : text.split(' ');
      if (uris.some((uri) => uri === '' || new URL(uri).protocol !== 'wss:')) {
        throw new Error('BACNET_SC_INVALID_WEBSOCKET_URI');
      }
    } catch {
      return this._rejectMessage(
        message,
        baEnum.ErrorCode.PARAMETER_OUT_OF_RANGE,
        'invalid-address-resolution',
        'Discarded invalid BACnet/SC Address-Resolution data',
        0,
        socket,
        generation
      );
    }
    this._recordBvlcActivity();
    this.emit('addressResolution', {
      address: message.originating || this._peer.vmac,
      uris: uris.slice()
    });
    return true;
  }

  _handleAdvertisement(message, socket, generation) {
    const advertisement = {
      address: message.originating || this._peer.vmac,
      hubConnectionStatus: message.payload[0],
      acceptDirectConnections: message.payload[1] === 1,
      maxBvlc: message.payload.readUInt16BE(2),
      maxNpdu: message.payload.readUInt16BE(4)
    };
    if (advertisement.hubConnectionStatus > 2 || message.payload[1] > 1 ||
      !validatePeerLimits(advertisement)) {
      return this._rejectMessage(
        message,
        baEnum.ErrorCode.PARAMETER_OUT_OF_RANGE,
        'invalid-advertisement',
        'Discarded invalid BACnet/SC Advertisement data',
        0,
        socket,
        generation
      );
    }
    this._recordBvlcActivity();
    this.emit('advertisement', Object.assign({}, advertisement));
    return true;
  }

  _sendAdvertisement(message, socket, generation) {
    const payload = Buffer.alloc(6);
    payload[0] = this._hubIndex === 0 ? 1 : 2;
    payload[1] = 0;
    payload.writeUInt16BE(this._settings.maxBvlc, 2);
    payload.writeUInt16BE(this._settings.maxNpdu, 4);
    const options = {
      id: this._nextMessageId(),
      payload: payload
    };
    if (message.originating) options.destination = message.originating;
    return this._sendScMessage(
      baScMessage.FUNCTIONS.ADVERTISEMENT,
      options,
      socket,
      generation
    );
  }

  _decodeBvlcResult(message) {
    try {
      return baScMessage.decodeBvlcResultPayload(message.payload);
    } catch (err) {
      this._emitDiagnostic('malformed-bvlc-result', 'Discarded a malformed BACnet/SC BVLC-Result', {
        messageId: message.id,
        error: err.message
      });
      return null;
    }
  }

  _handleConnectResult(message, socket, generation) {
    const result = this._decodeBvlcResult(message);
    if (!result || result.resultCode !== 1 ||
      result.forFunction !== baScMessage.FUNCTIONS.CONNECT_REQUEST) {
      this._emitDiagnostic('unexpected-connect-result', 'Ignored an unexpected BACnet/SC Connect result', {
        messageId: message.id,
        result: result
      });
      return false;
    }

    if (result.errorCode === baEnum.ErrorCode.NODE_DUPLICATE_VMAC) {
      const previousVmac = baScMessage.formatVmac(this._settings.vmac);
      let replacementVmac;
      do {
        replacementVmac = baScMessage.makeRandomVmac();
      } while (replacementVmac === previousVmac);
      this._settings.vmac = replacementVmac;
      this._emitDiagnostic('duplicate-vmac', 'BACnet/SC hub rejected a duplicate VMAC; generated a replacement', {
        previousVmac: previousVmac,
        replacementVmac: replacementVmac
      });
    }

    const err = makeError('BACNET_SC_CONNECT_REJECTED', 'BACnet/SC hub rejected the Connect-Request');
    return this._failConnection(
      err,
      'BACNET_SC_CONNECT_REJECTED',
      {
        closeCode: 1000,
        closeReason: 'Connect rejected',
        details: {result: result}
      },
      socket,
      generation
    );
  }

  _acceptConnection(message, socket, generation) {
    let connect;
    try {
      connect = baScMessage.decodeConnectPayload(message.payload);
    } catch (err) {
      const code = err.code === 'BACNET_SC_INVALID_MAX_BVLC' ||
        err.code === 'BACNET_SC_INVALID_MAX_NPDU' ||
        err.code === 'BACNET_SC_INCONSISTENT_MAX_LENGTHS' ?
        'BACNET_SC_INVALID_PEER_LIMITS' : 'BACNET_SC_MALFORMED_CONNECT_ACCEPT';
      this._failConnection(
        makeError(code, err.message),
        code,
        {},
        socket,
        generation
      );
      return false;
    }
    if (!validatePeerLimits(connect)) {
      this._failConnection(
        makeError('BACNET_SC_INVALID_PEER_LIMITS', 'BACnet/SC hub advertised invalid BVLC/NPDU limits'),
        'BACNET_SC_INVALID_PEER_LIMITS',
        {},
        socket,
        generation
      );
      return false;
    }

    this._peer = Object.freeze(Object.assign({}, connect));
    this._connected = true;
    this._state = 'connected';
    this._reconnectDelay = this._settings.reconnectMin;
    this._reconnectAttempts = 0;
    this._lastConnectedAt = new Date().toISOString();
    this._clearConnectionTimer();
    this._recordBvlcActivity();
    this._startHeartbeat(socket, generation);
    this._emitDiagnostic('connected', 'BACnet/SC hub connection accepted', connect);
    if (!this._isCurrentSocket(socket, generation) || this._manualClose ||
      this._failureGeneration === generation || !this._connected || this._state !== 'connected') return true;
    this.emit('open', Object.assign({}, this._peer));
    if (!this._isCurrentSocket(socket, generation) || this._manualClose ||
      this._failureGeneration === generation || !this._connected || this._state !== 'connected') return true;
    this._flushPendingSends(socket, generation);
    if (this._isCurrentSocket(socket, generation) && !this._manualClose &&
      this._failureGeneration !== generation && this._connected && this._state === 'connected') {
      if (this._hubIndex === 0) {
        this._primaryProbeDelay = this._settings.reconnectMin;
        this._clearPrimaryProbe();
      } else {
        this._schedulePrimaryProbe();
      }
    }
    return true;
  }

  _handleBvlcResult(message) {
    const result = this._decodeBvlcResult(message);
    if (!result) return false;
    this._recordBvlcActivity();
    if (result.resultCode !== 0) {
      this._emitError('BACNET_SC_BVLC_RESULT_NAK', 'BACnet/SC BVLC-Result NAK', result);
    } else {
      this._emitDiagnostic('bvlc-result', 'BACnet/SC BVLC-Result ACK', result);
    }
    return true;
  }

  _emitNpdu(message) {
    if (!this._connected || this._state !== 'connected' || this._manualClose) return false;
    // The shared client parser consumes a BACnet/IP-style four-octet BVLC
    // envelope. This local adapter is never placed on the BACnet/SC wire.
    const func = message.destination === baScMessage.BROADCAST_VMAC ?
      baEnum.BvlcResultPurpose.ORIGINAL_BROADCAST_NPDU :
      baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU;
    const framed = Buffer.alloc(baEnum.BVLC_HEADER_LENGTH + message.payload.length);
    const remoteAddress = message.originating || (this._peer && this._peer.vmac) || 'bacnet-sc';
    const dataOptions = (message.dataOptions || []).map((option) => {
      const copy = {
        marker: option.marker,
        type: option.type,
        everySegment: option.everySegment
      };
      if (option.data) copy.data = Buffer.from(option.data);
      return Object.freeze(copy);
    });
    const linkContext = Object.freeze({
      transport: 'bacnet-sc',
      messageId: message.id,
      originating: message.originating || null,
      destination: message.destination || null,
      dataOptions: Object.freeze(dataOptions)
    });

    baBvlc.encode(framed, func, framed.length);
    message.payload.copy(framed, baEnum.BVLC_HEADER_LENGTH);
    this.emit('message', framed, remoteAddress, 0, linkContext);
    return true;
  }

  _sendNpdu(item) {
    const maximum = this._getOutboundNpduLimit();
    if (!this._connected || !this._peer || item.payload.length > maximum) {
      if (this._peer && item.payload.length > maximum) {
        if (item.payload.length > this._peer.maxNpdu) {
          this._emitError('BACNET_SC_PEER_NPDU_TOO_LARGE', 'BACnet/SC NPDU exceeds the peer payload limit');
        } else {
          this._emitError('BACNET_SC_PEER_BVLC_TOO_LARGE', 'BACnet/SC NPDU exceeds the peer BVLC limit');
        }
      }
      return false;
    }

    let destination;
    try {
      destination = this._receiverToVmac(item.receiver);
    } catch {
      this._emitError('BACNET_SC_INVALID_RECEIVER', 'Invalid BACnet/SC receiver VMAC');
      return false;
    }
    return this._sendScMessage(baScMessage.FUNCTIONS.ENCAPSULATED_NPDU, {
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

  _sendScMessage(functionCode, options, socket, generation, allowDuringDisconnect) {
    socket = socket || this._socket;
    generation = generation === undefined ? this._socketGeneration : generation;
    if (!this._isCurrentSocket(socket, generation) || !this._webSocketReady ||
      this._failureGeneration === generation || socket.readyState !== WebSocket.OPEN) return false;

    const stateAllowsSend = this._state === 'connected' ||
      this._state === 'awaiting-accept' && functionCode === baScMessage.FUNCTIONS.CONNECT_REQUEST ||
      allowDuringDisconnect === true && (
        this._state === 'awaiting-accept' || this._state === 'disconnecting'
      );
    if (!stateAllowsSend) return false;

    let payload;
    try {
      payload = baScMessage.encode(functionCode, options || {});
    } catch (err) {
      this._emitError('BACNET_SC_ENCODE_FAILED', 'Failed to encode BACnet/SC message: ' + err.message);
      return false;
    }

    const peerLimit = this._peer ?
      Math.min(this._settings.maxBvlc, this._peer.maxBvlc) : this._settings.maxBvlc;
    if (payload.length > peerLimit) {
      this._emitError('BACNET_SC_PEER_BVLC_TOO_LARGE', 'BACnet/SC message exceeds the peer BVLC limit');
      return false;
    }
    return this._writeMessage(payload, socket, generation);
  }

  _writeMessage(payload, socket, generation) {
    if (!this._isCurrentSocket(socket, generation) || this._failureGeneration === generation ||
      socket.readyState !== WebSocket.OPEN) return false;
    const bufferedAmount = socket.bufferedAmount || 0;
    if (bufferedAmount + payload.length > this._settings.maxBufferedAmount) {
      this._failConnection(
        makeError('BACNET_SC_BACKPRESSURE', 'BACnet/SC WebSocket outbound buffer limit exceeded'),
        'BACNET_SC_BACKPRESSURE',
        {},
        socket,
        generation
      );
      return false;
    }

    try {
      socket.send(payload, {binary: true, compress: false}, (err) => {
        if (err && this._isCurrentSocket(socket, generation)) {
          this._failConnection(err, 'BACNET_SC_SOCKET_ERROR', {}, socket, generation);
        }
      });
      return true;
    } catch (err) {
      this._failConnection(err, 'BACNET_SC_SOCKET_ERROR', {}, socket, generation);
      return false;
    }
  }

  _flushPendingSends(socket, generation) {
    const pending = this._pendingSends;
    this._pendingSends = [];
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      this._settlePendingSend(item);
      if (item.signal && item.signal.aborted) {
        this._emitDiagnostic('send-aborted', 'Dropped an aborted BACnet/SC queued NPDU', {
          queuedAt: item.queuedAt
        });
      } else if (item.deadline !== null && Date.now() >= item.deadline || monotonicNow() >= item.expiresAt) {
        this._emitDiagnostic('send-expired', 'Dropped an expired BACnet/SC queued NPDU', {
          queuedAt: item.queuedAt
        });
      } else if (this._isCurrentSocket(socket, generation) && this._connected) {
        if (!this._sendNpdu(item)) {
          const remaining = pending.length - i - 1;
          if (remaining > 0) {
            for (let j = i + 1; j < pending.length; j++) this._settlePendingSend(pending[j]);
            this._emitDiagnostic('send-dropped', 'Dropped queued BACnet/SC NPDUs after a send failure', {
              count: remaining
            });
          }
          break;
        }
      }
    }
  }

  _expirePendingSend(item) {
    const index = this._pendingSends.indexOf(item);
    if (index === -1) return;
    this._pendingSends.splice(index, 1);
    this._settlePendingSend(item);
    this._emitDiagnostic('send-expired', 'Dropped an expired BACnet/SC queued NPDU', {
      queuedAt: item.queuedAt
    });
  }

  _abortPendingSend(item) {
    const index = this._pendingSends.indexOf(item);
    if (index === -1) return;
    this._pendingSends.splice(index, 1);
    this._settlePendingSend(item);
    this._emitDiagnostic('send-aborted', 'Dropped an aborted BACnet/SC queued NPDU', {
      queuedAt: item.queuedAt
    });
  }

  _settlePendingSend(item) {
    if (item.settled) return;
    item.settled = true;
    if (item.timeout) clearTimeout(item.timeout);
    item.timeout = null;
    if (item.signal && item.abortHandler) {
      item.signal.removeEventListener('abort', item.abortHandler);
    }
    item.abortHandler = null;
  }

  _clearPendingSends(code) {
    const pending = this._pendingSends;
    this._pendingSends = [];
    pending.forEach((item) => this._settlePendingSend(item));
    if (pending.length > 0) {
      this._emitDiagnostic(code, 'Cleared queued BACnet/SC NPDUs', {count: pending.length});
    }
  }

  _nextMessageId() {
    const id = this._messageId++;
    if (this._messageId > 0xFFFF) this._messageId = 1;
    return id;
  }

  _recordBvlcActivity(acknowledgeHeartbeat) {
    const now = monotonicNow();
    this._lastBvlcActivityAt = now;
    if (acknowledgeHeartbeat) {
      this._heartbeatPendingAt = null;
      this._heartbeatRequestId = null;
    }
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = null;
    if (this._settings.heartbeatInterval > 0 && this._connected && this._state === 'connected' &&
      this._isCurrentSocket(this._socket, this._socketGeneration)) {
      const delay = this._heartbeatPendingAt === null ? this._settings.heartbeatInterval :
        Math.max(1, this._settings.heartbeatTimeout - (now - this._heartbeatPendingAt));
      this._scheduleHeartbeatCheck(
        delay,
        this._socket,
        this._socketGeneration
      );
    }
  }

  _startHeartbeat(socket, generation) {
    this._clearHeartbeatTimer();
    if (this._settings.heartbeatInterval === 0) return;
    if (this._lastBvlcActivityAt === null) this._lastBvlcActivityAt = monotonicNow();
    this._scheduleHeartbeatCheck(this._settings.heartbeatInterval, socket, generation);
  }

  _scheduleHeartbeatCheck(delay, socket, generation) {
    this._heartbeatTimer = setTimeout(() => {
      this._heartbeatTimer = null;
      this._heartbeatCheck(socket, generation);
    }, Math.max(1, Math.ceil(delay)));
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  _heartbeatCheck(socket, generation) {
    if (!this._isCurrentSocket(socket, generation) || !this._connected || this._state !== 'connected') return;
    const now = monotonicNow();
    if (this._heartbeatPendingAt !== null) {
      const remaining = this._settings.heartbeatTimeout - (now - this._heartbeatPendingAt);
      if (remaining <= 0) {
        this._beginFailedDisconnect(
          makeError('BACNET_SC_HEARTBEAT_TIMEOUT', 'BACnet/SC heartbeat response timed out'),
          'BACNET_SC_HEARTBEAT_TIMEOUT',
          socket,
          generation
        );
        return;
      }
      this._scheduleHeartbeatCheck(remaining, socket, generation);
      return;
    }

    const remaining = this._settings.heartbeatInterval - (now - this._lastBvlcActivityAt);
    if (remaining > 0) {
      this._scheduleHeartbeatCheck(remaining, socket, generation);
      return;
    }

    const messageId = this._nextMessageId();
    if (this._sendScMessage(
      baScMessage.FUNCTIONS.HEARTBEAT_REQUEST,
      {id: messageId},
      socket,
      generation
    )) {
      this._heartbeatPendingAt = monotonicNow();
      this._heartbeatRequestId = messageId;
      this._scheduleHeartbeatCheck(this._settings.heartbeatTimeout, socket, generation);
    }
  }

  _startConnectionTimer(code, timeout, socket, generation) {
    this._clearConnectionTimer();
    this._connectionTimer = setTimeout(() => {
      this._connectionTimer = null;
      if (!this._isCurrentSocket(socket, generation)) return;
      this._failConnection(makeError(code, code), code, {}, socket, generation);
    }, timeout);
    if (this._connectionTimer.unref) this._connectionTimer.unref();
  }

  _startDisconnectTimer(socket, generation) {
    this._clearDisconnectTimer();
    this._disconnectTimer = setTimeout(() => {
      this._disconnectTimer = null;
      this._closeSocket(socket, generation, true);
    }, this._settings.disconnectTimeout);
    if (this._disconnectTimer.unref) this._disconnectTimer.unref();
  }

  _clearHeartbeatTimer() {
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = null;
    this._lastBvlcActivityAt = null;
    this._heartbeatPendingAt = null;
    this._heartbeatRequestId = null;
  }

  _clearConnectionTimer() {
    if (this._connectionTimer) clearTimeout(this._connectionTimer);
    this._connectionTimer = null;
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
  }

  _clearPrimaryProbe() {
    if (this._primaryProbeTimer) clearTimeout(this._primaryProbeTimer);
    this._primaryProbeTimer = null;
    const probe = this._primaryProbe;
    this._primaryProbe = null;
    if (probe) probe.close();
  }

  _clearDisconnectTimer() {
    if (this._disconnectTimer) clearTimeout(this._disconnectTimer);
    this._disconnectTimer = null;
  }

  _createPrimaryProbeTransport() {
    return new BacnetScTransport({
      hubUrl: this._hubs[0],
      cert: this._settings.cert,
      key: this._settings.key,
      pfx: this._settings.pfx,
      ca: this._settings.ca,
      passphrase: this._settings.passphrase,
      rejectUnauthorized: this._settings.rejectUnauthorized,
      requireClientCertificate: this._settings.requireClientCertificate,
      servername: this._settings.servername,
      checkServerIdentity: this._settings.checkServerIdentity,
      verifyServerIdentity: this._settings.verifyServerIdentity,
      allowSystemTrust: this._settings.allowSystemTrust,
      tlsOptions: Object.assign({}, this._settings.tlsOptions),
      tlsVersion: this._settings.tlsVersion,
      tlsMinVersion: this._settings.tlsMinVersion,
      tlsMaxVersion: this._settings.tlsMaxVersion,
      allowInsecureTls: this._settings.allowInsecureTls,
      allowPlain: this._settings.allowPlain,
      vmac: this._settings.vmac,
      uuid: this._settings.uuid,
      maxBvlc: this._settings.maxBvlc,
      maxNpdu: this._settings.maxNpdu,
      connectionWaitTimeout: this._settings.connectionWaitTimeout,
      webSocketWaitTimeout: this._settings.webSocketWaitTimeout,
      heartbeatInterval: 0,
      heartbeatTimeout: 0,
      disconnectTimeout: this._settings.disconnectTimeout,
      reconnect: false,
      reconnectMin: this._settings.reconnectMin,
      reconnectMax: this._settings.reconnectMax,
      sendQueueLimit: 0,
      sendQueueTimeout: 0,
      maxHandshakeBytes: this._settings.maxHandshakeBytes,
      maxBufferedAmount: this._settings.maxBufferedAmount
    }, PRIMARY_PROBE_TOKEN);
  }

  _schedulePrimaryProbe() {
    if (!this._settings.reconnect || this._manualClose || this._hubs.length < 2 ||
      this._hubIndex === 0 || !this._connected || this._state !== 'connected' ||
      this._primaryProbeTimer || this._primaryProbe) return;

    const delay = this._primaryProbeDelay;
    this._emitDiagnostic('primary-probe-scheduled', 'Scheduling a BACnet/SC primary hub probe', {
      delay: delay,
      hubUrl: this._hubs[0]
    });
    if (this._manualClose || this._hubIndex === 0 || !this._connected ||
      this._state !== 'connected' || this._primaryProbeTimer || this._primaryProbe) return;
    this._primaryProbeTimer = setTimeout(() => {
      this._primaryProbeTimer = null;
      this._startPrimaryProbe();
    }, delay);
    if (this._primaryProbeTimer.unref) this._primaryProbeTimer.unref();
  }

  _startPrimaryProbe() {
    if (!this._settings.reconnect || this._manualClose || this._hubs.length < 2 ||
      this._hubIndex === 0 || !this._connected || this._state !== 'connected' || this._primaryProbe) return;

    let probe;
    try {
      probe = this._createPrimaryProbeTransport();
    } catch (err) {
      this._emitDiagnostic('primary-probe-failed', 'Could not create a BACnet/SC primary hub probe', {
        error: err.message,
        hubUrl: this._hubs[0]
      });
      this._primaryProbeDelay = Math.min(this._primaryProbeDelay * 2, this._settings.reconnectMax);
      this._schedulePrimaryProbe();
      return;
    }

    this._primaryProbe = probe;
    let accepted = false;
    let settled = false;
    const finish = (success) => {
      if (settled) return;
      settled = true;
      if (this._primaryProbe !== probe) return;
      this._primaryProbe = null;
      if (success && !this._manualClose && this._hubIndex !== 0 &&
        this._connected && this._state === 'connected') {
        this._primaryProbeDelay = this._settings.reconnectMin;
        this._requestPrimaryFailback();
      } else if (!this._manualClose && this._hubIndex !== 0 &&
        this._connected && this._state === 'connected') {
        this._primaryProbeDelay = Math.min(this._primaryProbeDelay * 2, this._settings.reconnectMax);
        this._schedulePrimaryProbe();
      }
    };

    probe.on('error', (err) => {
      this._emitDiagnostic('primary-probe-failed', 'BACnet/SC primary hub probe failed', {
        error: err.message,
        hubUrl: this._hubs[0]
      });
      finish(false);
      probe.close();
    });
    probe.on('open', () => {
      if (this._primaryProbe !== probe || this._manualClose || this._hubIndex === 0 ||
        !this._connected || this._state !== 'connected') {
        finish(false);
        probe.close();
        return;
      }
      accepted = true;
      this._emitDiagnostic('primary-probe-accepted', 'BACnet/SC primary hub accepted a probe connection', {
        hubUrl: this._hubs[0]
      });
      probe.close();
    });
    probe.on('diagnostic', (event) => {
      if (!accepted && event.code === 'websocket-close') finish(false);
    });
    probe.on('close', () => finish(accepted));
    if (!probe.open()) finish(false);
  }

  _requestPrimaryFailback() {
    const socket = this._socket;
    const generation = this._socketGeneration;
    if (this._manualClose || this._hubIndex === 0 || !this._connected ||
      this._state !== 'connected' || !this._isCurrentSocket(socket, generation)) return false;

    this._nextReconnectHubIndex = 0;
    this._retryOnClose = true;
    this._clearHeartbeatTimer();
    this._clearDisconnectTimer();
    this._state = 'disconnecting';
    this._disconnectRequestId = this._nextMessageId();
    const sent = this._sendScMessage(
      baScMessage.FUNCTIONS.DISCONNECT_REQUEST,
      {id: this._disconnectRequestId},
      socket,
      generation,
      true
    );
    if (!sent) this._closeSocket(socket, generation, false);
    this._startDisconnectTimer(socket, generation);
    this._emitDiagnostic('primary-failback', 'Switching BACnet/SC traffic back to the primary hub', {
      fromHubUrl: this._hubs[this._hubIndex],
      primaryHubUrl: this._hubs[0]
    });
    return true;
  }

  _reportConnectionFailure(err, code, options, socket) {
    options = options || {};
    code = code || err.code || 'BACNET_SC_CONNECTION_FAILED';
    const message = err.message || String(err);
    const details = Object.assign({
      hubUrl: this._hubs[this._hubIndex],
      hubIndex: this._hubIndex,
      authorizationError: socket && socket._socket && socket._socket.authorizationError
    }, options.details || {});
    let retryable = this._settings.reconnect && !this._manualClose;
    if (options.retryable === false) retryable = false;

    if (this._manualClose || (this._state === 'disconnecting' && !this._retryOnClose)) {
      this._emitDiagnostic(code, message, details);
      retryable = false;
    } else if (retryable && !this._settings.emitTransientErrors) {
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
    return {code: code, retryable: retryable};
  }

  _beginFailedDisconnect(err, code, socket, generation) {
    if (!this._isCurrentSocket(socket, generation) || this._state !== 'connected') return false;
    const failure = this._reportConnectionFailure(err, code, {}, socket);

    this._retryOnClose = failure.retryable;
    this._clearConnectionTimer();
    this._clearHeartbeatTimer();
    this._clearDisconnectTimer();
    this._state = 'disconnecting';
    this._disconnectRequestId = this._nextMessageId();
    const sent = this._sendScMessage(
      baScMessage.FUNCTIONS.DISCONNECT_REQUEST,
      {id: this._disconnectRequestId},
      socket,
      generation,
      true
    );
    if (!sent) this._closeSocket(socket, generation, false);
    this._startDisconnectTimer(socket, generation);
    return false;
  }

  _failConnection(err, code, options, socket, generation) {
    options = options || {};
    socket = socket === undefined ? this._socket : socket;
    generation = generation === undefined ? this._socketGeneration : generation;
    if (socket && !this._isCurrentSocket(socket, generation)) return false;
    if (socket && this._failureGeneration === generation) return false;

    const failure = this._reportConnectionFailure(err, code, options, socket);
    code = failure.code;
    const retryable = failure.retryable;

    if (socket) {
      this._failureGeneration = generation;
      this._retryOnClose = retryable;
      this._clearConnectionTimer();
      this._clearHeartbeatTimer();
      this._clearDisconnectTimer();
      this._closeSocket(
        socket,
        generation,
        options.force === true,
        options.closeCode,
        options.closeReason
      );
      if (options.force !== true && socket.readyState !== WebSocket.CLOSED) {
        this._startDisconnectTimer(socket, generation);
      }
    } else if (retryable) {
      this._scheduleReconnect(code);
    } else {
      this._state = 'idle';
    }
    return false;
  }

  _onSocketClose(socket, generation, code, reason) {
    if (!this._isCurrentSocket(socket, generation)) return;
    const wasConnected = this._connected;
    const disconnectShouldReconnect = this._state === 'disconnecting' && this._retryOnClose;
    const intentional = this._manualClose;
    const failed = this._failureGeneration === generation;
    const retryable = failed || disconnectShouldReconnect ?
      this._retryOnClose : this._settings.reconnect && !intentional;
    const reconnectHubIndex = this._nextReconnectHubIndex !== null ?
      this._nextReconnectHubIndex : (wasConnected ? 0 : null);
    const reasonText = reason ? Buffer.from(reason).toString('utf8') : '';
    const closeDetails = {
      code: code,
      reason: reasonText,
      intentional: intentional
    };
    this._lastClose = Object.assign({timestamp: new Date().toISOString()}, closeDetails);

    this._socket = null;
    this._connected = false;
    this._webSocketReady = false;
    this._peer = null;
    this._connectRequestId = null;
    this._disconnectRequestId = null;
    this._retryOnClose = false;
    this._nextReconnectHubIndex = null;
    this._failureGeneration = null;
    if (wasConnected) this._lastDisconnectedAt = new Date().toISOString();
    this._clearConnectionTimer();
    this._clearHeartbeatTimer();
    this._clearDisconnectTimer();
    this._clearPrimaryProbe();

    this._state = 'idle';
    this._emitDiagnostic('websocket-close', 'BACnet/SC WebSocket closed', closeDetails);
    if (wasConnected || intentional) this.emit('close', closeDetails);
    if (retryable && !this._manualClose && !this._socket && this._state === 'idle') {
      this._scheduleReconnect('socket closed (' + code + ')', reconnectHubIndex);
    }
  }

  _closeSocket(socket, generation, force, code, reason) {
    if (!socket || !this._isCurrentSocket(socket, generation)) return;
    try {
      if (force || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      } else if (socket.readyState === WebSocket.OPEN) {
        socket.close(code || 1000, reason);
      } else if (socket.readyState !== WebSocket.CLOSED) {
        // A close handshake is already in progress. The disconnect timer is
        // responsible for forcing cleanup if the peer never completes it.
        return;
      }
    } catch (err) {
      this._emitDiagnostic('close-error', 'Error while closing BACnet/SC WebSocket', {error: err.message});
      try {
        socket.terminate();
      } catch {
        // The socket is already unusable; its close callback owns final cleanup.
      }
    }
  }

  _isCurrentSocket(socket, generation) {
    return !!socket && this._socket === socket && this._socketGeneration === generation;
  }

  _scheduleReconnect(reason, hubIndex) {
    if (!this._settings.reconnect || this._manualClose || this._reconnectTimer || this._hubs.length === 0) {
      if (!this._reconnectTimer) this._state = 'idle';
      return;
    }
    this._state = 'reconnecting';
    this._hubIndex = hubIndex === null || hubIndex === undefined ?
      (this._hubIndex + 1) % this._hubs.length : hubIndex;
    this._reconnectAttempts++;
    const details = {
      attempt: this._reconnectAttempts,
      delay: this._reconnectDelay,
      reason: reason,
      hubUrl: this._hubs[this._hubIndex],
      hubIndex: this._hubIndex
    };
    this.emit('reconnect', details);
    if (this._manualClose || this._state !== 'reconnecting' || this._socket) return;
    this._emitDiagnostic('reconnect', 'Scheduling BACnet/SC reconnect', details);
    if (this._manualClose || this._state !== 'reconnecting' || this._socket) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._manualClose || this._state !== 'reconnecting') return;
      this._connect(this._hubs[this._hubIndex]);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._settings.reconnectMax);
    }, this._reconnectDelay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
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
