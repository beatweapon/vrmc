import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackingState } from '../docs/fullbody/tracking-state.js';

const point = (x, y = 0.5, z = 0) => ({ x, y, z, visibility: 0.92, presence: 0.97 });
const pose = (x, y = 0.5, z = 0) => ({
  landmarks: [[point(x, y, z)]], worldLandmarks: [[point(x, y, z)]], imageWidth: 1280, imageHeight: 720,
});
const hand = (x, label = 'Left', y = 0.3) => ({
  points: Array.from({ length: 21 }, (_, i) => point(x + (i % 4) * 0.01, y - i * 0.004)),
  world: Array.from({ length: 21 }, (_, i) => point((i % 4) * 0.01, -i * 0.005, i * 0.001)),
  label,
});
const hands = (...observations) => ({
  landmarks: observations.map(h => h.points), worldLandmarks: observations.map(h => h.world),
  handedness: observations.map(h => [{ categoryName: h.label, score: 0.98 }]),
});
const wristBySide = (frame, side) => frame.hands.landmarks[frame.hands.trackingIds.indexOf(side)]?.[0];
const rms = values => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);

test('stationary pose and hand landmark noise is attenuated before retargeting', () => {
  const state = new TrackingState();
  const raw = [], filtered = [], filteredHands = [];
  for (let i = 0; i < 120; i++) {
    const noise = 0.008 * Math.sin(i * 2.4) + 0.003 * Math.cos(i * 1.7);
    const frame = state.update({ time: i / 30, pose: pose(0.5 + noise), hands: hands(hand(0.5 + noise)) }, i / 30 + 0.04);
    if (i > 20) {
      raw.push(noise);
      filtered.push(frame.pose.landmarks[0][0].x - 0.5);
      filteredHands.push(wristBySide(frame, 'Left').x - 0.5);
    }
  }
  assert.ok(rms(filtered) < rms(raw) * 0.3, `pose jitter ratio ${rms(filtered) / rms(raw)}`);
  assert.ok(rms(filteredHands) < rms(raw) * 0.3, `wrist jitter ratio ${rms(filteredHands) / rms(raw)}`);
});

test('adaptive cutoff follows intentional motion with less than 80 ms positional lag', () => {
  const state = new TrackingState();
  for (let i = 0; i < 30; i++) state.update({ time: i / 30, pose: pose(0.2) });
  for (let i = 1; i <= 15; i++) {
    const desired = 0.2 + i / 30;
    const frame = state.update({ time: 1 + i / 30, pose: pose(desired) });
    assert.ok(desired - frame.pose.landmarks[0][0].x < 0.08);
    assert.ok(frame.pose.landmarks[0][0].x <= desired);
  }
});

test('result ordering does not change hand identity or mix different finger shapes', () => {
  const state = new TrackingState();
  const left = hand(0.7, 'Left'), right = hand(0.3, 'Right');
  left.world[8].z = 0.045;
  state.update({ time: 0, hands: hands(left, right) });
  const frame = state.update({ time: 1 / 30, hands: hands(right, left) });
  assert.deepEqual(frame.hands.trackingIds, ['Left', 'Right']);
  assert.equal(wristBySide(frame, 'Left').x, 0.7);
  assert.equal(wristBySide(frame, 'Right').x, 0.3);
  assert.equal(frame.hands.worldLandmarks[0][8].z, 0.045);
  assert.equal(frame.hands.worldLandmarks[1][8].z, right.world[8].z);
});

test('a temporary handedness classifier flip does not move a raised hand to the other arm', () => {
  const state = new TrackingState();
  state.update({ time: 0, hands: hands(hand(0.72, 'Left')) });
  const jitter = state.update({ time: 1 / 30, hands: hands(hand(0.721, 'Right')) });
  assert.deepEqual(jitter.hands.trackingIds, ['Left']);
  assert.equal(jitter.hands.handedness[0][0].categoryName, 'Left');
  const recovered = state.update({ time: 2 / 30, hands: hands(hand(0.72, 'Left')) });
  assert.deepEqual(recovered.hands.trackingIds, ['Left']);
});

