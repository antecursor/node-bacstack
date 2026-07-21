'use strict';

const expect = require('chai').expect;

const {
  parseArgs,
  validatePackageListing
} = require('../../scripts/package-smoke-test');

function requiredFiles() {
  return [
    'ARCHITECTURE.md',
    'BACNET_SC.md',
    'CHANGELOG.md',
    'CODE_OF_CONDUCT.md',
    'CONTRIBUTING.md',
    'FAQ.md',
    'LICENSE.md',
    'README.md',
    'RELEASE.md',
    'SECURITY.md',
    'index.js',
    'lib/client.js',
    'lib/enum.js',
    'lib/transport-bacnet-sc.js',
    'package.json'
  ].map((path) => ({path: path}));
}

describe('package smoke-test utility', () => {
  it('accepts either a fresh pack or one explicit retained tarball', () => {
    expect(parseArgs([])).to.deep.equal({tarball: null});
    expect(parseArgs(['--tarball', './candidate.tgz']).tarball)
      .to.match(/candidate\.tgz$/);
    expect(() => parseArgs(['candidate.tgz'])).to.throw('Usage:');
    expect(() => parseArgs(['--tarball'])).to.throw('Usage:');
  });

  it('validates the public allowlist for an inspected retained tarball', () => {
    expect(validatePackageListing({files: requiredFiles()})).to.have.length(15);
    expect(() => validatePackageListing({
      files: requiredFiles().concat([{path: 'test/fixture-secret.pem'}])
    })).to.throw('outside the public allowlist');
  });
});
