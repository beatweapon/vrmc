import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { FaceSolver, calibrateFace, measureFace } from '../docs/fullbody/face.js';

const VOWELS = ['aa', 'ih', 'ou', 'ee', 'oh'];
const EMOTIONS = ['happy', 'angry', 'sad', 'surprised'];
const immediate = { faceSmoothing: 0 };

// Independent visible mouth poses: gap is measured in the person's REST mouth
// widths, so narrowing the lips does not also increase the physical aperture.
function face({ width = 1, gap = .025, shapes = {}, aspect = 16 / 9,
  scale = 1, head = new Quaternion() } = {}) {
  const landmarks = Array.from({ length: 478 }, () => ({ x: .5, y: .5, z: 0 }));
  const put = (index, x, y) => {
    const p = new Vector3(x, y, 0).multiplyScalar(scale).applyQuaternion(head);
    landmarks[index] = { x: .5 + p.x, y: .5 - p.y * aspect, z: -p.z };
  };
  for (const [indices, iris, center] of [
    [[33, 160, 158, 133, 153, 144], 468, -.12],
    [[362, 385, 387, 263, 373, 380], 473, .12],
  ]) {
    const positions = [[-.04, 0], [-.02, .0112], [.02, .0112], [.04, 0], [.02, -.0112], [-.02, -.0112]];
    positions.forEach(([x, y], i) => put(indices[i], center + x, .1 + y));
    put(iris, center, .1);
  }
  put(13, 0, -.10 + .09 * gap);
  put(14, 0, -.10 - .09 * gap);
  put(61, -.09 * width, -.10);
  put(291, .09 * width, -.10);
  return {
    aspectRatio: aspect,
    faceLandmarks: [landmarks],
    facialTransformationMatrixes: [{ rows: 4, columns: 4,
      data: new Matrix4().makeRotationFromQuaternion(head).toArray() }],
    faceBlendshapes: [{ categories: Object.entries(shapes).map(([categoryName, score]) => ({ categoryName, score })) }],
  };
}

function solve(pose = {}, settings = {}, calibration = {}) {
  return new FaceSolver().update(face(pose), 0, { ...immediate, ...settings }, calibration).expressions;
}

const poses = {
  aa: { width: 1.02, gap: .43, shapes: { jawOpen: .7 } },
  ih: { width: 1.24, gap: .085, shapes: { jawOpen: .09, mouthStretchLeft: .78, mouthStretchRight: .78 } },
  ou: { width: .72, gap: .03, shapes: { jawOpen: .035, mouthPucker: .8 } },
  ee: { width: 1.23, gap: .25, shapes: { jawOpen: .38, mouthStretchLeft: .7, mouthStretchRight: .7 } },
  oh: { width: .78, gap: .35, shapes: { jawOpen: .5, mouthFunnel: .8 } },
};
const dominantVowel = expressions => VOWELS.reduce((best, name) => expressions[name] > expressions[best] ? name : best);

for (const [vowel, pose] of Object.entries(poses)) {
  test(`visible ${vowel} mouth pose primarily drives its own VRM vowel`, () => {
    const expressions = solve(pose);
    assert.equal(dominantVowel(expressions), vowel, JSON.stringify(expressions));
    assert.ok(expressions[vowel] > .5, `${vowel} should be visible: ${expressions[vowel]}`);
    const next = Math.max(...VOWELS.filter(name => name !== vowel).map(name => expressions[name]));
    assert.ok(expressions[vowel] > next * 2);
  });
}

test('relaxed closed lips and a closed-lip smile do not open the vowel morphs', () => {
  for (const pose of [{}, { width: .7 }, { width: 1.2,
    shapes: { mouthSmileLeft: .8, mouthSmileRight: .8 } }]) {
    const expressions = solve(pose);
    for (const name of VOWELS) assert.ok(expressions[name] < .005, `${name}: ${expressions[name]}`);
  }
  assert.ok(solve({ shapes: { mouthSmileLeft: .8, mouthSmileRight: .8 } }).happy > .6);
});

test('a fully pursed u stays visible with jawOpen zero, without becoming o', () => {
  const expressions = solve({ width: .7, gap: .02, shapes: { jawOpen: 0, mouthPucker: .85 } });
  assert.ok(expressions.ou > .8);
  assert.ok(expressions.oh < .01);
});

test('opening the same spread or pursed lips changes i to e and u to o continuously', () => {
  for (const [shape, low, high] of [
    [{ mouthStretchLeft: .85, mouthStretchRight: .85 }, 'ih', 'ee'],
    [{ mouthPucker: .85 }, 'ou', 'oh'],
  ]) {
    let previousHigh = 0;
    let previousLow = 1;
    for (let gap = .06; gap <= .36; gap += .02) {
      const expressions = solve({ gap, shapes: shape });
      const total = expressions[low] + expressions[high];
      const highRatio = expressions[high] / total;
      const lowRatio = expressions[low] / total;
      assert.ok(highRatio >= previousHigh - 1e-8);
      assert.ok(lowRatio <= previousLow + 1e-8);
      previousHigh = highRatio;
      previousLow = lowRatio;
    }
    assert.ok(previousHigh > .85);
  }
});

