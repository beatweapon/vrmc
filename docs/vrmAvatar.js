import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  VRMLoaderPlugin,
  MToonMaterialLoaderPlugin,
  VRMUtils,
} from "@pixiv/three-vrm";
import { MToonNodeMaterial } from "@pixiv/three-vrm/nodes";

export class VRMAvatar {
  constructor(url, scene, position) {
    console.log({ url, scene, position });
    this.scene = scene;
    this.lookAtTarget = new THREE.Object3D();
    this.lookAtTarget.position.z = 10;
    this.scene.add(this.lookAtTarget);

    this.vrm = null;

    const onLoaded = (vrmAvatar) => {
      vrmAvatar.vrm.scene.position.set(position.x, position.y, position.z);
    };

    this.loadModel(url, onLoaded);
  }

  loadModel(url, onLoaded) {
    const loader = new GLTFLoader();
    loader.crossOrigin = "anonymous";
    loader.register((parser) => {
      const mtoonMaterialPlugin = new MToonMaterialLoaderPlugin(parser, {
        materialType: MToonNodeMaterial,
      });
      return new VRMLoaderPlugin(parser, mtoonMaterialPlugin);
    });

    console.log(url);

    loader.load(
      url,
      (gltf) => {
        const vrm = gltf.userData.vrm;
        console.log("gltf.userData", gltf.userData);
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);

        vrm.scene.traverse((obj) => {
          obj.frustumCulled = false;
        });

        this.setupVrm(vrm);

        if (onLoaded) onLoaded(this);
      },
      undefined,
      (error) => {
        console.error(error);
      },
    );
  }

  async changeModel(url, onLoaded) {
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.loadModel(url, onLoaded);
  }

  setupVrm(vrm) {
    this.adjustArmsToIPose(vrm);
    vrm.lookAt.target = this.lookAtTarget;
    vrm.update(0);

    this.vrm = vrm;
    this.scene.add(vrm.scene);
  }

  adjustArmsToIPose(vrm) {
    const leftUpperArm = vrm.humanoid.getNormalizedBoneNode("leftUpperArm");
    const rightUpperArm = vrm.humanoid.getNormalizedBoneNode("rightUpperArm");
    if (leftUpperArm) leftUpperArm.rotation.z = -Math.PI / 2.5;
    if (rightUpperArm) rightUpperArm.rotation.z = Math.PI / 2.5;
  }

  updateBlendshapes(landmarks) {
    if (!this.vrm) return;
    this.updateHeadRotation(landmarks);

    this.updateFace(landmarks);
  }

  retarget(blendshapes) {
    const categories = blendshapes[0].categories;
    let coefsMap = new Map();
    categories.forEach((blendshape) => {
      // Adjust certain blendshape values to be less prominent.
      switch (blendshape.categoryName) {
        case "eyeBlinkLeft":
          blendshape.score *= 1.2;
          break;
        case "eyeBlinkRight":
          blendshape.score *= 1.2;
          break;
        default:
      }
      coefsMap.set(blendshape.categoryName, blendshape.score);
    });

    return coefsMap;
  }

  updateHeadRotation(landmarks) {
    if (!this.vrm) return;

    const transformationMatrices = landmarks.facialTransformationMatrixes;

    if (!transformationMatrices?.length) return;
    const matrix = new THREE.Matrix4().fromArray(
      transformationMatrices[0].data,
    );
    const originalQuaternion = new THREE.Quaternion().setFromRotationMatrix(
      matrix,
    );

    const reflectQuaternion = new THREE.Quaternion(
      originalQuaternion.x > 0
        ? originalQuaternion.x
        : originalQuaternion.x * 0.3,
      -originalQuaternion.y * 0.5,
      -originalQuaternion.z,
      originalQuaternion.w,
    );

    const spineBone = this.vrm.humanoid.getNormalizedBoneNode("spine");
    const neckBone = this.vrm.humanoid.getNormalizedBoneNode("neck");

    const adjustQuaternionAngleRatio = (quaternion, ratio) => {
      return new THREE.Quaternion(
        quaternion.x * ratio,
        quaternion.y * ratio,
        quaternion.z * ratio,
        quaternion.w,
      );
    };

    spineBone.quaternion.slerp(
      adjustQuaternionAngleRatio(reflectQuaternion, 0.6),
      0.3,
    );
    neckBone.quaternion
      .copy(spineBone.quaternion)
      .multiply(adjustQuaternionAngleRatio(reflectQuaternion, 0.2));
  }

  updateFace(landmarks) {
    if (!this.vrm) return;

    const blendshapes = landmarks.faceBlendshapes;
    if (!blendshapes?.length) return;

    const coefsMap = this.retarget(blendshapes);

    this.updateBlink(coefsMap);
    this.updateEye(coefsMap);
    this.updateMouth(landmarks, coefsMap);
    this.updateFacial(coefsMap);
  }

  updateEye(blendshapes) {
    const rightEyeLookRight =
      (blendshapes.get("eyeLookOutRight") || 0) -
      (blendshapes.get("eyeLookInRight") || 0);
    const leftEyeLookRight =
      (blendshapes.get("eyeLookInLeft") || 0) -
      (blendshapes.get("eyeLookOutLeft") || 0);

    const rightEyeLookUp =
      (blendshapes.get("eyeLookUpRight") || 0) -
      (blendshapes.get("eyeLookDownRight") || 0);
    const leftEyeLookUp =
      (blendshapes.get("eyeLookUpLeft") || 0) -
      (blendshapes.get("eyeLookDownLeft") || 0);

    this.lookAtTarget.position.x =
      (10 * (rightEyeLookRight + leftEyeLookRight)) / 2;
    this.lookAtTarget.position.y =
      1.7 + (10 * (rightEyeLookUp + leftEyeLookUp)) / 2;
  }

  updateBlink(blendshapes) {
    const blink = Math.max(
      blendshapes.get("eyeBlinkLeft"),
      blendshapes.get("eyeBlinkRight"),
    );
    this.vrm.expressionManager.setValue("blinkLeft", (blink - 0.5) * 2);
    this.vrm.expressionManager.setValue("blinkRight", (blink - 0.5) * 2);
  }

  updateMouth(landmarks, blendshapes) {
    const UPPER_LIP_BOTTOM_INDEX = 13;
    const UNDER_LIP_TOP_INDEX = 14;
    const mouthOpen =
      (landmarks.faceLandmarks[0][UPPER_LIP_BOTTOM_INDEX].y -
        landmarks.faceLandmarks[0][UNDER_LIP_TOP_INDEX].y) *
      -1;
    this.vrm.expressionManager.setValue("aa", mouthOpen * 20);

    const mouthPucker = blendshapes.get("mouthPucker");
    const ou = (mouthPucker - 0.5) * 2;
    if (ou > 0) {
      this.vrm.expressionManager.setValue("ou", ou);
    } else {
      this.vrm.expressionManager.setValue("ou", 0);
    }

    const mouthFunnel = blendshapes.get("mouthFunnel");
    if (mouthFunnel > 0.2) {
      this.vrm.expressionManager.setValue("oh", mouthFunnel);
    } else {
      this.vrm.expressionManager.setValue("oh", 0);
    }
  }

  updateFacial(blendshapes) {
    this.vrm.expressionManager.setValue("neutral", 0);

    const browInnerUp = blendshapes.get("browInnerUp");
    if (browInnerUp > 0.7) {
      this.vrm.expressionManager.setValue("surprised", browInnerUp);
    } else {
      this.vrm.expressionManager.setValue("surprised", 0);
    }

    const mouthSmileRight = blendshapes.get("mouthSmileRight");
    const mouthSmileLeft = blendshapes.get("mouthSmileLeft");
    const happy = (mouthSmileRight || 0) + (mouthSmileLeft || 0) - 0.8;
    if (happy > 0) {
      this.vrm.expressionManager.setValue("blinkLeft", happy * 4);
      this.vrm.expressionManager.setValue("blinkRight", happy * 4);
      this.vrm.expressionManager.setValue("surprised", 0);
    } else {
      this.vrm.expressionManager.setValue("happy", 0);
    }

    this.vrm.expressionManager.setValue(
      "neutral",
      0.5 -
        Math.max(
          this.vrm.expressionManager.getValue("aa"),
          this.vrm.expressionManager.getValue("ee"),
          this.vrm.expressionManager.getValue("ou"),
          this.vrm.expressionManager.getValue("oh"),
        ),
    );
  }
}
