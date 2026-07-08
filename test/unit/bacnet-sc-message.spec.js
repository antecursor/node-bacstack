'use strict';

const expect = require('chai').expect;
const sc = require('../../lib/bacnet-sc/message');

describe('bacstack - BACnet/SC message layer', () => {
  it('encodes and decodes an encapsulated NPDU', () => {
    const payload = Buffer.from([0x01, 0x20, 0xFF]);
    const encoded = sc.encode(sc.FUNCTIONS.ENCAPSULATED_NPDU, {
      id: 7,
      originating: '020000000001',
      destination: 'ff:ff:ff:ff:ff:ff',
      payload: payload
    });
    const decoded = sc.decode(encoded);

    expect(decoded.function).to.equal(sc.FUNCTIONS.ENCAPSULATED_NPDU);
    expect(decoded.id).to.equal(7);
    expect(decoded.originating).to.equal('020000000001');
    expect(decoded.destination).to.equal(sc.BROADCAST_VMAC);
    expect(decoded.payload).to.deep.equal(payload);
  });

  it('encodes and decodes connect payloads', () => {
    const payload = sc.encodeConnectPayload({
      vmac: '02:00:00:00:00:01',
      uuid: '11111111-2222-4333-8444-555555555555',
      maxBvlc: 1600,
      maxNpdu: 1497
    });
    const decoded = sc.decodeConnectPayload(payload);

    expect(decoded).to.deep.equal({
      vmac: '020000000001',
      uuid: '11111111-2222-4333-8444-555555555555',
      maxBvlc: 1600,
      maxNpdu: 1497
    });
  });

  it('rejects malformed VMAC values', () => {
    expect(() => sc.normalizeVmac('not-a-vmac')).to.throw('BACNET_SC_INVALID_VMAC');
    expect(() => sc.normalizeVmac([1, 2, 3])).to.throw('BACNET_SC_INVALID_VMAC');
  });

  it('encodes and decodes BVLC-Result NAK payloads', () => {
    const payload = sc.encodeBvlcResultPayload({
      forFunction: sc.FUNCTIONS.CONNECT_REQUEST,
      resultCode: 1,
      errorHeaderMarker: 0,
      errorClass: 5,
      errorCode: 42,
      errorDetails: 'duplicate vmac'
    });
    const decoded = sc.decodeBvlcResultPayload(payload);

    expect(decoded).to.deep.equal({
      forFunction: sc.FUNCTIONS.CONNECT_REQUEST,
      resultCode: 1,
      errorHeaderMarker: 0,
      errorClass: 5,
      errorCode: 42,
      errorDetails: 'duplicate vmac'
    });
  });
});
