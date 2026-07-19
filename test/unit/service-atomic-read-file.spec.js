'use strict';

const expect      = require('chai').expect;
const utils       = require('./utils');
const baServices  = require('../../lib/services');

describe('bacstack - Services layer AtomicReadFile unit', () => {
  it('should successfully encode and decode as stream', () => {
    const buffer = utils.getBuffer();
    baServices.atomicReadFile.encode(buffer, true, {type: 13, instance: 5000}, -50, 12);
    const result = baServices.atomicReadFile.decode(buffer.buffer, 0);
    delete result.len;
    expect(result).to.deep.equal({
      objectId: {type: 13, instance: 5000},
      count: 12,
      isStream: true,
      position: -50
    });
  });

  it('should successfully encode and decode as non-stream', () => {
    const buffer = utils.getBuffer();
    baServices.atomicReadFile.encode(buffer, false, {type: 14, instance: 5001}, 60, 13);
    const result = baServices.atomicReadFile.decode(buffer.buffer, 0);
    delete result.len;
    expect(result).to.deep.equal({
      objectId: {type: 14, instance: 5001},
      count: 13,
      isStream: false,
      position: 60
    });
  });
});

describe('AtomicReadFileAcknowledge', () => {
  it('should successfully encode and decode as stream', () => {
    const buffer = utils.getBuffer();
    baServices.atomicReadFile.encodeAcknowledge(buffer, true, false, 0, 90, [[12, 12, 12]], [3]);
    const result = baServices.atomicReadFile.decodeAcknowledge(buffer.buffer, 0);
    delete result.len;
    expect(result).to.deep.equal({
      isStream: true,
      position: 0,
      endOfFile: false,
      buffer: Buffer.from([12, 12, 12])
    });
  });

  it('should successfully encode and decode as non-stream', () => {
    const buffer = utils.getBuffer();
    baServices.atomicReadFile.encodeAcknowledge(
      buffer,
      false,
      false,
      12,
      2,
      [[1], [2, 3]],
      [1, 2]
    );
    const result = baServices.atomicReadFile.decodeAcknowledge(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      isStream: false,
      position: 12,
      endOfFile: false,
      blockCount: 2,
      blocks: [Buffer.from([1]), Buffer.from([2, 3])]
    });
  });

  it('returns owned stream data that does not alias the input', () => {
    const writer = utils.getBuffer();
    baServices.atomicReadFile.encodeAcknowledge(writer, true, false, 0, 1, [[1, 2, 3]], [3]);
    const input = Buffer.from(writer.buffer.subarray(0, writer.offset));
    const result = baServices.atomicReadFile.decodeAcknowledge(input, 0, input.length);

    input.fill(0);
    expect(result.buffer).to.deep.equal(Buffer.from([1, 2, 3]));
    result.buffer[0] = 0xFF;
    expect(input.includes(0xFF)).to.equal(false);
  });

  it('returns owned record data that does not alias the input', () => {
    const writer = utils.getBuffer();
    baServices.atomicReadFile.encodeAcknowledge(writer, false, false, 0, 2, [[1], [2, 3]], [1, 2]);
    const input = Buffer.from(writer.buffer.subarray(0, writer.offset));
    const result = baServices.atomicReadFile.decodeAcknowledge(input, 0, input.length);

    input.fill(0);
    expect(result.blocks).to.deep.equal([Buffer.from([1]), Buffer.from([2, 3])]);
    result.blocks[1][0] = 0xFF;
    expect(input.includes(0xFF)).to.equal(false);
  });
});
