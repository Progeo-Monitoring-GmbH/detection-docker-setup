# Computed suspicion points

The Status tab of every product (since 2026-11-21; first only smartex® mx-PEEL, project type 7) doesn't list one Verdachtsstelle per sensor. It shows **computed suspicion points**: the places where a leak is most likely, aggregated from all sensors that were over their threshold in the selected period.

## Why

A roof has many sensors close together, an mx-PEEL roof most of all. One leak lets several neighbouring sensors go over their threshold at the same time, so the per-sensor list shows one leak as a dozen entries. Customers need "where is the leak", not "which sensors fired".

## How the points are computed

Code: [progeo/helper/suspicion_clusters.py](../progeo/helper/suspicion_clusters.py). It uses the weighted KDE and peak detection in [progeo/helper/weighted_heatmap.py](../progeo/helper/weighted_heatmap.py), which is plain numpy (no scipy).

1. **Weighted points.** Every sensor that was over its threshold in the period becomes a point on the Lageplan. Its x/y are the normalized coordinates the heatmap uses; a dm band counts at its middle. The weight is

   `weight = min(peak / threshold, MAX_EXCEEDANCE) × (1 + ln(1 + readings))`

   - `peak`: the sensor's highest reading in the period.
   - `threshold`: the measure point's own threshold, else the location's.
   - `readings`: how many evaluated measurements were over the threshold (how often and how long).

2. **KDE.** A weighted Gaussian kernel density estimate runs over these points. Sigma is `SIGMA_SPACING ×` the median nearest-neighbour distance of **all** sensors on the plan, clamped to `SIGMA_MIN..SIGMA_MAX`. Neighbouring alarming sensors merge into one hill; sensors further apart stay separate.
3. **Peaks.** The local maxima of `cluster_strength` (weighted heat × density, which favours many strong sensors together) become candidate points. They must be at least `MIN_DISTANCE_SIGMAS × sigma` apart and at least `THRESHOLD_REL` of the strongest peak.
4. **Members.** Each over-threshold sensor joins its nearest peak within `ASSIGN_SIGMAS × sigma`. A peak without members is dropped.

**Safety rule:** an *active* sensor (an alarm not yet normalized) never disappears. If it is left over (too weak, or too far from every peak), it becomes a point of its own. Weak sensors that are already resolved are dropped; hiding those is the purpose of the aggregation.

**Unplaced sensors:** a sensor without a position on a Lageplan (no measure point, or one without coordinates) can't be aggregated. It becomes a point of its own with `x`/`y`/`lageplan` null: listed with its letter and "not placed on the Lageplan", but without a ring on the plan. Disabled sensors are left out.

Each Lageplan (view) of a location gets its own calculation, in its own coordinates.

| Parameter | Value | Meaning |
| --- | --- | --- |
| `SIGMA_SPACING` | 1.0 | Kernel width in median sensor spacings |
| `SIGMA_MIN` / `SIGMA_MAX` | 0.01 / 0.15 | Bounds of sigma (normalized plan units) |
| `SIGMA_DEFAULT` | 0.05 | Sigma when the spacing can't be measured (one sensor) |
| `MAX_EXCEEDANCE` | 5.0 | Higher exceedance counts no more |
| `MIN_DISTANCE_SIGMAS` | 1.5 | Minimum distance between two points |
| `THRESHOLD_REL` | 0.2 | Weaker peaks (share of the strongest) are dropped |
| `ASSIGN_SIGMAS` | 2.5 | How far a sensor may be from its point |
| `RESOLUTION` | 160 | Grid cells along the longer side of the KDE area |

The period is the Status tab's range. A longer range holds more alarms, so it can yield more points or different ones: "last year" may show three leaks, "last 24 h" only the one that is still active.

## What a point carries

`GET /v1/alarm/computed-clusters/?location=<id>&days=<n>` (demo: `/v1/demo/alarm-computed-clusters/`) uses the same window, scoping and permission (`module_measurements_enabled`) as `/v1/alarm/clusters/`. It answers `{"points": [...], "sigma": {lageplan: sigma}, "sensors": n}`. Each point has:

