"""
Reading a Lageplan image with OpenCV for the Lageplan wizard.

- auto_align: the plan's point alignment (offset/scale/flip, see
  plan_meters.plan_pixel) that lays the measure points onto the orange lines
  of the plan - the dm bands / sensors as the CAD drawing marks them.
- detect_heat_limitations: areas for the heat limitations - the outlines of
  the buildings drawn on the plan (several clusters each get their own),
  every one holding at least one sensor. Sensors outside every outline get
  an area around their cluster, so no sensor's heat is cut off.

The masks (ink, orange) are made at full resolution - a thin line would fade
away when the image is scaled down first - and then reduced to a working
size with "any pixel set" (cv2.INTER_AREA, > 0). Everything else works in
fractions of the image, so the results don't depend on its resolution.
"""
import math
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from progeo.helper.plan_meters import alignment_base_scale

# Longest side of the working copies - alignment runs its search on the
# smaller one (many distance transforms), the outlines need more detail.
ALIGN_SIZE = 900
LIMIT_SIZE = 1200
# Larger images are reduced to this many pixels before the masks are made.
MAX_PIXELS = 40_000_000

# Orange (OpenCV HSV: hue 0..179) - the dm bands / sensors of the CAD drawing,
# brand orange #eb633b (hue ~7) up to a yellowish orange (hue ~25).
ORANGE_HUE = (4, 25)
ORANGE_MIN_SATURATION = 100
ORANGE_MIN_VALUE = 120
# Orange specks smaller than this (working pixels) are noise, not lines.
ORANGE_MIN_AREA = 4
# Fewer orange pixels than this: nothing to align to.
ORANGE_MIN_PIXELS = 30

# Darker than this (grayscale) is a line of the drawing (walls, text, ...).
INK_GRAY = 200

# Gaps in the outline (doors, gates) up to this width are sealed before the
# inside is filled - fractions of the longest side, tried from small to large
# until every sensor lies inside an outline.
CLOSE_FRACTIONS = (0.006, 0.012, 0.02, 0.035)
# An outline spanning this share of both sides may be the drawing's frame:
# its largest inner region is paper, not a room, when it encloses other
# outlines with rooms (free space) of at least ENCLOSED_ROOMS of the frame's
# box - a hall of a tightly cropped building only encloses columns.
FRAME_SPAN = 0.9
ENCLOSED_ROOMS = 0.05
# Sensors outside every outline: clustered when closer than this (share of
# the longest side), each cluster gets its hull padded by CLUSTER_PAD.
CLUSTER_DISTANCE = 0.08
CLUSTER_PAD = 0.025

# Distances beyond this (working pixels) count no more - stray orange or a
# sensor without its line must not dominate the fit.
ALIGN_DISTANCE_CAP = 25.0
# The orange the sensors don't explain weighs less than sensors off orange
# (the plan may show leads or labels in orange too).
ALIGN_BACKWARD_WEIGHT = 0.5
# A sensor point this close to orange (share of the longest side) lies on it.
ALIGN_HIT_DISTANCE = 0.004
# At least this share of sensor points on orange: the alignment is a match.
ALIGN_MATCH_SCORE = 0.5
ALIGN_MAX_EVALS = 260
# Points sampled along a dm band.
LINE_SAMPLES = 12
BACKWARD_SAMPLES = 3000


class PlanDetectError(Exception):
    """Why the plan can't be read - the message is for the user."""


@dataclass
class PlanImage:
    """The masks of a plan image: lines of the drawing (ink) and orange, at
    full resolution (bool), and the size the wizard shows (EXIF rotation applied)."""

    ink: np.ndarray
    orange: np.ndarray
    size: tuple[int, int]

    def masks(self, longest: int) -> tuple[np.ndarray, np.ndarray]:
        """(ink, orange) as uint8 0/255, the longest side `longest` pixels."""
        width, height = self.size
        factor = min(1.0, longest / max(width, height))
        work = (max(1, round(width * factor)), max(1, round(height * factor)))

        def reduce(mask):
            if work == (mask.shape[1], mask.shape[0]):
                return mask.astype(np.uint8) * 255
            return np.where(cv2.resize(mask.astype(np.uint8) * 255, work, interpolation=cv2.INTER_AREA) > 0, 255, 0) \
                .astype(np.uint8)

        orange = reduce(self.orange)
        # Orange specks (antialiasing, text) are no lines.
        count, labels, stats, _ = cv2.connectedComponentsWithStats(orange, connectivity=8)
        small = [label for label in range(1, count) if stats[label, cv2.CC_STAT_AREA] < ORANGE_MIN_AREA]
        if small:
            orange[np.isin(labels, small)] = 0
        return reduce(self.ink), orange


