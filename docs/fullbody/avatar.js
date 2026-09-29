import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import {
  BodyRetargeter, TRACKED_BONES, calibrateBody, rootOffset, smoothingAlpha, solveBody, validateBodyCalibration,
} from './body.js';
import { mirrorBodyInput, mirrorFaceMotion } from './mirror-motion.js';
import { dampVector } from './motion.js';

const EXPRESSION_NAMES = ['blink', 'blinkLeft', 'blinkRight', 'aa', 'ih', 'ou', 'ee', 'oh', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const BODY_FILTER = Object.freeze({
  hips: { quiet: 0.6 * Math.PI / 180, responsive: 7 * Math.PI / 180, minAlpha: 0.10 },
  torso: { quiet: 0.8 * Math.PI / 180, responsive: 8 * Math.PI / 180, minAlpha: 0.08 },
});
const finiteQuaternion = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);
const posePoint = point => point && [point.x, point.y, point.z].every(Number.isFinite)
  ? new Vector3(point.x, -point.y, -point.z) : null;
const poseMidpoint = (points, a, b) => posePoint(points?.[a])?.add(posePoint(points?.[b])).multiplyScalar(0.5) ?? null;
const poseBasis = (across, up) => {
  if (!across || !up || across.lengthSq() < 1e-8 || up.lengthSq() < 1e-8) return null;
  const x = across.clone().normalize();
  const z = x.clone().cross(up).normalize();
  if (z.lengthSq() < 0.5 || Math.abs(x.dot(up.clone().normalize())) > 0.97) return null;
  const y = z.clone().cross(x).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z)).normalize();
};
const bodyOrientation = pose => {
  const points = pose?.worldLandmarks?.[0];
  const leftShoulder = posePoint(points?.[11]);
  const rightShoulder = posePoint(points?.[12]);
  const leftHip = posePoint(points?.[23]);
  const rightHip = posePoint(points?.[24]);
  const shoulders = poseMidpoint(points, 11, 12);
  const hips = poseMidpoint(points, 23, 24);
  if (![leftShoulder, rightShoulder, leftHip, rightHip, shoulders, hips].every(Boolean)) return null;
  const up = shoulders.sub(hips);
  if (up.lengthSq() < 1e-8) return null;
  const pelvisUp = new Vector3(0, 1, 0).lerp(up.clone().normalize(), 0.2);
  const hip = poseBasis(leftHip.sub(rightHip), pelvisUp);
  const torso = poseBasis(leftShoulder.sub(rightShoulder), up);
  return hip && torso ? { hips: hip, torso } : null;
};

export class FullBodyAvatar {
  static async load(url, scene) {
    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (!vrm?.humanoid) {
      VRMUtils.deepDispose(gltf.scene);
      throw new Error('このファイルにはVRMアバターが含まれていません。');
    }
    try {
      VRMUtils.rotateVRM0(vrm);
      vrm.scene.traverse(object => { object.frustumCulled = false; });
      scene.add(vrm.scene);
      vrm.update(0);
      return new FullBodyAvatar(vrm, scene);
    } catch (error) {
      scene.remove(vrm.scene);
      VRMUtils.deepDispose(vrm.scene);
      throw error;
    }
  }

  constructor(vrm, scene) {
    this.vrm = vrm;
    this.scene = scene;
    vrm.scene.updateWorldMatrix(true, true);
    const bounds = new Box3().setFromObject(vrm.scene);
    if (bounds.isEmpty() || ![bounds.min.y, bounds.max.y].every(Number.isFinite)) {
      throw new Error('このVRMには表示できるメッシュが含まれていません。');
    }
    this.height = Math.max(0.5, bounds.max.y - bounds.min.y);
    // Ground the loaded avatar once; root tracking acts on the normalized hips afterwards.
    vrm.scene.position.y -= bounds.min.y;
    vrm.scene.updateWorldMatrix(true, true);
    const bones = Object.fromEntries(TRACKED_BONES.map(name => [name, vrm.humanoid.getNormalizedBoneNode(name)]));
    this.rig = new BodyRetargeter(bones);
    this.hipsPosition = bones.hips?.position.clone();
    this.root = new Vector3();
    this.rootVelocity = new Vector3();
    this.rootTarget = new Vector3();
    this.rootTime = -Infinity;
    this.calibration = null;
    this.bodyNeutral = {};
    this.bodyRotationHold = {};
    this.lastExpressions = {};
    this.lastGaze = { yaw: 0, pitch: 0 };
    this.lastFaceTime = -Infinity;
    this.solution = solveBody(null, null);
    this.floorBones = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'].filter(name => bones[name]);
    this.floorHeight = this.floorBones.length ? Math.min(...this.floorBones.map(name => bones[name].getWorldPosition(new Vector3()).y)) : 0;
    if (vrm.lookAt) vrm.lookAt.autoUpdate = false;
    // Keep gaze through blinks for avatars whose eye direction is expression-based.
    // Some VRMs otherwise suppress lookAt expressions while a blink is active.
    for (const name of ['blink', 'blinkLeft', 'blinkRight']) {
      const expression = vrm.expressionManager?.getExpression(name);
      if (expression) expression.overrideLookAt = 'none';
    }
  }

