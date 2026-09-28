import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackingState } from '../docs/fullbody/tracking-state.js';

const p = (x, y, visibility = 0) => ({ x, y, z: 0, visibility, presence: visibility });
const hand = (side, x, y = 0.3) => ({
  side, points: [p(x, y), ...Array.from({ length: 20 }, (_, i) => {
    const finger = Math.floor(i / 4), joint = i % 4 + 1;
    return p(x + (finger - 2) * 0.022, y - joint * 0.025);
  })],
});
const hands = (...observations) => ({
  landmarks: observations.map(observation => observation.points),
  worldLandmarks: observations.map(({ points }) => points.map(point => ({
    ...point, x: point.x - points[0].x, y: point.y - points[0].y,
  }))),
  handedness: observations.map(observation => [{ categoryName: observation.side, score: 0.99 }]),
});
const pose = (left, right, confidence = 0.99) => {
  const points = Array.from({ length: 33 }, () => p(0, 0));
  if (left) points[15] = p(...left, confidence);
  if (right) points[16] = p(...right, confidence);
  // Shoulder order must not masquerade as hand identity when hands cross.
  points[11] = p(0.7, 0.6, 0.99);
  points[12] = p(0.3, 0.6, 0.99);
  return { landmarks: [points] };
};
const prime = (state, observations, poseResult) => {
  for (const time of [-0.2, -0.1]) state.update({ time, hands: observations, pose: poseResult });
  return state.update({ time: 0, hands: observations, pose: poseResult });
};

test('alternating hands at one position converge even when duplicate labels disagree with Pose', () => {
  const state = new TrackingState();
  prime(state, hands(hand('Left', .72), hand('Right', .28)));
  let time=0;
  for (const [side, duplicate] of [['Right',false],['Left',false],['Right',true],['Left',true]]) {
    const wrong=side==='Left'?'Right':'Left';
    const observations=[hand(wrong,.38)];
    if(duplicate) observations.push(hand(side,.38));
    let frame;
    for(let i=0;i<25;i++) {
      time+=.1;
      frame=state.update({time,hands:hands(...observations),pose:side==='Left'?pose([.38,.3],null):pose(null,[.38,.3])});
    }
    assert.deepEqual(frame.hands.trackingIds,[side],JSON.stringify({side,duplicate,tracks:Object.fromEntries(Object.entries(state.tracks).map(([s,t])=>[s,{id:t.id,confirmed:t.confirmed,conflict:t.identityConflict,seen:t.seenAt,acquisition:t.acquisition}]))}));
  }
});

test('hand acquisition converges after fast alternating inputs with different switch timings', () => {
  for(let dwell=1;dwell<=12;dwell++) {
    const state = new TrackingState();
    prime(state,hands(hand('Left',.72),hand('Right',.28)));
    let time=0,frame;
    for(let change=0;change<8;change++) {
      const side=change%2?'Left':'Right',wrong=side==='Left'?'Right':'Left';
      const values=change<2?[hand(wrong,.38)]:[hand(wrong,.38),hand(side,.38)];
      const input={hands:hands(...values),pose:side==='Left'?pose([.38,.3],null):pose(null,[.38,.3])};
      for(let tick=0;tick<(change===7?30:dwell);tick++) {
        time+=.08+(tick%3)*.02;
        frame=state.update({...input,time});
      }
    }
    assert.deepEqual(frame.hands.trackingIds,['Left'],`switch dwell ${dwell}`);
  }
});

test('visible Pose wrists confirm anatomical hands even with absent elbows and mistaken classifier labels', () => {
  const state = new TrackingState();
  const input = { pose: pose([0.25, 0.3], [0.75, 0.3]),
    hands: hands(hand('Right', 0.25), hand('Left', 0.75)),
  };
  const pending = state.update({ ...input, time: 0 });
  assert.deepEqual(pending.hands.trackingIds, []);
  assert.equal(pending.hands.pendingCount, 2);
  assert.deepEqual(pending.hands.pendingSides, ['left', 'right']);
  const frame = state.update({ ...input, time: 0.2 });
  assert.deepEqual(frame.hands.trackingIds, ['Left', 'Right']);
  assert.equal(frame.hands.landmarks[0][0].x, 0.25);
  assert.equal(frame.hands.landmarks[1][0].x, 0.75);
  assert.equal(new Set(frame.hands.physicalTrackingIds).size, 2);
});

