import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Object3D, Vector3 } from 'three';
import { VRMHumanoid } from '@pixiv/three-vrm';
import { TrackingState } from '../docs/fullbody/tracking-state.js';
import { BodyRetargeter, solveBody, TRACKED_BONES } from '../docs/fullbody/body.js';

const photo = JSON.parse(readFileSync(new URL('./fixtures/pointing-up-landmarks.json', import.meta.url)));

function sampleRig() {
  // Rebuild the shipped GLB's original transforms and humanoid mapping. There
  // are no authored test finger axes: these are the avatar's actual raw bones.
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
  const humanBones = Object.fromEntries(Object.entries(json.extensions.VRMC_vrm.humanoid.humanBones)
    .map(([name, { node }]) => [name, { node: nodes[node] }]));
  const humanoid = new VRMHumanoid(humanBones);
  scene.add(humanoid.normalizedHumanBonesRoot);
  const normalized = Object.fromEntries(TRACKED_BONES.map(name => [name, humanoid.getNormalizedBoneNode(name)]));
  return {
    humanoid,
    rig: new BodyRetargeter(normalized),
    raw: Object.fromEntries(Object.entries(humanBones).map(([name, { node }]) => [name, node])),
  };
}

function physicalFinger(raw, side, finger) {
  const proximal = raw[`${side}${finger}Proximal`].getWorldPosition(new Vector3());
  const intermediate = raw[`${side}${finger}Intermediate`].getWorldPosition(new Vector3());
  const distal = raw[`${side}${finger}Distal`].getWorldPosition(new Vector3());
  const first = intermediate.clone().sub(proximal).normalize();
  const second = distal.clone().sub(intermediate).normalize();
  return { first, second, bend: first.angleTo(second) };
}

for (const side of ['right', 'left']) {
  test(`official pointing photograph reaches ${side} raw VRM fingers without any torso or face anchor`, () => {
    const { humanoid, rig, raw } = sampleRig();
    // A reflection of the official right-hand geometry is an anatomical left
    // hand. Finger state is unchanged, while the flexion hinge must reverse.
    const reflected = side === 'left';
    const hands = {
      landmarks: [photo.landmarks.map(point => ({ ...point, x: reflected ? 1 - point.x : point.x }))],
      worldLandmarks: [photo.worldLandmarks.map(point => ({ ...point, x: reflected ? -point.x : point.x }))],
      handedness: [[{ categoryName: reflected ? 'Left' : 'Right', score: 1 }]],
    };
    const solution = solveBody(null, hands);
    assert.equal(solution.hips, null);
    assert.equal(solution.torso, null);
    assert.ok(solution.hands[side], 'finger measurements survive absent pose/face');
    assert.ok(solution.armTargets[side].face == null);
    assert.ok(solution.armTargets[side].shoulders == null);
    rig.update(solution, 1, 1, 1, { bodySmoothing: 0.001 });
    humanoid.update();
    assert.equal(rig.lastArmTargets.size, 0, 'no wrist position is invented without any body reference');

    // Check physical raw-bone segment geometry, after normalized-to-raw VRM
    // transfer. Reading solver curl values or normalized local quaternions
    // would miss axis errors in the final avatar.
    const index = physicalFinger(raw, side, 'Index');
    assert.ok(index.bend < 0.3, `the photographed straight index stays straight (${index.bend} rad)`);
    const indexRoot = raw[`${side}IndexProximal`].getWorldPosition(new Vector3());
    const littleRoot = raw[`${side}LittleProximal`].getWorldPosition(new Vector3());
    const hinge = indexRoot.sub(littleRoot).normalize();
    const ventral = side === 'right' ? 1 : -1;
    const before = {};
    for (const finger of ['Middle', 'Ring', 'Little']) {
      const physical = physicalFinger(raw, side, finger);
      assert.ok(physical.bend > 0.9 && physical.bend < 1.9, `${finger} bends independently of index (${physical.bend} rad)`);
      assert.ok(ventral * hinge.dot(physical.first.clone().cross(physical.second)) > 0.55, `${finger} bends toward the palm, not backward`);
      before[finger] = physical.bend;
    }

    // Repeated rendering of one received frame must neither accumulate twist
    // nor straighten the fingers as the idle arms settle underneath the wrist.
    for (let frame = 1; frame <= 20; frame++) {
      rig.update(solution, 1, 1 + frame / 60, 1 / 60, { bodySmoothing: 0.08 });
      humanoid.update();
    }
    assert.ok(physicalFinger(raw, side, 'Index').bend < 0.3);
    for (const finger of ['Middle', 'Ring', 'Little']) {
      assert.ok(Math.abs(physicalFinger(raw, side, finger).bend - before[finger]) < 1e-5, `${finger} physical angle remains steady between detections`);
    }
  });
}

