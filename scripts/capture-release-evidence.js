'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const OUTPUT_DIRECTORY = path.join('reports', 'release-evidence');
const MAX_COMMAND_OUTPUT = 64 * 1024 * 1024;

const QUICK_PLAN = Object.freeze([
  command('install', 'npm', ['ci', '--ignore-scripts']),
  command('lint', 'npm', ['run', 'lint']),
  command('test', 'npm', ['test']),
  command('docs', 'npm', ['run', 'docs']),
  command('docs-check', 'npm', ['run', 'docs:check']),
  command('package-smoke', 'npm', ['run', 'package:smoke'])
]);

const FULL_PLAN = Object.freeze([
  command('install', 'npm', ['ci', '--ignore-scripts']),
  command('lint-commits', 'npm', ['run', 'lint:commits']),
  command('verify', 'npm', ['run', 'verify']),
  command('bacnet-sc', 'npm', ['run', 'test:sc']),
  command('hostile-input', 'node', [
    'node_modules/mocha/bin/mocha.js',
    'test/unit/decoder-fuzz.spec.js',
    'test/unit/service-decoder-safety.spec.js',
    'test/unit/client-malformed-packets.spec.js'
  ]),
  command('audit', 'npm', ['audit', '--audit-level=high', '--json']),
  command('audit-production', 'npm', [
    'audit',
    '--omit=dev',
    '--audit-level=high',
    '--json'
  ]),
  command('dependency-tree', 'npm', ['ls', '--all', '--json']),
  command('bacnet-sc-java', 'npm', ['run', 'test:sc:java'])
]);

class ReleaseEvidenceError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ReleaseEvidenceError';
    if (details && details.code) this.code = details.code;
    if (details && details.evidencePath) this.evidencePath = details.evidencePath;
  }
}

function command(id, executable, args) {
  return Object.freeze({
    id: id,
    command: executable,
    args: Object.freeze(args.slice())
  });
}

function usage() {
  return [
    'Usage:',
    '  node scripts/capture-release-evidence.js --expected-sha <40-hex-sha> [--plan quick|full]',
    '',
    'The output is written below reports/release-evidence/<sha>/.'
  ].join('\n');
}

function parseArgs(argv) {
  const options = {plan: 'quick'};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--help' || value === '-h') {
      options.help = true;
    } else if (value === '--expected-sha') {
      options.expectedSha = argv[++index];
    } else if (value === '--plan') {
      options.plan = argv[++index];
    } else {
      throw new ReleaseEvidenceError('Unknown argument: ' + value, {code: 'ERR_INVALID_ARGUMENT'});
    }
  }
  if (options.help) return options;
  validatePlanName(options.plan);
  validateExpectedSha(options.expectedSha);
  return options;
}

function validatePlanName(name) {
  if (name !== 'quick' && name !== 'full') {
    throw new ReleaseEvidenceError('Plan must be exactly "quick" or "full"', {
      code: 'ERR_INVALID_PLAN'
    });
  }
}

function validateExpectedSha(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new ReleaseEvidenceError('--expected-sha must be a complete 40-hex commit ID', {
      code: 'ERR_INVALID_EXPECTED_SHA'
    });
  }
}

function getPlan(name) {
  validatePlanName(name);
  const selected = name === 'full' ? FULL_PLAN : QUICK_PLAN;
  return selected.map((entry) => ({
    id: entry.id,
    command: entry.command,
    args: entry.args.slice()
  }));
}

function defaultRunner(executable, args, options) {
  const commandName = process.platform === 'win32' && executable === 'npm' ?
    'npm.cmd' : executable;
  const result = childProcess.spawnSync(commandName, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    maxBuffer: MAX_COMMAND_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return {
    status: Number.isInteger(result.status) ? result.status : -1,
    signal: result.signal || null,
    stdout: result.stdout || '',
    stderr: (result.stderr || '') + (result.error ? result.error.message + '\n' : '')
  };
}

function runRaw(state, executable, args, label) {
  let result;
  try {
    result = state.runner(executable, args, {
      cwd: state.root || state.requestedCwd,
      env: process.env
    });
  } catch (error) {
    throw new ReleaseEvidenceError(label + ' could not be started: ' + error.message, {
      code: 'ERR_COMMAND_START'
    });
  }
  if (!result || !Number.isInteger(result.status)) {
    throw new ReleaseEvidenceError(label + ' did not return a process exit status', {
      code: 'ERR_COMMAND_STATUS'
    });
  }
  return {
    status: result.status,
    signal: result.signal || null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || '')
  };
}

