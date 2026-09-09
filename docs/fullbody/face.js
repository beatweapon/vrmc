import { Euler, Matrix4, Quaternion, Vector3 } from 'three';

const DEG = Math.PI / 180;
const EPS = 1e-6;
const DEFAULTS = Object.freeze({
  eyeOpenLeft: .28, eyeOpenRight: .28,
  eyeClosedLeft: .08, eyeClosedRight: .08,
  blinkLink: false, blinkHoldMs: 140,
  gazeStrength: 1, headStrength: 1, faceSmoothing: .08,
  mouthStrength: 1, expressionStrength: .65,
  smileStrength: 1, surpriseStrength: 1, angryStrength: 1,
});
const LEFT_EYE = [362, 385, 387, 263, 373, 380];
const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
const GAZE_SHAPES = [
  'eyeLookOutLeft', 'eyeLookInLeft', 'eyeLookOutRight', 'eyeLookInRight',
  'eyeLookUpLeft', 'eyeLookDownLeft', 'eyeLookUpRight', 'eyeLookDownRight',
];
const EXPRESSION_NAMES = ['blinkLeft', 'blinkRight', 'aa', 'ih', 'ou', 'ee', 'oh',
  'happy', 'angry', 'sad', 'surprised'];
const zeroExpressions = () => Object.fromEntries(EXPRESSION_NAMES.map(name => [name, 0]));
const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
const smoothstep = n => { const t = clamp(n); return t * t * (3 - 2 * t); };
const alpha = (dt, seconds) => seconds <= 0 ? 1 : -Math.expm1(-dt / seconds);
const setting = (settings, name, lo, hi) => clamp(finite(settings?.[name], DEFAULTS[name]), lo, hi);

function point(landmarks, index, aspect) {
  const p = landmarks[index];
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
  // Image y is normalized by height; x and z are normalized by width.
  // Both y and z flip when converting to our right-handed camera space.
  return new Vector3(p.x, -p.y / aspect, -p.z);
}

function eyeMeasurement(landmarks, indices, irisIndex, aspect, head) {
  const p = indices.map(index => point(landmarks, index, aspect));
  if (p.some(v => !v)) return null;
  const width = p[0].distanceTo(p[3]);
  if (width < EPS) return null;
  // Two independent eyelid distances, divided by eye width, make EAR scale-free.
  const openness = (p[1].distanceTo(p[5]) + p[2].distanceTo(p[4])) / (2 * width);
  if (!Number.isFinite(openness) || openness > 1.5) return null;
  const iris = point(landmarks, irisIndex, aspect);
  let gaze = null;
  if (iris) {
    const center = p[0].clone().add(p[3]).multiplyScalar(.5);
    const horizontal = p[3].clone().sub(p[0]).normalize();
    const up = new Vector3(0, 1, 0).applyQuaternion(head);
    up.addScaledVector(horizontal, -up.dot(horizontal)).normalize();
    const delta = iris.sub(center);
    // Width is stable during blinking; dividing pitch by lid height is unstable.
    gaze = {
      yaw: clamp(delta.dot(horizontal) / width * 100, -35, 35),
      pitch: clamp(-delta.dot(up) / width * 100, -25, 25),
    };
  }
  return { openness, gaze };
}

function headFromMatrix(value) {
  const data = value?.data;
  if (!data || data.length !== 16 || !Array.from(data).every(Number.isFinite)) return null;
  if ((value.rows != null && value.rows !== 4) || (value.columns != null && value.columns !== 4)) return null;
  // MediaPipe's MatrixData and THREE.Matrix4 both use column-major storage.
  // Face geometry is already camera-right X, up Y, toward-camera Z.
  // Sources: mediapipe/framework/formats/matrix_data.proto and
  // mediapipe/tasks/cc/vision/face_geometry/libs/geometry_pipeline.cc.
  const matrix = new Matrix4().fromArray(data);
  const x = new Vector3().setFromMatrixColumn(matrix, 0);
  const y = new Vector3().setFromMatrixColumn(matrix, 1);
  const originalZ = new Vector3().setFromMatrixColumn(matrix, 2);
  if (Math.min(x.lengthSq(), y.lengthSq(), originalZ.lengthSq()) < EPS * EPS) return null;
  x.normalize();
  y.addScaledVector(x, -y.dot(x));
  if (y.lengthSq() < EPS * EPS) return null;
  y.normalize();
  const z = new Vector3().crossVectors(x, y).normalize();
  if (z.dot(originalZ) <= EPS) return null;
  return new Quaternion().setFromRotationMatrix(matrix.makeBasis(x, y, z)).normalize();
}

