import pytest

import config
from fall.state_machine import RECOVERED, STARTED, UNRESOLVED, UPDATED, Incident, IncidentEvent
from fall.zones import IncidentAggregator

ZONES = {"ward-a": ["cam-1", "cam-2"]}


def event(kind, inc, t=0.0):
    return IncidentEvent(kind, inc, t)


def test_overlapping_cameras_give_one_alert():
    agg = IncidentAggregator(ZONES, merge_window_s=10)
    a = Incident(track_id=1, started_at=100.0, peak_confidence=0.8)
    b = Incident(track_id=7, started_at=102.0, peak_confidence=0.9)

    [(kind1, group)] = agg.handle("t", "cam-1", event(STARTED, a))
    [(kind2, same)] = agg.handle("t", "cam-2", event(STARTED, b))
    assert (kind1, kind2) == (STARTED, UPDATED)  # second camera joins, no second alert
    assert same is group
    assert group.cameras == ["cam-1", "cam-2"]
    assert group.tracks == ["cam-1#1", "cam-2#7"]
    assert group.started_at == 100.0 and group.peak_confidence == 0.9


def test_merged_incident_closes_when_every_camera_closes():
    agg = IncidentAggregator(ZONES, merge_window_s=10)
    a = Incident(1, 100.0, 0.8)
    b = Incident(2, 101.0, 0.8)
    agg.handle("t", "cam-1", event(STARTED, a))
    agg.handle("t", "cam-2", event(STARTED, b))

    a.recovered_at = 130.0
    assert agg.handle("t", "cam-1", event(RECOVERED, a)) == []  # cam-2 still sees them down
    [(kind, group)] = agg.handle("t", "cam-2", event(UNRESOLVED, b))  # cam-2 lost sight of them
    assert kind == RECOVERED and group.status == "recovered" and group.recovered_at == 130.0


def test_all_cameras_unresolved_means_unresolved():
    agg = IncidentAggregator(ZONES, merge_window_s=10)
    a = Incident(1, 100.0, 0.8)
    agg.handle("t", "cam-1", event(STARTED, a))
    [(kind, group)] = agg.handle("t", "cam-1", event(UNRESOLVED, a))
    assert kind == UNRESOLVED and group.status == "unresolved"


def test_severity_is_highest_of_any_camera():
    agg = IncidentAggregator(ZONES, merge_window_s=10)
    a, b = Incident(1, 100.0, 0.8), Incident(2, 101.0, 0.8)
    agg.handle("t", "cam-1", event(STARTED, a))
    agg.handle("t", "cam-2", event(STARTED, b))
    b.severity = "high"
    [(kind, group)] = agg.handle("t", "cam-2", event(UPDATED, b))
    assert kind == UPDATED and group.severity == "high"
    a.severity = "high"
    assert agg.handle("t", "cam-1", event(UPDATED, a)) == []  # nothing new to report


@pytest.mark.parametrize("cam2, start2, tenant2", [
    ("cam-3", 101.0, "t"),   # different zone (cam-3 isn't zoned)
    ("cam-2", 120.0, "t"),   # same zone but outside the merge window
    ("cam-2", 101.0, "t2"),  # same zone, other tenant
])
def test_not_merged(cam2, start2, tenant2):
    agg = IncidentAggregator(ZONES, merge_window_s=10)
    agg.handle("t", "cam-1", event(STARTED, Incident(1, 100.0, 0.8)))
    [(kind, group)] = agg.handle(tenant2, cam2, event(STARTED, Incident(2, start2, 0.8)))
    assert kind == STARTED and group.cameras == [cam2]


def test_two_people_on_one_camera_stay_separate():
    for zones in ({}, ZONES):  # unzoned and zoned camera alike
        agg = IncidentAggregator(zones, merge_window_s=10)
        [(k1, g1)] = agg.handle("t", "cam-1", event(STARTED, Incident(1, 100.0, 0.8)))
        [(k2, g2)] = agg.handle("t", "cam-1", event(STARTED, Incident(2, 101.0, 0.8)))
        assert (k1, k2) == (STARTED, STARTED) and g1 is not g2


def test_second_camera_joins_the_closest_incident():
    agg = IncidentAggregator(ZONES, merge_window_s=10)
    [(_, early)] = agg.handle("t", "cam-1", event(STARTED, Incident(1, 100.0, 0.8)))
    [(_, late)] = agg.handle("t", "cam-1", event(STARTED, Incident(2, 106.0, 0.8)))
    [(kind, joined)] = agg.handle("t", "cam-2", event(STARTED, Incident(5, 105.0, 0.8)))
    assert kind == UPDATED and joined is late and late.cameras == ["cam-1", "cam-2"]
    assert early.cameras == ["cam-1"]


def test_zone_config_validation(tmp_path):
    p = tmp_path / "config.yaml"
    p.write_text("zones:\n  a: [cam-1, cam-2]\n  b: [cam-2]\n", encoding="utf-8")
    with pytest.raises(ValueError, match="in two zones"):
        config.load(p, prod_mode=False)

    p.write_text("zones:\n  a: cam-1\n", encoding="utf-8")
    with pytest.raises(ValueError, match="list of camera_ids"):
        config.load(p, prod_mode=False)

    p.write_text("zones:\n  a: [cam-1]\nfall:\n  merge_window_seconds: 5\n", encoding="utf-8")
    cfg = config.load(p, prod_mode=False)
    assert cfg.zones == {"a": ["cam-1"]} and cfg.merge_window_s == 5
