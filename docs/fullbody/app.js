import {Viewer} from './viewer.js';
import {Tracker} from './tracker.js';
import {FaceSolver, measureFace, calibrateFace} from './face.js';
import {TrackingState} from './tracking-state.js';
import {DEFAULTS, sanitizeSettings, loadProfile, saveProfile, modelStore} from './settings.js';

const $ = id => document.getElementById(id);
const isOutput = new URLSearchParams(location.search).get('output') === '1';
const origin = location.origin;
const profile = loadProfile();
let settings = profile.settings;
let calibration = profile.calibration;
let viewer;
let frame = {face:null, pose:null, hands:null, time:0};
let frozen = false;
let popup;
let modelFile = null;
let cameraStream;
let running = false;
let starting = false;
let cameraGeneration = 0;
let loadingModel = false;
let lastResults = null;
let calibrationJob = null;
let lastInferenceTime = 0;
let trackingFps = 0;
let lastRenderTime = performance.now();
let renderHandle;
const faceSolver = new FaceSolver();
const trackingState = new TrackingState();
const video = $('video');
const tracker = new Tracker({onResults: receiveResults, onStatus: message => status(message), onError: error => { stopCamera(); status(`追跡を停止しました: ${error.message}`, true); }});

function status(message, error = false) {
  $('status').textContent = message;
  $('status').dataset.error = String(error);
}
function post(message) { if (popup && !popup.closed) popup.postMessage({vrmc:'fullbody', ...message}, origin); }
function sendState() {
  post({type:'state', settings, calibration, frozen, pose:frozen?viewer.getPose():null, view:viewer.getView()});
}
function persist() {
  if (!saveProfile(settings, calibration)) status('このブラウザでは設定を保存できません。現在のセッションではそのまま使えます。');
}
function syncSettings() {
  document.querySelectorAll('[data-setting]').forEach(input => {
    const value = settings[input.dataset.setting];
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
  });
  document.querySelectorAll('[data-value]').forEach(output => {
    const key = output.dataset.value, value = settings[key];
    output.textContent = /Smoothing/.test(key) ? `${Math.round(value*1000)} ms` : key === 'blinkHoldMs' ? `${value} ms` : /eye/.test(key) ? value.toFixed(3) : `${value.toFixed(2)}×`;
    if (key === 'minVisibility') output.textContent = `${Math.round(value*100)}%`;
  });
  $('color-control').hidden = settings.background !== 'color';
  $('camera-preview').classList.toggle('mirrored', settings.mirrorPreview);
  viewer?.setDisplay(settings);
}
function cameraButtons() {
  $('camera').textContent = starting ? '開始をキャンセル' : running ? 'カメラを停止' : 'カメラを開始';
  $('cameraId').disabled = starting || running;
  document.querySelector('[data-setting="quality"]').disabled = starting || running;
  $('connection').textContent = frozen ? 'ポーズ固定中' : running ? 'トラッキング中' : starting ? '準備中' : 'カメラ停止中';
  $('connection').dataset.live = String(running && !frozen);
  $('freeze').disabled = !viewer?.avatar;
  $('freeze').textContent = frozen ? '固定を解除' : 'ポーズを固定';
  $('freeze').setAttribute('aria-pressed', String(frozen));
  document.querySelectorAll('[data-calibrate]').forEach(button => { button.disabled = !running || frozen || !!calibrationJob; });
  $('camera-preview').hidden = !running || !$('preview-toggle').checked;
}

function receiveResults(results) {
  try { applyResults(results); }
  catch (error) {
    console.error('追跡結果をアバターに反映できませんでした', error);
    stopCamera();
    status(`追跡結果の反映に失敗しました: ${error.message}`, true);
  }
}

