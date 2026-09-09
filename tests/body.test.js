import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Object3D, Quaternion, Vector3 } from 'three';
import { VRMHumanBoneName, VRMHumanoid, VRMUtils } from '@pixiv/three-vrm';
import {
  BodyRetargeter, basisQuaternion, calibrateBody, directionWorldQuaternion, landmarkVector,
  rootOffset, smoothingAlpha, solveBody, TRACKED_BONES, validateBodyCalibration, worldToLocalQuaternion,
} from '../docs/fullbody/body.js';
import { FullBodyAvatar } from '../docs/fullbody/avatar.js';

const nearVector = (actual, expected, tolerance = 1e-5) => assert.ok(actual.distanceTo(expected) < tolerance, `${actual.toArray()} ≠ ${expected.toArray()}`);
const nearQuaternion = (actual, expected, tolerance = 1e-5) => assert.ok(actual.angleTo(expected) < tolerance, `quaternion difference ${actual.angleTo(expected)}`);
const point = (x, y, z = 0, visibility = 1) => ({ x, y: -y, z: -z, visibility });
function poseFixture() {
  const world = Array.from({ length: 33 }, () => point(0, 0, 0, 0));
  Object.assign(world, {
    11: point(0.2, 0.5), 12: point(-0.2, 0.5), 13: point(0.5, 0.5), 14: point(-0.5, 0.5),
    15: point(0.8, 0.5), 16: point(-0.8, 0.5), 23: point(0.1, 0), 24: point(-0.1, 0),
    25: point(0.1, -0.45), 26: point(-0.1, -0.45), 27: point(0.1, -0.9), 28: point(-0.1, -0.9),
    31: point(0.1, -0.95, 0.15), 32: point(-0.1, -0.95, 0.15),
  });
  const image = world.map(value => ({ ...value, x: 0.5 + value.x * 0.4, y: 0.5 + value.y * 0.4, z: 0 }));
  return { worldLandmarks: [world], landmarks: [image] };
}
function rigFixture({ neck = true, arbitraryRest = false } = {}) {
  const root = new Object3D();
  const bones = {};
  function bone(name, parent, position) {
    const node = new Object3D();
    node.position.fromArray(position);
    (bones[parent] ?? root).add(node);
    bones[name] = node;
    return node;
  }
  bone('hips', null, [0, 1, 0]);
  bone('spine', 'hips', [0, 0.2, 0]);
  bone('chest', 'spine', [0, 0.3, 0]);
  if (neck) bone('neck', 'chest', [0, 0.12, 0]);
  bone('head', neck ? 'neck' : 'chest', [0, 0.12, 0]);
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    bone(`${side}UpperArm`, 'chest', [sign * 0.2, 0, 0]);
    bone(`${side}LowerArm`, `${side}UpperArm`, [sign * 0.3, 0, 0]);
    bone(`${side}Hand`, `${side}LowerArm`, [sign * 0.3, 0, 0]);
    bone(`${side}UpperLeg`, 'hips', [sign * 0.1, 0, 0]);
    bone(`${side}LowerLeg`, `${side}UpperLeg`, [0, -0.45, 0]);
    bone(`${side}Foot`, `${side}LowerLeg`, [0, -0.45, 0]);
    bone(`${side}Toes`, `${side}Foot`, [0, -0.05, 0.15]);
  }
  if (arbitraryRest) {
    bones.leftUpperArm.rotation.z = Math.PI / 3;
    // Rotate the child offset in the opposite direction: a different bind axis, same T-pose geometry.
    bones.leftLowerArm.position.applyAxisAngle(new Vector3(0, 0, 1), -Math.PI / 3);
    bones.leftLowerArm.rotation.z = -Math.PI / 3;
  }
  root.updateWorldMatrix(true, true);
  return { root, bones, rig: new BodyRetargeter(bones) };
}
function measuredDirection(bones, from, to) {
  return bones[to].getWorldPosition(new Vector3()).sub(bones[from].getWorldPosition(new Vector3())).normalize();
}