function headFromLandmarks(landmarks, aspect) {
  const p = [234, 454, 10, 152].map(index => point(landmarks, index, aspect));
  if (p.some(v => !v)) return null;
  const x = p[1].sub(p[0]);
  const y = p[2].sub(p[3]);
  if (x.lengthSq() < EPS * EPS || y.lengthSq() < EPS * EPS) return null;
  x.normalize();
  y.addScaledVector(x, -y.dot(x));
  if (y.lengthSq() < EPS * EPS) return null;
  y.normalize();
  const z = new Vector3().crossVectors(x, y).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z)).normalize();
}

/**
 * Read one MediaPipe FaceLandmarkerResult. Attach imageWidth/imageHeight (or
 * aspectRatio) from the actual inference image for aspect-correct measurements.
 * Output is JSON-serializable; all left/right names are the person's own sides.
 * head: camera-space quaternion [x,y,z,w], gaze: degrees (+yaw right, +pitch down).
 */
export function measureFace(result) {
  const landmarks = result?.faceLandmarks?.[0];
  if (!Array.isArray(landmarks) || landmarks.length < 468) return null;
  const aspect = clamp(finite(result.aspectRatio,
    finite(result.imageWidth / result.imageHeight, 1)), .2, 5);
  const head = headFromMatrix(result.facialTransformationMatrixes?.[0])
    || headFromLandmarks(landmarks, aspect);
  if (!head) return null;
  const left = eyeMeasurement(landmarks, LEFT_EYE, 473, aspect, head);
  const right = eyeMeasurement(landmarks, RIGHT_EYE, 468, aspect, head);
  const lips = [13, 14, 61, 291].map(index => point(landmarks, index, aspect));
  if (!left || !right || lips.some(v => !v)) return null;
  const mouthWidth = lips[2].distanceTo(lips[3]);
  if (mouthWidth < EPS) return null;
  const eyeCenters = [[33, 133], [362, 263]].map(indices =>
    point(landmarks, indices[0], aspect).add(point(landmarks, indices[1], aspect)).multiplyScalar(.5));
  const eyeDistance = eyeCenters[0].distanceTo(eyeCenters[1]);
  const blendshapes = {};
  for (const category of result.faceBlendshapes?.[0]?.categories || []) {
    if (typeof category.categoryName === 'string' && Number.isFinite(category.score)) {
      blendshapes[category.categoryName] = clamp(category.score);
    }
  }
  let gaze = null;
  if (GAZE_SHAPES.every(name => Number.isFinite(blendshapes[name]))) {
    gaze = {
      yaw: 30 * (blendshapes.eyeLookOutLeft - blendshapes.eyeLookInLeft
        + blendshapes.eyeLookInRight - blendshapes.eyeLookOutRight) / 2,
      pitch: 22 * (blendshapes.eyeLookDownLeft - blendshapes.eyeLookUpLeft
        + blendshapes.eyeLookDownRight - blendshapes.eyeLookUpRight) / 2,
    };
  } else if (left.gaze && right.gaze) {
    gaze = { yaw: (left.gaze.yaw + right.gaze.yaw) / 2,
      pitch: (left.gaze.pitch + right.gaze.pitch) / 2 };
  }
  return {
    head: head.toArray(),
    leftEyeOpen: left.openness, rightEyeOpen: right.openness,
    gaze: gaze || { yaw: 0, pitch: 0 }, gazeValid: !!gaze,
    mouthOpen: clamp(lips[0].distanceTo(lips[1]) / mouthWidth, 0, 2),
    // Unlike image width, this ratio survives moving closer and turning the head.
    mouthWidth: eyeDistance > EPS ? clamp(mouthWidth / eyeDistance, .1, 2) : null,
    blendshapes,
  };
}

function validQuaternion(array) {
  return Array.isArray(array) && array.length === 4 && array.every(Number.isFinite)
    && array.reduce((sum, n) => sum + n * n, 0) > EPS;
}

function quantile(values, fraction = .5) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * fraction;
  return sorted[Math.floor(index)] * (1 - index % 1) + sorted[Math.ceil(index)] * (index % 1);
}

/**
 * Persistent calibration schema (version 1):
 * neutralHead [x,y,z,w], neutralGaze {yaw,pitch}, mouthNeutral (mouth EAR),
 * mouthWidthNeutral (optional mouth width / eye-center distance),
 * neutralBlendshapes {name:score}, eyeOpenLeft/Right, eyeClosedLeft/Right.
 * Eye endpoints must be copied into the corresponding settings by the UI.
 * `neutral` only changes neutral fields; eye captures only change their endpoints.
 * Throws a Japanese user-facing error for insufficient/unstable samples.
 */
