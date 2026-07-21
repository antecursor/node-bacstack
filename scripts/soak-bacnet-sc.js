'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const perfHooks = require('perf_hooks');

const baApdu = require('../lib/apdu');
const baEnum = require('../lib/enum');
const baNpdu = require('../lib/npdu');
const baServices = require('../lib/services');
const sc = require('../lib/bacnet-sc/message');
const {
  MockScHub,
  createClient
} = require('../test/support/mock-sc-hub');

const ROOT = path.join(__dirname, '..');
const REQUESTER_VMAC = '020000000001';
const PRIMARY_DEVICE_VMAC = '020000000002';
const FAILOVER_DEVICE_VMAC = '020000000003';
const SEGMENTED_DEVICE_VMAC = '0200000000fe';
const TEST_OBJECT = {type: baEnum.ObjectType.ANALOG_VALUE, instance: 1};
const PRESENT_VALUE = baEnum.PropertyIdentifier.PRESENT_VALUE;
const MIB = 1024 * 1024;

function integer(value, fallback, name, minimum) {
  value = value == null || value === '' ? fallback : Number(value);
  minimum = minimum == null ? 0 : minimum;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(name + ' must be an integer greater than or equal to ' + minimum);
  }
  return value;
}

function parseArguments(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--help') {
      result.help = true;
      continue;
    }
    if (!argument.startsWith('--') || i + 1 >= argv.length) {
      throw new TypeError('Expected --name value, received ' + argument);
    }
    const name = argument.slice(2).replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
    result[name] = argv[++i];
  }
  return result;
}

function parseConfig(argv, env) {
  const args = parseArguments(argv || []);
  env = env || process.env;
  const config = {
    durationMs: integer(args.durationMs || env.BACSTACK_SC_SOAK_DURATION_MS, 24 * 60 * 60 * 1000, 'durationMs', 1),
    sampleMs: integer(args.sampleMs || env.BACSTACK_SC_SOAK_SAMPLE_MS, 10000, 'sampleMs', 25),
    warmupMs: integer(args.warmupMs || env.BACSTACK_SC_SOAK_WARMUP_MS, 10 * 60 * 1000, 'warmupMs', 0),
    operationIntervalMs: integer(
      args.operationIntervalMs || env.BACSTACK_SC_SOAK_OPERATION_INTERVAL_MS,
      100,
      'operationIntervalMs',
      0
    ),
    faultIntervalMs: integer(
      args.faultIntervalMs || env.BACSTACK_SC_SOAK_FAULT_INTERVAL_MS,
      15 * 60 * 1000,
      'faultIntervalMs',
      1000
    ),
    outputDir: args.output || env.BACSTACK_SC_SOAK_OUTPUT_DIR || null,
    forceGc: env.BACSTACK_SC_SOAK_FORCE_GC !== '0',
    limits: {
      maxTransactions: integer(env.BACSTACK_SC_SOAK_MAX_TRANSACTIONS, 32, 'maxTransactions', 1),
      maxTransactionPeers: integer(env.BACSTACK_SC_SOAK_MAX_TRANSACTION_PEERS, 8, 'maxTransactionPeers', 1),
      maxServerTransactions: integer(env.BACSTACK_SC_SOAK_MAX_SERVER_TRANSACTIONS, 32, 'maxServerTransactions', 1),
      maxServerTransactionBytes: integer(
        env.BACSTACK_SC_SOAK_MAX_SERVER_TRANSACTION_BYTES,
        128 * 1024,
        'maxServerTransactionBytes',
        1600
      ),
      maxSegmentedTransfers: integer(env.BACSTACK_SC_SOAK_MAX_SEGMENTED_TRANSFERS, 8, 'maxSegmentedTransfers', 1),
      maxSegmentedTotalBytes: integer(
        env.BACSTACK_SC_SOAK_MAX_SEGMENTED_TOTAL_BYTES,
        128 * 1024,
        'maxSegmentedTotalBytes',
        1
      ),
      sendQueueLimit: integer(env.BACSTACK_SC_SOAK_SEND_QUEUE_LIMIT, 8, 'sendQueueLimit', 1),
      maxBufferedAmount: integer(env.BACSTACK_SC_SOAK_MAX_BUFFERED_AMOUNT, 64 * 1024, 'maxBufferedAmount', 1600),
      maxKnownListeners: integer(env.BACSTACK_SC_SOAK_MAX_KNOWN_LISTENERS, 96, 'maxKnownListeners', 1),
      maxActiveResources: integer(env.BACSTACK_SC_SOAK_MAX_ACTIVE_RESOURCES, 160, 'maxActiveResources', 1),
      maxActiveTimeouts: integer(env.BACSTACK_SC_SOAK_MAX_ACTIVE_TIMEOUTS, 128, 'maxActiveTimeouts', 1),
      maxHeapBytes: integer(env.BACSTACK_SC_SOAK_MAX_HEAP_BYTES, 256 * MIB, 'maxHeapBytes', MIB),
      maxRssBytes: integer(env.BACSTACK_SC_SOAK_MAX_RSS_BYTES, 512 * MIB, 'maxRssBytes', MIB),
      maxHeapSlopeBytesPerHour: integer(
        env.BACSTACK_SC_SOAK_MAX_HEAP_SLOPE_BYTES_PER_HOUR,
        8 * MIB,
        'maxHeapSlopeBytesPerHour',
        0
      ),
      maxRssGrowthBytes: integer(env.BACSTACK_SC_SOAK_MAX_RSS_GROWTH_BYTES, 64 * MIB, 'maxRssGrowthBytes', 0),
      minTrendDurationMs: integer(
        env.BACSTACK_SC_SOAK_MIN_TREND_DURATION_MS,
        10 * 60 * 1000,
        'minTrendDurationMs',
        0
      ),
      maxCpuRatio: Number(env.BACSTACK_SC_SOAK_MAX_CPU_RATIO || 0.85),
      maxEventLoopP99Ms: integer(
        env.BACSTACK_SC_SOAK_MAX_EVENT_LOOP_P99_MS,
        100,
        'maxEventLoopP99Ms',
        1
      )
    }
  };
  if (!Number.isFinite(config.limits.maxCpuRatio) || config.limits.maxCpuRatio <= 0) {
    throw new TypeError('maxCpuRatio must be a positive number');
  }
  if (args.help) config.help = true;
  return config;
}

