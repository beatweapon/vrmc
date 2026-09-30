import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {FullBodyAvatar} from './avatar.js';
import {sampleModels} from '../models/catalog.js';
import './background-controls.js';
import './model-controls.js';

const LIGHTWEIGHT_KEY = 'vrmc.fullbody.lightweight.v1';
const TRACKING_MODE_KEY = 'vrmc.fullbody.tracking-mode.v1';

const readLightweightState = () => {
  try { return JSON.parse(localStorage.getItem(LIGHTWEIGHT_KEY)) || {enabled:false, previous:null}; }
  catch { return {enabled:false, previous:null}; }
};
const writeLightweightState = state => {
  try { localStorage.setItem(LIGHTWEIGHT_KEY, JSON.stringify(state)); }
  catch { /* The preset still works for the current page. */ }
};
const readTrackingMode = () => {
  try { return localStorage.getItem(TRACKING_MODE_KEY) === 'face' ? 'face' : 'fullbody'; }
  catch { return 'fullbody'; }
};
const writeTrackingMode = mode => {
  try { localStorage.setItem(TRACKING_MODE_KEY, mode); }
  catch { /* The mode still works for the current page. */ }
};
const settingInput = key => document.querySelector(`[data-setting="${key}"]`);
const updateSettingInput = (input, value) => {
  if (!input) return;
  if (input.type === 'checkbox') input.checked = !!value;
  else input.value = String(value);
  input.dispatchEvent(new Event('input', {bubbles:true}));
};

const TRACKING_ICONS = {
  fullbody: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="4.5" r="2.5"/><path d="M8.4 8.2c.7-.8 1.8-1.2 3.6-1.2s2.9.4 3.6 1.2l2.7 3.1-1.6 1.4-2.2-2.5v4.1l2 6.1-2 .6-2.1-5.2h-.8L9.5 21l-2-.6 2-6.1v-4.1l-2.2 2.5-1.6-1.4 2.7-3.1Z"/></svg>',
  face: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5a8 8 0 0 0-8 8v2.8a8 8 0 0 0 16 0v-2.8a8 8 0 0 0-8-8Zm-3 8.1a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2Zm6 0a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2Zm-6.1 3.1h6.2c-.4 2-1.5 3-3.1 3s-2.7-1-3.1-3Z"/></svg>',
};
const FEATHER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5Z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/></svg>';