function requireSuccess(result, label) {
  if (result.status === 0) return result;
  const detail = (result.stderr || result.stdout).trim();
  throw new ReleaseEvidenceError(
    label + ' failed with exit status ' + result.status + (detail ? ': ' + detail : ''),
    {code: 'ERR_COMMAND_FAILED'}
  );
}

function git(state, args, label) {
  return requireSuccess(runRaw(state, 'git', args, label), label).stdout.trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function digestFile(filePath, algorithm, encoding) {
  return crypto.createHash(algorithm).update(fs.readFileSync(filePath)).digest(encoding);
}

function readJson(filePath, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new ReleaseEvidenceError('Unable to read ' + label + ': ' + error.message, {
      code: 'ERR_INVALID_JSON'
    });
  }
  return value;
}

function parseVersion(value, label) {
  const match = String(value).trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new ReleaseEvidenceError('Unable to parse ' + label + ' version: ' + value, {
      code: 'ERR_INVALID_VERSION'
    });
  }
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function validateRuntime(packageManifest, environment) {
  const packageManager = String(packageManifest.packageManager || '');
  const npmMatch = packageManager.match(/^npm@(\d+\.\d+\.\d+)$/);
  if (!npmMatch) {
    throw new ReleaseEvidenceError('package.json must declare an exact npm packageManager version', {
      code: 'ERR_PACKAGE_MANAGER_REQUIRED'
    });
  }
  if (environment.npm !== npmMatch[1]) {
    throw new ReleaseEvidenceError(
      'npm ' + npmMatch[1] + ' is required; found ' + environment.npm,
      {code: 'ERR_NPM_VERSION'}
    );
  }

  const engine = packageManifest.engines && packageManifest.engines.node;
  const engineMatch = String(engine || '').match(/^>=(\d+\.\d+\.\d+)$/);
  if (!engineMatch) {
    throw new ReleaseEvidenceError('Only an exact minimum Node.js engine can be verified', {
      code: 'ERR_NODE_ENGINE'
    });
  }
  if (compareVersions(parseVersion(environment.node, 'Node.js'), parseVersion(engineMatch[1], 'engine')) < 0) {
    throw new ReleaseEvidenceError(
      'Node.js ' + engineMatch[1] + ' or newer is required; found ' + environment.node,
      {code: 'ERR_NODE_VERSION'}
    );
  }
}

function ensureRegularFile(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new ReleaseEvidenceError(label + ' is missing: ' + error.message, {
      code: 'ERR_REQUIRED_FILE'
    });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ReleaseEvidenceError(label + ' must be a regular file', {
      code: 'ERR_REQUIRED_FILE'
    });
  }
}

function ensureDirectory(directory) {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ReleaseEvidenceError('Evidence path is not a safe directory: ' + directory, {
        code: 'ERR_UNSAFE_OUTPUT'
      });
    }
    return;
  }
  fs.mkdirSync(directory, {mode: 0o700});
}

function timestampForPath(date) {
  return date.toISOString().replace(/[-:.]/g, '');
}

function uniqueDestination(parent, baseName) {
  let candidate = path.join(parent, baseName);
  let suffix = 2;
  while (fs.existsSync(candidate)) candidate = path.join(parent, baseName + '-' + suffix++);
  return candidate;
}

