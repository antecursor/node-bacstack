'use strict';

const createSocket      = require('dgram').createSocket;
const EventEmitter      = require('events').EventEmitter;
const net               = require('node:net');

function transportError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function validatePort(value, name, allowZero) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum || value > 0xFFFF) {
    const error = transportError(
      'ERR_INVALID_PORT',
      `${name} must be a whole number between ${minimum} and 65535`
    );
    error.option = name;
    throw error;
  }
}

function validateIpv4(value, name) {
  if (net.isIP(value) === 4) return;
  if (net.isIP(value) === 6) {
    throw transportError(
      'ERR_UNSUPPORTED_ADDRESS_FAMILY',
      `Built-in BACnet/IP ${name} supports IPv4 addresses only`
    );
  }
  throw transportError('ERR_INVALID_ADDRESS', `${name} must be an IPv4 address`);
}

class Transport extends EventEmitter {
  constructor(settings) {
    super();
    this._settings = Object.assign({
      port: 47808,
      destinationPort: 47808,
      broadcastAddress: '255.255.255.255'
    }, settings);
    validatePort(this._settings.port, 'port', true);
    validatePort(this._settings.destinationPort, 'destinationPort', false);
    validateIpv4(this._settings.broadcastAddress, 'broadcastAddress');
    if (this._settings.interface != null) {
      validateIpv4(this._settings.interface, 'interface');
    }
    this._opened = false;
    this._closed = false;
    this._server = createSocket({type: 'udp4', reuseAddr: true});
    this._server.on('message', (msg, rinfo) => this.emit('message', msg, rinfo.address, rinfo.port));
    this._server.on('error', (err) => this.emit('error', err));
    this._server.on('close', () => {
      this._closed = true;
    });
  }

  getBroadcastAddress() {
    return this._settings.broadcastAddress;
  }

  getAddressKind() {
    return 'ip';
  }

  getIpVersion() {
    return 4;
  }

  supportsAddress(address) {
    return net.isIP(address) === 4;
  }

  getMaxPayload() {
    return 1482;
  }

  send(buffer, offset, receiver, context) {
    if (!this.supportsAddress(receiver)) {
      if (net.isIP(receiver) === 6) {
        throw transportError(
          'ERR_UNSUPPORTED_ADDRESS_FAMILY',
          'Built-in BACnet/IP transport supports IPv4 destinations only'
        );
      }
      throw transportError('ERR_INVALID_ADDRESS', 'BACnet/IP destination must be an IPv4 address');
    }
    const destinationPort = context && context.destinationPort != null ?
      context.destinationPort : this._settings.destinationPort;
    validatePort(destinationPort, 'destinationPort', false);
    this._server.send(buffer, 0, offset, destinationPort, receiver);
  }

  open() {
    if (this._opened || this._closed) return;
    this._opened = true;
    this._server.bind(this._settings.port, this._settings.interface, () => {
      this._server.setBroadcast(true);
    });
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      this._server.close();
    } catch (err) {
      if (!err || err.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') {
        this._closed = false;
        throw err;
      }
    }
  }
}
module.exports = Transport;
