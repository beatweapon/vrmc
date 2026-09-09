import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { FaceSolver, calibrateFace, measureFace } from '../docs/fullbody/face.js';

const DEG = Math.PI / 180;
const immediate = { faceSmoothing: 0 };
const qFor = (x = 0, y = 0, z = 0) => new Quaternion().setFromEuler(new Euler(x * DEG, y * DEG, z * DEG, 'YXZ'));
function close(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `Expected ${actual} to be within ${tolerance} of ${expected}`);
}

function result({ leftEar = .28, rightEar = .28, yaw = 18, pitch = -4,
  head = new Quaternion(), aspect = 16 / 9, scale = 1, shapes = {}, iris = true } = {}) {
  const landmarks = Array.from({ length: iris ? 478 : 468 }, () => ({ x: .5, y: .5, z: 0 }));
  const set = (index, x, y, z = 0) => {
    if (index >= landmarks.length) return;
    const p = new Vector3(x * scale, y * scale, z * scale).applyQuaternion(head);
    landmarks[index] = { x: .5 + p.x, y: .5 - p.y * aspect, z: -p.z };
  };
  function eye(indices, irisIndex, center, ear) {
    const width = .12;
    const h = ear * width / 2;
    const positions = [[-.5, 0], [-.25, h], [.25, h], [.5, 0], [.25, -h], [-.25, -h]];
    positions.forEach(([x, y], index) => set(indices[index], center + x * width, .08 + y));
    set(irisIndex, center + yaw / 100 * width, .08 - pitch / 100 * width);
  }
  eye([362, 385, 387, 263, 373, 380], 473, .13, leftEar);
  eye([33, 160, 158, 133, 153, 144], 468, -.13, rightEar);
  set(13, 0, -.10); set(14, 0, -.105);
  set(61, -.10, -.10); set(291, .10, -.10);
  set(234, -.24, 0); set(454, .24, 0);
  set(10, 0, .3); set(152, 0, -.3);
  const gazeShapes = {
    eyeLookOutLeft: Math.max(yaw, 0) / 30, eyeLookInLeft: Math.max(-yaw, 0) / 30,
    eyeLookInRight: Math.max(yaw, 0) / 30, eyeLookOutRight: Math.max(-yaw, 0) / 30,
    eyeLookDownLeft: Math.max(pitch, 0) / 22, eyeLookUpLeft: Math.max(-pitch, 0) / 22,
    eyeLookDownRight: Math.max(pitch, 0) / 22, eyeLookUpRight: Math.max(-pitch, 0) / 22,
  };
  return {
    aspectRatio: aspect,
    faceLandmarks: [landmarks],
    faceBlendshapes: [{ categories: Object.entries({ ...gazeShapes, ...shapes })
      .map(([categoryName, score]) => ({ categoryName, score })) }],
    facialTransformationMatrixes: [{ rows: 4, columns: 4,
      data: new Matrix4().compose(new Vector3(.2, .3, -50), head, new Vector3(2, 2, 2)).toArray() }],
  };
}

test('EAR remains unchanged with image aspect, distance, and head rotation', () => {
  for (const aspect of [1, 16 / 9, 9 / 16]) {
    for (const scale of [.4, 1.8]) {
      const measured = measureFace(result({ leftEar: .3, rightEar: .1, aspect, scale, head: qFor(15, -30, 27) }));
      close(measured.leftEyeOpen, .3);
      close(measured.rightEyeOpen, .1);
    }
  }
});

test('column-major matrix preserves pitch, yaw and roll, ignoring scale and translation', () => {
  const expected = qFor(14, -22, 32);
  const measured = measureFace(result({ head: expected }));
  const actual = new Quaternion().fromArray(measured.head);
  close(actual.length(), 1);
  close(actual.angleTo(expected), 0);
  const solved = new FaceSolver().update(result({ head: expected }), 0, immediate);
  close(new Quaternion().fromArray(solved.head).angleTo(expected), 0);
});

test('landmark orientation fallback uses the same camera axes as the matrix', () => {
  const expected = qFor(14, -22, 32);
  const frame = result({ head: expected });
  frame.facialTransformationMatrixes = [];
  const measured = measureFace(frame);
  close(new Quaternion().fromArray(measured.head).angleTo(expected), 0);
});

