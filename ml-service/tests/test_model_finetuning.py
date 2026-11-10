"""Tests for model_finetuning/finetune.py and the learned classifier (no model or videos needed)."""

import cv2
import numpy as np
import pytest

from evaluation import datasets as mcfd
from model_finetuning.finetune import ROTATIONS, label_line, unrotate


# ================================================================================================
# Fine-tuning and Stage B training helpers
# ================================================================================================
#
# Training helpers that can be checked without a model or the dataset.

@pytest.mark.parametrize("angle", [90, 270])
def test_unrotate_undoes_cv2_rotate(angle):
    h, w = 48, 64
    img = np.zeros((h, w), np.uint8)
    img[10, 50] = 255                       # original point: x=50, y=10
    rotated = cv2.rotate(img, ROTATIONS[angle])
    ry, rx = np.argwhere(rotated == 255)[0]
    assert unrotate(np.array([[rx, ry]], float), angle, w, h).tolist() == [[50, 10]]


def test_label_line_is_normalised_yolo_pose():
    kpts = np.zeros((17, 3))
    kpts[0] = (360, 240, 0.9)               # visible
    kpts[1] = (100, 100, 0.3)               # labelled but unsure
    parts = label_line(np.array([300, 200, 420, 280]), kpts, 720, 480).split()
    assert len(parts) == 5 + 17 * 3 and parts[0] == "0"
    assert [float(p) for p in parts[1:5]] == pytest.approx([0.5, 0.5, 120 / 720, 80 / 480], abs=1e-5)
    assert parts[5:8] == ["0.500000", "0.500000", "2"] and parts[10] == "1" and parts[13] == "0"


def _tiny_model(path, threshold=0.5, bias=0.0):
    from detection.fall_detection import FRAME_DIM
    rng = np.random.default_rng(0)
    d = FRAME_DIM * 3
    np.savez(path, n_layers=2, w0=rng.normal(0, 0.1, (d, 4)).astype(np.float32), b0=np.zeros(4, np.float32),
             w1=rng.normal(0, 0.1, (4, 1)).astype(np.float32), b1=np.array([bias], np.float32),
             mean=np.zeros(d, np.float32), std=np.ones(d, np.float32), threshold=threshold, version="test")


def test_learned_classifier_matches_a_direct_calculation(tmp_path):
    from detection.fall_detection import LearnedClassifier, window_vector
    _tiny_model(tmp_path / "m.npz")
    clf = LearnedClassifier(tmp_path / "m.npz")
    rng = np.random.default_rng(1)
    window = [rng.normal(size=56).astype(np.float32) for _ in range(10)]
    m = np.load(tmp_path / "m.npz")
    hidden = np.maximum(window_vector(window) @ m["w0"] + m["b0"], 0)
    expected = 1 / (1 + np.exp(-(hidden @ m["w1"] + m["b1"])[0]))
    assert clf.probability(window) == pytest.approx(expected)
    assert clf.name == "learned" and clf.version == "test"


def test_detector_uses_the_learned_model_when_configured(tmp_path):
    from detection.fall_detection import DetectorConfig, FallDetector
    from detection.fall_detection import LYING, RuleThresholds
    from detection.fall_detection import MonitorConfig
    _tiny_model(tmp_path / "m.npz", bias=50.0)   # always "down"
    det = FallDetector(RuleThresholds(), MonitorConfig(),
                       DetectorConfig(classifier="learned", learned_model=str(tmp_path / "m.npz")))
    standing = np.zeros((17, 3), np.float32)
    standing[:, 0], standing[:, 1], standing[:, 2] = 100, np.linspace(50, 290, 17), 0.9

    class P:
        track_id, box, keypoints = 1, np.array([80, 40, 120, 300], float), standing
    results, _ = det.process(0.0, [P()], (480, 640))
    assert results[0].label == LYING and det.classifier.name == "learned"
    with pytest.raises(ValueError):
        FallDetector(RuleThresholds(), MonitorConfig(), DetectorConfig(classifier="magic"))


def test_mirroring_a_frame_twice_gives_it_back():
    from model_finetuning.finetune import flip
    frame = np.random.default_rng(2).normal(size=56).astype(np.float32)
    assert np.allclose(flip(flip(frame)), frame)


def test_split_keeps_test_data_out_of_training():
    assert not set(mcfd.TEST_SCENARIOS) & set(mcfd.TRAIN_SCENARIOS)
    assert not set(mcfd.TEST_CAMERAS) & set(mcfd.TRAIN_CAMERAS)
    assert set(mcfd.VAL_SCENARIOS) <= set(mcfd.TRAIN_SCENARIOS)
    assert sorted(mcfd.TEST_SCENARIOS + mcfd.TRAIN_SCENARIOS) == list(range(1, 25))