export function calibrateFace(samples, kind, previous = {}) {
  if (!['neutral', 'eyesOpen', 'eyesClosed'].includes(kind)) throw new Error('不明なキャリブレーションです。');
  const valid = (Array.isArray(samples) ? samples : []).filter(sample => sample
    && validQuaternion(sample.head) && Number.isFinite(sample.leftEyeOpen)
    && Number.isFinite(sample.rightEyeOpen) && Number.isFinite(sample.mouthOpen));
  if (valid.length < 8 || valid.length < samples.length * .6) {
    throw new Error('顔を十分に検出できませんでした。明るい場所で、顔をカメラに向けて再試行してください。');
  }
  const next = { ...previous, version: 1 };
  if (kind === 'eyesOpen' || kind === 'eyesClosed') {
    for (const side of ['Left', 'Right']) {
      const metric = side === 'Left' ? 'leftEyeOpen' : 'rightEyeOpen';
      const value = quantile(valid.map(sample => sample[metric]), kind === 'eyesOpen' ? .6 : .4);
      if (value < 0 || value > .8) throw new Error('目の測定が不安定です。正面を向いて再試行してください。');
      if (kind === 'eyesOpen') {
        const closed = finite(previous[`eyeClosed${side}`], DEFAULTS[`eyeClosed${side}`]);
        if (value - closed < .045) throw new Error('開いた目と閉じた目の差が小さすぎます。先に閉眼を計測するか、目を開いて再試行してください。');
        next[`eyeOpen${side}`] = value;
      } else {
        const open = finite(previous[`eyeOpen${side}`], DEFAULTS[`eyeOpen${side}`]);
        if (open - value < .045) throw new Error('閉じた目と開いた目の差が小さすぎます。目を軽く閉じて再試行してください。');
        next[`eyeClosed${side}`] = value;
      }
    }
    return next;
  }
  const reference = new Quaternion().fromArray(valid[0].head).normalize();
  const components = [[], [], [], []];
  for (const sample of valid) {
    const q = new Quaternion().fromArray(sample.head).normalize();
    const sign = reference.dot(q) < 0 ? -1 : 1;
    q.toArray().forEach((n, index) => components[index].push(n * sign));
  }
  const neutral = new Quaternion(...components.map(values => quantile(values))).normalize();
  const deviation = quantile(valid.map(sample => neutral.angleTo(new Quaternion().fromArray(sample.head).normalize())), .85);
  if (deviation > 12 * DEG) throw new Error('計測中に顔が動きました。自然な正面姿勢を保って再試行してください。');
  const openSamples = valid.filter(sample => sample.gazeValid
    && sample.leftEyeOpen > finite(previous.eyeClosedLeft, .08) + .05
    && sample.rightEyeOpen > finite(previous.eyeClosedRight, .08) + .05);
  if (openSamples.length < 4) throw new Error('視線の基準を計測できませんでした。目を開いてカメラを見てください。');
  next.neutralHead = neutral.toArray();
  next.neutralGaze = {
    yaw: quantile(openSamples.map(sample => sample.gaze?.yaw)),
    pitch: quantile(openSamples.map(sample => sample.gaze?.pitch)),
  };
  next.mouthNeutral = quantile(valid.map(sample => sample.mouthOpen));
  const widths = valid.map(sample => sample.mouthWidth).filter(n => Number.isFinite(n) && n > .1);
  if (widths.length >= valid.length * .6) next.mouthWidthNeutral = quantile(widths);
  const names = new Set(valid.flatMap(sample => Object.keys(sample.blendshapes || {})));
  next.neutralBlendshapes = Object.fromEntries([...names].map(name =>
    [name, quantile(valid.map(sample => sample.blendshapes?.[name]))]));
  return next;
}

function eyeBlink(value, settings, side) {
  const closed = setting(settings, `eyeClosed${side}`, 0, .75);
  // Corrupt or crossed sliders never divide by zero or invert a blink.
  const open = Math.max(closed + .005, setting(settings, `eyeOpen${side}`, .005, .9));
  return 1 - smoothstep((value - closed) / (open - closed));
}

