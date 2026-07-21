'use strict';

const expect = require('chai').expect;

const {
  analyzeSamples,
  linearSlope,
  parseConfig
} = require('../../scripts/soak-bacnet-sc');

function sample(elapsedMs, options) {
  options = options || {};
  return {
    elapsedMs: elapsedMs,
    memory: {
      heapUsed: options.heapUsed == null ? 10 * 1024 * 1024 : options.heapUsed,
      rss: options.rss == null ? 50 * 1024 * 1024 : options.rss
    },
    cpu: {ratio: options.cpuRatio == null ? 0.1 : options.cpuRatio},
    eventLoopP99Ms: options.eventLoopP99Ms == null ? 10 : options.eventLoopP99Ms,
    activeResources: {Timeout: options.timeouts || 3},
    activeResourceTotal: options.activeResourceTotal || 12,
    totals: {
      pendingSends: options.pendingSends || 0,
      bufferedAmount: options.bufferedAmount || 0,
      transactions: options.transactions || 0,
      transactionPeers: options.transactionPeers || 3,
      serverTransactions: options.serverTransactions || 2,
      serverTransactionBytes: options.serverTransactionBytes || 4096,
      segments: options.segments || 0,
      segmentBytes: options.segmentBytes || 0,
      completedSegments: options.completedSegments || 0,
      listeners: options.listeners == null ? 24 : options.listeners
    }
  };
}

function counters() {
  return {
    normalTransactions: 10,
    faultCampaigns: 1,
    connectionDropRecoveries: 1,
    heartbeatRecoveries: 1,
    gcExposed: true,
    failovers: 1,
    failbacks: 1,
    cancelledRequests: 4,
    cancelledCallbacks: 4,
    maximumCancellationQueue: 4,
    segmentedTransactions: 1,
    malformedFramesContained: 1,
    unexpectedClientErrors: 0,
    unhandledRejections: 0,
    uncaughtExceptions: 0
  };
}

function finalState() {
  return {
    pendingSends: 0,
    transactions: 0,
    serverTransactions: 0,
    segments: 0,
    tcpResources: 0,
    timeoutResources: 0
  };
}

describe('BACnet/SC soak report analysis', () => {
  it('parses reproducible command-line campaign settings', () => {
    const config = parseConfig([
      '--duration-ms', '1234',
      '--sample-ms', '50',
      '--warmup-ms', '10',
      '--operation-interval-ms', '2',
      '--fault-interval-ms', '1000',
      '--output', 'reports/test-output'
    ], {});

    expect(config).to.include({
      durationMs: 1234,
      sampleMs: 50,
      warmupMs: 10,
      operationIntervalMs: 2,
      faultIntervalMs: 1000,
      outputDir: 'reports/test-output'
    });
    expect(config.limits).to.include({
      maxTransactions: 32,
      maxSegmentedTransfers: 8,
      sendQueueLimit: 8
    });
  });

  it('computes a least-squares byte trend per hour', () => {
    const samples = [
      {elapsedMs: 0, value: 100},
      {elapsedMs: 30 * 60 * 1000, value: 150},
      {elapsedMs: 60 * 60 * 1000, value: 200}
    ];
    expect(linearSlope(samples, (entry) => entry.value)).to.equal(100);
  });

  it('passes a bounded campaign and marks short-run trends as not applicable', () => {
    const config = parseConfig([
      '--duration-ms', '1000',
      '--sample-ms', '100',
      '--fault-interval-ms', '1000'
    ], {});
    const result = analyzeSamples(
      [sample(0), sample(500), sample(1000)],
      config,
      counters(),
      finalState()
    );

    expect(result.pass).to.equal(true);
    expect(result.checks.find((entry) => entry.name === 'heap trend')).to.include({
      pass: true,
      applicable: false
    });
  });

  it('does not accept an interrupted run as a complete duration campaign', () => {
    const config = parseConfig([
      '--duration-ms', '1000',
      '--sample-ms', '100',
      '--fault-interval-ms', '1000'
    ], {});
    const result = analyzeSamples(
      [sample(0), sample(200)],
      config,
      counters(),
      finalState()
    );

    expect(result.pass).to.equal(false);
    expect(result.checks.find((entry) => entry.name === 'minimum campaign duration'))
      .to.include({pass: false, actual: 200, limit: 1000});
  });

  it('fails hard bounds and post-shutdown leak checks independently', () => {
    const config = parseConfig([
      '--duration-ms', '1000',
      '--sample-ms', '100',
      '--fault-interval-ms', '1000'
    ], {});
    const badFinalState = finalState();
    badFinalState.transactions = 1;
    badFinalState.tcpResources = 1;
    const result = analyzeSamples(
      [sample(0), sample(100, {pendingSends: 9, listeners: 100})],
      config,
      counters(),
      badFinalState
    );
    const failures = result.checks.filter((entry) => !entry.pass).map((entry) => entry.name);

    expect(result.pass).to.equal(false);
    expect(failures).to.include.members([
      'maximum pending sends',
      'known listener ceiling',
      'known listener growth',
      'clean shutdown transactions',
      'clean shutdown TCP resources'
    ]);
  });
});
