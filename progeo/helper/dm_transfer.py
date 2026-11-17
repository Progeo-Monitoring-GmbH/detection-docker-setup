"""
"dm-Transfer" (optional step of the Lageplan wizard): the band ends of smartex
dm sensors read from the plan image.

A dm sensor is a band - a line from x/y (nx/ny) to x_end/y_end (nx_end/ny_end,
ProgeoMeasurePoint). Plans imported without the ends have one point per
sensor that lies on its orange band. trace_bands follows each band from its
point to both ends:

1. snap: the nearest orange pixel to the point (within SNAP of the longest
   side) - none: "no_line";
2. direction: the angle whose ray through that pixel runs on orange the most
   - on its better half, so a point at a band's end works too (crossing bands
   or a marker next to the band don't confuse it like a local fit would) - too
   little orange: "unclear";
3. walk: along that direction both ways while orange is under it (a small
   window across the band, small gaps such as antialiasing bridged), the band's
   middle followed;
4. fit: a straight line through the walked middles, its ends the outermost
   ones - the end nearer the point is the start (x/y stays the band start, as
   the CAD import has it).

Two points whose walks end up on the same band (bands drawn end to end without
a gap) split it: at the widest gap between them, else - "shared", to be
checked - at the later point (points at band starts) or halfway (points in
the middle of their bands), whichever the plan's other bands suggest.

Positions in and out are fractions of the image; transfer() turns them into
nx/ny with the plan's alignment (plan_meters.plan_pixel and its inverse).
"""
from dataclasses import dataclass, field
from itertools import pairwise

import cv2
import numpy as np

from progeo.helper.plan_meters import alignment_base_scale, plan_pixel

# Shares of the longest side of the (mask) image.
SNAP = 0.012
# The direction's ray (each way): RAY_THICKNESS band thicknesses, within
# RAY_RANGE (shares of the longest side).
RAY_THICKNESS = 12
RAY_RANGE = (0.02, 0.08)
ACROSS = 0.003
GAP = 0.004
# The direction is a band when at least this share of its ray is orange.
MIN_RAY_COVER = 0.45
# A ray this much on orange (its better half) is clearly a band; below it -
# or when the band's line isn't straight on orange - up to SEED_CANDIDATES
# other orange pixels near the point are tried.
CLEAR_COVER = 0.9
SEED_CANDIDATES = 8
# The nearest pixel's band is taken without trying others when its fitted
# line runs on orange for at least this share.
CLEAR_STRAIGHT = 0.97
# Angles tried for the direction (degrees, 0..180) - then 1 degree steps
# around the best.
ANGLE_STEP = 6
# A band shorter than this (share of the longest side) is no band - a dot.
MIN_LENGTH = 0.01
# Points this close to their band's start (share of its length) are "at the start".
AT_START = 0.15

FOUND, NO_LINE, UNCLEAR, SHARED = "found", "no_line", "unclear", "shared"


@dataclass
class Band:
    status: str
    # Fractions of the image (0..1); None without a band.
    start: tuple[float, float] | None = None
    end: tuple[float, float] | None = None
    # Mask pixels.
    length: float = 0.0
    # Internals of the walk (mask pixels): the fitted line and the walked middles.
    origin: np.ndarray | None = field(default=None, repr=False)
    direction: np.ndarray | None = field(default=None, repr=False)
    ts: np.ndarray | None = field(default=None, repr=False)


def _hits(mask, coords) -> np.ndarray:
    """mask at the (..., 2) pixel coordinates `coords` - False off the image."""
    ix = np.rint(coords[..., 0]).astype(np.int64)
    iy = np.rint(coords[..., 1]).astype(np.int64)
    inside = (ix >= 0) & (iy >= 0) & (ix < mask.shape[1]) & (iy < mask.shape[0])
    result = np.zeros(ix.shape, dtype=bool)
    result[inside] = mask[iy[inside], ix[inside]]
    return result


def _snap(mask, x, y, radius):
    height, width = mask.shape
    x0, x1 = max(0, int(x - radius)), min(width, int(x + radius) + 1)
    y0, y1 = max(0, int(y - radius)), min(height, int(y + radius) + 1)
    if x0 >= x1 or y0 >= y1:
        return None
    ys, xs = np.nonzero(mask[y0:y1, x0:x1])
    if not len(xs):
        return None
    distances = (xs + x0 - x) ** 2 + (ys + y0 - y) ** 2
    best = int(np.argmin(distances))
    if distances[best] > radius * radius:
        return None
    return np.array([xs[best] + x0, ys[best] + y0], dtype=np.float64)