test('camera coordinates and orthonormal torso basis preserve front-facing T stance', () => {
  nearVector(landmarkVector({ x: 1, y: 2, z: 3 }), new Vector3(1, -2, -3));
  assert.equal(landmarkVector({ x: NaN, y: 0, z: 0 }), null);
  const solved = solveBody(poseFixture(), null);
  nearQuaternion(solved.hips, new Quaternion());
  nearQuaternion(solved.torso, new Quaternion());
  nearVector(solved.directions.leftUpperArm, new Vector3(1, 0, 0));
  nearVector(solved.directions.rightLowerArm, new Vector3(-1, 0, 0));
  nearVector(solved.directions.leftUpperLeg, new Vector3(0, -1, 0));
  assert.equal(basisQuaternion(new Vector3(0, 1, 0), new Vector3(0, 2, 0)), null);
});

test('cropped hips do not stop shoulder-driven torso tilt', () => {
  const pose = poseFixture();
  const angle = 0.28;
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), angle);
  for (const index of [11, 12]) {
    const value = landmarkVector(pose.worldLandmarks[0][index]).applyQuaternion(rotation);
    pose.worldLandmarks[0][index] = point(value.x, value.y, value.z);
  }
  for (const index of [23, 24]) pose.landmarks[0][index].y = 1.2;
  const solved = solveBody(pose, null);
  assert.equal(solved.hips, null);
  assert.equal(solved.tracked, true);
  nearQuaternion(solved.torso, rotation);
  const { bones, rig } = rigFixture();
  rig.update(solved, 1, 1, 1, { bodySmoothing: 0.001 });
  nearQuaternion(bones.chest.getWorldQuaternion(new Quaternion()), rotation);
  nearQuaternion(bones.hips.quaternion, new Quaternion());
});

test('forward torso bending is carried by the spine while pelvic pitch stays conservative', () => {
  const pose = poseFixture();
  pose.worldLandmarks[0][11].z = -0.3;
  pose.worldLandmarks[0][12].z = -0.3;
  const body = solveBody(pose, null);
  const neutral = new Quaternion();
  assert.ok(body.torso.angleTo(neutral) > 0.4);
  assert.ok(body.hips.angleTo(neutral) < body.torso.angleTo(neutral) * 0.3);
});

test('world targets are converted through a rotated parent and a non-identity bind axis', () => {
  const parent = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.8);
  const rest = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.7);
  const desiredDirection = new Vector3(0, 0, 1);
  const desiredWorld = directionWorldQuaternion(new Vector3(1, 0, 0), desiredDirection, rest);
  const local = worldToLocalQuaternion(parent, desiredWorld);
  nearQuaternion(parent.clone().multiply(local), desiredWorld);
  const bindAxis = new Vector3(1, 0, 0).applyQuaternion(rest.clone().invert());
  nearVector(bindAxis.applyQuaternion(parent.clone().multiply(local)), desiredDirection);
});

test('bundled VRM skeleton transfers retargeted normalized rotations to its original rig', () => {
  const bytes = readFileSync(new URL('../docs/models/VRM1_Constraint_Twist_Sample.vrm', import.meta.url));
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
  const nodes = json.nodes.map(source => {
    const node = new Object3D();
    if (source.translation) node.position.fromArray(source.translation);
    if (source.rotation) node.quaternion.fromArray(source.rotation);
    if (source.scale) node.scale.fromArray(source.scale);
    if (source.matrix) {
      node.matrix.fromArray(source.matrix);
      node.matrix.decompose(node.position, node.quaternion, node.scale);
    }
    return node;
  });
  json.nodes.forEach((source, index) => source.children?.forEach(child => nodes[index].add(nodes[child])));
  const scene = new Object3D();
  json.scenes[json.scene ?? 0].nodes.forEach(index => scene.add(nodes[index]));
  scene.updateWorldMatrix(true, true);
  const humanBones = Object.fromEntries(Object.entries(json.extensions.VRMC_vrm.humanoid.humanBones).map(([name, { node }]) => [name, { node: nodes[node] }]));
  const humanoid = new VRMHumanoid(humanBones);
  scene.add(humanoid.normalizedHumanBonesRoot);
  const normalized = Object.fromEntries(TRACKED_BONES.map(name => {
    assert.ok(Object.values(VRMHumanBoneName).includes(name), `Invalid VRM bone: ${name}`);
    return [name, humanoid.getNormalizedBoneNode(name)];
  }));
  const rig = new BodyRetargeter(normalized);
  const body = solveBody(poseFixture(), null);
  body.hips = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.3);
  body.torso = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -0.2);
  body.directions.leftUpperArm = new Vector3(0.3, -0.8, 0.4).normalize();
  body.directions.leftLowerArm = new Vector3(0.4, 0.2, 0.6).normalize();
  rig.update(body, 1, 1, 1, { bodySmoothing: 0.001 });
  humanoid.update();
  const raw = Object.fromEntries(Object.entries(humanBones).map(([name, { node }]) => [name, node]));
  nearVector(measuredDirection(raw, 'leftUpperArm', 'leftLowerArm'), body.directions.leftUpperArm);
  nearVector(measuredDirection(raw, 'leftLowerArm', 'leftHand'), body.directions.leftLowerArm);
  nearVector(measuredDirection(raw, 'rightUpperLeg', 'rightLowerLeg'), body.directions.rightUpperLeg);
});