def load_plan_image(path: str) -> PlanImage:
    try:
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source)
            if image.mode in ("RGBA", "LA", "P") or "transparency" in image.info:
                # Transparent parts are paper, not black.
                background = Image.new("RGBA", image.size, (255, 255, 255, 255))
                background.alpha_composite(image.convert("RGBA"))
                image = background
            image = image.convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise PlanDetectError("The Lageplan is no image that can be analysed (e.g. a PDF)") from exc
    size = image.size
    if size[0] * size[1] > MAX_PIXELS:
        factor = math.sqrt(MAX_PIXELS / (size[0] * size[1]))
        image = image.resize((max(1, int(size[0] * factor)), max(1, int(size[1] * factor))), Image.Resampling.BOX)
    rgb = np.asarray(image)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    hue, saturation, value = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    orange = (
        (hue >= ORANGE_HUE[0]) & (hue <= ORANGE_HUE[1])
        & (saturation >= ORANGE_MIN_SATURATION) & (value >= ORANGE_MIN_VALUE)
    )
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    ink = (gray < INK_GRAY) & ~orange
    return PlanImage(ink=ink, orange=orange, size=size)


# ----------------------------------------------------------------- alignment

@dataclass
class Alignment:
    offset_x: int
    offset_y: int
    scale_x: float
    scale_y: float
    flip_y: bool
    # Share of the sensor points lying on orange.
    score: float

    @property
    def matched(self) -> bool:
        return self.score >= ALIGN_MATCH_SCORE


def _segment_samples(segments) -> tuple[np.ndarray, list[tuple[int, int]]]:
    """Normalized points along the sensors (dm bands: LINE_SAMPLES each) and
    each sensor's range in them."""
    samples, ranges = [], []
    for start, end in segments:
        first = len(samples)
        if end is None:
            samples.append(start)
        else:
            for t in np.linspace(0, 1, LINE_SAMPLES):
                samples.append((start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t))
        ranges.append((first, len(samples)))
    return np.asarray(samples, dtype=float), ranges


def _pattern_search(cost, start, steps, min_steps, max_evals):
    """Minimizes `cost` by moving one parameter at a time (halving the steps
    when none helps) - few evaluations, no gradients needed."""
    best = np.asarray(start, dtype=float)
    best_cost = cost(best)
    steps = np.asarray(steps, dtype=float)
    min_steps = np.asarray(min_steps, dtype=float)
    evals = 1
    while evals < max_evals and np.any(steps > min_steps):
        improved = False
        for index in range(len(best)):
            if steps[index] <= min_steps[index]:
                continue
            for sign in (1, -1):
                trial = best.copy()
                trial[index] += sign * steps[index]
                trial_cost = cost(trial)
                evals += 1
                if trial_cost < best_cost:
                    best, best_cost, improved = trial, trial_cost, True
                    break
        if not improved:
            steps = steps / 2
    return best, best_cost


