import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serve } from '../scripts/serve.js';

// Exercise the real UI, video element, camera ownership and async model load.
// Inference is replaced here; tracker-browser.js covers the actual worker.
const trackerStub = `
export class Tracker {
  async start() {
    this.stop();
    window.testTrackerStarts = (window.testTrackerStarts || 0) + 1;
    if (window.testHoldTracker) return new Promise((resolve, reject) => { this.reject = reject; });
  }
  stop() {
    this.reject?.(new DOMException('Cancelled for test', 'AbortError'));
    this.reject = null;
  }
  setOptions() {}
}`;

const server = serve(0);
if (!server.listening) await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const sample = await readFile(new URL('../docs/models/VRM1_Constraint_Twist_Sample.vrm', import.meta.url));
let browser;
const errors = [];
try {
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || (process.platform === 'win32'
      ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),
    args: ['--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });

  async function newContext({ denyFirst = false, holdTracker = false, syntheticCamera = false, endedOnArrival = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 },
      permissions: ['camera'], serviceWorkers: 'block' });
    await context.route('**/fullbody/tracker.js', route => route.fulfill({
      contentType: 'text/javascript', body: trackerStub,
    }));
    await context.addInitScript(({ denyFirst, holdTracker, syntheticCamera, endedOnArrival }) => {
      window.testCameraRequests = 0;
      window.testTrackerStarts = 0;
      window.testStreams = [];
      window.testHoldTracker = holdTracker;
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        window.testCameraRequests++;
        if (denyFirst && window.testCameraRequests === 1) {
          throw new DOMException('Permission denied for test', 'NotAllowedError');
        }
        let stream;
        if(syntheticCamera) {
          const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
          const ctx=canvas.getContext('2d');let frame=0;
          stream=canvas.captureStream(30);
          const timer=setInterval(()=>{
            if(stream.getTracks().every(track=>track.readyState==='ended')) clearInterval(timer);
            else {ctx.fillStyle=++frame%2?'#26323c':'#27333d';ctx.fillRect(0,0,640,480);}
          },33);
        } else stream = await capture(constraints);
        window.testStreams.push(stream);
        if(endedOnArrival) stream.getTracks().forEach(track=>track.stop());
        return stream;
      };
    }, { denyFirst, holdTracker, syntheticCamera, endedOnArrival });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    return { context, page };
  }

  // Deliver a deterministic device-ended event while model initialization is
  // still pending. A track.stop() alone does not dispatch a native ended event.
  {
    const {context,page}=await newContext({holdTracker:true,syntheticCamera:true});
    try {
      await page.goto(`${origin}/fullbody/`);
      await page.waitForFunction(()=>testTrackerStarts===1);
      await page.evaluate(()=>{
        const track=testStreams[0].getVideoTracks()[0];
        track.stop();track.dispatchEvent(new Event('ended'));
      });
      await page.waitForFunction(()=>document.getElementById('stage-status').textContent.includes('接続が切れました'),null,{timeout:3000});
      assert.equal(await page.locator('#connection').getAttribute('data-live'),'false');
      assert.equal(await page.locator('#stage-camera').isEnabled(),true);
      assert.equal(await page.locator('#camera-preview').isVisible(),false);
      assert.equal(await page.evaluate(()=>document.getElementById('video').srcObject),null);
      await page.evaluate(()=>{testHoldTracker=false;});
      await page.locator('#stage-camera').click();
      await page.waitForFunction(()=>document.getElementById('connection').dataset.live==='true');
      assert.equal(await page.evaluate(()=>testCameraRequests),2);
      await page.evaluate(()=>testStreams[0].getVideoTracks()[0].dispatchEvent(new Event('ended')));
      assert.equal(await page.locator('#connection').getAttribute('data-live'),'true','an old stream must not stop the new session');
      assert.equal(await page.locator('#preview-toggle').isChecked(),false);
      await page.evaluate(()=>{
        const track=testStreams[1].getVideoTracks()[0];track.stop();track.dispatchEvent(new Event('ended'));
      });
      assert.equal(await page.locator('#connection').getAttribute('data-live'),'false','disconnects after startup remain handled');
      assert.equal(await page.locator('#stage-camera').isEnabled(),true);
    }finally{await context.close();}
  }

  // An already-ended stream has no future ended event to subscribe to.
  {
    const {context,page}=await newContext({syntheticCamera:true,endedOnArrival:true});
    try {
      await page.goto(`${origin}/fullbody/`);
      await page.waitForFunction(()=>document.getElementById('stage-status').textContent.includes('接続が切れました'),null,{timeout:3000});
      assert.equal(await page.evaluate(()=>testTrackerStarts),0);
      assert.equal(await page.evaluate(()=>document.getElementById('video').srcObject),null);
      assert.equal(await page.locator('#stage-camera').isEnabled(),true);
    }finally{await context.close();}
  }

  // The user can enter settings before the model finishes loading. A manual
  // camera cancellation there must suppress the eventual automatic start.
  {
    const { context, page } = await newContext({ holdTracker: true });
    let releaseModel;
    const heldModel = new Promise(resolve => { releaseModel = resolve; });
    await context.route('**/models/VRM1_Constraint_Twist_Sample.vrm', async route => {
      await heldModel;
      await route.fulfill({ contentType: 'model/gltf-binary', body: sample });
    });
    try {
      await page.goto(`${origin}/fullbody/?settings=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('files').disabled);
      await page.locator('#camera').click();
      await page.waitForFunction(() => window.testTrackerStarts === 1);
      assert.equal(await page.locator('#camera').textContent(), '開始をキャンセル');
      await page.locator('#camera').click();
      assert.equal(await page.locator('#camera').textContent(), 'カメラを開始');
      releaseModel();
      await page.waitForFunction(() => document.getElementById('model-name').textContent === 'サンプルVRM'
        && !document.getElementById('files').disabled);
      // Await render tasks after init's continuation, so a late automatic
      // getUserMedia call would have incremented the counter already.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => window.testCameraRequests), 1,
        'finishing model initialization must not reopen a camera the user just cancelled');
      assert.equal(await page.evaluate(() => window.testTrackerStarts), 1);
      assert.equal(await page.locator('#connection').getAttribute('data-live'), 'false');
      assert.equal(await page.locator('#camera-preview').isVisible(), false);
      assert.equal(await page.evaluate(() => document.getElementById('video').srcObject), null);
      assert.equal(await page.evaluate(() => window.testStreams.every(stream =>
        stream.getTracks().every(track => track.readyState === 'ended'))), true);
    } finally {
      releaseModel();
      await context.close();
    }
  }

  // First-visit denial must be actionable from the capture URL itself, even
  // while the settings panel and camera preview are both hidden.
  {
    const { context, page } = await newContext({ denyFirst: true });
    try {
      await page.goto(`${origin}/fullbody/`);
      await page.waitForFunction(() => document.getElementById('stage-status').textContent.includes('カメラが許可されていません'));
      assert.equal(await page.locator('aside').isVisible(), false);
      assert.equal(await page.locator('#stage-notice').isVisible(), true);
      assert.equal(await page.locator('#stage-camera').isVisible(), true);
      assert.equal(await page.locator('#stage-camera').isEnabled(), true);
      assert.equal(await page.locator('#camera-preview').isVisible(), false);
      assert.equal(await page.evaluate(() => window.testCameraRequests), 1);
      assert.equal(await page.evaluate(() => window.testTrackerStarts), 0);
      await page.locator('#stage-camera').click();
      await page.waitForFunction(() => document.getElementById('connection').dataset.live === 'true');
      assert.equal(await page.evaluate(() => window.testCameraRequests), 2);
      assert.equal(await page.evaluate(() => window.testTrackerStarts), 1);
      assert.equal(await page.locator('#stage-notice').isVisible(), false);
      assert.equal(await page.locator('#camera-preview').isVisible(), false);
      assert.equal(await page.locator('#preview-toggle').isChecked(), false);
      await page.mouse.move(20, 20);
      await page.locator('#settings-toggle').click();
      await page.locator('#camera').click();
      assert.equal(await page.evaluate(() => window.testStreams.every(stream =>
        stream.getTracks().every(track => track.readyState === 'ended'))), true);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  console.log('Browser startup: early/late device-ended events, already-ended streams, retry and stale-event isolation passed with synthetic streams; model-load cancellation and permission denial/retry passed with the Chrome fake camera. Preview remains hidden.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
