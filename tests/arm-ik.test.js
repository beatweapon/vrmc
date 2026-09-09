import test from 'node:test';
import assert from 'node:assert/strict';
import { Object3D, Quaternion, Vector3 } from 'three';
import { BodyRetargeter, solveBody } from '../docs/fullbody/body.js';
import { solveTwoBoneIK } from '../docs/fullbody/arm-ik.js';
import { FullBodyAvatar } from '../docs/fullbody/avatar.js';
import { TrackingState } from '../docs/fullbody/tracking-state.js';

const imagePoint = (x, y, visibility = 1) => ({ x, y, z: 0, visibility });
const worldPoint = (x, y, z = 0, visibility = 1) => ({ x, y: -y, z: -z, visibility });
const near = (actual, expected, tolerance = 1e-5) =>
  assert.ok(actual.distanceTo(expected) < tolerance, `${actual.toArray()} != ${expected.toArray()}`);
const position = bone => bone.getWorldPosition(new Vector3());

test('face-only avatar frames carry their camera dimensions into image wrist anchoring', () => {
  const avatar=Object.create(FullBodyAvatar.prototype);
  avatar.vrm={update(){}};
  avatar.rig={update(){}};
  avatar.updateRoot=()=>{};
  avatar.updateFace=()=>{};
  const aspect=16/9;
  avatar.update({pose:null,hands:handsFixture({aspect}),faceLandmarks:faceFixture(aspect),
    imageWidth:1280,imageHeight:720,time:performance.now()/1000},1/60,{});
  assert.equal(avatar.solution.armTargets.left.aspect,aspect);
  assert.equal(avatar.solution.armTargets.right.aspect,aspect);
});

function rigFixture({ eyes = true, neck = true, arbitraryRest = false } = {}) {
  const root = new Object3D();
  const bones = {};
  const add = (name, parent, offset) => {
    const bone = new Object3D();
    bone.position.fromArray(offset);
    (bones[parent] ?? root).add(bone);
    bones[name] = bone;
  };
  add('hips', null, [0, 1, 0]);
  add('spine', 'hips', [0, 0.2, 0]);
  add('chest', 'spine', [0, 0.3, 0]);
  if (neck) add('neck', 'chest', [0, 0.12, 0]);
  add('head', neck ? 'neck' : 'chest', [0, neck ? 0.12 : 0.24, 0]);
  for (const [side, sign] of [['left', 1], ['right', -1]]) {
    if (eyes) add(`${side}Eye`, 'head', [sign * 0.036, 0.075, 0.048]);
    add(`${side}UpperArm`, 'chest', [sign * 0.2, 0, 0]);
    add(`${side}LowerArm`, `${side}UpperArm`, [sign * 0.3, 0, 0]);
    add(`${side}Hand`, `${side}LowerArm`, [sign * 0.3, 0, 0]);
    for (const [finger, z] of [['Index', 0.04], ['Middle', 0], ['Little', -0.04]]) {
      add(`${side}${finger}Proximal`, `${side}Hand`, [sign * 0.07, 0, z]);
      add(`${side}${finger}Intermediate`, `${side}${finger}Proximal`, [sign * 0.03, 0, 0]);
      add(`${side}${finger}Distal`, `${side}${finger}Intermediate`, [sign * 0.025, 0, 0]);
    }
  }
  if (arbitraryRest) {
    bones.leftUpperArm.rotation.z = 0.7;
    bones.leftLowerArm.position.applyAxisAngle(new Vector3(0, 0, 1), -0.7);
    bones.leftLowerArm.rotation.z = -0.7;
  }
  root.updateWorldMatrix(true, true);
  return { root, bones, rig: new BodyRetargeter(bones) };
}

function poseFixture({ elbows = false, shoulders = true, aspect = 1 } = {}) {
  const image = Array.from({ length: 33 }, () => imagePoint(0.5, 0.5, 0));
  const world = Array.from({ length: 33 }, () => worldPoint(0, 0, 0, 0));
  for (const [shoulder, elbow, wrist, sign] of [[11, 13, 15, 1], [12, 14, 16, -1]]) {
    world[shoulder] = worldPoint(sign * 0.2, 0.5, 0, shoulders ? 1 : 0);
    image[shoulder] = imagePoint(0.5 + sign * 0.2 / aspect, 0.565, shoulders ? 1 : 0);
    world[elbow] = worldPoint(sign * 0.5, 0.5);
    image[elbow] = imagePoint(0.5 + sign * 0.3 / aspect, elbows ? 0.565 : 1.1);
    world[wrist] = worldPoint(sign * 0.8, 0.5);
    image[wrist] = imagePoint(0.5 + sign * 0.4 / aspect, 0.565, elbows ? 1 : 0);
  }
  return { landmarks: [image], worldLandmarks: [world], imageWidth: aspect * 720, imageHeight: 720 };
}