test('sustained Pose corrects a previously confirmed wrong hand and releases the former arm', () => {
  const state = new TrackingState();
  const initial = prime(state, hands(hand('Left', 0.65)));
  const pending = state.update({ time: 0.1, pose: pose(null, [0.65, 0.3]), hands: hands(hand('Left', 0.65)) });
  assert.deepEqual(pending.hands.trackingIds, ['Left']);
  assert.deepEqual(pending.hands.releasedSides, []);
  assert.deepEqual(pending.hands.pendingSides, ['right']);
  const corrected = state.update({ time: 0.3, pose: pose(null, [0.65, 0.3]), hands: hands(hand('Left', 0.65)) });
  assert.deepEqual(corrected.hands.trackingIds, ['Right']);
  assert.deepEqual(corrected.hands.releasedSides, ['left']);
  assert.deepEqual(corrected.hands.physicalTrackingIds, initial.hands.physicalTrackingIds);
  assert.equal(state.tracks.Left.wrist, null);
  const next = state.update({ time: 0.4, pose: pose(null, [0.65, 0.3]), hands: hands(hand('Left', 0.65)) });
  assert.deepEqual(next.hands.trackingIds, ['Right']);
  assert.deepEqual(next.hands.releasedSides, []);
});

test('alternating raised hands can reuse the previous opposite hand position without raising both arms', () => {
  const state = new TrackingState();
  prime(state, hands(hand('Left', 0.7), hand('Right', 0.3)));
  for (let i = 1; i <= 10; i++) {
    const side = i % 2 ? 'Right' : 'Left';
    const input = {
      pose: side === 'Right' ? pose([0.25, 0.8], [0.7, 0.3]) : pose([0.7, 0.3], [0.25, 0.8]),
      hands: hands(hand(side, 0.7)),
    };
    const pending = state.update({ ...input, time: i * 0.4 });
    assert.deepEqual(pending.hands.trackingIds, [], 'ambiguous new hand must not update the former arm');
    assert.deepEqual(pending.hands.pendingSides, ['left', 'right']);
    const frame = state.update({ ...input, time: i * 0.4 + 0.15 });
    assert.deepEqual(frame.hands.trackingIds, [side]);
    assert.deepEqual(frame.hands.releasedSides, [side === 'Right' ? 'left' : 'right']);
    assert.equal(frame.hands.landmarks.length, 1);
    assert.equal(frame.hands.physicalTrackingIds.length, 1);
  }
});

test('unreliable Pose wrists cannot override a correctly tracked hand', () => {
  const state = new TrackingState();
  prime(state, hands(hand('Left', 0.65)));
  const frame = state.update({ time: 0.1, pose: pose(null, [0.65, 0.3], 0.2), hands: hands(hand('Left', 0.65)) });
  assert.deepEqual(frame.hands.trackingIds, ['Left']);
  assert.deepEqual(frame.hands.releasedSides, []);
});

test('overlapping Pose wrists leave identity to history instead of arbitrary nearest-side ties', () => {
  const state = new TrackingState();
  prime(state, hands(hand('Right', 0.5)));
  for (let i = 1; i < 5; i++) {
    const frame = state.update({ time: i / 30, pose: pose([0.5, 0.3], [0.501, 0.3]), hands: hands(hand('Left', 0.5)) });
    assert.deepEqual(frame.hands.trackingIds, ['Right']);
    assert.deepEqual(frame.hands.releasedSides, []);
  }
});

test('a duplicate detection with an opposite label does not fabricate a second raised hand', () => {
  const state = new TrackingState();
  prime(state, hands(hand('Left', 0.65)));
  for (let i = 1; i <= 12; i++) {
    const original = hand('Left', 0.65), duplicate = hand('Right', 0.651);
    const frame = state.update({ time: i / 30, hands: i % 2 ? hands(duplicate, original) : hands(original, duplicate) });
    assert.deepEqual(frame.hands.trackingIds, ['Left']);
    assert.equal(frame.hands.landmarks.length, 1);
    assert.equal(frame.hands.physicalTrackingIds.length, 1);
  }
});