function usage() {
  return [
    'Usage: node --expose-gc scripts/soak-bacnet-sc.js [options]',
    '  --duration-ms N           minimum campaign duration (default: 86400000)',
    '  --sample-ms N             resource sample interval (default: 10000)',
    '  --warmup-ms N             samples excluded from trend analysis (default: 600000)',
    '  --operation-interval-ms N delay between normal transactions (default: 100)',
    '  --fault-interval-ms N     delay between repeated fault campaigns (default: 900000)',
    '  --output PATH             report directory (default: reports/soak-bacnet-sc/<run>)'
  ].join('\n');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCondition(description, predicate, timeout) {
  const deadline = Date.now() + (timeout || 5000);
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch (err) {
      lastError = err;
    }
    await delay(5);
  }
  const error = new Error('Timed out waiting for ' + description);
  if (lastError) error.cause = lastError;
  throw error;
}

function readProperty(client, address, options) {
  return new Promise((resolve, reject) => {
    client.readProperty(address, TEST_OBJECT, PRESENT_VALUE, options || {}, (err, value, linkContext) => {
      if (err) return reject(err);
      resolve({value: value, linkContext: linkContext});
    });
  });
}

function installResponder(client, value) {
  client.on('readProperty', (event) => {
    event.reply.readProperty(event.request.objectId, event.request.property, [
      {type: baEnum.ApplicationTags.REAL, value: value}
    ]);
  });
}

function encodeService(encoder) {
  const writer = {buffer: Buffer.alloc(1497), offset: 0};
  encoder(writer);
  return Buffer.from(writer.buffer.subarray(0, writer.offset));
}

function decodeConfirmedRequest(payload) {
  const npdu = baNpdu.decode(payload, 0, payload.length);
  if (!npdu) return null;
  const request = baApdu.decodeConfirmedServiceRequest(
    payload,
    npdu.len,
    payload.length - npdu.len
  );
  if (!request) return null;
  return {npdu: npdu, request: request};
}

function segmentedNpdu(request, sequenceNumber, moreFollows, payload) {
  const writer = {buffer: Buffer.alloc(1497), offset: 0};
  baNpdu.encode(writer, baEnum.NpduControlPriority.NORMAL_MESSAGE);
  baApdu.encodeComplexAck(
    writer,
    baEnum.PduTypes.COMPLEX_ACK |
      baEnum.PduConReqBits.SEGMENTED_MESSAGE |
      (moreFollows ? baEnum.PduConReqBits.MORE_FOLLOWS : 0),
    request.service,
    request.invokeId,
    sequenceNumber,
    2
  );
  payload.copy(writer.buffer, writer.offset);
  writer.offset += payload.length;
  return Buffer.from(writer.buffer.subarray(0, writer.offset));
}

function installSegmentedResponder(hub, counters) {
  let responseId = 0x7000;
  hub.routeHandler = (source, message) => {
    if (message.destination !== SEGMENTED_DEVICE_VMAC) return false;
    const decoded = decodeConfirmedRequest(message.payload);
    if (!decoded || decoded.request.service !== baEnum.ConfirmedServiceChoice.READ_PROPERTY) {
      return true;
    }
    const servicePayload = encodeService((writer) => baServices.readProperty.encodeAcknowledge(
      writer,
      TEST_OBJECT,
      PRESENT_VALUE,
      baEnum.ASN1_ARRAY_ALL,
      [{type: baEnum.ApplicationTags.REAL, value: 73.25}]
    ));
    const split = Math.ceil(servicePayload.length / 2);
    const fragments = [servicePayload.subarray(0, split), servicePayload.subarray(split)];
    source.sendMessage({
      function: sc.FUNCTIONS.ENCAPSULATED_NPDU,
      id: responseId++ & 0xFFFF,
      originating: SEGMENTED_DEVICE_VMAC,
      payload: segmentedNpdu(decoded.request, 0, true, fragments[0])
    });
    setImmediate(() => {
      if (source.socket.destroyed) return;
      source.sendMessage({
        function: sc.FUNCTIONS.ENCAPSULATED_NPDU,
        id: responseId++ & 0xFFFF,
        originating: SEGMENTED_DEVICE_VMAC,
        payload: segmentedNpdu(decoded.request, 1, false, fragments[1])
      });
    });
    counters.segmentedResponsesSent++;
    return true;
  };
}

