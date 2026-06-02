'use strict';

const EventEmitter = require('events').EventEmitter;
const expect = require('chai').expect;
const bacnet = require('../../');

class Transport extends EventEmitter {
  getBroadcastAddress() {
    return '255.255.255.255';
  }

  getMaxPayload() {
    return 1482;
  }

  send() {}

  open() {}

  close() {}
}

function createClient(options) {
  return new bacnet(Object.assign({transport: new Transport(), apduTimeout: 1000}, options));
}

function addPending(client, address, invokeId) {
  const calls = [];
  const key = client._makeInvokeKey(address, invokeId);
  client._addCallback(address, invokeId, (err, result) => calls.push({err, result}));
  return {key, calls};
}

function cleanup(client) {
  client._invokeStore.forEach(entry => clearTimeout(entry.timeout));
  client._invokeStore.clear();
  client.close();
}

describe('bacstack - Client invoke callback matching', () => {
  let client;

  afterEach(() => {
    cleanup(client);
  });

  it('matches exact routed response addresses', () => {
    client = createClient();
    const pending = addPending(client, {ip: '10.90.7.172', net: 303, adr: [5]}, 141);
    const result = {ok: true};

    client._invokeCallback({ip: '10.90.7.172', net: 303, adr: [5]}, 141, null, result);

    expect(pending.calls).to.deep.equal([{err: null, result}]);
    expect(client._invokeStore.has(pending.key)).to.equal(false);
  });

  it('does not match IP-only routed responses by default', () => {
    client = createClient();
    const pending = addPending(client, {ip: '10.90.7.172', net: 303, adr: [5]}, 141);

    client._invokeCallback('10.90.7.172', 141, null, {ok: true});

    expect(pending.calls).to.deep.equal([]);
    expect(client._invokeStore.has(pending.key)).to.equal(true);
  });

  it('matches an IP-only routed response when fallback matching is enabled', () => {
    client = createClient({allowRoutedResponseFallback: true});
    const pending = addPending(client, {ip: '10.90.7.172', net: 303, adr: [5]}, 141);
    const result = {ok: true};

    client._invokeCallback('10.90.7.172', 141, null, result);

    expect(pending.calls).to.deep.equal([{err: null, result}]);
    expect(client._invokeStore.has(pending.key)).to.equal(false);
  });

  it('delivers errors from IP-only routed responses when fallback matching is enabled', () => {
    client = createClient({allowRoutedResponseFallback: true});
    const pending = addPending(client, {ip: '10.90.7.172', net: 303, adr: [5]}, 141);
    const err = new Error('BacnetError - Class:1 - Code:67');

    client._invokeCallback('10.90.7.172', 141, err);

    expect(pending.calls.length).to.equal(1);
    expect(pending.calls[0].err).to.equal(err);
    expect(pending.calls[0].result).to.equal(undefined);
    expect(client._invokeStore.has(pending.key)).to.equal(false);
  });

  it('delivers aborts through the address-aware callback matcher', () => {
    client = createClient({allowRoutedResponseFallback: true});
    const pending = addPending(client, {ip: '10.90.7.172', net: 303, adr: [5]}, 141);

    client._processAbort('10.90.7.172', 141, 9);

    expect(pending.calls.length).to.equal(1);
    expect(pending.calls[0].err.message).to.equal('BacnetAbort - Reason:9');
    expect(pending.calls[0].result).to.equal(undefined);
    expect(client._invokeStore.has(pending.key)).to.equal(false);
  });

  it('does not guess when an IP-only routed response is ambiguous', () => {
    client = createClient({allowRoutedResponseFallback: true});
    const first = addPending(client, {ip: '10.90.7.172', net: 303, adr: [5]}, 141);
    const second = addPending(client, {ip: '10.90.7.172', net: 304, adr: [6]}, 141);

    client._invokeCallback('10.90.7.172', 141, null, {ok: true});

    expect(first.calls).to.deep.equal([]);
    expect(second.calls).to.deep.equal([]);
    expect(client._invokeStore.has(first.key)).to.equal(true);
    expect(client._invokeStore.has(second.key)).to.equal(true);
  });
});
