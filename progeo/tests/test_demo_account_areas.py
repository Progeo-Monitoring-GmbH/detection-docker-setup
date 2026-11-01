"""The demo plans must carry heat-limitation polygons that match the drawings."""
from progeo.management.commands import demo_account


def test_every_demo_plan_has_normalized_heat_areas():
    for spec in demo_account.LOCATIONS:
        for plan in spec["plans"]:
            areas = plan.get("areas") or []
            assert areas, f"{spec['kind']} has no heat limitation"
            for area in areas:
                assert area["name"]
                points = area["points"]
                assert 3 <= len(points) <= 200
                for x, y in points:
                    assert 0 <= x <= 1 and 0 <= y <= 1, (spec["kind"], area["name"], x, y)


def test_multi_zone_and_multi_view_plans_keep_separate_areas():
    by_kind = {spec["kind"]: spec for spec in demo_account.LOCATIONS}

    is_plan = by_kind["smartex_is"]["plans"][0]
    assert {area["name"] for area in is_plan["areas"]} == {"Hauptdach", "Anbau", "Garage"}

    va_plans = by_kind["smartex_mx_va"]["plans"]
    assert all(plan["areas"] for plan in va_plans)
    assert len({plan["areas"][0]["name"] for plan in va_plans}) == len(va_plans)

    vt_plan = by_kind["smartex_vt"]["plans"][0]
    assert {area["name"] for area in vt_plan["areas"]} == {"Haus A", "Haus B", "Laubengang"}
