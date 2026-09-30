import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import {
  BodyRetargeter, TRACKED_BONES, calibrateBody, rootOffset, smoothingAlpha, solveBody, validateBodyCalibration,
} from './body.js';
import { mirrorBodyInput, mirrorFaceMotion } from './mirror-motion.js';
import { dampQuaternion, dampVector } from './motion.js';

const EXPRESSION_NAMES = ['blink', 'blinkLeft', 'blinkRight', 'aa', 'ih', 'ou', 'ee', 'oh', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const finiteQuaternion = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);
const morphTargetName = (primitive, index) => Object.entries(primitive?.morphTargetDictionary || {})
  .find(([, targetIndex]) => targetIndex === index)?.[0] || '';
const isEyeMorph = name => /^Fcl_EYE_/i.test(name)
  || /(^|[_\-.])(eye|eyes|eyelid|lid)([_\-.]|$)/i.test(name);
const keepHappyEyeBinds = manager => {
  const happy = manager?.getExpression('happy');
  if (!happy || !Array.isArray(happy.binds) || typeof happy.deleteBind !== 'function') return false;
  const binds = [...happy.binds];
  const eyeBinds = binds.filter(bind => Array.isArray(bind.primitives)
    && bind.primitives.some(primitive => isEyeMorph(morphTargetName(primitive, bind.index))));
  for (const bind of binds) if (!eyeBinds.includes(bind)) happy.deleteBind(bind);
  return eyeBinds.length > 0;
};
const findHappyEyeTargets = scene => {
  const targets = [];
  scene?.traverse(primitive => {
    const dictionary = primitive?.morphTargetDictionary;
    const influences = primitive?.morphTargetInfluences;
    if (!dictionary || !Array.isArray(influences)) return;
    const entries = Object.entries(dictionary);
    const exact = entries.find(([name]) => /^Fcl_EYE_Joy$/i.test(name));
    const fallback = exact || entries.find(([name]) => /eye/i.test(name) && /(joy|happy|smile)/i.test(name));
    if (!fallback) return;
    const [, index] = fallback;
    if (!Number.isInteger(index) || index < 0 || index >= influences.length) return;
    targets.push({ primitive, index });
  });
  return targets;
};
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
    this.bodyMotion = {};
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
    const happy = vrm.expressionManager?.getExpression('happy');
    if (happy) happy.overrideMouth = 'none';
    const happyUsesEyeBinds = keepHappyEyeBinds(vrm.expressionManager);
    this.happyEyeTargets = happyUsesEyeBinds ? [] : findHappyEyeTargets(vrm.scene);
    this.happyEyeActive = false;
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
    this.bodyMotion = {};
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

  observeBodyRotation(name, rotation, captureTime) {
    if (!rotation) return;
    let motion = this.bodyMotion[name];
    if (!motion) {
      motion = this.bodyMotion[name] = {
        rotation: rotation.clone(), target: rotation.clone(), velocity: new Vector3(),
        captureTime: null, interval: null, lastSeen: captureTime, liveResponse: .08, pending: null,
      };
    }
    if (motion.captureTime === null || captureTime > motion.captureTime) {
      const interval = motion.captureTime === null ? 0 : captureTime - motion.captureTime;
      if (interval > 0) {
        const bounded = Math.min(.4, interval);
        motion.interval = motion.interval === null || interval >= .4
          ? bounded : motion.interval + .25 * (bounded - motion.interval);
      }
      motion.captureTime = captureTime;
      motion.lastSeen = captureTime;

      // Pose world-depth occasionally produces a one-sample shoulder/hip jump while
      // the person is still. Confirm only large jumps that begin from a settled pose;
      // continuous motion and ordinary small changes remain zero-latency.
      const settledAngle = (name === 'torso' ? 1.5 : 1.2) * Math.PI / 180;
      const spikeAngle = (name === 'torso' ? 4 : 3) * Math.PI / 180;
      const settled = motion.rotation.angleTo(motion.target) <= settledAngle;
      const jump = motion.target.angleTo(rotation);
      if (motion.pending) {
        // A second consecutive off-target observation confirms real movement.
        // If it returned to the old target, the held sample was just a spike.
        motion.target.copy(rotation);
        motion.pending = null;
      } else if (settled && jump > spikeAngle) {
        motion.pending = { rotation: rotation.clone(), time: captureTime };
      } else {
        motion.target.copy(rotation);
      }
    }
  }

  bodyRotation(name, now, dt, settings) {
    const motion = this.bodyMotion[name];
    if (!motion) return null;
    const holding = now - motion.lastSeen < .4;
    const target = holding ? motion.target : new Quaternion();
    if (holding) {
      const angle = motion.rotation.angleTo(target);
      const quietAngle = (name === 'torso' ? 1.5 : 1.2) * Math.PI / 180;
      const responsiveAngle = (name === 'torso' ? 8 : 7) * Math.PI / 180;
      const t = Math.max(0, Math.min(1, (angle - quietAngle) / Math.max(1e-6, responsiveAngle - quietAngle)));
      const activity = t * t * (3 - 2 * t);
      const cadenceResponse = Math.max(.055, Math.min(.09, .5 * (motion.interval ?? 0)));
      const quietResponse = Math.max(name === 'torso' ? .16 : .145,
        Math.min(.2, (settings.bodySmoothing ?? .12) * 1.25));
      motion.liveResponse = quietResponse + (cadenceResponse - quietResponse) * activity;
    }
    dampQuaternion(motion.rotation, motion.velocity, target, dt, holding ? motion.liveResponse : .35);
    return motion.rotation.clone();
  }

  prepareBodySolution(solution, mirrored, captureTime) {
    for (const name of ['hips', 'torso']) {
      const measured = solution[name];
      if (!measured) continue;
      const neutral = this.neutralRotation(name, mirrored, measured);
      const relative = neutral ? measured.clone().multiply(neutral.clone().invert()).normalize() : measured.clone();
      this.observeBodyRotation(name, relative, captureTime);
    }
    return solution;
  }

  applyRenderedBody(solution, now, dt, settings) {
    const hips = solution.hips;
    if (hips) {
      this.rig.apply('hips', hips.clone().multiply(this.rig.rest.hips?.world ?? new Quaternion()), now, now, dt, settings, false, true);
    }
    const torsoNames = ['spine', 'chest', 'upperChest'].filter(name => this.rig.bones[name]);
    torsoNames.forEach((name, index) => {
      if (!solution.torso) return;
      const orientation = (hips ?? new Quaternion()).clone().slerp(solution.torso, (index + 1) / torsoNames.length)
        .multiply(this.rig.rest[name].world);
      this.rig.apply(name, orientation, now, now, dt, settings, false, true);
    });
  }

  applyHappyEyeMorph() {
    if (!this.happyEyeTargets?.length) return;
    const amount = this.happyEyeActive ? 1 : 0;
    for (const target of this.happyEyeTargets) {
      if (target.primitive?.morphTargetInfluences) target.primitive.morphTargetInfluences[target.index] = amount;
    }
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
    const captureTime = frame.captureTime ?? frame.sampleTime ?? sampleTime;
    const mirrored = settings.mirrorAvatar === true;
    if (this.mirrored !== undefined && this.mirrored !== mirrored) {
      for (const side of ['left', 'right']) this.rig.releaseArm(side, now);
      this.rig.imageReference = {};
      this.bodyNeutral = {};
      this.bodyMotion = {};
    }
    this.mirrored = mirrored;
    const solveSettings = `${settings.minVisibility}/${settings.seated}/${settings.trackHands}/${mirrored}`;
    if (!this.solution || this.solutionSequence !== sequence || this.solveSettings !== solveSettings) {
      const input = mirrored ? mirrorBodyInput(pose, frame.hands, frame.faceLandmarks)
        : { pose, hands: frame.hands, faceLandmarks: frame.faceLandmarks };
      this.solution = this.prepareBodySolution(solveBody(input.pose, input.hands, settings, input.faceLandmarks), mirrored, captureTime);
      this.solution.captureTime = captureTime;
      this.solutionSequence = sequence;
      this.solveSettings = solveSettings;
    }
    // Pose inference only updates targets. Render-time motion advances every frame,
    // just like headMotion, so sparse body inference never appears as pose steps.
    const renderedSolution = {
      ...this.solution,
      hips: this.bodyRotation('hips', now, dt, settings),
      torso: this.bodyRotation('torso', now, dt, settings),
    };
    // The rendered hips/torso are already a continuous render-time pose. Seed
    // those exact bone rotations before the retargeter so its generic body
    // spring sees zero remaining error instead of adding a second layer of lag.
    this.applyRenderedBody(renderedSolution, now, dt, settings);
    const faceMotion = mirrored ? mirrorFaceMotion(frame.face) : frame.face;
    const faceTime = frame.faceTime ?? sampleTime;
    this.rig.update(renderedSolution, sampleTime, now, dt, settings, faceMotion ?? null, faceTime);
    this.updateRoot(pose, sampleTime, now, dt, settings);
    this.updateFace(frame.face, faceTime, now, dt, mirrored);
    this.vrm.update(dt);
    this.applyHappyEyeMorph();
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

      // Smiling eyes are an authored expression, not a tracked eyelid pose.
      // Once a smile is active, ignore real eyelid openness completely so Blink
      // cannot stack with Joy and push the eye mesh past its intended shape.
      const rawHappy = holding ? clamp01(expressions.happy) : 0;
      this.happyEyeActive = this.happyEyeActive ? rawHappy > .08 : rawHappy > .15;
      expressions.happy = this.happyEyeActive ? 1 : 0;
      if (this.happyEyeActive) {
        expressions.blink = 0;
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
