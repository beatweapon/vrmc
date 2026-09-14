import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Euler, Object3D, Quaternion, Vector3 } from 'three';
import { VRMHumanoid, VRMUtils } from '@pixiv/three-vrm';
import { FullBodyAvatar } from '../docs/fullbody/avatar.js';
import { BodyRetargeter, calibrateBody, solveBody, TRACKED_BONES } from '../docs/fullbody/body.js';
import { mirrorBodyInput, mirrorFaceMotion } from '../docs/fullbody/mirror-motion.js';

const reflect = vector => new Vector3(-vector.x, vector.y, vector.z);
const nearVector = (actual, expected, tolerance = 1e-5) =>
  assert.ok(actual.distanceTo(expected) < tolerance, `${actual.toArray()} differs from ${expected.toArray()}`);
const nearQuaternion = (actual, expected) => assert.ok(actual.angleTo(expected) < 1e-5);
const reflectedQuaternion = value => new Quaternion(value.x, -value.y, -value.z, value.w);
const native = JSON.parse(readFileSync(new URL('./fixtures/pointing-up-native.json', import.meta.url))).result;

function poseFixture() {
  const points = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  for (const [index, x, y, z = 0] of [
    [11, .2, -.5], [12, -.2, -.5], [13, .45, -.8], [14, -.4, -.3],
    [15, .55, -1], [16, -.3, -.1], [23, .1, 0], [24, -.1, 0],
    [25, .15, .35, .15], [26, -.1, .4], [27, .2, .65, .15], [28, -.1, .8],
    [31, .2, .65, -.05], [32, -.1, .8, -.1],
  ]) points[index] = { x, y, z, visibility: .95 };
  const turn = new Quaternion().setFromEuler(new Euler(.12, .28, -.16));
  for (const point of points) {
    const rotated = new Vector3(point.x, -point.y, -point.z).applyQuaternion(turn);
    Object.assign(point, { x: rotated.x, y: -rotated.y, z: -rotated.z });
  }
  return { worldLandmarks: [points], landmarks: [points.map(point => ({ ...point,
    x: .58 + .3 * point.x, y: .45 + .3 * point.y, z: 0 }))], imageWidth: 1280, imageHeight: 720 };
}

function sampleAvatar(vrm0 = false) {
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
  const raw = Object.fromEntries(Object.entries(json.extensions.VRMC_vrm.humanoid.humanBones)
    .map(([name, { node }]) => [name, nodes[node]]));
  // Exercise the normalized rig's rotated scene convention as well as VRM 1.
  if (vrm0) raw.hips.rotation.y += Math.PI;
  scene.updateWorldMatrix(true, true);
  const humanoid = new VRMHumanoid(Object.fromEntries(Object.entries(raw).map(([name, node]) => [name, { node }])));
  scene.add(humanoid.normalizedHumanBonesRoot);
  if (vrm0) VRMUtils.rotateVRM0({ scene, meta: { metaVersion: '0' } });
  scene.updateWorldMatrix(true, true);
  const rig = new BodyRetargeter(Object.fromEntries(TRACKED_BONES.map(name => [name, humanoid.getNormalizedBoneNode(name)])));
  const values = {};
  const avatar = Object.assign(Object.create(FullBodyAvatar.prototype), {
    rig, scene, hipsPosition: rig.bones.hips.position.clone(), root: new Vector3(), rootTarget: new Vector3(),
    rootTime: -Infinity, calibration: null, lastExpressions: {}, lastGaze: { yaw: 0, pitch: 0 },
    lastFaceTime: -Infinity, floorBones: [],
    vrm: { scene, humanoid, update: () => humanoid.update(), lookAt: { yaw: 0, pitch: 0 },
      expressionManager: { getExpression: () => true, getValue: name => values[name] ?? 0,
        setValue: (name, value) => { values[name] = value; } } },
  });
  return { avatar, raw, values };
}

test('mirrored observations swap anatomical limbs while retaining camera confidence and source data', () => {
  const pose = poseFixture();
  const hands = { ...structuredClone(native.hands), identitiesStable: true, trackingIds: ['right'],
    physicalTrackingIds: [42], releasedSides: ['left'] };
  const original = structuredClone({ pose, hands });
  const mirrored = mirrorBodyInput(pose, hands);
  assert.deepEqual({ pose, hands }, original);
  assert.equal(mirrored.pose.landmarks[0][15].x, 1 - pose.landmarks[0][16].x);
  assert.equal(mirrored.pose.landmarks[0][15].visibility, pose.landmarks[0][16].visibility);
  assert.equal(mirrored.hands.handedness[0][0].categoryName, 'Left');
  assert.deepEqual(mirrored.hands.trackingIds, ['left']);
  assert.deepEqual(mirrored.hands.physicalTrackingIds, [42]);
  assert.deepEqual(mirrored.hands.releasedSides, ['right']);
  assert.equal(mirrored.hands.landmarks[0][0].visibility, 0);
  const normal = solveBody(pose, null);
  const reflected = solveBody(mirrored.pose, null);
  nearQuaternion(reflected.hips, reflectedQuaternion(normal.hips));
  nearQuaternion(reflected.torso, reflectedQuaternion(normal.torso));
  for (const limb of ['UpperArm', 'LowerArm', 'UpperLeg', 'LowerLeg', 'Foot']) {
    nearVector(reflected.directions['left' + limb], reflect(normal.directions['right' + limb]));
    nearVector(reflected.directions['right' + limb], reflect(normal.directions['left' + limb]));
  }
});