test('VRM 0 scene rotation preserves camera-space limb directions through normalized rig transfer', () => {
  const { root: scene, bones } = rigFixture();
  // A VRM 0 bind pose faces -Z; bake a half-turn into the authored node transforms.
  bones.hips.rotation.y = Math.PI;
  scene.updateWorldMatrix(true, true);
  const humanoid = new VRMHumanoid(Object.fromEntries(Object.entries(bones).map(([name, node]) => [name, { node }])));
  scene.add(humanoid.normalizedHumanBonesRoot);
  VRMUtils.rotateVRM0({ scene, meta: { metaVersion: '0' } });
  scene.updateWorldMatrix(true, true);
  const normalized = Object.fromEntries(TRACKED_BONES.map(name => [name, humanoid.getNormalizedBoneNode(name)]));
  const rig = new BodyRetargeter(normalized);
  const body = solveBody(poseFixture(), null);
  body.directions.leftUpperArm = new Vector3(0.4, -0.8, 0.5).normalize();
  body.directions.leftLowerArm = new Vector3(0.2, 0.3, 0.7).normalize();
  rig.update(body, 1, 1, 1, { bodySmoothing: 0.001 });
  humanoid.update();
  nearVector(measuredDirection(bones, 'leftUpperArm', 'leftLowerArm'), body.directions.leftUpperArm);
  nearVector(measuredDirection(bones, 'leftLowerArm', 'leftHand'), body.directions.leftLowerArm);
});

test('a turned torso does not double-rotate limb targets, including unusual model bind axes', () => {
  const { bones, rig } = rigFixture({ arbitraryRest: true });
  const solution = solveBody(poseFixture(), null);
  solution.hips = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4);
  solution.torso = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7);
  solution.directions.leftUpperArm = new Vector3(0.6, -0.3, 0.7).normalize();
  solution.directions.leftLowerArm = new Vector3(0.1, 0.9, 0.3).normalize();
  rig.update(solution, 1, 1, 1, { bodySmoothing: 0.001 });
  nearVector(measuredDirection(bones, 'leftUpperArm', 'leftLowerArm'), solution.directions.leftUpperArm);
  nearVector(measuredDirection(bones, 'leftLowerArm', 'leftHand'), solution.directions.leftLowerArm);
});

test('low confidence affects only dependent joints; stale held frames eventually return to idle', () => {
  const { bones, rig } = rigFixture();
  const pose = poseFixture();
  const tracked = solveBody(pose, null);
  rig.update(tracked, 1, 1, 1, { bodySmoothing: 0.001 });
  const captured = bones.leftLowerArm.quaternion.clone();
  pose.worldLandmarks[0][15].visibility = 0.1;
  const partial = solveBody(pose, null);
  assert.equal(partial.directions.leftLowerArm, undefined);
  assert.ok(partial.directions.rightLowerArm);
  rig.update(partial, 1.1, 1.1, 0.1);
  nearQuaternion(bones.leftLowerArm.quaternion, captured);
  // Repeated old detections must not keep the arms stuck in their last pose.
  for (let now = 1.5; now < 4; now += 0.05) rig.update(tracked, 1, now, 0.05);
  nearQuaternion(bones.leftUpperArm.quaternion, rig.rest.leftUpperArm.idle, 0.006);
});