const setupPerformanceControls = () => {
  const mode = readTrackingMode();
  const lightweightState = readLightweightState();
  document.documentElement.classList.toggle('face-only-mode', mode === 'face');
  document.documentElement.classList.toggle('lightweight-mode', !!lightweightState.enabled);

  if (document.documentElement.classList.contains('output')) return;
  const quality = settingInput('quality');
  const qualityLabel = quality?.closest('label');
  if (!qualityLabel || document.getElementById('lightweight-mode')) return;

  const style = document.createElement('style');
  style.textContent = `
    .tracking-mode-control{display:block;margin:12px 0 6px}
    .tracking-mode-title{display:block;margin-bottom:7px;font-size:11px;color:#bdc9d1}
    .tracking-mode-options{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .tracking-mode-option{display:flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:8px 10px;border:1px solid #45555d;border-radius:9px;background:#182127;color:#c8d2d7;cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s,color .15s}
    .tracking-mode-option:hover{background:#223039;border-color:#71887e}
    .tracking-mode-option[aria-pressed="true"]{background:#29483d;border-color:#acedd1;box-shadow:0 0 0 1px #acedd1 inset;color:#f5fffb}
    .tracking-mode-option svg{width:25px;height:25px;fill:currentColor;flex:0 0 auto}
    .tracking-mode-option span{font-size:11px;font-weight:600;white-space:nowrap}
    .lightweight-quick-control{position:fixed;right:174px;bottom:18px;z-index:7;width:max-content}
    .lightweight-quick-button{width:44px;height:44px;min-width:44px;min-height:44px;padding:9px;border:1px solid #6c827a;border-radius:9px;background:#172028da;color:#acedd1;display:grid;place-items:center;box-shadow:0 3px 14px #0005;transition:background .15s,border-color .15s,box-shadow .15s,transform .15s}
    .lightweight-quick-button:hover{background:#26363e;border-color:#91b5a5}
    .lightweight-quick-button:active{transform:translateY(1px)}
    .lightweight-quick-button[aria-pressed="true"]{background:#29483d;border-color:#acedd1;box-shadow:0 0 0 1px #acedd1 inset,0 3px 14px #0005;color:#f5fffb}
    .lightweight-quick-button svg{width:25px;height:25px;display:block}
    .output .lightweight-quick-control{display:none!important}
    @media(max-width:760px){.lightweight-quick-control{right:168px;bottom:12px}}
  `;
  document.head.appendChild(style);

  const modeControl = document.createElement('div');
  modeControl.className = 'tracking-mode-control';
  modeControl.innerHTML = `<span class="tracking-mode-title">トラッキングモード</span><div class="tracking-mode-options" role="group" aria-label="トラッキングモード"><button type="button" class="tracking-mode-option" data-mode="fullbody">${TRACKING_ICONS.fullbody}<span>Full Body</span></button><button type="button" class="tracking-mode-option" data-mode="face">${TRACKING_ICONS.face}<span>Face Only</span></button></div>`;
  const modeHint = document.createElement('p');
  modeHint.className = 'hint';
  modeHint.textContent = 'Face Onlyでは体・手のMediaPipe処理を停止し、顔の向きに上半身を少し追従させます。動作中の変更は追跡を自動で再起動して反映します。';
  qualityLabel.before(modeControl, modeHint);

  const cameraButton = document.getElementById('camera');
  const connection = document.getElementById('connection');
  const restartTracking = () => {
    if (connection?.dataset.live !== 'true' || !cameraButton) return;
    queueMicrotask(() => {
      if (connection?.dataset.live !== 'true') return;
      cameraButton.click();
      setTimeout(() => cameraButton.click(), 0);
    });
  };
  const modeButtons = [...modeControl.querySelectorAll('[data-mode]')];
  const setMode = nextMode => {
    writeTrackingMode(nextMode);
    document.documentElement.classList.toggle('face-only-mode', nextMode === 'face');
    modeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === nextMode)));
  };
  setMode(mode);
  modeButtons.forEach(button => button.addEventListener('click', () => {
    const nextMode = button.dataset.mode;
    if (nextMode === readTrackingMode()) return;
    setMode(nextMode);
    restartTracking();
  }));

  let state = lightweightState;
  const quickControl = document.createElement('div');
  quickControl.className = 'lightweight-quick-control';
  quickControl.innerHTML = `<button id="lightweight-mode" type="button" class="lightweight-quick-button" aria-label="軽量モード" title="軽量モード ${state.enabled?'ON':'OFF'}" aria-pressed="${String(!!state.enabled)}">${FEATHER_ICON}</button>`;
  document.body.appendChild(quickControl);
  const toggle = quickControl.querySelector('#lightweight-mode');

  const setLightweight = enabled => {
    if (enabled) {
      const fps = settingInput('fps');
      state = {enabled:true,previous:{fps:fps?.value || '24',quality:quality.value || 'balanced'}};
      writeLightweightState(state);
      document.documentElement.classList.add('lightweight-mode');
      updateSettingInput(quality, 'light');
      updateSettingInput(fps, '15');
    } else {
      const previous = state.previous || {fps:'24',quality:'balanced'};
      document.documentElement.classList.remove('lightweight-mode');
      updateSettingInput(quality, previous.quality);
      updateSettingInput(settingInput('fps'), previous.fps);
      state = {enabled:false,previous:null};
      writeLightweightState(state);
    }
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.title = `軽量モード ${enabled?'ON':'OFF'}`;
  };
  toggle.addEventListener('click', () => setLightweight(toggle.getAttribute('aria-pressed') !== 'true'));
};

setupPerformanceControls();

