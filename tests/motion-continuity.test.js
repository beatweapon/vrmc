import test from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { dampVector, dampQuaternion } from '../docs/fullbody/motion.js';
import { ArmMotion, solveTwoBoneIK } from '../docs/fullbody/arm-ik.js';

for (const side of ['left','right']) test(`${side} hand acquisition rises in front of the torso instead of collapsing reach and leading with the elbow`, () => {
  const sign=side==='left'?1:-1;
  const shoulder=new Vector3(sign*.2,0,0), target=shoulder.clone().add(new Vector3(sign*.03,.28,.096));
  const motion=new ArmMotion(new Vector3(sign*.168,-.576,0));
  let maxDepth=0,maxLateral=0,minReach=Infinity,result;
  for(let i=0;i<180;i++) {
    result=motion.update({shoulder,target,side,upperLength:.3,lowerLength:.3,width:.4,height:.5,dt:1/60,response:.16});
    maxDepth=Math.max(maxDepth,result.wrist.z);
    if(result.wrist.y<0) maxLateral=Math.max(maxLateral,sign*(result.elbow.x-shoulder.x));
    minReach=Math.min(minReach,result.wrist.distanceTo(shoulder));
    if(result.wrist.y>-.35 && result.wrist.y<0) assert.ok(result.elbow.y<result.wrist.y+.04,
      `elbow led the hand upwards: elbow=${result.elbow.toArray()}, wrist=${result.wrist.toArray()}`);
  }
  assert.ok(maxDepth>.22,'raise must pass in front of the body');
  assert.ok(minReach>.25,'the transition must not fold the wrist into the shoulder');
  assert.ok(maxLateral<.18,`elbow abducted ${maxLateral}m during acquisition`);
  assert.ok(result.wrist.distanceTo(target)<1e-5,'the final observed wrist position must remain unchanged');
});

test('raised wrist crosses the sagittal angle boundary without travelling back around the shoulder', () => {
  const shoulder=new Vector3(.2,0,0);
  const motion=new ArmMotion(new Vector3(.1,.4,.01));
  const target=shoulder.clone().add(new Vector3(.1,.4,-.01));
  let previous=shoulder.clone().add(motion.offset),result;
  for(let i=0;i<120;i++) {
    result=motion.update({shoulder,target,side:'left',upperLength:.3,lowerLength:.3,
      width:.4,height:.5,dt:1/60,response:.16});
    assert.ok(result.wrist.y>.399,'the hand must stay raised across +/- pi');
    assert.ok(result.wrist.distanceTo(previous)<.003,'the angle branch must remain continuous');
    previous=result.wrist;
  }
  assert.ok(result.wrist.distanceTo(target)<1e-6);
});

test('a constant elbow hint has no second convergence after the wrist reaches its target', () => {
  const shoulder = new Vector3(.2, 0, 0), target = shoulder.clone().add(new Vector3(.03,.28,.096));
  const motion = new ArmMotion(new Vector3(.168,-.576,0));
  let checked = 0;
  for (let i=0;i<180;i++) {
    const current = motion.update({shoulder,target,side:'left',upperLength:.3,lowerLength:.3,
      width:.4,height:.5,dt:1/60,response:.16});
    if (current.wrist.distanceTo(target)<.005) {
      // Some elbow displacement is required by the remaining wrist movement.
      // Compare to the IK for THIS wrist, not an unrelated elbow speed limit.
      const expected = solveTwoBoneIK(shoulder,current.wrist,.3,.3,new Vector3(.15,-1,-.25),0);
      assert.ok(current.elbow.distanceTo(expected.elbow)<.001,
        `elbow is ${current.elbow.distanceTo(expected.elbow)}m behind the current wrist constraint`);
      checked++;
    }
  }
  assert.ok(checked > 60);
});

test('critical motion preserves velocity at a new observation instead of restarting each camera frame', () => {
  const value = new Vector3(), velocity = new Vector3();
  dampVector(value, velocity, new Vector3(1, 0, 0), .06, .12);
  const before = velocity.x;
  const start = value.x;
  dampVector(value, velocity, new Vector3(-1, 0, 0), 1e-6, .12);
  assert.ok(Math.abs(velocity.x - before) < .001);
  assert.ok(Math.abs((value.x - start) / 1e-6 - before) < .001);
  for (let i = 0; i < 120; i++) dampVector(value, velocity, new Vector3(-1, 0, 0), 1 / 60, .12);
  assert.ok(value.distanceTo(new Vector3(-1, 0, 0)) < 1e-8);
  assert.ok(velocity.length() < 1e-8);
});

test('position and rotation responses agree at 30, 60 and 144 render fps', () => {
  const simulate = fps => {
    const value = new Vector3(), velocity = new Vector3(), rotation = new Quaternion(), angular = new Vector3();
    const target = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 2);
    for (let i = 0; i < fps / 2; i++) {
      dampVector(value, velocity, new Vector3(1, 2, 3), 1 / fps, .2);
      dampQuaternion(rotation, angular, target, 1 / fps, .2);
    }
    return { value, rotation };
  };
  const expected = simulate(60);
  for (const fps of [30, 144]) {
    const actual = simulate(fps);
    assert.ok(actual.value.distanceTo(expected.value) < 1e-8);
    assert.ok(actual.rotation.angleTo(expected.rotation) < 1e-7);
  }
});

