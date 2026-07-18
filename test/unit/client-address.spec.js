'use strict';

const expect = require('chai').expect;
const {
  addressKey,
  getLinkIp,
  linkKey,
  normalizeAddress
} = require('../../lib/client/address');

describe('bacstack - Client address normalization', () => {
  it('normalizes direct IP addresses to one immutable identity', () => {
    const fromString = normalizeAddress(' 10.20.30.40 ');
    const fromObject = normalizeAddress({ip: '10.20.30.40'});

    expect(fromString).to.deep.include({kind: 'ip', ip: '10.20.30.40', linkIp: '10.20.30.40'});
    expect(Object.isFrozen(fromString)).to.equal(true);
    expect(normalizeAddress(fromString)).to.equal(fromString);
    expect(addressKey(fromString)).to.equal(addressKey(fromObject));
    expect(getLinkIp(fromString)).to.equal('10.20.30.40');
    expect(linkKey(fromString)).to.equal(linkKey(fromObject));
  });

  it('preserves and freezes complete routed identities', () => {
    const source = Buffer.from([5, 0xFE]);
    const address = normalizeAddress({ip: '10.20.30.1', net: 303, adr: source});
    source[0] = 99;

    expect(address).to.deep.include({
      kind: 'routed',
      ip: '10.20.30.1',
      net: 303,
      linkIp: '10.20.30.1'
    });
    expect(address.adr).to.deep.equal([5, 0xFE]);
    expect(Object.isFrozen(address)).to.equal(true);
    expect(Object.isFrozen(address.adr)).to.equal(true);
    expect(addressKey(address)).to.equal(addressKey({
      ip: '10.20.30.1',
      net: 303,
      adr: new Uint8Array([5, 0xFE])
    }));
  });

  it('keeps routed peers distinct while exposing their shared link IP', () => {
    const first = {ip: '10.20.30.1', net: 303, adr: [5]};
    const second = {ip: '10.20.30.1', net: 304, adr: [5]};
    const third = {ip: '10.20.30.1', net: 303, adr: [6]};

    expect(addressKey(first)).not.to.equal(addressKey(second));
    expect(addressKey(first)).not.to.equal(addressKey(third));
    expect(linkKey(first)).to.equal(linkKey(second));
    expect(getLinkIp(third)).to.equal('10.20.30.1');
  });

  it('canonicalizes BACnet/SC VMAC representations with a stable link identity', () => {
    const hex = normalizeAddress({vmac: '02:00:00:00:AB:CD'});
    const bytes = normalizeAddress({vmac: [2, 0, 0, 0, 0xAB, 0xCD]});
    const dotted = normalizeAddress({vmac: '2.0.0.0.171.205'});

    expect(hex).to.deep.include({kind: 'vmac', vmac: '02000000abcd', linkIp: null});
    expect(addressKey(hex)).to.equal(addressKey(bytes));
    expect(addressKey(hex)).to.equal(addressKey(dotted));
    expect(getLinkIp(hex)).to.equal(null);
    expect(linkKey(hex)).to.equal(linkKey(bytes));
    expect(addressKey('02:00:00:00:AB:CD', 'vmac')).to.equal(addressKey(hex));
  });

  it('preserves routed BACnet/SC identities separately from their link VMAC', () => {
    const first = normalizeAddress({vmac: '02000000abcd', net: 303, adr: [5]});
    const second = normalizeAddress({vmac: '02000000abcd', net: 304, adr: [5]});

    expect(first.kind).to.equal('vmac-routed');
    expect(addressKey(first)).not.to.equal(addressKey(second));
    expect(linkKey(first)).to.equal(linkKey(second));
  });

  it('canonicalizes IPv6 and rejects names that cannot match receive-side IPs', () => {
    expect(addressKey('2001:0db8:0:0:0:0:0:1')).to.equal(addressKey('2001:db8::1'));
    expect(() => normalizeAddress('example.local')).to.throw('ERR_INVALID_ADDRESS');
  });

  it('rejects incomplete, ambiguous, and out-of-range addresses', () => {
    const invalid = [
      null,
      '',
      {},
      {ip: '10.0.0.1', net: 1},
      {ip: '10.0.0.1', adr: [1]},
      {ip: '10.0.0.1', net: 0x10000, adr: [1]},
      {ip: '10.0.0.1', net: 1, adr: [256]},
      {ip: '10.0.0.1', net: 1, adr: []},
      {ip: '10.0.0.1', vmac: '02000000abcd'},
      {vmac: 'not-a-vmac'},
      {vmac: [1, 2, 3]},
      {vmac: '02000000abcd', net: 1, adr: []}
    ];

    invalid.forEach((value) => expect(() => normalizeAddress(value)).to.throw());
  });
});