const native = JSON.parse(readFileSync(new URL('./fixtures/pointing-up-native.json', import.meta.url))).result;

test('unmodified SDK hand result reaches a raised raw VRM wrist and fingers through the full observation pipeline', () => {
  const { humanoid, rig, raw } = sampleRig();
  const input = structuredClone(native);
  // A controlled face location anchors the photographed wrist beside the head.
  // Its zero visibility reproduces the native Face container as well.
  const face = Array.from({length:478},()=>({x:.65,y:.7,z:0,visibility:0}));
  for (const [index,x] of [[33,.604],[133,.624],[362,.676],[263,.696]]) face[index].x=x;
  const observation = new TrackingState().update(input, input.time + .1);
  assert.equal(observation.hands.landmarks[0][0].visibility, 0);
  const solved = solveBody({...observation.pose,imageWidth:720,imageHeight:720}, observation.hands,
    {minVisibility:.9}, face);
  assert.ok(solved.armTargets.right?.face, 'SDK hand and face defaults must reach wrist IK');
  assert.ok(solved.hands.right?.fingers.Index, 'SDK defaults must reach finger articulation');
  rig.update(solved, observation.time, observation.time, 1, {bodySmoothing:.001});
  humanoid.update();
  const wrist = raw.rightHand.getWorldPosition(new Vector3());
  const target = rig.imageWristTarget(solved.armTargets.right);
  assert.ok(wrist.distanceTo(target)<.005, 'the actual raw VRM wrist reaches the image-derived target');
  assert.ok(wrist.y>raw.chest.getWorldPosition(new Vector3()).y+.1, 'hand is raised, not at the waist');
  assert.ok(physicalFinger(raw,'right','Index').bend<.4);
  for(const finger of ['Middle','Ring','Little']) assert.ok(physicalFinger(raw,'right',finger).bend>.7);

  // A zero Pose score IS meaningful. Do not fix Hands by disabling all scores.
  const pose={landmarks:[Array.from({length:33},()=>({x:.5,y:.5,z:0,visibility:0}))],
    worldLandmarks:[Array.from({length:33},()=>({x:0,y:0,z:0,visibility:0}))]};
  const rejected=solveBody(pose,observation.hands,{},face);
  assert.equal(rejected.tracked,false);
  assert.equal(rejected.hips,null);
  assert.equal(rejected.directions.leftUpperArm,undefined);
  assert.ok(rejected.armTargets.right.face);
});

test('native zero-visibility hand articulation is filtered without changing its confidence metadata', () => {
  const state=new TrackingState();
  const input=structuredClone(native);
  const before=state.update(input,input.time+.1);
  const original=before.hands.worldLandmarks[0][6].y;
  input.time+=1/30;
  input.hands.worldLandmarks[0][6].y+=.006;
  const after=state.update(input,input.time+.1);
  const change=after.hands.worldLandmarks[0][6].y-original;
  assert.ok(change>0&&change<.0055,'real hand points must not bypass articulation smoothing');
  assert.equal(after.hands.worldLandmarks[0][6].visibility,0);
});
