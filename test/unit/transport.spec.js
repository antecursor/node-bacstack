'use strict';

const createSocket      = require('dgram').createSocket;
const once              = require('events').once;
const expect            = require('chai').expect;
const Transport         = require('../../lib/transport');

describe('bacstack - UDP transport', () => {
  it('reports its IPv4-only BACnet/IP address capability', () => {
    const transport = new Transport({port: 0});

    expect(transport.getAddressKind()).to.equal('ip');
    expect(transport.getIpVersion()).to.equal(4);
    expect(transport.supportsAddress('192.0.2.10')).to.equal(true);
    expect(transport.supportsAddress('2001:db8::10')).to.equal(false);
    transport.close();
  });

  it('rejects IPv6 BACnet/IP settings synchronously', () => {
    const cases = [
      {broadcastAddress: '2001:db8::ffff'},
      {interface: '2001:db8::1'}
    ];

    cases.forEach((settings) => {
      expect(() => new Transport(settings))
        .to.throw('supports IPv4 addresses only')
        .with.property('code', 'ERR_UNSUPPORTED_ADDRESS_FAMILY');
    });
  });

  it('validates UDP port settings before use', () => {
    const cases = [
      {port: -1},
      {port: 65536},
      {port: 47808.5},
      {destinationPort: 0},
      {destinationPort: 65536},
      {destinationPort: '47808'}
    ];

    cases.forEach((settings) => {
      expect(() => new Transport(settings))
        .to.throw('must be a whole number')
        .with.property('code', 'ERR_INVALID_PORT');
    });
  });

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

  it('uses a validated per-send destination port when supplied by the client', () => {
    const transport = new Transport({port: 0, destinationPort: 47808});
    const calls = [];
    transport._server.send = (...args) => calls.push(args);

    transport.send(
      Buffer.from([1, 2, 3]),
      3,
      '192.0.2.10',
      {destinationPort: 47809}
    );

    expect(calls[0][3]).to.equal(47809);
    expect(calls[0][4]).to.equal('192.0.2.10');
    expect(() => transport.send(
      Buffer.from([1]),
      1,
      '192.0.2.10',
      {destinationPort: 0}
    )).to.throw().with.property('code', 'ERR_INVALID_PORT');
    transport.close();
  });

  it('rejects IPv6 destinations before asking the udp4 socket to send', () => {
    const transport = new Transport({port: 0});

    expect(() => transport.send(Buffer.from([1]), 1, '2001:db8::10'))
      .to.throw('supports IPv4 destinations only')
      .with.property('code', 'ERR_UNSUPPORTED_ADDRESS_FAMILY');
    transport.close();
  });

  it('can be closed repeatedly', () => {
    const transport = new Transport({port: 0});
    expect(() => transport.close()).not.to.throw();
    expect(() => transport.close()).not.to.throw();
  });
});
