import test from 'node:test';
import assert from 'node:assert/strict';
import { Object3D, Vector3 } from 'three';
import { BodyRetargeter, solveBody } from '../docs/fullbody/body.js';
import { TrackingState } from '../docs/fullbody/tracking-state.js';

const position = bone => bone.getWorldPosition(new Vector3());

// These rigs intentionally omit optional finger/eye joints. Wrist placement
// must remain independent of the availability of articulation bones.
function rigFixture() {
  const scene = new Object3D();
  const bones = {};
  const add = (name, parent, x, y, z = 0) => {
    const bone = new Object3D();
    bone.position.set(x, y, z);
    (bones[parent] ?? scene).add(bone);
    bones[name] = bone;
  };
  add('hips', null, 0, 1);
  add('spine', 'hips', 0, 0.2);
  add('chest', 'spine', 0, 0.3);
  add('head', 'chest', 0, 0.24);
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    add(`${side}UpperArm`, 'chest', sign * 0.2, 0);
    add(`${side}LowerArm`, `${side}UpperArm`, sign * 0.3, 0);
    add(`${side}Hand`, `${side}LowerArm`, sign * 0.3, 0);
  }
  scene.updateWorldMatrix(true, true);
  return { bones, rig: new BodyRetargeter(bones) };
}

test('uncertain monocular wrist depth cannot pull a reachable observed image position away from the face', () => {
  const wrists = [];
  for (const depthRatio of [-1.5, 0, 1.5]) {
    const { bones, rig } = rigFixture();
    const solution = solveBody(null, null);
    solution.armTargets.left = {
      aspect: 1,
      shoulders: { x: 0.5, y: 0.565, span: 0.4, foreshorten: 1 },
      wrist: { x: 0.8, y: 0.28 },
      depthRatio,
    };
    rig.update(solution, 1, 1, 1, { bodySmoothing: 0.001 });
    const wrist = position(bones.leftHand);
    wrists.push(wrist);
    assert.ok(Math.abs(wrist.x - 0.3) < 1e-5, `wrist x was pulled by inferred depth: ${wrist.x}`);
    assert.ok(Math.abs(wrist.y - 1.785) < 1e-5, `raised wrist y was pulled by inferred depth: ${wrist.y}`);
    assert.ok(Math.abs(position(bones.leftUpperArm).distanceTo(position(bones.leftLowerArm)) - 0.3) < 1e-7);
    assert.ok(Math.abs(position(bones.leftLowerArm).distanceTo(wrist) - 0.3) < 1e-7);
  }
  assert.ok(wrists[0].z < wrists[1].z && wrists[1].z < wrists[2].z,
    'depth still changes within the arm reach instead of discarding all depth observations');
});

test('hands-only tracking still places both wrists when the VRM has no optional finger bones', () => {
  const { bones, rig } = rigFixture();
  const solution = solveBody(null, null);
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    solution.armTargets[side] = {
      aspect: 1,
      shoulders: { x: 0.5, y: 0.565, span: 0.4 },
      wrist: { x: 0.5 + sign * 0.22, y: 0.28 },
    };
  }
  assert.doesNotThrow(() => rig.update(solution, 1, 1, 1, { bodySmoothing: 0.001 }));
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    const actual = position(bones[`${side}Hand`]);
    assert.ok(actual.distanceTo(new Vector3(sign * 0.22, 1.785, 0.048)) < 1e-5);
  }
});

const observedHand = (label, x = 0.65, score = 0.99) => ({
  landmarks: [Array.from({ length: 21 }, (_, index) => ({ x: x + index * 0.001, y: 0.3, z: 0 }))],
  worldLandmarks: [Array.from({ length: 21 }, (_, index) => ({ x: index * 0.001, y: 0.01, z: 0 }))],
  handedness: [[{ categoryName: label, score }]],
});

test('a mistaken initial hand label recovers after sustained high-confidence evidence without restarting the camera', () => {
  const state = new TrackingState();
  assert.deepEqual(state.update({ time: 0, hands: observedHand('Left') }).hands.trackingIds, ['Left']);
  // A short classifier fluctuation does not swap the animated arm.
  for (const time of [0.1, 0.2, 0.3, 0.4]) {
    assert.deepEqual(state.update({ time, hands: observedHand('Right') }).hands.trackingIds, ['Left']);
  }
  const corrected = state.update({ time: 0.65, hands: observedHand('Right') });
  assert.deepEqual(corrected.hands.trackingIds, ['Right']);
  assert.equal(corrected.hands.landmarks[0][0].x, 0.65);
  assert.equal(state.tracks.Left.wrist, null);
  assert.deepEqual(state.update({ time: 0.75, hands: observedHand('Right') }).hands.trackingIds, ['Right']);
});

test('identity correction needs three confident observations and an unbroken contradiction', () => {
  const state = new TrackingState();
  state.update({ time: 0, hands: observedHand('Left') });
  state.update({ time: 0.2, hands: observedHand('Right') });
  const onlyTwo = state.update({ time: 0.75, hands: observedHand('Right') });
  assert.deepEqual(onlyTwo.hands.trackingIds, ['Left']);
  state.update({ time: 0.8, hands: observedHand('Right', 0.65, 0.6) });
  state.update({ time: 0.9, hands: observedHand('Right') });
  state.update({ time: 1.0, hands: observedHand('Right') });
  assert.deepEqual(state.update({ time: 1.1, hands: observedHand('Right') }).hands.trackingIds, ['Left']);
  state.update({ time: 1.2, hands: null });
  state.update({ time: 1.3, hands: observedHand('Right') });
  state.update({ time: 1.4, hands: observedHand('Right') });
  assert.deepEqual(state.update({ time: 1.5, hands: observedHand('Right') }).hands.trackingIds, ['Left']);
  assert.deepEqual(state.update({ time: 1.85, hands: observedHand('Right') }).hands.trackingIds, ['Right']);
});

test('a classifier contradiction cannot take over a recently observed opposite hand during occlusion', () => {
  const state = new TrackingState();
  const left = observedHand('Left', 0.7);
  const right = observedHand('Right', 0.3);
  state.update({ time: 0, hands: {
    landmarks: [...left.landmarks, ...right.landmarks],
    worldLandmarks: [...left.worldLandmarks, ...right.worldLandmarks],
    handedness: [...left.handedness, ...right.handedness],
  } });
  for (const time of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
    assert.deepEqual(state.update({ time, hands: observedHand('Right', 0.7) }).hands.trackingIds, ['Left']);
  }
});