test('a wink freezes both eyes gaze during closure and the reopen hold, without a recenter flash', () => {
  const solver = new FaceSolver();
  const settings = { ...immediate, blinkHoldMs: 140 };
  const initial = solver.update(result({ yaw: 18 }), 0, settings);
  const closed = solver.update(result({ leftEar: .06, yaw: 0 }), .04, settings);
  close(closed.expressions.blinkLeft, 1);
  close(closed.expressions.blinkRight, 0);
  assert.deepEqual(closed.gaze, initial.gaze);
  const reopening = solver.update(result({ yaw: 0 }), .08, settings);
  assert.deepEqual(reopening.gaze, initial.gaze);
  assert.deepEqual(solver.update(result({ yaw: 0 }), .17, settings).gaze, initial.gaze);
  const recovered = solver.update(result({ yaw: -12 }), .20, settings);
  assert.ok(recovered.gaze.yaw < initial.gaze.yaw);
  assert.ok(recovered.gaze.yaw > -12);
});

test('blink lock freezes the current smoothed gaze, including an in-flight eye movement', () => {
  const solver = new FaceSolver();
  solver.update(result({ yaw: 0 }), 0, {});
  const moving = solver.update(result({ yaw: 24 }), .03, {});
  assert.ok(moving.gaze.yaw > 0 && moving.gaze.yaw < 24);
  const blink = solver.update(result({ rightEar: .05, yaw: 0 }), .06, {});
  assert.deepEqual(blink.gaze, moving.gaze);
});

test('eye sliders are authoritative after calibration, and blink linking is optional', () => {
  const calibration = { eyeOpenLeft: .6, eyeClosedLeft: .5 };
  const open = new FaceSolver().update(result(), 0, immediate, calibration);
  close(open.expressions.blinkLeft, 0);
  const partial = new FaceSolver().update(result(), 0, { ...immediate, eyeOpenLeft: .4 });
  assert.ok(partial.expressions.blinkLeft > .2);
  const linked = new FaceSolver().update(result({ rightEar: .05 }), 0, { ...immediate, blinkLink: true });
  close(linked.expressions.blinkLeft, 1);
  close(linked.expressions.blinkRight, 1);
});

test('neutral calibration cancels measured pose and gaze, including antipodal quaternions', () => {
  const capture = measureFace(result({ head: qFor(12, 19, -15), yaw: 9, pitch: 3, shapes: { jawOpen: .2 } }));
  const samples = Array.from({ length: 20 }, (_, index) => ({ ...capture,
    head: capture.head.map(n => n * (index % 2 ? -1 : 1)) }));
  const calibration = calibrateFace(samples, 'neutral', { eyeOpenLeft: .31 });
  close(calibration.eyeOpenLeft, .31);
  assert.equal(calibration.version, 1);
  const output = new FaceSolver().update(result({ head: qFor(12, 19, -15), yaw: 9, pitch: 3, shapes: { jawOpen: .2 } }), 0, immediate, calibration);
  close(new Quaternion().fromArray(output.head).angleTo(new Quaternion()), 0);
  close(output.gaze.yaw, 0); close(output.gaze.pitch, 0); close(output.expressions.aa, 0);
});

test('tilted neutral calibration preserves world-axis motion without adding yaw to a roll', () => {
  const neutral = qFor(17, 24, 18);
  const delta = qFor(0, 0, 12);
  const measured = delta.clone().multiply(neutral);
  const output = new FaceSolver().update(result({ head: measured }), 0, immediate, { neutralHead: neutral.toArray() });
  close(new Quaternion().fromArray(output.head).angleTo(delta), 0);
});

test('head strength scales rotation angle and angular limits keep the result normalized', () => {
  const half = new FaceSolver().update(result({ head: qFor(0, 0, 30) }), 0, { ...immediate, headStrength: .5 });
  close(new Quaternion().fromArray(half.head).angleTo(qFor(0, 0, 15)), 0);
  const extreme = new FaceSolver().update(result({ head: qFor(60, 80, 70) }), 0, immediate);
  const q = new Quaternion().fromArray(extreme.head);
  const angles = new Euler().setFromQuaternion(q, 'YXZ');
  close(q.length(), 1);
  assert.ok(Math.abs(angles.x) <= 45 * DEG + 1e-6);
  assert.ok(Math.abs(angles.y) <= 65 * DEG + 1e-6);
  assert.ok(Math.abs(angles.z) <= 40 * DEG + 1e-6);
});