function inspectCandidate(state, options, runtime) {
  const topLevel = git(state, ['rev-parse', '--show-toplevel'], 'Git repository discovery');
  state.root = path.resolve(topLevel);
  const packagePath = path.join(state.root, 'package.json');
  const lockPath = path.join(state.root, 'package-lock.json');
  ensureRegularFile(packagePath, 'package.json');
  ensureRegularFile(lockPath, 'package-lock.json');

  const actualSha = git(state, ['rev-parse', 'HEAD'], 'Candidate commit lookup').toLowerCase();
  if (actualSha !== options.expectedSha.toLowerCase()) {
    throw new ReleaseEvidenceError(
      'Expected candidate ' + options.expectedSha + ' but HEAD is ' + actualSha,
      {code: 'ERR_CANDIDATE_MISMATCH'}
    );
  }
  const status = git(
    state,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    'Initial worktree check'
  );
  if (status) {
    throw new ReleaseEvidenceError('Candidate worktree is not clean:\n' + status, {
      code: 'ERR_DIRTY_WORKTREE'
    });
  }
  const ignored = runRaw(
    state,
    'git',
    ['check-ignore', '-q', path.join(OUTPUT_DIRECTORY, '.probe')],
    'Evidence ignore check'
  );
  if (ignored.status !== 0) {
    throw new ReleaseEvidenceError(OUTPUT_DIRECTORY + ' must be ignored by Git', {
      code: 'ERR_OUTPUT_NOT_IGNORED'
    });
  }

  const packageManifest = readJson(packagePath, 'package.json');
  const npmVersion = requireSuccess(
    runRaw(state, 'npm', ['--version'], 'npm version check'),
    'npm version check'
  ).stdout.trim();
  const environment = {
    arch: runtime.arch,
    git: git(state, ['--version'], 'Git version check'),
    node: runtime.nodeVersion,
    npm: npmVersion,
    platform: runtime.platform
  };
  validateRuntime(packageManifest, environment);
  const branchResult = runRaw(
    state,
    'git',
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    'Git branch lookup'
  );
  if (branchResult.status !== 0 && branchResult.status !== 1) {
    requireSuccess(branchResult, 'Git branch lookup');
  }
  return {
    branch: branchResult.status === 0 ? branchResult.stdout.trim() : null,
    committedAt: git(state, ['show', '-s', '--format=%cI', 'HEAD'], 'Candidate date lookup'),
    environment: environment,
    initialStatus: status,
    lockPath: lockPath,
    lockSha256: sha256File(lockPath),
    packageManifest: packageManifest,
    sha: actualSha,
    subject: git(state, ['show', '-s', '--format=%s', 'HEAD'], 'Candidate subject lookup')
  };
}

function createEvidenceWorkspace(state, candidate, planName) {
  const reportsRoot = path.join(state.root, 'reports');
  const evidenceRoot = path.join(state.root, OUTPUT_DIRECTORY);
  const candidateRoot = path.join(evidenceRoot, candidate.sha);
  ensureDirectory(reportsRoot);
  ensureDirectory(evidenceRoot);
  ensureDirectory(candidateRoot);
  const startedAt = state.now();
  const label = timestampForPath(startedAt) + '-' + planName;
  const staging = path.join(
    candidateRoot,
    '.incomplete-' + label + '-' + crypto.randomBytes(4).toString('hex')
  );
  fs.mkdirSync(staging);
  fs.mkdirSync(path.join(staging, 'logs'));
  fs.mkdirSync(path.join(staging, 'artifacts'));
  return {
    candidateRoot: candidateRoot,
    label: label,
    staging: staging,
    startedAt: startedAt
  };
}

function shellDisplay(executable, args) {
  return [executable].concat(args).map((value) => {
    const text = String(value);
    return /^[A-Za-z0-9_./:=@-]+$/.test(text) ? text : JSON.stringify(text);
  }).join(' ');
}

function commandLog(record, result) {
  return [
    '$ ' + shellDisplay(record.command, record.args),
    'started: ' + record.startedAt,
    'completed: ' + record.completedAt,
    'durationMs: ' + record.durationMs,
    'exitCode: ' + record.exitCode,
    'signal: ' + (record.signal || ''),
    '',
    '--- stdout ---',
    result.stdout,
    '--- stderr ---',
    result.stderr
  ].join('\n');
}

