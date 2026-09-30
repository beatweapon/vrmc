import test from 'node:test';
import assert from 'node:assert/strict';
import {smileEyesOnly} from '../docs/fullbody/smile-expression.js';

const mouthTotal = expressions => ['aa','ih','ee','ou','oh']
  .reduce((sum, name) => sum + (expressions[name] || 0), 0);

test('smile suppresses authored happy while preserving camera mouth aperture', () => {
  const face = {
    tracked: true,
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
  assert.ok(Math.abs(mouthTotal(result.expressions) - mouthTotal(face.expressions)) < 1e-12,
    'smile must reshape the mouth without increasing its total expression weight');
  assert.ok(result.expressions.ih + result.expressions.ee > face.expressions.ih + face.expressions.ee,
    'detected smile should make the camera-driven mouth shape wider');
  assert.equal(face.expressions.happy, .8, 'input face data must remain immutable');
});

test('closed mouth stays closed while smile still narrows the eyes', () => {
  const face = {tracked:true, expressions:{happy:.9, blinkLeft:0, blinkRight:0, aa:0, ih:0, ee:0, ou:0, oh:0}};
  const result = smileEyesOnly(face);
  assert.equal(mouthTotal(result.expressions), 0);
  assert.equal(result.expressions.blinkLeft, .315);
  assert.equal(result.expressions.blinkRight, .315);
});

test('non-smile frames pass through unchanged', () => {
  const face = {tracked:true, expressions:{happy:0, blinkLeft:.2, blinkRight:.3, aa:.4}};
  assert.equal(smileEyesOnly(face), face);
  assert.equal(smileEyesOnly(null), null);
});
