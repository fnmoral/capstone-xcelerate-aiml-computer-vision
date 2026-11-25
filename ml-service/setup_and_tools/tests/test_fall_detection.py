"""Tests for app/detection/fall_detection.py: measurements, rules, incident timing, FallDetector.
"""

import numpy as np

from app.detection.fall_detection import DetectorConfig, FALLING, FallDetector, FallMonitor, LYING, MonitorConfig, RECOVERED, RuleClassifier, RuleThresholds, STARTED, UNCLEAR, UNRESOLVED, UPDATED, UPRIGHT, extract


# ================================================================================================
# 1. Fall detection
# ================================================================================================

FRAME = (480, 640)


def keypoints(nose, shoulders, hips, knees=None, ankles=None, conf=0.9):
    k = np.zeros((17, 3), dtype=np.float32)
    k[0] = (*nose, conf)
    k[5], k[6] = (*shoulders[0], conf), (*shoulders[1], conf)
    k[11], k[12] = (*hips[0], conf), (*hips[1], conf)
    if knees:
        k[13], k[14] = (*knees[0], conf), (*knees[1], conf)
    if ankles:
        k[15], k[16] = (*ankles[0], conf), (*ankles[1], conf)
    return k


STANDING = keypoints(nose=(100, 50), shoulders=((90, 80), (110, 80)), hips=((92, 180), (108, 180)),
                     knees=((92, 240), (108, 240)), ankles=((92, 295), (108, 295)))
STANDING_BOX = np.array([80, 40, 120, 300])
LYING_DOWN = keypoints(nose=(300, 400), shoulders=((270, 395), (270, 405)), hips=((170, 395), (170, 405)),
                       knees=((110, 395), (110, 405)), ankles=((55, 395), (55, 405)))
LYING_BOX = np.array([45, 380, 320, 420])
# Side view, bent forward ~85 degrees at the hips, legs straight.
BENT_OVER = keypoints(nose=(215, 165), shoulders=((175, 170), (175, 175)), hips=((100, 180), (100, 185)),
                      knees=((100, 240), (100, 245)), ankles=((100, 295), (100, 300)))
BENT_BOX = np.array([85, 150, 225, 305])


def test_features_standing():
    f = extract(STANDING_BOX, STANDING, FRAME, 0.3)
    assert f.torso_angle_deg < 10
    assert f.aspect_ratio < 0.5
    assert f.head_below_hips is False
    assert f.legs_upright > 0.9 and f.visible == 9 and f.lower_body and not f.at_edge


def test_features_lying():
    f = extract(LYING_BOX, LYING_DOWN, FRAME, 0.3)
    assert f.torso_angle_deg > 80
    assert f.aspect_ratio > 3
    assert abs(f.legs_upright) < 0.1


def test_features_low_confidence_keypoints_are_ignored():
    f = extract(STANDING_BOX, keypoints((0, 0), ((0, 0),) * 2, ((0, 0),) * 2, conf=0.1), FRAME, 0.3)
    assert f.torso_angle_deg is None and f.hip_y is None and f.head_below_hips is None
    assert f.visible == 0 and not f.lower_body


def test_features_body_angle_without_hips():
    k = LYING_DOWN.copy()
    k[[11, 12], 2] = 0.0  # hips hidden: head to knees/ankles instead
    f = extract(LYING_BOX, k, FRAME, 0.3)
    assert f.angle_source == "body" and f.torso_angle_deg > 80


def test_features_box_at_frame_edge():
    assert extract(np.array([0, 380, 320, 420]), LYING_DOWN, FRAME, 0.3).at_edge


def test_rules():
    clf = RuleClassifier(RuleThresholds())
    assert clf.classify(extract(STANDING_BOX, STANDING, FRAME, 0.3), 0.0)[0] == UPRIGHT
    assert clf.classify(extract(LYING_BOX, LYING_DOWN, FRAME, 0.3), 0.0)[0] == LYING

    leaning = extract(np.array([80, 40, 160, 300]),
                      keypoints((140, 90), ((150, 120), (160, 125)), ((100, 180), (110, 185)),
                                knees=((95, 240), (105, 240)), ankles=((90, 295), (100, 295))), FRAME, 0.3)
    assert clf.classify(leaning, 0.0)[0] == UPRIGHT
    assert clf.classify(leaning, 2.0)[0] == FALLING


