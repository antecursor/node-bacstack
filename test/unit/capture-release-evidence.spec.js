'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const expect = require('chai').expect;

const {
  FULL_PLAN,
  QUICK_PLAN,
  captureReleaseEvidence,
  getPlan,
  parseArgs,
  sha256File
} = require('../../scripts/capture-release-evidence');

const PACKAGE_BYTES = Buffer.from('fixture package bytes\n');

function execute(executable, args, cwd) {
  const result = childProcess.spawnSync(executable, args, {
    cwd: cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      executable + ' failed: ' + (result.stderr || result.stdout || result.status)
    );
  }
  return result.stdout.trim();
}

function initializeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bacstack-release-evidence-test-'));
  const packageManifest = {
    name: 'bacstack-evidence-fixture',
    version: '1.2.3-rc.1',
    private: true,
    engines: {node: '>=22.13.0'},
    packageManager: 'npm@11.18.0'
  };
  const packageLock = {
    name: packageManifest.name,
    version: packageManifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: packageManifest.name,
        version: packageManifest.version,
        engines: packageManifest.engines
      }
    }
  };
  fs.writeFileSync(path.join(root, '.gitignore'), 'reports/\nnode_modules/\n*.tgz\n');
  fs.writeFileSync(path.join(root, 'index.js'), "'use strict';\nmodule.exports = {};\n");
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageManifest, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(packageLock, null, 2) + '\n');
  execute('git', ['init', '--quiet'], root);
  execute('git', ['config', 'user.email', 'release-evidence@example.invalid'], root);
  execute('git', ['config', 'user.name', 'Release Evidence Test'], root);
  execute('git', ['add', '.'], root);
  execute('git', ['commit', '--quiet', '-m', 'test: initialize evidence fixture'], root);
  return {
    packageManifest: packageManifest,
    root: root,
    sha: execute('git', ['rev-parse', 'HEAD'], root)
  };
}

function processResult(status, stdout, stderr) {
  return {
    signal: null,
    status: status,
    stderr: stderr || '',
    stdout: stdout || ''
  };
}

