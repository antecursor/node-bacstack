'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const expect = require('chai').expect;

const execFile = util.promisify(childProcess.execFile);
const ROOT = path.join(__dirname, '..', '..');

describe('bacstack - BACnet/SC operational soak smoke', function() {
  this.timeout(15000);

  let outputDir;

  afterEach(() => {
    if (outputDir) fs.rmSync(outputDir, {recursive: true, force: true});
  });

  it('runs the real WSS/mTLS fault campaign and writes a passing report', async() => {
    outputDir = path.join(
      ROOT,
      'reports',
      'soak-bacnet-sc',
      'integration-' + process.pid + '-' + Date.now()
    );
    const result = await execFile(process.execPath, [
      '--expose-gc',
      path.join(ROOT, 'scripts', 'soak-bacnet-sc.js'),
      '--duration-ms', '1000',
      '--sample-ms', '100',
      '--warmup-ms', '0',
      '--operation-interval-ms', '20',
      '--fault-interval-ms', '1000',
      '--output', outputDir
    ], {
      cwd: ROOT,
      timeout: 12000,
      maxBuffer: 1024 * 1024
    });
    const invocation = JSON.parse(result.stdout.trim());
    const report = JSON.parse(fs.readFileSync(path.join(outputDir, 'summary.json')));
    const samples = fs.readFileSync(path.join(outputDir, 'samples.jsonl'), 'utf8').trim().split('\n');

    expect(invocation.pass).to.equal(true);
    expect(report).to.include({schemaVersion: 1, kind: 'bacnet-sc-operational-soak', pass: true});
    expect(report.source.commit).to.match(/^[0-9a-f]{40}$/);
    expect(report.source.harnessFingerprintSha256).to.match(/^[0-9a-f]{64}$/);
    expect(report.runtime).to.include({gcExposed: true});
    expect(report.hubs.primary.tlsConnections).to.be.at.least(1);
    expect(report.hubs.failover.tlsConnections).to.be.at.least(1);
    expect(report.counters).to.include({
      faultCampaigns: 1,
      connectionDropRecoveries: 1,
      heartbeatRecoveries: 1,
      failovers: 1,
      failbacks: 1,
      segmentedTransactions: 1,
      malformedFramesContained: 1,
      cancelledRequests: 4,
      cancelledCallbacks: 4
    });
    expect(report.finalState).to.include({
      pendingSends: 0,
      transactions: 0,
      serverTransactions: 0,
      segments: 0,
      tcpResources: 0,
      timeoutResources: 0
    });
    expect(report.analysis.checks.every((entry) => entry.pass)).to.equal(true);
    expect(samples.length).to.be.at.least(2);
  });
});