function candidateSnapshot(state, candidate) {
  let lockSha256 = null;
  let head;
  let status;
  try {
    if (fs.existsSync(candidate.lockPath)) lockSha256 = sha256File(candidate.lockPath);
    head = git(state, ['rev-parse', 'HEAD'], 'Candidate integrity check').toLowerCase();
    status = git(
      state,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      'Worktree integrity check'
    );
  } catch (error) {
    return {error: error.message, head: null, lockSha256: lockSha256, status: null};
  }
  return {head: head, lockSha256: lockSha256, status: status};
}

function assertCandidateIntegrity(state, candidate, label) {
  const snapshot = candidateSnapshot(state, candidate);
  if (snapshot.error) {
    throw new ReleaseEvidenceError(label + ': ' + snapshot.error, {
      code: 'ERR_INTEGRITY_CHECK'
    });
  }
  if (snapshot.head !== candidate.sha) {
    throw new ReleaseEvidenceError(label + ': HEAD changed during evidence capture', {
      code: 'ERR_HEAD_CHANGED'
    });
  }
  if (snapshot.lockSha256 !== candidate.lockSha256) {
    throw new ReleaseEvidenceError(label + ': package-lock.json changed during evidence capture', {
      code: 'ERR_LOCKFILE_CHANGED'
    });
  }
  if (snapshot.status) {
    throw new ReleaseEvidenceError(label + ': tracked worktree state changed:\n' + snapshot.status, {
      code: 'ERR_WORKTREE_CHANGED'
    });
  }
  return snapshot;
}

function runRecorded(state, candidate, workspace, spec) {
  const sequence = state.commandRecords.length + 1;
  const started = state.now();
  process.stdout.write('[' + sequence + '] ' + shellDisplay(spec.command, spec.args) + '\n');
  const result = runRaw(state, spec.command, spec.args, spec.id);
  const completed = state.now();
  const logName = String(sequence).padStart(3, '0') + '-' + spec.id + '.log';
  const logPath = path.join(workspace.staging, 'logs', logName);
  const record = {
    args: spec.args.slice(),
    command: spec.command,
    completedAt: completed.toISOString(),
    durationMs: Math.max(0, completed.getTime() - started.getTime()),
    exitCode: result.status,
    id: spec.id,
    log: path.join('logs', logName),
    signal: result.signal,
    startedAt: started.toISOString()
  };
  fs.writeFileSync(logPath, commandLog(record, result));
  record.logSha256 = sha256File(logPath);
  state.commandRecords.push(record);
  if (result.status !== 0) requireSuccess(result, spec.id);
  assertCandidateIntegrity(state, candidate, 'After ' + spec.id);
  return result;
}

function parsePackOutput(stdout, packageManifest, label) {
  let packs;
  try {
    packs = JSON.parse(stdout);
  } catch (error) {
    throw new ReleaseEvidenceError(label + ' did not emit valid JSON: ' + error.message, {
      code: 'ERR_PACK_JSON'
    });
  }
  if (!Array.isArray(packs) || packs.length !== 1 || !Array.isArray(packs[0].files)) {
    throw new ReleaseEvidenceError(label + ' must describe exactly one package with a file list', {
      code: 'ERR_PACK_JSON'
    });
  }
  const pack = packs[0];
  if (pack.name !== packageManifest.name || pack.version !== packageManifest.version) {
    throw new ReleaseEvidenceError(label + ' package identity does not match package.json', {
      code: 'ERR_PACK_IDENTITY'
    });
  }
  const paths = pack.files.map((file) => file.path);
  if (!pack.filename || paths.length === 0 || new Set(paths).size !== paths.length) {
    throw new ReleaseEvidenceError(label + ' contains an invalid filename or file list', {
      code: 'ERR_PACK_FILE_LIST'
    });
  }
  return pack;
}

function samePackageFiles(left, right) {
  const files = (pack) => pack.files.map((file) => ({
    mode: file.mode == null ? null : file.mode,
    path: file.path,
    size: file.size == null ? null : file.size
  })).sort((first, second) => first.path.localeCompare(second.path));
  return JSON.stringify(files(left)) === JSON.stringify(files(right));
}

