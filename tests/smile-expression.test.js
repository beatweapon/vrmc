import test from 'node:test';
import assert from 'node:assert/strict';
import {smileEyesOnly} from '../docs/fullbody/smile-expression.js';

test('smile suppresses authored happy while preserving ordinary camera mouth expressions', () => {
  const face = {
    tracked: true,
    measurement: {mouthOpen:.18},
    expressions: {
      happy: .8,
      blinkLeft: .1,
      blinkRight: .5,
      aa: .42,
      ih: .18,
      ee: .07,
      ou: .03,
      oh: .11,
    },
  };
  const result = smileEyesOnly(face);
  assert.notEqual(result, face);
  assert.equal(result.expressions.happy, 0);
  assert.equal(result.expressions.blinkLeft, .28);
  assert.equal(result.expressions.blinkRight, .5);
  for (const name of ['aa', 'ih', 'ee', 'ou', 'oh']) {
    assert.equal(result.expressions[name], face.expressions[name],
      `ordinary mouth geometry must preserve camera-derived ${name}`);
  }
  assert.equal(face.expressions.happy, .8, 'input face data must remain immutable');
});

test('strong vertical opening shifts wide vowel weight to aa without using smile strength', () => {
  const face = {
    tracked:true,
    measurement:{mouthOpen:.5},
    expressions:{happy:0, blinkLeft:0, blinkRight:0, aa:.15, ih:.2, ee:.55, ou:.04, oh:.06},
  };
  const result = smileEyesOnly(face);
  assert.equal(result.expressions.happy, 0);
  assert.ok(result.expressions.aa > .75, JSON.stringify(result.expressions));
  assert.ok(result.expressions.ih < .05, JSON.stringify(result.expressions));
  assert.ok(result.expressions.ee < .15, JSON.stringify(result.expressions));
  assert.equal(result.expressions.ou, .04);
  assert.equal(result.expressions.oh, .06);
});

test('closed mouth stays closed while smile narrows the eyes', () => {
  const face = {tracked:true, measurement:{mouthOpen:0}, expressions:{happy:.9, blinkLeft:0, blinkRight:0, aa:0, ih:0, ee:0, ou:0, oh:0}};
  const result = smileEyesOnly(face);
  for (const name of ['aa', 'ih', 'ee', 'ou', 'oh']) assert.equal(result.expressions[name], 0);
  assert.equal(result.expressions.blinkLeft, .315);
  assert.equal(result.expressions.blinkRight, .315);
});

test('non-smile frames can still correct a strongly open mouth from camera geometry', () => {
  const face = {tracked:true, measurement:{mouthOpen:.46}, expressions:{happy:0, blinkLeft:.2, blinkRight:.3, aa:.1, ih:.1, ee:.6}};
  const result = smileEyesOnly(face);
  assert.notEqual(result, face);
  assert.ok(result.expressions.aa > face.expressions.aa);
  assert.ok(result.expressions.ee < face.expressions.ee);
  assert.equal(result.expressions.blinkLeft, .2);
  assert.equal(result.expressions.blinkRight, .3);
  assert.equal(smileEyesOnly(null), null);
});
