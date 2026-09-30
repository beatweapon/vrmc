import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import {
  BodyRetargeter, TRACKED_BONES, calibrateBody, rootOffset, smoothingAlpha, solveBody, validateBodyCalibration,
} from './body.js';
import { mirrorBodyInput, mirrorFaceMotion } from './mirror-motion.js';
import { dampQuaternion, dampVector } from './motion.js';

const EXPRESSION_NAMES = ['blink', 'blinkLeft', 'blinkRight', 'aa', 'ih', 'ou', 'ee', 'oh', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
const MOUTH_NAMES = ['aa', 'ih', 'ou', 'ee', 'oh'];
const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const finiteQuaternion = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);
const morphTargetName = (primitive, index) => Object.entries(primitive?.morphTargetDictionary || {})
  .find(([, targetIndex]) => targetIndex === index)?.[0] || '';
const bindMorphNames = expression => [...new Set((expression?.binds || []).flatMap(bind =>
  (bind.primitives || []).map(primitive => morphTargetName(primitive, bind.index)).filter(Boolean)))];
const isEyeMorph = name => /^Fcl_EYE_/i.test(name)
  || /(^|[_\-.])(eye|eyes|eyelid|lid)([_\-.]|$)/i.test(name);
const keepHappyEyeBinds = manager => {
  const happy = manager?.getExpression('happy');
  if (!happy || !Array.isArray(happy.binds) || typeof happy.deleteBind !== 'function') {
    return { usesEyeBinds:false, originalNames:[], keptNames:[], details:[] };
  }
  const binds = [...happy.binds];
  const details = binds.flatMap((bind, bindIndex) => (bind.primitives || []).map((primitive, primitiveIndex) => {
    const name = morphTargetName(primitive, bind.index);
    const dictionary = Object.keys(primitive?.morphTargetDictionary || {});
    return `bind${bindIndex}/mesh${primitiveIndex}: index=${bind.index} name=${name || '(unresolved)'} dict=[${dictionary.join(',') || '(none)'}]`;
  }));
  const originalNames = [...new Set(binds.flatMap(bind => (bind.primitives || [])
    .map(primitive => morphTargetName(primitive, bind.index)).filter(Boolean)))];
  const eyeBinds = binds.filter(bind => Array.isArray(bind.primitives)
    && bind.primitives.some(primitive => isEyeMorph(morphTargetName(primitive, bind.index))));
  for (const bind of binds) if (!eyeBinds.includes(bind)) happy.deleteBind(bind);
  return {
    usesEyeBinds: eyeBinds.length > 0,
    originalNames,
    keptNames: bindMorphNames(happy),
    details,
  };
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
    const [name, index] = fallback;
    if (!Number.isInteger(index) || index < 0 || index >= influences.length) return;
    targets.push({ primitive, index, name });
  });
  return targets;
};
const debugNumber = value => Number.isFinite(value) ? value.toFixed(3) : '—';
const appliedMorphValue = expression => Math.max(0, ...(expression?.binds || []).flatMap(bind =>
  (bind.primitives || []).map(primitive => primitive?.morphTargetInfluences?.[bind.index] || 0)));
