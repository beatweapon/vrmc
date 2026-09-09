import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeSettings} from '../docs/fullbody/settings.js';

test('persisted settings reject invalid types and keep eye thresholds ordered',()=>{
  const settings=sanitizeSettings({fps:Infinity,headStrength:'broken',trackHands:'false',background:'url(x)',eyeClosedLeft:.4,eyeOpenLeft:.08,quality:'light'});
  assert.equal(settings.fps,24);
  assert.equal(settings.headStrength,1);
  assert.equal(settings.trackHands,true);
  assert.equal(settings.background,'transparent');
  assert.equal(settings.quality,'light');
  assert.ok(settings.eyeOpenLeft>settings.eyeClosedLeft);
});

test('avatar mirror defaults on for existing profiles and persists separately from camera preview',()=>{
  assert.equal(sanitizeSettings({mirrorPreview:true}).mirrorAvatar,true);
  const settings=sanitizeSettings({mirrorAvatar:false,mirrorPreview:true});
  assert.equal(settings.mirrorAvatar,false);
  assert.equal(settings.mirrorPreview,true);
});

test('expression sensitivity defaults are backward compatible and independently bounded',()=>{
  const old=sanitizeSettings({expressionStrength:.7});
  assert.equal(old.smileStrength,1);
  assert.equal(old.surpriseStrength,1);
  assert.equal(old.angryStrength,1);
  const adjusted=sanitizeSettings({smileStrength:0,surpriseStrength:5,angryStrength:NaN});
  assert.equal(adjusted.smileStrength,0);
  assert.equal(adjusted.surpriseStrength,2);
  assert.equal(adjusted.angryStrength,1);
});
