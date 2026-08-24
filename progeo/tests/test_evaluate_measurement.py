from dataclasses import dataclass

import pytest

from progeo.helper.measurement_utils import compute_weighted_spots, extract_measurement_values


@dataclass
class DummyPoint:
    id: int
    x: float
    y: float
    last_value: float


def get_base_points():
    points = [0, 4, 1,
              2, 25, 5,
              0, 1, 3]
    return [
        DummyPoint(id=1, x=0, y=0, last_value=points[0]),
        DummyPoint(id=2, x=0.5, y=0, last_value=points[1]),
        DummyPoint(id=3, x=1, y=0, last_value=points[2]),
        DummyPoint(id=4, x=0, y=0.5, last_value=points[3]),
        DummyPoint(id=5, x=0.5, y=0.5, last_value=points[4]),
        DummyPoint(id=6, x=1, y=0.5, last_value=points[5]),
        DummyPoint(id=7, x=0, y=1, last_value=points[6]),
        DummyPoint(id=8, x=0.5, y=1, last_value=points[7]),
        DummyPoint(id=9, x=1, y=1, last_value=points[8]),
    ]

@pytest.mark.parametrize(
    "raw_data,expected",
    [
        ([1, 2, 3], [1.0, 2.0, 3.0]),
        ({"values": ["1", 2, 3.5]}, [1.0, 2.0, 3.5]),
        ({"rows": [[1, 2], [3, 4]]}, [1.0, 2.0, 3.0, 4.0]),
        ({"mixed": {"a": 1, "b": "2.5", "c": [3, "x"]}}, [1.0, 2.5, 3.0]),
        (None, []),
    ],
)
def test_extract_measurement_values(raw_data, expected):
    assert extract_measurement_values(raw_data) == expected


def test_compute_weighted_spots_single_cluster_center_of_gravity():
    points = [
        DummyPoint(id=1, x=0.1, y=0.1, last_value=1.0),
        DummyPoint(id=2, x=0.2, y=0.1, last_value=3.0),
        DummyPoint(id=3, x=0.2, y=0.2, last_value=2.0),
    ]

    spots = compute_weighted_spots(points, neighbor_distance=0.2)

    assert len(spots) == 1
    spot = spots[0]
    assert spot["spot_id"] == 1
    assert spot["point_count"] == 3
    assert spot["member_point_ids"] == [1, 2, 3]

    # Weighted centroid:
    # x = (0.1*1 + 0.2*3 + 0.2*2) / 6 = 0.183333...
    # y = (0.1*1 + 0.1*3 + 0.2*2) / 6 = 0.133333...
    assert spot["x"] == pytest.approx(0.183333, rel=1e-6)
    assert spot["y"] == pytest.approx(0.133333, rel=1e-6)
    assert spot["total_weight"] == pytest.approx(6.0, rel=1e-6)


def test_compute_weighted_spots_multiple_clusters():
    points = [
        DummyPoint(id=1, x=0.10, y=0.10, last_value=5.0),
        DummyPoint(id=2, x=0.12, y=0.10, last_value=4.0),
        DummyPoint(id=3, x=0.80, y=0.80, last_value=8.0),
        DummyPoint(id=4, x=0.82, y=0.78, last_value=7.0),
    ]

    spots = compute_weighted_spots(points, neighbor_distance=0.05)

    assert len(spots) == 2
    first, second = spots

    # Sorted by descending total weight, so second cluster should come first.
    assert first["total_weight"] == pytest.approx(15.0, rel=1e-6)
    assert first["member_point_ids"] == [3, 4]

    assert second["total_weight"] == pytest.approx(9.0, rel=1e-6)
    assert second["member_point_ids"] == [1, 2]


def test_compute_weighted_spots_isolated_points_create_multiple_spots():
    points = [
        DummyPoint(id=1, x=0.05, y=0.05, last_value=2.0),
        DummyPoint(id=2, x=0.50, y=0.50, last_value=3.0),
        DummyPoint(id=3, x=0.95, y=0.95, last_value=4.0),
    ]

    spots = compute_weighted_spots(points, neighbor_distance=0.01)

    print("spots:", spots)
    assert len(spots) == 3
    assert [spot["point_count"] for spot in spots] == [1, 1, 1]
    assert [spot["member_point_ids"] for spot in spots] == [[3], [2], [1]]