test('crossing hand trajectories retain identity through array reordering and a label flip', () => {
  const state = new TrackingState();
  let frame;
  for (let i = 0; i <= 12; i++) {
    const left = hand(0.74 - i * 0.04, i === 6 || i === 7 ? 'Right' : 'Left', 0.3);
    const right = hand(0.26 + i * 0.04, i === 6 || i === 7 ? 'Left' : 'Right', 0.35);
    frame = state.update({ time: i / 30, hands: i % 2 ? hands(right, left) : hands(left, right) });
    assert.deepEqual(frame.hands.trackingIds, ['Left', 'Right']);
    assert.ok(Math.abs(wristBySide(frame, 'Left').y - 0.3) < 0.015, `Left identity lost at ${i}`);
    assert.ok(Math.abs(wristBySide(frame, 'Right').y - 0.35) < 0.015, `Right identity lost at ${i}`);
  }
  assert.ok(wristBySide(frame, 'Left').x < wristBySide(frame, 'Right').x);
});

test('freshly received slow inference is not classified as lost tracking', () => {
  const face = { faceLandmarks: [[point(0.5)]], faceBlendshapes: [{ categories: [] }], facialTransformationMatrixes: [{ data: [1, 0, 0] }] };
  const state = new TrackingState();
  const frame = state.update({ time: 10, face, pose: pose(0.5), hands: hands(hand(0.6)) }, 10.85);
  assert.equal(frame.time, 10.85);
  assert.equal(frame.captureTime, 10);
  assert.equal(frame.sampleTime, 10);
  assert.equal(Math.round(frame.latencyMs), 850);
  assert.equal(frame.face, face);
  assert.deepEqual(frame.hands.observedAt, [10.85]);
  assert.equal(frame.pose.imageWidth, 1280);
});

test('capture deltas drive smoothing independently of variable inference latency', () => {
  const stable = new TrackingState(), variable = new TrackingState();
  for (let i = 0; i < 30; i++) {
    const input = { time: i / 10, pose: pose(0.5 + 0.03 * Math.sin(i)) };
    const first = stable.update(input, i / 10 + 0.05);
    const second = variable.update(input, i / 10 + 0.5 + (i % 3) / 20);
    assert.deepEqual(first.pose, second.pose);
  }
});

test('slow sequential inference does not expire a hand that is continuously observed', () => {
  const state = new TrackingState();
  state.update({ time: 0, hands: hands(hand(0.7, 'Left')) }, 0.9);
  const frame = state.update({ time: 1, hands: hands(hand(0.701, 'Right')) }, 1.9);
  assert.deepEqual(frame.hands.trackingIds, ['Left']);
  assert.equal(frame.time, 1.9);
});

test('duplicate and out-of-order captures do not advance filtering, sequence or freshness', () => {
  const state = new TrackingState();
  state.update({ time: 1, pose: pose(0.5) }, 1.2);
  const frame = state.update({ time: 1.03, pose: pose(0.51) }, 1.23);
  assert.equal(state.update({ time: 1.03, pose: pose(0.9) }, 1.4), frame);
  assert.equal(state.update({ time: 1, pose: pose(0.1) }, 1.6), frame);
  assert.equal(frame.sequence, 2);
  assert.equal(frame.time, 1.23);
});

test('single-frame landmark teleport is rejected and sustained relocation is reacquired', () => {
  const state = new TrackingState();
  state.update({ time: 0, pose: pose(0.2) });
  const spike = state.update({ time: 1 / 30, pose: pose(0.95) });
  assert.equal(spike.pose.landmarks[0][0].x, 0.2);
  const recovered = state.update({ time: 2 / 30, pose: pose(0.2) });
  assert.equal(recovered.pose.landmarks[0][0].x, 0.2);
  state.update({ time: 3 / 30, pose: pose(0.95) });
  const moved = state.update({ time: 4 / 30, pose: pose(0.95) });
  assert.ok(moved.pose.landmarks[0][0].x > 0.7);
});