test('head rotation and wink mirror after personal calibration while facial measurements stay anatomical', () => {
  const head = new Quaternion().setFromEuler(new Euler(.25, .4, -.3));
  const face = { tracked: true, head: head.toArray(), gaze: { yaw: 14, pitch: -8 },
    expressions: { blinkLeft: 1, blinkRight: 0, aa: .4, happy: .6 },
    metrics: { leftEyeOpen: .07, rightEyeOpen: .29 } };
  const before = structuredClone(face);
  const mirrored = mirrorFaceMotion(face);
  const actual = new Quaternion().fromArray(mirrored.head);
  for (const axis of [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)]) {
    nearVector(axis.clone().applyQuaternion(actual), reflect(reflect(axis).applyQuaternion(head)));
  }
  assert.deepEqual(mirrored.metrics, face.metrics);
  assert.deepEqual(face, before);
  const { avatar, values } = sampleAvatar();
  avatar.updateFace(face, 1, 1, .1, true);
  assert.equal(values.blinkLeft, 0);
  assert.equal(values.blinkRight, 1);
  assert.equal(values.aa, .4);
  assert.equal(values.happy, .6);
  assert.deepEqual(avatar.vrm.lookAt, { yaw: -14, pitch: -8 });
  // Changing the setting while holding a lost detection must also affect the
  // held motion, without swapping the original stored calibration/metrics.
  avatar.updateFace(null, 1, 1.2, .1, false);
  assert.equal(values.blinkLeft, 1);
  assert.equal(values.blinkRight, 0);
  assert.equal(avatar.vrm.lookAt.yaw, 14);
});

for (const vrm0 of [false, true]) test(`motion mirror reaches the opposite raw VRM ${vrm0 ? '0' : '1'} wrist and pointing fingers`, () => {
  const normal = sampleAvatar(vrm0);
  const mirrored = sampleAvatar(vrm0);
  const faceLandmarks = Array.from({ length: 478 }, () => ({ x: .65, y: .7, z: 0, visibility: 0 }));
  for (const [index, x] of [[33, .604], [133, .624], [362, .676], [263, .696]]) faceLandmarks[index].x = x;
  const frame = { ...structuredClone(native), faceLandmarks, imageWidth: 720, imageHeight: 720, face: null };
  const originals = [normal, mirrored].map(({ avatar }) => ({
    scale: avatar.scene.scale.clone(),
    offsets: Object.fromEntries(Object.entries(avatar.rig.bones).filter(([, node]) => node)
      .map(([name, node]) => [name, node.position.clone()])),
  }));
  for (let step = 0; step < 25; step++) {
    frame.time = performance.now() / 1000;
    frame.sequence = step;
    normal.avatar.update(frame, .1, { mirrorAvatar: false, bodySmoothing: .001 });
    mirrored.avatar.update(frame, .1, { mirrorAvatar: true, bodySmoothing: .001 });
  }
  assert.ok(normal.avatar.solution.armTargets.right);
  assert.ok(mirrored.avatar.solution.armTargets.left);
  assert.equal(mirrored.avatar.solution.armTargets.right, undefined);
  const right = normal.raw.rightHand.getWorldPosition(new Vector3());
  const left = mirrored.raw.leftHand.getWorldPosition(new Vector3());
  nearVector(left, reflect(right), .015);
  assert.ok(left.y > mirrored.raw.chest.getWorldPosition(new Vector3()).y + .1);
  assert.ok(mirrored.raw.rightHand.getWorldPosition(new Vector3()).y < left.y - .3);
  for (const finger of ['Index', 'Middle', 'Ring', 'Little']) {
    function bend(raw, side) {
      const p = raw[side + finger + 'Proximal'].getWorldPosition(new Vector3());
      const m = raw[side + finger + 'Intermediate'].getWorldPosition(new Vector3());
      const d = raw[side + finger + 'Distal'].getWorldPosition(new Vector3());
      return m.clone().sub(p).angleTo(d.sub(m));
    }
    const actual = bend(mirrored.raw, 'left');
    assert.ok(Math.abs(actual - bend(normal.raw, 'right')) < .015);
    assert.ok(finger === 'Index' ? actual < .4 : actual > .7);
  }
  [normal, mirrored].forEach(({ avatar }, index) => {
    nearVector(avatar.scene.scale, originals[index].scale);
    for (const [name, position] of Object.entries(originals[index].offsets)) {
      nearVector(avatar.rig.bones[name].position, position);
    }
  });
  // A setting change must re-solve even before the next camera frame arrives.
  mirrored.avatar.update(frame, .1, { mirrorAvatar: false, bodySmoothing: .001 });
  assert.ok(mirrored.avatar.solution.armTargets.right);
  assert.equal(mirrored.avatar.solution.armTargets.left, undefined);
  assert.equal(mirrored.avatar.rig.lastArmTargets.has('left'), false);
});

test('root translation mirrors the calibrated displacement, leaving an off-centre neutral pose unchanged', () => {
  const original = poseFixture();
  const { avatar } = sampleAvatar();
  avatar.setCalibration(calibrateBody(original));
  const calibration = structuredClone(avatar.calibration);
  avatar.updateRoot(original, 1, 1, 1, { mirrorAvatar: true, bodySmoothing: .001 });
  nearVector(avatar.root, new Vector3());
  const moved = structuredClone(original);
  moved.landmarks[0].forEach(point => { point.x += .1; });
  avatar.updateRoot(moved, 2, 2, 1, { mirrorAvatar: false, bodySmoothing: .001 });
  const displacement = avatar.root.clone();
  assert.ok(displacement.x > 0);
  avatar.updateRoot(moved, 2, 2, 1, { mirrorAvatar: true, bodySmoothing: .001 });
  nearVector(avatar.root, reflect(displacement));
  assert.deepEqual(avatar.calibration, calibration);
});
