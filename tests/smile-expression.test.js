import test from 'node:test';
import assert from 'node:assert/strict';
import {smileEyesOnly} from '../docs/fullbody/smile-expression.js';

test('smile suppresses authored happy while preserving camera expressions exactly', () => {
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
  for (const name of ['blinkLeft', 'blinkRight', 'aa', 'ih', 'ee', 'ou', 'oh']) {
    assert.equal(result.expressions[name], face.expressions[name],
      `smile isolation must not alter camera-derived ${name}`);
  }
  assert.equal(face.expressions.happy, .8, 'input face data must remain immutable');
});

test('non-smile frames pass through unchanged', () => {
  const face = {tracked:true, expressions:{happy:0, blinkLeft:.2, blinkRight:.3, aa:.4}};
  assert.equal(smileEyesOnly(face), face);
  assert.equal(smileEyesOnly(null), null);
});
