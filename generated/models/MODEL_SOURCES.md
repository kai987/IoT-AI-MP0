# Model sources and checksums

## YuNet face detector

- Source: https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
- File: `face_detection_yunet_2023mar.onnx`
- License: MIT
- SHA-256: `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`

## EmotiEffLib facial-expression classifier

- Source: https://github.com/sb-ai-lab/EmotiEffLib/tree/main/models/affectnet_emotions/onnx
- File: `enet_b0_8_best_vgaf.onnx`
- License: Apache-2.0
- SHA-256: `fa07e841fd06c7a67ee651ea4e6e4a3a2bb5695f47b37a7da50492526f59c898`

## MediaPipe Face Landmarker

- Source: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task
- Documentation: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/python
- Model card: https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Face%20Mesh%20V2.pdf
- File: `face_landmarker.task`
- License file: `LICENSE-MEDIAPIPE.txt` (Apache-2.0)
- SHA-256: `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`

The previous FERPlus and OpenCV SSD/Caffe files are retained for reference but are
not loaded by the default recognition pipeline.
