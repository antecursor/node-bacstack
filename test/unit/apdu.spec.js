'use strict';

const expect      = require('chai').expect;
const utils       = require('./utils');
const baApdu      = require('../../lib/apdu');

describe('bacstack - APDU layer', () => {
  it('should reject truncated APDU headers', () => {
    const cases = [
      {decode: baApdu.decodeConfirmedServiceRequest, bytes: [0, 0, 1, 12]},
      {decode: baApdu.decodeConfirmedServiceRequest, bytes: [8, 0, 1, 2, 3, 12]},
      {decode: baApdu.decodeUnconfirmedServiceRequest, bytes: [16, 8]},
      {decode: baApdu.decodeSimpleAck, bytes: [32, 1, 12]},
      {decode: baApdu.decodeComplexAck, bytes: [48, 1, 12]},
      {decode: baApdu.decodeComplexAck, bytes: [56, 1, 2, 3, 12]},
      {decode: baApdu.decodeSegmentAck, bytes: [64, 1, 2, 3]},
      {decode: baApdu.decodeError, bytes: [80, 1, 12]},
      {decode: baApdu.decodeAbort, bytes: [112, 1, 2]}
    ];

    cases.forEach((entry) => {
      const packet = Buffer.from(entry.bytes);
      for (let length = 0; length < packet.length; length++) {
        expect(entry.decode(packet, 0, length)).to.equal(undefined);
      }
      expect(entry.decode(packet, 0, packet.length)).to.be.an('object');
    });
  });

  describe('decodedType', () => {
    it('should correctly encode and decode a package', () => {
      const value = [0, 128, 4, 5];
      baApdu.setDecodedType(value, 1, 48);
      const result = baApdu.getDecodedInvokeId(value, 1);
      expect(result).to.equal(4);
    });

    it('should correctly encode and decode a confirmed service package', () => {
      const value = [0, 128, 4, 5];
      baApdu.setDecodedType(value, 1, 0);
      const result = baApdu.getDecodedInvokeId(value, 1);
      expect(result).to.equal(5);
    });

    it('should fail if decode an invalid package', () => {
      const value = [0, 128, 4, 5];
      const result = baApdu.getDecodedInvokeId(value, 1);
      expect(result).to.equal(undefined);
    });
  });

  describe('confirmedServiceRequest', () => {
    it('should correctly encode and decode a package', () => {
      const buffer = utils.getBuffer();
      baApdu.encodeConfirmedServiceRequest(buffer, 0, 41, 176, 12, 44, 45, 46);
      const result = baApdu.decodeConfirmedServiceRequest(buffer.buffer, 0);
      expect(result).to.deep.equal({
        len: 4,
        type: 0,
        service: 41,
        maxSegments: 176,
        maxApdu: 12,
        invokeId: 44,
        sequencenumber: 0,
        proposedWindowNumber: 0
      });
    });

    it('should correctly encode and decode a segmented package', () => {
      const buffer = utils.getBuffer();
      baApdu.encodeConfirmedServiceRequest(buffer, 8, 47, 208, 14, 50, 51, 52);
      const result = baApdu.decodeConfirmedServiceRequest(buffer.buffer, 0);
      expect(result).to.deep.equal({
        len: 6,
        type: 8,
        service: 47,
        maxSegments: 208,
        maxApdu: 14,
        invokeId: 50,
        sequencenumber: 51,
        proposedWindowNumber: 52
      });
    });
  });

  describe('unconfirmedServiceRequest', () => {
    it('should correctly encode and decode a package', () => {
      const buffer = utils.getBuffer();
      baApdu.encodeUnconfirmedServiceRequest(buffer, 33, 34);
      const result = baApdu.decodeUnconfirmedServiceRequest(buffer.buffer, 0);
      expect(result).to.deep.equal({
        len: 2,
        type: 33,
        service: 34
      });
    });
  });

  describe('simpleAck', () => {
    it('should correctly encode and decode a package', () => {
      const buffer = utils.getBuffer();
      baApdu.encodeSimpleAck(buffer, 11, 12, 13);
      const result = baApdu.decodeSimpleAck(buffer.buffer, 0);
      expect(result).to.deep.equal({
        len: 3,
        type: 11,
        service: 12,
        invokeId: 13
      });
    });
  });

  describe('complexAck', () => {
    it('should correctly encode and decode a package', () => {
      const buffer = utils.getBuffer();
      baApdu.encodeComplexAck(buffer, 0, 15, 16, 20, 21);
      const result = baApdu.decodeComplexAck(buffer.buffer, 0);
      expect(result).to.deep.equal({
        len: 3,
        type: 0,
        service: 15,
        invokeId: 16,
        sequencenumber: 0,
        proposedWindowNumber: 0
      });
    });

    it('should correctly encode and decode a segmented package', () => {
      const buffer = utils.getBuffer();
      baApdu.encodeComplexAck(buffer, 8, 18, 19, 20, 21);
      const result = baApdu.decodeComplexAck(buffer.buffer, 0);
      expect(result).to.deep.equal({
        len: 5,
        type: 8,
        service: 18,
        invokeId: 19,
        sequencenumber: 20,
        proposedWindowNumber: 21
      });
    });
  });

  describe('segmentAck', () => {
    it('should correctly encode and decode a package', () => {
      const buffer = utils.getBuffer();
      baApdu.encodeSegmentAck(buffer, 6, 7, 8, 9);
      const result = baApdu.decodeSegmentAck(buffer.buffer, 0);
      expect(result).to.deep.equal({
        len: 4,
        type: 6,
        originalInvokeId: 7,
        sequencenumber: 8,
        actualWindowSize: 9
      });
    });
  });

  describe('error', () => {
    it('should correctly encode and decode a package', () => {
      const buffer = utils.getBuffer();
      baApdu.encodeError(buffer, 5, 6, 7);
      const result = baApdu.decodeError(buffer.buffer, 0);
      expect(result).to.deep.equal({
        len: 3,
        type: 5,
        service: 6,
        invokeId: 7
      });
    });
  });

  describe('abort', () => {
    it('should correctly encode and decode a package', () => {
      const buffer = utils.getBuffer();
      baApdu.encodeAbort(buffer, 4, 5, 6);
      const result = baApdu.decodeAbort(buffer.buffer, 0);
      expect(result).to.deep.equal({
        len: 3,
        type: 4,
        invokeId: 5,
        reason: 6
      });
    });
  });
});
