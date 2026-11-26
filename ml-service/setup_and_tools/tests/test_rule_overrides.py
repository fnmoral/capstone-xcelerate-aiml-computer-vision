"""Tests for an organization's own fall and alert rules (Detection rules page, super admins):
with_rules, rule_defaults and FallDetector.configure.
"""

from app.detection.fall_detection import (DetectorConfig, FallDetector, MonitorConfig, RuleThresholds,
                                          TUNABLE_RULES, rule_defaults, with_rules)


def base():
    return RuleThresholds(), MonitorConfig(), DetectorConfig(handoff_seconds=5.0)


def test_changed_rules_go_to_the_right_settings():
    r, m, d = with_rules(*base(), {"confirm_seconds": 5, "lying_torso_angle_deg": 55,
                                   "handoff_radius": 1.0, "high_after_seconds": 90})
    assert m.confirm_seconds == 5.0 and m.high_after_seconds == 90.0
    assert r.lying_torso_angle_deg == 55.0
    assert d.handoff_radius == 1.0
    # the rest stays as config.yaml has it
    assert m.critical_after_seconds == 300.0 and d.handoff_seconds == 5.0


def test_integer_rules_stay_integers():
    r, _, _ = with_rules(*base(), {"min_visible_keypoints": 8.0})
    assert r.min_visible_keypoints == 8 and isinstance(r.min_visible_keypoints, int)


def test_unknown_keys_and_bad_values_are_ignored():
    r, m, d = with_rules(*base(), {"classifier": "learned", "confirm_seconds": "fast",
                                   "recover_seconds": True, "nope": 1})
    assert (r, m, d) == base()
    assert d.classifier == "rules"


def test_no_changes_returns_the_defaults_themselves():
    b = base()
    assert with_rules(*b, None) == b and with_rules(*b, {}) == b


def test_rule_defaults_lists_every_tunable_rule():
    defaults = rule_defaults(*base())
    assert set(defaults) == {k for keys in TUNABLE_RULES.values() for k in keys}
    assert defaults["critical_after_seconds"] == 300.0 and defaults["handoff_seconds"] == 5.0


def test_configure_keeps_tracked_people_and_the_classifier():
    det = FallDetector(*base())
    det._tracks[7] = object()  # someone being tracked
    det.configure(*with_rules(*base(), {"confirm_seconds": 6, "min_keypoint_conf": 0.5}))
    assert det.monitor.cfg.confirm_seconds == 6.0
    assert det.cfg.min_keypoint_conf == 0.5 and det.cfg.classifier == "rules"
    assert 7 in det._tracks