function targetHead(measurement, calibration, strength) {
  const q = new Quaternion().fromArray(measurement.head);
  if (validQuaternion(calibration.neutralHead)) {
    // World delta preserves the camera axes even if neutral was tilted.
    q.multiply(new Quaternion().fromArray(calibration.neutralHead).normalize().invert());
  }
  q.normalize();
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  // Scale the rotation angle via a quaternion interpolation, never its components.
  q.copy(new Quaternion().slerp(q, strength));
  const angles = new Euler().setFromQuaternion(q, 'YXZ');
  angles.x = clamp(angles.x, -40 * DEG, 45 * DEG);
  angles.y = clamp(angles.y, -65 * DEG, 65 * DEG);
  angles.z = clamp(angles.z, -40 * DEG, 40 * DEG);
  return q.setFromEuler(angles).normalize();
}

function expressionTargets(measurement, settings, calibration) {
  const output = zeroExpressions();
  const score = name => {
    const raw = finite(measurement.blendshapes[name]);
    const baseline = clamp(finite(calibration.neutralBlendshapes?.[name]), 0, .85);
    return clamp((raw - baseline - .025) / (1 - baseline - .025));
  };
  const average = (left, right) => (score(left) + score(right)) / 2;
  output.blinkLeft = eyeBlink(measurement.leftEyeOpen, settings, 'Left');
  output.blinkRight = eyeBlink(measurement.rightEyeOpen, settings, 'Right');
  if (settings.blinkLink) output.blinkLeft = output.blinkRight = Math.max(output.blinkLeft, output.blinkRight);
  const mouthStrength = setting(settings, 'mouthStrength', 0, 2);
  const smile = average('mouthSmileLeft', 'mouthSmileRight');
  const stretch = average('mouthStretchLeft', 'mouthStretchRight');
  const pucker = score('mouthPucker');
  const funnel = score('mouthFunnel');
  const widthCalibrated = Number.isFinite(calibration.mouthWidthNeutral) && calibration.mouthWidthNeutral > .1;
  const neutralWidth = clamp(finite(calibration.mouthWidthNeutral, .75), .2, 1.6);
  const relativeWidth = clamp(finite(measurement.mouthWidth, neutralWidth) / neutralWidth, .3, 2);
  // Express lip separation in *neutral* mouth widths: otherwise narrowing the
  // lips alone increases mouthOpen and changes a nearly closed "u" into "o".
  const gap = Math.max(0, measurement.mouthOpen * relativeWidth - finite(calibration.mouthNeutral, .025));
  const jaw = score('jawOpen') * (1 - .85 * score('mouthClose'));
  const opening = clamp(Math.max((gap - .015) / .50, jaw * .85));
  // A person's naturally narrow mouth must not count as pursing before capture.
  const spreadSignal = Math.max(stretch, smile * .9,
    widthCalibrated ? smoothstep((relativeWidth - 1.05) / .30) : 0);
  const roundSignal = Math.max(pucker, funnel,
    widthCalibrated ? smoothstep((.90 - relativeWidth) / .30) : 0);
  const round = smoothstep((roundSignal - .03) / .67);
  const wide = smoothstep((spreadSignal - .04) / .65);
  // The three shape families sum to one. Aperture independently separates i/e
  // and u/o, without changing the inferred shape when sensitivity is adjusted.
  // These are visible lip poses, not phoneme or emotion recognition from audio.
  const wideWeight = (1 - round) * wide;
  const neutralWeight = (1 - round) * (1 - wide);
  const iToE = smoothstep((opening - .10) / .45);
  const uToO = smoothstep((opening - .14) / .48);
  const parted = smoothstep((gap - .008) / .045);
  // A pursed "u" and a narrow-gap "i" must be visible even with a closed jaw.
  // A closed-lip smile remains an emotion; it does not force the mouth open.
  const wideAmount = Math.max(opening, spreadSignal * parted);
  const roundAmount = Math.max(opening, roundSignal);
  const vowels = {
    aa: neutralWeight * opening,
    ih: wideWeight * (1 - iToE) * wideAmount,
    ee: wideWeight * iToE * wideAmount,
    ou: round * (1 - uToO) * roundAmount,
    oh: round * uToO * roundAmount,
  };
  const vowelScale = mouthStrength / Math.max(1,
    Object.values(vowels).reduce((sum, weight) => sum + weight, 0) * mouthStrength);
  for (const [name, weight] of Object.entries(vowels)) output[name] = weight * vowelScale;
  const strength = setting(settings, 'expressionStrength', 0, 1.5);
  const browDown = average('browDownLeft', 'browDownRight');
  const browUp = Math.max(score('browInnerUp'), average('browOuterUpLeft', 'browOuterUpRight'));
  const eyeWide = average('eyeWideLeft', 'eyeWideRight');
  const tension = Math.max(average('mouthPressLeft', 'mouthPressRight'),
    average('noseSneerLeft', 'noseSneerRight'));
  output.happy = smoothstep((smile - .04) / .66) * strength
    * setting(settings, 'smileStrength', 0, 2);
  // Lowered brows carry the visible angry pose. Pressed lips or a nose wrinkle
  // add support, rather than being a mandatory second gesture.
  output.angry = smoothstep((browDown * (.85 + .15 * tension) - .04) / .66) * strength
    * setting(settings, 'angryStrength', 0, 2);
  output.sad = smoothstep((Math.min(average('mouthFrownLeft', 'mouthFrownRight'),
    score('browInnerUp')) - .04) / .66) * strength;
  // Talking/yawning alone must not trigger surprise. Both raised brows and
  // widened eyes are required; outer-brow raising works as well as inner-brow.
  output.surprised = Math.sqrt(smoothstep((browUp - .08) / .62)
    * smoothstep((eyeWide - .05) / .60)) * strength
    * setting(settings, 'surpriseStrength', 0, 2);
  const emotionSum = output.happy + output.angry + output.sad + output.surprised;
  if (emotionSum > 1) for (const name of ['happy', 'angry', 'sad', 'surprised']) output[name] /= emotionSum;
  return output;
}

