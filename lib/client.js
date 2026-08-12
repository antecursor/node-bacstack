'use strict';

// Util Modules
const EventEmitter      = require('events').EventEmitter;
const debug             = require('debug')('bacstack');
const net               = require('node:net');

// Local Modules
const baTransport       = require('./transport');
const baScTransport     = require('./transport-bacnet-sc');
const baServices        = require('./services');
const baApdu            = require('./apdu');
const baNpdu            = require('./npdu');
const baBvlc            = require('./bvlc');
const baEnum            = require('./enum');
const TransactionManager = require('./client/transaction-manager');
const SegmentReceiver   = require('./client/segment-receiver');
const ServerTransactionManager = require('./client/server-transaction-manager');
const {
  addressKey,
  normalizeAddress
} = require('./client/address');

const DEFAULT_HOP_COUNT = 0xFF;
const BVLC_HEADER_LENGTH = baEnum.BVLC_HEADER_LENGTH;
const DEFAULT_MAX_APDU_LENGTH = 1476;
const DEFAULT_MAX_SEGMENTS_PER_TRANSFER = 1024;
const DEFAULT_ACKNOWLEDGING_PROCESS_IDENTIFIER = 57;
const MAX_BACNET_UNSIGNED = 0xFFFFFFFF;
const SEGMENTED_COMPLEX_ACK_HEADER_LENGTH = 5;
const CONFIRMED_FAILURE_PDUS = Object.freeze([
  baEnum.PduTypes.ERROR,
  baEnum.PduTypes.REJECT,
  baEnum.PduTypes.ABORT
]);
const MAX_APDU_BYTES = Object.freeze({
  [baEnum.MaxApduLengthAccepted.OCTETS_50]: 50,
  [baEnum.MaxApduLengthAccepted.OCTETS_128]: 128,
  [baEnum.MaxApduLengthAccepted.OCTETS_206]: 206,
  [baEnum.MaxApduLengthAccepted.OCTETS_480]: 480,
  [baEnum.MaxApduLengthAccepted.OCTETS_1024]: 1024,
  [baEnum.MaxApduLengthAccepted.OCTETS_1476]: 1476
});
const MAX_SEGMENT_COUNTS = Object.freeze({
  [baEnum.MaxSegmentsAccepted.SEGMENTS_0]: 0,
  [baEnum.MaxSegmentsAccepted.SEGMENTS_2]: 2,
  [baEnum.MaxSegmentsAccepted.SEGMENTS_4]: 4,
  [baEnum.MaxSegmentsAccepted.SEGMENTS_8]: 8,
  [baEnum.MaxSegmentsAccepted.SEGMENTS_16]: 16,
  [baEnum.MaxSegmentsAccepted.SEGMENTS_32]: 32,
  [baEnum.MaxSegmentsAccepted.SEGMENTS_64]: 64
});
const SIMPLE_ACK_SERVICES = new Set([
  baEnum.ConfirmedServiceChoice.ACKNOWLEDGE_ALARM,
  baEnum.ConfirmedServiceChoice.CONFIRMED_COV_NOTIFICATION,
  baEnum.ConfirmedServiceChoice.CONFIRMED_EVENT_NOTIFICATION,
  baEnum.ConfirmedServiceChoice.SUBSCRIBE_COV,
  baEnum.ConfirmedServiceChoice.WRITE_PROPERTY,
  baEnum.ConfirmedServiceChoice.WRITE_PROPERTY_MULTIPLE,
  baEnum.ConfirmedServiceChoice.DEVICE_COMMUNICATION_CONTROL,
  baEnum.ConfirmedServiceChoice.REINITIALIZE_DEVICE,
  baEnum.ConfirmedServiceChoice.DELETE_OBJECT,
  baEnum.ConfirmedServiceChoice.ADD_LIST_ELEMENT,
  baEnum.ConfirmedServiceChoice.REMOVE_LIST_ELEMENT,
  baEnum.ConfirmedServiceChoice.LIFE_SAFETY_OPERATION,
  baEnum.ConfirmedServiceChoice.SUBSCRIBE_COV_PROPERTY
]);
const COMPLEX_ACK_SERVICES = new Set([
  baEnum.ConfirmedServiceChoice.GET_ALARM_SUMMARY,
  baEnum.ConfirmedServiceChoice.GET_ENROLLMENT_SUMMARY,
  baEnum.ConfirmedServiceChoice.ATOMIC_READ_FILE,
  baEnum.ConfirmedServiceChoice.ATOMIC_WRITE_FILE,
  baEnum.ConfirmedServiceChoice.CREATE_OBJECT,
  baEnum.ConfirmedServiceChoice.READ_PROPERTY,
  baEnum.ConfirmedServiceChoice.READ_PROPERTY_MULTIPLE,
  baEnum.ConfirmedServiceChoice.CONFIRMED_PRIVATE_TRANSFER,
  baEnum.ConfirmedServiceChoice.READ_RANGE,
  baEnum.ConfirmedServiceChoice.GET_EVENT_INFORMATION
]);
const CONFIRMED_SERVICE_DEFINITIONS = new Map([
  [baEnum.ConfirmedServiceChoice.READ_PROPERTY,
    {event: 'readProperty', decoder: baServices.readProperty.decode}],
  [baEnum.ConfirmedServiceChoice.WRITE_PROPERTY,
    {event: 'writeProperty', decoder: baServices.writeProperty.decode}],
  [baEnum.ConfirmedServiceChoice.READ_PROPERTY_MULTIPLE,
    {event: 'readPropertyMultiple', decoder: baServices.readPropertyMultiple.decode}],
  [baEnum.ConfirmedServiceChoice.WRITE_PROPERTY_MULTIPLE,
    {event: 'writePropertyMultiple', decoder: baServices.writePropertyMultiple.decode}],
  [baEnum.ConfirmedServiceChoice.CONFIRMED_COV_NOTIFICATION,
    {event: 'covNotify', decoder: baServices.covNotify.decode}],
  [baEnum.ConfirmedServiceChoice.ATOMIC_WRITE_FILE,
    {event: 'atomicWriteFile', decoder: baServices.atomicWriteFile.decode}],
  [baEnum.ConfirmedServiceChoice.ATOMIC_READ_FILE,
    {event: 'atomicReadFile', decoder: baServices.atomicReadFile.decode}],
  [baEnum.ConfirmedServiceChoice.SUBSCRIBE_COV,
    {event: 'subscribeCOV', decoder: baServices.subscribeCov.decode}],
  [baEnum.ConfirmedServiceChoice.SUBSCRIBE_COV_PROPERTY,
    {event: 'subscribeProperty', decoder: baServices.subscribeProperty.decode}],
  [baEnum.ConfirmedServiceChoice.DEVICE_COMMUNICATION_CONTROL,
    {event: 'deviceCommunicationControl', decoder: baServices.deviceCommunicationControl.decode}],
  [baEnum.ConfirmedServiceChoice.REINITIALIZE_DEVICE,
    {event: 'reinitializeDevice', decoder: baServices.reinitializeDevice.decode}],
  [baEnum.ConfirmedServiceChoice.CONFIRMED_EVENT_NOTIFICATION,
    {event: 'eventNotifyData', decoder: baServices.eventNotifyData.decode}],
  [baEnum.ConfirmedServiceChoice.READ_RANGE,
    {event: 'readRange', decoder: baServices.readRange.decode}],
  [baEnum.ConfirmedServiceChoice.CREATE_OBJECT,
    {event: 'createObject', decoder: baServices.createObject.decode}],
  [baEnum.ConfirmedServiceChoice.DELETE_OBJECT,
    {event: 'deleteObject', decoder: baServices.deleteObject.decode}],
  [baEnum.ConfirmedServiceChoice.ACKNOWLEDGE_ALARM,
    {event: 'alarmAcknowledge', decoder: baServices.alarmAcknowledge.decode}],
  [baEnum.ConfirmedServiceChoice.GET_ALARM_SUMMARY,
    {event: 'getAlarmSummary', decoder: null}],
  // Keep the historical misspelling as the public event name for compatibility.
  [baEnum.ConfirmedServiceChoice.GET_ENROLLMENT_SUMMARY,
    {
      event: ['getEnrollmentSummary', 'getEntrollmentSummary'],
      decoder: baServices.getEnrollmentSummary.decode
    }],
  [baEnum.ConfirmedServiceChoice.GET_EVENT_INFORMATION,
    {event: 'getEventInformation', decoder: baServices.getEventInformation.decode}],
  [baEnum.ConfirmedServiceChoice.LIFE_SAFETY_OPERATION,
    {event: 'lifeSafetyOperation', decoder: baServices.lifeSafetyOperation.decode}],
  [baEnum.ConfirmedServiceChoice.ADD_LIST_ELEMENT,
    {event: 'addListElement', decoder: baServices.addListElement.decode}],
  [baEnum.ConfirmedServiceChoice.REMOVE_LIST_ELEMENT,
    {event: 'removeListElement', decoder: baServices.addListElement.decode}],
  [baEnum.ConfirmedServiceChoice.CONFIRMED_PRIVATE_TRANSFER,
    {event: 'privateTransfer', decoder: baServices.privateTransfer.decode}]
]);

function clientError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function maxApduBytes(value) {
  const bytes = MAX_APDU_BYTES[value];
  if (bytes == null) throw clientError('ERR_INVALID_MAX_APDU');
  return bytes;
}

function maxSegmentPolicy(value, configuredLimit) {
  let requestedLimit = MAX_SEGMENT_COUNTS[value];
  if (value === baEnum.MaxSegmentsAccepted.SEGMENTS_65) requestedLimit = configuredLimit;
  if (requestedLimit == null) throw clientError('ERR_INVALID_MAX_SEGMENTS');
  const limit = Math.min(requestedLimit, configuredLimit);
  let encoded = baEnum.MaxSegmentsAccepted.SEGMENTS_0;
  [
    [65, baEnum.MaxSegmentsAccepted.SEGMENTS_65],
    [64, baEnum.MaxSegmentsAccepted.SEGMENTS_64],
    [32, baEnum.MaxSegmentsAccepted.SEGMENTS_32],
    [16, baEnum.MaxSegmentsAccepted.SEGMENTS_16],
    [8, baEnum.MaxSegmentsAccepted.SEGMENTS_8],
    [4, baEnum.MaxSegmentsAccepted.SEGMENTS_4],
    [2, baEnum.MaxSegmentsAccepted.SEGMENTS_2]
  ].some(([minimum, code]) => {
    if (limit < minimum) return false;
    encoded = code;
    return true;
  });
  const enforcedLimit = encoded === baEnum.MaxSegmentsAccepted.SEGMENTS_65 ?
    limit : MAX_SEGMENT_COUNTS[encoded];
  return {encoded, limit: enforcedLimit};
}

/**
 * Immutable, generation-bound terminal responder attached to exactly one
 * inbound confirmed-request event. The first terminal operation wins; later,
 * stale, expired, or mismatched uses throw a stable local error.
 *
 * @typedef {object} ConfirmedReply
 * @property {BacnetAddress} address - Frozen public peer address.
 * @property {number} deadline - Absolute transaction expiry timestamp.
 * @property {number} invokeId - Fixed request invoke ID.
 * @property {number} maxApdu - Maximum response APDU bytes advertised by the requester.
 * @property {number} service - Fixed confirmed service choice.
 * @property {function(): (boolean|undefined)} simpleAck - Send a legal SimpleACK.
 * @property {function((Buffer|Uint8Array|function(object))): (boolean|undefined)} complexAck - Encode an isolated ComplexACK payload.
 * @property {function(number, number): (boolean|undefined)} error - Send an Error PDU.
 * @property {function(number): (boolean|undefined)} reject - Send a Reject PDU.
 * @property {function(number): (boolean|undefined)} abort - Send a server Abort PDU.
 * @property {function(object, object, object[]): (boolean|undefined)} readProperty - Send a typed ReadProperty ComplexACK.
 * @property {function(object[]): (boolean|undefined)} readPropertyMultiple - Send a typed ReadPropertyMultiple ComplexACK.
 */

/**
 * A direct BACnet/IP peer. Omitting `port` uses the client's destination port.
 *
 * @typedef {object} DirectBacnetIpAddress
 * @property {string} ip BACnet/IP peer IPv4 address or DNS hostname
 * @property {number=} port UDP destination port from 1 through 65535
 */

/**
 * A routed BACnet peer. Supply exactly one link address (`ip` or `vmac`) plus
 * the destination network and MAC address.
 *
 * @typedef {object} RoutedBacnetAddress
 * @property {string=} ip BACnet/IP router IPv4 address or DNS hostname
 * @property {number=} port BACnet/IP router UDP port from 1 through 65535
 * @property {string=} vmac BACnet/SC router VMAC as 12 hexadecimal characters
 * @property {number} net destination network from 1 through 65534
 * @property {(Buffer|number[])} adr destination MAC as 1 through 255 octets
 */

/**
 * A direct BACnet/IP address, direct BACnet/SC VMAC, or routed peer.
 * String interpretation follows the active transport's address kind.
 *
 * @typedef {(string|DirectBacnetIpAddress|RoutedBacnetAddress)} BacnetAddress
 */

/**
 * BACnet object identifier.
 *
 * @typedef {object} BacnetObjectId
 * @property {number} type object type
 * @property {number=} instance object instance; some creation requests allow it to be omitted
 */

/**
 * BACnet property identifier and optional array index.
 *
 * @typedef {object} BacnetPropertyReference
 * @property {number} id property identifier
 * @property {number=} index array index; omit it to address the complete property value
 */

/**
 * Typed BACnet application value. `type`, rather than the historical `tag`
 * spelling, is the field consumed by the runtime encoders.
 *
 * @typedef {object} BacnetApplicationValue
 * @property {ApplicationTags} type application tag
 * @property {*} value value accepted by that application tag's encoder
 */

/**
 * Detached link-layer context supplied for BACnet/SC and forwarded BACnet/IP.
 * Containers are frozen and option payloads are copied from transport input,
 * but Buffer contents remain mutable. This is diagnostic data, not an
 * authorization decision.
 *
 * @typedef {object} LinkContext
 * @property {string=} transport transport identifier
 * @property {(number|string)=} messageId BACnet/SC message identifier
 * @property {(string|object)=} originating originating VMAC or Forwarded-NPDU source
 * @property {string=} destination destination VMAC
 * @property {object[]} [dataOptions] decoded BACnet/SC Data Options
 * @property {string=} forwardedBy BACnet/IP forwarding peer
 * @property {number=} forwardedByPort BACnet/IP forwarding peer port
 * @property {boolean=} segmented whether APDU reassembly occurred
 * @property {number=} segmentCount number of reassembled segments
 * @property {Array<(number|string)>=} messageIds reassembled message identifiers
 */

/**
 * Payload delivered to an inbound confirmed-service listener. `request` is the
 * decoded service payload and is absent for a service with no request body.
 * Applications should reply only through the generation-bound `reply` object.
 *
 * @typedef {object} ConfirmedRequestEvent
 * @property {BacnetAddress} address historical direct or routed peer address
 * @property {BacnetAddress} sourceAddress canonical direct or routed peer address
 * @property {number} invokeId request invoke ID
 * @property {object=} request decoded service request
 * @property {ConfirmedReply} reply frozen terminal response capability
 * @property {LinkContext=} linkContext detached link-layer context when available
 */