test('a wrist position spike does not teleport the hand or assign it to a new arm', () => {
  const state = new TrackingState();
  state.update({ time: 0, hands: hands(hand(0.2, 'Left')) });
  const spike = state.update({ time: 1 / 30, hands: hands(hand(0.95, 'Left')) });
  assert.deepEqual(spike.hands.trackingIds, ['Left']);
  assert.equal(wristBySide(spike, 'Left').x, 0.2);
  const recovered = state.update({ time: 2 / 30, hands: hands(hand(0.2, 'Left')) });
  assert.equal(wristBySide(recovered, 'Left').x, 0.2);
});

test('absent hands are absent immediately while short occlusion preserves identity', () => {
  const state = new TrackingState();
  state.update({ time: 0, hands: hands(hand(0.7, 'Left')) });
  assert.equal(state.update({ time: 0.1, hands: hands() }).hands.landmarks.length, 0);
  const briefReturn = state.update({ time: 0.2, hands: hands(hand(0.7, 'Right')) });
  assert.deepEqual(briefReturn.hands.trackingIds, ['Left']);
  assert.equal(state.update({ time: 0.4 }).hands, null);
  const longReturn = state.update({ time: 1.2, hands: hands(hand(0.3, 'Right')) });
  assert.deepEqual(longReturn.hands.trackingIds, ['Right']);
  assert.equal(wristBySide(longReturn, 'Right').x, 0.3);
});

test('invalid coordinates cannot poison filter history, and confidence fields are preserved', () => {
  const state = new TrackingState();
  state.update({ time: 0, pose: pose(0.5) });
  const invalidHand = hand(0.7);
  invalidHand.points[8].z = NaN;
  const invalid = state.update({ time: 1 / 30, pose: pose(NaN), hands: hands(invalidHand) });
  assert.equal(invalid.pose.landmarks[0][0].visibility, 0);
  assert.equal(invalid.pose.landmarks[0][0].presence, 0);
  assert.ok(Number.isFinite(invalid.pose.landmarks[0][0].x));
  assert.equal(invalid.hands.landmarks.length, 0);
  const recovered = state.update({ time: 2 / 30, pose: pose(0.5) });
  assert.equal(recovered.pose.landmarks[0][0].x, 0.5);
  assert.equal(recovered.pose.landmarks[0][0].visibility, 0.92);
  assert.equal(recovered.pose.landmarks[0][0].presence, 0.97);
});

test('filtering finger articulation separately from translation preserves hand shape in motion', () => {
  const state = new TrackingState();
  for (let i = 0; i < 20; i++) {
    const observation = hand(0.2 + i * 0.02);
    for (const p of observation.world) p.x += i * 0.03;
    const frame = state.update({ time: i / 30, hands: hands(observation) });
    for (const space of ['landmarks', 'worldLandmarks']) {
      const output = frame.hands[space][0];
      const source = space === 'landmarks' ? observation.points : observation.world;
      for (let joint = 1; joint < 21; joint++) {
        assert.ok(Math.abs((output[joint].x - output[0].x) - (source[joint].x - source[0].x)) < 1e-8);
      }
    }
  }
});

test('camera restart resets identity, capture monotonicity and old positions', () => {
  const state = new TrackingState();
  state.update({ time: 20, pose: pose(0.2), hands: hands(hand(0.7, 'Left')) });
  state.reset();
  const restarted = state.update({ time: 0, pose: pose(0.8), hands: hands(hand(0.7, 'Right')) });
  assert.equal(restarted.sequence, 1);
  assert.equal(restarted.pose.landmarks[0][0].x, 0.8);
  assert.deepEqual(restarted.hands.trackingIds, ['Right']);
});
