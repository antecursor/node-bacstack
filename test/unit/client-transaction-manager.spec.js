'use strict';

const expect = require('chai').expect;
const baEnum = require('../../lib/enum');
const TransactionManager = require('../../lib/client/transaction-manager');

const PDUS = baEnum.PduTypes;
const READ_PROPERTY = baEnum.ConfirmedServiceChoice.READ_PROPERTY;

function createClock(start) {
  let now = start == null ? 1000 : start;
  let nextId = 1;
  const timers = new Map();
  return {
    clearTimeout: (id) => timers.delete(id),
    now: () => now,
    pending: () => timers.size,
    setTimeout: (callback, delay) => {
      const id = nextId++;
      timers.set(id, {at: now + delay, callback});
      return id;
    },
    tick: (duration) => {
      const target = now + duration;
      let due;
      do {
        due = Array.from(timers.entries())
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (due) {
          timers.delete(due[0]);
          now = due[1].at;
          due[1].callback();
        }
      } while (due);
      now = target;
    }
  };
}

function createManager(options) {
  const clock = options && options.clock ? options.clock : createClock();
  const manager = new TransactionManager(Object.assign({
    clearTimeout: clock.clearTimeout,
    defaultTimeout: 100,
    now: clock.now,
    setTimeout: clock.setTimeout
  }, options, {clock: undefined}));
  return {clock, manager};
}

function begin(manager, address, callback, options) {
  return manager.begin(Object.assign({
    acceptedPdus: [PDUS.COMPLEX_ACK, PDUS.ERROR, PDUS.ABORT],
    address,
    callback: callback || (() => {}),
    service: READ_PROPERTY
  }, options));
}