def test_bending_over_on_straight_legs_is_not_lying():
    clf = RuleClassifier(RuleThresholds())
    f = extract(BENT_BOX, BENT_OVER, FRAME, 0.3)
    assert f.torso_angle_deg > 80 and f.legs_upright > 0.9
    assert clf.classify(f, 0.0)[0] == UPRIGHT


def test_lying_seen_by_a_low_camera_is_lying():
    """Legs toward a low camera: ankles show below the hips, but the outline is wide."""
    clf = RuleClassifier(RuleThresholds())
    low = keypoints(nose=(300, 400), shoulders=((270, 395), (270, 405)), hips=((170, 398), (170, 402)),
                    knees=((130, 440), (130, 444)), ankles=((100, 500), (100, 504)))
    f = extract(np.array([90, 380, 320, 510]), low, (720, 1280), 0.3)   # fully inside the frame
    assert f.legs_upright > 0.6 and f.aspect_ratio > 1.3 and not f.kneeling
    assert clf.classify(f, 0.0)[0] == LYING


def test_kneeling_with_a_flat_torso_is_not_lying():
    """Kneeling to look under furniture: torso flat, but thighs down and shins on the floor."""
    clf = RuleClassifier(RuleThresholds())
    kneel = keypoints(nose=(330, 330), shoulders=((290, 335), (290, 340)), hips=((200, 320), (200, 325)),
                      knees=((215, 400), (215, 405)), ankles=((140, 402), (140, 407)))
    f = extract(np.array([130, 310, 340, 410]), kneel, FRAME, 0.3)
    assert f.torso_angle_deg > 70 and f.kneeling
    assert clf.classify(f, 0.0)[0] == UPRIGHT
    assert extract(LYING_BOX, LYING_DOWN, FRAME, 0.3).kneeling is False   # thighs flat: not kneeling


def test_too_little_evidence_is_unclear():
    clf = RuleClassifier(RuleThresholds())
    # Only nose, shoulders and hips: fewer than min_visible_keypoints.
    few = keypoints((300, 400), ((270, 395), (270, 405)), ((170, 395), (170, 405)))
    assert clf.classify(extract(LYING_BOX, few, FRAME, 0.3), 0.0)[0] == UNCLEAR
    # Upper body only behind a table, wide box: no hips or legs, so the shape alone doesn't count.
    upper = np.zeros((17, 3), dtype=np.float32)
    upper[:11] = [(320 + dx, 200 + dy, 0.9) for dx, dy in
                  [(0, 0), (5, -5), (-5, -5), (12, 0), (-12, 0), (40, 40), (-40, 40), (80, 70), (-80, 70),
                   (130, 80), (-130, 80)]]
    assert clf.classify(extract(np.array([180, 180, 460, 290]), upper, FRAME, 0.3), 0.0)[0] == UNCLEAR


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


def test_stray_lying_frames_do_not_add_up():
    # A single misdetected frame, upright for 2.9 s, another single one: never an incident.
    m = FallMonitor(MonitorConfig(confirm_seconds=3, recover_seconds=3))
    events, _ = run(m, [LYING] + [UPRIGHT] * 29 + [LYING] + [UPRIGHT] * 29 + [LYING], step=0.1)
    assert events == []


def test_fall_then_recovery():
    m = FallMonitor(MonitorConfig(confirm_seconds=3, recover_seconds=3))
    events, _ = run(m, [UPRIGHT, FALLING] + [LYING] * 8 + [UPRIGHT] * 8)
    kinds = [e.kind for e in events]
    assert kinds == [STARTED, RECOVERED]
    inc = events[0].incident
    assert inc.started_at == 0.5  # when the fall began, not when it was confirmed
    assert inc.recovered_at == 5.0


def test_fall_start_skips_an_old_stray_frame():
    m = FallMonitor(MonitorConfig(confirm_seconds=3, recover_seconds=3))
    events, _ = run(m, [LYING] + [UPRIGHT] * 20 + [LYING] * 40, step=0.1)
    assert [e.kind for e in events] == [STARTED]
    assert abs(events[0].incident.started_at - 2.1) < 1e-6  # the real fall, not the glitch at 0.0


def test_unclear_frames_change_nothing():
    m = FallMonitor(MonitorConfig(confirm_seconds=1, recover_seconds=1))
    events, t = run(m, [LYING] * 4)
    assert [e.kind for e in events] == [STARTED]
    events, _ = run(m, [UNCLEAR] * 10, start=t)  # e.g. hidden behind furniture: still down
    assert events == [] and m.incident_of(1) is not None


