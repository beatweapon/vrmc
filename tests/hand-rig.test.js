import test from 'node:test';
import assert from 'node:assert/strict';
import { Object3D, Quaternion, Vector3 } from 'three';
import { HandRetargeter, HAND_FINGERS, measureHand } from '../docs/fullbody/hand-rig.js';

const near = (actual, expected, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const nearVector = (actual, expected, tolerance = 1e-5) => assert.ok(actual.distanceTo(expected) < tolerance, `${actual.toArray()} != ${expected.toArray()}`);
const nearQuaternion = (actual, expected, tolerance = 1e-5) => assert.ok(actual.angleTo(expected) < tolerance, `angle ${actual.angleTo(expected)}`);
const toLandmark = value => ({ x: value.x, y: -value.y, z: -value.z });
const toVector = value => new Vector3(value.x, -value.y, -value.z);

function handPoints(side = 'right', pose = {}) {
  const points = Array.from({ length: 21 }, () => new Vector3());
  const ventral = side === 'right' ? 1 : -1;
  const baseXs = { Index: 0.027, Middle: 0.008, Ring: -0.011, Little: -0.029 };
  // Middle MCP is centered relative to the wrist, defining the forward axis.
  points[0].x = baseXs.Middle;
  for (const [finger, { indices }] of Object.entries(HAND_FINGERS)) {
    if (finger === 'Thumb') {
      points[1].set(0.034, 0.027, 0);
      const directions = pose.Thumb ?? [[0.8, 0.6, 0], [0.72, 0.68, 0], [0.68, 0.73, 0]];
      for (let joint = 0; joint < 3; joint++) {
        points[indices[joint + 1]].copy(points[indices[joint]])
          .addScaledVector(new Vector3(...directions[joint]).normalize(), [0.032, 0.025, 0.022][joint]);
      }
      continue;
    }
    points[indices[0]].set(baseXs[finger], 0.065, 0);
    const { curl = [0, 0, 0], splay = 0 } = pose[finger] ?? {};
    let total = 0;
    for (let joint = 0; joint < 3; joint++) {
      total += curl[joint];
      const direction = new Vector3(Math.sin(splay) * Math.cos(total), Math.cos(splay) * Math.cos(total), ventral * Math.sin(total));
      points[indices[joint + 1]].copy(points[indices[joint]])
        .addScaledVector(direction, [0.036, 0.024, 0.018][joint] * (finger === 'Little' ? 0.8 : 1));
    }
  }
  return points.map(toLandmark);
}

function createRig(side = 'right', arbitraryAxes = false, omitted = []) {
  const root = new Object3D();
  root.quaternion.setFromAxisAngle(new Vector3(0.4, 0.7, 0.3).normalize(), 0.7);
  root.updateWorldMatrix(true, true);
  const bones = {};
  const points = handPoints(side).map(toVector);
  let count = 0;
  function add(name, parent, location) {
    const node = new Object3D();
    parent.add(node);
    parent.updateWorldMatrix(true, false);
    const desiredPosition = location.clone().applyQuaternion(root.quaternion);
    node.position.copy(parent.worldToLocal(desiredPosition));
    const world = arbitraryAxes
      ? new Quaternion().setFromAxisAngle(new Vector3(1 + count % 3, 2 - count % 2, 0.5).normalize(), ++count * 0.23)
      : root.quaternion.clone();
    node.quaternion.copy(parent.getWorldQuaternion(new Quaternion()).invert().multiply(world));
    node.updateWorldMatrix(true, true);
    bones[name] = node;
    return node;
  }
  const hand = add(`${side}Hand`, root, points[0]);
  for (const [finger, { indices, joints }] of Object.entries(HAND_FINGERS)) {
    let parent = hand;
    for (let index = 0; index < 3; index++) {
      const name = `${side}${finger}${joints[index]}`;
      if (omitted.includes(name)) continue;
      parent = add(name, parent, points[indices[index]]);
    }
    add(`${side}${finger}Tip`, parent, points[indices[3]]);
  }
  root.updateWorldMatrix(true, true);
  const rig = new HandRetargeter(bones);
  return { bones, root, rig };
}

function applyResult(bones, side, solved) {
  const wrist = bones[`${side}Hand`];
  wrist.quaternion.copy(wrist.parent.getWorldQuaternion(new Quaternion()).invert().multiply(solved.wristWorld));
  for (const [name, value] of solved.rotations) bones[name].quaternion.copy(value);
  wrist.updateWorldMatrix(true, true);
}

function directionOf(bones, from, to) {
  return bones[to].getWorldPosition(new Vector3()).sub(bones[from].getWorldPosition(new Vector3())).normalize();
}

test('open, fist, and V sign retain independent joint flexion and finger spread', () => {
  for (const side of ['left', 'right']) {
    const open = measureHand(handPoints(side), side);
    for (const finger of ['Index', 'Middle', 'Ring', 'Little']) {
      open.fingers[finger].curl.forEach(angle => near(angle, 0));
      near(open.fingers[finger].splay, 0);
    }
    const gesture = {
      Index: { curl: [0.12, 0.02, 0.01], splay: 0.25 },
      Middle: { curl: [0.1, 0.04, 0.02], splay: -0.2 },
      Ring: { curl: [1.05, 1.65, 1.1] },
      Little: { curl: [1.2, 1.75, 1.15] },
    };
    const measured = measureHand(handPoints(side, gesture), side);
    for (const [finger, values] of Object.entries(gesture)) {
      values.curl.forEach((angle, joint) => near(measured.fingers[finger].curl[joint], angle));
      near(measured.fingers[finger].splay, values.splay ?? 0);
    }
  }
});

test('rigid hand rotation affects wrist only, including a 180 degree turn', () => {
  const gesture = {
    Index: { curl: [0.4, 0.9, 0.65], splay: 0.15 },
    Little: { curl: [0.85, 1.2, 0.9], splay: -0.1 },
    Thumb: [[0.65, 0.6, 0.45], [0.25, 0.8, 0.6], [-0.15, 0.75, 0.65]],
  };
  for (const side of ['left', 'right']) {
    const { rig } = createRig(side, true);
    const landmarks = handPoints(side, gesture);
    const original = measureHand(landmarks, side);
    const before = rig.solve(original);
    for (const angle of [0.7, Math.PI]) {
      const rotation = new Quaternion().setFromAxisAngle(new Vector3(0.5, 0.8, 0.3).normalize(), angle);
      const rotated = landmarks.map(value => toLandmark(toVector(value).applyQuaternion(rotation).add(new Vector3(2, 3, 4))));
      const measured = measureHand(rotated, side);
      const solved = rig.solve(measured);
      nearQuaternion(measured.palm, rotation.clone().multiply(original.palm));
      nearQuaternion(solved.wristWorld, rotation.clone().multiply(before.wristWorld));
      assert.equal(solved.rotations.size, 15);
      for (const [name, quaternion] of before.rotations) nearQuaternion(solved.rotations.get(name), quaternion);
    }
  }
});

test('arbitrary bind axes reproduce observed finger segment directions after wrist and arm rotation', () => {
  const gesture = {
    Index: { curl: [0.25, 0.1, 0.2], splay: 0.25 },
    Middle: { curl: [0.7, 1.5, 0.9], splay: -0.1 },
    Ring: { curl: [0.9, 1.7, 0.95] },
    Little: { curl: [1.2, 1.8, 1.3], splay: -0.3 },
    Thumb: [[0.65, 0.6, 0.45], [0.25, 0.8, 0.6], [-0.15, 0.75, 0.65]],
  };
  for (const side of ['left', 'right']) {
    const { rig, bones, root } = createRig(side, true);
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0.5, 0.8, 0.3).normalize(), 1.7);
    const landmarks = handPoints(side, gesture).map(value => toLandmark(toVector(value).applyQuaternion(rotation)));
    const solution = rig.solve(measureHand(landmarks, side));
    // The rest capture remains valid after the upper-body parent has moved.
    root.quaternion.setFromAxisAngle(new Vector3(1, 1, 0).normalize(), -1.1);
    root.updateWorldMatrix(true, true);
    applyResult(bones, side, solution);
    for (const [finger, { indices, joints }] of Object.entries(HAND_FINGERS)) {
      for (let joint = 0; joint < 3; joint++) {
        const from = `${side}${finger}${joints[joint]}`;
        const to = `${side}${finger}${joints[joint + 1] ?? 'Tip'}`;
        const expected = toVector(landmarks[indices[joint + 1]]).sub(toVector(landmarks[indices[joint]])).normalize();
        nearVector(directionOf(bones, from, to), expected);
      }
    }
  }
});

