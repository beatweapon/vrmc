import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { StudioAvatar } from './avatar.js';

const $ = id => document.getElementById(id);
const stage = $('stage');
const diagnostics = window.vrmDiagnostics;
const entries = [];
const scene = new THREE.Scene();
scene.background = new THREE.Color($('background').value);
scene.add(new THREE.AmbientLight(0xffffff, Math.PI));
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
camera.position.set(0, 1, 4);
const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
stage.prepend(renderer.domElement);
diagnostics.renderer(renderer);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.update();
const timer = new THREE.Timer();
timer.connect(document);
let frozen = false;
let lastBlendshapes;
let faceLandmarker;
let stream;
let tracking = false;
let lastVideoTime = -1;
let lastDetectionTime = 0;
let loading = false;
let capturePending = false;
const video = $('video');
diagnostics.camera(video);

function status(message, error = false) {
  $('status').textContent = message;
  $('status').dataset.error = String(error);
}

function fit() {
  if (!entries.length) return;
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  for (const {avatar} of entries) bounds.union(new THREE.Box3().setFromObject(avatar.vrm.scene, true));
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const distance = Math.max(size.y / (2 * tangent), size.x / (2 * tangent * camera.aspect)) * 1.15 + size.z / 2;
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(0, 0, Math.max(distance, 0.5)));
  controls.update();
}

function layout() {
  const spacing = Number($('spacing').value);
  entries.forEach(({avatar}, index) => {
    avatar.vrm.scene.position.x = (index - (entries.length - 1) / 2) * spacing;
  });
  $('empty').hidden = entries.length > 0;
  $('save').disabled = !entries.length || capturePending;
  $('freeze').disabled = !entries.length;
  fit();
}

function updateList() {
  $('avatars').replaceChildren();
  entries.forEach((entry, index) => {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = entry.name;
    const left = document.createElement('button');
    left.textContent = '←';
    left.setAttribute('aria-label', `${entry.name}を左へ`);
    left.disabled = index === 0;
    left.onclick = () => {
      [entries[index - 1], entries[index]] = [entries[index], entries[index - 1]];
      updateList();
      layout();
    };
    const remove = document.createElement('button');
    remove.textContent = '削除';
    remove.setAttribute('aria-label', `${entry.name}を削除`);
    remove.onclick = () => {
      entry.avatar.destroyModel();
      entries.splice(entries.indexOf(entry), 1);
      updateList();
      layout();
    };
    item.append(name, left, remove);
    $('avatars').append(item);
  });
}

async function addModels(models) {
  if (loading) { status('読み込みが終わってから追加してください。'); return; }
  loading = true;
  $('files').disabled = true;
  $('sample').disabled = true;
  const failures = [];
  try {
    for (const model of models) {
      if (model instanceof File && !model.name.toLowerCase().endsWith('.vrm')) {
        failures.push(`${model.name}: .vrmファイルを選択してください。`);
        continue;
      }
      const isFile = model instanceof File;
      const url = isFile ? URL.createObjectURL(model) : model.url;
      status(`${model.name} を読み込んでいます…`);
      let avatar;
      try {
        avatar = new StudioAvatar(url, scene);
        await avatar.ready;
        // A newly added avatar can join an already frozen pose.
        if (lastBlendshapes) {
          for (let i = 0; i < 20; i++) avatar.applyBlendshapes(lastBlendshapes);
          avatar.vrm.update(0);
        }
        entries.push({name: model.name, avatar});
        updateList();
        layout();
      } catch (error) {
        avatar?.destroyModel();
        failures.push(`${model.name}: ${error.message}`);
      } finally {
        if (isFile) URL.revokeObjectURL(url);
      }
    }
    status(failures.length ? failures.join('\n') : `${entries.length}体のアバターを配置しました。`, failures.length > 0);
  } finally {
    loading = false;
    $('files').disabled = false;
    $('files').value = '';
    $('sample').disabled = false;
  }
}

