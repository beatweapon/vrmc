import test from 'node:test';
import assert from 'node:assert/strict';
import {Tracker} from '../docs/fullbody/tracker.js';

test('early face delivery keeps the frame in flight and ignores messages from a stopped session', async t => {
  const workers = [], events = [];
  class Worker {
    constructor() { workers.push(this); }
    postMessage(data) { if(data.type==='init') queueMicrotask(()=>this.onmessage({data:{type:'ready'}})); }
    terminate() {}
  }
  for (const [name,value] of Object.entries({Worker,OffscreenCanvas:class {},createImageBitmap:async()=>({close(){}})})) {
    const original = Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{value,configurable:true});
    t.after(()=>{ if(original) Object.defineProperty(globalThis,name,original); else delete globalThis[name]; });
  }
  const tracker = new Tracker({onFace:result=>events.push(['face',result.time]),onResults:result=>events.push(['body',result.time])});
  t.after(()=>tracker.stop());
  await tracker.start({readyState:0});
  const worker = workers[0], session = tracker._session;
  session.busy = true;
  const send = worker.onmessage;
  send({data:{type:'face',result:{face:null,time:1}}});
  assert.deepEqual(events,[['face',1]]);
  assert.equal(session.busy,true,'partial delivery must not allow a second capture');
  send({data:{type:'results',result:{face:null,pose:null,time:1}}});
  assert.deepEqual(events,[['face',1],['body',1]]);
  assert.equal(session.busy,false);
  tracker.stop();
  send({data:{type:'face',result:{face:null,time:2}}});
  assert.equal(events.length,2);
});
