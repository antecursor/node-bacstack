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

    const defaults = sc.decodeConnectPayload(sc.encodeConnectPayload({
      vmac: '020000000001',
      uuid: '11111111-2222-4333-8444-555555555555'
    }));
    expect(defaults.maxBvlc).to.equal(5705);
    expect(defaults.maxNpdu).to.equal(1497);
  });

  it('rejects malformed VMAC values', () => {
    expect(() => sc.normalizeVmac('not-a-vmac')).to.throw('BACNET_SC_INVALID_VMAC');
    expect(() => sc.normalizeVmac([1, 2, 3])).to.throw('BACNET_SC_INVALID_VMAC');
    expect(() => sc.normalizeVmac([1, 2, 3, 4, 5, 256])).to.throw('BACNET_SC_INVALID_VMAC');
  });

  it('rejects non-octet message input before reading fields', () => {
    expect(() => sc.decode(null)).to.throw('BACNET_SC_INVALID_MESSAGE');
    expect(() => sc.decode('abcd')).to.throw('BACNET_SC_INVALID_MESSAGE');
    expect(() => sc.decode([1, 0, 0, 1, 256])).to.throw('BACNET_SC_INVALID_MESSAGE');
  });

  it('accepts byte-array views without masking invalid identifiers', () => {
    const encoded = sc.encode(sc.FUNCTIONS.HEARTBEAT_REQUEST, {id: 65535});
    const decoded = sc.decode(new Uint8Array(encoded));

    expect(decoded).to.include({function: sc.FUNCTIONS.HEARTBEAT_REQUEST, id: 65535});
    expect(() => sc.encode(256, {})).to.throw('BACNET_SC_INVALID_FUNCTION');
    expect(() => sc.encode(sc.FUNCTIONS.HEARTBEAT_REQUEST, {id: 65536})).to.throw('BACNET_SC_INVALID_MESSAGE_ID');
  });

  it('validates header option types and encoded lengths', () => {
    expect(() => sc.encode(sc.FUNCTIONS.ENCAPSULATED_NPDU, {
      destOptions: [{type: 0}]
    })).to.throw('BACNET_SC_INVALID_OPTION_TYPE');
    expect(() => sc.encode(sc.FUNCTIONS.ENCAPSULATED_NPDU, {
      dataOptions: [{type: 1, mustUnderstand: false}]
    })).to.throw('BACNET_SC_INVALID_SECURE_PATH_OPTION');
    const current = sc.decode(sc.encode(sc.FUNCTIONS.ENCAPSULATED_NPDU, {
      dataOptions: [{type: 1, everySegment: true}],
      payload: Buffer.from([1])
    }));
    expect(current.dataOptions).to.deep.equal([{
      marker: 0x41,
      type: 1,
      everySegment: true
    }]);
    const legacy = sc.decode(sc.encode(sc.FUNCTIONS.ENCAPSULATED_NPDU, {
      dataOptions: [{type: 1, mustUnderstand: true}],
      payload: Buffer.from([1])
    }));
    expect(legacy.dataOptions).to.deep.equal(current.dataOptions);
    expect(() => sc.encode(sc.FUNCTIONS.ENCAPSULATED_NPDU, {
      dataOptions: [{type: 2, everySegment: true, mustUnderstand: false}],
      payload: Buffer.from([1])
    })).to.throw('BACNET_SC_INVALID_OPTION');
    expect(() => sc.encode(sc.FUNCTIONS.PROPRIETARY_MESSAGE, {
      destOptions: [{type: 31, data: Buffer.from([1, 2])}]
    })).to.throw('BACNET_SC_INVALID_PROPRIETARY_OPTION');
    expect(() => sc.encode(sc.FUNCTIONS.ENCAPSULATED_NPDU, {
      destOptions: [{type: 31, data: Buffer.alloc(65536)}]
    })).to.throw('BACNET_SC_OPTION_TOO_LARGE');
  });

  it('requires exact and internally consistent connect limits', () => {
    const payload = sc.encodeConnectPayload({
      vmac: '020000000001',
      uuid: '11111111-2222-4333-8444-555555555555',
      maxBvlc: 1600,
      maxNpdu: 1497
    });

    expect(() => sc.decodeConnectPayload(Buffer.concat([payload, Buffer.from([0])]))).to.throw('BACNET_SC_INVALID_CONNECT_PAYLOAD');
    expect(() => sc.encodeConnectPayload({
      vmac: '020000000001',
      uuid: '11111111-2222-4333-8444-555555555555',
      maxBvlc: 100,
      maxNpdu: 100
    })).to.throw('BACNET_SC_INCONSISTENT_MAX_LENGTHS');
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

  it('rejects malformed BVLC-Result values and UTF-8', () => {
    expect(() => sc.decodeBvlcResultPayload(Buffer.from([0, 2]))).to.throw('BACNET_SC_INVALID_RESULT_CODE');
    expect(() => sc.decodeBvlcResultPayload(Buffer.from([0, 0, 0]))).to.throw('BACNET_SC_INVALID_BVLC_RESULT');
    expect(() => sc.decodeBvlcResultPayload(Buffer.from([0, 1, 0, 0, 0, 0, 0, 0xC3, 0x28]))).to.throw('BACNET_SC_INVALID_ERROR_DETAILS');
  });
});