def _ray_length(distance, point, across, longest):
    """The direction's ray: RAY_THICKNESS band thicknesses long (a ray only a
    few thicknesses long stays on a thick band even when slanted), within
    RAY_RANGE of the longest side."""
    x, y = int(point[0]), int(point[1])
    window = distance[max(0, y - 2 * across): y + 2 * across + 1, max(0, x - 2 * across): x + 2 * across + 1]
    thickness = 2 * float(window.max()) if window.size else 1.0
    low, high = RAY_RANGE
    return round(min(max(RAY_THICKNESS * thickness, low * longest, 6), high * longest))


def _candidates(mask, point, radius):
    """Orange pixels near `point` to start a band's walk from: the nearest
    first, then up to SEED_CANDIDATES spread over the rest."""
    height, width = mask.shape
    x0, x1 = max(0, int(point[0] - radius)), min(width, int(point[0] + radius) + 1)
    y0, y1 = max(0, int(point[1] - radius)), min(height, int(point[1] + radius) + 1)
    if x0 >= x1 or y0 >= y1:
        return []
    ys, xs = np.nonzero(mask[y0:y1, x0:x1])
    pixels = np.stack([xs + x0, ys + y0], axis=1).astype(np.float64)
    distances = np.hypot(*(pixels - point).T) if len(pixels) else np.array([])
    pixels = pixels[distances <= radius][np.argsort(distances[distances <= radius])]
    if not len(pixels):
        return []
    rest = pixels[1:][:: max(1, (len(pixels) - 1) // SEED_CANDIDATES)][:SEED_CANDIDATES]
    return [pixels[0], *rest]


def _straightness(mask, origin, direction, t_from, t_to, across):
    """The share of the fitted line from t_from to t_to that runs on orange
    (a thin window across it) - low for a line that cuts across its band."""
    ts = np.arange(t_from, t_to + 1.0)
    if not len(ts):
        return 0.0
    normal = np.array([-direction[1], direction[0]])
    thin = np.arange(-max(1, across // 3), max(1, across // 3) + 1, dtype=np.float64)
    coords = origin + ts[:, None, None] * direction + thin[None, :, None] * normal
    return float(_hits(mask, coords).any(axis=1).mean())


def _best_band(mask, distance, point, radius, across, gap, longest):
    """(origin, direction, ts) of the band the point lies on, or the reason
    there is none (NO_LINE, UNCLEAR). The nearest orange pixel is tried first
    - clearly on a straight band, that is it; else (a marker or connection
    box next to the band) the candidates' bands compete: the longest that
    runs straight on orange."""
    candidates = _candidates(mask, point, radius)
    if not candidates:
        return NO_LINE
    best, best_score = UNCLEAR, 0.0
    for index, seed in enumerate(candidates):
        ray = _ray_length(distance, seed, across, longest)
        direction, cover = _direction(mask, seed, ray, across)
        if cover < MIN_RAY_COVER:
            continue
        origin, fitted, ts = _follow(mask, seed, direction, across, gap, longest)
        straight = _straightness(mask, origin, fitted, ts[0], ts[-1], across)
        score = (ts[-1] - ts[0]) * straight ** 4
        if score > best_score:
            best, best_score = (origin, fitted, ts), score
        if index == 0 and cover >= CLEAR_COVER and straight >= CLEAR_STRAIGHT:
            break
    return best


def _direction_cover(mask, point, degrees, ray, across):
    """(halves, whole) cover of the rays through `point` at `degrees`."""
    angles = np.radians(degrees)
    d = np.stack([np.cos(angles), np.sin(angles)], axis=1)  # A x 2
    n = np.stack([-d[:, 1], d[:, 0]], axis=1)
    steps = np.arange(-ray, ray + 1, dtype=np.float64)
    # A thin ray: a slightly slanted one must leave the band, not stay on it.
    thin = max(1, across // 3)
    offsets = np.arange(-thin, thin + 1, dtype=np.float64)
    coords = (point[None, None, None, :] + d[:, None, None, :] * steps[None, :, None, None]
              + n[:, None, None, :] * offsets[None, None, :, None])  # A x S x K x 2
    on = _hits(mask, coords).any(axis=2)  # A x S
    # The better half of the ray counts: a point at the end of its band has
    # orange on one side only.
    halves = np.maximum(on[:, : ray + 1].mean(axis=1), on[:, ray:].mean(axis=1))
    return halves, on.mean(axis=1), d


def _direction(mask, point, ray, across):
    """(unit vector, cover) of the angle whose ray through `point` runs on
    orange the most (cover: the share of its better half on orange) - coarse
    angles first, then fine ones around the best."""
    best_degrees = 0.0
    for degrees in (np.arange(0, 180, ANGLE_STEP), None):
        if degrees is None:
            degrees = best_degrees + np.arange(-ANGLE_STEP, ANGLE_STEP + 0.5, 1.0)
        halves, whole, d = _direction_cover(mask, point, degrees, ray, across)
        # The whole ray breaks ties between equally covered halves.
        best = int(np.argmax(halves + 0.01 * whole))
        best_degrees = float(degrees[best])
    return d[best], float(halves[best])


def _run_middles(hits, offsets):
    """Per row of `hits` (steps x offsets across the walk, each with a hit)
    the middle of the run of hits nearest the walk's line - the band's middle
    even when the walk runs a little off it, not that of a marker beside it."""
    rows = np.arange(len(hits))
    distance = np.where(hits, np.abs(offsets)[None, :], np.inf)
    nearest = np.argmin(distance, axis=1)
    starts = hits & ~np.concatenate([np.zeros((len(hits), 1), bool), hits[:, :-1]], axis=1)
    run = np.cumsum(starts, axis=1)
    same = hits & (run == run[rows, nearest][:, None])
    return (same * offsets[None, :]).sum(axis=1) / same.sum(axis=1)


def _walk(mask, point, d, across, gap, limit):
    """The band's middles (mask pixels) from `point` along +d and -d - up to
    `limit` steps each way, ending where more than `gap` steps miss it; and
    whether both ends were reached (not the limit). Sampled in chunks, so a
    short band costs little on a large plan."""
    n = np.array([-d[1], d[0]])
    # On the band: a hit within `across`; its middle is looked for twice as
    # wide - a walk a little off the band would see only its edge otherwise.
    offsets = np.arange(-2 * across, 2 * across + 1, dtype=np.float64)
    near = np.abs(offsets) <= across
    middles = [point[None, :]]
    ended = True
    for sign in (1, -1):
        done = 0
        missed = 0
        stopped = False
        while done < limit and not stopped:
            ts = np.arange(done + 1, min(limit, done + WALK_CHUNK) + 1, dtype=np.float64)
            centres = point[None, :] + sign * ts[:, None] * d[None, :]
            coords = centres[:, None, :] + offsets[None, :, None] * n[None, None, :]  # T x K x 2
            hits = _hits(mask, coords)
            on = hits[:, near].any(axis=1)
            # The first run of more than `gap` misses (counting the misses
            # the last chunk ended with) ends the band.
            run = np.concatenate([np.ones(missed, bool), ~on]).astype(np.int32)
            misses = np.convolve(run, np.ones(gap + 1, dtype=np.int32), mode="valid")
            stops = np.nonzero(misses == gap + 1)[0]
            last = len(on)
            if len(stops):
                last = max(0, int(stops[0]) - missed)
                stopped = True
            keep = np.nonzero(on[:last])[0]
            if len(keep):
                shift = _run_middles(hits[keep], offsets)
                middles.append(centres[keep] + shift[:, None] * n[None, :])
            trailing = len(on) - (int(np.nonzero(on)[0][-1]) + 1) if on.any() else missed + len(on)
            missed = min(trailing, gap)
            done += len(on)
        if not stopped:
            ended = False
    return np.concatenate(middles).astype(np.float32), ended


def _fit(middles):
    """(origin, unit direction, sorted positions along it) of the line through `middles`."""
    if len(middles) < 2:
        point = middles[0].astype(np.float64)
        return point, np.array([1.0, 0.0]), np.array([0.0])
    origin, direction = _line_through(middles)
    # A marker or connection box beside the band (where the point may sit)
    # adds middles off its line: dropped, and the line fitted again.
    normal = np.array([-direction[1], direction[0]])
    residual = np.abs((middles - origin) @ normal)
    kept = middles[residual <= max(1.0, 3 * float(np.median(residual)))]
    if 2 <= len(kept) < len(middles):
        origin, direction = _line_through(kept)
    ts = np.sort((middles - origin) @ direction)
    return origin, direction, ts


def _line_through(middles):
    # Huber: what is left off the band weighs little.
    vx, vy, x0, y0 = cv2.fitLine(middles.reshape(-1, 1, 2), cv2.DIST_HUBER, 0, 0.01, 0.01).flatten()
    return np.array([x0, y0], dtype=np.float64), np.array([vx, vy], dtype=np.float64)


def _ends(origin, direction, t_from, t_to, point):
    a = origin + direction * t_from
    b = origin + direction * t_to
    # The end nearer the measure point is the band's start.
    if np.hypot(*(a - point)) > np.hypot(*(b - point)):
        a, b = b, a
    return a, b


def _follow(mask, point, d, across, gap, longest):
    """Walk the band in growing passes, refitting its direction after each -
    a small error of the first direction would leave a long band otherwise -
    then walk and refit the whole band until the direction holds."""
    limit = max(16, 8 * across)
    while True:
        middles, ended = _walk(mask, point, d, across, gap, limit)
        origin, d, _ts = _fit(middles)
        # Walk on from the point's place on the fitted line.
        point = origin + d * float((point - origin) @ d)
        if ended or limit >= 2 * longest:
            break
        limit *= 4
    for _ in range(REFINE_PASSES):
        middles, _ended = _walk(mask, point, d, across, gap, 2 * longest)
        origin, fitted, ts = _fit(middles)
        point = origin + fitted * float((point - origin) @ fitted)
        if abs(float(fitted @ d)) > 1 - 1e-7:
            return origin, fitted, ts
        d = fitted
    return origin, fitted, ts


# Steps sampled at once while walking a band.
WALK_CHUNK = 256
# Walks along the whole band after the first passes, at most.
REFINE_PASSES = 4

# Larger masks are reduced to this longest side first ("any pixel orange").
WORK_SIZE = 3000


def _working_mask(mask: np.ndarray) -> np.ndarray:
    height, width = mask.shape
    factor = WORK_SIZE / max(width, height)
    if factor >= 1:
        return mask.astype(bool)
    size = (max(1, round(width * factor)), max(1, round(height * factor)))
    return cv2.resize(mask.astype(np.uint8) * 255, size, interpolation=cv2.INTER_AREA) > 0


def trace_bands(mask: np.ndarray, points: list[tuple[float, float]]) -> list[Band]:
    """The band of each point (fractions of the image) on the orange `mask`
    (bool, H x W). See the module docstring."""
    mask = _working_mask(mask)
    height, width = mask.shape
    longest = max(width, height)
    closed = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)) > 0
    snap = max(4.0, SNAP * longest)
    distance = cv2.distanceTransform(closed.astype(np.uint8), cv2.DIST_L2, 3)
    across = max(2, round(ACROSS * longest))
    gap = max(2, round(GAP * longest))
    min_length = max(4.0, MIN_LENGTH * longest)
    scale = np.array([width, height], dtype=np.float64)

    bands: list[Band] = []
    pixels = []
    for fx, fy in points:
        point = np.array([fx * width, fy * height])
        pixels.append(point)
        found = _best_band(closed, distance, point, snap, across, gap, longest)
        if isinstance(found, str):
            bands.append(Band(found))
            continue
        origin, fitted, ts = found
        if ts[-1] - ts[0] < min_length:
            bands.append(Band(UNCLEAR))
            continue
        bands.append(Band(FOUND, origin=origin, direction=fitted, ts=ts, length=float(ts[-1] - ts[0])))

    _split_shared(bands, pixels, across)

    for band, point in zip(bands, pixels):
        if band.origin is None:
            continue
        a, b = _ends(band.origin, band.direction, band.ts[0], band.ts[-1], point)
        band.start = tuple((a / scale).round(6).tolist())
        band.end = tuple((b / scale).round(6).tolist())
        band.length = float(band.ts[-1] - band.ts[0])
    return bands


def _split_shared(bands, pixels, across):
    """Bands holding several points (drawn end to end): split between them."""
    at_start = _points_at_band_starts(bands, pixels)
    done = set()
    for index, band in enumerate(bands):
        if band.origin is None or index in done:
            continue
        on_band = []
        for other, point in enumerate(pixels):
            other_band = bands[other]
            if other_band.origin is None:
                continue
            offset = point - band.origin
            t = float(offset @ band.direction)
            distance = abs(float(offset @ np.array([-band.direction[1], band.direction[0]])))
            if distance <= across + 1.5 and band.ts[0] - across <= t <= band.ts[-1] + across:
                on_band.append((t, other))
        if len(on_band) < 2:
            continue
        on_band.sort()
        ts = band.ts
        cuts = []
        for (t_a, _a), (t_b, _b) in pairwise(on_band):
            between = ts[(ts >= t_a) & (ts <= t_b)]
            steps = np.diff(between) if len(between) > 1 else np.array([])
            if len(steps) and steps.max() >= 2:
                widest = int(np.argmax(steps))
                cuts.append(((between[widest] + between[widest + 1]) / 2, False))
            else:
                cuts.append((t_b - 0.5 if at_start else (t_a + t_b) / 2, True))
        bounds = [ts[0], *[cut for cut, _ in cuts], ts[-1]]
        for position, (_t, other) in enumerate(on_band):
            low, high = bounds[position], bounds[position + 1]
            piece = ts[(ts >= low) & (ts <= high)]
            if len(piece) < 2:
                piece = np.array([low, high])
            bands[other].origin = band.origin
            bands[other].direction = band.direction
            bands[other].ts = piece
            guessed = (position > 0 and cuts[position - 1][1]) or (position < len(cuts) and cuts[position][1])
            bands[other].status = SHARED if guessed else FOUND
            done.add(other)


def _points_at_band_starts(bands, pixels) -> bool:
    """Do the plan's points sit at the start of their bands (as the CAD
    import places them), rather than in their middle? By the bands that hold
    one point only."""
    shares = []
    for band, point in zip(bands, pixels):
        if band.origin is None or band.ts[-1] - band.ts[0] <= 0:
            continue
        t = float((point - band.origin) @ band.direction)
        nearer = min(abs(t - band.ts[0]), abs(band.ts[-1] - t))
        shares.append(nearer / (band.ts[-1] - band.ts[0]))
    return bool(shares) and float(np.median(shares)) <= AT_START


# -------------------------------------------------------------- nx/ny frame

def plan_normalized(fx: float, fy: float, plan, width: float, height: float) -> tuple[float, float]:
    """The inverse of plan_meters.plan_pixel: nx/ny of a point at the image
    fraction fx/fy under the plan's alignment."""
    base_scale = alignment_base_scale(width, height)
    scale_x = plan.scale_x or 1
    scale_y = plan.scale_y or 1
    nx = (fx - (plan.offset_x or 0) / (width * base_scale)) / scale_x
    v = (fy - (plan.offset_y or 0) / (height * base_scale)) / scale_y
    ny = 1 - v if plan.flip_y else v
    return nx, ny


def cad_frame(points) -> tuple | None:
    """x = a * nx + b and y = c * ny + d of the CAD import (cad_reader
    normalize_points), fitted over `points` (nx, ny, x, y) - None per axis
    without two different positions on it."""
    def axis(normalized, raw):
        normalized, raw = np.asarray(normalized, float), np.asarray(raw, float)
        if len(normalized) < 2 or np.ptp(normalized) <= 1e-9:
            return None
        slope, intercept = np.polyfit(normalized, raw, 1)
        return float(slope), float(intercept)

    rows = [(p.nx, p.ny, p.x, p.y) for p in points if None not in (p.nx, p.ny, p.x, p.y)]
    if not rows:
        return None, None
    nxs, nys, xs, ys = zip(*rows)
    return axis(nxs, xs), axis(nys, ys)


def transfer(plan, points, mask: np.ndarray, size: tuple[int, int]) -> list[dict]:
    """The proposals for the measure `points` on `plan` (image `size`, its
    orange `mask`): per point {id, sensor_order, name, status, had_end, nx,
    ny, nx_end, ny_end, start, end (image fractions, for the preview),
    length (share of the longest side)}."""
    width, height = size
    positions = []
    for point in points:
        px, py = plan_pixel(point.nx, point.ny, plan, width, height)
        positions.append((px / width, py / height))
    bands = trace_bands(mask, positions)
    longest = max(mask.shape)
    proposals = []
    for point, band in zip(points, bands):
        entry = {
            "id": point.pk,
            "sensor_order": point.sensor_order,
            "name": point.name,
            "status": band.status,
            "had_end": point.nx_end is not None and point.ny_end is not None,
            "start": band.start,
            "end": band.end,
            "length": round(band.length / longest, 4) if band.start else None,
            "nx": None, "ny": None, "nx_end": None, "ny_end": None,
        }
        if band.start:
            entry["nx"], entry["ny"] = (round(value, 6) for value in plan_normalized(*band.start, plan, width, height))
            entry["nx_end"], entry["ny_end"] = (
                round(value, 6) for value in plan_normalized(*band.end, plan, width, height)
            )
        proposals.append(entry)
    return proposals