  calibrate(poseResult) {
    const calibration = calibrateBody(poseResult);
    const normal = bodyOrientation(poseResult);
    const mirroredPose = mirrorBodyInput(poseResult, null, null)?.pose;
    const mirrored = bodyOrientation(mirroredPose);
    if (normal) {
      calibration.hipsNeutral = normal.hips.toArray();
      calibration.torsoNeutral = normal.torso.toArray();
    }
    if (mirrored) {
      calibration.hipsNeutralMirrored = mirrored.hips.toArray();
      calibration.torsoNeutralMirrored = mirrored.torso.toArray();
    }
    this.setCalibration(calibration);
    return calibration;
  }

  setCalibration(calibration) {
    this.calibration = validateBodyCalibration(calibration) ? { ...calibration } : null;
    this.bodyNeutral = {};
    this.bodyRotationHold = {};
    this.root.set(0, 0, 0);
    this.rootVelocity?.set(0, 0, 0);
    this.rootTarget.set(0, 0, 0);
    this.rootTime = -Infinity;
  }

  neutralRotation(name, mirrored, measured) {
    const suffix = mirrored ? 'Mirrored' : '';
    const saved = this.calibration?.[`${name}Neutral${suffix}`];
    if (finiteQuaternion(saved)) return new Quaternion().fromArray(saved).normalize();
    const key = `${mirrored ? 'mirrored' : 'normal'}:${name}`;
    if (!this.bodyNeutral[key] && measured) this.bodyNeutral[key] = measured.clone();
    return this.bodyNeutral[key] ?? null;
  }

  stabilizeRotation(name, rotation) {
    if (!rotation) return null;
    const previous = this.bodyRotationHold[name];
    if (!previous) {
      this.bodyRotationHold[name] = rotation.clone();
      return rotation;
    }
    const { quiet, responsive, minAlpha } = BODY_FILTER[name];
    const angle = previous.angleTo(rotation);
    const motion = Math.max(0, Math.min(1, (angle - quiet) / Math.max(1e-6, responsive - quiet)));
    const alpha = minAlpha + (1 - minAlpha) * motion * motion * (3 - 2 * motion);
    previous.slerp(rotation, alpha).normalize();
    return previous.clone();
  }

  prepareBodySolution(solution, mirrored) {
    for (const name of ['hips', 'torso']) {
      const measured = solution[name];
      if (!measured) continue;
      const neutral = this.neutralRotation(name, mirrored, measured);
      const relative = neutral ? measured.clone().multiply(neutral.clone().invert()).normalize() : measured.clone();
      solution[name] = this.stabilizeRotation(name, relative);
    }
    return solution;
  }

  update(frame = {}, deltaSeconds = 1 / 60, settings = {}) {
    if (!this.vrm) return;
    const now = performance.now() / 1000;
    const sampleTime = Number.isFinite(frame.time) ? frame.time : -Infinity;
    const dt = Math.max(0, Math.min(0.1, deltaSeconds));
    // Re-solve when inputs/settings change; freshness is checked independently on every render.
    // A close-up can contain a face and hands without a Pose result. Preserve
    // the camera aspect in that case instead of assuming a square image.
    const pose = {...frame.pose, imageWidth:frame.pose?.imageWidth ?? frame.imageWidth,
      imageHeight:frame.pose?.imageHeight ?? frame.imageHeight};
    const sequence = frame.sequence ?? sampleTime;
    const mirrored = settings.mirrorAvatar === true;
    if (this.mirrored !== undefined && this.mirrored !== mirrored) {
      for (const side of ['left', 'right']) this.rig.releaseArm(side, now);
      this.rig.imageReference = {};
      this.bodyNeutral = {};
      this.bodyRotationHold = {};
    }
    this.mirrored = mirrored;
    const solveSettings = `${settings.minVisibility}/${settings.seated}/${settings.trackHands}/${mirrored}`;
    if (!this.solution || this.solutionSequence !== sequence || this.solveSettings !== solveSettings) {
      const input = mirrored ? mirrorBodyInput(pose, frame.hands, frame.faceLandmarks)
        : { pose, hands: frame.hands, faceLandmarks: frame.faceLandmarks };
      this.solution = this.prepareBodySolution(solveBody(input.pose, input.hands, settings, input.faceLandmarks), mirrored);
      this.solution.captureTime = frame.captureTime ?? frame.sampleTime ?? sampleTime;
      this.solutionSequence = sequence;
      this.solveSettings = solveSettings;
    }
    const faceMotion = mirrored ? mirrorFaceMotion(frame.face) : frame.face;
    const faceTime = frame.faceTime ?? sampleTime;
    this.rig.update(this.solution, sampleTime, now, dt, settings, faceMotion ?? null, faceTime);
    this.updateRoot(pose, sampleTime, now, dt, settings);
    this.updateFace(frame.face, faceTime, now, dt, mirrored);
    this.vrm.update(dt);
  }