function applyResults(results) {
  if (!running) return;
  if (results.face) {
    results.face.imageWidth = video.videoWidth;
    results.face.imageHeight = video.videoHeight;
  }
  if (results.pose) {
    results.pose.imageWidth = video.videoWidth;
    results.pose.imageHeight = video.videoHeight;
  }
  results.imageWidth=video.videoWidth;
  results.imageHeight=video.videoHeight;
  const observation=trackingState.update(results,performance.now()/1000);
  if (!observation || observation.sequence===lastResults?.sequence) return;
  lastResults = observation;
  // Filters advance on camera frames only, using capture time. Freshness for
  // rendering uses receipt time: expensive inference is not tracking loss.
  const face = faceSolver.update(observation.face, observation.captureTime, settings, calibration.face || {});
  if (!frozen) frame = {...observation, face,
    faceLandmarks:results.face?.faceLandmarks?.[0], imageWidth:video.videoWidth, imageHeight:video.videoHeight};
  if (lastInferenceTime) trackingFps = trackingFps * .7 + .3 / Math.max(.001, results.time - lastInferenceTime);
  lastInferenceTime = results.time;
  $('fps').textContent = `${Math.round(trackingFps)} fps`;
  $('latency').textContent = `検出 ${Math.round(observation.latencyMs)} ms`;
  const pose = results.pose?.landmarks?.[0];
  const confidence = index => pose?.[index] && (pose[index].visibility ?? 1) >= settings.minVisibility && pose[index].x>=0 && pose[index].x<=1 && pose[index].y>=0 && pose[index].y<=1;
  const bodySeen = [11,12].every(confidence);
  const legsSeen = [25,26,27,28,31,32].every(confidence);
  const handCount = observation.hands?.landmarks?.length || 0;
  for (const [id, active, label] of [['face-state',face.tracked,`顔 ${face.tracked?'●':'—'}`],['body-state',bodySeen,`体 ${bodySeen?(settings.seated?'着席':legsSeen?'全身':'上半身'):'—'}`],['hands-state',!!handCount,`手 ${settings.trackHands?`${handCount}/2`:'OFF'}`]]) {
    $(id).textContent = label;
    $(id).dataset.active = String(active);
  }
  for (const [side, value] of [['left',face.metrics?.leftEyeOpen],['right',face.metrics?.rightEyeOpen]]) {
    $(`eye-${side}`).textContent = face.tracked && Number.isFinite(value) ? value.toFixed(3) : '—';
    $(`meter-${side}`).value = face.tracked && Number.isFinite(value) ? value : 0;
  }
  for (const name of ['aa','ih','ou','ee','oh']) $('vowel-'+name).value = face.tracked ? (face.expressions[name] || 0) : 0;
  drawLandmarks(observation);
  sampleCalibration(results);
}

async function enumerateCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
    $('cameraId').replaceChildren(new Option('既定のカメラ', ''));
    cameras.forEach((device, index) => $('cameraId').add(new Option(device.label || `カメラ ${index+1}`, device.deviceId)));
    $('cameraId').value = settings.cameraId;
    if ($('cameraId').selectedIndex < 0) $('cameraId').value = '';
  } catch { status('カメラ一覧を取得できません。既定のカメラで開始できます。'); }
}
async function startCamera() {
  const generation = ++cameraGeneration;
  starting = true;
  cameraButtons();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('カメラにはHTTPSまたはlocalhostでのアクセスが必要です。');
    status('カメラの使用を許可してください。');
    const stream = await navigator.mediaDevices.getUserMedia({audio:false, video:{
      ...(settings.cameraId ? {deviceId:{exact:settings.cameraId}} : {facingMode:'user'}),
      width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30, max:30},
    }});
    if (generation !== cameraGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
    cameraStream = stream;
    const actualDevice = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (calibration.cameraId && actualDevice && calibration.cameraId !== actualDevice) {
      calibration = {};
      for (const key of ['eyeOpenLeft','eyeOpenRight','eyeClosedLeft','eyeClosedRight']) settings[key] = DEFAULTS[key];
      viewer.avatar?.setCalibration(null);
      syncSettings();
      $('calibration-state').textContent = 'カメラが変わったため、基準を初期化しました。';
      persist();
    }
    video.srcObject = stream;
    await video.play();
    if (generation !== cameraGeneration) return;
    faceSolver.reset();
    trackingState.reset();
    frame = {face:null,pose:null,hands:null,time:0};
    lastResults = null;
    await tracker.start(video, {fps:settings.fps, trackHands:settings.trackHands, quality:settings.quality});
    if (generation !== cameraGeneration) return;
    running = true;
    stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => { if (cameraStream === stream) { stopCamera(); status('カメラとの接続が切れました。再度開始してください。', true); } }));
    await enumerateCameras();
    status('追跡中です。頭からつま先まで映し、正面の姿勢と目の開閉を記録してください。');
  } catch (error) {
    if (generation !== cameraGeneration) return;
    stopCamera();
    const explanation = error.name === 'NotAllowedError' ? 'カメラが許可されていません。ブラウザのサイト設定から許可して再開してください。' : error.name === 'NotFoundError' ? 'カメラが見つかりません。接続を確認してください。' : error.name === 'NotReadableError' ? 'カメラを開けません。他のアプリが使用していないか確認してください。' : error.name === 'OverconstrainedError' ? '選択したカメラが使えません。別のカメラを選択してください。' : error.message;
    status(`開始できませんでした: ${explanation}`, true);
  } finally {
    if (generation === cameraGeneration) starting = false;
    cameraButtons();
  }
}
function stopCamera() {
  ++cameraGeneration;
  starting = false;
  running = false;
  tracker.stop();
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null;
  video.srcObject = null;
  lastResults = null;
  lastInferenceTime = 0;
  trackingFps = 0;
  cancelCalibration();
  faceSolver.reset();
  trackingState.reset();
  if (!frozen) frame = {face:null,pose:null,hands:null,time:0};
  $('fps').textContent = '— fps';
  $('latency').textContent = '';
  for (const name of ['aa','ih','ou','ee','oh']) $('vowel-'+name).value = 0;
  for (const [id,label] of [['face-state','顔 —'],['body-state','体 —'],['hands-state','手 —']]) { $(id).textContent=label; $(id).dataset.active='false'; }
  cameraButtons();
}