def auto_align(plan_image: PlanImage, segments, current: dict) -> Alignment:
    """The alignment laying the sensors - `segments`: [((nx, ny), (nx_end,
    ny_end) | None)] - onto the plan's orange lines. Starts from the extent of
    the orange and from `current` (offset_x, offset_y, scale_x, scale_y,
    flip_y), with and without the vertical flip, and keeps the best fit
    (symmetric chamfer distance, see ALIGN_*)."""
    if not segments:
        raise PlanDetectError("The plan has no measure points to align")
    _, orange = plan_image.masks(ALIGN_SIZE)
    height, width = orange.shape
    orange_ys, orange_xs = np.nonzero(orange)
    if len(orange_xs) < ORANGE_MIN_PIXELS:
        raise PlanDetectError("No orange lines found on the plan to align the measure points to")

    samples, ranges = _segment_samples(segments)
    # dm bands drawn from their first to their last sample, sensors as points.
    line_first = np.array([first for first, last in ranges if last - first > 1], dtype=int)
    line_last = np.array([last - 1 for first, last in ranges if last - first > 1], dtype=int)
    point_index = np.array([first for first, last in ranges if last - first == 1], dtype=int)
    # Distance of every pixel to the nearest orange one (zeros of the input).
    to_orange = cv2.distanceTransform(np.where(orange > 0, 0, 255).astype(np.uint8), cv2.DIST_L2, 3)
    rng = np.random.default_rng(0)
    pick = rng.choice(len(orange_xs), size=min(BACKWARD_SAMPLES, len(orange_xs)), replace=False)
    orange_points = (orange_xs[pick], orange_ys[pick])
    full_width, full_height = plan_image.size
    base = alignment_base_scale(full_width, full_height)

    def fit(flip):
        nx = samples[:, 0]
        v = 1 - samples[:, 1] if flip else samples[:, 1]
        # Parameters (cx, sx, cy, sy): x = cx + (nx - mid_x) * sx - the
        # middle as origin keeps the shift and the scale apart.
        n0, n1 = np.percentile(nx, [1, 99])
        v0, v1 = np.percentile(v, [1, 99])
        mid_x, mid_y = (n0 + n1) / 2, (v0 + v1) / 2

        def pixels(params):
            cx, sx, cy, sy = params
            return (cx + (nx - mid_x) * sx) * width, (cy + (v - mid_y) * sy) * height

        def cost(params):
            if params[1] <= 0 or params[3] <= 0:
                return math.inf
            xs, ys = pixels(params)
            inside = (xs >= 0) & (xs <= width - 1) & (ys >= 0) & (ys <= height - 1)
            forward = np.full(len(xs), ALIGN_DISTANCE_CAP)
            forward[inside] = np.minimum(
                to_orange[ys[inside].round().astype(int), xs[inside].round().astype(int)], ALIGN_DISTANCE_CAP
            )
            drawn = np.full((height, width), 255, np.uint8)
            if len(line_first):
                ends = np.stack(
                    [np.stack([xs[line_first], ys[line_first]], 1), np.stack([xs[line_last], ys[line_last]], 1)], 1
                )
                cv2.polylines(drawn, list(np.round(ends).astype(np.int32)), False, 0, 1)
            if len(point_index):
                px = np.clip(np.round(xs[point_index]).astype(int), 0, width - 1)
                py = np.clip(np.round(ys[point_index]).astype(int), 0, height - 1)
                drawn[py, px] = 0
            to_sensors = cv2.distanceTransform(drawn, cv2.DIST_L2, 3)
            backward = np.minimum(to_sensors[orange_points[1], orange_points[0]], ALIGN_DISTANCE_CAP)
            return forward.mean() + ALIGN_BACKWARD_WEIGHT * backward.mean()

        o_x0, o_x1 = np.percentile(orange_xs / width, [1, 99])
        o_y0, o_y1 = np.percentile(orange_ys / height, [1, 99])
        sx_extent = (o_x1 - o_x0) / (n1 - n0) if n1 - n0 > 0.02 else None
        sy_extent = (o_y1 - o_y0) / (v1 - v0) if v1 - v0 > 0.02 else None
        # One axis without extent (all sensors in a row): the same pixel scale.
        sx_extent = sx_extent or (sy_extent * height / width if sy_extent else 1.0)
        sy_extent = sy_extent or sx_extent * width / height
        starts = [((o_x0 + o_x1) / 2, sx_extent, (o_y0 + o_y1) / 2, sy_extent)]
        cur_sx, cur_sy = float(current.get("scale_x") or 1), float(current.get("scale_y") or 1)
        cur_ax = float(current.get("offset_x") or 0) / (full_width * base)
        cur_ay = float(current.get("offset_y") or 0) / (full_height * base)
        starts.append((cur_ax + mid_x * cur_sx, cur_sx, cur_ay + mid_y * cur_sy, cur_sy))

        results = []
        for start in starts:
            steps = (0.02, 0.05 * start[1], 0.02, 0.05 * start[3])
            min_steps = (0.25 / width, 2e-4 * start[1], 0.25 / height, 2e-4 * start[3])
            results.append(_pattern_search(cost, start, steps, min_steps, ALIGN_MAX_EVALS))
        params, best_cost = min(results, key=lambda result: result[1])
        xs, ys = pixels(params)
        inside = (xs >= 0) & (xs <= width - 1) & (ys >= 0) & (ys <= height - 1)
        hit = ALIGN_HIT_DISTANCE * max(width, height)
        on_orange = np.zeros(len(xs), bool)
        on_orange[inside] = to_orange[ys[inside].round().astype(int), xs[inside].round().astype(int)] <= hit
        cx, sx, cy, sy = params
        return best_cost, Alignment(
            offset_x=round((cx - mid_x * sx) * full_width * base),
            offset_y=round((cy - mid_y * sy) * full_height * base),
            scale_x=round(float(sx), 6),
            scale_y=round(float(sy), 6),
            flip_y=flip,
            score=round(float(on_orange.mean()), 3),
        )

    current_flip = bool(current.get("flip_y", True))
    return min((fit(flip) for flip in (current_flip, not current_flip)), key=lambda result: result[0])[1]


