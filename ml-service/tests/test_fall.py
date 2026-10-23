import numpy as np

from fall.features import extract
from fall.rules import FALLING, LYING, UPRIGHT, RuleClassifier, RuleThresholds
from fall.state_machine import RECOVERED, STARTED, UNRESOLVED, UPDATED, FallMonitor, MonitorConfig


def keypoints(nose, shoulders, hips, conf=0.9):
    k = np.zeros((17, 3), dtype=np.float32)
    k[0] = (*nose, conf)
    k[5] = (*shoulders[0], conf)
    k[6] = (*shoulders[1], conf)
    k[11] = (*hips[0], conf)
    k[12] = (*hips[1], conf)
    return k


STANDING = keypoints(nose=(100, 50), shoulders=((90, 80), (110, 80)), hips=((92, 180), (108, 180)))
LYING_DOWN = keypoints(nose=(300, 400), shoulders=((270, 395), (270, 405)), hips=((170, 395), (170, 405)))


def test_features_standing():
    f = extract(np.array([80, 40, 120, 300]), STANDING, 480, 0.3)
    assert f.torso_angle_deg < 10
    assert f.aspect_ratio < 0.5
    assert f.head_below_hips is False


def test_features_lying():
    f = extract(np.array([150, 380, 320, 420]), LYING_DOWN, 480, 0.3)
    assert f.torso_angle_deg > 80
    assert f.aspect_ratio > 3


def test_features_low_confidence_keypoints_are_ignored():
    f = extract(np.array([80, 40, 120, 300]), keypoints((0, 0), ((0, 0),) * 2, ((0, 0),) * 2, conf=0.1), 480, 0.3)
    assert f.torso_angle_deg is None and f.hip_y is None and f.head_below_hips is None


def test_rules():
    clf = RuleClassifier(RuleThresholds())
    standing = extract(np.array([80, 40, 120, 300]), STANDING, 480, 0.3)
    lying = extract(np.array([150, 380, 320, 420]), LYING_DOWN, 480, 0.3)
    assert clf.classify(standing, 0.0)[0] == UPRIGHT
    assert clf.classify(lying, 0.0)[0] == LYING

    leaning = extract(np.array([80, 40, 160, 300]),
                      keypoints((140, 90), ((150, 120), (160, 125)), ((100, 180), (110, 185))), 480, 0.3)
    assert clf.classify(leaning, 0.0)[0] == UPRIGHT
    assert clf.classify(leaning, 1.5)[0] == FALLING


def run(monitor, labels, start=0.0, step=0.5, track=1):
    events = []
    t = start
    for label in labels:
        events += monitor.update(t, track, label, 0.8)
        t += step
    return events, t


def test_short_dip_does_not_open_incident():
    m = FallMonitor(MonitorConfig(confirm_seconds=3, recover_seconds=3))
    events, _ = run(m, [UPRIGHT, FALLING, LYING, LYING, UPRIGHT] + [UPRIGHT] * 8)
    assert events == []


def test_fall_then_recovery():
    m = FallMonitor(MonitorConfig(confirm_seconds=3, recover_seconds=3))
    events, _ = run(m, [UPRIGHT, FALLING] + [LYING] * 8 + [UPRIGHT] * 8)
    kinds = [e.kind for e in events]
    assert kinds == [STARTED, RECOVERED]
    inc = events[0].incident
    assert inc.started_at == 0.5  # when the fall began, not when it was confirmed
    assert inc.recovered_at == 5.0


def test_severity_escalates_and_lost_track_is_unresolved():
    m = FallMonitor(MonitorConfig(confirm_seconds=1, high_after_seconds=5, critical_after_seconds=10,
                                  lost_track_seconds=2))
    events, t = run(m, [LYING] * 30)
    assert [e.kind for e in events] == [STARTED, UPDATED, UPDATED]
    assert events[-1].incident.severity == "critical"
    assert [e.kind for e in m.expire(t + 5)] == [UNRESOLVED]


def test_hip_velocity():
    m = FallMonitor(MonitorConfig())
    assert m.hip_velocity(1, 0.0, 0.4) is None
    assert abs(m.hip_velocity(1, 0.5, 0.7) - 0.6) < 1e-9