def test_severity_escalates_and_lost_at_the_edge_is_unresolved():
    m = FallMonitor(MonitorConfig(confirm_seconds=1, high_after_seconds=5, critical_after_seconds=10,
                                  lost_track_seconds=2))
    events, t = run(m, [LYING] * 30)
    assert [e.kind for e in events] == [STARTED, UPDATED, UPDATED]
    assert events[-1].incident.severity == "critical"
    m.update(t, 1, LYING, 0.8, at_edge=True)  # last seen at the edge of the picture: went out of view
    assert [e.kind for e in m.expire(t + 5)] == [UNRESOLVED]


def test_hidden_fallen_person_stays_open_and_escalates():
    # Lost in the middle of the picture (e.g. behind someone): still down, not "out of view".
    m = FallMonitor(MonitorConfig(confirm_seconds=1, high_after_seconds=5, critical_after_seconds=10,
                                  lost_track_seconds=2))
    events, t = run(m, [LYING] * 4)
    assert [e.kind for e in events] == [STARTED]
    assert m.expire(t + 2.5) == []  # lost, but no change yet
    escalated = m.expire(t + 11)
    assert [e.kind for e in escalated] == [UPDATED] and escalated[0].incident.severity == "critical"
    assert m.incident_of(1) is not None
    assert [e.kind for e in m.close_all(t + 20)] == [UNRESOLVED]  # the camera stopped


class P:
    def __init__(self, track_id, box, keypoints):
        self.track_id, self.box, self.keypoints = track_id, np.asarray(box, dtype=float), keypoints


def detector(**monitor):
    return FallDetector(RuleThresholds(), MonitorConfig(**({"confirm_seconds": 1.0} | monitor)), DetectorConfig())


def test_hip_velocity_is_in_torso_lengths_per_second():
    det = detector()
    torso = 100.0  # shoulders at y=80, hips at y=180
    for i in range(6):
        k = STANDING.copy()
        k[:, 1] += 20 * i  # whole body moves down 20 px per 0.1 s = 200 px/s = 2 torso lengths/s
        results, _ = det.process(i * 0.1, [P(1, STANDING_BOX + [0, 20 * i, 0, 20 * i], k)], FRAME)
    assert abs(results[0].hip_velocity - 200 / torso) < 1e-6


def test_new_track_id_takes_over_a_fallen_person():
    det = detector()
    t, events = 0.0, []
    for _ in range(5):  # down for 0.5 s as track 1
        events += det.process(t, [P(1, LYING_BOX, LYING_DOWN)], FRAME)[1]
        t += 0.1
    for _ in range(7):  # the tracker renumbers them: track 2 continues the same fall
        events += det.process(t, [P(2, LYING_BOX + 5, LYING_DOWN)], FRAME)[1]
        t += 0.1
    assert [e.kind for e in events] == [STARTED]
    assert events[0].at < 1.15  # confirmed after 1 s in total, not 1 s after the new ID appeared
    assert det.incident_of(2) is not None


def moved(kpts, box, dx, dy):
    k = kpts.copy()
    k[:, 0] += dx
    k[:, 1] += dy
    return k, box + [dx, dy, dx, dy]


def test_incident_follows_the_fallen_person_not_the_nearest_lost_one():
    # Two people close together; the tracker loses both and a new ID appears between them,
    # nearer the one standing. It carries on the fallen person's incident (one incident per
    # person), instead of taking the bystander's state and opening a second incident.
    det = detector()
    other_k, other_box = moved(STANDING, STANDING_BOX, 320, 130)  # centre (420, 300)
    t, events = 0.0, []
    for _ in range(15):
        events += det.process(t, [P(1, LYING_BOX, LYING_DOWN), P(2, other_box, other_k)], FRAME)[1]
        t += 0.1
    assert [e.kind for e in events] == [STARTED]
    incident = det.incident_of(1)
    new_k, new_box = moved(LYING_DOWN, LYING_BOX, 147.5, -40)  # centre (330, 360): nearer person 2
    for _ in range(10):
        events += det.process(t, [P(3, new_box, new_k)], FRAME)[1]
        t += 0.1
    assert [e.kind for e in events] == [STARTED]  # no second incident
    assert det.incident_of(3) is incident


