'use strict';

const EventEmitter      = require('events').EventEmitter;
const bacnet            = require('../../');

module.exports.bacnetClient = bacnet;

class Transport extends EventEmitter {
  constructor() {
    super();
  }
  getBroadcastAddress() {
    return '255.255.255.255';
  }
  getMaxPayload() {
    return 1482;
  }
  send() {
    return true;
  }
  open() { }
  close() { }
}
module.exports.transportStub = Transport;

module.exports.createNoDeviceClient = () => new bacnet({
  apduTimeout: 200,
  transport: new Transport()
});

module.exports.propertyFormater = (object) => {
  const converted = {};
  object.forEach(property => converted[property.id] = property.value);
  return converted;
};
