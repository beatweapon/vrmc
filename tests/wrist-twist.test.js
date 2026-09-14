import test from 'node:test';
import assert from 'node:assert/strict';
import { Object3D, Quaternion, Vector3 } from 'three';
import { BodyRetargeter, solveBody } from '../docs/fullbody/body.js';
import { constrainWristRotation, WRIST_LIMITS } from '../docs/fullbody/hand-rig.js';

const rad = degrees => degrees * Math.PI / 180;
const position = bone => bone.getWorldPosition(new Vector3());
const world = bone => bone.getWorldQuaternion(new Quaternion());
const nearRotation = (actual, expected, tolerance = 1e-5) => assert.ok(actual.angleTo(expected) < tolerance, `rotation error ${actual.angleTo(expected)}`);

function fixture(arbitraryAxes = false) {
  const root = new Object3D();
  if (arbitraryAxes) root.quaternion.setFromAxisAngle(new Vector3(.3, .5, .2).normalize(), .5);
  root.updateWorldMatrix(true, true);
  const bones = {};
  let count = 0;
  const add = (name, parentName, location) => {
    const parent = bones[parentName] ?? root;
    const bone = new Object3D();
    parent.add(bone);
    bone.position.copy(parent.worldToLocal(new Vector3(...location).applyQuaternion(root.quaternion)));
    const desiredWorld = arbitraryAxes ? new Quaternion().setFromAxisAngle(new Vector3(.4, 1, .3).normalize(), ++count * .19) : new Quaternion();
    bone.quaternion.copy(world(parent).invert().multiply(desiredWorld));
    bone.updateWorldMatrix(true, true);
    bones[name] = bone;
  };
  add('hips', null, [0, 1, 0]);
  add('spine', 'hips', [0, 1.2, 0]);
  add('chest', 'spine', [0, 1.5, 0]);
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    add(`${side}UpperArm`, 'chest', [sign * .2, 1.5, 0]);
    add(`${side}LowerArm`, `${side}UpperArm`, [sign * .5, 1.5, 0]);
    add(`${side}Hand`, `${side}LowerArm`, [sign * .8, 1.5, 0]);
    for (const [finger, z] of [['Index', .035], ['Middle', 0], ['Little', -.035]]) {
      for (const [joint, x, parent] of [
        ['Proximal', .87, `${side}Hand`],
        ['Intermediate', .90, `${side}${finger}Proximal`],
        ['Distal', .925, `${side}${finger}Intermediate`],
      ]) add(`${side}${finger}${joint}`, parent, [sign * x, 1.5, z]);
    }
  }
  return { root, bones, rig: new BodyRetargeter(bones) };
}

function observation(rig, side, desiredWrist) {
  const solution = solveBody(null, null);
  solution.hips = new Quaternion();
  solution.torso = new Quaternion();
  for (const name of ['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm']) solution.directions[name] = rig.rest[name].direction.clone();
  const bind = rig.handRig.hands[side];
  solution.hands[side] = {
    side,
    palm: desiredWrist.clone().multiply(bind.wristWorld.clone().invert()).multiply(bind.palmInverse.clone().invert()),
    fingers: {
      Index: { curl: [0, 0, 0], splay: .12 },
      Middle: { curl: [.7, 1.1, .6], splay: 0 },
      Little: { curl: [1, 1.4, .8], splay: -.08 },
    },
  };
  return solution;
}

function wristAngles(rig, side) {
  const wrist = rig.bones[`${side}Hand`];
  const lower = rig.bones[`${side}LowerArm`];
  const rest = rig.rest[`${side}Hand`];
  const neutralWorld = world(wrist.parent).multiply(rest.local);
  const axis = position(wrist).sub(position(lower)).normalize().applyQuaternion(neutralWorld.invert());
  const relative = rest.local.clone().invert().multiply(wrist.quaternion);
  const projection = relative.x * axis.x + relative.y * axis.y + relative.z * axis.z;
  const angle = 2 * Math.atan2(projection, relative.w);
  const twist = Math.atan2(Math.sin(angle), Math.cos(angle));
  const swing = relative.clone().multiply(new Quaternion().setFromAxisAngle(axis, -twist));
  return { twist, swing: new Quaternion().angleTo(swing) };
}

function assertWristBounded(rig, side) {
  const angles = wristAngles(rig, side);
  assert.ok(Math.abs(angles.twist) <= WRIST_LIMITS.wristTwist + 1e-6, `wrist twist ${angles.twist}`);
  assert.ok(angles.swing <= WRIST_LIMITS.swing + 1e-6, `wrist swing ${angles.swing}`);
}

