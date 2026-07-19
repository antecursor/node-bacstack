'use strict';

const utils       = require('./utils');

describe('bacstack - whoIs integration', () => {
  it('should not invoke a event if no device is available', (next) => {
    const client = new utils.bacnetClient({apduTimeout: 200, port: 47819, broadcastAddress: '127.0.0.1'});
    client.on('iAm', () => {
      client.close();
      next(new Error('Unallowed Callback'));
    });
    setTimeout(() => {
      client.close();
      next();
    }, 300);
    client.whoIs();
  });
});