test('offscreen pose points are rejected even when the model reports high world confidence', () => {
  const pose = poseFixture();
  pose.landmarks[0][15].x = 1.1;
  pose.landmarks[0][27].y = 1.2;
  const solution = solveBody(pose, null);
  assert.equal(solution.directions.leftLowerArm, undefined);
  assert.equal(solution.directions.leftLowerLeg, undefined);
  assert.equal(solution.directions.leftFoot, undefined);
  assert.ok(solution.directions.rightLowerArm);
  assert.equal(solution.legTracked, false);
  pose.landmarks[0][23].x = -0.1;
  assert.throws(() => calibrateBody(pose), /肩と腰/);
});

test('absolute face orientation removes torso rotation and neck+head weights do not accumulate', () => {
  for (const neck of [true, false]) {
    const { bones, rig } = rigFixture({ neck });
    const body = solveBody(poseFixture(), null);
    body.hips = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.25);
    body.torso = body.hips;
    rig.update(body, 1, 1, 1, { bodySmoothing: 0.001 });
    const desired = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -0.3);
    rig.updateHead({ tracked: true, head: desired.toArray() }, 1, 1, 1, { bodySmoothing: 0.001 });
    nearQuaternion(bones.head.getWorldQuaternion(new Quaternion()), desired);
    if (neck) assert.ok(Math.abs(bones.neck.rotation.z + 0.1925) < 0.001);
  }
});

test('seated mode restores leg rest pose and missing optional bones remain safe', () => {
  const { bones, rig } = rigFixture({ neck: false });
  const body = solveBody(poseFixture(), null);
  body.directions.leftUpperLeg = new Vector3(0, 0, 1);
  rig.update(body, 1, 1, 1, { bodySmoothing: 0.001 });
  assert.ok(bones.leftUpperLeg.quaternion.angleTo(rig.rest.leftUpperLeg.local) > 1);
  for (let now = 1.1; now < 5; now += 0.1) rig.update(body, now, now, 0.1, { seated: true });
  nearQuaternion(bones.leftUpperLeg.quaternion, rig.rest.leftUpperLeg.local, 0.001);
  assert.doesNotThrow(() => new BodyRetargeter({}).update(solveBody(null, null), 1, 1, 0.1));
});

test('calibration measures neutral scale and translates lateral motion/crouches without depth drift', () => {
  const pose = poseFixture();
  const calibration = calibrateBody(pose);
  assert.equal(validateBodyCalibration(JSON.parse(JSON.stringify(calibration))), true);
  nearVector(rootOffset(pose, calibration, 0.5), new Vector3());
  for (const point of pose.landmarks[0]) point.x += 0.1;
  pose.worldLandmarks[0][27].y -= 0.2;
  pose.worldLandmarks[0][28].y -= 0.2;
  nearVector(rootOffset(pose, calibration, 0.5), new Vector3(0.25, -0.2, 0));
  assert.equal(rootOffset(pose, calibration, 0.5, { seated: true }).y, 0);
  assert.equal(rootOffset(pose, calibration, 0.5, { rootMotion: false }), null);
  assert.throws(() => calibrateBody(null), /肩と腰/);
});

test('lateral calibration uses consistent pixel units for widescreen and square camera images', () => {
  const square = poseFixture();
  const wide = poseFixture();
  square.imageWidth = square.imageHeight = 720;
  wide.imageWidth = 1280;
  wide.imageHeight = 720;
  // Same pixel geometry inside different image widths; include a tilted torso to test both axes.
  for (const index of [11, 12]) square.landmarks[0][index].x += 0.08;
  wide.landmarks[0] = square.landmarks[0].map(value => ({ ...value, x: 0.5 + (value.x - 0.5) * 720 / 1280 }));
  const squareCalibration = calibrateBody(square);
  const wideCalibration = calibrateBody(wide);
  assert.ok(Math.abs(squareCalibration.torsoImage - wideCalibration.torsoImage) < 1e-10);
  for (const value of square.landmarks[0]) value.x += 72 / 720;
  for (const value of wide.landmarks[0]) value.x += 72 / 1280;
  nearVector(rootOffset(square, squareCalibration, 0.5), rootOffset(wide, wideCalibration, 0.5));
});

