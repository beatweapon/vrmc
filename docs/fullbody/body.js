import { Matrix4, Quaternion, Vector3 } from 'three';
import { solveTwoBoneIK } from './arm-ik.js';
import { measureHand, HandRetargeter } from './hand-rig.js';

const IDENTITY = new Quaternion();
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const smoothingAlpha = (dt, seconds) => 1 - Math.exp(-Math.max(0, dt) / Math.max(0.001, seconds));

// MediaPipe's x-right, y-down, z-away becomes our x-right, y-up, z-toward-camera.
export function landmarkVector(point) {
  return point && [point.x, point.y, point.z].every(Number.isFinite)
    ? new Vector3(point.x, -point.y, -point.z) : null;
}

function visible(points, indices, threshold) {
  return indices.every(index => {
    const point = points?.[index];
    return landmarkVector(point) && (point.visibility ?? 1) >= threshold && (point.presence ?? 1) >= threshold;
  });
}

// Hand/Face tasks do not estimate per-landmark visibility. The JS container
// still emits visibility: 0 for them; only Pose scores carry that meaning.
// Check geometry here, never apply Pose confidence gates to Hand/Face points.
function imagePointsValid(points, indices) {
  return indices.every(index => {
    const point = points?.[index];
    return landmarkVector(point) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
  });
}

function inFrame(points, indices, threshold) {
  if (!points) return true;
  return visible(points, indices, threshold) && imagePointsValid(points, indices);
}

function poseVisible(pose, indices, threshold) {
  return visible(pose?.worldLandmarks?.[0], indices, threshold) && inFrame(pose?.landmarks?.[0], indices, threshold);
}

function imageAspect(pose) {
  return Number.isFinite(pose?.imageWidth) && Number.isFinite(pose?.imageHeight) && pose.imageWidth > 0 && pose.imageHeight > 0
    ? pose.imageWidth / pose.imageHeight : 1;
}

function direction(points, from, to) {
  const a = landmarkVector(points[from]);
  const b = landmarkVector(points[to]);
  const result = b.sub(a);
  return result.lengthSq() > 1e-8 ? result.normalize() : null;
}

function midpoint(points, a, b) {
  return landmarkVector(points[a]).add(landmarkVector(points[b])).multiplyScalar(0.5);
}

/** A stable right-handed frame, rejecting collapsed or nearly parallel axes. */
export function basisQuaternion(across, up) {
  if (across.lengthSq() < 1e-8 || up.lengthSq() < 1e-8) return null;
  const x = across.clone().normalize();
  const z = x.clone().cross(up).normalize();
  if (z.lengthSq() < 0.5 || Math.abs(x.dot(up.clone().normalize())) > 0.97) return null;
  const y = z.clone().cross(x).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z)).normalize();
}

export function worldToLocalQuaternion(parentWorld, desiredWorld) {
  return parentWorld.clone().invert().multiply(desiredWorld).normalize();
}

export function directionWorldQuaternion(restDirection, desiredDirection, restWorld) {
  return new Quaternion().setFromUnitVectors(restDirection.clone().normalize(), desiredDirection.clone().normalize())
    .multiply(restWorld).normalize();
}

const LIMBS = {
  leftUpperArm: [11, 13], leftLowerArm: [13, 15], rightUpperArm: [12, 14], rightLowerArm: [14, 16],
  leftUpperLeg: [23, 25], leftLowerLeg: [25, 27], rightUpperLeg: [24, 26], rightLowerLeg: [26, 28],
  leftFoot: [27, 31], rightFoot: [28, 32],
};
const FINGERS = {
  Thumb: { indices: [1, 2, 3, 4], joints: ['Metacarpal', 'Proximal', 'Distal'] },
  Index: { indices: [5, 6, 7, 8], joints: ['Proximal', 'Intermediate', 'Distal'] },
  Middle: { indices: [9, 10, 11, 12], joints: ['Proximal', 'Intermediate', 'Distal'] },
  Ring: { indices: [13, 14, 15, 16], joints: ['Proximal', 'Intermediate', 'Distal'] },
  Little: { indices: [17, 18, 19, 20], joints: ['Proximal', 'Intermediate', 'Distal'] },
};

