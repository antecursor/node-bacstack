'use strict';

const expect      = require('chai').expect;
const utils       = require('./utils');
const baServices  = require('../../lib/services');

describe('bacstack - Services layer TimeSync unit', () => {
  it('should successfully encode and decode', () => {
    const buffer = utils.getBuffer();
    const date = new Date();
    date.setMilliseconds(990);
    baServices.timeSync.encode(buffer, date);
    const result = baServices.timeSync.decode(buffer.buffer, 0, buffer.offset);
    delete result.len;
    expect(result).to.deep.equal({
      value: date
    });
  });

  it('should honor the APDU boundary from a non-zero offset', () => {
    const buffer = utils.getBuffer();
    const offset = 11;
    const date = new Date(2026, 6, 18, 14, 35, 27, 990);
    buffer.offset = offset;
    baServices.timeSync.encode(buffer, date);
    const length = buffer.offset - offset;

    const result = baServices.timeSync.decode(buffer.buffer, offset, length);
    expect(result.value).to.deep.equal(date);
    for (let truncatedLength = 0; truncatedLength < length; truncatedLength++) {
      expect(() => baServices.timeSync.decode(buffer.buffer, offset, truncatedLength)).not.to.throw();
      expect(baServices.timeSync.decode(buffer.buffer, offset, truncatedLength)).to.equal(undefined);
    }
    expect(baServices.timeSync.decode(buffer.buffer, offset, length + 1)).to.equal(undefined);
  });
});
