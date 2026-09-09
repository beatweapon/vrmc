import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {FullBodyAvatar} from './avatar.js';

export class Viewer {
  constructor(stage, {interactive = true, onViewChange = () => {}} = {}) {
    this.stage = stage;
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, Math.PI));
    const light = new THREE.DirectionalLight(0xffffff, 1.4);
    light.position.set(1, 3, 4);
    this.scene.add(light);
    this.camera = new THREE.PerspectiveCamera(32, 1, .01, 100);
    this.camera.position.set(0, 1, 4);
    this.renderer = new THREE.WebGLRenderer({alpha:true, antialias:true});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
    this.resize();
  }
  resize() {
    const {clientWidth:width, clientHeight:height} = this.stage;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
  async load(file) {
    const id = ++this.generation;
    const url = file ? URL.createObjectURL(file) : '../models/VRM1_Constraint_Twist_Sample.vrm';
    let next;
    try {
      next = await FullBodyAvatar.load(url, this.scene);
      if (id !== this.generation) { next.dispose(); return false; }
      this.avatar?.dispose();
      this.avatar = next;
      this.fit();
      return true;
    } finally { if (file) URL.revokeObjectURL(url); }
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
    return {bones:vrm.humanoid.getNormalizedPose(),
      expressions:Object.fromEntries((vrm.expressionManager?.expressions || []).map(expression => [expression.expressionName,vrm.expressionManager.getValue(expression.expressionName)])),
      gaze:vrm.lookAt ? {yaw:vrm.lookAt.yaw,pitch:vrm.lookAt.pitch} : null};
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
    // Reflect the finished image, leaving anatomical sides and all tracking
    // coordinates intact. Output windows use this same display setting.
    this.mirrored = settings.mirrorAvatar === true;
    this.renderer.domElement.style.transform = this.mirrored ? 'scaleX(-1)' : '';
    this.scene.background = settings.background === 'transparent' ? null : new THREE.Color(
      settings.background === 'green' ? '#00ff00' : settings.background === 'blue' ? '#0000ff' : settings.backgroundColor);
  }
  render(frame, delta, settings, frozen) {
    if (!frozen) this.avatar?.update(frame, delta, settings);
    this.renderer.render(this.scene, this.camera);
  }
  async save() {
    this.renderer.render(this.scene, this.camera);
    let canvas = this.renderer.domElement;
    if (this.mirrored) {
      // CSS transforms are absent from toBlob. Bake the same reflection into
      // the export, preserving alpha and excluding every UI overlay.
      const reflected = document.createElement('canvas');
      reflected.width = canvas.width;
      reflected.height = canvas.height;
      const context = reflected.getContext('2d');
      context.translate(reflected.width, 0);
      context.scale(-1, 1);
      context.drawImage(canvas, 0, 0);
      canvas = reflected;
    }
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
    this.renderer.dispose();
  }
}