function assertPresentValue(result, expected) {
  const value = result && result.value;
  const actual = value && value.values && value.values[0] && value.values[0].value;
  if (actual !== expected) {
    throw new Error('ReadProperty value mismatch: expected ' + expected + ', received ' + actual);
  }
}

function emitterListenerCount(emitter) {
  if (!emitter || typeof emitter.eventNames !== 'function') return 0;
  return emitter.eventNames().reduce((total, name) => total + emitter.listenerCount(name), 0);
}

function resourceCounts() {
  const result = {};
  if (typeof process.getActiveResourcesInfo !== 'function') return result;
  process.getActiveResourcesInfo().forEach((name) => {
    result[name] = (result[name] || 0) + 1;
  });
  return result;
}

function clientState(client, name) {
  const status = client.getTransportStatus();
  return {
    name: name,
    connected: Boolean(status.connected),
    hubIndex: status.hubIndex == null ? null : status.hubIndex,
    state: status.state,
    pendingSends: status.pendingSends || 0,
    bufferedAmount: status.bufferedAmount || 0,
    transactions: client._transactions ? client._transactions.size : 0,
    transactionPeers: client._transactions && client._transactions._peerStates ?
      client._transactions._peerStates.size : 0,
    serverTransactions: client._serverTransactions ? client._serverTransactions.size : 0,
    serverTransactionBytes: client._serverTransactions ? client._serverTransactions.totalBytes : 0,
    segments: client._segments ? client._segments.size : 0,
    segmentBytes: client._segments ? client._segments.totalBytes : 0,
    completedSegments: client._segments ? client._segments.completedSize : 0,
    listeners: emitterListenerCount(client) + emitterListenerCount(client._transport)
  };
}

function updateHighWater(context) {
  const totals = context.clients.map((entry) => clientState(entry.client, entry.name))
    .reduce((result, state) => {
      Object.keys(result).forEach((name) => {
        result[name] += state[name];
      });
      return result;
    }, {
      pendingSends: 0,
      bufferedAmount: 0,
      transactions: 0,
      transactionPeers: 0,
      serverTransactions: 0,
      serverTransactionBytes: 0,
      segments: 0,
      segmentBytes: 0,
      completedSegments: 0,
      listeners: 0
    });
  Object.keys(context.highWater).forEach((name) => {
    context.highWater[name] = Math.max(context.highWater[name], totals[name]);
  });
}

function instrumentClientState(context, client) {
  const methods = [
    [client._transactions, 'begin'],
    [client._transactions, 'settle'],
    [client._serverTransactions, 'accept'],
    [client._serverTransactions, 'bindResponse'],
    [client._segments, 'accept'],
    [client._transport, '_queueSend'],
    [client._transport, '_writeMessage']
  ];
  methods.forEach(([target, name]) => {
    if (!target || typeof target[name] !== 'function') return;
    const original = target[name];
    target[name] = function(...args) {
      const result = original.apply(this, args);
      updateHighWater(context);
      return result;
    };
  });
}

function sampleResources(context) {
  if (context.config.forceGc && typeof global.gc === 'function') global.gc();
  const elapsedMs = perfHooks.performance.now() - context.startedMonotonic;
  const cpu = process.cpuUsage(context.startedCpu);
  const clients = context.clients.map((entry) => clientState(entry.client, entry.name));
  const activeResources = resourceCounts();
  const eventLoopP99Ms = context.eventLoop.percentile(99) / 1e6;
  context.eventLoop.reset();
  return {
    timestamp: new Date().toISOString(),
    elapsedMs: elapsedMs,
    memory: process.memoryUsage(),
    cpu: {
      userMicros: cpu.user,
      systemMicros: cpu.system,
      ratio: elapsedMs > 0 ? (cpu.user + cpu.system) / (elapsedMs * 1000) : 0
    },
    eventLoopP99Ms: Number.isFinite(eventLoopP99Ms) ? eventLoopP99Ms : 0,
    activeResources: activeResources,
    activeResourceTotal: Object.values(activeResources).reduce((sum, count) => sum + count, 0),
    clients: clients,
    totals: clients.reduce((totals, client) => {
      totals.pendingSends += client.pendingSends;
      totals.bufferedAmount += client.bufferedAmount;
      totals.transactions += client.transactions;
      totals.transactionPeers += client.transactionPeers;
      totals.serverTransactions += client.serverTransactions;
      totals.serverTransactionBytes += client.serverTransactionBytes;
      totals.segments += client.segments;
      totals.segmentBytes += client.segmentBytes;
      totals.completedSegments += client.completedSegments;
      totals.listeners += client.listeners;
      return totals;
    }, {
      pendingSends: 0,
      bufferedAmount: 0,
      transactions: 0,
      transactionPeers: 0,
      serverTransactions: 0,
      serverTransactionBytes: 0,
      segments: 0,
      segmentBytes: 0,
      completedSegments: 0,
      listeners: 0
    })
  };
}

function appendSample(context) {
  const sample = sampleResources(context);
  context.samples.push(sample);
  fs.appendFileSync(context.samplesPath, JSON.stringify(sample) + '\n');
  return sample;
}