function faceFixture(aspect = 1) {
  const face = Array.from({ length: 478 }, () => imagePoint(0.5, 0.25));
  for (const [index, x] of [[33, 0.454], [133, 0.474], [362, 0.526], [263, 0.546]]) {
    face[index] = imagePoint(0.5 + (x - 0.5) / aspect, 0.25);
  }
  return face;
}

function handsFixture({ crossed = false, aspect = 1 } = {}) {
  const hands = { worldLandmarks: [], landmarks: [], handedness: [] };
  for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
    const world = Array.from({ length: 21 }, () => worldPoint(0, 0));
    for (const [index, x] of [[5, -0.03], [9, 0], [17, 0.03]]) {
      for (let joint = 0; joint < 4; joint++) world[index + joint] = worldPoint(x, 0.07 + joint * 0.025);
    }
    hands.worldLandmarks.push(world);
    hands.landmarks.push([imagePoint(0.5 + sign * (crossed ? -0.22 : 0.22) / aspect, 0.28)]);
    hands.handedness.push([{ categoryName: side, score: 0.99 }]);
  }
  return hands;
}

test('elbows outside the image: both actual rig wrists reach beside the face', () => {
  const { bones, rig } = rigFixture();
  const body = solveBody(poseFixture(), handsFixture(), {}, faceFixture());
  assert.ok(body.armTargets.left && body.armTargets.right);
  assert.equal(body.directions.leftUpperArm, undefined);
  rig.update(body, 1, 1, 1, { bodySmoothing: 0.001 });
  near(position(bones.leftHand), new Vector3(0.22, 1.785, 0.096));
  near(position(bones.rightHand), new Vector3(-0.22, 1.785, 0.096));
  for (const side of ['left', 'right']) {
    assert.ok(position(bones[`${side}LowerArm`]).y < position(bones[`${side}Hand`]).y);
    assert.ok(Math.abs(position(bones[`${side}UpperArm`]).distanceTo(position(bones[`${side}LowerArm`])) - 0.3) < 1e-7);
    assert.ok(Math.abs(position(bones[`${side}LowerArm`]).distanceTo(position(bones[`${side}Hand`])) - 0.3) < 1e-7);
  }
});

test('face-only closeup preserves wrist position without shoulders, neck, or optional eye bones', () => {
  for (const eyes of [true, false]) {
    const { bones, rig } = rigFixture({ eyes, neck: false });
    const body = solveBody(poseFixture({ shoulders: false }), handsFixture(), {}, faceFixture());
    rig.update(body, 1, 1, 1, { bodySmoothing: 0.001 });
    near(position(bones.leftHand), new Vector3(0.22, 1.785, 0.096));
    near(position(bones.rightHand), new Vector3(-0.22, 1.785, 0.096));
  }
});

test('shoulder-only image anchors also raise hands when face detection is temporarily lost', () => {
  const { bones, rig } = rigFixture();
  const body = solveBody(poseFixture(), handsFixture());
  rig.update(body, 1, 1, 1, { bodySmoothing: 0.001 });
  near(position(bones.leftHand), new Vector3(0.22, 1.785, 0.048));
});

test('face and hand translation, camera aspect, and independent hand world origins do not change placement', () => {
  for (const aspect of [1, 16 / 9]) {
    const { bones, rig } = rigFixture();
    const pose = poseFixture({ shoulders: false, aspect });
    const hands = handsFixture({ aspect });
    const face = faceFixture(aspect);
    for (const points of [face, ...hands.landmarks]) {
      for (const value of points) { value.x += 0.07; value.y += 0.08; }
    }
    // These hand-centered origins have no relation to the body's world origin.
    for (const points of hands.worldLandmarks) {
      for (const value of points) { value.x += 5; value.y -= 8; value.z += 3; }
    }
    const body = solveBody(pose, hands, {}, face);
    rig.update(body, 1, 1, 1, { bodySmoothing: 0.001 });
    near(position(bones.leftHand), new Vector3(0.22, 1.785, 0.096));
  }
});

test('visible elbows guide the bend while the detected hand remains the wrist position target', () => {
  const { bones, rig } = rigFixture();
  const body = solveBody(poseFixture({ elbows: true }), handsFixture(), {}, faceFixture());
  assert.ok(body.armTargets.left.elbowDirection);
  rig.update(body, 1, 1, 1, { bodySmoothing: 0.001 });
  near(position(bones.leftHand), new Vector3(0.22, 1.785, 0.096));
  near(position(bones.rightHand), new Vector3(-0.22, 1.785, 0.096));
});

