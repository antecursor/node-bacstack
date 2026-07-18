'use strict';

const createSocket      = require('dgram').createSocket;
const once              = require('events').once;
const expect            = require('chai').expect;
const Transport         = require('../../lib/transport');

describe('bacstack - UDP transport', () => {
  it('uses the standard BACnet port as the backward-compatible destination default', () => {
    const transport = new Transport({port: 0});
    expect(transport._settings.destinationPort).to.equal(47808);
    expect(() => transport.close()).not.to.throw();
  });

  it('emits socket failures as errors rather than packet messages', () => {
    const transport = new Transport({port: 0});
    const expected = new Error('socket failed');
    let messageCount = 0;
    let actual;
    transport.on('message', () => messageCount++);
    transport.on('error', (err) => actual = err);

    transport._server.emit('error', expected);

    expect(actual).to.equal(expected);
    expect(messageCount).to.equal(0);
    transport.close();
  });

  it('sends to the configured destination port', async() => {
    const receiver = createSocket('udp4');
    let transport;
    try {
      receiver.bind(0, '127.0.0.1');
      await once(receiver, 'listening');
      transport = new Transport({
        port: 0,
        interface: '127.0.0.1',
        destinationPort: receiver.address().port
      });
      transport.open();
      await once(transport._server, 'listening');

      const received = once(receiver, 'message');
      transport.send(Buffer.from([1, 2, 3]), 3, '127.0.0.1');
      const [message] = await received;
      expect(message).to.deep.equal(Buffer.from([1, 2, 3]));
    } finally {
      if (transport) transport.close();
      receiver.close();
    }
  });

  it('can be closed repeatedly', () => {
    const transport = new Transport({port: 0});
    expect(() => transport.close()).not.to.throw();
    expect(() => transport.close()).not.to.throw();
  });
});