describe('bacstack - Client transaction manager', () => {
  it('registers atomically and exposes immutable correlation metadata', () => {
    const clock = createClock(2500);
    let manager;
    let sizeDuringTimerSetup;
    manager = new TransactionManager({
      clearTimeout: clock.clearTimeout,
      defaultTimeout: 100,
      now: clock.now,
      setTimeout: (callback, delay) => {
        sizeDuringTimerSetup = manager.size;
        return clock.setTimeout(callback, delay);
      }
    });

    const transaction = begin(manager, '10.0.0.1', null, {timeout: 75});

    expect(sizeDuringTimerSetup).to.equal(1);
    expect(transaction).to.include({invokeId: 0, service: READ_PROPERTY, deadline: 2575});
    expect(transaction.key).to.be.a('string');
    expect(transaction.peerKey).to.be.a('string');
    expect(transaction.active).to.equal(true);
    expect(transaction.signal).to.be.an.instanceOf(AbortSignal);
    expect(Object.isFrozen(transaction)).to.equal(true);
    expect(Object.isFrozen(transaction.address)).to.equal(true);
    expect(Object.isFrozen(transaction.acceptedPdus)).to.equal(true);
    expect(manager.has('10.0.0.1', 0)).to.equal(true);
  });

  it('allocates the full 0..255 range independently for each exact peer', () => {
    const {manager} = createManager();
    const first = begin(manager, '10.0.0.1');
    const second = begin(manager, '10.0.0.1');
    const other = begin(manager, '10.0.0.2');
    const routeOne = begin(manager, {ip: '10.0.0.254', net: 1, adr: [1]});
    const routeTwo = begin(manager, {ip: '10.0.0.254', net: 2, adr: [1]});
    const scFirst = begin(manager, {vmac: '020000000001'});
    const scSamePeer = begin(manager, {vmac: [2, 0, 0, 0, 0, 1]});
    const scOther = begin(manager, {vmac: '020000000002'});

    expect([first.invokeId, second.invokeId, other.invokeId]).to.deep.equal([0, 1, 0]);
    expect([routeOne.invokeId, routeTwo.invokeId]).to.deep.equal([0, 0]);
    expect([scFirst.invokeId, scSamePeer.invokeId, scOther.invokeId]).to.deep.equal([0, 1, 0]);
    manager.cancelAll();
  });

  it('accepts explicit ID zero but rejects duplicate and invalid explicit IDs', () => {
    const {manager} = createManager();
    const zero = begin(manager, '10.0.0.1', null, {requestedInvokeId: 0});
    const sameIdOtherPeer = begin(manager, '10.0.0.2', null, {requestedInvokeId: 0});

    expect(zero.invokeId).to.equal(0);
    expect(sameIdOtherPeer.invokeId).to.equal(0);
    expect(() => begin(manager, '10.0.0.1', null, {requestedInvokeId: 0}))
      .to.throw('ERR_INVOKE_ID_IN_USE').with.property('code', 'ERR_INVOKE_ID_IN_USE');
    [-1, 256, 1.5].forEach((invokeId) => {
      expect(() => begin(manager, '10.0.0.3', null, {requestedInvokeId: invokeId}))
        .to.throw('ERR_INVALID_INVOKE_ID').with.property('code', 'ERR_INVALID_INVOKE_ID');
    });
  });

  it('reports exhaustion only after all 256 IDs for one peer are active', () => {
    const {manager} = createManager();
    const ids = [];
    for (let index = 0; index < 256; index++) {
      ids.push(begin(manager, '10.0.0.1').invokeId);
    }

    expect(ids).to.deep.equal(Array.from({length: 256}, (value, index) => index));
    expect(() => begin(manager, '10.0.0.1'))
      .to.throw('ERR_INVOKE_ID_EXHAUSTED').with.property('code', 'ERR_INVOKE_ID_EXHAUSTED');
    expect(begin(manager, '10.0.0.2').invokeId).to.equal(0);
    manager.cancelAll();
  });

  it('requires exact peer, expected service, and an accepted response PDU', () => {
    const {manager} = createManager();
    const calls = [];
    const address = {ip: '10.0.0.254', net: 303, adr: [5]};
    const transaction = begin(manager, address, (error, result) => calls.push({error, result}), {
      acceptedPdus: [PDUS.COMPLEX_ACK, PDUS.ERROR]
    });

    expect(manager.settle({
      address: {ip: '10.0.0.254', net: 304, adr: [5]},
      invokeId: transaction.invokeId,
      pduType: PDUS.COMPLEX_ACK,
      result: 'wrong route',
      service: READ_PROPERTY
    })).to.equal(false);
    expect(manager.settle({
      address,
      invokeId: transaction.invokeId,
      pduType: PDUS.SIMPLE_ACK,
      result: 'wrong PDU',
      service: READ_PROPERTY
    })).to.equal(false);
    expect(manager.settle({
      address,
      invokeId: transaction.invokeId,
      pduType: PDUS.COMPLEX_ACK,
      result: 'wrong service',
      service: READ_PROPERTY + 1
    })).to.equal(false);
    expect(calls).to.deep.equal([]);
    expect(transaction.active).to.equal(true);

    expect(manager.settle({
      address,
      invokeId: transaction.invokeId,
      pduType: PDUS.COMPLEX_ACK | 0x0C,
      result: 'matched',
      service: READ_PROPERTY
    })).to.equal(true);
    expect(calls).to.deep.equal([{error: undefined, result: 'matched'}]);
    expect(transaction.active).to.equal(false);
    expect(manager.size).to.equal(0);
    expect(manager.settle({
      address,
      invokeId: transaction.invokeId,
      pduType: PDUS.COMPLEX_ACK,
      result: 'duplicate',
      service: READ_PROPERTY
    })).to.equal(false);
    expect(transaction.settle(null, 'duplicate')).to.equal(false);
  });

  it('preflights segmented responses and exposes immutable request policy', () => {
    const {manager} = createManager();
    const transaction = begin(manager, '10.0.0.1', null, {
      responseMaxApdu: 480,
      responseSegmentLimit: 16
    });
    const response = {
      address: '10.0.0.1',
      invokeId: transaction.invokeId,
      pduType: PDUS.COMPLEX_ACK | 0x0C,
      service: READ_PROPERTY
    };

    expect(manager.match(Object.assign({}, response, {address: '10.0.0.2'}))).to.equal(null);
    expect(manager.match(Object.assign({}, response, {service: READ_PROPERTY + 1}))).to.equal(null);
    expect(manager.match(Object.assign({}, response, {pduType: PDUS.SIMPLE_ACK}))).to.equal(null);
    const policy = manager.match(response);
    expect(policy).to.include({
      invokeId: transaction.invokeId,
      responseMaxApdu: 480,
      responseSegmentDeadline: null,
      responseSegmentLimit: 16,
      service: READ_PROPERTY
    });
    expect(Object.isFrozen(policy)).to.equal(true);
    expect(transaction).to.include({responseMaxApdu: 480, responseSegmentLimit: 16});
    expect(transaction.active).to.equal(true);
  });

  it('hands request timing to one fixed segmented-response deadline', () => {
    const {clock, manager} = createManager();
    const calls = [];
    const transaction = begin(manager, '10.0.0.1', (error) => calls.push(error), {
      timeout: 25,
      responseSegmentLimit: 8
    });
    const response = {
      address: '10.0.0.1',
      invokeId: transaction.invokeId,
      pduType: PDUS.COMPLEX_ACK,
      segmented: true,
      service: READ_PROPERTY
    };
    clock.tick(20);
    expect(manager.handoffSegmentedResponse(response, 1050)).to.equal(true);
    expect(manager.match(response).responseSegmentDeadline).to.equal(1050);
    expect(manager.handoffSegmentedResponse(response, 1050)).to.equal(true);
    expect(manager.handoffSegmentedResponse(response, 1060)).to.equal(false);

    clock.tick(5);
    expect(calls).to.deep.equal([]);
    expect(transaction.active).to.equal(true);
    clock.tick(24);
    expect(calls).to.deep.equal([]);
    clock.tick(1);
    expect(calls).to.have.length(1);
    expect(calls[0]).to.have.property('code', 'ERR_TIMEOUT');
    expect(transaction.active).to.equal(false);
  });

  it('does not accept an unsegmented success after segmented response handoff', () => {
    const {manager} = createManager();
    const calls = [];
    const transaction = begin(manager, '10.0.0.1',
      (error, result) => calls.push({error, result}));
    const response = {
      address: '10.0.0.1',
      invokeId: transaction.invokeId,
      pduType: PDUS.COMPLEX_ACK,
      service: READ_PROPERTY,
      segmented: true
    };
    expect(manager.handoffSegmentedResponse(response, 1050)).to.equal(true);

    expect(manager.settle(Object.assign({}, response, {
      result: 'unsegmented',
      segmented: false
    }))).to.equal(false);
    expect(calls).to.deep.equal([]);
    expect(transaction.active).to.equal(true);
    expect(manager.settle(Object.assign({}, response, {result: 'reassembled'}))).to.equal(true);
    expect(calls).to.deep.equal([{error: undefined, result: 'reassembled'}]);
  });

  it('hard-expires request and segmented-response deadlines when timer delivery is late', () => {
    let now = 1000;
    const callbacks = [];
    const manager = new TransactionManager({
      clearTimeout: () => {},
      defaultTimeout: 25,
      now: () => now,
      setTimeout: () => 1
    });
    const first = begin(manager, '10.0.0.1', (error) => callbacks.push(error));
    now = first.deadline;
    expect(manager.settle({
      address: '10.0.0.1',
      invokeId: first.invokeId,
      pduType: PDUS.COMPLEX_ACK,
      result: 'late',
      service: READ_PROPERTY
    })).to.equal(false);
    expect(callbacks[0]).to.have.property('code', 'ERR_TIMEOUT');

    now = 2000;
    const second = begin(manager, '10.0.0.2', (error) => callbacks.push(error));
    const segmented = {
      address: '10.0.0.2',
      invokeId: second.invokeId,
      pduType: PDUS.COMPLEX_ACK,
      segmented: true,
      service: READ_PROPERTY
    };
    expect(manager.handoffSegmentedResponse(segmented, 2050)).to.equal(true);
    now = 2050;
    expect(manager.settle(Object.assign({result: 'late segmented'}, segmented))).to.equal(false);
    expect(callbacks[1]).to.have.property('code', 'ERR_TIMEOUT');
  });

  it('leaves the request timer active when segmented handoff setup fails', () => {
    const clock = createClock();
    let setups = 0;
    const manager = new TransactionManager({
      clearTimeout: clock.clearTimeout,
      defaultTimeout: 25,
      now: clock.now,
      setTimeout: (callback, delay) => {
        setups++;
        if (setups === 2) throw new Error('handoff timer failed');
        return clock.setTimeout(callback, delay);
      }
    });
    const calls = [];
    const transaction = begin(manager, '10.0.0.1', (error) => calls.push(error));
    const response = {
      address: '10.0.0.1',
      invokeId: transaction.invokeId,
      pduType: PDUS.COMPLEX_ACK,
      service: READ_PROPERTY
    };

    expect(() => manager.handoffSegmentedResponse(response, 1050))
      .to.throw('handoff timer failed');
    clock.tick(25);
    expect(calls).to.have.length(1);
    expect(calls[0]).to.have.property('code', 'ERR_TIMEOUT');
  });

  it('validates stored segmented-response policy without reserving IDs', () => {
    const {manager} = createManager();
    expect(() => begin(manager, '10.0.0.1', null, {responseSegmentLimit: -1}))
      .to.throw('ERR_INVALID_RESPONSE_SEGMENT_LIMIT')
      .with.property('code', 'ERR_INVALID_RESPONSE_SEGMENT_LIMIT');
    expect(() => begin(manager, '10.0.0.1', null, {responseMaxApdu: 0}))
      .to.throw('ERR_INVALID_RESPONSE_MAX_APDU')
      .with.property('code', 'ERR_INVALID_RESPONSE_MAX_APDU');
    expect(manager.size).to.equal(0);
    expect(begin(manager, '10.0.0.1', null, {
      requestedInvokeId: 0,
      responseSegmentLimit: 0
    }).invokeId).to.equal(0);
  });

  it('allows service-less abort responses only when their PDU is accepted', () => {
    const {manager} = createManager();
    const calls = [];
    const transaction = begin(manager, '10.0.0.1', (error, result) => calls.push({error, result}), {
      acceptedPdus: PDUS.ABORT
    });
    const error = new Error('BacnetAbort - Reason:9');

    expect(manager.settle({
      address: '10.0.0.1',
      error,
      invokeId: transaction.invokeId,
      pduType: PDUS.ABORT
    })).to.equal(true);
    expect(calls).to.deep.equal([{error, result: undefined}]);
  });

  it('uses routed fallback only when enabled and exactly one peer can match', () => {
    const disabled = createManager().manager;
    const disabledCalls = [];
    const disabledTransaction = begin(disabled, {ip: '10.0.0.254', net: 303, adr: [5]},
      (error, result) => disabledCalls.push({error, result}));
    expect(disabled.settle({
      address: '10.0.0.254',
      invokeId: disabledTransaction.invokeId,
      pduType: PDUS.COMPLEX_ACK,
      result: 'response',
      service: READ_PROPERTY
    })).to.equal(false);
    expect(disabledCalls).to.deep.equal([]);

    const {manager} = createManager({allowRoutedResponseFallback: true});
    const calls = [];
    const transaction = begin(manager, {ip: '10.0.0.254', net: 303, adr: [5]},
      (error, result) => calls.push({error, result}));
    expect(manager.settle({
      address: {ip: '10.0.0.254'},
      invokeId: transaction.invokeId,
      pduType: PDUS.COMPLEX_ACK,
      result: 'response',
      service: READ_PROPERTY
    })).to.equal(true);
    expect(calls).to.deep.equal([{error: undefined, result: 'response'}]);
  });

  it('shares invoke-ID allocation across routed peers on one fallback link', () => {
    const {manager} = createManager({allowRoutedResponseFallback: true});
    const calls = [];
    const first = begin(manager, {ip: '10.0.0.254', net: 303, adr: [5]},
      (error, result) => calls.push({peer: 'first', error, result}));
    const second = begin(manager, {ip: '10.0.0.254', net: 304, adr: [6]},
      (error, result) => calls.push({peer: 'second', error, result}));

    expect(first.invokeId).to.equal(0);
    expect(second.invokeId).to.equal(1);
    expect(manager.settle({
      address: '10.0.0.254',
      invokeId: first.invokeId,
      pduType: PDUS.COMPLEX_ACK,
      result: 'first response',
      service: READ_PROPERTY
    })).to.equal(true);
    expect(calls).to.deep.equal([{peer: 'first', error: undefined, result: 'first response'}]);
    expect(manager.size).to.equal(1);

    expect(manager.settle({
      address: '10.0.0.254',
      invokeId: first.invokeId,
      pduType: PDUS.COMPLEX_ACK,
      result: 'late first response',
      service: READ_PROPERTY
    })).to.equal(false);
    expect(second.active).to.equal(true);
  });

  it('prevents direct and routed peers from colliding in fallback mode', () => {
    const {manager} = createManager({allowRoutedResponseFallback: true});
    const direct = begin(manager, '10.0.0.254');
    const routed = begin(manager, {ip: '10.0.0.254', net: 303, adr: [5]});

    expect(direct.invokeId).to.equal(0);
    expect(routed.invokeId).to.equal(1);
    manager.cancelAll();
  });

  it('releases response-completed invoke IDs without waiting for the APDU timeout', () => {
    const {manager} = createManager({allowRoutedResponseFallback: true});
    const address = {ip: '10.0.0.254', net: 303, adr: [5]};
    const transaction = begin(manager, address, null, {timeout: 25});
    expect(transaction.invokeId).to.equal(0);
    expect(transaction.settle(null, 'done')).to.equal(true);
    const next = begin(manager, address, null, {timeout: 25});
    expect(next.invokeId).to.equal(1);
    expect(next.settle(null, 'next')).to.equal(true);
    expect(begin(manager, address, null, {requestedInvokeId: 0, timeout: 25}).invokeId).to.equal(0);
  });

  it('keeps routed invoke IDs unique across DNS service NAT and counter wrap', () => {
    const {manager} = createManager({allowRoutedResponseFallback: true});
    const pending = begin(manager, {ip: 'bacnet-sim', net: 303, adr: [5]}, null, {
      requestedInvokeId: 0
    });

    for (let index = 0; index < 300; index++) {
      const transaction = begin(manager, {ip: 'bacnet-sim', net: 304, adr: [6]});
      expect(transaction.invokeId).not.to.equal(pending.invokeId);
      expect(manager.settle({
        address: '10.0.0.254',
        invokeId: transaction.invokeId,
        pduType: PDUS.COMPLEX_ACK,
        result: index,
        service: READ_PROPERTY
      })).to.equal(true);
    }

    expect(pending.active).to.equal(true);
    expect(manager.size).to.equal(1);
  });

  it('extends invoke quarantine through segmented-response replay retention', () => {
    const clock = createClock();
    const manager = new TransactionManager({
      clearTimeout: clock.clearTimeout,
      defaultTimeout: 10,
      now: clock.now,
      segmentedResponseRetention: 30,
      setTimeout: clock.setTimeout
    });
    const response = {
      address: '10.0.0.1',
      invokeId: 0,
      pduType: PDUS.COMPLEX_ACK,
      segmented: true,
      service: READ_PROPERTY
    };
    const transaction = begin(manager, response.address, null, {
      requestedInvokeId: 0,
      timeout: 10
    });
    expect(manager.handoffSegmentedResponse(response, 1050)).to.equal(true);
    expect(transaction.settle(null, 'complete')).to.equal(true);

    clock.tick(10);
    expect(() => begin(manager, response.address, null, {
      requestedInvokeId: 0,
      timeout: 10
    })).to.throw('ERR_INVOKE_ID_QUARANTINED')
      .with.property('code', 'ERR_INVOKE_ID_QUARANTINED');
    clock.tick(19);
    expect(() => begin(manager, response.address, null, {
      requestedInvokeId: 0,
      timeout: 10
    })).to.throw('ERR_INVOKE_ID_QUARANTINED');
    clock.tick(1);
    expect(begin(manager, response.address, null, {
      requestedInvokeId: 0,
      timeout: 10
    }).invokeId).to.equal(0);
  });

  it('times out once with ERR_TIMEOUT and aborts the transaction signal', () => {
    const {clock, manager} = createManager();
    const calls = [];
    const transaction = begin(manager, '10.0.0.1', (error, result) => calls.push({error, result}), {
      timeout: 25
    });

    clock.tick(24);
    expect(calls).to.deep.equal([]);
    expect(transaction.active).to.equal(true);
    clock.tick(1);

    expect(calls).to.have.length(1);
    expect(calls[0].error).to.be.an.instanceOf(Error);
    expect(calls[0].error.message).to.equal('ERR_TIMEOUT');
    expect(calls[0].error.code).to.equal('ERR_TIMEOUT');
    expect(calls[0].result).to.equal(undefined);
    expect(transaction.signal.aborted).to.equal(true);
    expect(transaction.signal.reason).to.equal(calls[0].error);
    expect(transaction.active).to.equal(false);
    expect(manager.size).to.equal(0);
    expect(transaction.cancel()).to.equal(false);
    expect(transaction.settle(null, 'late')).to.equal(false);
  });

  it('supports idempotent direct settlement and cancellation handles', () => {
    const {manager} = createManager();
    const settledCalls = [];
    const settled = begin(manager, '10.0.0.1', (error, result) => settledCalls.push({error, result}));
    expect(settled.settle(null, 'done')).to.equal(true);
    expect(settled.settle(null, 'again')).to.equal(false);
    expect(settled.signal.aborted).to.equal(false);
    expect(settledCalls).to.deep.equal([{error: null, result: 'done'}]);

    const cancelledCalls = [];
    const cancelled = begin(manager, '10.0.0.1',
      (error, result) => cancelledCalls.push({error, result}));
    const reason = new Error('send failed');
    expect(cancelled.cancel(reason)).to.equal(true);
    expect(cancelled.cancel(reason)).to.equal(false);
    expect(cancelled.signal.aborted).to.equal(true);
    expect(cancelled.signal.reason).to.equal(reason);
    expect(cancelledCalls).to.deep.equal([{error: reason, result: undefined}]);

    const rolledBackCalls = [];
    const rolledBack = begin(manager, '10.0.0.1',
      (error, result) => rolledBackCalls.push({error, result}));
    const rollbackReason = new Error('send threw');
    expect(rolledBack.rollback(rollbackReason)).to.equal(true);
    expect(rolledBack.rollback(rollbackReason)).to.equal(false);
    expect(rolledBack.signal.aborted).to.equal(true);
    expect(rolledBack.signal.reason).to.equal(rollbackReason);
    expect(rolledBackCalls).to.deep.equal([]);
    expect(manager.size).to.equal(0);
  });

  it('supports external AbortSignals without sending or leaking state', async() => {
    const {clock, manager} = createManager();
    const alreadyAborted = new AbortController();
    const earlyReason = new Error('cancel before begin');
    const earlyCalls = [];
    alreadyAborted.abort(earlyReason);

    const inactive = begin(manager, '10.0.0.1',
      (error, result) => earlyCalls.push({error, result}),
      {signal: alreadyAborted.signal, requestedInvokeId: 7});

    expect(inactive.active).to.equal(false);
    expect(inactive.signal.aborted).to.equal(true);
    expect(inactive.signal.reason).to.equal(earlyReason);
    expect(manager.size).to.equal(0);
    expect(clock.pending()).to.equal(0);
    expect(earlyCalls).to.deep.equal([]);
    await Promise.resolve();
    expect(earlyCalls).to.deep.equal([{error: earlyReason, result: undefined}]);

    const activeController = new AbortController();
    const laterReason = new Error('cancel in flight');
    const laterCalls = [];
    const active = begin(manager, '10.0.0.1',
      (error, result) => laterCalls.push({error, result}),
      {signal: activeController.signal, requestedInvokeId: 7});
    expect(active.active).to.equal(true);

    activeController.abort(laterReason);
    expect(active.active).to.equal(false);
    expect(active.signal.aborted).to.equal(true);
    expect(active.signal.reason).to.equal(laterReason);
    expect(laterCalls).to.deep.equal([{error: laterReason, result: undefined}]);
    expect(manager.size).to.equal(0);
    expect(clock.pending()).to.equal(0);
  });

  it('rejects invalid AbortSignal shims without reserving an invoke ID', () => {
    const {manager} = createManager();

    expect(() => begin(manager, '10.0.0.1', null, {signal: {aborted: false}}))
      .to.throw('ERR_INVALID_ABORT_SIGNAL').with.property('code', 'ERR_INVALID_ABORT_SIGNAL');
    expect(manager.size).to.equal(0);
    expect(begin(manager, '10.0.0.1', null, {requestedInvokeId: 0}).invokeId).to.equal(0);
  });

  it('cancels all transactions with ERR_CLIENT_CLOSED and clears timers', () => {
    const {clock, manager} = createManager();
    const calls = [];
    const first = begin(manager, '10.0.0.1', (error) => calls.push(error));
    const second = begin(manager, '10.0.0.2', (error) => calls.push(error));

    expect(clock.pending()).to.equal(2);
    expect(manager.cancelAll()).to.equal(2);
    expect(manager.size).to.equal(0);
    expect(clock.pending()).to.equal(0);
    expect(calls).to.have.length(2);
    calls.forEach((error) => {
      expect(error.message).to.equal('ERR_CLIENT_CLOSED');
      expect(error.code).to.equal('ERR_CLIENT_CLOSED');
    });
    expect(first.signal.aborted).to.equal(true);
    expect(second.signal.aborted).to.equal(true);
    expect(manager.cancelAll()).to.equal(0);
  });

  it('rolls registration back if timer setup fails', () => {
    const setupError = new Error('timer unavailable');
    const manager = new TransactionManager({
      clearTimeout: () => {},
      now: () => 0,
      setTimeout: () => {
        throw setupError;
      }
    });

    expect(() => begin(manager, '10.0.0.1')).to.throw(setupError);
    expect(manager.size).to.equal(0);
    expect(manager.has('10.0.0.1', 0)).to.equal(false);
  });

  it('requires service metadata and errors for the terminal PDU shape', () => {
    const {manager} = createManager();
    const transaction = begin(manager, '10.0.0.1');

    expect(manager.settle({
      address: '10.0.0.1',
      invokeId: transaction.invokeId,
      pduType: PDUS.COMPLEX_ACK,
      result: 'missing service'
    })).to.equal(false);
    expect(manager.settle({
      address: '10.0.0.1',
      invokeId: transaction.invokeId,
      pduType: PDUS.ERROR,
      service: READ_PROPERTY
    })).to.equal(false);
    expect(transaction.active).to.equal(true);
    transaction.cancel();
  });

  it('rejects non-terminal PDU classes and overflowing native timer delays', () => {
    const {manager} = createManager();
    [PDUS.CONFIRMED_REQUEST, PDUS.UNCONFIRMED_REQUEST, PDUS.SEGMENT_ACK, 0xF0, 0xFF].forEach((pduType) => {
      expect(() => begin(manager, '10.0.0.1', null, {acceptedPdus: pduType}))
        .to.throw('ERR_INVALID_PDU_TYPE').with.property('code', 'ERR_INVALID_PDU_TYPE');
    });
    expect(() => begin(manager, '10.0.0.1', null, {timeout: 0x80000000}))
      .to.throw('ERR_INVALID_TIMEOUT').with.property('code', 'ERR_INVALID_TIMEOUT');
  });

  it('blocks reentrant begin calls while cancelling all transactions', () => {
    const {manager} = createManager();
    let reentrantError;
    begin(manager, '10.0.0.1', () => {
      try {
        begin(manager, '10.0.0.2');
      } catch (error) {
        reentrantError = error;
      }
    });

    expect(manager.cancelAll()).to.equal(1);
    expect(reentrantError).to.have.property('code', 'ERR_TRANSACTION_MANAGER_CANCELLING');
    expect(manager.size).to.equal(0);
  });

  it('closes permanently and cancels callbacks before releasing peer state', () => {
    const {manager} = createManager();
    let callbackError;
    begin(manager, '10.0.0.1', () => {
      try {
        begin(manager, '10.0.0.2');
      } catch (error) {
        callbackError = error;
      }
    });

    expect(manager.close()).to.equal(1);
    expect(callbackError).to.have.property('code', 'ERR_TRANSACTION_MANAGER_CLOSED');
    expect(manager.size).to.equal(0);
    expect(() => begin(manager, '10.0.0.1'))
      .to.throw('ERR_TRANSACTION_MANAGER_CLOSED').with.property('code', 'ERR_TRANSACTION_MANAGER_CLOSED');
    expect(manager.close()).to.equal(0);
  });

  it('deactivates every transaction before close callbacks can settle siblings', () => {
    const {manager} = createManager();
    const calls = [];
    let second;
    begin(manager, '10.0.0.1', (error) => {
      calls.push({name: 'first', error});
      expect(second.settle(null, 'reentrant success')).to.equal(false);
    });
    second = begin(manager, '10.0.0.2', (error, result) => {
      calls.push({name: 'second', error, result});
    });

    expect(manager.close()).to.equal(2);
    expect(calls.map((call) => call.name)).to.deep.equal(['first', 'second']);
    calls.forEach((call) => expect(call.error).to.have.property('code', 'ERR_CLIENT_CLOSED'));
    expect(second.signal.aborted).to.equal(true);
    expect(manager.size).to.equal(0);
  });

  it('delivers cancellation even when injected cleanup functions fail', () => {
    let now = 1000;
    const calls = [];
    const manager = new TransactionManager({
      clearTimeout: () => {
        throw new Error('clear failed');
      },
      defaultTimeout: 100,
      now: () => now,
      setTimeout: () => 1
    });
    const transaction = begin(manager, '10.0.0.1', (error) => calls.push(error));
    now = NaN;

    expect(transaction.cancel()).to.equal(true);
    expect(calls).to.have.length(1);
    expect(calls[0]).to.have.property('code', 'ERR_TRANSACTION_CANCELLED');
    expect(transaction.signal.aborted).to.equal(true);
    expect(manager.size).to.equal(0);
  });

  it('bounds churned peer state and prunes it after quarantine', () => {
    const clock = createClock();
    const {manager} = createManager({clock, maxPeerStates: 1});
    const first = begin(manager, '10.0.0.1', null, {timeout: 25});
    first.cancel();
    expect(() => begin(manager, '10.0.0.2', null, {timeout: 25}))
      .to.throw('ERR_TRANSACTION_PEER_LIMIT').with.property('code', 'ERR_TRANSACTION_PEER_LIMIT');
    clock.tick(25);
    expect(begin(manager, '10.0.0.2', null, {timeout: 25}).invokeId).to.equal(0);
  });

  it('canonicalizes public BACnet/SC string addresses when configured', () => {
    const clock = createClock();
    const manager = new TransactionManager({
      clearTimeout: clock.clearTimeout,
      defaultTimeout: 100,
      now: clock.now,
      setTimeout: clock.setTimeout,
      stringAddressKind: 'vmac'
    });
    const calls = [];
    const transaction = begin(manager, '02:00:00:00:AB:CD', (error, result) => calls.push({error, result}));

    expect(manager.settle({
      address: '02000000abcd',
      invokeId: transaction.invokeId,
      pduType: PDUS.COMPLEX_ACK,
      result: 'matched',
      service: READ_PROPERTY
    })).to.equal(true);
    expect(calls).to.deep.equal([{error: undefined, result: 'matched'}]);
  });
});
