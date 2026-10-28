# Bundled model assets

## The Fruit Bowl (default scene)

- File: `The Fruit Bowl.sog`
- Author: SuperDelphi (https://superspl.at/user/superdelphi)
- Source: https://superspl.at/scene/d8ba72a6
- License: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)
- Requirements: attribution; commercial use is allowed. The SOG archive also contains the
  upstream `license.txt`.

## Hand model assets

- `soma_hand_left.json`, `soma_hand_right.json` — exported from NVIDIA
  [SOMA-X](https://github.com/NVlabs/SOMA-X) (`SOMAHandLayer`, mid LOD) with
  `tools/export_soma_hand.py`. SOMA-X code and released model artifacts are
  Apache 2.0; attribution required. Upstream use restrictions apply (no
  impersonating real individuals, no deception/biometric misuse).
- `mano_left.json`, `mano_right.json` — derived from the
  [MANO](https://mano.is.tue.mpg.de/) hand model with `tools/export_mano.py`.
  They are **not included in this repository**; generate them locally from the
  MANO pkl if needed. MANO is licensed for non-commercial research; check the
  upstream terms before commercial use or redistribution.
- `hand_landmarker.task` — MediaPipe HandLandmarker model, also downloaded by
  `scripts/setup.sh` and committed here for out-of-the-box use. See the
  [MediaPipe model card](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
  for its license.