test('stationary hand yields identical local targets despite animated parent feedback', () => {
  const { rig, bones } = createRig('right', true);
  const measurement = measureHand(handPoints('right', { Index: { curl: [0.5, 1, 0.8] } }), 'right');
  const expected = rig.solve(measurement);
  for (let frame = 0; frame < 100; frame++) {
    bones.rightHand.rotation.set(frame * 0.21, frame * -0.4, frame * 0.31);
    bones.rightIndexProximal.rotation.set(frame * 0.7, frame * 0.5, frame * -0.8);
    bones.rightHand.updateWorldMatrix(true, true);
    const actual = rig.solve(measurement);
    nearQuaternion(actual.wristWorld, expected.wristWorld);
    for (const [name, quaternion] of expected.rotations) nearQuaternion(actual.rotations.get(name), quaternion);
  }
});

test('pinching thumb retains opposition and individual MCP/IP motion', () => {
  const { rig, bones } = createRig('right', true);
  const neutral = rig.solve(measureHand(handPoints(), 'right'));
  const pose = handPoints('right', {
    Index: { curl: [0.65, 0.5, 0.35] },
    Thumb: [[0.45, 0.8, 0.4], [-0.2, 0.8, 0.56], [-0.6, 0.65, 0.45]],
  });
  const pinched = rig.solve(measureHand(pose, 'right'));
  for (const joint of ['Metacarpal', 'Proximal', 'Distal']) {
    assert.ok(neutral.rotations.get(`rightThumb${joint}`).angleTo(pinched.rotations.get(`rightThumb${joint}`)) > 0.1);
  }
  applyResult(bones, 'right', pinched);
  const actual = directionOf(bones, 'rightThumbDistal', 'rightThumbTip');
  const expected = toVector(pose[4]).sub(toVector(pose[3])).normalize();
  nearVector(actual, expected);
});