$('files').addEventListener('change', event => addModels(Array.from(event.target.files)));
$('sample').onclick = () => addModels([{name: 'サンプルVRM', url: '../models/VRM1_Constraint_Twist_Sample.vrm'}]);
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => {
  event.preventDefault();
  addModels(Array.from(event.dataTransfer.files));
});
$('spacing').oninput = layout;
$('fit').onclick = fit;
$('background').oninput = () => {
  if (!$('transparent').checked) scene.background = new THREE.Color($('background').value);
};
$('transparent').onchange = () => {
  scene.background = $('transparent').checked ? null : new THREE.Color($('background').value);
};
$('freeze').onclick = () => {
  frozen = !frozen;
  $('freeze').textContent = frozen ? 'ポーズの固定を解除' : 'ポーズを固定';
  updatePoseState();
};
function updatePoseState() {
  $('pose-state').textContent = frozen ? 'ポーズ固定中' : tracking ? 'カメラと連動中' : 'カメラ停止中';
}

function stopCamera() {
  tracking = false;
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  faceLandmarker?.close();
  faceLandmarker = null;
  lastVideoTime = -1;
  $('camera').textContent = 'カメラを開始';
  updatePoseState();
}

$('camera').onclick = async () => {
  if (tracking) { stopCamera(); status('カメラを停止しました。'); return; }
  $('camera').disabled = true;
  try {
    diagnostics.stage('カメラ許可待ち');
    stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: 'user', width: {ideal: 640}, height: {ideal: 480}, frameRate: {ideal: 30, max: 30}}});
    video.srcObject = stream;
    await video.play();
    status('顔検出モデルを準備しています…');
    diagnostics.stage('顔検出モデル準備中');
    const {FilesetResolver, FaceLandmarker} = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm');
    faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task', delegate: 'GPU'},
      runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
    });
    tracking = true;
    $('camera').textContent = 'カメラを停止';
    updatePoseState();
    diagnostics.stage('カメラと連動中');
    status('顔をカメラに向けてください。好きな瞬間にポーズを固定できます。');
  } catch (error) {
    stopCamera();
    status(`カメラを開始できませんでした: ${error.message}`, true);
  } finally {
    $('camera').disabled = false;
  }
};

$('save').onclick = async () => {
  capturePending = true;
  $('save').disabled = true;
  try {
    // Capture immediately after rendering so preserveDrawingBuffer is unnecessary.
    renderer.render(scene, camera);
    const blob = await new Promise((resolve, reject) => renderer.domElement.toBlob(value => value ? resolve(value) : reject(new Error('画像を生成できませんでした。')), 'image/png'));
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `vrmc-studio-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status('PNGを保存しました。');
  } catch (error) {
    status(`保存に失敗しました: ${error.message}`, true);
  } finally {
    capturePending = false;
    $('save').disabled = !entries.length;
  }
};

new ResizeObserver(() => {
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  camera.aspect = stage.clientWidth / stage.clientHeight;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
}).observe(stage);

function animate(time) {
  requestAnimationFrame(animate);
  timer.update();
  if (!frozen) {
    if (tracking && entries.length && video.readyState >= 2 && video.currentTime !== lastVideoTime && time - lastDetectionTime >= 1000 / 30) {
      lastVideoTime = video.currentTime;
      lastDetectionTime = time;
      try {
        diagnostics.detectionStart();
        const result = faceLandmarker.detectForVideo(video, time);
        diagnostics.detectionEnd(result);
        if (result.faceLandmarks?.length) {
          lastBlendshapes = entries[0].avatar.calculateBlendshapes(result);
          for (const {avatar} of entries) avatar.applyBlendshapes(lastBlendshapes);
        }
        diagnostics.detectionApplied();
      } catch (error) {
        stopCamera();
        status(`顔追跡を停止しました: ${error.message}。カメラを再開してお試しください。`, true);
      }
    }
    for (const {avatar} of entries) avatar.vrm.update(Math.min(timer.getDelta(), 0.05));
  }
  renderer.render(scene, camera);
  diagnostics.frame();
}
requestAnimationFrame(animate);
window.addEventListener('pagehide', stopCamera);
