import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { serve } from '../scripts/serve.js';
import { measureHand } from '../docs/fullbody/hand-rig.js';
import { TrackingState } from '../docs/fullbody/tracking-state.js';
import { solveBody } from '../docs/fullbody/body.js';

// Official MediaPipe regression images. Download into the ignored results folder;
// image pixels are not synthesized by our rig or redistributed in this repository.
// Sources: google-ai-edge/mediapipe's tasks/python/test/vision/hand_landmarker_test.py
// and python/solutions/pose_test.py. See tests/fixtures/mediapipe-assets.md.
async function officialImage(name, sha256) {
  const path = new URL(`../test-results/mediapipe/${name}`, import.meta.url);
  await mkdir(new URL('../test-results/mediapipe/', import.meta.url), { recursive: true });
  let bytes;
  try { bytes = await readFile(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(`https://storage.googleapis.com/mediapipe-assets/${name}`);
    assert.ok(response.ok, `official image download failed: ${name} (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(path, bytes);
  }
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, `unexpected official asset: ${name}`);
  return bytes;
}

const server = serve(0);
if (!server.listening) await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const failures = [];
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || (process.platform === 'win32'
      ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),
    args: ['--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext();
  const assets = await Promise.all([
    officialImage('pointing_up.jpg', 'ecf8ca2611d08fa25948a4fc10710af9120e88243a54da6356bacea17ff3e36e'),
    officialImage('pose.jpg', 'c8a830ed683c0276d713dd5aeda28f415f10cd6291972084a40d0d8b934ed62b'),
  ]);
  await context.route('**/__pointing_up__.jpg', route => route.fulfill({ contentType: 'image/jpeg', body: assets[0] }));
  await context.route('**/__pose__.jpg', route => route.fulfill({ contentType: 'image/jpeg', body: assets[1] }));
  await context.route('**/__tracker_test__', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><video muted playsinline></video>',
  }));
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  page.on('requestfailed', request => failures.push(`${request.failure()?.errorText}: ${request.url()}`));
  await page.goto(`${origin}/__tracker_test__`);
  await page.evaluate(async () => {
    const { Tracker } = await import('/fullbody/tracker.js');
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    window.showImage = async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      window.sourceImage = image;
      window.sourceChangedAt = performance.now() / 1000;
    };
    let frame = 0;
    window.drawTimer = setInterval(() => {
      if (window.sourceImage) ctx.drawImage(sourceImage, 0, 0);
      else {
        ctx.fillStyle = frame++ % 2 ? '#324054' : '#324154';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }, 33);
    window.stream = canvas.captureStream(30);
    window.video = document.querySelector('video');
    video.srcObject = stream;
    await video.play();
    window.results = [];
    window.statuses = [];
    window.errors = [];
    window.count = 0;
    window.tracker = new Tracker({
      onStatus: status => statuses.push(status),
      onError: error => errors.push(error.message),
      onResults: result => { count++; results.push(result); if (results.length > 20) results.shift(); },
    });
    window.startedAt = performance.now() / 1000;
    await tracker.start(video, { fps: 12, quality: 'balanced' });
  });
  await page.waitForFunction(() => count >= 3 || errors.length, null, { timeout: 30000 });
  const first = await page.evaluate(() => ({ results, errors, startedAt, now: performance.now() / 1000, statuses }));
  assert.deepEqual(first.errors, [], 'real MediaPipe inference must succeed');
  assert.ok(first.results.length >= 3);
  for (const result of first.results) {
    assert.equal(result.face.faceLandmarks.length, 0, 'blank frames have no face');
    assert.equal(result.pose.landmarks.length, 0, 'blank frames have no pose');
    assert.equal(result.pose.worldLandmarks.length, 0);
    assert.equal(result.hands.landmarks.length, 0, 'blank frames have no hands');
    assert.ok(result.time >= first.startedAt && result.time <= first.now, 'capture time uses the main clock in seconds');
  }
  assert.ok(first.results.every((result, i, all) => i === 0 || result.time > all[i - 1].time));

  await page.evaluate(() => showImage('/__pointing_up__.jpg'));
  await page.waitForFunction(() => results.filter(result => result.time > sourceChangedAt + 0.1 && result.hands?.landmarks.length === 1).length >= 4,
    null, { timeout: 30000 });
  const realHandFrames = await page.evaluate(() => results.filter(result => result.time > sourceChangedAt + 0.1 && result.hands?.landmarks.length === 1));
  const observations = new TrackingState();
  for (const result of realHandFrames) {
    const category = (result.hands.handedness ?? result.hands.handednesses)[0][0];
    assert.equal(category.categoryName, 'Right', 'unmirrored official photo is anatomically a right hand');
    assert.ok(category.score > 0.9);
    const imagePoints = result.hands.landmarks[0];
    const worldPoints = result.hands.worldLandmarks[0];
    assert.equal(imagePoints.length, 21);
    assert.equal(worldPoints.length, 21);
    assert.ok([...imagePoints, ...worldPoints].every(point => [point.x, point.y, point.z].every(Number.isFinite)));
    // Ground truth comes from the visible photograph and upstream landmarks,
    // independently of this app's geometry or synthetic hand fixtures.
    assert.ok(Math.abs(imagePoints[0].x - 0.479) < 0.05 && Math.abs(imagePoints[0].y - 0.743) < 0.05, 'wrist matches the photo');
    assert.ok(Math.abs(imagePoints[8].x - 0.474) < 0.05 && Math.abs(imagePoints[8].y - 0.196) < 0.05, 'pointing fingertip matches the photo');
    // Include all native metadata through the boundary that previously lost
    // every real hand, rather than testing only isolated palm mathematics.
    const observation = observations.update(result,result.time+.1);
    const solved = solveBody(observation.pose,observation.hands);
    assert.ok(solved.armTargets.right, 'actual SDK hand must survive identity/confidence checks');
    assert.ok(solved.hands.right?.fingers.Index, 'actual SDK hand must reach finger retargeting');
    const hand = measureHand(worldPoints, 'right');
    assert.ok(hand && hand.palm.toArray().every(Number.isFinite), 'actual detector world points yield a valid palm');
    assert.ok(hand.fingers.Index.curl[1] < 0.55, 'the pictured index finger stays extended');
    for (const finger of ['Middle', 'Ring', 'Little']) {
      assert.ok(hand.fingers[finger].curl[1] > 0.7, `the pictured ${finger} PIP bends toward the palm`);
      assert.ok(hand.fingers[finger].curl.reduce((sum, value) => sum + value, 0) > 2.0, `${finger} is curled independently of index`);
    }
  }
  await writeFile(new URL('../test-results/mediapipe/pointing-up-detection.json', import.meta.url), JSON.stringify(realHandFrames.at(-1), null, 2));

  await page.evaluate(() => showImage('/__pose__.jpg'));
  await page.waitForFunction(() => results.filter(result => result.time > sourceChangedAt + 0.1 && result.pose?.landmarks.length === 1).length >= 4,
    null, { timeout: 30000 });
  const realPoseFrames = await page.evaluate(() => results.filter(result => result.time > sourceChangedAt + 0.1 && result.pose?.landmarks.length === 1));
  for (const result of realPoseFrames) {
    assert.equal(result.pose.landmarks[0].length, 33);
    assert.equal(result.pose.worldLandmarks[0].length, 33);
    assert.ok([...result.pose.landmarks[0], ...result.pose.worldLandmarks[0]].every(point => [point.x, point.y, point.z].every(Number.isFinite)));
    const points = result.pose.landmarks[0];
    assert.ok([11, 12, 13, 14, 15, 16, 23, 24].every(index => points[index].visibility > 0.6), 'shoulders, elbows, wrists and hips are visible in the photograph');
    assert.ok(points[15].x > points[11].x && points[16].x < points[12].x, 'both arms extend to the correct sides');
    assert.ok(Math.abs(points[15].y - points[11].y) < 0.08 && Math.abs(points[16].y - points[12].y) < 0.08, 'wrists remain near shoulder height');
  }
  await writeFile(new URL('../test-results/mediapipe/pose-detection.json', import.meta.url), JSON.stringify(realPoseFrames.at(-1), null, 2));

  await page.evaluate(() => { tracker.setOptions({ fps: 20, trackHands: false }); });
  await page.waitForFunction(() => results.length && !('hands' in results.at(-1)), null, { timeout: 10000 });
  await page.evaluate(() => tracker.setOptions({ trackHands: true }));
  await page.waitForFunction(() => results.length && 'hands' in results.at(-1), null, { timeout: 10000 });
  const stoppedCount = await page.evaluate(() => { tracker.stop(); return count; });
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => count), stoppedCount, 'stop must prevent late results');

  const cancellation = await page.evaluate(async () => {
    const starting = tracker.start(video);
    tracker.stop();
    try { await starting; return 'unexpected success'; }
    catch (error) { return error.name; }
  });
  assert.equal(cancellation, 'AbortError', 'stopping during startup must settle its promise');

  // Exercise the fresh-worker CPU path with a controlled GPU initialization
  // failure; face, pose and hand CPU models still load and infer for real.
  const workerSource = await readFile(new URL('../docs/fullbody/tracking-worker.js', import.meta.url), 'utf8');
  await context.route('**/fullbody/tracking-worker.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: workerSource.replace('async function initialize({ delegate, quality }) {',
      "async function initialize({ delegate, quality }) { if (delegate === 'GPU') throw new Error('Test: force CPU fallback');"),
  }));
  await page.evaluate(async () => {
    statuses.length = 0;
    await tracker.start(video, { fps: 10, quality: 'light' });
  });
  await page.waitForFunction(previous => count > previous || errors.length, stoppedCount, { timeout: 30000 });
  const fallback = await page.evaluate(() => ({ statuses, errors, count }));
  assert.deepEqual(fallback.errors, []);
  assert.ok(fallback.statuses.some(status => status.includes('CPU に切り替え')));
  assert.ok(fallback.statuses.some(status => status.includes('CPU・')));
  assert.ok(fallback.count > stoppedCount, 'CPU fallback must produce actual inference results');
  await page.evaluate(() => {
    tracker.stop();
    clearInterval(drawTimer);
    stream.getTracks().forEach(track => track.stop());
  });
  assert.deepEqual(failures, []);
  console.log('Tracker browser: actual photo hand/pose detections and finger articulation, blank frames, timestamps, hands toggle, stop/cancel/restart, and CPU fallback passed.');
} catch (error) {
  if (failures.length) console.error(failures.join('\n'));
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