test('ordinary palm roll moves the forearm while preserving the world palm, finger shape, and wrist position', () => {
  for (const arbitraryAxes of [false, true]) for (const side of ['left', 'right']) {
    const { bones, rig } = fixture(arbitraryAxes);
    const name = `${side}Hand`;
    const axis = rig.rest[`${side}LowerArm`].direction;
    const desired = new Quaternion().setFromAxisAngle(axis, rad(90)).multiply(rig.rest[name].world);
    const solution = observation(rig, side, desired);
    const fingerTargets = rig.handRig.solve(solution.hands[side]).rotations;
    const expectedPosition = position(bones[name]);
    rig.update(solution, 1, 1, 1, { bodySmoothing: .001 });
    nearRotation(world(bones[name]), desired);
    assert.ok(position(bones[name]).distanceTo(expectedPosition) < 1e-7);
    const forearmRotation = world(bones[`${side}LowerArm`]).angleTo(rig.rest[`${side}LowerArm`].world);
    assert.ok(forearmRotation > rad(65) && forearmRotation < rad(90), 'roll must be shared with the forearm');
    assertWristBounded(rig, side);
    for (const [name, expected] of fingerTargets) nearRotation(bones[name].quaternion, expected);
  }
});

test('180-degree boundary jitter and quaternion sign flips cannot reverse a saturated wrist', () => {
  for (const side of ['left', 'right']) {
    const { bones, rig } = fixture(true);
    const name = `${side}Hand`;
    const axis = rig.rest[`${side}LowerArm`].direction;
    let previous = null;
    for (let index = 0; index < 90; index++) {
      const angle = index < 30 ? index * 6 : 180 + (index % 2 ? 1 : -1);
      const desired = new Quaternion().setFromAxisAngle(axis, rad(angle)).multiply(rig.rest[name].world);
      if (index % 2) desired.fromArray(desired.toArray().map(value => -value));
      rig.update(observation(rig, side, desired), 1 + index / 30, 1 + index / 30, 1 / 30, { bodySmoothing: .08 });
      assertWristBounded(rig, side);
      const forearm = world(bones[`${side}LowerArm`]);
      assert.ok(forearm.angleTo(rig.rest[`${side}LowerArm`].world) <= WRIST_LIMITS.forearmTwist + 1e-6);
      if (index > 35) assert.ok(forearm.angleTo(previous) < .02, 'boundary jitter must not unwind the forearm');
      previous = forearm;
    }
    assert.ok(world(bones[`${side}LowerArm`]).angleTo(rig.rest[`${side}LowerArm`].world) > rad(99));
  }
});

test('held targets do not accumulate distributed forearm roll and tracking loss returns it to neutral', () => {
  const { bones, rig } = fixture();
  const desired = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), rad(120));
  const solution = observation(rig, 'left', desired);
  rig.update(solution, 1, 1, 1, { bodySmoothing: .001 });
  const expected = world(bones.leftHand);
  const expectedLower = world(bones.leftLowerArm);
  for (let index = 1; index < 240; index++) {
    const time = 1 + index / 60;
    rig.update(solution, time, time, 1 / 60, { bodySmoothing: .08 });
    nearRotation(world(bones.leftHand), expected);
    nearRotation(world(bones.leftLowerArm), expectedLower);
    assertWristBounded(rig, 'left');
  }
  const noHand = observation(rig, 'left', desired);
  noHand.hands = {};
  for (let index = 0; index < 360; index++) rig.update(noHand, 5 + index / 60, 5 + index / 60, 1 / 60);
  nearRotation(bones.leftHand.quaternion, rig.rest.leftHand.local, .0001);
  nearRotation(world(bones.leftLowerArm), rig.rest.leftLowerArm.world, .0001);
  rig.releaseArm('left', 12);
  assert.equal(rig.wristRotations.has('left'), false, 'side reassignment and mirror switching clear the wrist history');
});

test('extreme palm swing remains finite and bounded even during smoothing and an antipodal observation', () => {
  const { rig } = fixture();
  for (let index = 0; index < 90; index++) {
    const desired = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), rad(index % 2 ? 179.999 : 180.001))
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), rad(200)));
    rig.update(observation(rig, 'left', desired), 1 + index / 30, 1 + index / 30, 1 / 30);
    assertWristBounded(rig, 'left');
    for (const bone of Object.values(rig.bones)) assert.ok(bone.quaternion.toArray().every(Number.isFinite));
  }
  assert.equal(constrainWristRotation(new Quaternion(NaN, 0, 0, 1), new Vector3(1, 0, 0)), null);
  assert.equal(constrainWristRotation(new Quaternion(), new Vector3()), null);
});

test('sharing forearm roll preserves a raised IK target beside the face', () => {
  const { rig, bones } = fixture();
  const solution = observation(rig, 'left', new Quaternion());
  solution.armTargets.left = {
    aspect: 1, shoulders: { x: .5, y: .55, span: .4 }, wrist: { x: .74, y: .29 },
  };
  // Determine the geometric target without a palm observation first.
  const positionOnly = { ...solution, hands: {} };
  rig.update(positionOnly, 1, 1, 1, { bodySmoothing: .001 });
  const target = position(bones.leftHand);
  const axis = target.clone().sub(position(bones.leftLowerArm)).normalize();
  const neutral = world(bones.leftLowerArm).multiply(rig.rest.leftHand.local);
  const desired = new Quaternion().setFromAxisAngle(axis, rad(110)).multiply(neutral);
  solution.hands = observation(rig, 'left', desired).hands;
  rig.update(solution, 1.1, 1.1, 1, { bodySmoothing: .001 });
  assert.ok(position(bones.leftHand).distanceTo(target) < 1e-7);
  nearRotation(world(bones.leftHand), desired);
  assertWristBounded(rig, 'left');
});