test('crossed hands retain Tasks anatomical handedness when pose wrists are unavailable', () => {
  const { bones, rig } = rigFixture();
  const body = solveBody(poseFixture({ shoulders: false }), handsFixture({ crossed: true }), {}, faceFixture());
  rig.update(body, 1, 1, 1, { bodySmoothing: 0.001 });
  near(position(bones.leftHand), new Vector3(-0.22, 1.785, 0.096));
  near(position(bones.rightHand), new Vector3(0.22, 1.785, 0.096));
});

test('pose wrist proximity overrides incorrect classifier labels for crossed hands', () => {
  const { bones, rig } = rigFixture();
  const pose = poseFixture();
  const hands = handsFixture({ crossed: true });
  pose.landmarks[0][15] = { ...hands.landmarks[0][0] };
  pose.landmarks[0][16] = { ...hands.landmarks[1][0] };
  hands.handedness.reverse();
  const body = solveBody(pose, hands, {}, faceFixture());
  rig.update(body, 1, 1, 1, { bodySmoothing: 0.001 });
  near(position(bones.leftHand), new Vector3(-0.22, 1.785, 0));
  near(position(bones.rightHand), new Vector3(0.22, 1.785, 0));
});

test('wrist IK survives a bent torso and unusual bind axes, then palms and fingers retain their world targets', () => {
  const { bones, rig } = rigFixture({ arbitraryRest: true });
  const body = solveBody(poseFixture({ shoulders: false }), handsFixture(), {}, faceFixture());
  body.hips = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.2);
  body.torso = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.35);
  const face = { tracked: true, head: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -0.15).toArray() };
  rig.update(body, 1, 1, 1, { bodySmoothing: 0.001 }, face);
  const eyes = [position(bones.leftEye), position(bones.rightEye)];
  const eyeCenter = eyes[0].clone().add(eyes[1]).multiplyScalar(0.5);
  const scale = Math.hypot(eyes[0].x - eyes[1].x, eyes[0].y - eyes[1].y) / 0.072;
  near(position(bones.leftHand), eyeCenter.clone().add(new Vector3(0.22 * scale, -0.03 * scale, 0.048)));
  const finger = position(bones.leftIndexIntermediate).sub(position(bones.leftIndexProximal)).normalize();
  near(finger, body.directions.leftIndexProximal);
  const expectedPalm = body.palms.leftHand.clone().multiply(rig.rest.leftHand.palm.clone().invert()).multiply(rig.rest.leftHand.world);
  assert.ok(bones.leftHand.getWorldQuaternion(new Quaternion()).angleTo(expectedPalm) < 1e-5);
});

test('unreachable and coincident wrist targets clamp to real limb lengths without NaNs', () => {
  for (const target of [new Vector3(30, 40, 20), new Vector3()]) {
    const result = solveTwoBoneIK(new Vector3(), target, 0.3, 0.2, new Vector3(0, 1, 0));
    assert.ok(result.wrist.toArray().every(Number.isFinite));
    assert.ok(Math.abs(result.elbow.length() - 0.3) < 1e-8);
    assert.ok(Math.abs(result.wrist.distanceTo(result.elbow) - 0.2) < 1e-8);
    assert.ok(result.wrist.length() > 0.1 && result.wrist.length() < 0.5);
  }
  assert.equal(solveTwoBoneIK(new Vector3(), new Vector3(NaN, 0, 0), 0.3, 0.3), null);
  const { bones, rig } = rigFixture();
  const hands = handsFixture();
  hands.landmarks[0][0] = imagePoint(0.99, 0.01);
  const face = faceFixture();
  for (const value of face) value.x = 0.5 + (value.x - 0.5) * 0.25;
  const body = solveBody(poseFixture({ shoulders: false }), hands, {}, face);
  rig.update(body, 1, 1, 1, { bodySmoothing: 0.001 });
  const distance = position(bones.leftHand).distanceTo(position(bones.leftUpperArm));
  assert.ok(distance > 0.59 && distance < 0.6);
});