async function loadModel(file, save = true) {
  if (loadingModel) return;
  if (file && !file.name?.toLowerCase().endsWith('.vrm')) { status('.vrmファイルを選択してください。', true); return; }
  loadingModel = true;
  $('files').disabled = $('sample').disabled = true;
  $('loading').hidden = false;
  $('loading').textContent = 'アバターを読み込んでいます…';
  try {
    if (!await viewer.load(file)) return;
    modelFile = file || null;
    viewer.avatar.setCalibration(calibration.body || null);
    $('model-name').textContent = file?.name || 'サンプルVRM';
    const missing = [['happy','笑顔'],['surprised','驚き'],['angry','怒り'],['aa','あ'],['ih','い'],['ou','う'],['ee','え'],['oh','お']]
      .filter(([name])=>!viewer.avatar.vrm.expressionManager?.getExpression(name)).map(([,label])=>label);
    $('expression-support').hidden = missing.length === 0;
    $('expression-support').textContent = missing.length ? 'このモデルには「'+missing.join('・')+'」の表情がありません。' : '';
    if (save) {
      try { await modelStore(modelFile); }
      catch { status('モデルを読み込みましたが、ブラウザに保存できませんでした。次回は再選択してください。'); }
    }
    post({type:'model', file:modelFile, view:viewer.getView()});
    sendState();
    $('loading').hidden = true;
  } catch (error) {
    status(`VRMを読み込めませんでした: ${error.message}`, true);
    $('loading').textContent = 'モデルを読み込めませんでした。別のVRMを選択してください。';
    $('loading').hidden = !!viewer.avatar;
  } finally {
    loadingModel = false;
    $('files').disabled = $('sample').disabled = false;
    $('files').value = '';
    $('save').disabled = !viewer.avatar;
    cameraButtons();
  }
}

