'use strict';

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const manifest = require(path.join(projectRoot, 'package.json'));
const outputRoot = path.join(projectRoot, 'docs', manifest.name, manifest.version);
// Docdash's staticFiles handling treats individual file paths as directories
// and can create root-level paths such as "ARCHITECTUREdocs/". Copy the exact
// release-document set after JSDoc generation so output stays under outputRoot.
const files = [
  'ARCHITECTURE.md',
  'BACNET_SC.md',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'FAQ.md',
  'LICENSE.md',
  'README.md',
  'RELEASE.md',
  'SECURITY.md'
];

if (!fs.existsSync(path.join(outputRoot, 'index.html'))) {
  throw new Error('JSDoc output directory is missing: ' + outputRoot);
}
files.forEach((file) => fs.copyFileSync(
  path.join(projectRoot, file),
  path.join(outputRoot, file)
));
