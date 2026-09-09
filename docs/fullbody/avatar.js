import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import {
  BodyRetargeter, TRACKED_BONES, calibrateBody, rootOffset, smoothingAlpha, solveBody, validateBodyCalibration,
} from './body.js';

const EXPRESSION_NAMES = ['blink', 'blinkLeft', 'blinkRight', 'aa', 'ih', 'ou', 'ee', 'oh', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

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
    this.rootTarget = new Vector3();
    this.rootTime = -Infinity;
    this.calibration = null;
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
    this.setCalibration(calibration);
    return calibration;
  }

  setCalibration(calibration) {
    this.calibration = validateBodyCalibration(calibration) ? { ...calibration } : null;
    this.root.set(0, 0, 0);
    this.rootTarget.set(0, 0, 0);
    this.rootTime = -Infinity;
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
    const solveSettings = `${settings.minVisibility}/${settings.seated}/${settings.trackHands}`;
    if (!this.solution || this.solutionSequence !== sequence || this.solveSettings !== solveSettings) {
      this.solution = solveBody(pose, frame.hands, settings, frame.faceLandmarks);
      this.solutionSequence = sequence;
      this.solveSettings = solveSettings;
    }
    this.rig.update(this.solution, sampleTime, now, dt, settings, frame.face ?? null);
    this.updateRoot(pose, sampleTime, now, dt, settings);
    this.updateFace(frame.face, sampleTime, now, dt);
    this.vrm.update(dt);
  }

  updateRoot(pose, sampleTime, now, dt, settings) {
    const hips = this.rig.bones.hips;
    if (!hips || !this.hipsPosition) return;
    const offset = rootOffset(pose, this.calibration, this.rig.torsoLength, settings);
    if (offset && now - sampleTime < 0.4) {
      this.rootTarget.copy(offset);
      this.rootTime = sampleTime;
    }
    if (settings.rootMotion === false || now - this.rootTime > 0.4) this.rootTarget.set(0, 0, 0);
    if (settings.seated) this.rootTarget.y = 0;
    this.root.lerp(this.rootTarget, smoothingAlpha(dt, settings.bodySmoothing ?? 0.12));
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

  updateFace(face, sampleTime, now, dt) {
    const fresh = face?.tracked && now - sampleTime < 0.4;
    if (fresh) {
      this.lastExpressions = { ...face.expressions };
      this.lastGaze = { yaw: face.gaze?.yaw ?? 0, pitch: face.gaze?.pitch ?? 0 };
      this.lastFaceTime = sampleTime;
    }
    const holding = now - this.lastFaceTime <= 0.4;
    const manager = this.vrm.expressionManager;
    if (manager) {
      const independentBlink = !!manager.getExpression('blinkLeft') && !!manager.getExpression('blinkRight');
      const expressions = { ...this.lastExpressions };
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
      const yaw = holding && Number.isFinite(this.lastGaze.yaw) ? this.lastGaze.yaw : 0;
      const pitch = holding && Number.isFinite(this.lastGaze.pitch) ? this.lastGaze.pitch : 0;
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
