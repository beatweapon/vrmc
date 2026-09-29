import test from 'node:test';
import assert from 'node:assert/strict';
import {replayHead} from './helpers/head-motion.js';

// Acceptance bounds chosen from the pre-change replay, before changing the
// runtime. A step-response formula alone cannot expose inter-observation stalls.
for(const fps of [4,7,10,15,24]) for(const renderFps of [30,60]) {
  test(`continuous head motion at ${fps} observations / ${renderFps} renders per second balances cadence and lag`,()=>{
    const {metrics}=replayHead({fps,renderFps});
    assert.ok(metrics.speedP10>.5,`head nearly stopped between observations: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.speedP90<1.5,`head rushed after observations: ${JSON.stringify(metrics)}`);
    const budget=fps===4?.37:fps===7?.24:fps===10?.21:.18;
    assert.ok(metrics.lagP95<budget,`p95 lag exceeds ${budget}s: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.maxOvershoot<1e-6,'no prediction beyond the observed turn');
    assert.ok(metrics.finalError<1e-6,'head settles when the person stops');
  });
}

for(const fps of [4,7,10]) test(`irregular ${fps} fps head observations do not restore repeated stalls`,()=>{
  const {metrics}=replayHead({fps,jitter:true});
  assert.ok(metrics.speedP10>.35,`head stalled: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.speedP90<1.75,`head rushed: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.lagP95<(fps===4?.41:.26),`lag regression: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.maxOvershoot<1e-6 && metrics.finalError<1e-6);
});

for(const fps of [4,7,10,15,24]) test(`head reverses and recovers from missing/empty observations at ${fps} fps without a pose jump`,()=>{
  for(const dropout of [false,true]) for(const lostPackets of [false,true]) for(const renderFps of [30,60]) {
    const {traces}=replayHead({fps,renderFps,turnBack:true,dropout,lostPackets});
    assert.ok(traces.every(point=>Number.isFinite(point.angle)));
    assert.ok(Math.max(...traces.map(point=>Math.abs(point.velocity)))<1.5,'reacquisition must not snap the head');
    assert.ok(Math.abs(traces.at(-1).angle)<1e-5,'the stopped head must settle');
    assert.ok(Math.max(...traces.map(point=>point.angle))<=.48+1e-6,'turn reversal must not predict past the observed turn');
  }
});