const calibrationLabels = {neutral:'カメラに正面を向き、口を閉じて自然に立ってください',eyesOpen:'普段どおりに両目を開いてください',eyesClosed:'両目をやさしく閉じてください'};
function beginCalibration(kind) {
  if (!running || frozen || calibrationJob) return;
  calibrationJob = {kind, start:performance.now()+3000, samples:[], pose:null};
  $('calibration-progress').hidden = false;
  $('cancel-calibration').hidden = false;
  cameraButtons();
}
function cancelCalibration() {
  calibrationJob = null;
  $('calibration-progress').hidden = true;
  $('cancel-calibration').hidden = true;
}
function sampleCalibration(results) {
  const job = calibrationJob;
  if (!job || results.time * 1000 < job.start) return;
  const measurement = measureFace(results.face);
  job.samples.push(measurement);
  if (results.pose?.worldLandmarks?.length) job.pose = results.pose;
}
function calibrationTick(now) {
  const job = calibrationJob;
  if (!job) return;
  const elapsed = now-job.start;
  const validSamples = job.samples.filter(Boolean).length;
  $('calibration-progress').value = Math.max(0,Math.min(1,elapsed/1500,validSamples/8));
  $('calibration-state').textContent = `${calibrationLabels[job.kind]} · ${elapsed<0?`${Math.ceil(-elapsed/1000)}秒後に測定`:'測定中…'}`;
  // At 4fps a fixed 1.5s window cannot supply the eight measurements needed
  // by calibration. Extend collection, with a bound for genuinely lost faces.
  if (elapsed < 1500 || (validSamples < 8 && elapsed < 6000)) return;
  try {
    const eyeSettings = Object.fromEntries(['eyeOpenLeft','eyeOpenRight','eyeClosedLeft','eyeClosedRight'].map(key => [key,settings[key]]));
    const nextFace = calibrateFace(job.samples, job.kind, {...calibration.face,...eyeSettings});
    calibration.face = nextFace;
    for (const key of ['eyeOpenLeft','eyeOpenRight','eyeClosedLeft','eyeClosedRight']) {
      if (Number.isFinite(nextFace[key])) settings[key] = nextFace[key];
    }
    let bodyMessage = '';
    if (job.kind === 'neutral') {
      try {
        if (!job.pose || !viewer.avatar) throw new Error('体が見つかりません');
        calibration.body = viewer.avatar.calibrate(job.pose);
        bodyMessage = '・体';
      } catch { bodyMessage = '（体は未記録。腰と両肩を映して測り直せます）'; }
    }
    calibration.cameraId = cameraStream?.getVideoTracks()[0]?.getSettings().deviceId || settings.cameraId;
    calibration.updatedAt = new Date().toISOString();
    settings = sanitizeSettings(settings);
    faceSolver.reset();
    syncSettings();
    persist();
    sendState();
    $('calibration-state').textContent = `${job.kind==='neutral'?`正面の顔${bodyMessage}`:job.kind==='eyesOpen'?'開いた目':'閉じた目'}を記録しました。`;
    status('キャリブレーションを保存しました。動きを確認し、必要ならスライダーで微調整してください。');
  } catch (error) {
    $('calibration-state').textContent = `測定できませんでした: ${error.message}`;
    status('顔がはっきり映る位置で、もう一度測定してください。', true);
  } finally { cancelCalibration(); cameraButtons(); }
}

const connections = [[11,12],[11,23],[12,24],[23,24],[11,13],[13,15],[12,14],[14,16],[23,25],[25,27],[27,31],[24,26],[26,28],[28,32]];
function drawLandmarks(results) {
  if (!$('preview-toggle').checked) return;
  const canvas = $('landmarks');
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  $('camera-preview').style.aspectRatio = `${canvas.width}/${canvas.height}`;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const points = results.pose?.landmarks?.[0] || [];
  ctx.strokeStyle='#acedd1'; ctx.fillStyle='#ffffff'; ctx.lineWidth=3;
  for (const [a,b] of connections) {
    if ([a,b].some(i => !points[i] || (points[i].visibility??1)<settings.minVisibility)) continue;
    ctx.beginPath(); ctx.moveTo(points[a].x*canvas.width,points[a].y*canvas.height); ctx.lineTo(points[b].x*canvas.width,points[b].y*canvas.height); ctx.stroke();
  }
  for (const point of points.slice(11)) {
    if ((point.visibility??1)<settings.minVisibility) continue;
    ctx.beginPath(); ctx.arc(point.x*canvas.width,point.y*canvas.height,4,0,2*Math.PI); ctx.fill();
  }
  // Draw what was actually detected even when the torso is outside the image.
  // The two colors make left/right identity and finger tracking inspectable.
  const links=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
  (results.hands?.landmarks || []).forEach((hand,index)=>{
    ctx.strokeStyle=results.hands.handedness?.[index]?.[0]?.categoryName==='Left'?'#ffbf69':'#60d9ff';
    for(const [a,b] of links) {
      if(!hand[a]||!hand[b]) continue;
      ctx.beginPath();ctx.moveTo(hand[a].x*canvas.width,hand[a].y*canvas.height);ctx.lineTo(hand[b].x*canvas.width,hand[b].y*canvas.height);ctx.stroke();
    }
    for(const point of hand) { ctx.beginPath();ctx.arc(point.x*canvas.width,point.y*canvas.height,3,0,2*Math.PI);ctx.fill(); }
  });
}