/**
 * Received inbound ReadProperty request.
 * @event bacstack.readProperty
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound WriteProperty request.
 * @event bacstack.writeProperty
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound ReadPropertyMultiple request.
 * @event bacstack.readPropertyMultiple
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound WritePropertyMultiple request.
 * @event bacstack.writePropertyMultiple
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound confirmed COV notification.
 * @event bacstack.covNotify
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound AtomicWriteFile request.
 * @event bacstack.atomicWriteFile
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound AtomicReadFile request.
 * @event bacstack.atomicReadFile
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound SubscribeCOV request.
 * @event bacstack.subscribeCOV
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound SubscribeCOVProperty request.
 * @event bacstack.subscribeProperty
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound DeviceCommunicationControl request.
 * @event bacstack.deviceCommunicationControl
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound ReinitializeDevice request.
 * @event bacstack.reinitializeDevice
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound confirmed EventNotification request.
 * @event bacstack.eventNotifyData
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound ReadRange request.
 * @event bacstack.readRange
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound CreateObject request.
 * @event bacstack.createObject
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound DeleteObject request.
 * @event bacstack.deleteObject
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound AcknowledgeAlarm request.
 * @event bacstack.alarmAcknowledge
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound GetAlarmSummary request.
 * @event bacstack.getAlarmSummary
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound GetEnrollmentSummary request.
 * @event bacstack.getEnrollmentSummary
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Historical misspelling of {@link event:bacstack.getEnrollmentSummary}.
 * Register only one of the canonical or legacy event names.
 * @event bacstack.getEntrollmentSummary
 * @param {ConfirmedRequestEvent} event
 * @deprecated Use `getEnrollmentSummary`.
 */

/**
 * Received inbound GetEventInformation request.
 * @event bacstack.getEventInformation
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound LifeSafetyOperation request.
 * @event bacstack.lifeSafetyOperation
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound AddListElement request.
 * @event bacstack.addListElement
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound RemoveListElement request.
 * @event bacstack.removeListElement
 * @param {ConfirmedRequestEvent} event
 */

/**
 * Received inbound confirmed or unconfirmed PrivateTransfer data. Confirmed
 * requests expose `request`, `invokeId`, and `reply`; unconfirmed requests
 * expose `eventData` and do not have a reply capability.
 * @event bacstack.privateTransfer
 * @param {object} event
 * @param {BacnetAddress} event.address historical peer address
 * @param {BacnetAddress} event.sourceAddress canonical peer address
 * @param {number=} event.invokeId confirmed-request invoke ID
 * @param {object=} event.request decoded confirmed request
 * @param {object=} event.eventData decoded unconfirmed request
 * @param {ConfirmedReply=} event.reply confirmed-request response capability
 * @param {LinkContext=} event.linkContext detached link-layer context when available
 */

/**
 * Callback used by confirmed client service methods.
 *
 * @callback ConfirmedCallback
 * @param {?Error} error local, transport, decode, or remote BACnet failure
 * @param {*=} value decoded service result
 * @param {LinkContext=} linkContext detached link-layer context when available
 */

/**
 * Options shared by confirmed client service methods. Service-specific options
 * documented on an individual method may be supplied alongside these fields.
 *
 * @typedef {object} ConfirmedRequestOptions
 * @property {MaxSegmentsAccepted=} maxSegments advertised response segment limit
 * @property {MaxApduLengthAccepted=} maxApdu advertised response APDU limit
 * @property {number=} invokeId explicit invoke ID from 0 through 255
 * @property {number=} timeout time to an unsegmented response or first response segment, in milliseconds
 * @property {AbortSignal=} signal cancellation signal that remains active during reassembly
 */

/**
 * Client construction options. BACnet/SC transport-specific trust, reconnect,
 * and queue options are detailed in `BACNET_SC.md`.
 *
 * @typedef {object} ClientOptions
 * @property {(object|string)=} transport custom transport or `bacnet-sc`
 * @property {('ip'|'vmac')=} addressKind string-address kind for a custom transport
 * @property {number=} port local BACnet/IP port; 0 requests an ephemeral port
 * @property {number=} destinationPort BACnet/IP destination port from 1 through 65535
 * @property {string=} interface local BACnet/IP IPv4 interface
 * @property {string=} broadcastAddress BACnet/IP IPv4 broadcast address
 * @property {number=} apduTimeout initial confirmed-response timeout in milliseconds
 * @property {boolean=} allowRoutedResponseFallback permit one unambiguous link-only routed response
 * @property {number=} maxTransactions maximum active outbound confirmed requests
 * @property {number=} maxTransactionPeers maximum retained outbound peer states
 * @property {number=} maxSegmentedTransfers maximum partial inbound APDUs
 * @property {number=} maxSegmentedTransfersPerPeer maximum partial APDUs per peer and direction
 * @property {number=} maxSegmentedRequestTransfers inbound-request ceiling; defaults to 31
 * @property {number=} maxSegmentsPerTransfer maximum segments in one inbound APDU
 * @property {number=} maxSegmentedBytesPerTransfer maximum bytes in one inbound APDU
 * @property {number=} maxSegmentedTotalBytes maximum bytes across partial inbound APDUs
 * @property {number=} maxSegmentedRequestBytes inbound-request byte ceiling; defaults to 3 MiB
 * @property {number=} segmentIdleTimeout refreshable segmented-APDU idle timeout
 * @property {number=} segmentAbsoluteTimeout fixed segmented-APDU lifetime
 * @property {number=} serverTransactionTimeout inbound request/reply retention; defaults to 30000 ms
 * @property {number=} maxServerTransactions maximum retained inbound requests; defaults to 1024
 * @property {number=} maxServerTransactionsPerPeer per-peer inbound request limit; defaults to 64
 * @property {number=} maxServerTransactionBytes inbound request/reply budget; defaults to 4 MiB
 * @property {boolean=} allowUntrackedServerResponses enable legacy address/invoke response helpers; defaults to false
 * @property {string=} hubUrl primary BACnet/SC hub URL
 * @property {string[]} [hubUrls] ordered BACnet/SC hub URLs
 * @property {string=} vmac local BACnet/SC VMAC
 * @property {string=} uuid local BACnet/SC UUID
 * @property {(string|Buffer)=} cert BACnet/SC operational certificate
 * @property {(string|Buffer)=} key BACnet/SC operational private key
 * @property {(string|Buffer|Array<(string|Buffer)>)=} ca BACnet/SC site CA store
 */

/**
 * To be able to communicate to BACNET devices, you have to initialize a new bacstack instance.
 * @class bacstack
 * @param {ClientOptions=} options - Client, transport, and resource-limit options.
 * @param {number=} [options.port=47808] - Local BACnet/IP UDP listening port (0-65535; 0 requests an ephemeral port).
 * @param {number=} [options.destinationPort=47808] - Remote BACnet/IP UDP port used for outgoing datagrams (1-65535).
 * @param {string=} options.interface - Specific IPv4 BACnet/IP interface if different from the primary one.
 * @param {string=} [options.broadcastAddress=255.255.255.255] - The IPv4 address used for broadcast messages.
 * @param {number=} [options.apduTimeout=3000] - The timeout in milliseconds until a transaction should be interpreted as error.
 * @param {boolean=} [options.allowRoutedResponseFallback=false] - Match routed responses by router IP and invoke ID when no source network address is present.
 * @param {number=} [options.serverTransactionTimeout=30000] - Retain inbound confirmed-request and encoded reply state for this many milliseconds.
 * @param {number=} [options.maxServerTransactions=1024] - Maximum retained inbound confirmed-request transactions.
 * @param {number=} [options.maxServerTransactionsPerPeer=64] - Maximum retained inbound confirmed-request transactions per exact peer.
 * @param {number=} [options.maxServerTransactionBytes=4194304] - Maximum bytes reserved for inbound confirmed-request reply state.
 * @param {boolean=} [options.allowUntrackedServerResponses=false] - Permit legacy address/invoke response helpers without an inbound reply capability.
 * @example
 * const bacnet = require('bacstack');
 *
 * const client = new bacnet({
 *   port: 47809,                          // Use BAC1 as communication port
 *   interface: '192.168.251.10',          // Listen on a specific interface
 *   broadcastAddress: '192.168.251.255',  // Use the subnet broadcast address
 *   apduTimeout: 6000                     // Wait twice as long for response
 * });
 */
class Client extends EventEmitter {
  constructor(options) {
    super();

    options = options || {};

    this._settings = {
      port: options.port != null ? options.port : 47808,
      destinationPort: options.destinationPort != null ? options.destinationPort : 47808,
      interface: options.interface,
      transport: options.transport,
      broadcastAddress: options.broadcastAddress != null ?
        options.broadcastAddress : '255.255.255.255',
      apduTimeout: options.apduTimeout != null ? options.apduTimeout : 3000,
      allowRoutedResponseFallback: options.allowRoutedResponseFallback === true,
      allowUntrackedServerResponses: options.allowUntrackedServerResponses === true
    };

    if (this._settings.transport === 'bacnet-sc') {
      this._transport = new baScTransport(options);
    } else {
      this._transport = this._settings.transport || new baTransport({
        port: this._settings.port,
        destinationPort: this._settings.destinationPort,
        interface: this._settings.interface,
        broadcastAddress: this._settings.broadcastAddress
      });
    }

    const ownsTransport = !options.transport || typeof options.transport === 'string';
    const attachedListeners = [];
    const listen = (event, listener) => {
      this._transport.on(event, listener);
      attachedListeners.push([event, listener]);
    };
    try {
      const reportedAddressKind = typeof this._transport.getAddressKind === 'function' ?
        this._transport.getAddressKind() : null;
      if (options.addressKind && reportedAddressKind && options.addressKind !== reportedAddressKind) {
        throw clientError(
          'ERR_ADDRESS_KIND_MISMATCH',
          'Configured address kind does not match the transport address kind'
        );
      }
      this._addressKind = reportedAddressKind || options.addressKind ||
        (this._settings.transport === 'bacnet-sc' ? 'vmac' : 'ip');
      this._maxSegmentsPerTransfer = options.maxSegmentsPerTransfer == null ?
        DEFAULT_MAX_SEGMENTS_PER_TRANSFER : options.maxSegmentsPerTransfer;
      this._segmentIdleTimeout = options.segmentIdleTimeout == null ?
        this._settings.apduTimeout : options.segmentIdleTimeout;
      this._transactions = new TransactionManager({
        defaultTimeout: this._settings.apduTimeout,
        allowRoutedResponseFallback: this._settings.allowRoutedResponseFallback,
        stringAddressKind: this._addressKind,
        maxTransactions: options.maxTransactions,
        maxPeerStates: options.maxTransactionPeers,
        segmentedResponseRetention: this._segmentIdleTimeout,
        defaultPort: this._settings.destinationPort
      });
      this._serverTransactions = new ServerTransactionManager({
        timeout: options.serverTransactionTimeout,
        maxEntries: options.maxServerTransactions,
        maxEntriesPerPeer: options.maxServerTransactionsPerPeer,
        maxBytes: options.maxServerTransactionBytes,
        maxResponseBytes: this._transport.getMaxPayload(),
        stringAddressKind: this._addressKind,
        defaultPort: this._settings.destinationPort,
        onExpire: this._onServerTransactionExpire.bind(this)
      });
      this._replyContexts = new WeakMap();
      this._segments = new SegmentReceiver({
        maxTransfers: options.maxSegmentedTransfers,
        maxTransfersPerPeer: options.maxSegmentedTransfersPerPeer,
        maxRequestTransfers: options.maxSegmentedRequestTransfers,
        maxSegments: this._maxSegmentsPerTransfer,
        maxBytesPerTransfer: options.maxSegmentedBytesPerTransfer,
        maxTotalBytes: options.maxSegmentedTotalBytes,
        maxRequestBytes: options.maxSegmentedRequestBytes,
        idleTimeout: this._segmentIdleTimeout,
        absoluteTimeout: options.segmentAbsoluteTimeout,
        onExpire: this._onSegmentExpire.bind(this)
      });
      this._closed = false;

      // Setup code
      listen('message', this._receiveData.bind(this));
      listen('error', this._receiveError.bind(this));
      listen('open', (event) => this.emit('open', event));
      listen('close', (event) => this.emit('close', event));
      listen('reconnect', (event) => this.emit('reconnect', event));
      listen('diagnostic', (event) => this.emit('diagnostic', event));
      this._transport.open();
    } catch (error) {
      try {
        if (this._serverTransactions) this._serverTransactions.close();
        if (this._segments) this._segments.cancelAll();
        if (this._transactions) this._transactions.close(error);
      } catch {
        // Preserve the construction error instead of a cleanup failure.
      }
      if (typeof this._transport.removeListener === 'function') {
        attachedListeners.forEach(([event, listener]) =>
          this._transport.removeListener(event, listener)
        );
      }
      if (ownsTransport) {
        try {
          this._transport.close();
        } catch {
          // Preserve the construction error instead of a cleanup failure.
        }
      }
      throw error;
    }
  }

  _normalizeAddress(address) {
    const normalized = normalizeAddress(
      address,
      this._addressKind,
      this._settings.destinationPort
    );
    const matchesTransport = this._addressKind === 'vmac' ?
      normalized.linkVmac != null : normalized.linkIp != null;
    if (!matchesTransport) throw clientError('ERR_ADDRESS_KIND_MISMATCH');
    if (this._addressKind === 'ip') {
      const receiver = normalized.linkIp;
      const addressVersion = net.isIP(receiver);
      let supported = addressVersion === 4;
      if (typeof this._transport.supportsAddress === 'function') {
        supported = this._transport.supportsAddress(receiver) === true;
      } else if (typeof this._transport.getIpVersion === 'function') {
        supported = this._transport.getIpVersion() === addressVersion;
      }
      if (!supported) {
        throw clientError(
          'ERR_UNSUPPORTED_ADDRESS_FAMILY',
          'The active BACnet/IP transport does not support this address family'
        );
      }
    }
    return normalized;
  }

  _linkAddress(address) {
    const normalized = this._normalizeAddress(address);
    return this._addressKind === 'vmac' ? normalized.linkVmac : normalized.linkIp;
  }

  _legacyAddress(address) {
    const normalized = this._normalizeAddress(address);
    if (normalized.kind === 'ip') {
      return normalized.port === this._settings.destinationPort ?
        normalized.ip : {ip: normalized.ip, port: normalized.port};
    }
    if (normalized.kind === 'vmac') return normalized.vmac;
    if (normalized.kind === 'routed') {
      return {
        ip: normalized.ip,
        port: normalized.port,
        net: normalized.net,
        adr: normalized.adr.slice()
      };
    }
    return {vmac: normalized.vmac, net: normalized.net, adr: normalized.adr.slice()};
  }