- `x`, `y`, `lageplan`: position (heatmap coordinates) and the view it lies on; `x_m`, `y_m` on a calibrated plan.
- `strength`: 0..1 of the plan's strongest point.
- `sensor_ids`: the member sensors.
- `state`, `active`, `severity`: the worst of the members.
- `max_value`, `max_exceedance`, `readings`.
- `first_seen`, `last_seen`.
- `alarm_ids`, `pending_ack_alarm_ids`.
- `alarms`: the member sensors' alarm history merged, newest first, each entry with its `sensor_id` (at most `HISTORY_LIMIT` = 1000). The expanded point shows it as the "Alarm-Verlauf" table (25 rows per page, with a sensor column when the point has several sensors).

Acknowledging a point acknowledges every pending alarm of its member sensors (`/v1/alarm/<id>/acknowledge/`).

## In the portal

- **Customers** see the computed points in the "Suspected leak locations" panel and as lettered rings (A, B, ...) over the heatmap. The heatmap stays. Ring size follows the strength; ring colour follows the state (red: new, orange: acknowledged, grey: resolved).
- **Staff** (`is_staff` or `is_superuser`) can switch between "Computed" and "Per sensor" in the panel's header. With "Show as normal user" on, staff see the customer view.
- The "Verdachtsstellen" KPI counts the open computed points (per sensor while staff look at "Per sensor").
- LoRaWAN climate objects have no Verdachtsstellen.

Frontend: [computedSuspicion.ts](../frontend/src/main/computedSuspicion.ts), [useComputedSuspicion.ts](../frontend/src/main/useComputedSuspicion.ts), [ComputedSuspicionPanel.tsx](../frontend/src/main/ComputedSuspicionPanel.tsx), [SuspicionMarkers.tsx](../frontend/src/components/device/SuspicionMarkers.tsx).

---

# Lageplan: automatic heat limitations and resolution score

## Heat clipped at the building outline

The heatmap is only drawn inside a Lageplan's heat limitations. Until now they only existed where staff had run wizard step 6 or `auto_lageplans --heat-limits`. Now [progeo/helper/auto_heat_limits.py](../progeo/helper/auto_heat_limits.py) detects them on its own: the building outlines that hold sensors, plus a padded hull around sensors that lie outside every outline.

- **New plans:** a celery task (`auto_heat_limitations_task`) runs after a plan upload, a CAD import, a placement (wizard step 5) or a saved alignment. `AUTO_HEAT_LIMITATIONS=0` in `django.env` switches this off.
- **Existing plans:** `python manage.py backfill_heat_limits` is a dry run by default; `--apply` stores. `--project` and `--database` narrow the run, `--limit` caps it.
- **Hand-made areas are never replaced.** A plan's areas are only (re)detected while it has none, or while every area it has is automatic (named "Auto 1", "Auto 2 (sensors)", ...). Automatic areas therefore follow a changed alignment. If staff delete every area, the next placement or alignment detects them again.

## Resolution score

[progeo/helper/plan_resolution.py](../progeo/helper/plan_resolution.py) scores each plan image from 0 to 100. The score is the weakest of three measures, each relative to its target:

- long side in pixels (target 2000)
- pixels per metre on calibrated plans (target 20)
- median pixel distance between neighbouring sensors (target 30)

Grades: **ok** from 75, **low** from 40, otherwise **very low**.

- The location checklist has a new optional check, "Lageplan resolution sufficient", on the main plan. Its detail shows the grade and links to the wizard.
- `python manage.py lageplan_resolution` lists the low-res plans; `--all` lists every plan and `--csv <file>` writes them to a file.
- With `--airtable`, the command writes the worst grade per project into the Airtable field `AIRTABLE_LAGEPLAN_RESOLUTION_FIELD` (default "Lageplan Auflösung", a text field you create in the projects table). Records are matched by Projektnummer. `--clear-ok` empties the field for projects whose plans are all ok.
- New plans go through the Lageplan wizard as before.