test('two actual hands with close wrists and different finger geometry are retained', () => {
  const left = hand('Left', 0.5), right = hand('Right', 0.501);
  for (let joint = 9; joint < 21; joint++) right.points[joint].y += 0.06;
  const frame = prime(new TrackingState(), hands(left, right));
  assert.deepEqual(frame.hands.trackingIds, ['Left', 'Right']);
  assert.equal(frame.hands.landmarks.length, 2);
  assert.equal(new Set(frame.hands.physicalTrackingIds).size, 2);
});

test('physical hand IDs survive detector order changes while keeping independent finger samples', () => {
  const state = new TrackingState();
  const left = hand('Left', 0.7), right = hand('Right', 0.3);
  const first = prime(state, hands(left, right));
  const second = state.update({ time: 0.1, hands: hands(right, left) });
  assert.deepEqual(second.hands.physicalTrackingIds, first.hands.physicalTrackingIds);
  assert.equal(second.hands.landmarks[0][0].x, 0.7);
  assert.equal(second.hands.landmarks[1][0].x, 0.3);
});

test('SDK default visibility zero on Hand points does not suppress hand association or filters', () => {
  const state = new TrackingState();
  prime(state, hands(hand('Right', 0.65)));
  const frame = state.update({ time: 0.1, pose: pose(null, [0.66, 0.3]), hands: hands(hand('Right', 0.66)) });
  assert.deepEqual(frame.hands.trackingIds, ['Right']);
  assert.ok(frame.hands.landmarks[0][0].x > 0.65);
  assert.ok(frame.hands.landmarks[0][0].x < 0.66);
  assert.equal(frame.hands.landmarks[0][0].visibility, 0);
});

test('a sustained classifier correction emits release metadata even without Pose', () => {
  const state = new TrackingState();
  const first = prime(state, hands(hand('Left', 0.65)));
  let corrected;
  for (const time of [0.1, 0.3, 0.61]) corrected = state.update({ time, hands: hands(hand('Right', 0.65)) });
  assert.deepEqual(corrected.hands.trackingIds, ['Right']);
  assert.deepEqual(corrected.hands.releasedSides, ['left']);
  assert.deepEqual(corrected.hands.physicalTrackingIds, first.hands.physicalTrackingIds);
});

test('Pose can correct two mistaken initial assignments atomically without sharing a track', () => {
  const state = new TrackingState();
  const initial = prime(state, hands(hand('Left', 0.3), hand('Right', 0.7)));
  state.update({ time: 0.1, pose: pose([0.7, 0.3], [0.3, 0.3]), hands: hands(hand('Left', 0.3), hand('Right', 0.7)) });
  const corrected = state.update({ time: 0.3, pose: pose([0.7, 0.3], [0.3, 0.3]), hands: hands(hand('Left', 0.3), hand('Right', 0.7)) });
  assert.deepEqual(corrected.hands.releasedSides.sort(), ['left', 'right']);
  assert.deepEqual(corrected.hands.physicalTrackingIds, [...initial.hands.physicalTrackingIds].reverse());
  assert.equal(corrected.hands.landmarks[0][0].x, 0.7);
  assert.equal(corrected.hands.landmarks[1][0].x, 0.3);
  assert.notEqual(state.tracks.Left, state.tracks.Right);
});

test('one or two incorrect acquisition labels never flash the wrong arm before a palm settles', () => {
  for (const wrongSamples of [1, 2]) {
    const state = new TrackingState();
    for (let i = 0; i < wrongSamples; i++) {
      const frame = state.update({ time: i / 30, hands: hands(hand('Left', 0.65)) });
      assert.deepEqual(frame.hands.trackingIds, []);
    }
    for (let i = 0; i <= 3; i++) {
      const frame = state.update({ time: (wrongSamples + i) / 30, hands: hands(hand('Right', 0.65)) });
      assert.deepEqual(frame.hands.trackingIds, i < 3 ? [] : ['Right']);
      assert.deepEqual(frame.hands.releasedSides, [], 'a provisional side was never animated and needs no release');
    }
  }
});