test('periodic palm orientations and quaternion sign do not reverse an in-flight rotation', () => {
  const value = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI - .1);
  const velocity = new Vector3();
  for (let i = 0; i < 180; i++) {
    const target = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI + .1);
    if (i % 2) target.set(-target.x, -target.y, -target.z, -target.w);
    const previous = value.clone();
    dampQuaternion(value, velocity, target, 1 / 60, .12);
    assert.ok(previous.angleTo(value) < .03);
  }
  assert.ok(value.angleTo(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI + .1)) < 1e-6);
});

for (const fps of [4, 10, 24]) for (const side of ['left', 'right']) {
  test(`${side} arm raises, crosses the chest and lowers at ${fps} camera fps with fixed lengths and torso clearance`, () => {
    const sign = side === 'left' ? 1 : -1;
    const shoulder = new Vector3(sign * .2, 0, 0);
    const start = new Vector3(sign * .3, -.5, .12);
    const motion = new ArmMotion(start.clone().sub(shoulder));
    let target = start, previous = null, maxStep = 0, capture = -1;
    for (let i = 0; i < 720; i++) {
      const t = i / 60;
      if (Math.floor(t * fps) > capture) {
        capture = Math.floor(t * fps);
        const phase = Math.min(1, Math.max(0, t - 1) / 8);
        const elevation = Math.sin(Math.min(1, phase) * Math.PI) ** 2;
        const crossing = Math.max(0, Math.sin((phase - .25) * 2 * Math.PI));
        target = new Vector3(sign * (.3 - .55 * crossing), -.5 + .8 * elevation, .12);
      }
      const solved = motion.update({ shoulder, target, side, upperLength: .3, lowerLength: .3,
        width: .4, height: .5, dt: 1 / 60, response: Math.max(.12, 1.1 / fps) });
      assert.ok(solved.elbow.toArray().every(Number.isFinite));
      assert.ok(Math.abs(solved.elbow.distanceTo(shoulder) - .3) < 1e-7);
      assert.ok(Math.abs(solved.elbow.distanceTo(solved.wrist) - .3) < 1e-7);
      for (const joint of [solved.elbow, solved.elbow.clone().lerp(solved.wrist, .5)]) {
        if (joint.y <= .025 && joint.y >= -.5) {
          const clearance = (joint.x / (.4 * .47)) ** 2 + (joint.z / (.4 * .32)) ** 2 + ((joint.y+.25)/.28)**2;
          assert.ok(clearance >= .995, `torso penetration at ${t}: ${joint.toArray()}`);
        }
      }
      if (previous) maxStep = Math.max(maxStep, previous.distanceTo(solved.elbow));
      previous = solved.elbow;
    }
    assert.ok(maxStep < .035, `elbow jumped ${maxStep} m in one display frame`);
    assert.ok(motion.velocity.length() < .005, 'stationary end must settle');
  });
}

test('bend plane survives full extension and almost collinear noisy elbow observations', () => {
  const shoulder = new Vector3(.2, 0, 0);
  const motion = new ArmMotion(new Vector3(.4, -.2, .05));
  let previous;
  for (let i = 0; i < 360; i++) {
    const phase = i / 359;
    const axis = new Vector3(.8 * Math.cos(phase * 2), .8 * Math.sin(phase * 2), .1).normalize();
    const length = .58 + .025 * Math.sin(phase * Math.PI);
    const measuredElbow = axis.clone().add(new Vector3(.001 * Math.sin(i), .001 * Math.cos(i), 0)).normalize();
    const result = motion.update({ shoulder, target: shoulder.clone().addScaledVector(axis, length), measuredElbow,
      side: 'left', upperLength: .3, lowerLength: .3, width: .4, height: .5, dt: 1 / 60, response: .12 });
    if (previous) assert.ok(previous.distanceTo(result.elbow) < .04,
      `straight arm singularity flipped the elbow at ${i}: ${previous.toArray()} -> ${result.elbow.toArray()}`);
    previous = result.elbow;
  }
});

test('an elbow hint crossing the wrist axis cannot flip the bend plane on reacquisition', () => {
  const shoulder = new Vector3(.2,0,0), target = new Vector3(.65,-.1,.1);
  const axis = target.clone().sub(shoulder).normalize();
  const perpendicular = new Vector3(0,1,0).addScaledVector(axis,-axis.y).normalize();
  const motion = new ArmMotion(target.clone().sub(shoulder));
  let previous, maxStep = 0;
  for(let i=0;i<360;i++) {
    const strength = .5 * Math.cos(Math.PI * Math.min(1,Math.max(0,i-120)/120));
    const measuredElbow = axis.clone().addScaledVector(perpendicular,strength).normalize();
    const solved = motion.update({shoulder,target,measuredElbow,side:'left',upperLength:.3,lowerLength:.3,
      width:.4,height:.5,dt:1/60,response:.16});
    if(previous) maxStep = Math.max(maxStep,solved.elbow.distanceTo(previous));
    previous = solved.elbow;
  }
  assert.ok(maxStep<.08,`elbow flipped ${maxStep}m when its hint crossed the wrist axis`);
});