  updateRoot(pose, sampleTime, now, dt, settings) {
    const hips = this.rig.bones.hips;
    if (!hips || !this.hipsPosition) return;
    const offset = rootOffset(pose, this.calibration, this.rig.torsoLength, settings);
    if (offset && now - sampleTime < 0.4) {
      // The calibration remains in the user's coordinates. Reflect only the
      // resulting lateral motion, not the model's authored rest translation.
      if (settings.mirrorAvatar === true) offset.x *= -1;
      this.rootTarget.copy(offset);
      this.rootTime = sampleTime;
    }
    if (settings.rootMotion === false || now - this.rootTime > 0.4) this.rootTarget.set(0, 0, 0);
    if (settings.seated) this.rootTarget.y = 0;
    this.rootVelocity ??= new Vector3();
    dampVector(this.root, this.rootVelocity, this.rootTarget, dt, this.rig.response ?? settings.bodySmoothing ?? 0.12);
    hips.position.copy(this.hipsPosition);
    // Convert world-space translation to the hips parent's local axes (also handles VRM 0).
    const world = hips.parent.localToWorld(this.hipsPosition.clone()).add(this.root);
    hips.position.copy(hips.parent.worldToLocal(world));
    hips.updateWorldMatrix(true, true);
    // A conservative floor bound prevents knees/crouches from pulling both feet below ground.
    // This is not foot-lock IK: the lower visible foot may still slide with monocular estimates.
    if (!settings.seated && this.floorBones.length) {
      const lowest = Math.min(...this.floorBones.map(name => this.rig.bones[name].getWorldPosition(new Vector3()).y));
      const correction = Math.max(0, this.floorHeight - lowest);
      if (correction > 0) {
        const corrected = hips.getWorldPosition(new Vector3());
        corrected.y += correction;
        hips.position.copy(hips.parent.worldToLocal(corrected));
        hips.updateWorldMatrix(false, true);
      }
    }
  }

  updateFace(face, sampleTime, now, dt, mirrored = false) {
    const fresh = face?.tracked && now - sampleTime < 0.4;
    if (fresh) {
      this.lastExpressions = { ...face.expressions };
      this.lastGaze = { yaw: face.gaze?.yaw ?? 0, pitch: face.gaze?.pitch ?? 0 };
      this.lastFaceTime = sampleTime;
    }
    const holding = now - this.lastFaceTime <= 0.4;
    const motion = { expressions: this.lastExpressions, gaze: this.lastGaze };
    const displayed = mirrored ? mirrorFaceMotion(motion) : motion;
    const manager = this.vrm.expressionManager;
    if (manager) {
      const independentBlink = !!manager.getExpression('blinkLeft') && !!manager.getExpression('blinkRight');
      const expressions = { ...displayed.expressions };
      if (independentBlink) {
        expressions.blink = 0;
      } else {
        expressions.blink = Math.max(expressions.blink ?? 0, expressions.blinkLeft ?? 0, expressions.blinkRight ?? 0);
        expressions.blinkLeft = 0;
        expressions.blinkRight = 0;
      }
      for (const name of EXPRESSION_NAMES) {
        if (!manager.getExpression(name)) continue;
        const target = holding ? clamp01(expressions[name]) : 0;
        const current = manager.getValue(name) ?? 0;
        // FaceSolver already smooths live data. Only ease the recovery after detection loss.
        manager.setValue(name, holding ? target : current + (target - current) * smoothingAlpha(dt, 0.25));
      }
    }
    if (this.vrm.lookAt) {
      const lookAt = this.vrm.lookAt;
      const alpha = holding ? 1 : smoothingAlpha(dt, 0.4);
      const yaw = holding && Number.isFinite(displayed.gaze.yaw) ? displayed.gaze.yaw : 0;
      const pitch = holding && Number.isFinite(displayed.gaze.pitch) ? displayed.gaze.pitch : 0;
      lookAt.yaw += (yaw - lookAt.yaw) * alpha;
      lookAt.pitch += (pitch - lookAt.pitch) * alpha;
    }
  }

  dispose() {
    if (!this.vrm) return;
    this.scene.remove(this.vrm.scene);
    VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
  }
}
