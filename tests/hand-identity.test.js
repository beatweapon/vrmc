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

test('visible Pose wrists associate anatomical hands even with absent elbows and mistaken classifier labels', () => {
  const frame = new TrackingState().update({
    time: 0, pose: pose([0.25, 0.3], [0.75, 0.3]),
    hands: hands(hand('Right', 0.25), hand('Left', 0.75)),
  });
  assert.deepEqual(frame.hands.trackingIds, ['Left', 'Right']);
  assert.equal(frame.hands.landmarks[0][0].x, 0.25);
  assert.equal(frame.hands.landmarks[1][0].x, 0.75);
  assert.equal(new Set(frame.hands.physicalTrackingIds).size, 2);
});

test('reliable Pose immediately corrects an initial wrong hand and explicitly releases the former arm', () => {
  const state = new TrackingState();
  const initial = state.update({ time: 0, hands: hands(hand('Left', 0.65)) });
  const corrected = state.update({ time: 0.1, pose: pose(null, [0.65, 0.3]), hands: hands(hand('Left', 0.65)) });
  assert.deepEqual(corrected.hands.trackingIds, ['Right']);
  assert.deepEqual(corrected.hands.releasedSides, ['left']);
  assert.deepEqual(corrected.hands.physicalTrackingIds, initial.hands.physicalTrackingIds);
  assert.equal(state.tracks.Left.wrist, null);
  const next = state.update({ time: 0.2, pose: pose(null, [0.65, 0.3]), hands: hands(hand('Left', 0.65)) });
  assert.deepEqual(next.hands.trackingIds, ['Right']);
  assert.deepEqual(next.hands.releasedSides, []);
});

test('alternating raised hands can reuse the previous opposite hand position without raising both arms', () => {
  const state = new TrackingState();
  state.update({ time: 0, hands: hands(hand('Left', 0.7), hand('Right', 0.3)) });
  for (let i = 1; i <= 10; i++) {
    const side = i % 2 ? 'Right' : 'Left';
    const frame = state.update({ time: i / 10,
      pose: side === 'Right' ? pose([0.25, 0.8], [0.7, 0.3]) : pose([0.7, 0.3], [0.25, 0.8]),
      hands: hands(hand(side, 0.7)),
    });
    assert.deepEqual(frame.hands.trackingIds, [side]);
    assert.deepEqual(frame.hands.releasedSides, [side === 'Right' ? 'left' : 'right']);
    assert.equal(frame.hands.landmarks.length, 1);
    assert.equal(frame.hands.physicalTrackingIds.length, 1);
  }
});

test('unreliable Pose wrists cannot override a correctly tracked hand', () => {
  const state = new TrackingState();
  state.update({ time: 0, hands: hands(hand('Left', 0.65)) });
  const frame = state.update({ time: 0.1, pose: pose(null, [0.65, 0.3], 0.2), hands: hands(hand('Left', 0.65)) });
  assert.deepEqual(frame.hands.trackingIds, ['Left']);
  assert.deepEqual(frame.hands.releasedSides, []);
});

test('overlapping Pose wrists leave identity to history instead of arbitrary nearest-side ties', () => {
  const state = new TrackingState();
  state.update({ time: 0, hands: hands(hand('Right', 0.5)) });
  for (let i = 1; i < 5; i++) {
    const frame = state.update({ time: i / 30, pose: pose([0.5, 0.3], [0.501, 0.3]), hands: hands(hand('Left', 0.5)) });
    assert.deepEqual(frame.hands.trackingIds, ['Right']);
    assert.deepEqual(frame.hands.releasedSides, []);
  }
});

test('a duplicate detection with an opposite label does not fabricate a second raised hand', () => {
  const state = new TrackingState();
  state.update({ time: 0, hands: hands(hand('Left', 0.65)) });
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
  const frame = new TrackingState().update({ time: 0, hands: hands(left, right) });
  assert.deepEqual(frame.hands.trackingIds, ['Left', 'Right']);
  assert.equal(frame.hands.landmarks.length, 2);
  assert.equal(new Set(frame.hands.physicalTrackingIds).size, 2);
});

test('physical hand IDs survive detector order changes while keeping independent finger samples', () => {
  const state = new TrackingState();
  const left = hand('Left', 0.7), right = hand('Right', 0.3);
  const first = state.update({ time: 0, hands: hands(left, right) });
  const second = state.update({ time: 0.1, hands: hands(right, left) });
  assert.deepEqual(second.hands.physicalTrackingIds, first.hands.physicalTrackingIds);
  assert.equal(second.hands.landmarks[0][0].x, 0.7);
  assert.equal(second.hands.landmarks[1][0].x, 0.3);
});

test('SDK default visibility zero on Hand points does not suppress hand association or filters', () => {
  const state = new TrackingState();
  state.update({ time: 0, hands: hands(hand('Right', 0.65)) });
  const frame = state.update({ time: 0.1, pose: pose(null, [0.66, 0.3]), hands: hands(hand('Right', 0.66)) });
  assert.deepEqual(frame.hands.trackingIds, ['Right']);
  assert.ok(frame.hands.landmarks[0][0].x > 0.65);
  assert.ok(frame.hands.landmarks[0][0].x < 0.66);
  assert.equal(frame.hands.landmarks[0][0].visibility, 0);
});

test('a sustained classifier correction emits release metadata even without Pose', () => {
  const state = new TrackingState();
  const first = state.update({ time: 0, hands: hands(hand('Left', 0.65)) });
  let corrected;
  for (const time of [0.1, 0.3, 0.61]) corrected = state.update({ time, hands: hands(hand('Right', 0.65)) });
  assert.deepEqual(corrected.hands.trackingIds, ['Right']);
  assert.deepEqual(corrected.hands.releasedSides, ['left']);
  assert.deepEqual(corrected.hands.physicalTrackingIds, first.hands.physicalTrackingIds);
});

test('Pose can correct two mistaken initial assignments atomically without sharing a track', () => {
  const state = new TrackingState();
  const initial = state.update({ time: 0, hands: hands(hand('Left', 0.3), hand('Right', 0.7)) });
  const corrected = state.update({ time: 0.1, pose: pose([0.7, 0.3], [0.3, 0.3]), hands: hands(hand('Left', 0.3), hand('Right', 0.7)) });
  assert.deepEqual(corrected.hands.releasedSides.sort(), ['left', 'right']);
  assert.deepEqual(corrected.hands.physicalTrackingIds, [...initial.hands.physicalTrackingIds].reverse());
  assert.equal(corrected.hands.landmarks[0][0].x, 0.7);
  assert.equal(corrected.hands.landmarks[1][0].x, 0.3);
  assert.notEqual(state.tracks.Left, state.tracks.Right);
});
