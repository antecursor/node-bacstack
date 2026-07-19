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
    const first = receiver.accept(segment({
      payload: Buffer.from('ab'),
      contextKey: 'same-options',
      contextId: 10
    }));
    const second = receiver.accept(segment({
      sequenceNumber: 1,
      moreFollows: false,
      payload: Buffer.from('cd'),
      contextKey: 'same-options',
      contextId: 11
    }));

    expect(first).to.include({status: 'pending', ack: true, segmentCount: 1});
    expect(second).to.include({status: 'complete', ack: true, segmentCount: 2});
    expect(second.payload.toString()).to.equal('abcd');
    expect(second.contextIds).to.deep.equal([10, 11]);
    expect(Object.isFrozen(second.contextIds)).to.equal(true);
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
    receiver.accept(segment({sequenceNumber: 1, payload: Buffer.from('b')}));

    const duplicate = receiver.accept(segment({sequenceNumber: 1, payload: Buffer.from('x')}));
    const outOfOrder = receiver.accept(segment({sequenceNumber: 3, payload: Buffer.from('y')}));
    const complete = receiver.accept(segment({sequenceNumber: 2, moreFollows: false, payload: Buffer.from('c')}));

    expect(duplicate).to.include({status: 'duplicate', ack: false});
    expect(outOfOrder).to.include({status: 'out-of-order', negativeAck: true, expectedSequenceNumber: 2});
    expect(complete.payload.toString()).to.equal('abc');
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

  it('reserves transfer and byte capacity for segmented responses', () => {
    const receiver = new SegmentReceiver({
      maxBytesPerTransfer: 3,
      maxRequestBytes: 1,
      maxRequestTransfers: 1,
      maxTotalBytes: 4,
      maxTransfers: 2,
      maxTransfersPerPeer: 2
    });
    expect(receiver.accept(segment({
      direction: 'request',
      invokeId: 1,
      payload: Buffer.from('r')
    }))).to.include({status: 'pending'});
    expect(receiver.accept(segment({
      direction: 'request',
      invokeId: 2,
      payload: Buffer.from('x')
    }))).to.include({reason: 'REQUEST_TRANSFER_LIMIT', abort: true});
    expect(receiver.accept(segment({
      direction: 'response',
      invokeId: 3,
      payload: Buffer.from('rsp')
    }))).to.include({status: 'pending'});
    expect(receiver.requestSize).to.equal(1);
    expect(receiver.requestBytes).to.equal(1);
    expect(receiver.totalBytes).to.equal(4);

    const byteBounded = new SegmentReceiver({
      maxBytesPerTransfer: 3,
      maxRequestBytes: 1,
      maxRequestTransfers: 2,
      maxTotalBytes: 4,
      maxTransfers: 2
    });
    expect(byteBounded.accept(segment({
      direction: 'request',
      payload: Buffer.from('xx')
    }))).to.include({reason: 'REQUEST_BYTE_LIMIT', abort: true});
    expect(byteBounded.requestSize).to.equal(0);
    expect(byteBounded.requestBytes).to.equal(0);
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
    receiver.accept(segment({peerKey: 'peer-a', payload: Buffer.from('one'), contextKey: 'first'}));
    const mismatch = receiver.accept(segment({
      peerKey: 'peer-a',
      sequenceNumber: 1,
      service: 14,
      contextKey: 'second'
    }));
    receiver.accept(segment({peerKey: 'peer-c', contextKey: 'first'}));
    const contextMismatch = receiver.accept(segment({
      peerKey: 'peer-c',
      sequenceNumber: 1,
      contextKey: 'second'
    }));
    receiver.accept(segment({peerKey: 'peer-b', payload: Buffer.from('two')}));

    expect(mismatch).to.include({status: 'reject', reason: 'TRANSFER_MISMATCH', abort: true});
    expect(contextMismatch).to.include({status: 'reject', reason: 'INCONSISTENT_ATTRIBUTES', abort: true});
    receiver.cancelAll();
    expect(receiver.size).to.equal(0);
    expect(receiver.totalBytes).to.equal(0);
  });

  it('ACKs sequence zero, each negotiated window boundary, and the final segment', () => {
    const receiver = new SegmentReceiver();
    const results = [];
    for (let sequenceNumber = 0; sequenceNumber < 6; sequenceNumber++) {
      results.push(receiver.accept(segment({
        sequenceNumber: sequenceNumber,
        moreFollows: sequenceNumber < 5,
        payload: Buffer.from([sequenceNumber]),
        windowSize: 2
      })));
    }

    expect(results.map((result) => result.ack)).to.deep.equal([
      true, false, true, false, true, true
    ]);
    expect(results[5]).to.include({status: 'complete', sequenceNumber: 5});
  });

  it('silently discards a window of duplicates before sending a negative ACK', () => {
    const receiver = new SegmentReceiver();
    receiver.accept(segment({sequenceNumber: 0, payload: Buffer.from('a'), windowSize: 3}));
    receiver.accept(segment({sequenceNumber: 1, payload: Buffer.from('b'), windowSize: 3}));
    receiver.accept(segment({sequenceNumber: 2, payload: Buffer.from('c'), windowSize: 3}));

    const earlier = receiver.accept(segment({sequenceNumber: 1, payload: Buffer.from('x'), windowSize: 3}));
    const recent = receiver.accept(segment({sequenceNumber: 2, payload: Buffer.from('y'), windowSize: 3}));
    const lastAllowed = receiver.accept(segment({sequenceNumber: 1, payload: Buffer.from('z'), windowSize: 3}));
    const excessive = receiver.accept(segment({sequenceNumber: 2, payload: Buffer.from('q'), windowSize: 3}));

    expect(earlier).to.include({status: 'duplicate', ack: false, duplicateCount: 1});
    expect(recent).to.include({status: 'duplicate', ack: false, duplicateCount: 2});
    expect(lastAllowed).to.include({status: 'duplicate', ack: false, duplicateCount: 3});
    expect(excessive).to.include({
      status: 'duplicate-limit',
      negativeAck: true,
      sequenceNumber: 2
    });
    expect(receiver.totalBytes).to.equal(3);
  });

  it('recognizes duplicates across sequence-number wrap', () => {
    const receiver = new SegmentReceiver({maxSegments: 300});
    for (let index = 0; index <= 256; index++) {
      receiver.accept(segment({
        sequenceNumber: index & 0xFF,
        windowSize: 3,
        payload: Buffer.from([index & 0xFF])
      }));
    }

    expect(receiver.accept(segment({
      sequenceNumber: 0,
      windowSize: 3,
      payload: Buffer.from('duplicate')
    }))).to.include({status: 'duplicate', negativeAck: false});
    expect(receiver.accept(segment({
      sequenceNumber: 255,
      windowSize: 3,
      payload: Buffer.from('duplicate')
    }))).to.include({status: 'out-of-order', negativeAck: true, sequenceNumber: 0});
    expect(receiver.accept(segment({
      sequenceNumber: 254,
      windowSize: 3,
      payload: Buffer.from('duplicate')
    }))).to.include({status: 'out-of-order', negativeAck: true, sequenceNumber: 0});
  });

  it('negative-ACKs outside the accepted interval and realigns its window anchor', () => {
    const receiver = new SegmentReceiver();
    receiver.accept(segment({sequenceNumber: 0, windowSize: 3}));
    expect(receiver.accept(segment({sequenceNumber: 0, windowSize: 3}))).to.include({
      status: 'out-of-order',
      negativeAck: true,
      sequenceNumber: 0
    });

    receiver.accept(segment({sequenceNumber: 1, windowSize: 3}));
    expect(receiver.accept(segment({sequenceNumber: 1, windowSize: 3}))).to.include({
      status: 'duplicate',
      negativeAck: false
    });
    expect(receiver.accept(segment({sequenceNumber: 0, windowSize: 3}))).to.include({
      status: 'out-of-order',
      negativeAck: true,
      sequenceNumber: 1
    });
    expect(receiver.accept(segment({sequenceNumber: 1, windowSize: 3}))).to.include({
      status: 'out-of-order',
      negativeAck: true,
      sequenceNumber: 1
    });
  });

  it('refreshes the idle deadline after a negative ACK', () => {
    const clock = new FakeClock();
    const expirations = [];
    const receiver = new SegmentReceiver({
      idleTimeout: 10,
      absoluteTimeout: 50,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onExpire: (event) => expirations.push(event)
    });
    receiver.accept(segment({payload: Buffer.from('a')}));
    clock.tick(9);
    expect(receiver.accept(segment({sequenceNumber: 3}))).to.include({
      status: 'out-of-order',
      negativeAck: true
    });
    clock.tick(9);
    expect(expirations).to.deep.equal([]);
    clock.tick(1);
    expect(expirations).to.have.length(1);
    expect(expirations[0].reason).to.equal('IDLE_TIMEOUT');
  });

  it('enforces stable every-segment context while allowing first-only context', () => {
    const receiver = new SegmentReceiver();
    receiver.accept(segment({
      contextKey: 'every',
      firstContextKey: 'first-only',
      payload: Buffer.from('a')
    }));
    const complete = receiver.accept(segment({
      contextKey: 'every',
      firstContextKey: null,
      sequenceNumber: 1,
      moreFollows: false,
      payload: Buffer.from('b')
    }));
    expect(complete).to.include({status: 'complete'});

    receiver.accept(segment({peerKey: 'other', contextKey: 'every'}));
    expect(receiver.accept(segment({
      peerKey: 'other',
      contextKey: 'changed',
      sequenceNumber: 1
    }))).to.include({
      status: 'reject',
      reason: 'INCONSISTENT_ATTRIBUTES',
      abort: true
    });

    receiver.accept(segment({peerKey: 'third', contextKey: 'every'}));
    expect(receiver.accept(segment({
      peerKey: 'third',
      contextKey: 'every',
      firstContextKey: 'late-first-only',
      sequenceNumber: 1
    }))).to.include({
      status: 'reject',
      reason: 'INCONSISTENT_ATTRIBUTES',
      abort: true
    });
  });

  it('allows only an exact retransmission of sequence-zero first-only context', () => {
    const receiver = new SegmentReceiver();
    receiver.accept(segment({
      peerKey: 'exact',
      contextKey: 'every',
      firstContextKey: 'first-only'
    }));
    expect(receiver.accept(segment({
      peerKey: 'exact',
      contextKey: 'every',
      firstContextKey: 'first-only',
      sequenceNumber: 0
    }))).to.include({status: 'out-of-order', negativeAck: true});

    receiver.accept(segment({
      peerKey: 'changed',
      contextKey: 'every',
      firstContextKey: 'first-only'
    }));
    expect(receiver.accept(segment({
      peerKey: 'changed',
      contextKey: 'every',
      firstContextKey: 'different',
      sequenceNumber: 0
    }))).to.include({
      status: 'reject',
      reason: 'INCONSISTENT_ATTRIBUTES',
      abort: true
    });
  });

  it('does not treat wrapped sequence zero as the original first segment', () => {
    const receiver = new SegmentReceiver({maxSegments: 300});
    for (let index = 0; index <= 256; index++) {
      const result = receiver.accept(segment({
        contextKey: 'every',
        firstContextKey: index === 0 ? 'first-only' : null,
        moreFollows: index < 256,
        payload: Buffer.from([index & 0xFF]),
        sequenceNumber: index & 0xFF,
        windowSize: 127
      }));
      if (index === 256) expect(result.status).to.equal('complete');
      else expect(result.status).to.equal('pending');
    }


    const inconsistent = new SegmentReceiver({maxSegments: 300});
    for (let index = 0; index <= 255; index++) {
      inconsistent.accept(segment({
        contextKey: 'every',
        firstContextKey: index === 0 ? 'first-only' : null,
        payload: Buffer.from([index]),
        sequenceNumber: index,
        windowSize: 127
      }));
    }
    expect(inconsistent.accept(segment({
      contextKey: 'every',
      firstContextKey: 'first-only',
      sequenceNumber: 0,
      windowSize: 127
    }))).to.include({
      status: 'reject',
      reason: 'INCONSISTENT_ATTRIBUTES',
      abort: true
    });
  });

  it('retains bounded completion tombstones to ACK replay without redelivery', () => {
    const clock = new FakeClock();
    const receiver = new SegmentReceiver({
      completedRetentionTimeout: 20,
      idleTimeout: 10,
      absoluteTimeout: 50,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout
    });
    const firstSegment = segment({payload: Buffer.from('a')});
    const finalSegment = segment({
      sequenceNumber: 1,
      moreFollows: false,
      payload: Buffer.from('b')
    });
    receiver.accept(firstSegment);
    expect(receiver.accept(finalSegment)).to.include({status: 'complete', ack: true});
    expect(receiver.size).to.equal(0);
    expect(receiver.completedSize).to.equal(1);

    expect(receiver.accept(finalSegment)).to.include({status: 'replay', ack: true});
    expect(receiver.size).to.equal(0);
    expect(receiver.completedSize).to.equal(1);

    clock.tick(20);
    expect(receiver.completedSize).to.equal(0);
    expect(receiver.accept(firstSegment)).to.include({status: 'pending'});
  });

  it('retains only the final unacknowledged window across sequence wrap', () => {
    const receiver = new SegmentReceiver({maxSegments: 300});
    for (let index = 0; index <= 258; index++) {
      const result = receiver.accept(segment({
        moreFollows: index < 258,
        payload: Buffer.from('same'),
        sequenceNumber: index & 0xFF,
        windowSize: 3
      }));
      if (index === 258) expect(result.status).to.equal('complete');
    }

    expect(receiver.replay(segment({
      payload: Buffer.from('same'),
      sequenceNumber: 255,
      windowSize: 3
    }))).to.equal(null);
    expect(receiver.replay(segment({
      payload: Buffer.from('same'),
      sequenceNumber: 0,
      windowSize: 3
    }))).to.include({status: 'replay', ack: false});
    expect(receiver.replay(segment({
      payload: Buffer.from('same'),
      sequenceNumber: 1,
      windowSize: 3
    }))).to.include({status: 'replay', ack: false});
    expect(receiver.replay(segment({
      moreFollows: false,
      payload: Buffer.from('same'),
      sequenceNumber: 2,
      windowSize: 3
    }))).to.include({status: 'replay', ack: true, sequenceNumber: 2});
  });

  it('bounds completion tombstones globally and per peer and clears them on close', () => {
    const clock = new FakeClock();
    const receiver = new SegmentReceiver({
      maxCompletedTransfers: 2,
      maxCompletedTransfersPerPeer: 1,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout
    });
    const complete = (peerKey, invokeId) => receiver.accept(segment({
      peerKey: peerKey,
      invokeId: invokeId,
      moreFollows: false
    }));
    complete('a', 1);
    complete('a', 2);
    expect(receiver.completedSize).to.equal(1);
    complete('b', 1);
    complete('c', 1);
    expect(receiver.completedSize).to.equal(2);

    receiver.cancelAll();
    expect(receiver.completedSize).to.equal(0);
    expect(clock.timers.size).to.equal(0);
  });

  it('reserves response replay capacity when completed requests churn', () => {
    const receiver = new SegmentReceiver({
      maxCompletedTransfers: 2,
      maxCompletedTransfersPerPeer: 2
    });
    const response = segment({
      direction: 'response',
      peerKey: 'response-peer',
      invokeId: 1,
      moreFollows: false
    });
    const firstRequest = segment({
      direction: 'request',
      peerKey: 'request-peer',
      invokeId: 1,
      moreFollows: false
    });
    const secondRequest = segment({
      direction: 'request',
      peerKey: 'request-peer',
      invokeId: 2,
      moreFollows: false
    });

    receiver.accept(response);
    receiver.accept(firstRequest);
    receiver.accept(secondRequest);

    expect(receiver.completedSize).to.equal(2);
    expect(receiver.replay(response)).to.include({status: 'replay', ack: true});
    expect(receiver.replay(firstRequest)).to.equal(null);
    expect(receiver.replay(secondRequest)).to.include({status: 'replay', ack: true});
  });

  it('evicts request tombstones before response tombstones at the global limit', () => {
    const receiver = new SegmentReceiver({
      maxCompletedTransfers: 2,
      maxCompletedTransfersPerPeer: 2
    });
    const firstResponse = segment({
      direction: 'response',
      peerKey: 'response-peer',
      invokeId: 1,
      moreFollows: false
    });
    const request = segment({
      direction: 'request',
      peerKey: 'request-peer',
      invokeId: 1,
      moreFollows: false
    });
    const secondResponse = segment({
      direction: 'response',
      peerKey: 'response-peer',
      invokeId: 2,
      moreFollows: false
    });

    receiver.accept(firstResponse);
    receiver.accept(request);
    receiver.accept(secondResponse);

    expect(receiver.completedSize).to.equal(2);
    expect(receiver.replay(firstResponse)).to.include({status: 'replay', ack: true});
    expect(receiver.replay(request)).to.equal(null);
    expect(receiver.replay(secondResponse)).to.include({status: 'replay', ack: true});
  });

  it('uses a sole completion slot only for response replay by default', () => {
    const receiver = new SegmentReceiver({maxCompletedTransfers: 1});
    const response = segment({
      direction: 'response',
      peerKey: 'response-peer',
      invokeId: 1,
      moreFollows: false
    });
    const request = segment({
      direction: 'request',
      peerKey: 'request-peer',
      invokeId: 1,
      moreFollows: false
    });

    receiver.accept(request);
    expect(receiver.completedSize).to.equal(0);
    receiver.accept(response);
    receiver.accept(request);

    expect(receiver.completedSize).to.equal(1);
    expect(receiver.replay(response)).to.include({status: 'replay', ack: true});
    expect(receiver.replay(request)).to.equal(null);
  });
});