function outputMode() {
  document.title = 'VRMC Full Body — 配信出力';
  let loadSequence = 0;
  let pendingView;
  let pendingPose;
  window.addEventListener('message', async event => {
    if (event.origin!==origin || event.source!==window.opener || event.data?.vrmc!=='fullbody') return;
    const message = event.data;
    if (message.type==='state') {
      settings = sanitizeSettings(message.settings);
      calibration = message.calibration || {};
      frozen = !!message.frozen;
      pendingPose = message.pose;
      pendingView = message.view;
      viewer.setDisplay(settings);
      viewer.setView(message.view);
      const bodyKey = JSON.stringify(calibration.body || null);
      if (outputMode.bodyKey !== bodyKey) { viewer.avatar?.setCalibration(calibration.body || null); outputMode.bodyKey = bodyKey; }
      if (frozen) viewer.setPose(pendingPose);
    } else if (message.type==='model') {
      const sequence = ++loadSequence;
      try {
        await viewer.load(message.file);
        if (sequence!==loadSequence) return;
        viewer.avatar?.setCalibration(calibration.body || null);
        viewer.setView(pendingView || message.view);
        if (frozen) viewer.setPose(pendingPose);
      } catch (error) { console.error('配信用モデルの読み込みに失敗しました', error); }
    } else if (message.type==='frame') {
      // performance.now() has a different origin in a popup; translate its capture age.
      frame = {...message.frame, time:performance.now()/1000 - Math.max(0,message.age || 0)};
    } else if (message.type==='view') { pendingView=message.view; viewer.setView(message.view); }
  });
  if (window.opener) window.opener.postMessage({vrmc:'fullbody',type:'ready'}, origin);
  else {
    document.documentElement.classList.remove('output');
    $('loading').hidden = false;
    $('loading').textContent = '配信出力はメイン画面の「配信用ウィンドウを開く」から開始してください。';
    $('loading').append(Object.assign(document.createElement('a'), {href:'./',textContent:' メイン画面へ'}));
    document.querySelector('aside').hidden = true;
    $('camera').disabled = $('freeze').disabled = $('output').disabled = true;
  }
}

function animate(now) {
  renderHandle = requestAnimationFrame(animate);
  const delta = Math.min(.05, Math.max(0,(now-lastRenderTime)/1000));
  lastRenderTime = now;
  if (!isOutput) {
    calibrationTick(now);
    if (popup && !popup.closed && now-(animate.lastPost||0)>=1000/30) {
      post({type:'frame',frame,age:Math.max(0,now/1000-frame.time)});
      animate.lastPost=now;
    }
  }
  try { viewer.render(frame,delta,settings,frozen); }
  catch (error) {
    console.error('アバターの描画に失敗しました', error);
    stopCamera();
    frozen = true;
    cameraButtons();
    status(`アバターの描画に失敗しました: ${error.message}`, true);
  }
}

