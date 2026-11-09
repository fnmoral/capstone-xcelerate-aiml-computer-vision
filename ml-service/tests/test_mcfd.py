"""The Multiple Cameras Fall Dataset ground truth and scoring (no videos needed)."""

import pytest

from eval import mcfd
from eval.benchmark import _new_tally, score_mcfd


def test_every_scenario_is_annotated_in_order():
    assert sorted(mcfd.PERIODS) == list(range(1, 25)) == sorted(mcfd.DELAYS)
    for s, periods in mcfd.PERIODS.items():
        assert all(len(d) == 8 for d in [mcfd.DELAYS[s]])
        for (a, b, code), (a2, _, _) in zip(periods, periods[1:]):
            assert a <= b < a2 and code in mcfd.ACTIVITY, s


def test_falls_and_time_on_the_ground():
    (f,) = mcfd.falls(1)  # falls at frame 1080, lies 1109-1285
    assert f.start == 1080 / 30 and abs(f.lying_s - 177 / 30) < 1e-9
    assert [x.lying_s for x in mcfd.falls(23)] == [0.0, 0.0]  # gets straight back up, twice
    assert mcfd.falls(24) == []
    assert sum(len(mcfd.falls(s)) for s in mcfd.PERIODS) == 25


def test_activity_at():
    assert mcfd.activity_at(13, 680 / 30) == 8   # lying on a sofa
    assert mcfd.activity_at(1, 10.0) is None     # before the annotations


def test_scoring_short_falls_duplicates_and_false_alarms():
    need = 3.5
    tally = _new_tally()
    fall_t = 1080 / 30
    # Scenario 1: one alert 3 s after the fall, one duplicate, one alert while walking earlier.
    row = score_mcfd(1, [(fall_t + 3.0, fall_t), (fall_t + 4.0, fall_t + 1), (30.0, 30.0)], need, tally)
    assert row == {"expected": 1, "caught": 1, "short": 0, "short_caught": 0, "false_alarms": 1}
    assert tally["duplicates"] == 1 and tally["false_alarms"] == {"walking/standing": 1}
    # Scenario 4: first fall has only 2.2 s on the ground, so it's "short", not a miss.
    row = score_mcfd(4, [], need, tally)
    assert row["short"] == 1 and row["expected"] == 1 and row["caught"] == 0


@pytest.mark.parametrize("text,expected", [("1,3-5", [1, 3, 4, 5]), ("8", [8]), ("2,2", [2])])
def test_parse_list(text, expected):
    assert mcfd.parse_list(text, 1, 8) == expected


def test_parse_list_rejects_out_of_range():
    with pytest.raises(ValueError):
        mcfd.parse_list("0,9", 1, 8)