test('a one-frame mistaken Pose wrist cannot swap a settled hand or acquire a new wrong hand', () => {
  const state = new TrackingState();
  const first = prime(state, hands(hand('Left', 0.65)));
  const wrong = state.update({ time: 0.1, hands: hands(hand('Left', 0.65)), pose: pose(null, [0.65, 0.3]) });
  assert.deepEqual(wrong.hands.trackingIds, ['Left']);
  assert.deepEqual(wrong.hands.releasedSides, []);
  assert.deepEqual(wrong.hands.pendingSides, ['right']);
  const recovered = state.update({ time: 0.2, hands: hands(hand('Left', 0.65)), pose: pose([0.65, 0.3], null) });
  assert.deepEqual(recovered.hands.physicalTrackingIds, first.hands.physicalTrackingIds);
  assert.deepEqual(recovered.hands.pendingSides, []);

  const fresh = new TrackingState();
  assert.equal(fresh.update({ time: 0, hands: hands(hand('Left', 0.65)), pose: pose(null, [0.65, 0.3]) }).hands.pendingCount, 1);
  assert.deepEqual(fresh.update({ time: 0.03, hands: hands(hand('Left', 0.65)), pose: pose([0.65, 0.3], null) }).hands.trackingIds, []);
  assert.deepEqual(fresh.update({ time: 0.12, hands: hands(hand('Left', 0.65)), pose: pose([0.65, 0.3], null) }).hands.trackingIds, ['Left']);
});

test('a reappearing palm is confirmed again while preserving its physical ID', () => {
  const state = new TrackingState();
  const first = prime(state, hands(hand('Left', 0.65)));
  state.update({ time: 0.1, hands: hands() });
  const ambiguous = state.update({ time: 0.2, hands: hands(hand('Right', 0.65)) });
  assert.deepEqual(ambiguous.hands.trackingIds, []);
  assert.deepEqual(ambiguous.hands.pendingSides, ['left', 'right']);
  const candidate = state.update({ time: 0.23, hands: hands(hand('Left', 0.65)) });
  assert.deepEqual(candidate.hands.trackingIds, []);
  const accepted = state.update({ time: 0.34, hands: hands(hand('Left', 0.65)) });
  assert.deepEqual(accepted.hands.trackingIds, ['Left']);
  assert.deepEqual(accepted.hands.physicalTrackingIds, first.hands.physicalTrackingIds);
  assert.deepEqual(accepted.hands.releasedSides, []);
});

test('a candidate cannot accumulate confirmation through missing or duplicate captures', () => {
  const state = new TrackingState();
  const first = state.update({ time: 0, hands: hands(hand('Left', 0.65)) });
  assert.equal(state.update({ time: 0, hands: hands(hand('Left', 0.65)) }, 1), first);
  state.update({ time: 0.03, hands: hands() });
  assert.deepEqual(state.update({ time: 0.2, hands: hands(hand('Left', 0.65)) }).hands.trackingIds, []);
  assert.deepEqual(state.update({ time: 0.3, hands: hands(hand('Left', 0.65)) }).hands.trackingIds, ['Left']);
});

test('confirmation uses capture time and completes on the second sample even at 4 fps', () => {
  for (const fps of [4, 10, 30, 60]) {
    const state = new TrackingState();
    let acceptedAt = null;
    for (let sample = 0; sample <= fps; sample++) {
      const frame = state.update({ time: sample / fps, hands: hands(hand('Left', 0.65)) }, sample / fps + 0.8);
      if (frame.hands.trackingIds.length) { acceptedAt = sample / fps; break; }
    }
    assert.ok(acceptedAt >= 0.1 && acceptedAt <= Math.max(0.25, 0.1 + 1 / fps));
    if (fps === 4) assert.equal(acceptedAt, 0.25);
  }
});

test('confirming a new hand never suppresses the other already confirmed hand', () => {
  const state = new TrackingState();
  prime(state, hands(hand('Left', 0.7)));
  const candidate = state.update({ time: 0.1, hands: hands(hand('Left', 0.7), hand('Right', 0.3)) });
  assert.deepEqual(candidate.hands.trackingIds, ['Left']);
  assert.equal(candidate.hands.pendingCount, 1);
  assert.deepEqual(candidate.hands.pendingSides, ['right']);
  const accepted = state.update({ time: 0.2, hands: hands(hand('Left', 0.7), hand('Right', 0.3)) });
  assert.deepEqual(accepted.hands.trackingIds, ['Left', 'Right']);
  assert.equal(accepted.hands.pendingCount, 0);
});