  _frozenPublicAddress(address) {
    const value = this._legacyAddress(address);
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value.adr)) Object.freeze(value.adr);
    return Object.freeze(value);
  }

  _sourceAddress(linkAddress, npduSource) {
    const link = this._normalizeAddress(linkAddress);
    if (!npduSource) return link;
    const routed = {
      net: npduSource.net,
      adr: npduSource.adr
    };
    if (this._addressKind === 'vmac') routed.vmac = link.linkVmac;
    else {
      routed.ip = link.linkIp;
      routed.port = link.linkPort;
    }
    return this._normalizeAddress(routed);
  }

  _eventPayload(payload, sourceAddress, metadata) {
    payload.sourceAddress = this._legacyAddress(sourceAddress);
    if (metadata) payload.linkContext = metadata;
    return payload;
  }

  _metadataSignature(metadata, everySegment) {
    if (!metadata) return '';
    const dataOptions = (metadata.dataOptions || [])
      .filter((option) => everySegment == null ||
        (option.everySegment === true) === everySegment)
      .map((option) => [
        option.type,
        option.everySegment === true,
        option.data ? Buffer.from(option.data).toString('hex') : ''
      ]);
    return JSON.stringify([
      metadata.transport || null,
      metadata.forwardedBy || null,
      metadata.forwardedByPort || null,
      metadata.originating || null,
      metadata.destination || null,
      dataOptions
    ]);
  }

  _firstMetadataSignature(metadata) {
    if (!metadata) return null;
    const dataOptions = (metadata.dataOptions || [])
      .filter((option) => option.everySegment !== true)
      .map((option) => [
        option.type,
        false,
        option.data ? Buffer.from(option.data).toString('hex') : ''
      ]);
    return dataOptions.length === 0 ? null : JSON.stringify(dataOptions);
  }

  _encodeNpdu(buffer, control, destination, source) {
    return baNpdu.encode(
      buffer,
      control,
      destination,
      source,
      DEFAULT_HOP_COUNT,
      baEnum.NetworkLayerMessageType.WHO_IS_ROUTER_TO_NETWORK,
      0
    );
  }

  _outboundApduError(cause) {
    const error = clientError(
      'ERR_OUTBOUND_APDU_TOO_LARGE',
      'Encoded BACnet frame exceeds the active transport or BVLC size limit'
    );
    if (cause) error.cause = cause;
    return error;
  }

  _validateFinalizedBuffer(buffer) {
    const maxPayload = this._transport.getMaxPayload();
    if (!buffer || !Buffer.isBuffer(buffer.buffer) ||
        !Number.isInteger(buffer.offset) ||
        buffer.offset < BVLC_HEADER_LENGTH ||
        buffer.offset > buffer.buffer.length ||
        buffer.offset > 0xFFFF ||
        !Number.isSafeInteger(maxPayload) ||
        maxPayload < BVLC_HEADER_LENGTH ||
        buffer.offset > maxPayload) {
      throw this._outboundApduError();
    }
    const declaredLength = (buffer.buffer[2] << 8) | buffer.buffer[3];
    if (buffer.buffer[0] !== baEnum.BVLL_TYPE_BACNET_IP ||
        declaredLength !== buffer.offset) {
      throw this._outboundApduError();
    }
    return buffer;
  }

  _finalizeBuffer(buffer, purpose) {
    if (!buffer || !Buffer.isBuffer(buffer.buffer) ||
        !Number.isInteger(buffer.offset) ||
        buffer.offset < BVLC_HEADER_LENGTH ||
        buffer.offset > buffer.buffer.length ||
        buffer.offset > 0xFFFF ||
        buffer.offset > this._transport.getMaxPayload()) {
      throw this._outboundApduError();
    }
    try {
      baBvlc.encode(buffer.buffer, purpose, buffer.offset);
    } catch (error) {
      throw this._outboundApduError(error);
    }
    return this._validateFinalizedBuffer(buffer);
  }

  _encodeSafely(encode) {
    try {
      return encode();
    } catch (error) {
      if (error && error.code === 'ERR_OUTBOUND_APDU_TOO_LARGE') throw error;
      if (error instanceof RangeError ||
          (error && (error.code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
            error.code === 'ERR_OUT_OF_RANGE'))) {
        throw this._outboundApduError(error);
      }
      throw error;
    }
  }

  _sendBuffer(buffer, address, context) {
    if (this._closed) throw clientError('ERR_CLIENT_CLOSED');
    this._validateFinalizedBuffer(buffer);
    const normalized = this._normalizeAddress(address);
    const receiver = this._addressKind === 'vmac' ? normalized.linkVmac : normalized.linkIp;
    if (receiver == null) throw clientError('ERR_ADDRESS_KIND_MISMATCH');
    if (this._addressKind === 'ip') {
      context = Object.assign({}, context, {destinationPort: normalized.linkPort});
    }
    return this._transport.send(buffer.buffer, buffer.offset, receiver, context);
  }

  _sendServerResponse(buffer, address, service, invokeId, generation, allowExpired) {
    if (this._closed) throw clientError('ERR_CLIENT_CLOSED');
    this._validateFinalizedBuffer(buffer);
    const frame = Buffer.from(buffer.buffer.subarray(0, buffer.offset));
    const binding = this._serverTransactions.bindResponse({
      address: address,
      invokeId: invokeId,
      service: service,
      generation: generation,
      allowExpired: allowExpired === true,
      frame: frame
    });
    if (binding.status === 'untracked' &&
        !this._settings.allowUntrackedServerResponses) {
      throw clientError('ERR_SERVER_REPLY_REQUIRED');
    }
    return this._sendBuffer({buffer: binding.frame, offset: binding.frame.length}, address);
  }

  _tryReplayServerResponse(frame, address) {
    try {
      return this._sendBuffer({buffer: frame, offset: frame.length}, address) !== false;
    } catch (error) {
      debug('Unable to replay confirmed-request response: ' + error.message);
      return false;
    }
  }

  _replyContext(reply) {
    if (!reply || typeof reply !== 'object') return null;
    return this._replyContexts.get(reply) || null;
  }

  _validateReplyIdentity(context, address, service, invokeId) {
    if (context.service !== service || context.invokeId !== invokeId ||
        addressKey(context.address) !== addressKey(this._normalizeAddress(address))) {
      throw clientError('ERR_SERVER_RESPONSE_MISMATCH');
    }
    return context;
  }

  _assertReplyByte(value, code) {
    if (!Number.isInteger(value) || value < 0 || value > 0xFF) {
      throw clientError(code);
    }
    return value;
  }

  _encodeServerReply(context, encodeApdu) {
    const buffer = this._getBuffer();
    this._encodeNpdu(
      buffer,
      baEnum.NpduControlPriority.NORMAL_MESSAGE,
      context.address
    );
    const apduOffset = buffer.offset;
    this._encodeSafely(() => encodeApdu(buffer));
    return {
      apduLength: buffer.offset - apduOffset,
      buffer: buffer
    };
  }

  _sendTrackedReply(context, encoded, allowExpired) {
    this._finalizeBuffer(
      encoded.buffer,
      baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU
    );
    return this._sendServerResponse(
      encoded.buffer,
      context.address,
      context.service,
      context.invokeId,
      context.generation,
      allowExpired
    );
  }

  _replySimpleAck(context) {
    if (!SIMPLE_ACK_SERVICES.has(context.service)) {
      throw clientError('ERR_INVALID_SERVER_REPLY');
    }
    const encoded = this._encodeServerReply(context, (buffer) =>
      baApdu.encodeSimpleAck(
        buffer,
        baEnum.PduTypes.SIMPLE_ACK,
        context.service,
        context.invokeId
      )
    );
    return this._sendTrackedReply(context, encoded);
  }

  _replyError(context, errorClass, errorCode) {
    this._assertReplyByte(errorClass, 'ERR_INVALID_ERROR_CLASS');
    this._assertReplyByte(errorCode, 'ERR_INVALID_ERROR_CODE');
    const encoded = this._encodeServerReply(context, (buffer) => {
      baApdu.encodeError(buffer, baEnum.PduTypes.ERROR, context.service, context.invokeId);
      baServices.error.encode(buffer, errorClass, errorCode);
    });
    return this._sendTrackedReply(context, encoded);
  }

  _replyReject(context, reason) {
    this._assertReplyByte(reason, 'ERR_INVALID_REJECT_REASON');
    const encoded = this._encodeServerReply(context, (buffer) =>
      baApdu.encodeAbort(buffer, baEnum.PduTypes.REJECT, context.invokeId, reason)
    );
    return this._sendTrackedReply(context, encoded);
  }

  _replyAbort(context, reason, allowExpired) {
    this._assertReplyByte(reason, 'ERR_INVALID_ABORT_REASON');
    const encoded = this._encodeServerReply(context, (buffer) =>
      baApdu.encodeAbort(
        buffer,
        baEnum.PduTypes.ABORT | baEnum.PduAbortBits.SERVER,
        context.invokeId,
        reason
      )
    );
    return this._sendTrackedReply(context, encoded, allowExpired);
  }

  _encodeComplexAckPayload(payload) {
    if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
      return Buffer.from(payload);
    }
    if (typeof payload !== 'function') throw clientError('ERR_INVALID_COMPLEX_ACK_PAYLOAD');
    const buffer = {
      buffer: Buffer.alloc(this._transport.getMaxPayload()),
      offset: 0
    };
    this._encodeSafely(() => payload(buffer));
    if (!Buffer.isBuffer(buffer.buffer) || !Number.isInteger(buffer.offset) ||
        buffer.offset < 0 ||
        buffer.offset > buffer.buffer.length) {
      throw this._outboundApduError();
    }
    return Buffer.from(buffer.buffer.subarray(0, buffer.offset));
  }

  _replyComplexAck(context, payload) {
    if (!COMPLEX_ACK_SERVICES.has(context.service)) {
      throw clientError('ERR_INVALID_SERVER_REPLY');
    }
    try {
      const servicePayload = this._encodeComplexAckPayload(payload);
      const encoded = this._encodeServerReply(context, (buffer) => {
        baApdu.encodeComplexAck(
          buffer,
          baEnum.PduTypes.COMPLEX_ACK,
          context.service,
          context.invokeId
        );
        servicePayload.copy(buffer.buffer, buffer.offset);
        buffer.offset += servicePayload.length;
      });
      if (encoded.apduLength > context.responseMaxApdu) {
        return this._replyAbort(context, baEnum.AbortReason.APDU_TOO_LONG);
      }
      return this._sendTrackedReply(context, encoded);
    } catch (error) {
      if (error && error.code === 'ERR_OUTBOUND_APDU_TOO_LARGE') {
        return this._replyAbort(context, baEnum.AbortReason.APDU_TOO_LONG);
      }
      throw error;
    }
  }

  _replyReadProperty(context, objectId, property, value) {
    if (context.service !== baEnum.ConfirmedServiceChoice.READ_PROPERTY) {
      throw clientError('ERR_INVALID_SERVER_REPLY');
    }
    return this._replyComplexAck(context, (buffer) =>
      baServices.readProperty.encodeAcknowledge(
        buffer,
        objectId,
        property.id,
        property.index,
        value
      )
    );
  }

  _replyReadPropertyMultiple(context, values) {
    if (context.service !== baEnum.ConfirmedServiceChoice.READ_PROPERTY_MULTIPLE) {
      throw clientError('ERR_INVALID_SERVER_REPLY');
    }
    return this._replyComplexAck(context, (buffer) =>
      baServices.readPropertyMultiple.encodeAcknowledge(buffer, values)
    );
  }

  _isBroadcastAddress(address) {
    return this._linkAddress(address) === this._linkAddress(this._transport.getBroadcastAddress());
  }

  _sendConfirmedRequest(address, service, options, successPdu, encodeService, callback) {
    options = options && typeof options === 'object' ? options : {};
    if (this._closed) throw clientError('ERR_CLIENT_CLOSED');
    if (typeof callback !== 'function') throw clientError('ERR_INVALID_CALLBACK');
    const normalizedAddress = this._normalizeAddress(address);
    if (this._isBroadcastAddress(normalizedAddress)) {
      throw clientError(
        'ERR_CONFIRMED_BROADCAST',
        'Confirmed BACnet services require a unicast destination'
      );
    }
    const requestedMaxSegments = options.maxSegments != null ?
      options.maxSegments : baEnum.MaxSegmentsAccepted.SEGMENTS_65;
    const maxApdu = options.maxApdu != null ?
      options.maxApdu : baEnum.MaxApduLengthAccepted.OCTETS_1476;
    const segmentPolicy = maxSegmentPolicy(
      requestedMaxSegments,
      this._maxSegmentsPerTransfer
    );
    const maxSegments = segmentPolicy.encoded;
    const responseMaxApdu = maxApduBytes(maxApdu);
    const buffer = this._getBuffer();
    this._encodeNpdu(
      buffer,
      baEnum.NpduControlPriority.NORMAL_MESSAGE | baEnum.NpduControlBits.EXPECTING_REPLY,
      normalizedAddress,
      null
    );
    const acceptsSegmentedResponse = successPdu === baEnum.PduTypes.COMPLEX_ACK &&
      maxSegments !== baEnum.MaxSegmentsAccepted.SEGMENTS_0;
    const type = baEnum.PduTypes.CONFIRMED_REQUEST |
      (acceptsSegmentedResponse ? baEnum.PduConReqBits.SEGMENTED_RESPONSE_ACCEPTED : 0);
    const apduOffset = buffer.offset;
    this._encodeSafely(() => {
      baApdu.encodeConfirmedServiceRequest(buffer, type, service, maxSegments, maxApdu, 0, 0, 0);
      encodeService(buffer);
    });
    this._finalizeBuffer(buffer, baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU);

    let transaction;
    const peerKey = addressKey(normalizedAddress);
    transaction = this._transactions.begin({
      address: normalizedAddress,
      service: service,
      acceptedPdus: [successPdu].concat(CONFIRMED_FAILURE_PDUS),
      requestedInvokeId: options.invokeId,
      responseMaxApdu: responseMaxApdu,
      responseSegmentLimit: successPdu === baEnum.PduTypes.COMPLEX_ACK ?
        segmentPolicy.limit : 0,
      signal: options.signal,
      timeout: options.timeout,
      callback: (err, result) => {
        this._segments.cancel('response', peerKey, transaction.invokeId);
        callback(err, result);
      }
    });
    if (!transaction.active) return transaction;
    this._segments.forgetCompleted('response', peerKey, transaction.invokeId);
    buffer.buffer[apduOffset + 2] = transaction.invokeId;

    let sent;
    try {
      sent = this._sendBuffer(buffer, normalizedAddress, {
        signal: transaction.signal,
        deadline: transaction.deadline
      });
    } catch (err) {
      transaction.rollback(err);
      throw err;
    }
    if (sent === false) {
      transaction.cancel(clientError('ERR_SEND_FAILED', 'BACnet transport rejected the request'));
    }
    return transaction;
  }

  _confirmedCallback(next, decoder) {
    if (typeof next !== 'function') throw clientError('ERR_INVALID_CALLBACK');
    return (err, data) => {
      const metadata = data ? data.metadata : err ? err.linkContext : undefined;
      if (err) return next(err, undefined, metadata);
      if (!decoder) return next(null, undefined, metadata);
      const result = this._decodeService(decoder, data.buffer, data.offset, data.length);
      if (!result || !Number.isSafeInteger(result.len) || result.len !== data.length) {
        return next(clientError('INVALID_DECODING'), undefined, metadata);
      }
      next(null, result, metadata);
    };
  }

  _getBuffer() {
    return {
      buffer: Buffer.alloc(this._transport.getMaxPayload()),
      offset: BVLC_HEADER_LENGTH
    };
  }

  _decodeService(decoder, ...args) {
    try {
      return decoder(...args);
    } catch (err) {
      const errorType = err && err.name ? err.name : 'Error';
      debug(`Service decoder rejected malformed data (${errorType})`);
      return;
    }
  }

  // Service Handlers
  _processError(address, apdu, buffer, offset, length, metadata) {
    const result = this._decodeService(baServices.error.decode, buffer, offset, length);
    if (!result) return debug('Couldn`t decode Error');
    const error = clientError(
      'BACNET_ERROR',
      'BacnetError - Class:' + result.class + ' - Code:' + result.code
    );
    error.errorClass = result.class;
    error.errorCode = result.code;
    error.service = apdu.service;
    if (metadata) error.linkContext = metadata;
    this._transactions.settle({
      address: address,
      invokeId: apdu.invokeId,
      pduType: apdu.type,
      service: apdu.service,
      error: error
    });
  }

  _processAbort(address, apdu, metadata) {
    const pduType = apdu.type & baEnum.PDU_TYPE_MASK;
    const rejected = pduType === baEnum.PduTypes.REJECT;
    const error = clientError(
      rejected ? 'BACNET_REJECT' : 'BACNET_ABORT',
      (rejected ? 'BacnetReject' : 'BacnetAbort') + ' - Reason:' + apdu.reason
    );
    error.reason = apdu.reason;
    if (metadata) error.linkContext = metadata;
    this._transactions.settle({
      address: address,
      invokeId: apdu.invokeId,
      pduType: apdu.type,
      error: error
    });
  }

  _segmentAckResponse(receiver, negative, server, originalInvokeId, sequencenumber, actualWindowSize) {
    const buffer = this._getBuffer();
    this._encodeNpdu(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE, receiver, null);
    baApdu.encodeSegmentAck(buffer, baEnum.PduTypes.SEGMENT_ACK | (negative ? baEnum.PduSegAckBits.NEGATIVE_ACK : 0) | (server ? baEnum.PduSegAckBits.SERVER : 0), originalInvokeId, sequencenumber, actualWindowSize);
    this._finalizeBuffer(buffer, baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU);
    return this._sendBuffer(buffer, receiver);
  }

  _trySegmentAckResponse(receiver, negative, server, originalInvokeId,
    sequencenumber, actualWindowSize) {
    try {
      return this._segmentAckResponse(
        receiver,
        negative,
        server,
        originalInvokeId,
        sequencenumber,
        actualWindowSize
      ) !== false;
    } catch (error) {
      debug('Unable to send segmented transfer ACK: ' + error.message);
      return false;
    }
  }

  _segmentAbortReason(reason) {
    if (reason === 'INVALID_WINDOW_SIZE' || reason === 'WINDOW_SIZE_CHANGED') {
      return baEnum.AbortReason.WINDOW_SIZE_OUT_OF_RANGE;
    }
    if (reason === 'TRANSFER_LIMIT' || reason === 'PEER_TRANSFER_LIMIT' ||
        reason === 'TOTAL_BYTE_LIMIT' || reason === 'REQUEST_TRANSFER_LIMIT' ||
        reason === 'REQUEST_BYTE_LIMIT' || reason === 'OUT_OF_RESOURCES') {
      return baEnum.AbortReason.OUT_OF_RESOURCES;
    }
    if (reason === 'SEGMENT_LIMIT' || reason === 'TRANSFER_BYTE_LIMIT') {
      return baEnum.AbortReason.BUFFER_OVERFLOW;
    }
    if (reason === 'SEGMENT_BYTE_LIMIT' || reason === 'APDU_TOO_LONG') {
      return baEnum.AbortReason.APDU_TOO_LONG;
    }
    if (reason === 'SEGMENTATION_NOT_SUPPORTED') {
      return baEnum.AbortReason.SEGMENTATION_NOT_SUPPORTED;
    }
    if (reason === 'INCONSISTENT_ATTRIBUTES') {
      return baEnum.AbortReason.INCONSISTENT_ATTRIBUTES;
    }
    if (reason === 'IDLE_TIMEOUT' || reason === 'ABSOLUTE_TIMEOUT') {
      return baEnum.AbortReason.TSM_TIMEOUT;
    }
    if (reason === 'SEGMENT_ACK_FAILED') return baEnum.AbortReason.TSM_TIMEOUT;
    return baEnum.AbortReason.INVALID_APDU_IN_THIS_STATE;
  }

  _segmentAbortResponse(receiver, server, invokeId, reason) {
    const buffer = this._getBuffer();
    this._encodeNpdu(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE, receiver);
    baApdu.encodeAbort(
      buffer,
      baEnum.PduTypes.ABORT | (server ? baEnum.PduAbortBits.SERVER : 0),
      invokeId,
      reason
    );
    this._finalizeBuffer(buffer, baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU);
    this._sendBuffer(buffer, receiver);
  }

  _segmentedMetadata(metadata, contextIds, segmentCount) {
    if (!metadata) return undefined;
    return Object.freeze(Object.assign({}, metadata, {
      segmented: true,
      segmentCount: segmentCount,
      messageIds: Object.freeze(contextIds.slice())
    }));
  }

  _failSegmentedResponse(address, invokeId, reason, metadata) {
    const error = clientError('BACNET_SEGMENTATION_ERROR', 'BACnet segmentation failed: ' + reason);
    error.reason = reason;
    if (metadata) error.linkContext = metadata;
    this._transactions.settle({
      address: address,
      invokeId: invokeId,
      pduType: baEnum.PduTypes.ABORT,
      error: error
    });
  }

  _abortSegmentTransfer(address, server, invokeId, reason, metadata) {
    try {
      this._segmentAbortResponse(
        address,
        server,
        invokeId,
        this._segmentAbortReason(reason)
      );
    } catch (error) {
      debug('Unable to send segmented transfer Abort: ' + error.message);
    }
    if (!server) this._failSegmentedResponse(address, invokeId, reason, metadata);
  }

  _segmentAckFailure(address, server, peerKey, invokeId, metadata, completed) {
    if (completed) {
      this._segments.discard(server ? 'request' : 'response', peerKey, invokeId);
    } else {
      this._segments.cancel(server ? 'request' : 'response', peerKey, invokeId);
    }
    this._abortSegmentTransfer(address, server, invokeId, 'SEGMENT_ACK_FAILED', metadata);
  }

  _onSegmentExpire(event) {
    const context = event.context;
    if (!context || this._closed) return;
    this._abortSegmentTransfer(
      context.address,
      context.server,
      event.invokeId,
      event.reason,
      context.metadata
    );
  }

  _onServerTransactionExpire(transaction) {
    if (this._closed) return;
    const context = Object.freeze({
      address: transaction.address,
      expiresAt: transaction.expiresAt,
      generation: transaction.generation,
      invokeId: transaction.invokeId,
      responseMaxApdu: transaction.responseMaxApdu,
      service: transaction.service
    });
    this._tryAutomaticReply(() => this._replyAbort(
      context,
      baEnum.AbortReason.APPLICATION_EXCEEDED_REPLY_TIME,
      true
    ));
  }

  _processSegment(receiver, type, service, invokeId, maxSegments, maxApdu, server,
    sequencenumber, proposedWindowNumber, buffer, offset, length, metadata) {
    let address = this._normalizeAddress(receiver);
    let peerKey = addressKey(address);
    const receivedPeerKey = peerKey;
    const canonicalType = type & ~baEnum.PduConReqBits.MORE_FOLLOWS;
    const response = server ? null : {
      address: address,
      invokeId: invokeId,
      pduType: canonicalType,
      segmented: true,
      service: service
    };
    const segment = {
      direction: server ? 'request' : 'response',
      peerKey: peerKey,
      invokeId: invokeId,
      type: canonicalType,
      service: service,
      sequenceNumber: sequencenumber,
      windowSize: proposedWindowNumber,
      moreFollows: (type & baEnum.PduConReqBits.MORE_FOLLOWS) !== 0,
      payload: buffer.slice(offset, offset + length),
      contextKey: JSON.stringify([
        maxSegments,
        maxApdu,
        this._metadataSignature(metadata, true)
      ]),
      firstContextKey: this._firstMetadataSignature(metadata),
      contextId: metadata && metadata.messageId,
      context: {
        address: address,
        server: server,
        maxSegments: maxSegments,
        maxApdu: maxApdu,
        metadata: metadata
      }
    };

    if (!server) {
      const policy = this._transactions.match(response);
      if (!policy) {
        const replay = this._segments.replay(segment);
        if (replay && replay.ack) {
          this._trySegmentAckResponse(
            replay.address || address,
            false,
            false,
            invokeId,
            replay.sequenceNumber,
            replay.windowSize
          );
        }
        return;
      }

      address = policy.address;
      peerKey = addressKey(address);
      segment.peerKey = peerKey;
      segment.replayPeerKey = receivedPeerKey;
      segment.context.address = address;

      if (policy.responseSegmentLimit === 0) {
        this._abortSegmentTransfer(
          address,
          false,
          invokeId,
          'SEGMENTATION_NOT_SUPPORTED',
          metadata
        );
        return;
      }
      if (policy.responseMaxApdu != null &&
          length + SEGMENTED_COMPLEX_ACK_HEADER_LENGTH > policy.responseMaxApdu) {
        this._abortSegmentTransfer(address, false, invokeId, 'APDU_TOO_LONG', metadata);
        return;
      }
      segment.segmentLimit = policy.responseSegmentLimit;
      if (policy.responseMaxApdu != null) {
        segment.segmentByteLimit = policy.responseMaxApdu -
          SEGMENTED_COMPLEX_ACK_HEADER_LENGTH;
      }
    }

    const outcome = this._segments.accept(segment);

    if (!server && outcome.absoluteDeadline != null) {
      this._transactions.handoffSegmentedResponse(response, outcome.absoluteDeadline);
    }

    if (outcome.negativeAck) {
      if (!this._trySegmentAckResponse(
        address,
        true,
        server,
        invokeId,
        outcome.sequenceNumber,
        outcome.windowSize
      )) {
        this._segmentAckFailure(address, server, peerKey, invokeId, metadata, false);
      }
      return;
    }
    if (outcome.status === 'reject') {
      this._abortSegmentTransfer(address, server, invokeId, outcome.reason, metadata);
      return;
    }
    if (outcome.ack) {
      if (!this._trySegmentAckResponse(
        address,
        false,
        server,
        invokeId,
        outcome.sequenceNumber,
        outcome.windowSize
      )) {
        this._segmentAckFailure(
          address,
          server,
          peerKey,
          invokeId,
          metadata,
          outcome.status === 'complete'
        );
        return;
      }
    }
    if (outcome.status !== 'complete') return;

    const completeType = outcome.type &
      ~(baEnum.PduConReqBits.SEGMENTED_MESSAGE | baEnum.PduConReqBits.MORE_FOLLOWS);
    const completeMetadata = this._segmentedMetadata(
      outcome.context.metadata,
      outcome.contextIds,
      outcome.segmentCount
    );
    if (server) {
      this._processConfirmedServiceRequest(
        address,
        completeType,
        outcome.service,
        outcome.context.maxSegments,
        outcome.context.maxApdu,
        outcome.invokeId,
        outcome.payload,
        0,
        outcome.payload.length,
        completeMetadata
      );
      return;
    }
    this._transactions.settle({
      address: address,
      invokeId: outcome.invokeId,
      pduType: completeType,
      segmented: true,
      service: outcome.service,
      error: null,
      result: {
        result: {
          type: completeType,
          service: outcome.service,
          invokeId: outcome.invokeId
        },
        buffer: outcome.payload,
        offset: 0,
        length: outcome.payload.length,
        metadata: completeMetadata
      }
    });
  }

  _acceptConfirmedServiceRequest(sourceAddress, type, service, maxSegments, maxApdu,
    invokeId, buffer, offset, length, metadata) {
    const transaction = this._serverTransactions.accept({
      address: sourceAddress,
      invokeId: invokeId,
      type: type,
      service: service,
      maxSegments: maxSegments,
      maxApdu: maxApdu,
      responseMaxApdu: MAX_APDU_BYTES[maxApdu] || 50,
      payload: buffer.slice(offset, offset + length)
    });
    if (transaction.status === 'pending' || transaction.status === 'closed') return null;
    if (transaction.status === 'completed') {
      this._tryReplayServerResponse(transaction.frame, transaction.address);
      return null;
    }
    if (transaction.status === 'collision') {
      this._abortSegmentTransfer(
        sourceAddress,
        true,
        invokeId,
        'INVALID_APDU_IN_THIS_STATE',
        metadata
      );
      return null;
    }
    if (transaction.status === 'out-of-resources') {
      this._abortSegmentTransfer(
        sourceAddress,
        true,
        invokeId,
        'OUT_OF_RESOURCES',
        metadata
      );
      return null;
    }
    return transaction;
  }

  _prepareConfirmedServiceRequest(service, maxSegments, maxApdu, buffer, offset, length) {
    if ((MAX_SEGMENT_COUNTS[maxSegments] == null &&
        maxSegments !== baEnum.MaxSegmentsAccepted.SEGMENTS_65) ||
        MAX_APDU_BYTES[maxApdu] == null) {
      return {status: 'malformed'};
    }
    const definition = CONFIRMED_SERVICE_DEFINITIONS.get(service);
    if (!definition) return {status: 'unsupported'};
    if (!definition.decoder) {
      return length === 0 ?
        {status: 'ready', definition: definition, result: null} :
        {status: 'malformed', definition: definition};
    }
    const result = this._decodeService(definition.decoder, buffer, offset, length);
    if (!result || result.len !== length) return {status: 'malformed', definition: definition};
    return {status: 'ready', definition: definition, result: result};
  }

  _createReplyCapability(transaction) {
    const context = Object.freeze({
      address: transaction.address,
      expiresAt: transaction.expiresAt,
      generation: transaction.generation,
      invokeId: transaction.invokeId,
      responseMaxApdu: transaction.responseMaxApdu,
      service: transaction.service
    });
    const reply = Object.freeze({
      address: this._frozenPublicAddress(context.address),
      deadline: context.expiresAt,
      invokeId: context.invokeId,
      maxApdu: context.responseMaxApdu,
      service: context.service,
      abort: (reason) => this._replyAbort(context, reason),
      complexAck: (payload) => this._replyComplexAck(context, payload),
      error: (errorClass, errorCode) => this._replyError(context, errorClass, errorCode),
      readProperty: (objectId, property, value) =>
        this._replyReadProperty(context, objectId, property, value),
      readPropertyMultiple: (values) =>
        this._replyReadPropertyMultiple(context, values),
      reject: (reason) => this._replyReject(context, reason),
      simpleAck: () => this._replySimpleAck(context),
      toJSON: () => undefined
    });
    this._replyContexts.set(reply, context);
    return reply;
  }

  _tryAutomaticReply(send) {
    try {
      return send();
    } catch (error) {
      debug('Unable to send automatic confirmed-request terminal response: ' + error.message);
      return false;
    }
  }

  _surfaceConfirmedHandlerRejection(error, eventName, event) {
    this._tryAutomaticReply(() => event.reply.abort(baEnum.AbortReason.OTHER));
    const diagnostic = Object.freeze({
      type: 'confirmed-handler-rejection',
      error: error,
      event: eventName,
      invokeId: event.invokeId,
      service: event.reply.service,
      sourceAddress: event.sourceAddress
    });
    try {
      this.emit('diagnostic', diagnostic);
    } catch (diagnosticError) {
      debug('Confirmed-request diagnostic handler failed: ' + diagnosticError.message);
    }
    if (this.listenerCount('error') > 0) {
      try {
        this.emit('error', error);
      } catch (errorHandlerFailure) {
        debug('Confirmed-request error handler failed: ' + errorHandlerFailure.message);
      }
    }
  }

  _processConfirmedServiceRequest(address, type, service, maxSegments, maxApdu, invokeId,
    buffer, offset, length, metadata) {
    const sourceAddress = this._normalizeAddress(address);
    const transaction = this._acceptConfirmedServiceRequest(
      sourceAddress,
      type,
      service,
      maxSegments,
      maxApdu,
      invokeId,
      buffer,
      offset,
      length,
      metadata
    );
    if (!transaction) return;
    const prepared = this._prepareConfirmedServiceRequest(
      service,
      maxSegments,
      maxApdu,
      buffer,
      offset,
      length
    );
    const reply = this._createReplyCapability(transaction);

    if (prepared.status === 'unsupported') {
      this._tryAutomaticReply(() =>
        reply.reject(baEnum.RejectReason.UNRECOGNIZED_SERVICE)
      );
      return;
    }
    if (prepared.status === 'malformed') {
      this._tryAutomaticReply(() =>
        reply.reject(baEnum.RejectReason.INVALID_PARAMETER_DATA_TYPE)
      );
      return;
    }

    const eventNames = Array.isArray(prepared.definition.event) ?
      prepared.definition.event : [prepared.definition.event];
    const listeners = eventNames.reduce(
      (count, eventName) => count + this.listenerCount(eventName),
      0
    );
    if (listeners === 0) {
      this._tryAutomaticReply(() =>
        reply.reject(baEnum.RejectReason.UNRECOGNIZED_SERVICE)
      );
      return;
    }
    if (listeners !== 1) {
      this._tryAutomaticReply(() =>
        reply.abort(baEnum.AbortReason.INVALID_APDU_IN_THIS_STATE)
      );
      return;
    }

    const eventName = eventNames.find((name) => this.listenerCount(name) === 1);

    const event = {
      address: this._legacyAddress(sourceAddress),
      invokeId: invokeId,
      reply: reply
    };
    if (prepared.result) event.request = prepared.result;
    this._eventPayload(event, sourceAddress, metadata);
    let handlerResult;
    try {
      const handler = this.rawListeners(eventName)[0];
      handlerResult = handler.call(this, event);
    } catch (error) {
      this._tryAutomaticReply(() => reply.abort(baEnum.AbortReason.OTHER));
      throw error;
    }
    if (handlerResult != null &&
        (typeof handlerResult === 'object' || typeof handlerResult === 'function')) {
      Promise.resolve(handlerResult)
        .catch((error) => this._surfaceConfirmedHandlerRejection(error, eventName, event))
        .catch((error) => debug(
          'Unable to contain confirmed-request handler rejection: ' + error.message
        ));
    }
  }

  _processUnconfirmedServiceRequest(address, type, service, buffer, offset, length,
    addressObject, metadata) {
    let result;
    const sourceAddress = this._normalizeAddress(addressObject == null ? address : addressObject);
    const decode = (decoder) => {
      const decoded = this._decodeService(decoder, buffer, offset, length);
      if (!decoded || !Number.isSafeInteger(decoded.len) || decoded.len !== length) return;
      return decoded;
    };
    const publish = (name, payload) => this.emit(
      name,
      this._eventPayload(payload, sourceAddress, metadata)
    );
    debug('Handle this._processUnconfirmedServiceRequest');
    if (service === baEnum.UnconfirmedServiceChoice.I_AM) {
      result = decode(baServices.iAmBroadcast.decode);
      if (!result) return debug('Received invalid iAm message');

      /**
       * The iAm event represents the response to a whoIs request to detect all devices in a BACNET network.
       * @event bacstack.iAm
       * @param {object} device - An object representing the detected device.
       * @param {BacnetAddress} device.address - Historical direct link address.
       * @param {BacnetAddress} device.sourceAddress - Canonical direct or routed source.
       * @param {LinkContext=} device.linkContext - Detached link context when available.
       * @param {number} device.deviceId - The BACNET device-id of the detected device.
       * @param {number} device.maxApdu - The max APDU size the detected device is supporting.
       * @param {number} device.segmentation - The type of segmentation the detected device is supporting.
       * @param {number} device.vendorId - The BACNET vendor-id of the detected device.
       * @example
       * const bacnet = require('bacstack');
       * const client = new bacnet();
       *
       * client.on('iAm', (device) => {
       *   console.log('address: ', device.address, ' - deviceId: ', device.deviceId, ' - maxApdu: ', device.maxApdu, ' - segmentation: ', device.segmentation, ' - vendorId: ', device.vendorId);
       * });
       */
      const net = sourceAddress.net;
      const adr = sourceAddress.adr ? sourceAddress.adr.slice() : undefined;
      publish('iAm', {address: address, deviceId: result.deviceId, maxApdu: result.maxApdu, segmentation: result.segmentation, vendorId: result.vendorId, 'net':net, 'adr':adr});
    } else if (service === baEnum.UnconfirmedServiceChoice.WHO_IS) {
      result = decode(baServices.whoIs.decode);
      if (!result) return debug('Received invalid WhoIs message');

      /**
       * The whoIs event represents the request for an IAm reponse to detect all devices in a BACNET network.
       * @event bacstack.whoIs
       * @param {object} request - An object representing the received request.
       * @param {BacnetAddress} request.address - Historical direct link address.
       * @param {BacnetAddress} request.sourceAddress - Canonical direct or routed source.
       * @param {LinkContext=} request.linkContext - Detached link context when available.
       * @param {number=} request.lowLimit - The lower limit of the BACNET device-id.
       * @param {number=} request.highLimit - The higher limit of the BACNET device-id.
       * @example
       * const bacnet = require('bacstack');
       * const client = new bacnet();
       *
       * client.on('whoIs', (request) => {
       *   console.log('address: ', device.address, ' - lowLimit: ', device.lowLimit, ' - highLimit: ', device.highLimit);
       * });
       */
      publish('whoIs', {address: address, lowLimit: result.lowLimit, highLimit: result.highLimit});
    } else if (service === baEnum.UnconfirmedServiceChoice.WHO_HAS) {
      result = decode(baServices.whoHas.decode);
      if (!result) return debug('Received invalid WhoHas message');
      publish('whoHas', {address: address, lowLimit: result.lowLimit, highLimit: result.highLimit, objectId: result.objectId, objectName: result.objectName});
    } else if (service === baEnum.UnconfirmedServiceChoice.UNCONFIRMED_COV_NOTIFICATION) {
      result = decode(baServices.covNotify.decode);
      if (!result) return debug('Received invalid covNotifyUnconfirmed message');
      publish('covNotifyUnconfirmed', {address: address, request: result});
    } else if (service === baEnum.UnconfirmedServiceChoice.TIME_SYNCHRONIZATION) {
      result = decode(baServices.timeSync.decode);
      if (!result) return debug('Received invalid TimeSync message');

      /**
       * The timeSync event represents the request to synchronize the local time to the received time.
       * @event bacstack.timeSync
       * @param {object} request - An object representing the received request.
       * @param {BacnetAddress} request.address - Historical direct link address.
       * @param {BacnetAddress} request.sourceAddress - Canonical direct or routed source.
       * @param {LinkContext=} request.linkContext - Detached link context when available.
       * @param {date} request.dateTime - The time to be synchronized to.
       * @example
       * const bacnet = require('bacstack');
       * const client = new bacnet();
       *
       * client.on('timeSync', (request) => {
       *   console.log('address: ', device.address, ' - dateTime: ', device.dateTime);
       * });
       */
      publish('timeSync', {address: address, dateTime: result.value});
    } else if (service === baEnum.UnconfirmedServiceChoice.UTC_TIME_SYNCHRONIZATION) {
      result = decode(baServices.timeSync.decodeUTC);
      if (!result) return debug('Received invalid TimeSyncUTC message');

      /**
       * The timeSyncUTC event represents the request to synchronize the local time to the received UTC time.
       * @event bacstack.timeSyncUTC
       * @param {object} request - An object representing the received request.
       * @param {BacnetAddress} request.address - Historical direct link address.
       * @param {BacnetAddress} request.sourceAddress - Canonical direct or routed source.
       * @param {LinkContext=} request.linkContext - Detached link context when available.
       * @param {date} request.dateTime - The time to be synchronized to.
       * @example
       * const bacnet = require('bacstack');
       * const client = new bacnet();
       *
       * client.on('timeSyncUTC', (request) => {
       *   console.log('address: ', device.address, ' - dateTime: ', device.dateTime);
       * });
       */
      publish('timeSyncUTC', {address: address, dateTime: result.value});
    } else if (service === baEnum.UnconfirmedServiceChoice.UNCONFIRMED_EVENT_NOTIFICATION) {
      result = decode(baServices.eventNotifyData.decode);
      if (!result) return debug('Received invalid EventNotify message');
      publish('eventNotify', {address: address, eventData: result});
    } else if (service === baEnum.UnconfirmedServiceChoice.I_HAVE) {
      result = decode(baServices.iHaveBroadcast.decode);
      if (!result) return debug('Received invalid ihaveBroadcast message');
      const iHave = this._eventPayload({
        address: address,
        deviceId: result.deviceId,
        objectId: result.objectId,
        objectName: result.objectName,
        eventData: result
      }, sourceAddress, metadata);
      this.emit('ihaveBroadcast', iHave);
      this.emit('iHave', iHave);
    } else if (service === baEnum.UnconfirmedServiceChoice.UNCONFIRMED_PRIVATE_TRANSFER) {
      result = decode(baServices.privateTransfer.decode);
      if (!result) return debug('Received invalid privateTransfer message');
      publish('privateTransfer', {address: address, eventData: result});
    } else {
      debug('Received unsupported unconfirmed service request');
    }
  }

  _handlePdu(address, type, buffer, offset, length, sourceAddress, metadata, broadcast) {
    if (typeof type !== 'number' || length <= 0) return debug('Received invalid APDU header -> Drop package');
    if (broadcast && (type & baEnum.PDU_TYPE_MASK) !== baEnum.PduTypes.UNCONFIRMED_REQUEST) {
      return debug('Received confirmed or response APDU by broadcast -> Drop package');
    }

    let result;
    // Handle different PDU types
    switch (type & baEnum.PDU_TYPE_MASK) {
      case baEnum.PduTypes.UNCONFIRMED_REQUEST:
        result = baApdu.decodeUnconfirmedServiceRequest(buffer, offset, length);
        if (!result) return debug('Received truncated unconfirmed request -> Drop package');
        this._processUnconfirmedServiceRequest(
          address,
          result.type,
          result.service,
          buffer,
          offset + result.len,
          length - result.len,
          sourceAddress,
          metadata
        );
        break;
      case baEnum.PduTypes.SIMPLE_ACK:
        result = baApdu.decodeSimpleAck(buffer, offset, length);
        if (!result || result.len !== length) {
          return debug('Received malformed simple ACK -> Drop package');
        }
        this._transactions.settle({
          address: sourceAddress,
          invokeId: result.invokeId,
          pduType: result.type,
          service: result.service,
          error: null,
          result: {
            result: result,
            buffer: buffer,
            offset: offset + result.len,
            length: length - result.len,
            metadata: metadata
          }
        });
        break;
      case baEnum.PduTypes.COMPLEX_ACK:
        result = baApdu.decodeComplexAck(buffer, offset, length);
        if (!result) return debug('Received truncated complex ACK -> Drop package');
        if ((type & baEnum.PduConReqBits.SEGMENTED_MESSAGE) === 0) {
          const responsePolicy = this._transactions.match({
            address: sourceAddress,
            invokeId: result.invokeId,
            pduType: result.type,
            service: result.service
          });
          if (responsePolicy && responsePolicy.responseMaxApdu != null &&
              length > responsePolicy.responseMaxApdu) {
            this._abortSegmentTransfer(
              sourceAddress,
              false,
              result.invokeId,
              'APDU_TOO_LONG',
              metadata
            );
            break;
          }
          this._transactions.settle({
            address: sourceAddress,
            invokeId: result.invokeId,
            pduType: result.type,
            service: result.service,
            error: null,
            result: {
              result: result,
              buffer: buffer,
              offset: offset + result.len,
              length: length - result.len,
              metadata: metadata
            }
          });
        } else {
          this._processSegment(sourceAddress, result.type, result.service, result.invokeId,
            baEnum.MaxSegmentsAccepted.SEGMENTS_0, baEnum.MaxApduLengthAccepted.OCTETS_50,
            false, result.sequencenumber, result.proposedWindowNumber, buffer,
            offset + result.len, length - result.len, metadata);
        }
        break;
      case baEnum.PduTypes.SEGMENT_ACK:
        result = baApdu.decodeSegmentAck(buffer, offset, length);
        if (!result || result.len !== length) {
          return debug('Received malformed segment ACK -> Drop package');
        }
        //m_last_segment_ack.Set(address, result.originalInvokeId, result.sequencenumber, result.actualWindowSize);
        //this._processSegmentAck(address, result.type, result.originalInvokeId, result.sequencenumber, result.actualWindowSize, buffer, offset + result.len, length - result.len);
        break;
      case baEnum.PduTypes.ERROR:
        result = baApdu.decodeError(buffer, offset, length);
        if (!result) return debug('Received truncated error APDU -> Drop package');
        this._processError(sourceAddress, result, buffer, offset + result.len, length - result.len, metadata);
        break;
      case baEnum.PduTypes.REJECT:
      case baEnum.PduTypes.ABORT:
        result = baApdu.decodeAbort(buffer, offset, length);
        if (!result || result.len !== length) {
          return debug('Received malformed reject/abort APDU -> Drop package');
        }
        this._processAbort(sourceAddress, result, metadata);
        break;
      case baEnum.PduTypes.CONFIRMED_REQUEST:
        result = baApdu.decodeConfirmedServiceRequest(buffer, offset, length);
        if (!result) return debug('Received truncated confirmed request -> Drop package');
        if ((type & baEnum.PduConReqBits.SEGMENTED_MESSAGE) === 0) {
          this._processConfirmedServiceRequest(sourceAddress, result.type, result.service,
            result.maxSegments, result.maxApdu, result.invokeId, buffer,
            offset + result.len, length - result.len, metadata);
        } else {
          this._processSegment(sourceAddress, result.type, result.service, result.invokeId,
            result.maxSegments, result.maxApdu, true, result.sequencenumber,
            result.proposedWindowNumber, buffer, offset + result.len,
            length - result.len, metadata);
        }
        break;
      default:
        debug('Received unknown PDU type -> Drop package');
        break;
    }
  }

  _handleNpdu(buffer, offset, msgLength, remoteAddress, metadata, broadcast) {
    // Check data length
    if (msgLength <= 0) return debug('No NPDU data -> Drop package');
    // Parse baNpdu header
    const result = baNpdu.decode(buffer, offset, msgLength);
    if (!result) return debug('Received invalid NPDU header -> Drop package');
    let sourceAddress;
    try {
      sourceAddress = this._sourceAddress(remoteAddress, result.source);
    } catch {
      return debug('Received invalid source address -> Drop package');
    }

    if (result.funct & baEnum.NpduControlBits.NETWORK_LAYER_MESSAGE) {
      return debug('Received network layer message -> Drop package');
    }
    offset += result.len;
    msgLength -= result.len;
    if (msgLength <= 0) return debug('No APDU data -> Drop package');
    const apduType = baApdu.getDecodedType(buffer, offset);
    const deliveryIsBroadcast = broadcast ||
      !!(result.destination && !result.destination.adr);
    this._handlePdu(
      this._linkAddress(sourceAddress),
      apduType,
      buffer,
      offset,
      msgLength,
      sourceAddress,
      metadata,
      deliveryIsBroadcast
    );
  }

  _receiveData(buffer, remoteAddress, remotePort, linkContext) {
    if (this._closed) return;
    if (!Buffer.isBuffer(buffer)) return debug('Received non-buffer data -> Drop package');
    // Check data length
    if (buffer.length < baBvlc.BVLC_HEADER_LENGTH) return debug('Received invalid data -> Drop package');
    // Parse BVLC header
    const result = baBvlc.decode(buffer, 0);
    if (!result) return debug('Received invalid BVLC header -> Drop package');
    // Check BVLC function
    if (result.func === baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU || result.func === baEnum.BvlcResultPurpose.ORIGINAL_BROADCAST_NPDU || result.func === baEnum.BvlcResultPurpose.FORWARDED_NPDU) {
      let sourceLinkAddress = this._addressKind === 'ip' ?
        {ip: remoteAddress, port: remotePort} : remoteAddress;
      let metadata = linkContext;
      if (result.originatingAddress) {
        sourceLinkAddress = {
          ip: result.originatingAddress.ip,
          port: result.originatingAddress.port
        };
        metadata = Object.freeze({
          transport: 'bacnet-ip',
          forwardedBy: remoteAddress,
          forwardedByPort: remotePort,
          originating: Object.freeze(Object.assign({}, result.originatingAddress))
        });
      }
      const broadcast = result.func !== baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU;
      this._handleNpdu(
        buffer,
        result.len,
        buffer.length - result.len,
        sourceLinkAddress,
        metadata,
        broadcast
      );
    } else {
      debug('Received unknown BVLC function -> Drop package');
    }
  }

  _receiveError(err) {
    if (this._closed) return;

    /**
     * @event bacstack.error
     * @param {error} err - The error object thrown by the underlying transport layer.
     * @example
     * const bacnet = require('bacstack');
     * const client = new bacnet();
     *
     * client.on('error', (err) => {
     *   console.log('Error occurred: ', err);
     *   client.close();
     * });
     */
    this.emit('error', err);
  }

  /**
   * The whoIs command discovers all BACNET devices in a network.
   * @function bacstack#whoIs
   * @param {object=} options
   * @param {number=} options.lowLimit - Minimal device instance number to search for.
   * @param {number=} options.highLimit - Maximal device instance number to search for.
   * @param {BacnetAddress=} options.address - Unicast peer; defaults to the transport broadcast.
   * @fires bacstack.iAm
   * @example
   * const bacnet = require('bacstack');
   * const client = new bacnet();
   *
   * client.whoIs();
   */
  whoIs(options) {
    options = options || {};
    const settings = {
      lowLimit: options.lowLimit,
      highLimit: options.highLimit,
      address: options.address != null ? options.address : this._transport.getBroadcastAddress()
    };
    const normalizedAddress = this._normalizeAddress(settings.address);
    const buffer = this._getBuffer();
    this._encodeNpdu(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE, normalizedAddress, null);
    baApdu.encodeUnconfirmedServiceRequest(buffer, baEnum.PduTypes.UNCONFIRMED_REQUEST, baEnum.UnconfirmedServiceChoice.WHO_IS);
    baServices.whoIs.encode(buffer, settings.lowLimit, settings.highLimit);
    const npduType = this._isBroadcastAddress(normalizedAddress) ?
      baEnum.BvlcResultPurpose.ORIGINAL_BROADCAST_NPDU :
      baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU;
    this._finalizeBuffer(buffer, npduType);
    this._sendBuffer(buffer, normalizedAddress);
  }

  /**
   * The timeSync command sets the local time of a target device. This mutates
   * the device clock; run it only against an authorized, disposable target.
   * @function bacstack#timeSync
   * @param {BacnetAddress} address - Direct or routed target device.
   * @param {date} dateTime - The date and time to set on the target device.
   * @example
   * const bacnet = require('bacstack');
   * const client = new bacnet();
   * const target = process.env.BACNET_EXAMPLE_TARGET;
   *
   * if (process.env.BACNET_EXAMPLE_ALLOW_MUTATION !== 'true' || !target) {
   *   throw new Error('Opt in and provide an authorized disposable target before changing its clock');
   * }
   * client.timeSync(target, new Date());
   */
  timeSync(address, dateTime) {
    const normalizedAddress = this._normalizeAddress(address);
    const buffer = this._getBuffer();
    this._encodeNpdu(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE, normalizedAddress);
    baApdu.encodeUnconfirmedServiceRequest(buffer, baEnum.PduTypes.UNCONFIRMED_REQUEST, baEnum.UnconfirmedServiceChoice.TIME_SYNCHRONIZATION);
    this._encodeSafely(() => baServices.timeSync.encode(buffer, dateTime));
    const npduType = this._isBroadcastAddress(normalizedAddress) ?
      baEnum.BvlcResultPurpose.ORIGINAL_BROADCAST_NPDU :
      baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU;
    this._finalizeBuffer(buffer, npduType);
    this._sendBuffer(buffer, normalizedAddress);
  }

  /**
   * The timeSyncUTC command sets the UTC time of a target device. This mutates
   * the device clock; run it only against an authorized, disposable target.
   * @function bacstack#timeSyncUTC
   * @param {BacnetAddress} address - Direct or routed target device.
   * @param {date} dateTime - The date and time to set on the target device.
   * @example
   * const bacnet = require('bacstack');
   * const client = new bacnet();
   * const target = process.env.BACNET_EXAMPLE_TARGET;
   *
   * if (process.env.BACNET_EXAMPLE_ALLOW_MUTATION !== 'true' || !target) {
   *   throw new Error('Opt in and provide an authorized disposable target before changing its clock');
   * }
   * client.timeSyncUTC(target, new Date());
   */
  timeSyncUTC(address, dateTime) {
    const normalizedAddress = this._normalizeAddress(address);
    const buffer = this._getBuffer();
    this._encodeNpdu(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE, normalizedAddress);
    baApdu.encodeUnconfirmedServiceRequest(buffer, baEnum.PduTypes.UNCONFIRMED_REQUEST, baEnum.UnconfirmedServiceChoice.UTC_TIME_SYNCHRONIZATION);
    this._encodeSafely(() => baServices.timeSync.encodeUTC(buffer, dateTime));
    const npduType = this._isBroadcastAddress(normalizedAddress) ?
      baEnum.BvlcResultPurpose.ORIGINAL_BROADCAST_NPDU :
      baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU;
    this._finalizeBuffer(buffer, npduType);
    this._sendBuffer(buffer, normalizedAddress);
  }

  /**
   * The readProperty command reads a single property of an object from a device.
   * @function bacstack#readProperty
   * @param {BacnetAddress} address - Direct or routed target device.
   * @param {object} objectId - The BACNET object ID to read.
   * @param {number} objectId.type - The BACNET object type to read.
   * @param {number} objectId.instance - The BACNET object instance to read.
   * @param {number} propertyId - The BACNET property id in the specified object to read.
   * @param {ConfirmedRequestOptions=} options
   * @param {MaxSegmentsAccepted=} options.maxSegments - The maximimal allowed number of segments.
   * @param {MaxApduLengthAccepted=} options.maxApdu - The maximal allowed APDU size.
   * @param {number=} options.invokeId - The invoke ID of the confirmed service telegram.
   * @param {number=} options.arrayIndex - The array index of the property to be read.
   * @param {ConfirmedCallback} next - Completion callback `(error, value, linkContext)`.
   * @example
   * const bacnet = require('bacstack');
   * const client = new bacnet();
   *
   * client.readProperty('192.168.1.43', {type: 8, instance: 44301}, 28, (err, value) => {
   *   console.log('value: ', value);
   * });
   */
  readProperty(address, objectId, propertyId, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    const arrayIndex = options.arrayIndex != null ? options.arrayIndex : baEnum.ASN1_ARRAY_ALL;
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.READ_PROPERTY,
      options,
      baEnum.PduTypes.COMPLEX_ACK,
      (buffer) => baServices.readProperty.encode(
        buffer,
        objectId.type,
        objectId.instance,
        propertyId,
        arrayIndex
      ),
      this._confirmedCallback(next, baServices.readProperty.decodeAcknowledge)
    );
  }

  /**
   * The writeProperty command writes a single property of an object to a
   * device. This changes device state; run it only against an authorized,
   * disposable target.
   * @function bacstack#writeProperty
   * @param {BacnetAddress} address - Direct or routed target device.
   * @param {object} objectId - The BACNET object ID to write.
   * @param {number} objectId.type - The BACNET object type to write.
   * @param {number} objectId.instance - The BACNET object instance to write.
   * @param {number} propertyId - The BACNET property id in the specified object to write.
   * @param {object[]} values - A list of values to be written to the specified property.
   * @param {ApplicationTags} values.type - The data type of the value to be written.
   * @param {number} values.value - The actual value to be written.
   * @param {ConfirmedRequestOptions=} options
   * @param {MaxSegmentsAccepted=} options.maxSegments - The maximimal allowed number of segments.
   * @param {MaxApduLengthAccepted=} options.maxApdu - The maximal allowed APDU size.
   * @param {number=} options.invokeId - The invoke ID of the confirmed service telegram.
   * @param {number=} options.arrayIndex - The array index of the property to be written.
   * @param {number=} options.priority - The priority of the value to be written.
   * @param {ConfirmedCallback} next - Completion callback `(error, value, linkContext)`.
   * @example
   * const bacnet = require('bacstack');
   * const client = new bacnet();
   * const target = process.env.BACNET_EXAMPLE_TARGET;
   *
   * if (process.env.BACNET_EXAMPLE_ALLOW_MUTATION !== 'true' || !target) {
   *   throw new Error('Opt in and provide an authorized disposable target before writing a property');
   * }
   * client.writeProperty(target, {type: 8, instance: 44301}, 28, [
   *   {type: bacnet.enum.ApplicationTags.REAL, value: 100}
   * ], (err, value) => {
   *   console.log('value: ', value);
   * });
   */
  writeProperty(address, objectId, propertyId, values, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    const arrayIndex = options.arrayIndex != null ? options.arrayIndex : baEnum.ASN1_ARRAY_ALL;
    const priority = options.priority != null ? options.priority : baEnum.ASN1_NO_PRIORITY;
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.WRITE_PROPERTY,
      options,
      baEnum.PduTypes.SIMPLE_ACK,
      (buffer) => baServices.writeProperty.encode(
        buffer,
        objectId.type,
        objectId.instance,
        propertyId,
        arrayIndex,
        priority,
        values
      ),
      this._confirmedCallback(next)
    );
  }

  /**
   * The readPropertyMultiple command reads multiple properties in multiple objects from a device.
   * @function bacstack#readPropertyMultiple
   * @param {BacnetAddress} address - Direct or routed target device.
   * @param {object[]} requestArray - List of object and property specifications to be read.
   * @param {object} requestArray.objectId - Specifies which object to read.
   * @param {number} requestArray.objectId.type - The BACNET object type to read.
   * @param {number} requestArray.objectId.instance - The BACNET object instance to read.
   * @param {object[]} requestArray.properties - List of properties to be read.
   * @param {number} requestArray.properties.id - The BACNET property id in the specified object to read. Also supports 8 for all properties.
   * @param {ConfirmedRequestOptions=} options
   * @param {MaxSegmentsAccepted=} options.maxSegments - The maximimal allowed number of segments.
   * @param {MaxApduLengthAccepted=} options.maxApdu - The maximal allowed APDU size.
   * @param {number=} options.invokeId - The invoke ID of the confirmed service telegram.
   * @param {ConfirmedCallback} next - Completion callback `(error, value, linkContext)`.
   * @example
   * const bacnet = require('bacstack');
   * const client = new bacnet();
   *
   * const requestArray = [
   *   {objectId: {type: 8, instance: 4194303}, properties: [{id: 8}]}
   * ];
   * client.readPropertyMultiple('192.168.1.43', requestArray, (err, value) => {
   *   console.log('value: ', value);
   * });
   */
  readPropertyMultiple(address, propertiesArray, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.READ_PROPERTY_MULTIPLE,
      options,
      baEnum.PduTypes.COMPLEX_ACK,
      (buffer) => baServices.readPropertyMultiple.encode(buffer, propertiesArray),
      this._confirmedCallback(next, baServices.readPropertyMultiple.decodeAcknowledge)
    );
  }

  /**
   * The writePropertyMultiple command writes multiple properties in multiple
   * objects to a device. This changes device state; run it only against an
   * authorized, disposable target.
   * @function bacstack#writePropertyMultiple
   * @param {BacnetAddress} address - Direct or routed target device.
   * @param {object[]} values - List of object and property specifications to be written.
   * @param {object} values.objectId - Specifies which object to write.
   * @param {number} values.objectId.type - The BACNET object type to write.
   * @param {number} values.objectId.instance - The BACNET object instance to write.
   * @param {object[]} values.values - List of properties to be written.
   * @param {object} values.values.property - Property specifications to be written.
   * @param {number} values.values.property.id - The BACNET property id in the specified object to write.
   * @param {number} values.values.property.index - The array index of the property to be written.
   * @param {object[]} values.values.value - A list of values to be written to the specified property.
   * @param {ApplicationTags} values.values.value.type - The data type of the value to be written.
   * @param {object} values.values.value.value - The actual value to be written.
   * @param {number} values.values.priority - The priority to be used for writing to the property.
   * @param {ConfirmedRequestOptions=} options
   * @param {MaxSegmentsAccepted=} options.maxSegments - The maximimal allowed number of segments.
   * @param {MaxApduLengthAccepted=} options.maxApdu - The maximal allowed APDU size.
   * @param {number=} options.invokeId - The invoke ID of the confirmed service telegram.
   * @param {ConfirmedCallback} next - Completion callback `(error, value, linkContext)`.
   * @example
   * const bacnet = require('bacstack');
   * const client = new bacnet();
   * const target = process.env.BACNET_EXAMPLE_TARGET;
   *
   * if (process.env.BACNET_EXAMPLE_ALLOW_MUTATION !== 'true' || !target) {
   *   throw new Error('Opt in and provide an authorized disposable target before writing properties');
   * }
   * const values = [
   *   {objectId: {type: 8, instance: 44301}, values: [
   *     {property: {id: 28, index: 12}, value: [{type: bacnet.enum.ApplicationTags.BOOLEAN, value: true}], priority: 8}
   *   ]}
   * ];
   * client.writePropertyMultiple(target, values, (err, value) => {
   *   console.log('value: ', value);
   * });
   */
  writePropertyMultiple(address, values, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.WRITE_PROPERTY_MULTIPLE,
      options,
      baEnum.PduTypes.SIMPLE_ACK,
      (buffer) => baServices.writePropertyMultiple.encodeObject(buffer, values),
      this._confirmedCallback(next)
    );
  }

  /**
   * The deviceCommunicationControl command enables or disables network
   * communication of the target device. A duration of zero can disable
   * communications indefinitely. Run it only against an authorized,
   * disposable target with an independent recovery path.
   * @function bacstack#deviceCommunicationControl
   * @param {BacnetAddress} address - Direct or routed target device.
   * @param {number} timeDuration - The time to hold the network communication state in seconds. 0 for infinite.
   * @param {EnableDisable} enableDisable - The network communication state to set.
   * @param {ConfirmedRequestOptions=} options
   * @param {MaxSegmentsAccepted=} options.maxSegments - The maximimal allowed number of segments.
   * @param {MaxApduLengthAccepted=} options.maxApdu - The maximal allowed APDU size.
   * @param {number=} options.invokeId - The invoke ID of the confirmed service telegram.
   * @param {string=} options.password - The optional password used to set the network communication state.
   * @param {ConfirmedCallback} next - Completion callback `(error, value, linkContext)`.
   * @example
   * const bacnet = require('bacstack');
   * const client = new bacnet();
   * const target = process.env.BACNET_EXAMPLE_TARGET;
   *
   * if (process.env.BACNET_EXAMPLE_ALLOW_MUTATION !== 'true' || !target) {
   *   throw new Error('Opt in and provide a recoverable disposable target before disabling communications');
   * }
   * client.deviceCommunicationControl(target, 0, bacnet.enum.EnableDisable.DISABLE, (err) => {
   *   console.log('error: ', err);
   * });
   */
  deviceCommunicationControl(address, timeDuration, enableDisable, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.DEVICE_COMMUNICATION_CONTROL,
      options,
      baEnum.PduTypes.SIMPLE_ACK,
      (buffer) => baServices.deviceCommunicationControl.encode(
        buffer,
        timeDuration,
        enableDisable,
        options.password
      ),
      this._confirmedCallback(next)
    );
  }

  /**
   * The reinitializeDevice command initiates a restart of the target device.
   * This interrupts device operation; run it only against an authorized,
   * disposable target with an independent recovery path.
   * @function bacstack#reinitializeDevice
   * @param {BacnetAddress} address - Direct or routed target device.
   * @param {ReinitializedState} state - The type of restart to be initiated.
   * @param {ConfirmedRequestOptions=} options
   * @param {MaxSegmentsAccepted=} options.maxSegments - The maximimal allowed number of segments.
   * @param {MaxApduLengthAccepted=} options.maxApdu - The maximal allowed APDU size.
   * @param {number=} options.invokeId - The invoke ID of the confirmed service telegram.
   * @param {string=} options.password - The optional password used to restart the device.
   * @param {ConfirmedCallback} next - Completion callback `(error, value, linkContext)`.
   * @example
   * const bacnet = require('bacstack');
   * const client = new bacnet();
   * const target = process.env.BACNET_EXAMPLE_TARGET;
   *
   * if (process.env.BACNET_EXAMPLE_ALLOW_MUTATION !== 'true' || !target) {
   *   throw new Error('Opt in and provide a recoverable disposable target before restarting it');
   * }
   * client.reinitializeDevice(target, bacnet.enum.ReinitializedState.COLDSTART, (err, value) => {
   *   console.log('value: ', value);
   * });
   */
  reinitializeDevice(address, state, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.REINITIALIZE_DEVICE,
      options,
      baEnum.PduTypes.SIMPLE_ACK,
      (buffer) => baServices.reinitializeDevice.encode(buffer, state, options.password),
      this._confirmedCallback(next)
    );
  }

  /**
   * Writes one or more record-access blocks to a BACnet File object. This
   * changes persistent device data; run it only against an authorized,
   * disposable target with a recovery plan.
   *
   * @function bacstack#writeFile
   * @param {BacnetAddress} address direct or routed target device
   * @param {BacnetObjectId} objectId File object identifier
   * @param {number} position starting record number
   * @param {Array<(Buffer|Uint8Array|number[])>} fileBuffer record payloads
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {ConfirmedCallback} next completion callback
   */
  writeFile(address, objectId, position, fileBuffer, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.ATOMIC_WRITE_FILE,
      options,
      baEnum.PduTypes.COMPLEX_ACK,
      (buffer) => baServices.atomicWriteFile.encode(buffer, false, objectId, position, fileBuffer),
      this._confirmedCallback(next, baServices.atomicWriteFile.decodeAcknowledge)
    );
  }

  /**
   * Reads record-access data from a BACnet File object.
   *
   * @function bacstack#readFile
   * @param {BacnetAddress} address direct or routed target device
   * @param {BacnetObjectId} objectId File object identifier
   * @param {number} position starting record number
   * @param {number} count maximum number of records to read
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {ConfirmedCallback} next completion callback
   */
  readFile(address, objectId, position, count, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.ATOMIC_READ_FILE,
      options,
      baEnum.PduTypes.COMPLEX_ACK,
      (buffer) => baServices.atomicReadFile.encode(buffer, true, objectId, position, count),
      this._confirmedCallback(next, baServices.atomicReadFile.decodeAcknowledge)
    );
  }

  /**
   * Reads a positional range from the LOG_BUFFER property of a Trend Log
   * object.
   *
   * @function bacstack#readRange
   * @param {BacnetAddress} address direct or routed target device
   * @param {BacnetObjectId} objectId Trend Log object identifier
   * @param {number} idxBegin starting position
   * @param {number} quantity signed number of records requested
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {ConfirmedCallback} next completion callback
   */
  readRange(address, objectId, idxBegin, quantity, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.READ_RANGE,
      options,
      baEnum.PduTypes.COMPLEX_ACK,
      (buffer) => baServices.readRange.encode(
        buffer,
        objectId,
        baEnum.PropertyIdentifier.LOG_BUFFER,
        baEnum.ASN1_ARRAY_ALL,
        baEnum.ReadRangeType.BY_POSITION,
        idxBegin,
        new Date(),
        quantity
      ),
      this._confirmedCallback(next, baServices.readRange.decodeAcknowledge)
    );
  }

  /**
   * Creates, renews, or cancels a COV subscription. This changes subscription
   * state on the device; use only an authorized target and cancel or expire
   * test subscriptions when finished.
   *
   * @function bacstack#subscribeCOV
   * @param {BacnetAddress} address direct or routed target device
   * @param {BacnetObjectId} objectId monitored object
   * @param {number} subscribeId subscriber process identifier
   * @param {boolean} cancel whether this is a cancellation request
   * @param {boolean} issueConfirmedNotifications request confirmed notifications
   * @param {number} lifetime subscription lifetime in seconds
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {ConfirmedCallback} next completion callback
   */
  subscribeCOV(address, objectId, subscribeId, cancel, issueConfirmedNotifications, lifetime, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.SUBSCRIBE_COV,
      options,
      baEnum.PduTypes.SIMPLE_ACK,
      (buffer) => baServices.subscribeCov.encode(
        buffer,
        subscribeId,
        objectId,
        cancel,
        issueConfirmedNotifications,
        lifetime
      ),
      this._confirmedCallback(next)
    );
  }

  /**
   * Creates or cancels a property-specific COV subscription. New
   * subscriptions use a lifetime of zero (indefinite). This changes device
   * subscription state; use only an authorized target and explicitly cancel
   * test subscriptions when finished.
   *
   * @function bacstack#subscribeProperty
   * @param {BacnetAddress} address direct or routed target device
   * @param {BacnetObjectId} objectId monitored object
   * @param {BacnetPropertyReference} monitoredProperty monitored property
   * @param {number} subscribeId subscriber process identifier
   * @param {boolean} cancel whether this is a cancellation request
   * @param {boolean} issueConfirmedNotifications request confirmed notifications
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {ConfirmedCallback} next completion callback
   */
  subscribeProperty(address, objectId, monitoredProperty, subscribeId, cancel, issueConfirmedNotifications, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.SUBSCRIBE_COV_PROPERTY,
      options,
      baEnum.PduTypes.SIMPLE_ACK,
      (buffer) => baServices.subscribeProperty.encode(
        buffer,
        subscribeId,
        objectId,
        cancel,
        issueConfirmedNotifications,
        0,
        monitoredProperty,
        false,
        0x0f
      ),
      this._confirmedCallback(next)
    );
  }

  /**
   * Creates a BACnet object, optionally with initial property values. This
   * changes device configuration; run it only against an authorized,
   * disposable target and arrange cleanup.
   *
   * @function bacstack#createObject
   * @param {BacnetAddress} address direct or routed target device
   * @param {BacnetObjectId} objectId object type and optional requested instance
   * @param {object[]} [values] initial property values
   * @param {BacnetPropertyReference} values.property property reference
   * @param {BacnetApplicationValue[]} values.value typed property values
   * @param {number=} values.priority write priority
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {ConfirmedCallback} next completion callback
   */
  createObject(address, objectId, values, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.CREATE_OBJECT,
      options,
      baEnum.PduTypes.COMPLEX_ACK,
      (buffer) => baServices.createObject.encode(buffer, objectId, values),
      this._confirmedCallback(next, baServices.createObject.decodeAcknowledge)
    );
  }

  /**
   * Deletes a BACnet object. This is destructive and may remove persistent
   * configuration; run it only against an authorized, disposable target with
   * a verified recovery path.
   *
   * @function bacstack#deleteObject
   * @param {BacnetAddress} address direct or routed target device
   * @param {BacnetObjectId} objectId object to delete
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {ConfirmedCallback} next completion callback
   */
  deleteObject(address, objectId, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.DELETE_OBJECT,
      options,
      baEnum.PduTypes.SIMPLE_ACK,
      (buffer) => baServices.deleteObject.encode(buffer, objectId),
      this._confirmedCallback(next)
    );
  }

  /**
   * Removes typed values from a list property. This changes device state; run
   * it only against an authorized, disposable target.
   *
   * @function bacstack#removeListElement
   * @param {BacnetAddress} address direct or routed target device
   * @param {BacnetObjectId} objectId containing object
   * @param {BacnetPropertyReference} reference list property reference
   * @param {BacnetApplicationValue[]} values values to remove
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {ConfirmedCallback} next completion callback
   */
  removeListElement(address, objectId, reference, values, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.REMOVE_LIST_ELEMENT,
      options,
      baEnum.PduTypes.SIMPLE_ACK,
      (buffer) => baServices.addListElement.encode(
        buffer,
        objectId,
        reference.id,
        reference.index,
        values
      ),
      this._confirmedCallback(next)
    );
  }

  /**
   * Adds typed values to a list property. This changes device state; run it
   * only against an authorized, disposable target and arrange cleanup.
   *
   * @function bacstack#addListElement
   * @param {BacnetAddress} address direct or routed target device
   * @param {BacnetObjectId} objectId containing object
   * @param {BacnetPropertyReference} reference list property reference
   * @param {BacnetApplicationValue[]} values values to add
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {ConfirmedCallback} next completion callback
   */
  addListElement(address, objectId, reference, values, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.ADD_LIST_ELEMENT,
      options,
      baEnum.PduTypes.SIMPLE_ACK,
      (buffer) => baServices.addListElement.encode(
        buffer,
        objectId,
        reference.id,
        reference.index,
        values
      ),
      this._confirmedCallback(next)
    );
  }

  /**
   * Retrieves the target device's active alarm summary.
   *
   * @function bacstack#getAlarmSummary
   * @param {BacnetAddress} address direct or routed target device
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {ConfirmedCallback} next completion callback
   */
  getAlarmSummary(address, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.GET_ALARM_SUMMARY,
      options,
      baEnum.PduTypes.COMPLEX_ACK,
      () => {},
      this._confirmedCallback(next, baServices.alarmSummary.decode)
    );
  }

  /**
   * Retrieves event information, optionally continuing after a previously
   * returned object identifier.
   *
   * @function bacstack#getEventInformation
   * @param {BacnetAddress} address direct or routed target device
   * @param {BacnetObjectId=} objectId last received object identifier for continuation
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {ConfirmedCallback} next completion callback
   */
  getEventInformation(address, objectId, options, next) {
    const hasObjectId = objectId != null && typeof objectId === 'object' &&
      objectId.type !== undefined && objectId.instance !== undefined;
    if (typeof objectId === 'function') {
      next = objectId;
      objectId = undefined;
      options = {};
    } else if (!hasObjectId && objectId != null && typeof objectId === 'object' &&
        typeof options === 'function') {
      next = options;
      options = objectId;
      objectId = undefined;
    } else {
      next = next || options;
      options = options && typeof options === 'object' ? options : {};
    }
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.GET_EVENT_INFORMATION,
      options,
      baEnum.PduTypes.COMPLEX_ACK,
      (buffer) => baServices.getEventInformation.encode(buffer, objectId),
      this._confirmedCallback(next, baServices.getEventInformation.decodeAcknowledge)
    );
  }

  /**
   * Acknowledges an alarm transition. This changes alarm state and audit
   * history; run it only against an authorized target after validating the
   * exact event and timestamps.
   *
   * @function bacstack#acknowledgeAlarm
   * @param {BacnetAddress} address direct or routed target device
   * @param {BacnetObjectId} objectId event object identifier
   * @param {number} eventState value from `bacnet.enum.EventState`
   * @param {string} ackText acknowledgement source text
   * @param {object} evTimeStamp timestamp of the event transition
   * @param {object} ackTimeStamp timestamp of the acknowledgement
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {number=} options.acknowledgingProcessIdentifier process identifier; defaults to 57
   * @param {ConfirmedCallback} next completion callback
   */
  acknowledgeAlarm(address, objectId, eventState, ackText, evTimeStamp, ackTimeStamp, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    const acknowledgingProcessIdentifier =
      options.acknowledgingProcessIdentifier === undefined ?
        DEFAULT_ACKNOWLEDGING_PROCESS_IDENTIFIER : options.acknowledgingProcessIdentifier;
    if (!Number.isSafeInteger(acknowledgingProcessIdentifier) ||
        acknowledgingProcessIdentifier < 0 ||
        acknowledgingProcessIdentifier > MAX_BACNET_UNSIGNED) {
      throw clientError(
        'ERR_INVALID_ACKNOWLEDGING_PROCESS_IDENTIFIER',
        'acknowledgingProcessIdentifier must be an integer from 0 through 4294967295'
      );
    }
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.ACKNOWLEDGE_ALARM,
      options,
      baEnum.PduTypes.SIMPLE_ACK,
      (buffer) => baServices.alarmAcknowledge.encode(
        buffer,
        acknowledgingProcessIdentifier,
        objectId,
        eventState,
        ackText,
        evTimeStamp,
        ackTimeStamp
      ),
      this._confirmedCallback(next)
    );
  }

  /**
   * Sends a confirmed vendor-specific private transfer. Its effects are
   * vendor-defined and may mutate a device; use only an authorized target with
   * a reviewed vendor service contract.
   *
   * @function bacstack#confirmedPrivateTransfer
   * @param {BacnetAddress} address direct or routed target device
   * @param {number} vendorId vendor identifier
   * @param {number} serviceNumber vendor service number
   * @param {(Buffer|Uint8Array|number[])=} data opaque service payload
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {ConfirmedCallback} next completion callback
   */
  confirmedPrivateTransfer(address, vendorId, serviceNumber, data, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.CONFIRMED_PRIVATE_TRANSFER,
      options,
      baEnum.PduTypes.COMPLEX_ACK,
      (buffer) => baServices.privateTransfer.encode(buffer, vendorId, serviceNumber, data),
      this._confirmedCallback(next, baServices.privateTransfer.decode)
    );
  }

  /**
   * Sends an unconfirmed vendor-specific private transfer. Its effects are
   * vendor-defined and may mutate a device; use only an authorized target with
   * a reviewed vendor service contract.
   *
   * @function bacstack#unconfirmedPrivateTransfer
   * @param {BacnetAddress} address direct, routed, or broadcast target
   * @param {number} vendorId vendor identifier
   * @param {number} serviceNumber vendor service number
   * @param {(Buffer|Uint8Array|number[])=} data opaque service payload
   */
  unconfirmedPrivateTransfer(address, vendorId, serviceNumber, data) {
    const normalizedAddress = this._normalizeAddress(address);
    const buffer = this._getBuffer();
    this._encodeNpdu(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE, normalizedAddress);
    baApdu.encodeUnconfirmedServiceRequest(buffer, baEnum.PduTypes.UNCONFIRMED_REQUEST, baEnum.UnconfirmedServiceChoice.UNCONFIRMED_PRIVATE_TRANSFER);
    this._encodeSafely(() =>
      baServices.privateTransfer.encode(buffer, vendorId, serviceNumber, data)
    );
    const npduType = this._isBroadcastAddress(normalizedAddress) ?
      baEnum.BvlcResultPurpose.ORIGINAL_BROADCAST_NPDU :
      baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU;
    this._finalizeBuffer(buffer, npduType);
    this._sendBuffer(buffer, normalizedAddress);
  }

  /**
   * Retrieves event-enrollment summaries matching the supplied filters.
   *
   * @function bacstack#getEnrollmentSummary
   * @param {BacnetAddress} address direct or routed target device
   * @param {number} acknowledgmentFilter acknowledgement filter enumeration
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {object=} options.enrollmentFilter object and process filter
   * @param {number=} options.eventStateFilter value from `bacnet.enum.EventState`
   * @param {number=} options.eventTypeFilter value from `bacnet.enum.EventType`
   * @param {object=} options.priorityFilter inclusive priority range
   * @param {number} options.priorityFilter.min minimum priority from 0 through 255
   * @param {number} options.priorityFilter.max maximum priority from 0 through 255
   * @param {number=} options.notificationClassFilter notification class filter
   * @param {ConfirmedCallback} next completion callback
   */
  getEnrollmentSummary(address, acknowledgmentFilter, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.GET_ENROLLMENT_SUMMARY,
      options,
      baEnum.PduTypes.COMPLEX_ACK,
      (buffer) => baServices.getEnrollmentSummary.encode(
        buffer,
        acknowledgmentFilter,
        options.enrollmentFilter,
        options.eventStateFilter,
        options.eventTypeFilter,
        options.priorityFilter,
        options.notificationClassFilter
      ),
      this._confirmedCallback(next, baServices.getEnrollmentSummary.decodeAcknowledge)
    );
  }

  /**
   * Sends an unconfirmed event notification. This can affect alarm or event
   * processing on receivers; send it only to authorized, disposable targets
   * with validated event data.
   *
   * @function bacstack#unconfirmedEventNotification
   * @param {BacnetAddress} address direct, routed, or broadcast target
   * @param {object} eventNotification BACnet event-notification data
   */
  unconfirmedEventNotification(address, eventNotification) {
    const normalizedAddress = this._normalizeAddress(address);
    const buffer = this._getBuffer();
    this._encodeNpdu(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE, normalizedAddress);
    baApdu.encodeUnconfirmedServiceRequest(buffer, baEnum.PduTypes.UNCONFIRMED_REQUEST, baEnum.UnconfirmedServiceChoice.UNCONFIRMED_EVENT_NOTIFICATION);
    this._encodeSafely(() => baServices.eventNotifyData.encode(buffer, eventNotification));
    const npduType = this._isBroadcastAddress(normalizedAddress) ?
      baEnum.BvlcResultPurpose.ORIGINAL_BROADCAST_NPDU :
      baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU;
    this._finalizeBuffer(buffer, npduType);
    this._sendBuffer(buffer, normalizedAddress);
  }

  /**
   * Sends a confirmed event notification. This can affect alarm or event
   * processing on the receiver; send it only to an authorized, disposable
   * target with validated event data.
   *
   * @function bacstack#confirmedEventNotification
   * @param {BacnetAddress} address direct or routed target device
   * @param {object} eventNotification BACnet event-notification data
   * @param {ConfirmedRequestOptions=} options confirmed-request options
   * @param {ConfirmedCallback} next completion callback
   */
  confirmedEventNotification(address, eventNotification, options, next) {
    next = next || options;
    options = options && typeof options === 'object' ? options : {};
    this._sendConfirmedRequest(
      address,
      baEnum.ConfirmedServiceChoice.CONFIRMED_EVENT_NOTIFICATION,
      options,
      baEnum.PduTypes.SIMPLE_ACK,
      (buffer) => baServices.eventNotifyData.encode(buffer, eventNotification),
      this._confirmedCallback(next)
    );
  }

  // Public Device Functions
  /**
   * Sends a typed ReadProperty ComplexACK for an inbound request. Prefer the
   * generation-bound `event.reply.readProperty(...)` capability. This helper's
   * preferred form is `readPropertyResponse(event.reply, objectId, property,
   * values)`. The legacy address/invoke-ID form is compatibility-only and is
   * disabled unless `allowUntrackedServerResponses` is explicitly enabled.
   *
   * @function bacstack#readPropertyResponse
   * @param {ConfirmedReply} reply reply capability from the request event
   * @param {BacnetObjectId} objectId object included in the response
   * @param {BacnetPropertyReference} property property included in the response
   * @param {BacnetApplicationValue[]} value typed response value
   * @returns {(boolean|undefined)} transport send result
   */
  readPropertyResponse(receiver, invokeId, objectId, property, value, reply) {
    let context = this._replyContext(receiver);
    if (context) return this._replyReadProperty(context, invokeId, objectId, property);
    context = this._replyContext(reply);
    if (context) {
      this._validateReplyIdentity(
        context,
        receiver,
        baEnum.ConfirmedServiceChoice.READ_PROPERTY,
        invokeId
      );
      return this._replyReadProperty(context, objectId, property, value);
    }
    const normalizedReceiver = this._normalizeAddress(receiver);
    const buffer = this._getBuffer();
    this._encodeNpdu(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE, normalizedReceiver);
    this._encodeSafely(() => {
      baApdu.encodeComplexAck(buffer, baEnum.PduTypes.COMPLEX_ACK, baEnum.ConfirmedServiceChoice.READ_PROPERTY, invokeId);
      baServices.readProperty.encodeAcknowledge(buffer, objectId, property.id, property.index, value);
    });
    this._finalizeBuffer(buffer, baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU);
    return this._sendServerResponse(
      buffer,
      normalizedReceiver,
      baEnum.ConfirmedServiceChoice.READ_PROPERTY,
      invokeId
    );
  }

  /**
   * Sends a typed ReadPropertyMultiple ComplexACK for an inbound request.
   * Prefer `event.reply.readPropertyMultiple(values)`. This helper's preferred
   * form is `readPropertyMultipleResponse(event.reply, values)`. The legacy
   * address/invoke-ID form is compatibility-only and requires the explicit
   * `allowUntrackedServerResponses` option.
   *
   * @function bacstack#readPropertyMultipleResponse
   * @param {ConfirmedReply} reply reply capability from the request event
   * @param {object[]} values ReadPropertyMultiple result objects
   * @returns {(boolean|undefined)} transport send result
   */
  readPropertyMultipleResponse(receiver, invokeId, values, reply) {
    let context = this._replyContext(receiver);
    if (context) return this._replyReadPropertyMultiple(context, invokeId);
    context = this._replyContext(reply);
    if (context) {
      this._validateReplyIdentity(
        context,
        receiver,
        baEnum.ConfirmedServiceChoice.READ_PROPERTY_MULTIPLE,
        invokeId
      );
      return this._replyReadPropertyMultiple(context, values);
    }
    const normalizedReceiver = this._normalizeAddress(receiver);
    const buffer = this._getBuffer();
    this._encodeNpdu(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE, normalizedReceiver);
    this._encodeSafely(() => {
      baApdu.encodeComplexAck(buffer, baEnum.PduTypes.COMPLEX_ACK, baEnum.ConfirmedServiceChoice.READ_PROPERTY_MULTIPLE, invokeId);
      baServices.readPropertyMultiple.encodeAcknowledge(buffer, values);
    });
    this._finalizeBuffer(buffer, baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU);
    return this._sendServerResponse(
      buffer,
      normalizedReceiver,
      baEnum.ConfirmedServiceChoice.READ_PROPERTY_MULTIPLE,
      invokeId
    );
  }

  /**
   * Broadcasts an I-Am announcement for a local device identity.
   *
   * @function bacstack#iAmResponse
   * @param {number} deviceId Device object instance
   * @param {number} segmentation value from `bacnet.enum.Segmentation`
   * @param {number} vendorId BACnet vendor identifier
   * @param {number=} maxApdu maximum accepted APDU length; defaults to 1476
   */
  iAmResponse(deviceId, segmentation, vendorId, maxApdu) {
    const broadcastAddress = this._normalizeAddress(this._transport.getBroadcastAddress());
    const buffer = this._getBuffer();
    this._encodeNpdu(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE, broadcastAddress);
    baApdu.encodeUnconfirmedServiceRequest(buffer, baEnum.PduTypes.UNCONFIRMED_REQUEST, baEnum.UnconfirmedServiceChoice.I_AM);
    this._encodeSafely(() => baServices.iAmBroadcast.encode(
      buffer,
      deviceId,
      maxApdu == null ? DEFAULT_MAX_APDU_LENGTH : maxApdu,
      segmentation,
      vendorId
    ));
    this._finalizeBuffer(buffer, baEnum.BvlcResultPurpose.ORIGINAL_BROADCAST_NPDU);
    this._sendBuffer(buffer, broadcastAddress);
  }

  /**
   * Broadcasts an I-Have announcement for a local object.
   *
   * @function bacstack#iHaveResponse
   * @param {(number|BacnetObjectId)} deviceId Device instance or Device object identifier
   * @param {BacnetObjectId} objectId advertised object identifier
   * @param {string} objectName advertised object name
   */
  iHaveResponse(deviceId, objectId, objectName) {
    const broadcastAddress = this._normalizeAddress(this._transport.getBroadcastAddress());
    const buffer = this._getBuffer();
    this._encodeNpdu(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE, broadcastAddress);
    baApdu.encodeUnconfirmedServiceRequest(buffer, baEnum.PduTypes.UNCONFIRMED_REQUEST, baEnum.UnconfirmedServiceChoice.I_HAVE);
    const deviceObjectId = typeof deviceId === 'number' ? {type: baEnum.ObjectType.DEVICE, instance: deviceId} : deviceId;
    this._encodeSafely(() =>
      baServices.iHaveBroadcast.encode(buffer, deviceObjectId, objectId, objectName)
    );
    this._finalizeBuffer(buffer, baEnum.BvlcResultPurpose.ORIGINAL_BROADCAST_NPDU);
    this._sendBuffer(buffer, broadcastAddress);
  }

  /**
   * Sends a SimpleACK for an inbound confirmed request. Prefer
   * `event.reply.simpleAck()`. This helper's preferred form is
   * `simpleAckResponse(event.reply)`. The legacy address/service/invoke-ID form
   * is compatibility-only and requires `allowUntrackedServerResponses`.
   *
   * @function bacstack#simpleAckResponse
   * @param {ConfirmedReply} reply reply capability from the request event
   * @returns {(boolean|undefined)} transport send result
   */
  simpleAckResponse(receiver, service, invokeId, reply) {
    let context = this._replyContext(receiver);
    if (context) return this._replySimpleAck(context);
    context = this._replyContext(reply);
    if (context) {
      this._validateReplyIdentity(context, receiver, service, invokeId);
      return this._replySimpleAck(context);
    }
    if (!SIMPLE_ACK_SERVICES.has(service)) throw clientError('ERR_INVALID_SERVER_REPLY');
    const normalizedReceiver = this._normalizeAddress(receiver);
    const buffer = this._getBuffer();
    this._encodeNpdu(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE, normalizedReceiver);
    baApdu.encodeSimpleAck(buffer, baEnum.PduTypes.SIMPLE_ACK, service, invokeId);
    this._finalizeBuffer(buffer, baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU);
    return this._sendServerResponse(buffer, normalizedReceiver, service, invokeId);
  }

  /**
   * Sends an Error PDU for an inbound confirmed request. Prefer
   * `event.reply.error(errorClass, errorCode)`. This helper's preferred form is
   * `errorResponse(event.reply, errorClass, errorCode)`. The legacy form is
   * compatibility-only and requires `allowUntrackedServerResponses`.
   *
   * @function bacstack#errorResponse
   * @param {ConfirmedReply} reply reply capability from the request event
   * @param {number} errorClass BACnet error class from 0 through 255
   * @param {number} errorCode BACnet error code from 0 through 255
   * @returns {(boolean|undefined)} transport send result
   */
  errorResponse(receiver, service, invokeId, errorClass, errorCode, reply) {
    let context = this._replyContext(receiver);
    if (context) return this._replyError(context, service, invokeId);
    context = this._replyContext(reply);
    if (context) {
      this._validateReplyIdentity(context, receiver, service, invokeId);
      return this._replyError(context, errorClass, errorCode);
    }
    this._assertReplyByte(errorClass, 'ERR_INVALID_ERROR_CLASS');
    this._assertReplyByte(errorCode, 'ERR_INVALID_ERROR_CODE');
    const normalizedReceiver = this._normalizeAddress(receiver);
    const buffer = this._getBuffer();
    this._encodeNpdu(buffer, baEnum.NpduControlPriority.NORMAL_MESSAGE, normalizedReceiver);
    baApdu.encodeError(buffer, baEnum.PduTypes.ERROR, service, invokeId);
    baServices.error.encode(buffer, errorClass, errorCode);
    this._finalizeBuffer(buffer, baEnum.BvlcResultPurpose.ORIGINAL_UNICAST_NPDU);
    return this._sendServerResponse(buffer, normalizedReceiver, service, invokeId);
  }

  /**
   * Sends a ComplexACK for the service bound to an inbound request. Prefer the
   * equivalent `event.reply.complexAck(payload)` capability.
   *
   * @function bacstack#complexAckResponse
   * @param {ConfirmedReply} reply reply capability from the request event
   * @param {(Buffer|Uint8Array|function(object))} payload encoded service payload or encoder callback
   * @returns {(boolean|undefined)} transport send result
   */
  complexAckResponse(reply, payload) {
    const context = this._replyContext(reply);
    if (!context) throw clientError('ERR_SERVER_REPLY_REQUIRED');
    return this._replyComplexAck(context, payload);
  }

  /**
   * Sends a Reject PDU for an inbound request. Prefer the equivalent
   * `event.reply.reject(reason)` capability.
   *
   * @function bacstack#rejectResponse
   * @param {ConfirmedReply} reply reply capability from the request event
   * @param {number} reason BACnet reject reason from 0 through 255
   * @returns {(boolean|undefined)} transport send result
   */
  rejectResponse(reply, reason) {
    const context = this._replyContext(reply);
    if (!context) throw clientError('ERR_SERVER_REPLY_REQUIRED');
    return this._replyReject(context, reason);
  }

  /**
   * Sends a server Abort PDU for an inbound request. Prefer the equivalent
   * `event.reply.abort(reason)` capability.
   *
   * @function bacstack#abortResponse
   * @param {ConfirmedReply} reply reply capability from the request event
   * @param {number} reason BACnet abort reason from 0 through 255
   * @returns {(boolean|undefined)} transport send result
   */
  abortResponse(reply, reason) {
    const context = this._replyContext(reply);
    if (!context) throw clientError('ERR_SERVER_REPLY_REQUIRED');
    return this._replyAbort(context, reason);
  }

  /**
   * Unloads the current BACstack instance and closes the underlying UDP socket.
   * @function bacstack#close
   * @example
   * const bacnet = require('bacstack');
   * const client = new bacnet();
   *
   * client.close();
   */
  close() {
    if (this._closed) return;
    this._closed = true;
    let closeError;
    try {
      this._transactions.close(clientError('ERR_CLIENT_CLOSED'));
    } catch (err) {
      closeError = err;
    } finally {
      try {
        this._segments.cancelAll();
      } catch (err) {
        closeError = closeError || err;
      }
      try {
        this._serverTransactions.close();
      } catch (err) {
        closeError = closeError || err;
      }
      try {
        this._transport.close();
      } catch (err) {
        closeError = closeError || err;
      }
    }
    if (closeError) throw closeError;
  }

  /**
   * Returns a detached snapshot of the active transport's connection and
   * diagnostic state. BACnet/IP transports may expose only `state`.
   *
   * @function bacstack#getTransportStatus
   * @returns {object} detached transport status snapshot
   */
  getTransportStatus() {
    if (this._transport && typeof this._transport.getStatus === 'function') {
      return this._transport.getStatus();
    }
    return {
      state: this._transport && typeof this._transport.getState === 'function' ? this._transport.getState() : 'unknown'
    };
  }
}
module.exports = Client;