function maximum(samples, selector) {
  return samples.reduce((value, sample) => Math.max(value, selector(sample) || 0), 0);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function linearSlope(samples, selector) {
  if (samples.length < 2) return 0;
  const origin = samples[0].elapsedMs;
  const points = samples.map((sample) => ({
    x: (sample.elapsedMs - origin) / (60 * 60 * 1000),
    y: selector(sample)
  }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const numerator = points.reduce((sum, point) =>
    sum + (point.x - meanX) * (point.y - meanY), 0);
  const denominator = points.reduce((sum, point) => sum + Math.pow(point.x - meanX, 2), 0);
  return denominator === 0 ? 0 : numerator / denominator;
}

function check(name, actual, limit, pass, applicable, details) {
  return {
    name: name,
    pass: applicable === false ? true : Boolean(pass),
    applicable: applicable !== false,
    actual: actual,
    limit: limit,
    details: details || null
  };
}

function analyzeSamples(samples, config, counters, finalState, highWater) {
  const limits = config.limits;
  highWater = highWater || {};
  const observed = (name, selector) => Math.max(highWater[name] || 0, maximum(samples, selector));
  const eligible = samples.filter((sample) => sample.elapsedMs >= config.warmupMs);
  const trendSamples = eligible.length >= 2 ? eligible : samples;
  const trendDurationMs = trendSamples.length >= 2 ?
    trendSamples[trendSamples.length - 1].elapsedMs - trendSamples[0].elapsedMs : 0;
  const trendApplicable = trendDurationMs >= limits.minTrendDurationMs;
  const heapSlope = linearSlope(trendSamples, (sample) => sample.memory.heapUsed);
  const firstRss = median(trendSamples.slice(0, 3).map((sample) => sample.memory.rss));
  const lastRss = median(trendSamples.slice(-3).map((sample) => sample.memory.rss));
  const rssGrowth = lastRss - firstRss;
  const listenerGrowth = samples[samples.length - 1].totals.listeners - samples[0].totals.listeners;
  const requiredFaultCampaigns = Math.max(1, Math.floor(config.durationMs / config.faultIntervalMs) - 1);
  const maxSampleGap = samples.slice(1).reduce((maximumGap, sample, index) =>
    Math.max(maximumGap, sample.elapsedMs - samples[index].elapsedMs), 0);
  const observedDurationMs = samples[samples.length - 1].elapsedMs;
  const checks = [
    check('minimum campaign duration', observedDurationMs, config.durationMs,
      observedDurationMs >= config.durationMs),
    check('normal transactions completed', counters.normalTransactions, 1, counters.normalTransactions >= 1),
    check('fault campaign cadence', counters.faultCampaigns, requiredFaultCampaigns,
      counters.faultCampaigns >= requiredFaultCampaigns),
    check('connection drops recovered', counters.connectionDropRecoveries, requiredFaultCampaigns,
      counters.connectionDropRecoveries >= requiredFaultCampaigns),
    check('heartbeat nonresponse recovered', counters.heartbeatRecoveries, requiredFaultCampaigns,
      counters.heartbeatRecoveries >= requiredFaultCampaigns),
    check('primary failover completed', counters.failovers, requiredFaultCampaigns,
      counters.failovers >= requiredFaultCampaigns),
    check('primary failback completed', counters.failbacks, requiredFaultCampaigns,
      counters.failbacks >= requiredFaultCampaigns),
    check('queued cancellations completed exactly once', counters.cancelledCallbacks, counters.cancelledRequests,
      counters.cancelledRequests >= 1 && counters.cancelledCallbacks === counters.cancelledRequests),
    check('segmented response reassembled', counters.segmentedTransactions, 1, counters.segmentedTransactions >= 1),
    check('malformed frame contained', counters.malformedFramesContained, 1, counters.malformedFramesContained >= 1),
    check('unexpected client errors', counters.unexpectedClientErrors, 0, counters.unexpectedClientErrors === 0),
    check('unhandled rejections', counters.unhandledRejections, 0, counters.unhandledRejections === 0),
    check('uncaught exceptions', counters.uncaughtExceptions, 0, counters.uncaughtExceptions === 0),
    check('forced GC available', counters.gcExposed, true, counters.gcExposed === true,
      config.forceGc, config.forceGc ? null : 'forced GC disabled by configuration'),
    check('maximum pending sends', observed('pendingSends', (sample) => sample.totals.pendingSends),
      limits.sendQueueLimit, observed('pendingSends', (sample) => sample.totals.pendingSends) <= limits.sendQueueLimit),
    check('queued pending-send high-water mark', counters.maximumCancellationQueue, limits.sendQueueLimit,
      counters.maximumCancellationQueue >= 1 && counters.maximumCancellationQueue <= limits.sendQueueLimit),
    check('maximum outbound transactions', observed('transactions', (sample) => sample.totals.transactions),
      limits.maxTransactions, observed('transactions', (sample) => sample.totals.transactions) <= limits.maxTransactions),
    check('maximum retained transaction peers', observed('transactionPeers', (sample) => sample.totals.transactionPeers),
      limits.maxTransactionPeers * 3,
      observed('transactionPeers', (sample) => sample.totals.transactionPeers) <= limits.maxTransactionPeers * 3),
    check('maximum inbound server transactions', observed('serverTransactions', (sample) => sample.totals.serverTransactions),
      limits.maxServerTransactions * 3,
      observed('serverTransactions', (sample) => sample.totals.serverTransactions) <= limits.maxServerTransactions * 3),
    check('maximum inbound server transaction bytes',
      observed('serverTransactionBytes', (sample) => sample.totals.serverTransactionBytes),
      limits.maxServerTransactionBytes * 3,
      observed('serverTransactionBytes', (sample) => sample.totals.serverTransactionBytes) <=
        limits.maxServerTransactionBytes * 3),
    check('maximum active segment transfers', observed('segments', (sample) => sample.totals.segments),
      limits.maxSegmentedTransfers * 3,
      observed('segments', (sample) => sample.totals.segments) <= limits.maxSegmentedTransfers * 3),
    check('maximum active segment bytes', observed('segmentBytes', (sample) => sample.totals.segmentBytes),
      limits.maxSegmentedTotalBytes * 3,
      observed('segmentBytes', (sample) => sample.totals.segmentBytes) <= limits.maxSegmentedTotalBytes * 3),
    check('maximum buffered WebSocket bytes', observed('bufferedAmount', (sample) => sample.totals.bufferedAmount),
      limits.maxBufferedAmount * 3,
      observed('bufferedAmount', (sample) => sample.totals.bufferedAmount) <= limits.maxBufferedAmount * 3),
    check('known listener ceiling', observed('listeners', (sample) => sample.totals.listeners),
      limits.maxKnownListeners,
      observed('listeners', (sample) => sample.totals.listeners) <= limits.maxKnownListeners),
    check('known listener growth', listenerGrowth, 0, listenerGrowth <= 0),
    check('active resource ceiling', maximum(samples, (sample) => sample.activeResourceTotal),
      limits.maxActiveResources,
      maximum(samples, (sample) => sample.activeResourceTotal) <= limits.maxActiveResources),
    check('active timeout ceiling', maximum(samples, (sample) => sample.activeResources.Timeout || 0),
      limits.maxActiveTimeouts,
      maximum(samples, (sample) => sample.activeResources.Timeout || 0) <= limits.maxActiveTimeouts),
    check('heap hard ceiling', maximum(samples, (sample) => sample.memory.heapUsed),
      limits.maxHeapBytes, maximum(samples, (sample) => sample.memory.heapUsed) <= limits.maxHeapBytes),
    check('RSS hard ceiling', maximum(samples, (sample) => sample.memory.rss),
      limits.maxRssBytes, maximum(samples, (sample) => sample.memory.rss) <= limits.maxRssBytes),
    check('heap trend', heapSlope, limits.maxHeapSlopeBytesPerHour,
      heapSlope <= limits.maxHeapSlopeBytesPerHour, trendApplicable,
      trendApplicable ? null : 'not enforced until the configured minimum trend duration'),
    check('RSS median growth', rssGrowth, limits.maxRssGrowthBytes,
      rssGrowth <= limits.maxRssGrowthBytes, trendApplicable,
      trendApplicable ? null : 'not enforced until the configured minimum trend duration'),
    check('CPU ratio', samples[samples.length - 1].cpu.ratio, limits.maxCpuRatio,
      samples[samples.length - 1].cpu.ratio <= limits.maxCpuRatio),
    check('event-loop delay p99', maximum(samples, (sample) => sample.eventLoopP99Ms),
      limits.maxEventLoopP99Ms,
      maximum(samples, (sample) => sample.eventLoopP99Ms) <= limits.maxEventLoopP99Ms),
    check('resource sample gap', maxSampleGap, config.sampleMs * 3 + 1000,
      maxSampleGap <= config.sampleMs * 3 + 1000),
    check('clean shutdown pending sends', finalState.pendingSends, 0, finalState.pendingSends === 0),
    check('clean shutdown transactions', finalState.transactions, 0, finalState.transactions === 0),
    check('clean shutdown server transactions', finalState.serverTransactions, 0,
      finalState.serverTransactions === 0),
    check('clean shutdown segment transfers', finalState.segments, 0, finalState.segments === 0),
    check('clean shutdown TCP resources', finalState.tcpResources, 0, finalState.tcpResources === 0),
    check('clean shutdown timeout resources', finalState.timeoutResources, 0,
      finalState.timeoutResources === 0)
  ];
  return {
    pass: checks.every((entry) => entry.pass),
    checks: checks,
    metrics: {
      trendDurationMs: trendDurationMs,
      heapSlopeBytesPerHour: heapSlope,
      rssMedianGrowthBytes: rssGrowth,
      maximumHeapBytes: maximum(samples, (sample) => sample.memory.heapUsed),
      maximumRssBytes: maximum(samples, (sample) => sample.memory.rss),
      maximumEventLoopP99Ms: maximum(samples, (sample) => sample.eventLoopP99Ms),
      maximumSampleGapMs: maxSampleGap
    }
  };
}

function sourceMetadata() {
  function git(args, fallback) {
    try {
      return childProcess.execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'}).trim();
    } catch {
      return fallback;
    }
  }
  const files = [
    path.join(ROOT, 'scripts', 'soak-bacnet-sc.js'),
    path.join(ROOT, 'test', 'support', 'mock-sc-hub.js'),
    path.join(ROOT, 'package-lock.json')
  ];
  const hash = crypto.createHash('sha256');
  files.forEach((file) => {
    hash.update(path.relative(ROOT, file));
    hash.update(fs.readFileSync(file));
  });
  return {
    commit: git(['rev-parse', 'HEAD'], null),
    dirty: git(['status', '--porcelain'], '') !== '',
    harnessFingerprintSha256: hash.digest('hex')
  };
}

function prepareOutputDirectory(directory) {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Soak output path must be a real directory: ' + directory);
    }
    if (fs.readdirSync(directory).length !== 0) {
      throw new Error('Soak output directory must be empty: ' + directory);
    }
    return;
  }
  fs.mkdirSync(directory, {recursive: true});
}

function clientOptions(config) {
  const limits = config.limits;
  return {
    apduTimeout: 1000,
    heartbeatInterval: 100,
    heartbeatTimeout: 150,
    disconnectTimeout: 250,
    reconnectMin: 20,
    reconnectMax: 40,
    connectionWaitTimeout: 500,
    webSocketWaitTimeout: 500,
    sendQueueLimit: limits.sendQueueLimit,
    sendQueueTimeout: 1000,
    maxBufferedAmount: limits.maxBufferedAmount,
    maxTransactions: limits.maxTransactions,
    maxTransactionPeers: limits.maxTransactionPeers,
    maxServerTransactions: limits.maxServerTransactions,
    maxServerTransactionsPerPeer: limits.maxServerTransactions,
    maxServerTransactionBytes: limits.maxServerTransactionBytes,
    serverTransactionTimeout: 100,
    maxSegmentedTransfers: limits.maxSegmentedTransfers,
    maxSegmentedTransfersPerPeer: 4,
    maxSegmentedRequestTransfers: 4,
    maxSegmentsPerTransfer: 8,
    maxSegmentedBytesPerTransfer: 32 * 1024,
    maxSegmentedTotalBytes: limits.maxSegmentedTotalBytes,
    maxSegmentedRequestBytes: 64 * 1024,
    segmentIdleTimeout: 1000,
    segmentAbsoluteTimeout: 5000
  };
}

async function verifyNormalTransaction(context, address, expected) {
  const result = await readProperty(context.requester, address);
  assertPresentValue(result, expected);
  context.counters.normalTransactions++;
}

async function runQueuedCancellation(context) {
  const controllers = Array.from({length: 4}, () => new AbortController());
  const callbackCounts = new Array(controllers.length).fill(0);
  const completions = controllers.map((controller, index) => new Promise((resolve) => {
    context.requester.readProperty(
      PRIMARY_DEVICE_VMAC,
      TEST_OBJECT,
      PRESENT_VALUE,
      {signal: controller.signal},
      (err) => {
        callbackCounts[index]++;
        resolve(err);
      }
    );
  }));
  await waitForCondition('queued sends', () =>
    context.requester.getTransportStatus().pendingSends === controllers.length, 1000);
  context.counters.maximumCancellationQueue = Math.max(
    context.counters.maximumCancellationQueue,
    context.requester.getTransportStatus().pendingSends
  );
  controllers.forEach((controller) => controller.abort());
  const errors = await Promise.all(completions);
  await waitForCondition('cancelled queue cleanup', () =>
    context.requester.getTransportStatus().pendingSends === 0 &&
    context.requester._transactions.size === 0, 1000);
  if (callbackCounts.some((count) => count !== 1) || errors.some((err) => !err)) {
    throw new Error('Queued cancellation did not settle each request exactly once');
  }
  context.counters.cancelledRequests += controllers.length;
  context.counters.cancelledCallbacks += callbackCounts.reduce((sum, count) => sum + count, 0);
}

async function runFaultCampaign(context) {
  const primary = context.primary;
  const failover = context.failover;

  await verifyNormalTransaction(context, PRIMARY_DEVICE_VMAC, 12.5);

  const segmented = await readProperty(context.requester, SEGMENTED_DEVICE_VMAC);
  assertPresentValue(segmented, 73.25);
  if (!segmented.linkContext || !segmented.linkContext.segmented ||
      segmented.linkContext.segmentCount !== 2) {
    throw new Error('Expected a two-segment Complex-ACK');
  }
  context.counters.segmentedTransactions++;

  const malformedDiagnostic = new Promise((resolve) => {
    const listener = (event) => {
      if (event && event.code === 'malformed-message') {
        context.requester.removeListener('diagnostic', listener);
        resolve();
      }
    };
    context.requester.on('diagnostic', listener);
  });
  primary.peers[REQUESTER_VMAC].sendRaw(Buffer.from([0x01]));
  await withTimeout(
    malformedDiagnostic,
    1000,
    'Malformed BACnet/SC frame did not produce a containment diagnostic'
  );
  await verifyNormalTransaction(context, PRIMARY_DEVICE_VMAC, 12.5);
  context.counters.malformedFramesContained++;

  const droppedPeer = primary.peers[REQUESTER_VMAC];
  primary.dropPeer(REQUESTER_VMAC);
  await waitForCondition('connection-drop reconnect', () => {
    const status = context.requester.getTransportStatus();
    return status.connected && status.hubIndex === 0 &&
      primary.peers[REQUESTER_VMAC] && primary.peers[REQUESTER_VMAC] !== droppedPeer;
  }, 5000);
  await verifyNormalTransaction(context, PRIMARY_DEVICE_VMAC, 12.5);
  context.counters.connectionDropRecoveries++;

  const heartbeatClose = new Promise((resolve) => context.requester.once('close', resolve));
  primary.setHeartbeatAcknowledgement(REQUESTER_VMAC, false);
  await withTimeout(
    heartbeatClose,
    3000,
    'Heartbeat nonresponse did not close the connection'
  );
  primary.setHeartbeatAcknowledgement(REQUESTER_VMAC, true);
  await waitForCondition('heartbeat reconnect', () => {
    const status = context.requester.getTransportStatus();
    return status.connected && status.hubIndex === 0 && primary.peers[REQUESTER_VMAC];
  }, 5000);
  await verifyNormalTransaction(context, PRIMARY_DEVICE_VMAC, 12.5);
  context.counters.heartbeatRecoveries++;

  primary.subprotocol = null;
  failover.subprotocol = null;
  primary.dropPeer(REQUESTER_VMAC);
  await waitForCondition('requester disconnect before queue test', () =>
    !context.requester.getTransportStatus().connected, 1000);
  await runQueuedCancellation(context);
  failover.subprotocol = 'hub.bsc.bacnet.org';
  await waitForCondition('secondary hub failover', () => {
    const status = context.requester.getTransportStatus();
    return status.connected && status.hubIndex === 1 && failover.peers[REQUESTER_VMAC];
  }, 5000);
  await verifyNormalTransaction(context, FAILOVER_DEVICE_VMAC, 44.5);
  context.counters.failovers++;

  primary.subprotocol = 'hub.bsc.bacnet.org';
  await waitForCondition('primary hub failback', () => {
    const status = context.requester.getTransportStatus();
    return status.connected && status.hubIndex === 0 && primary.peers[REQUESTER_VMAC];
  }, 5000);
  await verifyNormalTransaction(context, PRIMARY_DEVICE_VMAC, 12.5);
  context.counters.failbacks++;
  context.counters.faultCampaigns++;
}

function aggregateClosedState(context) {
  const states = context.clients.map((entry) => clientState(entry.client, entry.name));
  const resources = resourceCounts();
  return {
    pendingSends: states.reduce((sum, state) => sum + state.pendingSends, 0),
    transactions: states.reduce((sum, state) => sum + state.transactions, 0),
    serverTransactions: states.reduce((sum, state) => sum + state.serverTransactions, 0),
    segments: states.reduce((sum, state) => sum + state.segments, 0),
    activeResources: resources,
    tcpResources: Object.keys(resources).reduce((sum, name) =>
      /TCP|TLS/i.test(name) ? sum + resources[name] : sum, 0),
    timeoutResources: resources.Timeout || 0
  };
}

async function cleanShutdown(context) {
  context.clients.forEach((entry) => entry.client.close());
  await waitForCondition('clients to close cleanly', () => context.clients.every((entry) => {
    const status = entry.client.getTransportStatus();
    return status.state === 'idle' && !status.connected;
  }), 3000);
  await Promise.all([context.primary.close(), context.failover.close()]);
  await delay(100);
  if (context.config.forceGc && typeof global.gc === 'function') global.gc();
  return aggregateClosedState(context);
}

async function runSoak(config) {
  const metadata = sourceMetadata();
  const runName = new Date().toISOString().replace(/[:.]/g, '-') + '-' +
    (metadata.commit ? metadata.commit.slice(0, 12) : 'unknown');
  config.outputDir = path.resolve(ROOT, config.outputDir || path.join('reports', 'soak-bacnet-sc', runName));
  prepareOutputDirectory(config.outputDir);
  const samplesPath = path.join(config.outputDir, 'samples.jsonl');
  fs.writeFileSync(samplesPath, '');

  const counters = {
    cancelledCallbacks: 0,
    cancelledRequests: 0,
    connectionDropRecoveries: 0,
    failbacks: 0,
    failovers: 0,
    faultCampaigns: 0,
    gcExposed: typeof global.gc === 'function',
    heartbeatRecoveries: 0,
    malformedFramesContained: 0,
    maximumCancellationQueue: 0,
    normalTransactions: 0,
    segmentedResponsesSent: 0,
    segmentedTransactions: 0,
    uncaughtExceptions: 0,
    unexpectedClientErrors: 0,
    unhandledRejections: 0
  };
  const primary = new MockScHub();
  const failover = new MockScHub({
    vmac: '02000000abce',
    uuid: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
  });
  const context = {
    clients: [],
    config: config,
    counters: counters,
    eventLoop: perfHooks.monitorEventLoopDelay({resolution: 20}),
    failover: failover,
    highWater: {
      pendingSends: 0,
      bufferedAmount: 0,
      transactions: 0,
      transactionPeers: 0,
      serverTransactions: 0,
      serverTransactionBytes: 0,
      segments: 0,
      segmentBytes: 0,
      completedSegments: 0,
      listeners: 0
    },
    primary: primary,
    samples: [],
    samplesPath: samplesPath,
    startedAt: new Date().toISOString(),
    startedCpu: process.cpuUsage(),
    startedMonotonic: perfHooks.performance.now(),
    stoppedBySignal: null
  };
  const stop = {requested: false};
  const unexpected = [];
  const onUnhandledRejection = (reason) => {
    counters.unhandledRejections++;
    unexpected.push({type: 'unhandledRejection', message: String(reason && reason.stack || reason)});
    stop.requested = true;
  };
  const onUncaughtException = (err) => {
    counters.uncaughtExceptions++;
    unexpected.push({type: 'uncaughtException', message: String(err && err.stack || err)});
    stop.requested = true;
  };
  const onSignal = (signal) => {
    context.stoppedBySignal = signal;
    stop.requested = true;
  };
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let samplingTimer;
  let failure;
  let finalState = {
    pendingSends: -1,
    transactions: -1,
    serverTransactions: -1,
    segments: -1,
    tcpResources: -1,
    timeoutResources: -1,
    activeResources: {}
  };
  try {
    await Promise.all([primary.start(), failover.start()]);
    installSegmentedResponder(primary, counters);
    const options = clientOptions(config);
    const requester = createClient(primary, REQUESTER_VMAC, Object.assign({}, options, {
      hubUrl: undefined,
      hubUrls: [primary.url, failover.url]
    }));
    const primaryDevice = createClient(primary, PRIMARY_DEVICE_VMAC, options);
    const failoverDevice = createClient(failover, FAILOVER_DEVICE_VMAC, options);
    context.requester = requester;
    context.clients = [
      {name: 'requester', client: requester},
      {name: 'primary-device', client: primaryDevice},
      {name: 'failover-device', client: failoverDevice}
    ];
    context.clients.forEach((entry) => instrumentClientState(context, entry.client));
    updateHighWater(context);
    context.clients.forEach((entry) => entry.client.on('error', (err) => {
      counters.unexpectedClientErrors++;
      unexpected.push({
        type: 'clientError',
        client: entry.name,
        code: err && err.code,
        message: err && err.message
      });
    }));
    installResponder(primaryDevice, 12.5);
    installResponder(failoverDevice, 44.5);
    await waitForCondition('all BACnet/SC clients to open', () =>
      context.clients.every((entry) => entry.client.getTransportStatus().connected), 5000);

    context.eventLoop.enable();
    appendSample(context);
    samplingTimer = setInterval(() => appendSample(context), config.sampleMs);
    const deadline = context.startedMonotonic + config.durationMs;
    let nextFaultAt = context.startedMonotonic;
    do {
      const now = perfHooks.performance.now();
      if (now >= nextFaultAt) {
        await runFaultCampaign(context);
        nextFaultAt = perfHooks.performance.now() + config.faultIntervalMs;
      } else {
        await verifyNormalTransaction(context, PRIMARY_DEVICE_VMAC, 12.5);
        if (config.operationIntervalMs > 0) await delay(config.operationIntervalMs);
      }
    } while (!stop.requested && perfHooks.performance.now() < deadline);
  } catch (err) {
    failure = err;
  } finally {
    if (samplingTimer) clearInterval(samplingTimer);
    context.eventLoop.disable();
    if (context.clients.length > 0 && context.samples.length > 0) appendSample(context);
    try {
      if (context.clients.length > 0) {
        finalState = await cleanShutdown(context);
      } else {
        await Promise.all([primary.close(), failover.close()]);
        finalState = aggregateClosedState(context);
      }
    } catch (err) {
      failure = failure || err;
      unexpected.push({type: 'shutdownError', message: String(err && err.stack || err)});
    }
    process.removeListener('unhandledRejection', onUnhandledRejection);
    process.removeListener('uncaughtException', onUncaughtException);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  if (failure) unexpected.push({type: 'campaignFailure', message: String(failure.stack || failure)});
  if (context.samples.length === 0) {
    const fallbackSample = {
      elapsedMs: perfHooks.performance.now() - context.startedMonotonic,
      memory: process.memoryUsage(),
      cpu: {ratio: 0},
      eventLoopP99Ms: 0,
      activeResources: resourceCounts(),
      activeResourceTotal: 0,
      clients: [],
      totals: {
        pendingSends: 0,
        bufferedAmount: 0,
        transactions: 0,
        transactionPeers: 0,
        serverTransactions: 0,
        serverTransactionBytes: 0,
        segments: 0,
        segmentBytes: 0,
        completedSegments: 0,
        listeners: 0
      }
    };
    context.samples.push(fallbackSample);
  }
  const analysis = analyzeSamples(context.samples, config, counters, finalState, context.highWater);
  if (failure) analysis.pass = false;
  const report = {
    schemaVersion: 1,
    kind: 'bacnet-sc-operational-soak',
    pass: analysis.pass,
    startedAt: context.startedAt,
    endedAt: new Date().toISOString(),
    durationMs: perfHooks.performance.now() - context.startedMonotonic,
    stoppedBySignal: context.stoppedBySignal,
    source: metadata,
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cpuModel: os.cpus()[0] && os.cpus()[0].model,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      gcExposed: typeof global.gc === 'function'
    },
    config: config,
    counters: counters,
    highWater: context.highWater,
    hubs: {
      primary: primary.counters,
      failover: failover.counters
    },
    sampleCount: context.samples.length,
    samplesFile: path.basename(samplesPath),
    finalState: finalState,
    analysis: analysis,
    unexpected: unexpected
  };
  const reportPath = path.join(config.outputDir, 'summary.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return {report: report, reportPath: reportPath};
}

async function main() {
  let config;
  try {
    config = parseConfig(process.argv.slice(2), process.env);
  } catch (err) {
    process.stderr.write(err.message + '\n' + usage() + '\n');
    process.exitCode = 2;
    return;
  }
  if (config.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const result = await runSoak(config);
  process.stdout.write(JSON.stringify({
    pass: result.report.pass,
    report: result.reportPath,
    durationMs: result.report.durationMs,
    counters: result.report.counters
  }) + '\n');
  if (!result.report.pass) process.exitCode = 1;
}

module.exports = {
  analyzeSamples,
  linearSlope,
  parseConfig,
  runSoak
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(String(err && err.stack || err) + '\n');
    process.exitCode = 1;
  });
}