// Tasks HandLandmarker labels anatomical sides on our unmirrored input. Unlike
// legacy MediaPipe Hands, its class-label map must NOT receive a selfie swap.
// https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/cc/vision/hand_landmarker/hand_landmarks_detector_graph.cc
// Pose wrist proximity takes precedence, including when the hands cross.
function assignHands(hands, pose, threshold) {
  const candidates = [];
  const classified = [];
  const imagePose = pose?.landmarks?.[0];
  for (let index = 0; index < (hands?.worldLandmarks?.length ?? 0); index++) {
    const wrist = hands.landmarks?.[index]?.[0];
    if (!imagePointsValid([wrist], [0])) continue;
    const category = (hands.handedness ?? hands.handednesses)?.[index]?.[0];
    for (const [side, joint] of [['left', 15], ['right', 16]]) {
      if (!hands.identitiesStable && wrist && imagePose && inFrame(imagePose, [joint], threshold)) {
        const distance = Math.hypot((wrist.x - imagePose[joint].x) * imageAspect(pose), wrist.y - imagePose[joint].y);
        if (distance < 0.2) candidates.push({ side, index, distance });
      }
      if ((hands.identitiesStable || (category?.score ?? 0) >= 0.65) && category?.categoryName?.toLowerCase() === side)
        classified.push({ side, index, distance: 2 - (category.score ?? 0) });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  classified.sort((a, b) => a.distance - b.distance);
  const assigned = new Map();
  const used = new Set();
  for (const candidate of [...candidates, ...classified]) {
    if (!assigned.has(candidate.side) && !used.has(candidate.index)) {
      assigned.set(candidate.side, { world: hands.worldLandmarks[candidate.index], image: hands.landmarks[candidate.index],
        physicalId: hands.physicalTrackingIds?.[candidate.index] });
      used.add(candidate.index);
    }
  }
  return assigned;
}

// These anchors use only normalized image coordinates. Hand world landmarks are
// centered on that hand; adding them to pose or face world coordinates is invalid.
function imageAnchors(pose, face, threshold) {
  const aspect = imageAspect(pose);
  const image = pose?.landmarks?.[0];
  const anchors = { aspect };
  if (image && inFrame(image, [11, 12], threshold)) {
    const span = Math.hypot((image[11].x - image[12].x) * aspect, image[11].y - image[12].y);
    if (span > 0.04) anchors.shoulders = {
      x: (image[11].x + image[12].x) / 2, y: (image[11].y + image[12].y) / 2, span,
    };
    if (anchors.shoulders && visible(pose?.worldLandmarks?.[0],[11,12],threshold)) {
      const across=landmarkVector(pose.worldLandmarks[0][11]).sub(landmarkVector(pose.worldLandmarks[0][12]));
      anchors.shoulders.foreshorten=clamp(Math.hypot(across.x,across.y)/Math.max(.01,across.length()),.25,1);
    }
  }
  if (imagePointsValid(face, [33, 133, 362, 263])) {
    const left = { x: (face[362].x + face[263].x) / 2, y: (face[362].y + face[263].y) / 2 };
    const right = { x: (face[33].x + face[133].x) / 2, y: (face[33].y + face[133].y) / 2 };
    const span = Math.hypot((left.x - right.x) * aspect, left.y - right.y);
    if (span > 0.015) {
      const dz=((face[362].z+face[263].z)-(face[33].z+face[133].z))*.5*aspect;
      anchors.face = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2, span,
        foreshorten:clamp(span/Math.hypot(span,dz),.25,1) };
    }
  }
  return anchors;
}

export function solveBody(pose, hands, settings = {}, faceLandmarks = null) {
  const threshold = settings.minVisibility ?? 0.55;
  const points = pose?.worldLandmarks?.[0];
  const result = { hips: null, torso: null, directions: {}, palms: {}, hands:{}, armTargets: {},
    releasedSides: (hands?.releasedSides ?? []).filter(side => side === 'left' || side === 'right'), tracked: false, legTracked: false };
  if (poseVisible(pose, [11, 12, 23, 24], threshold)) {
    const up = midpoint(points, 11, 12).sub(midpoint(points, 23, 24));
    // Hip landmarks constrain yaw/roll but cannot determine pelvic pitch on their own.
    // Let the spine carry most forward bending instead of tilting the entire body as a block.
    const pelvisUp = new Vector3(0, 1, 0).lerp(up.clone().normalize(), 0.2);
    result.hips = basisQuaternion(landmarkVector(points[23]).sub(landmarkVector(points[24])), pelvisUp);
    result.torso = basisQuaternion(landmarkVector(points[11]).sub(landmarkVector(points[12])), up);
    result.tracked = !!(result.hips && result.torso);
  }
  // A desk/upper-body view must not disable the torso just because hips are
  // cropped. Shoulders define across; visible head points define the up axis.
  if (!result.torso && poseVisible(pose,[11,12],threshold)) {
    const across=landmarkVector(points[11]).sub(landmarkVector(points[12]));
    const shoulders=midpoint(points,11,12);
    let up=new Vector3(0,1,0);
    if (poseVisible(pose,[7,8],threshold)) up=midpoint(points,7,8).sub(shoulders);
    else if (poseVisible(pose,[0],threshold)) up=landmarkVector(points[0]).sub(shoulders);
    else {
      const anchors=imageAnchors(pose,faceLandmarks,threshold);
      if (anchors.face && anchors.shoulders) up.set((anchors.face.x-anchors.shoulders.x)*anchors.aspect,
        anchors.shoulders.y-anchors.face.y,0);
    }
    result.torso=basisQuaternion(across,up);
    result.tracked=!!result.torso;
  }
  for (const [name, indices] of Object.entries(LIMBS)) {
    if (settings.seated && /Leg|Foot/.test(name)) continue;
    if (poseVisible(pose, indices, threshold)) {
      const vector = direction(points, ...indices);
      if (vector) result.directions[name] = vector;
    }
  }
  result.legTracked = !settings.seated && poseVisible(pose, [23, 24, 25, 26, 27, 28], threshold);
  if (settings.trackHands !== false) {
    const anchors = imageAnchors(pose, faceLandmarks, threshold);
    for (const [side, { world: hand, image, physicalId }] of assignHands(hands, pose, threshold)) {
      if (!visible(hand, [0, 5, 9, 17], 0)) continue;
      const wristIndex=side==='left'?15:16;
      // One position path for the observed hand, with the measured elbow as
      // the bend hint. Crossing a visibility threshold no longer switches
      // between unrelated FK and IK wrist targets every other frame.
      result.armTargets[side] = {
        ...anchors, wrist: { x: image[0].x, y: image[0].y }, physicalId,
        elbowDirection: result.directions[`${side}UpperArm`]?.clone() ?? null,
      };
      if (poseVisible(pose,[11,12,wristIndex],threshold)) {
        const imageWrist=pose.landmarks?.[0]?.[wristIndex];
        if (imageWrist && Math.hypot((imageWrist.x-image[0].x)*anchors.aspect,imageWrist.y-image[0].y)<.12) {
          const shoulderSpan=visible(points,[11,12],threshold)?landmarkVector(points[11]).distanceTo(landmarkVector(points[12])):.4;
          result.armTargets[side].depthRatio=clamp((landmarkVector(points[wristIndex]).z-midpoint(points,11,12).z)/Math.max(.1,shoulderSpan),-1.5,1.5);
        }
      }
      // Finger articulation is independent of whether the torso can be found.
      result.hands[side]=measureHand(hand,side);
      // Both data/model palm bases use index-to-little across and wrist-to-middle forward.
      const across = landmarkVector(hand[5]).sub(landmarkVector(hand[17]));
      const forward = landmarkVector(hand[9]).sub(landmarkVector(hand[0]));
      const palm = basisQuaternion(across, forward);
      if (palm) result.palms[`${side}Hand`] = palm;
      for (const [finger, { indices, joints }] of Object.entries(FINGERS)) {
        for (let joint = 0; joint < joints.length; joint++) {
          if (visible(hand, [indices[joint], indices[joint + 1]], 0)) {
            const vector = direction(hand, indices[joint], indices[joint + 1]);
            if (vector) result.directions[`${side}${finger}${joints[joint]}`] = vector;
          }
        }
      }
    }
  }
  return result;
}

export function calibrateBody(pose, threshold = 0.55) {
  const world = pose?.worldLandmarks?.[0];
  const image = pose?.landmarks?.[0];
  if (!image || !poseVisible(pose, [11, 12, 23, 24], threshold)) {
    throw new Error('肩と腰をカメラに映してから、もう一度キャリブレーションしてください。');
  }
  const hipImage = midpoint(image, 23, 24);
  const shoulderImage = midpoint(image, 11, 12);
  const torsoWorld = midpoint(world, 11, 12).distanceTo(midpoint(world, 23, 24));
  const aspect = imageAspect(pose);
  // Normalized x is measured in image widths, y in image heights: use height units for both.
  const torsoImage = Math.hypot((shoulderImage.x - hipImage.x) * aspect, shoulderImage.y - hipImage.y);
  if (torsoWorld < 0.1 || torsoImage < 0.03) throw new Error('体が小さすぎます。カメラに少し近づいてください。');
  const feetVisible = poseVisible(pose, [27, 28], threshold);
  const hips = midpoint(world, 23, 24);
  const legHeight = feetVisible ? hips.y - Math.min(landmarkVector(world[27]).y, landmarkVector(world[28]).y) : null;
  return { version: 1, hipX: hipImage.x, hipY: -hipImage.y, torsoImage, torsoWorld, legHeight, imageAspect: aspect };
}

export function validateBodyCalibration(value) {
  return !!value && value.version === 1 && ['hipX', 'hipY', 'torsoImage', 'torsoWorld'].every(key => Number.isFinite(value[key]))
    && value.torsoImage > 0.03 && value.torsoWorld > 0.1
    && (value.legHeight === null || (Number.isFinite(value.legHeight) && value.legHeight > 0));
}

export function rootOffset(pose, calibration, modelTorsoLength, settings = {}) {
  if (!validateBodyCalibration(calibration) || settings.rootMotion === false) return null;
  const threshold = settings.minVisibility ?? 0.55;
  const image = pose?.landmarks?.[0];
  const points = pose?.worldLandmarks?.[0];
  if (!image || !poseVisible(pose, [23, 24], threshold)) return null;
  const hip = midpoint(image, 23, 24);
  const scale = clamp(settings.motionScale ?? 1, 0, 2);
  // Pixel motion uses calibrated torso height; monocular depth translation is intentionally omitted.
  const x = clamp((hip.x - calibration.hipX) * imageAspect(pose) * modelTorsoLength / calibration.torsoImage, -1.2, 1.2) * scale;
  let y = 0;
  if (!settings.seated && calibration.legHeight && poseVisible(pose, [23, 24, 27, 28], threshold)) {
    const height = midpoint(points, 23, 24).y - Math.min(landmarkVector(points[27]).y, landmarkVector(points[28]).y);
    y = clamp((height - calibration.legHeight) * modelTorsoLength / calibration.torsoWorld, -0.8, 0.25) * scale;
  }
  return new Vector3(x, y, 0);
}

const CHILDREN = {
  hips: 'spine', spine: 'chest', chest: 'upperChest', upperChest: 'neck', neck: 'head',
  leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand', rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand',
  leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot', rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot',
  leftFoot: 'leftToes', rightFoot: 'rightToes',
};
for (const side of ['left', 'right']) {
  for (const [finger, { joints }] of Object.entries(FINGERS)) {
    joints.forEach((joint, index) => { CHILDREN[`${side}${finger}${joint}`] = `${side}${finger}${joints[index + 1] ?? 'Tip'}`; });
  }
}
export const TRACKED_BONES = [...new Set([...Object.keys(CHILDREN), ...Object.values(CHILDREN), 'leftHand', 'rightHand', 'head', 'leftEye', 'rightEye'])]
  .filter(name => !name.endsWith('Tip'));

/** Retarget against the model's captured rest axes, then remove each animated parent. */
export class BodyRetargeter {
  constructor(bones) {
    this.bones = bones;
    this.rest = {};
    this.last = new Map();
    this.lastArmTargets = new Map();
    this.releasedArmTimes = new Map();
    this.imageReference = {};
    this.handRig = new HandRetargeter(bones);
    for (const [name, bone] of Object.entries(bones)) {
      if (!bone) continue;
      bone.updateWorldMatrix(true, false);
      this.rest[name] = {
        local: bone.quaternion.clone(), world: bone.getWorldQuaternion(new Quaternion()),
        position: bone.getWorldPosition(new Vector3()),
      };
    }
    for (const [name, rest] of Object.entries(this.rest)) {
      const child = this.rest[CHILDREN[name]];
      if (child) rest.direction = child.position.clone().sub(rest.position).normalize();
      else if (/Distal/.test(name)) {
        const previous = name.replace('Distal', name.includes('Thumb') ? 'Proximal' : 'Intermediate');
        const previousRest = this.rest[previous];
        if (previousRest) rest.direction = rest.position.clone().sub(previousRest.position).normalize();
      } else if (/Foot/.test(name)) rest.direction = new Vector3(0, -0.15, 1).normalize();
      if (/Hand/.test(name)) {
        const side = name.startsWith('left') ? 'left' : 'right';
        const index = this.rest[`${side}IndexProximal`];
        const little = this.rest[`${side}LittleProximal`];
        const middle = this.rest[`${side}MiddleProximal`];
        if (index && little && middle) rest.palm = basisQuaternion(index.position.clone().sub(little.position), middle.position.clone().sub(rest.position));
      }
      rest.idle = rest.local.clone();
      if (/UpperArm/.test(name) && rest.direction) {
        const sign = name.startsWith('left') ? 1 : -1;
        const world = directionWorldQuaternion(rest.direction, new Vector3(sign * 0.28, -0.96, 0).normalize(), rest.world);
        const parent = bones[name].parent?.getWorldQuaternion(new Quaternion()) ?? IDENTITY;
        rest.idle = worldToLocalQuaternion(parent, world);
      }
    }
    const hips = this.rest.hips?.position;
    const upper = this.rest.upperChest?.position ?? this.rest.chest?.position ?? this.rest.neck?.position;
    this.torsoLength = hips && upper ? Math.max(0.15, hips.distanceTo(upper)) : 0.45;
    const shoulderLeft = this.rest.leftUpperArm?.position;
    const shoulderRight = this.rest.rightUpperArm?.position;
    this.shoulderWidth = shoulderLeft && shoulderRight ? shoulderLeft.distanceTo(shoulderRight) : this.torsoLength * 0.8;
    // Eye bones give an avatar-specific face anchor (also works for stylized VRMs).
    // Expression-only faces have no eye bones, so use conservative body proportions.
    const head = this.bones.head;
    if (head) {
      const headPosition = this.rest.head.position;
      this.eyeOffsets = ['left', 'right'].map((side, index) => {
        const eye = this.rest[`${side}Eye`]?.position ?? headPosition.clone().add(
          new Vector3((index === 0 ? 1 : -1) * this.shoulderWidth * 0.09, this.torsoLength * 0.15, this.shoulderWidth * 0.12)
            .applyQuaternion(this.rest.head.world),
        );
        return head.worldToLocal(eye.clone());
      });
      this.eyeWidth = this.eyeOffsets[0].distanceTo(this.eyeOffsets[1]);
    }
  }

  apply(name, desiredWorld, sampleTime, now, dt, settings = {}, forceRest = false) {
    const parent = this.bones[name]?.parent?.getWorldQuaternion(new Quaternion()) ?? IDENTITY;
    const local = desiredWorld ? worldToLocalQuaternion(parent, desiredWorld) : null;
    this.applyLocal(name, local, sampleTime, now, dt, settings, forceRest);
  }

  applyLocal(name, desiredLocal, sampleTime, now, dt, settings = {}, forceRest = false) {
    const bone = this.bones[name];
    const rest = this.rest[name];
    if (!bone || !rest) return;
    const freshness = now - sampleTime;
    if (!forceRest && desiredLocal && freshness >= -0.1 && freshness < 0.4) {
      this.last.set(name, { rotation: desiredLocal, time: sampleTime });
    }
    const recent = this.last.get(name);
    const holding = !forceRest && recent && now - recent.time <= 0.4;
    const target = holding ? recent.rotation : (forceRest ? rest.local : rest.idle);
    const side = name.startsWith('left') ? 'left' : 'right';
    const correctedArm = /UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little/.test(name)
      && now - (this.releasedArmTimes.get(side) ?? -Infinity) < 0.3;
    bone.quaternion.slerp(target, smoothingAlpha(dt, holding ? (settings.bodySmoothing ?? 0.12) : correctedArm ? 0.06 : 0.45));
    bone.updateWorldMatrix(false, false);
    if (forceRest) this.last.delete(name);
  }

  update(solution, sampleTime, now, dt, settings = {}, face = undefined) {
    if (this.releaseSolution !== solution) {
      this.releaseSolution = solution;
      for (const side of solution.releasedSides ?? []) this.releaseArm(side, now);
    }
    // A physical hand moving to its corrected anatomical side cannot remain
    // held by the old arm while driving the new arm at the same time.
    for (const [side, anchor] of Object.entries(solution.armTargets ?? {})) {
      const other = side === 'left' ? 'right' : 'left';
      if (anchor.physicalId != null && this.lastArmTargets.get(other)?.physicalId === anchor.physicalId) this.releaseArm(other, now);
    }
    const hips = solution.hips;
    this.apply('hips', hips && hips.clone().multiply(this.rest.hips?.world ?? IDENTITY), sampleTime, now, dt, settings);
    const torsoNames = ['spine', 'chest', 'upperChest'].filter(name => this.bones[name]);
    torsoNames.forEach((name, index) => {
      const orientation = solution.torso ? (hips ?? IDENTITY).clone().slerp(solution.torso, (index + 1) / torsoNames.length).multiply(this.rest[name].world) : null;
      this.apply(name, orientation, sampleTime, now, dt, settings);
    });
    // Establish the head's current world position before anchoring a hand to it.
    if (face !== undefined) this.updateHead(face, sampleTime, now, dt, settings);
    const fallbackArms = new Set();
    for (const side of ['left', 'right']) {
      if (settings.trackHands === false) {
        this.lastArmTargets.delete(side);
      } else if (!solution.armTargets?.[side] && solution.directions[`${side}UpperArm`] && solution.directions[`${side}LowerArm`]) {
        // A visible lowering arm is new evidence, not a hand-detector dropout
        // to hold in its previous raised IK pose.
        this.lastArmTargets.delete(side);
      } else if (this.updateArmTarget(side, solution.armTargets?.[side], sampleTime, now, dt, settings)) {
        fallbackArms.add(side);
      }
    }
    // Order is proximal-to-distal so each local target sees its current animated parent.
    for (const name of Object.keys(CHILDREN)) {
      if (/^(hips|spine|chest|upperChest|neck)$/.test(name) || /Thumb|Index|Middle|Ring|Little/.test(name)) continue;
      if (/UpperArm|LowerArm/.test(name) && fallbackArms.has(name.startsWith('left') ? 'left' : 'right')) continue;
      const rest = this.rest[name];
      const vector = solution.directions[name];
      const desired = rest?.direction && vector ? directionWorldQuaternion(rest.direction, vector, rest.world) : null;
      const forceRest = (settings.seated && /Leg|Foot/.test(name)) || (settings.trackHands === false && /Thumb|Index|Middle|Ring|Little/.test(name));
      this.apply(name, desired, sampleTime, now, dt, settings, forceRest);
    }
    // Palms precede fingers so finger targets use the current wrist orientation.
    for (const side of ['left', 'right']) {
      const name = `${side}Hand`;
      const hand = this.handRig.solve(solution.hands?.[side]);
      this.apply(name, hand.wristWorld, sampleTime, now, dt, settings, settings.trackHands === false);
      for (const [finger, { joints }] of Object.entries(FINGERS)) {
        for (const joint of joints) {
          const name = `${side}${finger}${joint}`;
          this.applyLocal(name, hand.rotations.get(name), sampleTime, now, dt, settings, settings.trackHands === false);
        }
      }
    }
  }

  releaseArm(side, now) {
    if (side !== 'left' && side !== 'right') return;
    this.lastArmTargets.delete(side);
    for (const name of this.last.keys()) {
      if (name.startsWith(side) && /UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little/.test(name)) this.last.delete(name);
    }
    this.releasedArmTimes.set(side, now);
  }

  imageWristTarget(anchor, sampleTime = null) {
    if (!anchor) return null;
    const reference = this.imageReference;
    const remember = Number.isFinite(sampleTime);
    // A brief shoulder/face dropout keeps the same reference. It must not
    // change scale on every frame as the detector crosses its visibility gate.
    const anchors = { ...anchor };
    if (remember) for (const name of ['face', 'shoulders']) {
      if (anchor[name]) reference[name] = { value: anchor[name], time: sampleTime };
      else if (sampleTime - (reference[name]?.time ?? -Infinity) < 0.4) anchors[name] = reference[name].value;
    }
    const left = this.bones.leftUpperArm?.getWorldPosition(new Vector3());
    const right = this.bones.rightUpperArm?.getWorldPosition(new Vector3());
    let origin, imageOrigin, scale;
    if (anchors.shoulders && left && right) {
      origin = left.clone().add(right).multiplyScalar(0.5);
      imageOrigin = anchors.shoulders;
      scale = this.shoulderWidth * (anchors.shoulders.foreshorten ?? 1) / anchors.shoulders.span;
    }
    if (anchors.face && this.bones.head && this.eyeOffsets) {
      const eyes = this.eyeOffsets.map(offset => this.bones.head.localToWorld(offset.clone()));
      origin = eyes[0].clone().add(eyes[1]).multiplyScalar(0.5);
      imageOrigin = anchors.face;
      scale ??= this.eyeWidth * (anchors.face.foreshorten ?? 1) / anchors.face.span;
    }
    if (!origin || !Number.isFinite(scale) || scale <= 0) return null;
    // Scale comes from fixed avatar proportions and OBSERVED foreshortening,
    // never from the animated avatar. The latter feeds head/body lag back into
    // wrist placement and makes a stationary hand sway indefinitely.
    if (remember) {
      if (reference.scaleTime !== sampleTime) {
        const elapsed = sampleTime - (reference.scaleTime ?? -Infinity);
        reference.scale = elapsed > 0.8 ? scale : reference.scale +
          (scale - reference.scale) * smoothingAlpha(elapsed, 0.18);
        reference.scaleTime = sampleTime;
      }
      scale = reference.scale;
    }
    const target = origin.add(new Vector3(
      (anchor.wrist.x - imageOrigin.x) * anchor.aspect * scale,
      -(anchor.wrist.y - imageOrigin.y) * scale,
      this.shoulderWidth * 0.12,
    ));
    if (Number.isFinite(anchor.depthRatio) && left && right) {
      target.z = (left.z + right.z) / 2 + anchor.depthRatio * this.shoulderWidth;
    }
    return target;
  }

  updateArmTarget(side, anchor, sampleTime, now, dt, settings) {
    const upperName = side + 'UpperArm';
    const lowerName = side + 'LowerArm';
    const upper = this.bones[upperName];
    const lower = this.bones[lowerName];
    const hand = this.bones[side + 'Hand'];
    if (!upper || !lower || !hand) return false;
    const shoulder = upper.getWorldPosition(new Vector3());
    const elbow = lower.getWorldPosition(new Vector3());
    const wrist = hand.getWorldPosition(new Vector3());
    const upperLength = shoulder.distanceTo(elbow);
    const lowerLength = elbow.distanceTo(wrist);
    const reach = upperLength + lowerLength - Math.min(upperLength, lowerLength) * 0.001;
    const fresh = now - sampleTime >= -0.1 && now - sampleTime < 0.4;
    const defaultBend = new Vector3(side === 'left' ? 0.45 : -0.45, -1, 0.15).normalize();
    let recent = this.lastArmTargets.get(side);
    if (anchor && fresh) {
      const target = this.imageWristTarget(anchor, sampleTime);
      if (target) {
        if (!recent || now - recent.time > 0.4) {
          recent = { offset: wrist.clone().sub(shoulder), bendHint: defaultBend.clone(), time: sampleTime, elbowTime: -Infinity };
        }
        const offset = target.sub(shoulder);
        // Depth from one camera is less certain than the visible x/y. Fit z
        // into the remaining reach so noisy depth cannot pull the hand down
        // or sideways through a uniform 3D reach clamp.
        const depthReach = Math.sqrt(Math.max(0, reach * reach - offset.x * offset.x - offset.y * offset.y));
        offset.z = clamp(offset.z, -depthReach, depthReach);
        recent.offset.lerp(offset, smoothingAlpha(dt, settings.bodySmoothing ?? 0.12));
        recent.time = sampleTime;
        recent.physicalId = anchor.physicalId;
        // The observed elbow chooses the bend plane, not a second wrist target.
        // Near a straight arm its plane is ambiguous: retain the previous plane.
        const axis = recent.offset.clone().normalize();
        const measured = anchor.elbowDirection?.clone();
        if (measured) measured.addScaledVector(axis, -measured.dot(axis));
        if (measured?.lengthSq() > 0.035) {
          recent.elbowTarget = measured.normalize();
          recent.elbowTime = sampleTime;
        }
        const hint = now - recent.elbowTime < 0.6 ? recent.elbowTarget : defaultBend;
        recent.bendHint.lerp(hint, smoothingAlpha(dt, 0.2));
        this.lastArmTargets.set(side, recent);
      }
    }
    if (!recent || now - recent.time > 0.4) {
      this.lastArmTargets.delete(side);
      return false;
    }
    const solved = solveTwoBoneIK(shoulder, shoulder.clone().add(recent.offset),
      upperLength, lowerLength, recent.bendHint);
    if (!solved) return false;
    // Smooth the wrist once, satisfy segment lengths exactly, and use fixed
    // bind axes. Incremental rotations against last render accumulate roll.
    for (const [name, target] of [[upperName, solved.elbow], [lowerName, solved.wrist]]) {
      const bone = this.bones[name];
      const rest = this.rest[name];
      const direction = target.clone().sub(bone.getWorldPosition(new Vector3())).normalize();
      const world = directionWorldQuaternion(rest.direction, direction, rest.world);
      const parent = bone.parent?.getWorldQuaternion(new Quaternion()) ?? IDENTITY;
      const rotation = worldToLocalQuaternion(parent, world);
      bone.quaternion.copy(rotation);
      bone.updateWorldMatrix(false, true);
      this.last.set(name, { rotation: rotation.clone(), time: recent.time });
    }
    return true;
  }

  updateHead(face, sampleTime, now, dt, settings = {}) {
    const head = this.bones.head;
    if (!head) return;
    const valid = face?.tracked && face.head?.length === 4 && face.head.every(Number.isFinite);
    const desired = valid ? new Quaternion().fromArray(face.head).normalize().multiply(this.rest.head.world) : null;
    const neck = this.bones.neck;
    if (neck) {
      let neckDesired = null;
      if (desired) {
        const parent = neck.parent?.getWorldQuaternion(new Quaternion()) ?? IDENTITY;
        const neutralNeck = parent.clone().multiply(this.rest.neck.local);
        const relativeHead = this.rest.neck.world.clone().invert().multiply(this.rest.head.world);
        const neutralHead = neutralNeck.clone().multiply(relativeHead);
        const delta = desired.clone().multiply(neutralHead.invert());
        neckDesired = IDENTITY.clone().slerp(delta, 0.35).multiply(neutralNeck);
      }
      this.apply('neck', neckDesired, sampleTime, now, dt, settings);
    }
    // Remove the current neck world orientation: total head rotation is absolute, not doubled.
    this.apply('head', desired, sampleTime, now, dt, settings);
  }
}
