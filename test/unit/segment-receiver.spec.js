'use strict';

const expect = require('chai').expect;
const SegmentReceiver = require('../../lib/client/segment-receiver');

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  now = () => this.time;

  setTimeout = (callback, delay) => {
    const timer = {
      id: this.nextId++,
      at: this.time + delay,
      callback: callback,
      unref() {}
    };
    this.timers.set(timer.id, timer);
    return timer;
  };

  clearTimeout = (timer) => {
    if (timer) this.timers.delete(timer.id);
  };

  tick(milliseconds) {
    const end = this.time + milliseconds;
    while (true) {
      const due = Array.from(this.timers.values())
        .filter((timer) => timer.at <= end)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!due) break;
      this.time = due.at;
      this.timers.delete(due.id);
      due.callback();
    }
    this.time = end;
  }
}

function segment(overrides) {
  return Object.assign({
    direction: 'response',
    peerKey: 'peer-a',
    invokeId: 7,
    type: 0x30,
    service: 12,
    sequenceNumber: 0,
    windowSize: 2,
    moreFollows: true,
    payload: Buffer.from([0])
  }, overrides);
}

describe('bacstack - segmented APDU receiver', () => {
  it('requires sequence zero to start a transfer', () => {
    const receiver = new SegmentReceiver();
    const result = receiver.accept(segment({sequenceNumber: 1}));

    expect(result).to.include({
      status: 'reject',
      reason: 'SEQUENCE_START_REQUIRED',
      negativeAck: true,
      expectedSequenceNumber: 0
    });
    expect(receiver.size).to.equal(0);
  });

  it('reassembles a transfer and acknowledges by accepted segment count', () => {
    const receiver = new SegmentReceiver();
    const first = receiver.accept(segment({payload: Buffer.from('ab')}));
    const second = receiver.accept(segment({
      sequenceNumber: 1,
      moreFollows: false,
      payload: Buffer.from('cd')
    }));

    expect(first).to.include({status: 'pending', ack: false, segmentCount: 1});
    expect(second).to.include({status: 'complete', ack: true, segmentCount: 2});
    expect(second.payload.toString()).to.equal('abcd');
    expect(receiver.size).to.equal(0);
    expect(receiver.totalBytes).to.equal(0);
  });

  it('isolates interleaved peers and invoke identifiers', () => {
    const receiver = new SegmentReceiver();
    receiver.accept(segment({peerKey: 'peer-a', invokeId: 1, payload: Buffer.from('a')}));
    receiver.accept(segment({peerKey: 'peer-b', invokeId: 1, payload: Buffer.from('b')}));
    receiver.accept(segment({peerKey: 'peer-a', invokeId: 2, payload: Buffer.from('c')}));

    const a1 = receiver.accept(segment({peerKey: 'peer-a', invokeId: 1, sequenceNumber: 1, moreFollows: false, payload: Buffer.from('1')}));
    const b1 = receiver.accept(segment({peerKey: 'peer-b', invokeId: 1, sequenceNumber: 1, moreFollows: false, payload: Buffer.from('2')}));
    const a2 = receiver.accept(segment({peerKey: 'peer-a', invokeId: 2, sequenceNumber: 1, moreFollows: false, payload: Buffer.from('3')}));

    expect(a1.payload.toString()).to.equal('a1');
    expect(b1.payload.toString()).to.equal('b2');
    expect(a2.payload.toString()).to.equal('c3');
  });

  it('does not append duplicate or out-of-order segments', () => {
    const receiver = new SegmentReceiver();
    receiver.accept(segment({payload: Buffer.from('a')}));

    const duplicate = receiver.accept(segment({payload: Buffer.from('x')}));
    const outOfOrder = receiver.accept(segment({sequenceNumber: 2, payload: Buffer.from('y')}));
    const complete = receiver.accept(segment({sequenceNumber: 1, moreFollows: false, payload: Buffer.from('b')}));

    expect(duplicate).to.include({status: 'duplicate', ack: true});
    expect(outOfOrder).to.include({status: 'out-of-order', negativeAck: true, expectedSequenceNumber: 1});
    expect(complete.payload.toString()).to.equal('ab');
  });

  it('supports sequence-number wrap without treating it as a duplicate', () => {
    const receiver = new SegmentReceiver({maxSegments: 300});
    for (let index = 0; index <= 255; index++) {
      const result = receiver.accept(segment({
        sequenceNumber: index,
        windowSize: 127,
        payload: Buffer.from([index]),
        moreFollows: true
      }));
      expect(result.status).to.equal('pending');
    }

    const complete = receiver.accept(segment({
      sequenceNumber: 0,
      windowSize: 127,
      moreFollows: false,
      payload: Buffer.from([0xAA])
    }));

    expect(complete).to.include({status: 'complete', segmentCount: 257});
    expect(complete.payload.length).to.equal(257);
    expect(complete.payload[256]).to.equal(0xAA);
  });

  it('cleans up transfers that exceed segment or byte limits', () => {
    const receiver = new SegmentReceiver({
      maxSegments: 1,
      maxBytesPerTransfer: 2,
      maxTotalBytes: 2
    });
    receiver.accept(segment({payload: Buffer.from('a')}));
    const result = receiver.accept(segment({sequenceNumber: 1, payload: Buffer.from('b')}));

    expect(result).to.include({status: 'reject', reason: 'SEGMENT_LIMIT', abort: true});
    expect(receiver.size).to.equal(0);
    expect(receiver.totalBytes).to.equal(0);
  });

  it('enforces global and per-peer transfer limits', () => {
    const receiver = new SegmentReceiver({maxTransfers: 2, maxTransfersPerPeer: 1});
    receiver.accept(segment({peerKey: 'peer-a', invokeId: 1}));

    expect(receiver.accept(segment({peerKey: 'peer-a', invokeId: 2}))).to.include({reason: 'PEER_TRANSFER_LIMIT'});
    receiver.accept(segment({peerKey: 'peer-b', invokeId: 1}));
    expect(receiver.accept(segment({peerKey: 'peer-c', invokeId: 1}))).to.include({reason: 'TRANSFER_LIMIT'});
  });

  it('expires idle and absolute transfers with deterministic cleanup', () => {
    const clock = new FakeClock();
    const expirations = [];
    const receiver = new SegmentReceiver({
      idleTimeout: 10,
      absoluteTimeout: 25,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onExpire: (event) => expirations.push(event)
    });
    receiver.accept(segment({peerKey: 'idle'}));
    receiver.accept(segment({peerKey: 'absolute'}));
    clock.tick(8);
    receiver.accept(segment({peerKey: 'absolute', sequenceNumber: 0}));
    clock.tick(2);

    expect(expirations).to.deep.include({
      reason: 'IDLE_TIMEOUT',
      direction: 'response',
      peerKey: 'idle',
      invokeId: 7,
      type: 0x30,
      service: 12,
      sequenceNumber: 0,
      windowSize: 2,
      context: undefined
    });
    expect(receiver.size).to.equal(1);

    clock.tick(5);
    receiver.accept(segment({peerKey: 'absolute', sequenceNumber: 0}));
    clock.tick(7);
    receiver.accept(segment({peerKey: 'absolute', sequenceNumber: 0}));
    clock.tick(3);
    expect(expirations.some((event) => event.peerKey === 'absolute' && event.reason === 'ABSOLUTE_TIMEOUT')).to.equal(true);
    expect(receiver.size).to.equal(0);
  });

  it('rejects invariant changes and cancelAll releases every byte', () => {
    const receiver = new SegmentReceiver();
    receiver.accept(segment({peerKey: 'peer-a', payload: Buffer.from('one')}));
    const mismatch = receiver.accept(segment({peerKey: 'peer-a', sequenceNumber: 1, service: 14}));
    receiver.accept(segment({peerKey: 'peer-b', payload: Buffer.from('two')}));

    expect(mismatch).to.include({status: 'reject', reason: 'TRANSFER_MISMATCH', abort: true});
    receiver.cancelAll();
    expect(receiver.size).to.equal(0);
    expect(receiver.totalBytes).to.equal(0);
  });
});