test('head filter has equal response at 30 and 60 fps', () => {
  function simulate(fps) {
    const solver = new FaceSolver();
    solver.update(result({ head: qFor() }), 0, {});
    let output;
    for (let i = 1; i <= fps; i++) output = solver.update(result({ head: qFor(10, 20, 25) }), i / fps, { faceSmoothing: .2 });
    return new Quaternion().fromArray(output.head);
  }
  close(simulate(30).angleTo(simulate(60)), 0);
});

test('tracking loss briefly holds pose, then eases to neutral and reset clears it', () => {
  const solver = new FaceSolver();
  const initial = solver.update(result({ head: qFor(0, 20, 10), shapes: { jawOpen: .6 } }), 0, immediate);
  const held = solver.update(null, .2, immediate);
  assert.equal(held.tracked, false);
  assert.deepEqual(held.head, initial.head);
  assert.deepEqual(held.gaze, initial.gaze);
  let faded;
  for (let t = .4; t < 3; t += .1) faded = solver.update({}, t, immediate);
  assert.ok(new Quaternion().fromArray(faded.head).angleTo(new Quaternion()) < .001);
  assert.ok(Math.abs(faded.gaze.yaw) < .01);
  assert.ok(faded.expressions.aa < .001);
  solver.reset();
  assert.deepEqual(solver.update(null, 0).head, [0, 0, 0, 1]);
});

test('invalid input and crossed or non-finite thresholds cannot create NaNs', () => {
  assert.equal(measureFace(null), null);
  assert.equal(measureFace({ faceLandmarks: [[]] }), null);
  const bad = result();
  bad.faceLandmarks[0][385].x = NaN;
  assert.equal(measureFace(bad), null);
  const output = new FaceSolver().update(result(), NaN, {
    eyeOpenLeft: .08, eyeClosedLeft: .08, eyeOpenRight: .04, eyeClosedRight: .3,
    faceSmoothing: NaN, gazeStrength: Infinity, headStrength: Infinity,
  }, { neutralHead: [0, NaN, 0, 1] });
  for (const value of [...output.head, ...Object.values(output.gaze), ...Object.values(output.expressions)]) {
    assert.ok(Number.isFinite(value));
  }
  for (const value of Object.values(output.expressions)) assert.ok(value >= 0 && value <= 1);
});

test('missing look scores and iris hold gaze instead of injecting a zero target', () => {
  const solver = new FaceSolver();
  solver.update(result({ yaw: 18 }), 0, immediate);
  const missing = result({ iris: false });
  missing.faceBlendshapes = [];
  assert.equal(measureFace(missing).gazeValid, false);
  close(solver.update(missing, .2, immediate).gaze.yaw, 18);
});

test('eye calibration rejects insufficient separation, retains other captures, and resists an outlier', () => {
  const open = measureFace(result({ leftEar: .32, rightEar: .29 }));
  const samples = Array.from({ length: 15 }, () => open);
  samples.push(measureFace(result({ leftEar: .04, rightEar: .04 })));
  const first = calibrateFace(samples, 'eyesOpen', { neutralHead: [0, 0, 0, 1] });
  close(first.eyeOpenLeft, .32); close(first.eyeOpenRight, .29);
  const closed = measureFace(result({ leftEar: .055, rightEar: .065 }));
  const second = calibrateFace(Array(15).fill(closed), 'eyesClosed', first);
  close(second.eyeClosedLeft, .055); close(second.eyeClosedRight, .065);
  assert.deepEqual(second.neutralHead, [0, 0, 0, 1]);
  assert.throws(() => calibrateFace(samples.slice(0, 3), 'eyesOpen'));
  assert.throws(() => calibrateFace(Array(15).fill(open), 'eyesClosed', first));
  assert.throws(() => calibrateFace(Array(15).fill(closed), 'eyesOpen', second));
  assert.throws(() => calibrateFace(Array(15).fill(closed), 'neutral'));
});

test('moving neutral capture fails with an actionable error', () => {
  const samples = Array.from({ length: 16 }, (_, index) => measureFace(result({ head: qFor(0, index % 2 ? 30 : -30, 0) })));
  assert.throws(() => calibrateFace(samples, 'neutral'), /顔が動きました/);
});