const createFaceDebugPanel = () => {
  if (typeof document === 'undefined' || new URLSearchParams(location.search).get('output') === '1') return null;
  const panel = document.createElement('pre');
  panel.id = 'face-expression-debug';
  Object.assign(panel.style, {
    position:'fixed', left:'10px', bottom:'10px', zIndex:'30', margin:'0', padding:'10px 12px',
    maxWidth:'min(900px,calc(100vw - 20px))', maxHeight:'58vh', overflow:'auto', pointerEvents:'none',
    background:'#071016e8', color:'#d9ffe8', border:'1px solid #5b8b72', borderRadius:'8px',
    font:'11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace', whiteSpace:'pre-wrap',
  });
  document.body.appendChild(panel);
  return panel;
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
    this.lastDebugFace = null;
    this.debugPanel = createFaceDebugPanel();
    this.solution = solveBody(null, null);
    this.floorBones = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'].filter(name => bones[name]);
    this.floorHeight = this.floorBones.length ? Math.min(...this.floorBones.map(name => bones[name].getWorldPosition(new Vector3()).y)) : 0;
    if (vrm.lookAt) vrm.lookAt.autoUpdate = false;
    for (const name of ['blink', 'blinkLeft', 'blinkRight']) {
      const expression = vrm.expressionManager?.getExpression(name);
      if (expression) expression.overrideLookAt = 'none';
    }
    const happy = vrm.expressionManager?.getExpression('happy');
    if (happy) happy.overrideMouth = 'none';
    this.happyBindDebug = keepHappyEyeBinds(vrm.expressionManager);
    this.happyUsesEyeBinds = this.happyBindDebug.usesEyeBinds;
    this.happyEyeTargets = this.happyUsesEyeBinds ? [] : findHappyEyeTargets(vrm.scene);
    this.happyEyeApplied = 0;
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
      const settledAngle = (name === 'torso' ? 1.5 : 1.2) * Math.PI / 180;
      const spikeAngle = (name === 'torso' ? 4 : 3) * Math.PI / 180;
      const settled = motion.rotation.angleTo(motion.target) <= settledAngle;
      const jump = motion.target.angleTo(rotation);
      if (motion.pending) {
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
    const raw = clamp01(this.vrm.expressionManager?.getValue('happy') ?? 0);
    // Fcl_EYE_Joy reaches a fully closed stylized eye at weight 1 on common VRoid models.
    // Keep the smile visible while capping it before eyelashes collapse/disappear.
    const amount = Math.min(0.35, raw * 0.55);
    for (const target of this.happyEyeTargets) {
      if (target.primitive?.morphTargetInfluences) target.primitive.morphTargetInfluences[target.index] = amount;
    }
    this.happyEyeApplied = amount;
  }

  update(frame = {}, deltaSeconds = 1 / 60, settings = {}) {
    if (!this.vrm) return;
    const now = performance.now() / 1000;
    const sampleTime = Number.isFinite(frame.time) ? frame.time : -Infinity;
    const dt = Math.max(0, Math.min(0.1, deltaSeconds));
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
    const renderedSolution = {
      ...this.solution,
      hips: this.bodyRotation('hips', now, dt, settings),
      torso: this.bodyRotation('torso', now, dt, settings),
    };
    this.applyRenderedBody(renderedSolution, now, dt, settings);
    const faceMotion = mirrored ? mirrorFaceMotion(frame.face) : frame.face;
    const faceTime = frame.faceTime ?? sampleTime;
    this.rig.update(renderedSolution, sampleTime, now, dt, settings, faceMotion ?? null, faceTime);
    this.updateRoot(pose, sampleTime, now, dt, settings);
    this.updateFace(frame.face, faceTime, now, dt, mirrored);
    this.vrm.update(dt);
    this.applyHappyEyeMorph();
    this.renderFaceDebug();
  }

  updateRoot(pose, sampleTime, now, dt, settings) {
    const hips = this.rig.bones.hips;
    if (!hips || !this.hipsPosition) return;
    const offset = rootOffset(pose, this.calibration, this.rig.torsoLength, settings);
    if (offset && now - sampleTime < 0.4) {
      if (settings.mirrorAvatar === true) offset.x *= -1;
      this.rootTarget.copy(offset);
      this.rootTime = sampleTime;
    }
    if (settings.rootMotion === false || now - this.rootTime > 0.4) this.rootTarget.set(0, 0, 0);
    if (settings.seated) this.rootTarget.y = 0;
    this.rootVelocity ??= new Vector3();
    dampVector(this.root, this.rootVelocity, this.rootTarget, dt, this.rig.response ?? settings.bodySmoothing ?? 0.12);
    hips.position.copy(this.hipsPosition);
    const world = hips.parent.localToWorld(this.hipsPosition.clone()).add(this.root);
    hips.position.copy(hips.parent.worldToLocal(world));
    hips.updateWorldMatrix(true, true);
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
      this.lastDebugFace = face;
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

  renderFaceDebug() {
    if (!this.debugPanel) return;
    const face = this.lastDebugFace;
    const measurement = face?.measurement;
    const blend = measurement?.blendshapes || {};
    const manager = this.vrm.expressionManager;
    const happy = manager?.getExpression('happy');
    const expressions = manager?.expressions || [];
    const overrideTotal = expressions.reduce((sum, expression) => sum + (Number(expression.overrideMouthAmount) || 0), 0);
    const mouthMultiplier = Math.max(0, 1 - overrideTotal);
    const solver = face?.expressions || {};
    const weights = Object.fromEntries([...MOUTH_NAMES, 'happy'].map(name => [name, manager?.getValue(name)]));
    const morphs = Object.fromEntries([...MOUTH_NAMES, 'happy'].map(name => [name, appliedMorphValue(manager?.getExpression(name))]));
    const line = names => names.map(name => `${name}=${debugNumber(blend[name])}`).join('  ');
    const bindDebug = this.happyBindDebug || { originalNames:[], keptNames:[], details:[] };
    const manualNames = [...new Set((this.happyEyeTargets || []).map(target => target.name))];
    this.debugPanel.textContent = [
      'FACE EXPRESSION DEBUG',
      `tracked=${!!face?.tracked}  mouthOpen=${debugNumber(measurement?.mouthOpen)}  mouthWidth=${debugNumber(measurement?.mouthWidth)}`,
      `MediaPipe: ${line(['jawOpen','mouthClose','mouthPucker','mouthFunnel'])}`,
      `           ${line(['mouthSmileLeft','mouthSmileRight','mouthStretchLeft','mouthStretchRight'])}`,
      `Solver:    ${[...MOUTH_NAMES,'happy'].map(name => `${name}=${debugNumber(solver[name])}`).join('  ')}`,
      `VRM weight:${[...MOUTH_NAMES,'happy'].map(name => `${name}=${debugNumber(weights[name])}`).join('  ')}`,
      `Morph max: ${[...MOUTH_NAMES,'happy'].map(name => `${name}=${debugNumber(morphs[name])}`).join('  ')}`,
      `manual happy eye: amount=${debugNumber(this.happyEyeApplied)} targets=${manualNames.join(', ') || '(none)'}`,
      `happy overrideMouth=${happy?.overrideMouth ?? '—'}  overrideMouthAmount=${debugNumber(happy?.overrideMouthAmount)}`,
      `ALL overrideMouth total=${debugNumber(overrideTotal)}  => mouth multiplier=${debugNumber(mouthMultiplier)}`,
      `happy original binds: ${bindDebug.originalNames.join(', ') || '(none/unresolved)'}`,
      `happy kept eye binds: ${bindDebug.keptNames.join(', ') || '(none)'}`,
      ...bindDebug.details.map(detail => `  ${detail}`),
      mouthMultiplier < .999 ? '!!! mouth expressions are being attenuated by VRM overrideMouth !!!' : 'mouth override attenuation: none',
    ].join('\n');
  }

  dispose() {
    if (!this.vrm) return;
    this.debugPanel?.remove();
    this.scene.remove(this.vrm.scene);
    VRMUtils.deepDispose(vrm.scene);
    this.vrm = null;
  }
}
