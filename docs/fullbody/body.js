import { Matrix4, Quaternion, Vector3 } from 'three';
import { ArmMotion } from './arm-ik.js';
import { MotionState, dampQuaternion, dampVector } from './motion.js';
import { measureHand, HandRetargeter, constrainWristRotation, WRIST_LIMITS, principalAngle, forearmRollTarget } from './hand-rig.js';

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
    // A newly detected hand has not acquired an anatomical side yet. Do not
    // bypass that confirmation via a one-frame Pose wrist/elbow guess. Other
    // limbs and previously confirmed hands continue to track independently.
    if (settings.trackHands !== false && /Arm$/.test(name) &&
        hands?.pendingSides?.includes(name.startsWith('left') ? 'left' : 'right')) continue;
    if (poseVisible(pose, indices, threshold)) {
      const vector = direction(points, ...indices);
      if (vector) result.directions[name] = vector;
    }
  }
  result.legTracked = !settings.seated && poseVisible(pose, [23, 24, 25, 26, 27, 28], threshold);
  const anchors = imageAnchors(pose, faceLandmarks, threshold);
  if (settings.trackHands !== false) {
    for (const [side, { world: hand, image, physicalId }] of assignHands(hands, pose, threshold)) {
      if (!visible(hand, [0, 5, 9, 17], 0)) continue;
      const wristIndex = side === 'left' ? 15 : 16;
      const upperName = `${side}UpperArm`;
      const lowerName = `${side}LowerArm`;
      // Hand owns wrist image position. Pose contributes the 3D arm skeleton
      // only when its wrist corroborates the Hand wrist in image space.
      result.armTargets[side] = {
        ...anchors, wrist: { x: image[0].x, y: image[0].y }, physicalId,
        elbowDirection: result.directions[upperName]?.clone() ?? null,
        poseUpperDirection: null,
        poseLowerDirection: null,
      };
      if (poseVisible(pose, [wristIndex], threshold)) {
        const imageWrist = pose.landmarks?.[0]?.[wristIndex];
        const distance = imageWrist
          ? Math.hypot((imageWrist.x - image[0].x) * anchors.aspect, imageWrist.y - image[0].y)
          : Infinity;
        if (distance < .12) {
          result.armTargets[side].poseUpperDirection = result.directions[upperName]?.clone() ?? null;
          result.armTargets[side].poseLowerDirection = result.directions[lowerName]?.clone() ?? null;
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
    // Sparse Pose wrist detections must never drive the forearm on their own.
    // The corroborated copies above are consumed only by Hand-owned IK.
    delete result.directions.leftLowerArm;
    delete result.directions.rightLowerArm;
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
    this.wristRotations = new Map();
    this.imageReference = {};
    this.motion = new MotionState();
    this.sampleInterval = 1 / 30;
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

  apply(name, desiredWorld, sampleTime, now, dt, settings = {}, forceRest = false, direct = false) {
    const parent = this.bones[name]?.parent?.getWorldQuaternion(new Quaternion()) ?? IDENTITY;
    const local = desiredWorld ? worldToLocalQuaternion(parent, desiredWorld) : null;
    this.applyLocal(name, local, sampleTime, now, dt, settings, forceRest, direct);
  }

  applyLocal(name, desiredLocal, sampleTime, now, dt, settings = {}, forceRest = false, direct = false) {
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
    if (direct && holding) bone.quaternion.copy(target);
    else this.motion.rotation(name, bone.quaternion, target, dt,
      holding ? this.response ?? settings.bodySmoothing ?? 0.12 : correctedArm ? 0.06 : 0.45);
    bone.updateWorldMatrix(false, false);
    if (forceRest) this.last.delete(name);
  }

  update(solution, sampleTime, now, dt, settings = {}, face = undefined, faceTime = sampleTime) {
    const captureTime = solution.captureTime ?? sampleTime;
    if (captureTime > (this.previousSampleTime ?? -Infinity)) {
      const interval = captureTime - this.previousSampleTime;
      if (interval > 0 && interval < 0.8) this.sampleInterval += (interval - this.sampleInterval) * 0.25;
      else if (interval >= 0.8) this.sampleInterval = 1 / 30;
      this.previousSampleTime = captureTime;
    }
    // One response policy across independent body constraints. Slow inference
    // needs a longer response to bridge observations; never extrapolate a hand.
    this.response = Math.max(settings.bodySmoothing ?? 0.12, Math.min(0.3, this.sampleInterval * 1.1));
    // Remove last render's distributed roll before solving the arm again.
    // Its bind-based direction solution and smoothing must never feed that
    // additional roll back into themselves and accumulate complete turns.
    for (const [side, state] of this.wristRotations) {
      const upper = this.bones[`${side}UpperArm`];
      const lower = this.bones[`${side}LowerArm`];
      if (upper && state.upperBaseLocal) {
        upper.quaternion.copy(state.upperBaseLocal);
        upper.updateWorldMatrix(false, true);
      }
      if (lower && state.baseLocal) {
        lower.quaternion.copy(state.baseLocal);
        lower.updateWorldMatrix(false, true);
      }
    }
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
    if (face !== undefined) this.updateHead(face, faceTime, now, dt, settings);
    const fallbackArms = new Set();
    for (const side of ['left', 'right']) {
      if (this.updateArmTarget(side, settings.trackHands === false ? null : solution.armTargets?.[side],
        sampleTime, now, dt, settings, solution.directions)) {
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
      const hand = this.handRig.solve(solution.hands?.[side]);
      this.updateWrist(side, hand.wristWorld, sampleTime, now, dt, settings);
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
    const wristState = this.wristRotations.get(side);
    const upper = this.bones[`${side}UpperArm`];
    const lower = this.bones[`${side}LowerArm`];
    if (upper && wristState?.upperBaseLocal) {
      upper.quaternion.copy(wristState.upperBaseLocal);
      upper.updateWorldMatrix(false, true);
    }
    if (lower && wristState?.baseLocal) {
      lower.quaternion.copy(wristState.baseLocal);
      lower.updateWorldMatrix(false, true);
    }
    this.wristRotations.delete(side);
    this.motion.clearSide(side);
    this.lastArmTargets.delete(side);
    for (const name of this.last.keys()) {
      if (name.startsWith(side) && /UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little/.test(name)) this.last.delete(name);
    }
    this.releasedArmTimes.set(side, now);
  }

  updateWrist(side, desiredWorld, sampleTime, now, dt, settings) {
    const name = `${side}Hand`;
    const wrist = this.bones[name];
    const upper = this.bones[`${side}UpperArm`];
    const lower = this.bones[`${side}LowerArm`];
    const rest = this.rest[name];
    if (!wrist || !rest) return;
    if (!lower) {
      this.apply(name, desiredWorld, sampleTime, now, dt, settings, settings.trackHands === false);
      return;
    }
    let state = this.wristRotations.get(side);
    const fresh = settings.trackHands !== false && desiredWorld && now - sampleTime >= -0.1 && now - sampleTime < 0.4;
    if (!state) state = { appliedTwist: 0, measuredTwist: 0, upperTwist: 0, upperRollPhase: 0, time: -Infinity,
      orientation: wrist.getWorldQuaternion(new Quaternion()), velocity: new Vector3() };
    if (fresh) {
      if (sampleTime - state.time > 0.4) {
        state.measuredTwist = 0;
        state.upperRollPhase = state.appliedTwist;
      }
      state.desiredWorld = desiredWorld;
      state.time = sampleTime;
    }
    const holding = settings.trackHands !== false && now - state.time <= 0.4;
    const axisWorld = wrist.getWorldPosition(new Vector3()).sub(lower.getWorldPosition(new Vector3())).normalize();
    const parent = wrist.parent?.getWorldQuaternion(new Quaternion()) ?? IDENTITY;
    const neutral = parent.clone().multiply(rest.local);
    const axis = axisWorld.clone().applyQuaternion(neutral.clone().invert());
    dampQuaternion(state.orientation, state.velocity, holding ? state.desiredWorld : neutral, dt,
      holding ? this.response : 0.45);
    const delta = holding ? neutral.clone().invert().multiply(state.orientation) : null;
    // The bind-derived forearm orientation has no anatomical zero. Preserve
    // observed axial roll while still rejecting extreme wrist swing. Only the
    // wrist's relative axial rotation is an anatomical/deformation safeguard.
    const limited = delta && constrainWristRotation(delta, axis, state.measuredTwist, Infinity);
    if (limited) state.measuredTwist = principalAngle(limited.measuredTwist);
    const forearmTarget = limited ? forearmRollTarget(limited.measuredTwist) : 0;
    const rollStep = principalAngle(forearmTarget - state.appliedTwist);
    if (holding) {
      state.appliedTwist = principalAngle(state.appliedTwist + rollStep);
      state.releaseVelocity = new Vector3();
    } else {
      // Loss is a transition, not an immediate removal of distributed roll.
      // Live palms are filtered once above; only unobserved roll relaxes here.
      const releasing = new Vector3(state.appliedTwist, state.upperTwist, 0);
      state.releaseVelocity ??= new Vector3();
      dampVector(releasing, state.releaseVelocity, new Vector3(), dt, 0.45);
      state.appliedTwist = releasing.x;
      state.upperTwist = releasing.y;
    }
    state.baseLocal = lower.quaternion.clone();
    // Rotating around elbow -> wrist leaves both IK joint positions unchanged.
    const world = new Quaternion().setFromAxisAngle(axisWorld, state.appliedTwist)
      .multiply(lower.getWorldQuaternion(new Quaternion()));
    if (upper) {
      // Share roll only while the arm is nearly extended. With a bent elbow,
      // forearm pronation must not turn the upper arm as if it shared that axis.
      // Lower-arm compensation below preserves the observed world palm.
      if (holding) state.upperRollPhase += principalAngle(state.appliedTwist - state.upperRollPhase);
      else state.upperRollPhase = state.appliedTwist;
      const upperAxis = lower.getWorldPosition(new Vector3()).sub(upper.getWorldPosition(new Vector3())).normalize();
      const alignment = clamp((upperAxis.dot(axisWorld) - Math.cos(70 * Math.PI / 180)) /
        (Math.cos(20 * Math.PI / 180) - Math.cos(70 * Math.PI / 180)), 0, 1);
      const sharing = alignment * alignment * (3 - 2 * alignment);
      const upperTarget = holding ? clamp(state.upperRollPhase * 0.5 * sharing, -WRIST_LIMITS.upperArmTwist, WRIST_LIMITS.upperArmTwist) : 0;
      if (holding) state.upperTwist = upperTarget;
      state.upperBaseLocal = upper.quaternion.clone();
      const upperWorld = new Quaternion().setFromAxisAngle(upperAxis, state.upperTwist).multiply(upper.getWorldQuaternion(new Quaternion()));
      upper.quaternion.copy(worldToLocalQuaternion(upper.parent?.getWorldQuaternion(new Quaternion()) ?? IDENTITY, upperWorld));
      upper.updateWorldMatrix(false, true);
    }
    lower.quaternion.copy(worldToLocalQuaternion(lower.parent?.getWorldQuaternion(new Quaternion()) ?? IDENTITY, world));
    lower.updateWorldMatrix(false, true);
    let local = null;
    if (limited) {
      const desired = neutral.clone().multiply(limited.rotation);
      local = worldToLocalQuaternion(wrist.parent?.getWorldQuaternion(new Quaternion()) ?? IDENTITY, desired);
      // Cap the remaining local wrist roll after distributing the filtered
      // palm orientation; do not concentrate the forearm turn at this joint.
      const relative = rest.local.clone().invert().multiply(local);
      const constrained = constrainWristRotation(relative, axis, 0, WRIST_LIMITS.wristTwist);
      local = constrained && rest.local.clone().multiply(constrained.rotation);
    }
    this.applyLocal(name, local, state.time, now, dt, settings, settings.trackHands === false, true);
    // Bound the rendered joint too: a changing forearm axis or a previous
    // tracking pose cannot escape the limits during quaternion interpolation.
    const rendered = constrainWristRotation(rest.local.clone().invert().multiply(wrist.quaternion), axis, 0, WRIST_LIMITS.wristTwist);
    if (rendered) wrist.quaternion.copy(rest.local.clone().multiply(rendered.rotation));
    wrist.updateWorldMatrix(false, true);
    this.wristRotations.set(side, state);
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
    // Fixed bind dimensions and observed foreshortening define scale. Wrist
    // placement has one render-time filter in ArmMotion, no extra scale EMA.
    return origin.add(new Vector3(
      (anchor.wrist.x - imageOrigin.x) * anchor.aspect * scale,
      -(anchor.wrist.y - imageOrigin.y) * scale,
      this.shoulderWidth * 0.12,
    ));
  }

  updateArmTarget(side, anchor, sampleTime, now, dt, settings, directions = {}) {
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
    const fresh = now - sampleTime >= -0.1 && now - sampleTime < 0.4;
    const torsoName = ['upperChest', 'chest', 'spine', 'hips'].find(name => this.bones[name]);
    const torsoRotation = torsoName ? this.bones[torsoName].getWorldQuaternion(new Quaternion())
      .multiply(this.rest[torsoName].world.clone().invert()) : new Quaternion();
    const inverse = torsoRotation.clone().invert();
    const other = this.bones[(side === 'left' ? 'right' : 'left') + 'UpperArm'];
    const origin = other ? other.getWorldPosition(new Vector3()).add(shoulder).multiplyScalar(0.5) : shoulder.clone();
    const localShoulder = shoulder.clone().sub(origin).applyQuaternion(inverse);
    let recent = this.lastArmTargets.get(side);
    if (fresh) {
      const handTarget = anchor && this.imageWristTarget(anchor, sampleTime);
      if (handTarget) {
        if (!recent || now - recent.time > 0.4) {
          recent = { motion: new ArmMotion(wrist.clone().sub(shoulder).applyQuaternion(inverse)) };
        }

        let measured = anchor?.elbowDirection ?? null;
        if (anchor?.poseUpperDirection && anchor?.poseLowerDirection) {
          const poseElbow = shoulder.clone().addScaledVector(anchor.poseUpperDirection, upperLength);
          const poseWrist = poseElbow.clone().addScaledVector(anchor.poseLowerDirection, lowerLength);
          // Hand keeps x/y authority. Pose supplies only a bounded depth cue,
          // reconstructed from normalized segment directions and avatar lengths.
          handTarget.z += (poseWrist.z - handTarget.z) * .6;
          measured = poseElbow.sub(shoulder);
        }

        const offset = handTarget.clone().sub(shoulder);
        // Keep a little elbow bend even if image x/y or the depth cue asks for
        // full extension. This avoids the straight-arm failure from raw Pose Z.
        const reach = upperLength + lowerLength;
        const maxReach = reach * .97;
        const planar = Math.hypot(offset.x, offset.y);
        if (planar > maxReach) {
          const scale = maxReach / planar;
          offset.x *= scale;
          offset.y *= scale;
          offset.z = 0;
        } else {
          const depthReach = Math.sqrt(Math.max(0, maxReach ** 2 - planar ** 2));
          offset.z = clamp(offset.z, -depthReach, depthReach);
        }
        recent.target = offset.applyQuaternion(inverse);

        if (measured) {
          recent.measured = measured.clone().applyQuaternion(inverse);
          recent.measuredTime = sampleTime;
        } else if (sampleTime - (recent.measuredTime ?? -Infinity) > 0.4) recent.measured = null;
        recent.time = sampleTime;
        recent.physicalId = anchor?.physicalId ?? recent.physicalId;
        recent.source = 'hand';
        recent.mode = 'hand';
        this.lastArmTargets.set(side, recent);
      }
    }
    if (!recent || now - recent.time > 0.4) {
      this.lastArmTargets.delete(side);
      return false;
    }
    const solved = recent.motion.update({ shoulder: localShoulder, target: localShoulder.clone().add(recent.target),
      measuredElbow: recent.measured, side, upperLength, lowerLength, width: this.shoulderWidth,
      height: this.torsoLength, dt, response: this.response });
    if (!solved) return false;
    solved.elbow.applyQuaternion(torsoRotation).add(origin);
    solved.wrist.applyQuaternion(torsoRotation).add(origin);
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
    const raw = face?.headTarget;
    const rotation = raw ?? face?.head;
    const valid = face?.tracked && rotation?.length === 4 && rotation.every(Number.isFinite)
      && now - sampleTime >= -.1 && now - sampleTime < .4;
    let desired = valid ? new Quaternion().fromArray(rotation).normalize().multiply(this.rest.head.world) : null;
    const neck = this.bones.neck;
    const neutralParent = (neck ?? head).parent?.getWorldQuaternion(new Quaternion()) ?? IDENTITY;
    const neutralNeck = neck ? neutralParent.clone().multiply(this.rest.neck.local) : null;
    const neutralHead = neck
      ? neutralNeck.clone().multiply(this.rest.neck.world.clone().invert().multiply(this.rest.head.world))
      : neutralParent.clone().multiply(this.rest.head.local);
    if ((valid && raw) || (!valid && this.headMotion)) {
      // One world-space head response, independent of body fps compensation.
      // The neck/head split below is geometric, not two more delayed filters.
      this.headMotion ??= { rotation: head.getWorldQuaternion(new Quaternion()), velocity: new Vector3(),
        captureTime: null, interval: null };
      const motion = this.headMotion;
      const captureTime = Number.isFinite(face?.captureTime) ? face.captureTime : sampleTime;
      if (valid && (motion.captureTime === null || captureTime > motion.captureTime)) {
        const interval = motion.captureTime === null ? 0 : captureTime - motion.captureTime;
        if (interval > 0) {
          // Missing observations count as a bounded gap, not a fresh 80 ms
          // start. Subsequent observations restore the measured cadence.
          const boundedInterval = Math.min(.4, interval);
          motion.interval = motion.interval === null || interval >= .4
            ? boundedInterval : motion.interval + .25 * (boundedInterval - motion.interval);
        }
        motion.captureTime = captureTime;
      }
      // At sparse observations a short fixed response stops then rushes at
      // every sample. Adjust this SAME spring to the face cadence, not body
      // latency. 0.65 was selected with continuous-motion and lag comparisons;
      // the 200 ms cap keeps slow/failed inference from accumulating delay.
      motion.response = valid
        ? Math.max(settings.faceSmoothing ?? .08, Math.min(.2, .65 * (motion.interval ?? 0))) : .45;
      if (valid) {
        motion.target = desired.clone();
        motion.lastSeen = sampleTime;
        motion.liveResponse = motion.response;
      }
      const holding = !valid && now - motion.lastSeen < .4;
      dampQuaternion(motion.rotation, motion.velocity, desired ?? (holding ? motion.target : neutralHead),
        dt, holding ? motion.liveResponse : motion.response);
      desired = this.headMotion.rotation.clone();
      // This is a render-time pose, including the return to neutral. Apply it
      // directly; expiring it again would start separate neck/head springs.
      sampleTime = now;
    } else this.headMotion = null;
    if (neck) {
      let neckDesired = null;
      if (desired) {
        const delta = desired.clone().multiply(neutralHead.clone().invert());
        neckDesired = IDENTITY.clone().slerp(delta, 0.35).multiply(neutralNeck);
      }
      this.apply('neck', neckDesired, sampleTime, now, dt, settings, false, true);
    }
    // Remove the current neck world orientation: total head rotation is absolute, not doubled.
    this.apply('head', desired, sampleTime, now, dt, settings, false, true);
  }
}