# ---------------------------------------------------------- heat limitations

@dataclass
class DetectedArea:
    name: str
    # Normalized to the image (0..1, y down) like ProgeoLageplan.heat_limitations.
    points: list[list[float]]
    sensors: int
    # "outline": a building drawn on the plan; "cluster": around sensors
    # outside every outline.
    kind: str


@dataclass
class Detection:
    areas: list[DetectedArea]
    sensors: int
    # Sensors inside no outline - covered by the cluster areas.
    clustered: int


def _encloses_rooms(region: np.ndarray, free: np.ndarray, box: int) -> bool:
    """Whether the holes of `region` (bool) hold free space of at least
    ENCLOSED_ROOMS of `box` pixels - other outlines with rooms."""
    mask = region.astype(np.uint8)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(mask)
    cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
    rooms = (filled == 1) & ~region & (free == 1)
    return int(rooms.sum()) >= ENCLOSED_ROOMS * box


def _footprints(ink: np.ndarray, kernel: int) -> np.ndarray:
    """Labels (int32, 0 = outside) of the drawing's closed outlines - walls
    and everything they enclose - with gaps up to `kernel` pixels sealed: the
    lines are thickened by half of it (a closing would only fill gaps as
    narrow as the lines), the inside found and shrunk back by as much.
    A frame around the whole drawing: its largest inner region is paper, not
    a room, and is left out (FRAME_SPAN, PAPER_SHARE)."""
    height, width = ink.shape
    disk = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel, kernel))
    thick = cv2.dilate(ink, disk)
    free = (thick == 0).astype(np.uint8)
    _, regions = cv2.connectedComponents(free, connectivity=4)
    edge = np.unique(np.concatenate([regions[0, :], regions[-1, :], regions[:, 0], regions[:, -1]]))
    # Everything but the paper reachable from the image's edge (region 0: the lines).
    inside = ~np.isin(regions, edge[edge > 0])

    count, outlines, stats, _ = cv2.connectedComponentsWithStats(inside.astype(np.uint8), connectivity=8)
    for label in range(1, count):
        if stats[label, cv2.CC_STAT_WIDTH] < FRAME_SPAN * width or stats[label, cv2.CC_STAT_HEIGHT] < FRAME_SPAN * height:
            continue
        within = regions[(outlines == label) & (free == 1)]
        if not len(within):
            continue
        sizes = np.bincount(within)
        largest = int(sizes.argmax())
        box = stats[label, cv2.CC_STAT_WIDTH] * stats[label, cv2.CC_STAT_HEIGHT]
        if _encloses_rooms(regions == largest, free, box):
            inside[regions == largest] = False
    inside = cv2.erode(inside.astype(np.uint8), disk, borderValue=0)
    _, outlines = cv2.connectedComponents(inside, connectivity=8)
    return outlines