test('smoothing has the same elapsed-time response at different render rates', () => {
  const run = fps => {
    let value = 0;
    for (let i = 0; i < fps; i++) value += (1 - value) * smoothingAlpha(1 / fps, 0.12);
    return value;
  };
  assert.ok(Math.abs(run(30) - run(144)) < 1e-10);
});

test('palm and curled fingers retarget after the wrist, using pose proximity to assign hands', () => {
  const { root, bones } = rigFixture();
  const points = Array.from({ length: 21 }, () => point(0, 0));
  points[0] = point(0, 0);
  const twist = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.8);
  const add = (name, parent, offset) => {
    const bone = new Object3D();
    bone.position.fromArray(offset);
    bones[parent].add(bone);
    bones[name] = bone;
  };
  for (const [finger, index, z] of [['Index', 5, 0.04], ['Middle', 9, 0], ['Little', 17, -0.04]]) {
    add(`left${finger}Proximal`, 'leftHand', [0.07, 0, z]);
    add(`left${finger}Intermediate`, `left${finger}Proximal`, [0.035, 0, 0]);
    add(`left${finger}Distal`, `left${finger}Intermediate`, [0.025, 0, 0]);
    for (let joint = 0; joint < 4; joint++) {
      const vector = new Vector3(0.07 + joint * 0.025, joint > 0 ? -joint * 0.01 : 0, z).applyQuaternion(twist);
      points[index + joint] = point(...vector.toArray());
    }
  }
  root.updateWorldMatrix(true, true);
  const rig = new BodyRetargeter(bones);
  const pose = poseFixture();
  const hands = {
    worldLandmarks: [points], landmarks: [[{ ...pose.landmarks[0][15] }]],
    handedness: [[{ categoryName: 'Right', score: 0.99 }]],
  };
  const solution = solveBody(pose, hands);
  assert.ok(solution.palms.leftHand);
  assert.equal(solution.palms.rightHand, undefined);
  rig.update(solution, 1, 1, 1, { bodySmoothing: 0.001 });
  nearQuaternion(bones.leftHand.getWorldQuaternion(new Quaternion()), twist);
  nearVector(measuredDirection(bones, 'leftIndexProximal', 'leftIndexIntermediate'), solution.directions.leftIndexProximal);
  nearVector(measuredDirection(bones, 'leftIndexIntermediate', 'leftIndexDistal'), solution.directions.leftIndexIntermediate);
});

test('combined-blink-only VRMs blink, and stale face/gaze data relaxes without snapping', () => {
  const values = { blink: 0, aa: 0 };
  const avatar = Object.create(FullBodyAvatar.prototype);
  avatar.vrm = {
    expressionManager: { getExpression: name => name in values, getValue: name => values[name], setValue: (name, value) => { values[name] = value; } },
    lookAt: { yaw: 0, pitch: 0 },
  };
  avatar.lastFaceTime = -Infinity;
  const face = { tracked: true, expressions: { blinkLeft: 0.8, blinkRight: 0.9, aa: 0.5 }, gaze: { yaw: 12, pitch: -4 } };
  avatar.updateFace(face, 1, 1, 1 / 60);
  assert.equal(values.blink, 0.9);
  assert.equal(avatar.vrm.lookAt.yaw, 12);
  avatar.updateFace(null, 1.1, 1.1, 1 / 60);
  assert.equal(values.blink, 0.9);
  assert.equal(avatar.vrm.lookAt.yaw, 12);
  avatar.updateFace(face, 1, 2, 1 / 60);
  assert.ok(values.blink > 0 && values.blink < 0.9);
  assert.ok(avatar.vrm.lookAt.yaw > 0 && avatar.vrm.lookAt.yaw < 12);
});
