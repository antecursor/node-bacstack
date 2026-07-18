'use strict';

const createSocket      = require('dgram').createSocket;
const EventEmitter      = require('events').EventEmitter;

class Transport extends EventEmitter {
  constructor(settings) {
    super();
    this._settings = Object.assign({
      port: 47808,
      destinationPort: 47808,
      broadcastAddress: '255.255.255.255'
    }, settings);
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

  getMaxPayload() {
    return 1482;
  }

  send(buffer, offset, receiver) {
    this._server.send(buffer, 0, offset, this._settings.destinationPort, receiver);
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