def _polygon(mask: np.ndarray, max_points: int) -> np.ndarray | None:
    """The outer outline of `mask` (uint8) as at most max_points corners."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    epsilon = 0.002 * cv2.arcLength(contour, True)
    polygon = cv2.approxPolyDP(contour, epsilon, True)
    while len(polygon) > max_points:
        epsilon *= 1.5
        polygon = cv2.approxPolyDP(contour, epsilon, True)
    return polygon.reshape(-1, 2) if len(polygon) >= 3 else None


def _holds(polygon: np.ndarray, point) -> bool:
    return cv2.pointPolygonTest(polygon.astype(np.float32), (float(point[0]), float(point[1])), False) >= 0


def _clusters(points: np.ndarray, distance: float) -> list[list[int]]:
    """Indices of `points` grouped by single linkage (closer than `distance`)."""
    parent = list(range(len(points)))

    def root(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for a in range(len(points) - 1):
        near = np.nonzero(np.hypot(*(points[a + 1:] - points[a]).T) < distance)[0] + a + 1
        for b in near:
            parent[root(a)] = root(int(b))
    groups: dict[int, list[int]] = {}
    for index in range(len(points)):
        groups.setdefault(root(index), []).append(index)
    return list(groups.values())


def detect_heat_limitations(plan_image: PlanImage, sensors: list[list[tuple[float, float]]],
                            max_points: int = 200) -> Detection:
    """Areas for the heat limitations: the outlines (closed walls) on the plan
    holding sensors - `sensors`: per sensor its points as fractions of the
    image (a dm band: several along it) - each outline at most once, each
    with at least one sensor inside. Sensors outside every outline are
    clustered, each cluster gets the padded hull of its points."""
    ink, _ = plan_image.masks(LIMIT_SIZE)
    height, width = ink.shape
    scale = np.array([width - 1, height - 1], dtype=float)
    on_plan = [
        np.clip(np.round(np.asarray(points, dtype=float) * scale), 0, scale).astype(int)
        for points in sensors
        if len(points) and all(0 <= x <= 1 and 0 <= y <= 1 for x, y in points)
    ]
    if not on_plan:
        raise PlanDetectError("No measure point lies on the plan - align them first (step 5)")
    # Where a sensor is: the middle of its points.
    anchors = np.array([points[len(points) // 2] for points in on_plan])

    best = None
    for fraction in CLOSE_FRACTIONS:
        kernel = max(3, round(fraction * max(width, height)) | 1)
        outlines = _footprints(ink, kernel)
        labels = outlines[anchors[:, 1], anchors[:, 0]]
        covered = int((labels > 0).sum())
        if best is None or covered > best[1]:
            best = (outlines, covered)
        if covered == len(anchors):
            break
    outlines, _ = best

    areas: list[DetectedArea] = []
    covered = np.zeros(len(anchors), bool)
    labels = outlines[anchors[:, 1], anchors[:, 0]]
    for label in sorted(set(labels.tolist()) - {0}):
        polygon = _polygon(((outlines == label) * 255).astype(np.uint8), max_points)
        if polygon is None:
            continue
        inside = [index for index in np.nonzero(labels == label)[0] if _holds(polygon, anchors[index])]
        # No empty areas: an outline only with a sensor inside its polygon.
        if not inside:
            continue
        covered[inside] = True
        areas.append(DetectedArea("", (polygon / scale).round(5).tolist(), len(inside), "outline"))

    rest = np.nonzero(~covered)[0]
    longest = max(width, height)
    for group in _clusters(anchors[rest], CLUSTER_DISTANCE * longest) if len(rest) else []:
        members = rest[group]
        points = np.concatenate([on_plan[index] for index in members]).astype(np.int32)
        mask = np.zeros((height, width), np.uint8)
        cv2.fillPoly(mask, [cv2.convexHull(points)], 255)
        pad = max(2, round(CLUSTER_PAD * longest))
        mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * pad + 1, 2 * pad + 1)))
        polygon = _polygon(mask, max_points)
        if polygon is not None:
            areas.append(DetectedArea("", (polygon / scale).clip(0, 1).round(5).tolist(), len(members), "cluster"))

    for number, area in enumerate(areas, start=1):
        area.name = f"Auto {number}" if area.kind == "outline" else f"Auto {number} (sensors)"
    return Detection(areas=areas, sensors=len(anchors), clustered=len(rest))
