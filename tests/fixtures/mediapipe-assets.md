# MediaPipe integration test photographs

`tests/tracker-browser.js` downloads two official MediaPipe test photographs to
the ignored `test-results/mediapipe/` directory and verifies their SHA-256 hashes.
The images are not redistributed in this repository. The test already requires
network access for the pinned MediaPipe WASM runtime and model files.

- [pointing_up.jpg](https://storage.googleapis.com/mediapipe-assets/pointing_up.jpg):
  a right hand with the index extended and other fingers curled, used by the
  [upstream hand landmarker tests](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/python/test/vision/hand_landmarker_test.py).
  Wrist and index-tip reference positions come from
  [pointing_up_landmarks.pbtxt](https://storage.googleapis.com/mediapipe-assets/pointing_up_landmarks.pbtxt).
- [pose.jpg](https://storage.googleapis.com/mediapipe-assets/pose.jpg): a person
  with both arms extended, used by the
  [upstream pose tests](https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/python/solutions/pose_test.py).

The app's real video capture and worker inference paths process these images.
Assertions cover anatomical handedness, image/world point validity, actual
finger articulation, visible torso/arm landmarks, and wrist locations. Detector
results are retained beside the downloaded assets for inspection. Static image
checks establish data compatibility; they do not measure real camera occlusion,
motion accuracy, or temporal stability.

`pointing-up-landmarks.json` retains the 21 image and 21 world points from the
upstream reference `pointing_up_landmarks.pbtxt`, together with its source URL.
The offline `real-hand-rig.test.js` uses these measured points to check physical
finger segment angles on the bundled VRM's original skeleton after normalized
bone transfer, including the geometrically reflected left hand.

`pointing-up-native.json` retains an unmodified result from the pinned
JavaScript Tasks SDK's real video/worker inference on the same photograph,
including `visibility: 0` on Hand landmarks. Unlike the upstream reference
coordinates, this fixture preserves the SDK container fields that exposed the
Hand-to-Pose confidence-gate bug. The raw-VRM test passes it through
TrackingState and solveBody before checking wrist position and finger angles.
A controlled face anchor also carries zero visibility; Pose zero confidence
continues to be rejected. No user camera data is included.