test('missing anchors hold placement briefly; fingers stay observable independently, stale arms release', () => {
  const { bones, rig } = rigFixture();
  const body = solveBody(poseFixture({ shoulders: false }), handsFixture(), {}, faceFixture());
  rig.update(body, 1, 1, 1, { bodySmoothing: 0.001 });
  const wrist = position(bones.leftHand);
  const missing = solveBody(poseFixture({ shoulders: false }), handsFixture());
  assert.equal(missing.armTargets.left.face, undefined);
  assert.equal(missing.armTargets.left.shoulders, undefined);
  assert.ok(missing.hands.left.fingers.Index);
  rig.update(missing, 1.2, 1.2, 0.1);
  near(position(bones.leftHand), wrist);
  for (let now = 1.5; now < 5; now += 0.05) rig.update(body, 1, now, 0.05);
  assert.ok(position(bones.leftHand).y < 1.1);
  assert.equal(rig.lastArmTargets.size, 0);
  const disabled = solveBody(poseFixture(), handsFixture(), { trackHands: false }, faceFixture());
  assert.deepEqual(disabled.armTargets, {});
  const offscreen = handsFixture();
  offscreen.landmarks[0][0].x = -0.1;
  assert.equal(solveBody(poseFixture(), offscreen, {}, faceFixture()).armTargets.left, undefined);
  const uncertain = handsFixture();
  uncertain.handedness[0][0].score = 0.3;
  assert.equal(solveBody(poseFixture({ shoulders: false }), uncertain, {}, faceFixture()).armTargets.left, undefined);
});

test('static wrists stay stable at 4fps through noise and intermittent shoulder/elbow detections', () => {
  const { bones, rig } = rigFixture();
  const state = new TrackingState();
  const positions = [];
  for (let sample = 0; sample < 48; sample++) {
    const time = 1 + sample * 0.25;
    const pose = poseFixture({ elbows: sample % 2 === 0, shoulders: sample % 4 !== 1 });
    const hands = handsFixture();
    hands.landmarks = hands.landmarks.map((points, side) => hands.worldLandmarks[side].map(p => ({
      x: points[0].x + p.x * .3 + Math.sin(sample * 2.3) * .003,
      y: points[0].y + p.y * .3 + Math.cos(sample * 1.7) * .003, z: p.z * .3,
    })));
    const frame = state.update({ pose, hands, time }, time + .22);
    const solution = solveBody(frame.pose, frame.hands, {}, faceFixture());
    for (let render = 0; render < 15; render++) {
      rig.update(solution, frame.time, frame.time + render / 60, 1 / 60);
      if (sample > 20) positions.push(position(bones.leftHand));
    }
  }
  for (const axis of ['x', 'y', 'z']) {
    const extent = Math.max(...positions.map(p => p[axis])) - Math.min(...positions.map(p => p[axis]));
    assert.ok(extent < .015, `stationary wrist ${axis} oscillated ${extent} m`);
  }
  assert.ok(Math.min(...positions.map(p => p.y)) > 1.75, 'slow results must not release the raised arm');
});

test('a corrected physical hand releases its old arm instead of leaving two raised IK targets', () => {
  for (const [from, to] of [['left','right'],['right','left']]) {
    const { bones, rig } = rigFixture();
    const initial = solveBody(poseFixture({shoulders:false}), handsFixture(), {}, faceFixture());
    delete initial.armTargets[to]; delete initial.hands[to];
    initial.armTargets[from].physicalId = 42;
    rig.update(initial, 1, 1, 1, {bodySmoothing:.001});
    const next = solveBody(poseFixture({shoulders:false}), handsFixture(), {}, faceFixture());
    delete next.armTargets[from]; delete next.hands[from];
    next.armTargets[to].physicalId = 42;
    // Physical ID alone prevents an old arm hold, even if release metadata
    // was missed by an output window receiving fewer packets than the camera.
    for (let i=0;i<15;i++) rig.update(next,1.05,1.05+i/60,1/60,{bodySmoothing:.02});
    assert.equal(rig.lastArmTargets.has(from),false);
    assert.equal(rig.lastArmTargets.has(to),true);
    assert.ok(position(bones[`${from}Hand`]).y<1.2,'old incorrectly assigned arm must lower promptly');
    assert.ok(position(bones[`${to}Hand`]).y>1.7,'correct arm continues following the observed hand');
  }
});

test('a newly visible lowered arm overrides the held raised hand position immediately', () => {
  const { bones, rig } = rigFixture();
  const raised = solveBody(poseFixture(), handsFixture(), {}, faceFixture());
  rig.update(raised,1,1,1,{bodySmoothing:.001});
  const lower = solveBody(null,null);
  lower.directions.rightUpperArm = new Vector3(-.15,-1,0).normalize();
  lower.directions.rightLowerArm = new Vector3(0,-1,0);
  rig.update(lower,1.1,1.1,.1,{bodySmoothing:.02});
  assert.equal(rig.lastArmTargets.has('right'),false);
  assert.ok(position(bones.rightHand).y<1.15,'fresh Pose evidence must replace the old IK hold');
});
