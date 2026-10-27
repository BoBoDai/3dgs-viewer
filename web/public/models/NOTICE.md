# Hand model assets

- `mano_left.json`, `mano_right.json` — derived from the
  [MANO](https://mano.is.tue.mpg.de/) hand model with `tools/export_mano.py`.
  They are included so hand mode works without downloading the MANO pkl.
  MANO is licensed for non-commercial research; check the upstream terms before
  commercial use or public redistribution.
- `hand_landmarker.task` — MediaPipe HandLandmarker model, also downloaded by
  `scripts/setup.sh` and committed here for out-of-the-box use. See the
  [MediaPipe model card](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
  for its license.