test('anatomical mirror changes palm frame while retaining long-finger bend amounts', () => {
  const pose = handPoints('right', { Index: { curl: [0.8, 1.1, 0.7], splay: 0.2 } });
  const mirrored = pose.map(value => ({ ...value, x: -value.x }));
  const right = measureHand(pose, 'right');
  const left = measureHand(mirrored, 'left');
  right.fingers.Index.curl.forEach((angle, index) => near(left.fingers.Index.curl[index], angle));
  near(left.fingers.Index.splay, right.fingers.Index.splay);
  assert.ok(left.palm.angleTo(right.palm) > 3);
});

test('fully bent MCP does not turn depth noise into alternating wide finger spread', () => {
  const left = handPoints('left', { Index: { curl: [Math.PI / 2, 1.2, 0.8] } });
  const a = structuredClone(left);
  const b = structuredClone(left);
  a[6].x += 0.0001;
  b[6].x -= 0.0001;
  near(measureHand(a, 'left').fingers.Index.splay, 0);
  near(measureHand(b, 'left').fingers.Index.splay, 0);
});

test('degenerate/missing observations and partial VRM finger rigs fail without NaN', () => {
  assert.equal(measureHand(null, 'left'), null);
  assert.equal(measureHand(handPoints(), 'unknown'), null);
  assert.equal(measureHand(Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 })), 'left'), null);
  const invalid = handPoints();
  invalid[7].x = NaN;
  const measured = measureHand(invalid, 'right');
  assert.equal(measured.fingers.Index, undefined);
  assert.ok(measured.fingers.Middle);
  const { rig } = createRig('right', true, ['rightIndexIntermediate', 'rightLittleDistal']);
  assert.equal(rig.availableFingers.right.Index, 2);
  assert.equal(rig.availableFingers.right.Little, 2);
  const solved = rig.solve(measureHand(handPoints('right', { Index: { curl: [0.5, 0.8, 0.6] } }), 'right'));
  assert.equal(solved.rotations.size, 13);
  for (const value of solved.rotations.values()) {
    assert.ok(value.toArray().every(Number.isFinite));
    near(value.length(), 1);
  }
  assert.equal(rig.solve(null).wristWorld, null);
  assert.equal(new HandRetargeter({}).solve(measured).rotations.size, 0);
});
