import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAvatar } from '../vrmAvatar.js';

export class StudioAvatar extends VRMAvatar {
  loadModel(url, onLoaded) {
    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    this.ready = loader.loadAsync(url).then(gltf => {
      const vrm = gltf.userData.vrm;
      if (!vrm) {
        VRMUtils.deepDispose(gltf.scene);
        throw new Error('VRMとして読み込めないファイルです。');
      }
      try {
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);
        VRMUtils.rotateVRM0(vrm);
        vrm.scene.traverse(object => { object.frustumCulled = false; });
        this.setupVrm(vrm);
        onLoaded?.(this);
        vrm.update(0);
        return this;
      } catch (error) {
        this.scene.remove(vrm.scene);
        VRMUtils.deepDispose(vrm.scene);
        this.vrm = null;
        throw error;
      }
    });
    return this.ready;
  }

  updateHeadRotation(values) {
    if (!this.vrm || !Array.isArray(values) || values.length !== 4 || !values.every(Number.isFinite)) return;
    const target = new THREE.Quaternion(...values).normalize();
    // Optional bones differ between VRMs; retain the same distribution for each model.
    ['spine', 'chest', 'upperChest', 'neck', 'head'].forEach((name, index) => {
      const bone = this.vrm.humanoid.getNormalizedBoneNode(name);
      if (bone) bone.quaternion.slerp(new THREE.Quaternion().slerp(target, (index + 1) / 5), 0.5);
    });
  }
}