function verifyNpmDigests(tarballPath, pack) {
  const sha1 = digestFile(tarballPath, 'sha1', 'hex');
  const sha512 = digestFile(tarballPath, 'sha512', 'base64');
  if (!/^[0-9a-f]{40}$/i.test(String(pack.shasum || '')) ||
      pack.shasum.toLowerCase() !== sha1) {
    throw new ReleaseEvidenceError('npm pack SHA-1 metadata does not match the tarball', {
      code: 'ERR_PACK_DIGEST'
    });
  }
  if (pack.integrity !== 'sha512-' + sha512) {
    throw new ReleaseEvidenceError('npm pack integrity metadata does not match the tarball', {
      code: 'ERR_PACK_DIGEST'
    });
  }
}

function writeJson(filePath, value) {
  const temporary = filePath + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, filePath);
}

function capturePackageArtifacts(state, candidate, workspace) {
  const artifactDirectory = path.join(workspace.staging, 'artifacts');
  const dryResult = runRecorded(state, candidate, workspace, {
    id: 'package-dry-run',
    command: 'npm',
    args: ['pack', '--dry-run', '--json']
  });
  const dryPack = parsePackOutput(dryResult.stdout, candidate.packageManifest, 'npm pack dry run');
  const dryPath = path.join(artifactDirectory, 'npm-pack-dry-run.json');
  writeJson(dryPath, [dryPack]);

  const actualResult = runRecorded(state, candidate, workspace, {
    id: 'package-build',
    command: 'npm',
    args: ['pack', '--json', '--pack-destination', artifactDirectory]
  });
  const actualPack = parsePackOutput(actualResult.stdout, candidate.packageManifest, 'npm pack');
  if (!samePackageFiles(dryPack, actualPack)) {
    throw new ReleaseEvidenceError('Dry-run and actual package file lists differ', {
      code: 'ERR_PACK_FILE_MISMATCH'
    });
  }
  if (path.basename(actualPack.filename) !== actualPack.filename) {
    throw new ReleaseEvidenceError('npm pack returned an unsafe tarball filename', {
      code: 'ERR_PACK_FILENAME'
    });
  }
  const tarballPath = path.join(artifactDirectory, actualPack.filename);
  ensureRegularFile(tarballPath, 'Package tarball');
  verifyNpmDigests(tarballPath, actualPack);
  const tarballSha256 = sha256File(tarballPath);
  const metadataPath = path.join(artifactDirectory, 'npm-pack-actual.json');
  const checksumPath = tarballPath + '.sha256';
  writeJson(metadataPath, [actualPack]);
  fs.writeFileSync(checksumPath, tarballSha256 + '  ' + actualPack.filename + '\n');
  runRecorded(state, candidate, workspace, {
    id: 'package-retained-smoke',
    command: 'node',
    args: ['scripts/package-smoke-test.js', '--tarball', tarballPath]
  });
  return {
    dryRun: {
      file: path.join('artifacts', path.basename(dryPath)),
      sha256: sha256File(dryPath)
    },
    packageMetadata: {
      file: path.join('artifacts', path.basename(metadataPath)),
      sha256: sha256File(metadataPath)
    },
    tarball: {
      bytes: fs.statSync(tarballPath).size,
      file: path.join('artifacts', actualPack.filename),
      integrity: actualPack.integrity || null,
      npmShasum: actualPack.shasum || null,
      sha256: tarballSha256,
      sha256File: path.join('artifacts', path.basename(checksumPath))
    }
  };
}

function baseManifest(candidate, options, workspace) {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'running',
    startedAt: workspace.startedAt.toISOString(),
    candidate: {
      branch: candidate.branch,
      committedAt: candidate.committedAt,
      package: candidate.packageManifest.name + '@' + candidate.packageManifest.version,
      sha: candidate.sha,
      subject: candidate.subject
    },
    environment: candidate.environment,
    plan: {
      commands: getPlan(options.plan),
      name: options.plan
    },
    lockfile: {
      afterSha256: null,
      beforeSha256: candidate.lockSha256,
      path: 'package-lock.json',
      unchanged: false
    },
    initialState: {
      head: candidate.sha,
      lockSha256: candidate.lockSha256,
      status: candidate.initialStatus
    },
    commands: [],
    artifacts: null
  };
}