export class Viewer {
  constructor(stage, {interactive = true, onViewChange = () => {}} = {}) {
    this.stage = stage;
    this.scene = new THREE.Scene();

    this.scene.add(new THREE.AmbientLight(0xffffff, .75));
    const lightRig = new THREE.Group();
    lightRig.position.set(0, 1, 0);
    const keyPivot = new THREE.Group();
    lightRig.add(keyPivot);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(0, 0, 1);
    keyPivot.add(keyLight);
    keyPivot.rotation.y = Math.PI * 2 * .64;
    keyPivot.rotation.x = Math.PI * .75;
    this.scene.add(lightRig);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xdc8874, .3));

    this.camera = new THREE.PerspectiveCamera(32, 1, .01, 100);
    this.camera.position.set(0, 1, 4);
    this.renderer = new THREE.WebGLRenderer({alpha:true, antialias:true});
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(this.lightweight ? 1 : Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.setAttribute('aria-label', 'VRMアバター');
    stage.prepend(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enabled = interactive;
    this.controls.target.set(0, 1, 0);
    this.controls.minDistance = .3;
    this.controls.maxDistance = 15;
    this.controls.update();
    this.controls.addEventListener('change', () => onViewChange(this.getView()));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(stage);
    this.generation = 0;
    this.backgroundTexture = null;
    this.backgroundBitmap = null;
    this.lastLightweightRender = 0;
    this.pendingDelta = 0;
    this.resize();
  }
  get lightweight() { return document.documentElement.classList.contains('lightweight-mode'); }
  get faceOnly() { return document.documentElement.classList.contains('face-only-mode'); }
  syncPixelRatio() {
    const ratio = this.lightweight ? 1 : Math.min(devicePixelRatio, 2);
    if (this.renderer.getPixelRatio() !== ratio) this.renderer.setPixelRatio(ratio);
  }
  resize() {
    const {clientWidth:width, clientHeight:height} = this.stage;
    if (!width || !height) return;
    this.syncPixelRatio();
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
  async load(file) {
    const id = ++this.generation;
    const url = file ? URL.createObjectURL(file) : sampleModels[0].url;
    let next;
    try {
      next = await FullBodyAvatar.load(url, this.scene);
      if (id !== this.generation) { next.dispose(); return false; }
      this.avatar?.dispose();
      this.avatar = next;
      this.fitBust();
      return true;
    } finally { if (file) URL.revokeObjectURL(url); }
  }
  fitBust() {
    if (!this.avatar) return;
    this.avatar.vrm.update(0);
    this.scene.updateMatrixWorld(true);
    const vrm = this.avatar.vrm;
    const bounds = new THREE.Box3().setFromObject(vrm.scene, true);
    const center = bounds.getCenter(new THREE.Vector3());
    const humanoid = vrm.humanoid;
    const chestNode = humanoid.getRawBoneNode('upperChest') || humanoid.getRawBoneNode('chest');
    const leftShoulder = humanoid.getRawBoneNode('leftShoulder');
    const rightShoulder = humanoid.getRawBoneNode('rightShoulder');
    const chest = chestNode?.getWorldPosition(new THREE.Vector3()) || new THREE.Vector3(center.x, bounds.min.y + (bounds.max.y-bounds.min.y)*.58, center.z);
    const left = leftShoulder?.getWorldPosition(new THREE.Vector3());
    const right = rightShoulder?.getWorldPosition(new THREE.Vector3());
    const top = bounds.max.y;
    const visibleHeight = Math.max(.28, top - chest.y);
    const shoulderWidth = left && right ? left.distanceTo(right) : Math.max(.3, visibleHeight*.8);
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const verticalDistance = visibleHeight / (2*tangent) * 1.25;
    const horizontalDistance = shoulderWidth / (2*tangent*Math.max(.35,this.camera.aspect)) * 1.35;
    const distance = Math.max(verticalDistance, horizontalDistance) + Math.max(.05, bounds.getSize(new THREE.Vector3()).z*.35);
    const target = new THREE.Vector3(chest.x, chest.y + visibleHeight*.53, chest.z);
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(new THREE.Vector3(0, 0, distance));
    this.controls.update();
  }
  fit() {
    if (!this.avatar) return;
    this.avatar.vrm.update(0);
    this.scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.avatar.vrm.scene, true);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const height = Math.max(size.y, this.avatar.height || 1.5);
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const distance = Math.max(height / (2*tangent), Math.max(size.x, height*.85) / (2*tangent*this.camera.aspect))*1.18 + size.z*.5;
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(0, 0, distance));
    this.controls.update();
  }
  getView() { return {position:this.camera.position.toArray(), target:this.controls.target.toArray(), fov:this.camera.fov}; }
  setView(view) {
    if (!view?.position?.every(Number.isFinite) || !view?.target?.every(Number.isFinite)) return;
    this.camera.position.fromArray(view.position);
    this.controls.target.fromArray(view.target);
    this.controls.update();
  }
  getPose() {
    const vrm = this.avatar?.vrm;
    if (!vrm) return null;
    return {bones:vrm.humanoid.getNormalizedPose(), expressions:Object.fromEntries((vrm.expressionManager?.expressions || []).map(expression => [expression.expressionName,vrm.expressionManager.getValue(expression.expressionName)])), gaze:vrm.lookAt ? {yaw:vrm.lookAt.yaw,pitch:vrm.lookAt.pitch} : null};
  }
  setPose(pose) {
    const vrm = this.avatar?.vrm;
    if (!vrm || !pose) return;
    vrm.humanoid.setNormalizedPose(pose.bones);
    for (const [name,value] of Object.entries(pose.expressions || {})) vrm.expressionManager?.setValue(name,value);
    if (vrm.lookAt && pose.gaze) { vrm.lookAt.yaw=pose.gaze.yaw; vrm.lookAt.pitch=pose.gaze.pitch; }
    vrm.update(0);
  }
  setDisplay(settings) {
    if (settings.background === 'image') { this.scene.background = this.backgroundTexture; return; }
    this.scene.background = settings.background === 'transparent' ? null : new THREE.Color(settings.background === 'green' ? '#00ff00' : settings.background === 'blue' ? '#0000ff' : settings.backgroundColor);
  }
  async setBackgroundImage(file, settings) {
    this.backgroundTexture?.dispose();
    this.backgroundBitmap?.close?.();
    this.backgroundTexture = null;
    this.backgroundBitmap = null;
    if (file) {
      const bitmap = await createImageBitmap(file, {imageOrientation:'flipY'});
      const texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      this.backgroundBitmap = bitmap;
      this.backgroundTexture = texture;
    }
    this.setDisplay(settings);
  }
  applyFaceOnlyTorso(frame, settings, dt) {
    if (!this.faceOnly || !this.avatar?.rig || !frame.face?.tracked) return;
    const values = frame.face.headTarget ?? frame.face.head;
    if (!Array.isArray(values) || values.length !== 4 || !values.every(Number.isFinite)) return;
    const head = new THREE.Quaternion().fromArray(values).normalize();
    if (settings.mirrorAvatar === true) head.set(head.x, -head.y, -head.z, head.w);
    const identity = new THREE.Quaternion();
    const now = performance.now() / 1000;
    for (const [name, amount] of [['spine', .12], ['chest', .22], ['upperChest', .32]]) {
      const rest = this.avatar.rig.rest[name];
      if (!rest || !this.avatar.rig.bones[name]) continue;
      const delta = identity.clone().slerp(head, amount);
      const desired = delta.multiply(rest.world.clone());
      this.avatar.rig.apply(name, desired, now, now, dt, settings, false, true);
    }
  }
  render(frame, delta, settings, frozen) {
    this.syncPixelRatio();
    this.pendingDelta += delta;
    if (this.lightweight) {
      const now = performance.now();
      if (now - this.lastLightweightRender < 1000 / 30) return;
      this.lastLightweightRender = now;
    }
    const renderDelta = Math.min(.05, this.pendingDelta);
    this.pendingDelta = 0;
    if (!frozen) {
      this.avatar?.update(frame, renderDelta, settings);
      this.applyFaceOnlyTorso(frame, settings, renderDelta);
    }
    this.renderer.render(this.scene, this.camera);
  }
  async save() {
    this.renderer.render(this.scene, this.camera);
    const canvas = this.renderer.domElement;
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('画像を生成できませんでした。')), 'image/png'));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vrmc-fullbody-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  dispose() {
    this.generation++;
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.avatar?.dispose();
    this.backgroundTexture?.dispose();
    this.backgroundBitmap?.close?.();
    this.renderer.dispose();
  }
}