def test_getting_up_under_a_new_id_is_recovered_not_unresolved():
    # Standing up changes the box completely, so the tracker often renumbers the person.
    det = detector(lost_track_seconds=2)
    t, events = 0.0, []
    for _ in range(15):
        events += det.process(t, [P(1, LYING_BOX, LYING_DOWN)], FRAME)[1]
        t += 0.1
    up_k, up_box = moved(STANDING, STANDING_BOX, 82, -20)  # 250 px from where they lay
    for _ in range(35):
        events += det.process(t, [P(2, up_box, up_k)], FRAME)[1]
        t += 0.1
    events += det.expire(t + 5)
    assert [e.kind for e in events] == [STARTED, RECOVERED]


def test_someone_already_in_view_never_takes_over_a_fall():
    # A caregiver standing next to the fallen person when that person's track is lost keeps
    # their own state: the fall can't be "recovered" by someone else standing nearby.
    det = detector(lost_track_seconds=2)
    helper_k, helper_box = moved(STANDING, STANDING_BOX, 82, -20)
    t, events = 0.0, []
    for _ in range(15):
        events += det.process(t, [P(1, LYING_BOX, LYING_DOWN), P(2, helper_box, helper_k)], FRAME)[1]
        t += 0.1
    for _ in range(35):  # person 1 hidden; the helper stays standing there
        events += det.process(t, [P(2, helper_box, helper_k)], FRAME)[1]
        events += det.expire(t)
        t += 0.1
    assert [e.kind for e in events] == [STARTED]  # still open: person 1 is hidden, not gone
    assert det.incident_of(2) is None and det.incident_of(1) is not None


def stay(det, t, people, seconds):
    events = []
    for _ in range(int(seconds * 10)):
        events += det.process(t, people, FRAME)[1]
        events += det.expire(t)
        t += 0.1
    return events, t


def test_hidden_person_seen_again_on_the_spot_keeps_one_incident():
    det = detector(lost_track_seconds=2)
    events, t = stay(det, 0.0, [P(1, LYING_BOX, LYING_DOWN)], 1.5)
    events2, t = stay(det, t, [], 30)  # hidden for 30 s
    events3, t = stay(det, t, [P(7, LYING_BOX + 4, LYING_DOWN)], 2)  # found again, new ID
    assert [e.kind for e in events + events2 + events3] == [STARTED]
    assert det.incident_of(7) is events[0].incident


def test_hidden_person_getting_up_on_the_spot_is_recovered():
    det = detector(lost_track_seconds=2)
    events, t = stay(det, 0.0, [P(1, LYING_BOX, LYING_DOWN)], 1.5)
    more, t = stay(det, t, [], 30)
    up_k, up_box = moved(STANDING, STANDING_BOX, 80, 150)  # standing up where they lay
    more += stay(det, t, [P(8, up_box, up_k)], 4)[0]
    assert [e.kind for e in events + more] == [STARTED, RECOVERED]


def test_someone_new_away_from_the_spot_never_takes_over_a_hidden_fall():
    det = detector(lost_track_seconds=2)
    events, t = stay(det, 0.0, [P(1, LYING_BOX, LYING_DOWN)], 1.5)
    more, t = stay(det, t, [], 30)
    k, box = moved(STANDING, STANDING_BOX, 400, 0)  # someone walks in elsewhere
    more += stay(det, t, [P(9, box, k)], 4)[0]
    assert [e.kind for e in events + more] == [STARTED]
    assert det.incident_of(9) is None and det.incident_of(1) is not None


def test_two_people_renumbered_at_once_each_keep_their_own_state():
    # Both are new IDs in the same frame and both stand on the hidden person's spot: the nearer
    # one (still lying there) takes over, whatever order the tracker lists them in.
    det = detector(lost_track_seconds=2)
    events, t = stay(det, 0.0, [P(1, LYING_BOX, LYING_DOWN)], 1.5)
    more, t = stay(det, t, [], 20)
    helper_k, helper_box = moved(STANDING, STANDING_BOX, 230, 150)  # standing on the spot's edge
    more += stay(det, t, [P(11, helper_box, helper_k), P(12, LYING_BOX + 2, LYING_DOWN)], 4)[0]
    assert [e.kind for e in events + more] == [STARTED]
    assert det.incident_of(12) is events[0].incident and det.incident_of(11) is None