test('mouth sensitivity changes intensity without changing the vowel or exceeding the morph budget', () => {
  for (const [vowel, pose] of Object.entries(poses)) {
    const normal = solve(pose);
    for (const mouthStrength of [.25, 1, 2]) {
      const expressions = solve(pose, { mouthStrength });
      assert.equal(dominantVowel(expressions), vowel);
      assert.ok(VOWELS.reduce((sum, name) => sum + expressions[name], 0) <= 1 + 1e-8);
      for (const name of VOWELS) assert.ok(expressions[name] >= 0 && expressions[name] <= 1);
      for (const name of VOWELS.filter(name => normal[name] > 1e-6)) {
        assert.ok(Math.abs(expressions[name] / expressions[vowel] - normal[name] / normal[vowel]) < 1e-8);
      }
    }
    for (const name of VOWELS) assert.equal(solve(pose, { mouthStrength: 0 })[name], 0);
  }
});

test('mouth measurements remain unchanged across camera aspect, scale, and rigid head rotation', () => {
  const expected = measureFace(face(poses.ee));
  for (const aspect of [1, 16 / 9, 9 / 16]) {
    for (const scale of [.5, 1.7]) {
      const head = new Quaternion().setFromEuler(new Euler(.25, -.5, .3));
      const actual = measureFace(face({ ...poses.ee, aspect, scale, head }));
      assert.ok(Math.abs(actual.mouthWidth - expected.mouthWidth) < 1e-8);
      assert.ok(Math.abs(actual.mouthOpen - expected.mouthOpen) < 1e-8);
      assert.equal(dominantVowel(solve({ ...poses.ee, aspect, scale, head })), 'ee');
    }
  }
});

test('neutral capture learns individual lip width and width geometry can supplement absent blendshapes', () => {
  const rest = { width: .78, gap: .025 };
  const calibration = calibrateFace(Array.from({ length: 12 }, () => measureFace(face(rest))), 'neutral');
  assert.ok(Math.abs(calibration.mouthWidthNeutral - .75 * rest.width) < 1e-8);
  for (const name of VOWELS) assert.ok(solve(rest, {}, calibration)[name] < .001);
  const geometryPoses = {
    aa: { width: .78, gap: .35 },
    ih: { width: .78 * 1.36, gap: .78 * .085 },
    ou: { width: .78 * .60, gap: .78 * .03 },
    ee: { width: .78 * 1.36, gap: .78 * .25 },
    oh: { width: .78 * .60, gap: .78 * .35 },
  };
  for (const [name, pose] of Object.entries(geometryPoses)) {
    assert.equal(dominantVowel(solve(pose, {}, calibration)), name);
  }
  const previousSchema = { ...calibration };
  delete previousSchema.mouthWidthNeutral;
  for (const value of Object.values(solve(rest, {}, previousSchema))) assert.ok(Number.isFinite(value));
});

test('smiling, lowered brows and raised brows with wide eyes each produce their visible emotion', () => {
  const cases = {
    happy: { mouthSmileLeft: .75, mouthSmileRight: .75 },
    angry: { browDownLeft: .8, browDownRight: .8 },
    surprised: { browOuterUpLeft: .75, browOuterUpRight: .75, eyeWideLeft: .7, eyeWideRight: .7 },
  };
  for (const [name, shapes] of Object.entries(cases)) {
    const expressions = solve({ shapes });
    assert.ok(expressions[name] > .5, `${name}: ${expressions[name]}`);
    for (const other of EMOTIONS.filter(other => other !== name)) assert.equal(expressions[other], 0);
  }
});

test('speech, yawning, or either raised brows or wide eyes alone cannot trigger surprise', () => {
  for (const shapes of [{ jawOpen: .95 }, { eyeWideLeft: .9, eyeWideRight: .9 },
    { browInnerUp: .9 }, { browOuterUpLeft: .9, browOuterUpRight: .9 }]) {
    assert.equal(solve({ gap: .6, shapes }).surprised, 0);
  }
});

test('emotion gains are independent of lip-sync strength and all channels remain bounded', () => {
  const shapes = { mouthSmileLeft: .8, mouthSmileRight: .8,
    browDownLeft: .8, browDownRight: .8, browInnerUp: .8, eyeWideLeft: .8, eyeWideRight: .8 };
  const pose = { gap: .2, shapes };
  const off = solve(pose, { expressionStrength: 0 });
  for (const name of EMOTIONS) assert.equal(off[name], 0);
  const lipOff = solve(pose, { mouthStrength: 0 });
  for (const name of VOWELS) assert.equal(lipOff[name], 0);
  assert.ok(lipOff.happy > 0 && lipOff.angry > 0 && lipOff.surprised > 0);
  for (const [name, setting] of [['happy', 'smileStrength'], ['angry', 'angryStrength'], ['surprised', 'surpriseStrength']]) {
    assert.equal(solve(pose, { [setting]: 0 })[name], 0);
  }
  const max = solve(pose, { expressionStrength: 1.5, smileStrength: 2, angryStrength: 2, surpriseStrength: 2 });
  assert.ok(EMOTIONS.reduce((sum, name) => sum + max[name], 0) <= 1 + 1e-8);
  for (const value of Object.values(max)) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
});

test('neutral calibration removes habitual blendshape bias before expression classification', () => {
  const rest = { shapes: { mouthSmileLeft: .35, mouthSmileRight: .4,
    browDownLeft: .3, browDownRight: .28, mouthPucker: .2, jawOpen: .15 } };
  const calibration = calibrateFace(Array.from({ length: 12 }, () => measureFace(face(rest))), 'neutral');
  const expressions = solve(rest, {}, calibration);
  for (const name of [...VOWELS, ...EMOTIONS]) assert.ok(expressions[name] < .001, `${name}: ${expressions[name]}`);
});
