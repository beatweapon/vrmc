import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {FullBodyAvatar} from './avatar.js';
import {sampleModels} from '../models/catalog.js';
import './background-controls.js';
import './model-controls.js';

export class Viewer {
  constructor(stage, {interactive = true, onViewChange = () => {}} = {}) {
    this.stage = stage;
    this.scene = new THREE.Scene();

    const lightRig = new THREE.Group();
    lightRig.position.set(0, 1, 0);

    const keyPivot = new THREE.Group();
    lightRig.add(keyPivot);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
    keyLight.position.set(0, 0, 1);
    keyLight.castShadow = true;
    keyLight.shadow.radius = 2;
    keyLight.shadow.bias = 1.25e-6;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyPivot.add(keyLight);
    keyPivot.rotation.y = Math.PI * 2 * .64;
    keyPivot.rotation.x = Math.PI * .75;

    const fillLight = new THREE.AmbientLight(0xdc8874, .5);
    lightRig.add(fillLight);
    this.scene.add(lightRig);

    this.camera = new THREE.PerspectiveCamera(32, 1, .01, 100);
    this.camera.position.set(0, 1, 4);
    this.renderer = new THREE.WebGLRenderer({alpha:true, antialias:true});
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    this.backgroundTexture = null;
    this.backgroundBitmap = null;
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
    const url = file ? URL.createObjectURL(file) : sampleModels[0].url;
    let next;
    try {
      next = await FullBodyAvatar.load(url, this.scene);
      if (id !== this.generation) { next.dispose(); return false; }
      this.avatar?.dispose();
      this.avatar = next;
      this.avatar.vrm.scene.traverse(object => {
        if (object.isMesh) object.castShadow = true;
      });
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
    if (settings.background === 'image') {
      this.scene.background = this.backgroundTexture;
      return;
    }
    this.scene.background = settings.background === 'transparent' ? null : new THREE.Color(
      settings.background === 'green' ? '#00ff00' : settings.background === 'blue' ? '#0000ff' : settings.backgroundColor);
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
  render(frame, delta, settings, frozen) {
    if (!frozen) this.avatar?.update(frame, delta, settings);
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