export class FaceSolver {
  constructor() { this.reset(); }

  reset() {
    this.head = new Quaternion();
    this.gaze = { yaw: 0, pitch: 0 };
    this.expressions = zeroExpressions();
    this.lastTime = null;
    this.lastSeen = -Infinity;
    this.gazeHoldUntil = -Infinity;
    this.initialized = false;
    this.metrics = { leftEyeOpen: 0, rightEyeOpen: 0 };
  }

  update(result, timeSeconds, settings = {}, calibration = {}) {
    const now = Math.max(finite(timeSeconds, this.lastTime ?? 0), this.lastTime ?? 0);
    const dt = this.lastTime === null ? 1 / 60 : clamp(now - this.lastTime, 0, .5);
    this.lastTime = now;
    const measurement = measureFace(result);
    const tracked = measurement !== null;
    const smoothing = setting(settings, 'faceSmoothing', 0, .5);
    if (tracked) {
      this.lastSeen = now;
      this.metrics = { leftEyeOpen: measurement.leftEyeOpen, rightEyeOpen: measurement.rightEyeOpen };
      const target = targetHead(measurement, calibration, setting(settings, 'headStrength', 0, 2));
      const expressions = expressionTargets(measurement, settings, calibration);
      const closed = Math.max(expressions.blinkLeft, expressions.blinkRight) > .35;
      if (closed) this.gazeHoldUntil = now + setting(settings, 'blinkHoldMs', 0, 500) / 1000;
      const initialized = this.initialized;
      this.head.slerp(target, initialized ? alpha(dt, smoothing) : 1).normalize();
      for (const name of EXPRESSION_NAMES) {
        // Eyelids need a fast closing response even when head smoothing is high.
        const tau = name.startsWith('blink')
          ? Math.min(smoothing, expressions[name] > this.expressions[name] ? .016 : .045)
          : smoothing;
        this.expressions[name] += (expressions[name] - this.expressions[name]) * (initialized ? alpha(dt, tau) : 1);
      }
      // Freeze the *rendered* gaze throughout either eye's closing and reopening.
      // MediaPipe often reports centered iris/look scores during this interval.
      if (!closed && now >= this.gazeHoldUntil && measurement.gazeValid) {
        const strength = setting(settings, 'gazeStrength', 0, 2);
        for (const [axis, limit] of [['yaw', 35], ['pitch', 25]]) {
          const targetGaze = clamp((measurement.gaze[axis] - finite(calibration.neutralGaze?.[axis])) * strength, -limit, limit);
          this.gaze[axis] += (targetGaze - this.gaze[axis]) * (initialized ? alpha(dt, Math.max(.025, smoothing)) : 1);
        }
      }
      this.initialized = true;
    } else if (now - this.lastSeen > .35) {
      const fade = alpha(dt, .3);
      this.head.slerp(new Quaternion(), fade).normalize();
      this.gaze.yaw *= 1 - fade;
      this.gaze.pitch *= 1 - fade;
      for (const name of EXPRESSION_NAMES) this.expressions[name] *= 1 - fade;
      this.gazeHoldUntil = -Infinity;
    }
    return {
      tracked, head: this.head.toArray(), gaze: { ...this.gaze },
      expressions: { ...this.expressions }, metrics: { ...this.metrics }, measurement,
    };
  }
}