function finishWorkspace(workspace, manifest, failed) {
  const manifestPath = path.join(workspace.staging, 'manifest.json');
  writeJson(manifestPath, manifest);
  const manifestSha256 = sha256File(manifestPath);
  fs.writeFileSync(
    path.join(workspace.staging, 'manifest.sha256'),
    manifestSha256 + '  manifest.json\n'
  );
  const suffix = failed ? '-FAILED' : '';
  const destination = uniqueDestination(workspace.candidateRoot, workspace.label + suffix);
  fs.renameSync(workspace.staging, destination);
  return {manifestSha256: manifestSha256, path: destination};
}

function failureDetails(error) {
  return {
    code: error.code || 'ERR_RELEASE_EVIDENCE',
    message: error.message,
    name: error.name || 'Error'
  };
}

function finalizeFailure(state, candidate, workspace, manifest, error) {
  const snapshot = candidateSnapshot(state, candidate);
  manifest.status = 'failed';
  manifest.completedAt = state.now().toISOString();
  manifest.commands = state.commandRecords;
  manifest.failure = failureDetails(error);
  manifest.finalState = snapshot;
  manifest.lockfile.afterSha256 = snapshot.lockSha256;
  manifest.lockfile.unchanged = snapshot.lockSha256 === candidate.lockSha256;
  const completed = finishWorkspace(workspace, manifest, true);
  throw new ReleaseEvidenceError(error.message, {
    code: error.code || 'ERR_RELEASE_EVIDENCE',
    evidencePath: completed.path
  });
}

function captureReleaseEvidence(options, dependencies) {
  dependencies = dependencies || {};
  const state = {
    commandRecords: [],
    now: dependencies.now || (() => new Date()),
    requestedCwd: path.resolve(options.cwd || process.cwd()),
    root: null,
    runner: dependencies.runner || defaultRunner
  };
  const runtime = dependencies.runtime || {
    arch: process.arch,
    nodeVersion: process.version,
    platform: process.platform
  };
  validatePlanName(options.plan);
  validateExpectedSha(options.expectedSha);
  const candidate = inspectCandidate(state, options, runtime);
  const workspace = createEvidenceWorkspace(state, candidate, options.plan);
  const manifest = baseManifest(candidate, options, workspace);

  try {
    getPlan(options.plan).forEach((spec) => runRecorded(
      state,
      candidate,
      workspace,
      spec
    ));
    manifest.artifacts = capturePackageArtifacts(state, candidate, workspace);
    const finalState = assertCandidateIntegrity(state, candidate, 'Final candidate check');
    manifest.status = 'complete';
    manifest.completedAt = state.now().toISOString();
    manifest.commands = state.commandRecords;
    manifest.finalState = finalState;
    manifest.lockfile.afterSha256 = finalState.lockSha256;
    manifest.lockfile.unchanged = true;
    const completed = finishWorkspace(workspace, manifest, false);
    return {
      manifest: manifest,
      manifestSha256: completed.manifestSha256,
      path: completed.path
    };
  } catch (error) {
    return finalizeFailure(state, candidate, workspace, manifest, error);
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage() + '\n');
      return;
    }
    const result = captureReleaseEvidence(options);
    process.stdout.write(JSON.stringify({
      evidencePath: result.path,
      manifestSha256: result.manifestSha256,
      status: result.manifest.status
    }) + '\n');
  } catch (error) {
    process.stderr.write('Release evidence capture failed: ' + error.message + '\n');
    if (error.evidencePath) process.stderr.write('Failed evidence: ' + error.evidencePath + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  FULL_PLAN: FULL_PLAN,
  QUICK_PLAN: QUICK_PLAN,
  ReleaseEvidenceError: ReleaseEvidenceError,
  captureReleaseEvidence: captureReleaseEvidence,
  getPlan: getPlan,
  parseArgs: parseArgs,
  sha256File: sha256File,
  usage: usage
};

if (require.main === module) main();