async function init() {
  $('build-version').textContent = 'Full Body · 2026.09.09.5';
  try {
    viewer = new Viewer($('stage'), {interactive:!isOutput, onViewChange:view=>post({type:'view',view})});
    viewer.setDisplay(settings);
    viewer.renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); stopCamera(); status('描画用GPUとの接続が失われました。ページを再読み込みしてください。', true); });
    renderHandle = requestAnimationFrame(animate);
    if (isOutput) { outputMode(); return; }
    syncSettings();
    if (calibration.updatedAt) $('calibration-state').textContent = `保存済みの基準を使用中 · ${new Date(calibration.updatedAt).toLocaleDateString('ja-JP')}`;
    document.querySelectorAll('[data-setting]').forEach(input => input.addEventListener('input', () => {
      const key=input.dataset.setting;
      settings = sanitizeSettings({...settings,[key]:input.type==='checkbox'?input.checked:typeof DEFAULTS[key]==='number'?Number(input.value):input.value});
      syncSettings(); tracker.setOptions({fps:settings.fps,trackHands:settings.trackHands}); persist(); sendState();
    }));
    $('cameraId').onchange = () => { settings.cameraId=$('cameraId').value; persist(); };
    $('camera').onclick = () => { if (running || starting) { stopCamera(); status('カメラを停止しました。'); } else startCamera(); };
    $('preview-toggle').onchange = cameraButtons;
    $('freeze').onclick = () => {
      frozen=!frozen;
      if (frozen) cancelCalibration();
      else { faceSolver.reset(); frame={face:null,pose:null,hands:null,time:0}; }
      cameraButtons(); sendState();
    };
    $('fit').onclick = () => viewer.fit();
    $('save').onclick = async () => {
      $('save').disabled=true;
      try { await viewer.save(); status('PNGを保存しました。'); }
      catch(error) { status(`保存できませんでした: ${error.message}`,true); }
      finally { $('save').disabled=!viewer.avatar; }
    };
    $('files').onchange = () => { if ($('files').files[0]) loadModel($('files').files[0]); };
    $('sample').onclick = () => loadModel(null);
    window.addEventListener('dragover', event => event.preventDefault());
    window.addEventListener('drop', event => { event.preventDefault(); if (event.dataTransfer.files[0]) loadModel(event.dataTransfer.files[0]); });
    document.querySelectorAll('[data-calibrate]').forEach(button => { button.onclick=()=>beginCalibration(button.dataset.calibrate); });
    $('cancel-calibration').onclick = () => { cancelCalibration(); cameraButtons(); $('calibration-state').textContent='測定をキャンセルしました。'; };
    $('reset').onclick = () => {
      cancelCalibration(); calibration={};
      settings={...DEFAULTS,cameraId:settings.cameraId,background:settings.background,backgroundColor:settings.backgroundColor};
      faceSolver.reset(); viewer.avatar?.setCalibration(null); syncSettings(); persist(); sendState(); cameraButtons();
      tracker.setOptions({fps:settings.fps,trackHands:settings.trackHands});
      $('calibration-state').textContent='未調整 · 初期値に戻しました'; status('動き・表情・キャリブレーションを初期値に戻しました。');
    };
    $('output').onclick = () => {
      popup=window.open('./?output=1','vrmc-fullbody-output','popup,width=1280,height=720');
      if (!popup) { status('ポップアップがブロックされました。このサイトのポップアップを許可してください。',true); return; }
      status('OBSのウィンドウキャプチャで「VRMC Full Body — 配信出力」を選択してください。透過には背景をグリーンにしてクロマキーを使います。');
    };
    window.addEventListener('message', event => {
      if(event.origin!==origin || event.source!==popup || event.data?.vrmc!=='fullbody' || event.data.type!=='ready') return;
      sendState(); post({type:'model',file:modelFile,view:viewer.getView()});
    });
    window.addEventListener('keydown', event => {
      if (/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
      if ((event.ctrlKey||event.metaKey) && ['ArrowLeft','ArrowRight'].includes(event.key)) {
        event.preventDefault(); const backgrounds=['transparent','green','blue','color'];
        settings.background=backgrounds[(backgrounds.indexOf(settings.background)+(event.key==='ArrowRight'?1:3))%backgrounds.length];
        syncSettings(); persist(); sendState();
      }
    });
    navigator.mediaDevices?.addEventListener('devicechange',enumerateCameras);
    enumerateCameras();
    let savedFile;
    try { savedFile=await modelStore(); } catch { /* A sample is always available without storage. */ }
    await loadModel(savedFile || null,false);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('../service-worker.js').catch(()=>{});
  } catch(error) {
    status(`画面を初期化できませんでした: ${error.message}`,true);
    $('loading').textContent='WebGLが使えるChrome / Edgeで開いてください。';
    $('camera').disabled=true;
  }
}
window.addEventListener('pagehide', () => { stopCamera(); cancelAnimationFrame(renderHandle); viewer?.dispose(); });
window.addEventListener('pageshow', event => { if(event.persisted) location.reload(); });
init();