function gitResult(args, cwd) {
  const result = childProcess.spawnSync('git', args, {
    cwd: cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw result.error;
  return processResult(result.status, result.stdout, result.stderr);
}

function packMetadata(fixture, mismatch) {
  const files = [
    {path: 'index.js', size: 35, mode: 420},
    {path: 'package.json', size: 200, mode: 420}
  ];
  if (mismatch) files.push({path: 'unexpected.js', size: 1, mode: 420});
  return {
    id: fixture.packageManifest.name + '@' + fixture.packageManifest.version,
    name: fixture.packageManifest.name,
    version: fixture.packageManifest.version,
    filename: fixture.packageManifest.name + '-' + fixture.packageManifest.version + '.tgz',
    files: files,
    integrity: 'sha512-' + crypto.createHash('sha512').update(PACKAGE_BYTES).digest('base64'),
    shasum: crypto.createHash('sha1').update(PACKAGE_BYTES).digest('hex')
  };
}

function createRunner(fixture, behavior) {
  behavior = behavior || {};
  const calls = [];
  const runner = (executable, args, options) => {
    const display = [executable].concat(args).join(' ');
    calls.push(display);
    if (executable === 'git') return gitResult(args, options.cwd);
    if (executable === 'npm' && args.length === 1 && args[0] === '--version') {
      return processResult(0, behavior.npmVersion || '11.18.0\n');
    }
    if (behavior.failMatch && display.includes(behavior.failMatch)) {
      return processResult(behavior.failStatus || 7, '', 'deliberate fixture failure\n');
    }
    if (behavior.mutateLockMatch && display.includes(behavior.mutateLockMatch)) {
      fs.appendFileSync(path.join(fixture.root, 'package-lock.json'), '\n');
    }
    if (executable === 'npm' && args[0] === 'pack') {
      const dryRun = args.includes('--dry-run');
      const metadata = packMetadata(fixture, !dryRun && behavior.packMismatch);
      if (!dryRun) {
        const destinationIndex = args.indexOf('--pack-destination');
        const destination = args[destinationIndex + 1];
        fs.mkdirSync(destination, {recursive: true});
        fs.writeFileSync(path.join(destination, metadata.filename), PACKAGE_BYTES);
      }
      return processResult(0, JSON.stringify([metadata]));
    }
    return processResult(0, 'fixture success: ' + display + '\n');
  };
  return {calls: calls, runner: runner};
}

function deterministicClock() {
  let current = Date.parse('2026-07-18T20:00:00.000Z');
  return () => {
    const value = new Date(current);
    current += 25;
    return value;
  };
}

function capture(fixture, plan, behavior) {
  const controlled = createRunner(fixture, behavior);
  const result = captureReleaseEvidence({
    cwd: fixture.root,
    expectedSha: fixture.sha,
    plan: plan
  }, {
    now: deterministicClock(),
    runner: controlled.runner,
    runtime: {
      arch: 'x64',
      nodeVersion: 'v22.13.0',
      platform: 'test'
    }
  });
  return {calls: controlled.calls, result: result};
}

function removeRepository(fixture) {
  fs.rmSync(fixture.root, {force: true, recursive: true});
}

describe('release evidence capture utility', () => {
  it('defines distinct practical quick and full command plans', () => {
    expect(getPlan('quick').map((entry) => entry.id)).to.deep.equal([
      'install',
      'lint',
      'test',
      'docs',
      'docs-check',
      'package-smoke'
    ]);
    expect(getPlan('full').map((entry) => entry.id)).to.include.members([
      'install',
      'lint-commits',
      'verify',
      'bacnet-sc',
      'hostile-input',
      'audit',
      'audit-production',
      'dependency-tree',
      'bacnet-sc-java'
    ]);
    expect(getPlan('quick')).to.have.length(QUICK_PLAN.length);
    expect(getPlan('full')).to.have.length(FULL_PLAN.length);
    expect(parseArgs(['--expected-sha', 'a'.repeat(40)])).to.deep.equal({
      expectedSha: 'a'.repeat(40),
      plan: 'quick'
    });
    expect(() => parseArgs(['--expected-sha', 'short'])).to.throw('complete 40-hex');
  });

  it('captures a clean exact candidate with logs, pack JSON, checksums, and a checksummed manifest', () => {
    const fixture = initializeRepository();
    try {
      const captured = capture(fixture, 'quick');
      const result = captured.result;
      const manifestPath = path.join(result.path, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      expect(result.path).to.include(path.join('reports', 'release-evidence', fixture.sha));
      expect(manifest.status).to.equal('complete');
      expect(manifest.candidate.sha).to.equal(fixture.sha);
      expect(manifest.candidate.package).to.equal('bacstack-evidence-fixture@1.2.3-rc.1');
      expect(manifest.environment).to.include({node: 'v22.13.0', npm: '11.18.0'});
      expect(manifest.lockfile.unchanged).to.equal(true);
      expect(manifest.lockfile.afterSha256).to.equal(manifest.lockfile.beforeSha256);
      expect(manifest.commands.map((entry) => entry.id)).to.deep.equal(
        getPlan('quick').map((entry) => entry.id).concat([
          'package-dry-run',
          'package-build',
          'package-retained-smoke'
        ])
      );
      manifest.commands.forEach((entry) => {
        expect(sha256File(path.join(result.path, entry.log))).to.equal(entry.logSha256);
      });

      const dryRunPath = path.join(result.path, manifest.artifacts.dryRun.file);
      const tarballPath = path.join(result.path, manifest.artifacts.tarball.file);
      expect(JSON.parse(fs.readFileSync(dryRunPath, 'utf8'))).to.have.length(1);
      expect(fs.readFileSync(tarballPath, 'utf8')).to.equal('fixture package bytes\n');
      expect(sha256File(tarballPath)).to.equal(manifest.artifacts.tarball.sha256);
      expect(fs.readFileSync(
        path.join(result.path, manifest.artifacts.tarball.sha256File),
        'utf8'
      )).to.include(manifest.artifacts.tarball.sha256);

      const manifestHash = sha256File(manifestPath);
      expect(manifestHash).to.equal(result.manifestSha256);
      expect(fs.readFileSync(path.join(result.path, 'manifest.sha256'), 'utf8'))
        .to.equal(manifestHash + '  manifest.json\n');
      expect(execute('git', ['status', '--porcelain'], fixture.root)).to.equal('');
    } finally {
      removeRepository(fixture);
    }
  });

  it('refuses a dirty worktree or an unexpected candidate before creating evidence', () => {
    const dirty = initializeRepository();
    try {
      fs.appendFileSync(path.join(dirty.root, 'index.js'), '// dirty\n');
      expect(() => capture(dirty, 'quick')).to.throw('not clean');
      expect(fs.existsSync(path.join(dirty.root, 'reports'))).to.equal(false);
    } finally {
      removeRepository(dirty);
    }

    const wrongSha = initializeRepository();
    try {
      const controlled = createRunner(wrongSha);
      expect(() => captureReleaseEvidence({
        cwd: wrongSha.root,
        expectedSha: 'f'.repeat(40),
        plan: 'quick'
      }, {
        now: deterministicClock(),
        runner: controlled.runner,
        runtime: {arch: 'x64', nodeVersion: 'v22.13.0', platform: 'test'}
      })).to.throw('but HEAD is');
      expect(fs.existsSync(path.join(wrongSha.root, 'reports'))).to.equal(false);
    } finally {
      removeRepository(wrongSha);
    }
  });

  it('fails closed and retains an explicitly failed manifest when a command fails', () => {
    const fixture = initializeRepository();
    try {
      let error;
      try {
        capture(fixture, 'quick', {failMatch: 'npm run lint', failStatus: 9});
      } catch (caught) {
        error = caught;
      }
      expect(error).to.be.an('error');
      expect(error.code).to.equal('ERR_COMMAND_FAILED');
      expect(path.basename(error.evidencePath)).to.match(/-FAILED$/);
      const manifest = JSON.parse(fs.readFileSync(
        path.join(error.evidencePath, 'manifest.json'),
        'utf8'
      ));
      expect(manifest.status).to.equal('failed');
      expect(manifest.failure.code).to.equal('ERR_COMMAND_FAILED');
      expect(manifest.commands.map((entry) => entry.id)).to.deep.equal(['install', 'lint']);
      expect(manifest.commands[1].exitCode).to.equal(9);
      expect(manifest.lockfile.unchanged).to.equal(true);
      expect(execute('git', ['status', '--porcelain'], fixture.root)).to.equal('');
    } finally {
      removeRepository(fixture);
    }
  });

  it('detects a package-lock mutation immediately and never marks the run complete', () => {
    const fixture = initializeRepository();
    try {
      let error;
      try {
        capture(fixture, 'quick', {mutateLockMatch: 'npm ci --ignore-scripts'});
      } catch (caught) {
        error = caught;
      }
      expect(error).to.be.an('error');
      expect(error.code).to.equal('ERR_LOCKFILE_CHANGED');
      const manifest = JSON.parse(fs.readFileSync(
        path.join(error.evidencePath, 'manifest.json'),
        'utf8'
      ));
      expect(manifest.status).to.equal('failed');
      expect(manifest.lockfile.unchanged).to.equal(false);
      expect(manifest.failure.code).to.equal('ERR_LOCKFILE_CHANGED');
      expect(manifest.commands.map((entry) => entry.id)).to.deep.equal(['install']);
      expect(execute('git', ['status', '--porcelain'], fixture.root)).to.include('package-lock.json');
    } finally {
      removeRepository(fixture);
    }
  });

  it('rejects a disagreement between dry-run and actual package contents', () => {
    const fixture = initializeRepository();
    try {
      let error;
      try {
        capture(fixture, 'quick', {packMismatch: true});
      } catch (caught) {
        error = caught;
      }
      expect(error).to.be.an('error');
      expect(error.code).to.equal('ERR_PACK_FILE_MISMATCH');
      const manifest = JSON.parse(fs.readFileSync(
        path.join(error.evidencePath, 'manifest.json'),
        'utf8'
      ));
      expect(manifest.status).to.equal('failed');
      expect(manifest.artifacts).to.equal(null);
      expect(manifest.commands.map((entry) => entry.id).slice(-2))
        .to.deep.equal(['package-dry-run', 'package-build']);
    } finally {
      removeRepository(fixture);
    }
  });
});
