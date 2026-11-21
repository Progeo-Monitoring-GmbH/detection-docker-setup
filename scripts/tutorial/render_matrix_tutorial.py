"""Low-poly tutorial animations for the ProGeo chat setup dialog
(frontend/src/main/MatrixSetupModal.tsx): one short, looping, text-free clip
per step - so they work in every portal language.

    1  install   the app drops onto the phone
    2  scan      the phone scans the QR code on the screen and signs in
    3  test      the portal sends a test message, the phone rings

Rendered with OpenCV (flat-shaded triangles on a supersampled canvas) and
encoded with ffmpeg to WebM (VP9) + MP4 (H.264) + a PNG poster each, into
frontend/public/assets/tutorial/ (served as /assets/tutorial/...).

Usage (from the repository root, with the backend's venv: numpy + opencv):

    python scripts/tutorial/render_matrix_tutorial.py              # all steps
    python scripts/tutorial/render_matrix_tutorial.py --step 2     # one step
    python scripts/tutorial/render_matrix_tutorial.py --preview    # contact sheets only, no ffmpeg
    python scripts/tutorial/render_matrix_tutorial.py --size 960x600 --fps 30

Iterate on the look in the constants (PALETTE, sizes) and the scene_* functions:
every scene is a pure function of the time t (seconds) that draws onto a
canvas, so --preview shows a change in a second.
"""
import argparse
import math
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "frontend" / "public" / "assets" / "tutorial"
SUPERSAMPLE = 2  # draw at 2x, then downscale: smooth edges without slow AA polygons


def hex_bgr(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    r, g, b = (int(value[i:i + 2], 16) for i in (0, 2, 4))
    return b, g, r


# Portal tokens (--progeo-blue, page, panel) plus a success green and a
# signal orange - the same in light and dark mode, the clip brings its own background.
PALETTE = {
    "bg_top": hex_bgr("#dfe7ef"),
    "bg_bottom": hex_bgr("#c7d4e1"),
    "blue": hex_bgr("#0b3659"),
    "blue_mid": hex_bgr("#1d5687"),
    "blue_light": hex_bgr("#4f86b8"),
    "panel": hex_bgr("#f3f1f0"),
    "screen": hex_bgr("#eef3f7"),
    "dark": hex_bgr("#1b2430"),
    "green": hex_bgr("#2fa36b"),
    "orange": hex_bgr("#f0a030"),
    "white": (250, 250, 250),
}

# One clip per step: (name, seconds, scene function name).
STEPS = {
    1: ("matrix-step-1-install", 4.8, "scene_install"),
    2: ("matrix-step-2-scan", 5.6, "scene_scan"),
    3: ("matrix-step-3-test", 5.0, "scene_test"),
}


# ---------------------------------------------------------------------------- easing

def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def phase(t, start, end):
    """0..1 progress of t within [start, end]."""
    return clamp((t - start) / (end - start)) if end > start else float(t >= start)


def ease_out(x):
    return 1 - (1 - x) ** 3


def ease_in_out(x):
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def back_out(x, overshoot=1.7):
    x -= 1
    return 1 + (overshoot + 1) * x ** 3 + overshoot * x ** 2


def mix(a, b, x):
    return tuple(round(av + (bv - av) * x) for av, bv in zip(a, b))


def shade(color, factor):
    return tuple(int(clamp(c * factor, 0, 255)) for c in color)


# ---------------------------------------------------------------------------- canvas

class Canvas:
    """Draws in output coordinates (w x h) onto a SUPERSAMPLE-times larger image."""

    def __init__(self, width, height):
        self.w, self.h = width, height
        self.s = SUPERSAMPLE
        self.img = np.zeros((height * self.s, width * self.s, 3), np.uint8)
        self.light = np.array([-0.55, -0.85])  # light from the upper left
        self.light /= np.linalg.norm(self.light)

    def _pts(self, points):
        return np.round(np.asarray(points, np.float64) * self.s).astype(np.int32)

    def tri(self, points, color):
        cv2.fillConvexPoly(self.img, self._pts(points), color, lineType=cv2.LINE_8)

    def poly(self, points, color):
        cv2.fillPoly(self.img, [self._pts(points)], color, lineType=cv2.LINE_8)

    def faceted(self, points, color, strength=0.16, seed=0):
        """The low-poly look: the polygon fanned from its centroid, every
        facet shaded by its direction to the light plus a little noise."""
        points = np.asarray(points, np.float64)
        center = points.mean(axis=0)
        rng = np.random.default_rng(seed)
        count = len(points)
        for index in range(count):
            a, b = points[index], points[(index + 1) % count]
            mid = (a + b) / 2 - center
            norm = np.linalg.norm(mid)
            facing = float(np.dot(mid / norm, -self.light)) if norm else 0.0
            factor = 1 + strength * facing + rng.uniform(-0.04, 0.04)
            self.tri([center, a, b], shade(color, factor))

    def rect(self, x, y, w, h, color, chamfer=0.0, faceted=False, seed=0, strength=0.16):
        c = min(chamfer, w / 2, h / 2)
        points = [(x + c, y), (x + w - c, y), (x + w, y + c), (x + w, y + h - c),
                  (x + w - c, y + h), (x + c, y + h), (x, y + h - c), (x, y + c)] if c else \
            [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
        if faceted:
            self.faceted(points, color, strength=strength, seed=seed)
        else:
            self.poly(points, color)

    def ngon(self, cx, cy, radius, sides, color, rotation=0.0, faceted=True, seed=0, strength=0.2):
        points = [(cx + radius * math.cos(rotation + 2 * math.pi * i / sides),
                   cy + radius * math.sin(rotation + 2 * math.pi * i / sides)) for i in range(sides)]
        if faceted:
            self.faceted(points, color, strength=strength, seed=seed)
        else:
            self.poly(points, color)

    def line(self, a, b, color, width):
        cv2.line(self.img, tuple(self._pts([a])[0]), tuple(self._pts([b])[0]), color,
                 max(1, int(width * self.s)), lineType=cv2.LINE_AA)

    def blend(self, other, alpha):
        """Mix another canvas over this one (fades)."""
        cv2.addWeighted(other.img, alpha, self.img, 1 - alpha, 0, dst=self.img)

    def frame(self):
        return cv2.resize(self.img, (self.w, self.h), interpolation=cv2.INTER_AREA)


# ---------------------------------------------------------------------------- background

class Background:
    """A slowly breathing low-poly mesh: jittered grid points, Delaunay
    triangles, each colored from a vertical gradient plus noise."""

    def __init__(self, width, height, seed=7, cell=70):
        rng = np.random.default_rng(seed)
        xs = np.arange(-cell, width + 2 * cell, cell)
        ys = np.arange(-cell, height + 2 * cell, cell)
        grid = np.array([(x, y) for y in ys for x in xs], np.float64)
        jitter = rng.uniform(-0.38, 0.38, grid.shape) * cell
        self.base = grid + jitter
        self.phase = rng.uniform(0, 2 * math.pi, len(grid))
        self.noise = rng.uniform(-0.035, 0.035, 4 * len(grid))
        # Subdiv2D wants a rectangle with a non-negative origin: triangulate shifted by `offset`.
        offset = 3 * cell
        subdiv = cv2.Subdiv2D((0, 0, int(width + 2 * offset), int(height + 2 * offset)))
        for point in self.base:
            subdiv.insert((float(point[0] + offset), float(point[1] + offset)))
        # getTriangleList returns float32 corners: map each back to the nearest
        # inserted point (Subdiv2D's own far-away helper vertices match none).
        shifted = self.base + offset
        self.triangles = []
        for corners in subdiv.getTriangleList().reshape(-1, 3, 2):
            indices = []
            for corner in corners:
                distances = np.hypot(*(shifted - corner).T)
                nearest = int(np.argmin(distances))
                if distances[nearest] > 0.5:
                    break
                indices.append(nearest)
            if len(indices) == 3:
                self.triangles.append(indices)
        self.height = height

    def draw(self, canvas, t):
        wobble = np.stack([np.cos(self.phase + t * 0.9), np.sin(self.phase + t * 0.7)], axis=1) * 6
        points = self.base + wobble
        for index, (a, b, c) in enumerate(self.triangles):
            tri = points[[a, b, c]]
            y = clamp(tri[:, 1].mean() / self.height)
            color = mix(PALETTE["bg_top"], PALETTE["bg_bottom"], y)
            canvas.tri(tri, shade(color, 1 + self.noise[index % len(self.noise)]))


# ---------------------------------------------------------------------------- props

def phone(canvas, cx, cy, scale=1.0, tilt=0.0, screen=None, t=0.0):
    """A faceted phone; `screen(canvas, x, y, w, h, t)` draws its content."""
    w, h = 150 * scale, 290 * scale
    x, y = cx - w / 2, cy - h / 2 + tilt
    canvas.rect(x + 8 * scale, y + 10 * scale, w, h, shade(PALETTE["bg_bottom"], 0.82), chamfer=26 * scale)  # shadow
    canvas.rect(x, y, w, h, PALETTE["dark"], chamfer=26 * scale, faceted=True, seed=3, strength=0.35)
    sx, sy, sw, sh = x + 10 * scale, y + 30 * scale, w - 20 * scale, h - 52 * scale
    canvas.rect(sx, sy, sw, sh, PALETTE["screen"], chamfer=8 * scale)
    canvas.rect(cx - 22 * scale, y + 12 * scale, 44 * scale, 8 * scale, shade(PALETTE["dark"], 1.6), chamfer=4 * scale)
    if screen:
        screen(canvas, sx, sy, sw, sh, t)
    return sx, sy, sw, sh


def laptop(canvas, cx, cy, scale=1.0, screen=None, t=0.0):
    w, h = 300 * scale, 190 * scale
    x, y = cx - w / 2, cy - h / 2
    canvas.rect(x + 10 * scale, y + 14 * scale, w, h, shade(PALETTE["bg_bottom"], 0.84), chamfer=12 * scale)
    canvas.rect(x, y, w, h, PALETTE["dark"], chamfer=12 * scale, faceted=True, seed=11, strength=0.3)
    sx, sy, sw, sh = x + 12 * scale, y + 12 * scale, w - 24 * scale, h - 24 * scale
    canvas.rect(sx, sy, sw, sh, PALETTE["panel"], chamfer=4 * scale)
    base = [(x - 30 * scale, y + h), (x + w + 30 * scale, y + h), (x + w + 10 * scale, y + h + 18 * scale),
            (x - 10 * scale, y + h + 18 * scale)]
    canvas.faceted(base, shade(PALETTE["dark"], 1.35), strength=0.3, seed=12)
    if screen:
        screen(canvas, sx, sy, sw, sh, t)
    return sx, sy, sw, sh


def chat_icon(canvas, cx, cy, size, color=None, seed=5):
    """A generic chat app icon: faceted rounded square with a speech bubble."""
    color = color or PALETTE["blue_mid"]
    canvas.rect(cx - size / 2, cy - size / 2, size, size, color, chamfer=size * 0.24, faceted=True, seed=seed,
                strength=0.3)
    bubble = [(cx - size * 0.28, cy - size * 0.2), (cx + size * 0.28, cy - size * 0.2),
              (cx + size * 0.28, cy + size * 0.12), (cx - size * 0.02, cy + size * 0.12),
              (cx - size * 0.2, cy + size * 0.28), (cx - size * 0.16, cy + size * 0.12),
              (cx - size * 0.28, cy + size * 0.12)]
    canvas.poly(bubble, PALETTE["white"])
    for dx in (-0.14, 0, 0.14):
        canvas.ngon(cx + dx * size, cy - size * 0.04, size * 0.04, 6, color, faceted=False)


def check_badge(canvas, cx, cy, radius, progress=1.0):
    if progress <= 0:
        return
    r = radius * back_out(progress)
    canvas.ngon(cx, cy, r, 10, PALETTE["green"], rotation=math.pi / 10, seed=21, strength=0.25)
    tick = [(cx - r * 0.45, cy + r * 0.02), (cx - r * 0.12, cy + r * 0.34), (cx + r * 0.5, cy - r * 0.32)]
    drawn = clamp(progress * 1.4)
    if drawn > 0:
        canvas.line(tick[0], tick[1], PALETTE["white"], max(2, r * 0.17))
        end = (tick[1][0] + (tick[2][0] - tick[1][0]) * drawn, tick[1][1] + (tick[2][1] - tick[1][1]) * drawn)
        canvas.line(tick[1], end, PALETTE["white"], max(2, r * 0.17))


def qr_pattern(seed=4, size=21):
    rng = np.random.default_rng(seed)
    cells = rng.random((size, size)) > 0.52
    for ox, oy in ((0, 0), (size - 7, 0), (0, size - 7)):
        cells[oy:oy + 7, ox:ox + 7] = False
        cells[oy, ox:ox + 7] = cells[oy + 6, ox:ox + 7] = True
        cells[oy:oy + 7, ox] = cells[oy:oy + 7, ox + 6] = True
        cells[oy + 2:oy + 5, ox + 2:ox + 5] = True
    return cells


QR = qr_pattern()


def draw_qr(canvas, x, y, size, color=None, reveal=1.0):
    color = color or PALETTE["blue"]
    n = QR.shape[0]
    cell = size / n
    canvas.rect(x - cell, y - cell, size + 2 * cell, size + 2 * cell, PALETTE["white"])
    for row in range(n):
        for col in range(n):
            if QR[row, col] and (row + col) / (2 * n) <= reveal:
                canvas.rect(x + col * cell, y + row * cell, cell * 0.96, cell * 0.96, color)


def bubble(canvas, x, y, w, h, color, tail_left=True):
    canvas.rect(x, y, w, h, color, chamfer=h * 0.3, faceted=True, seed=int(x + y), strength=0.12)
    tail = [(x + 10, y + h - 2), (x + 2, y + h + 8), (x + 22, y + h - 2)] if tail_left else \
        [(x + w - 10, y + h - 2), (x + w - 2, y + h + 8), (x + w - 22, y + h - 2)]
    canvas.poly(tail, color)


def text_lines(canvas, x, y, w, color, lines=2, gap=9, height=4):
    for index in range(lines):
        canvas.rect(x, y + index * gap, w * (1 - 0.3 * (index == lines - 1)), height, color, chamfer=2)


# ---------------------------------------------------------------------------- scenes

def scene_install(canvas, t, duration):
    """The app falls from above onto the phone, fills a progress bar and lands as an icon."""
    cx, cy = canvas.w * 0.5, canvas.h * 0.52
    slide = ease_out(phase(t, 0.0, 0.7))
    drop = phase(t, 0.8, 2.3)
    pop = phase(t, 2.4, 2.9)
    done = phase(t, 3.2, 3.6)

    def screen(c, x, y, w, h, tt):
        # Home screen grid of faceted app tiles.
        size, gap = w * 0.2, w * 0.07
        start_x = x + (w - 3 * size - 2 * gap) / 2
        for row in range(4):
            for col in range(3):
                if row == 1 and col == 1:
                    continue
                tile = shade(PALETTE["blue_light"], 1.25 + 0.06 * ((row * 3 + col) % 3))
                c.rect(start_x + col * (size + gap), y + 22 + row * (size + gap), size, size, tile,
                       chamfer=size * 0.25, faceted=True, seed=row * 3 + col, strength=0.12)
        slot_x = start_x + size + gap + size / 2
        slot_y = y + 22 + size + gap + size / 2
        if pop > 0:
            chat_icon(c, slot_x, slot_y, size * back_out(pop))
        elif drop > 0:
            # Progress bar while it downloads.
            bar_w = w * 0.62
            c.rect(x + (w - bar_w) / 2, y + h - 40, bar_w, 8, shade(PALETTE["screen"], 0.86), chamfer=4)
            c.rect(x + (w - bar_w) / 2, y + h - 40, bar_w * ease_in_out(drop), 8, PALETTE["green"], chamfer=4)

    phone(canvas, cx, cy + (1 - slide) * canvas.h, scale=1.0, screen=screen, t=t)
    if 0 < drop < 1:
        # The icon falls from the sky in steps, with a downward arrow.
        icon_y = canvas.h * 0.05 + (cy - canvas.h * 0.12) * ease_in_out(drop)
        size = 70 * (1 - 0.45 * drop)
        chat_icon(canvas, cx, icon_y, size)
        for offset in range(3):
            alpha_y = icon_y + size * 0.75 + offset * 16 + (t * 60) % 16
            arrow = [(cx - 10, alpha_y), (cx + 10, alpha_y), (cx, alpha_y + 10)]
            canvas.poly(arrow, mix(PALETTE["green"], PALETTE["bg_top"], offset / 3))
    check_badge(canvas, cx + 62, cy - 120, 26, done)


def scene_scan(canvas, t, duration):
    """The phone moves in front of the laptop's QR code, scans it, and the chat opens."""
    lx, ly = canvas.w * 0.36, canvas.h * 0.5
    reveal = ease_out(phase(t, 0.0, 0.8))
    move = ease_in_out(phase(t, 0.6, 1.8))
    scan = phase(t, 1.9, 3.1)
    success = phase(t, 3.1, 3.5)
    chat = phase(t, 3.6, 4.4)

    def laptop_screen(c, x, y, w, h, tt):
        size = h * 0.72
        draw_qr(c, x + (w - size) / 2, y + (h - size) / 2, size, reveal=reveal)
        if success > 0:
            check_badge(c, x + w - 26, y + 26, 16, success)

    laptop(canvas, lx, ly, scale=1.0, screen=laptop_screen, t=t)

    px = canvas.w * 1.1 + (canvas.w * 0.72 - canvas.w * 1.1) * move
    py = canvas.h * 0.53 - 12 * math.sin(move * math.pi)

    def phone_screen(c, x, y, w, h, tt):
        if chat > 0 or success >= 1:
            # Signed in: the chat list.
            for index in range(4):
                row_y = y + 18 + index * 44
                appear = clamp(chat * 4 - index)
                if appear <= 0:
                    continue
                c.ngon(x + 24, row_y + 14, 12 * appear, 7, shade(PALETTE["blue_light"], 1 + 0.08 * index),
                       seed=index)
                text_lines(c, x + 44, row_y + 6, (w - 60) * appear, shade(PALETTE["screen"], 0.78))
            return
        # Camera view: dark, the QR in it, corner marks and a sweeping line.
        c.rect(x, y, w, h, shade(PALETTE["dark"], 1.25))
        size = w * 0.66
        qx, qy = x + (w - size) / 2, y + (h - size) / 2
        draw_qr(c, qx, qy, size, color=shade(PALETTE["blue"], 1.4))
        mark = PALETTE["green"] if success > 0 else PALETTE["white"]
        for mx, my, dx, dy in ((qx - 8, qy - 8, 1, 1), (qx + size + 8, qy - 8, -1, 1),
                               (qx - 8, qy + size + 8, 1, -1), (qx + size + 8, qy + size + 8, -1, -1)):
            c.line((mx, my), (mx + 18 * dx, my), mark, 3)
            c.line((mx, my), (mx, my + 18 * dy), mark, 3)
        if 0 < scan < 1:
            line_y = qy + size * (0.5 - 0.5 * math.cos(scan * 2 * math.pi))
            c.line((qx - 4, line_y), (qx + size + 4, line_y), PALETTE["green"], 3)

    phone(canvas, px, py, scale=0.92, screen=phone_screen, t=t)
    if chat > 0:
        check_badge(canvas, px + 58, py - 112, 24, chat)


def scene_test(canvas, t, duration):
    """The portal sends a test message: a paper plane flies to the phone, which rings."""
    lx, ly = canvas.w * 0.28, canvas.h * 0.5
    press = phase(t, 0.5, 0.8)
    fly = phase(t, 0.9, 2.1)
    ring = phase(t, 2.1, 3.0)
    message = ease_out(phase(t, 2.3, 2.9))
    done = phase(t, 3.3, 3.7)

    def laptop_screen(c, x, y, w, h, tt):
        text_lines(c, x + 20, y + 20, w * 0.6, shade(PALETTE["panel"], 0.82), lines=3)
        button = shade(PALETTE["blue_mid"], 0.8 if 0 < press < 1 else 1.0)
        c.rect(x + w * 0.3, y + h * 0.62, w * 0.4, h * 0.2, button, chamfer=h * 0.1, faceted=True, seed=8)
        plane = [(x + w * 0.44, y + h * 0.66), (x + w * 0.58, y + h * 0.72), (x + w * 0.44, y + h * 0.78),
                 (x + w * 0.47, y + h * 0.72)]
        c.poly(plane, PALETTE["white"])

    laptop(canvas, lx, ly, scale=0.82, screen=laptop_screen, t=t)

    px, py = canvas.w * 0.74, canvas.h * 0.52
    wiggle = math.sin(ring * math.pi * 8) * 5 * (1 - ring) if 0 < ring < 1 else 0

    def phone_screen(c, x, y, w, h, tt):
        c.rect(x, y, w, 30, shade(PALETTE["blue"], 1.2))
        c.ngon(x + 18, y + 15, 9, 7, PALETTE["blue_light"], seed=2)
        text_lines(c, x + 34, y + 10, w * 0.4, PALETTE["screen"], lines=1, height=6)
        bubble(c, x + 10, y + 46, w * 0.62, 34, PALETTE["white"])
        text_lines(c, x + 20, y + 56, w * 0.48, shade(PALETTE["screen"], 0.75))
        if message > 0:
            bw = w * 0.72 * message
            bubble(c, x + 10, y + 96, bw, 46, PALETTE["green"])
            if message > 0.7:
                text_lines(c, x + 20, y + 106, bw - 24, shade(PALETTE["green"], 1.45), lines=3)

    phone(canvas, px + wiggle, py, scale=0.95, screen=phone_screen, t=t)

    if 0 < ring < 1:
        # The bell above the phone.
        bx, by = px + 70, py - 150
        swing = math.sin(ring * math.pi * 10) * 0.35
        bell = [(bx - 18, by + 16), (bx - 14, by - 6), (bx, by - 18), (bx + 14, by - 6), (bx + 18, by + 16)]
        rotated = [(bx + (x - bx) * math.cos(swing) - (y - by) * math.sin(swing),
                    by + (x - bx) * math.sin(swing) + (y - by) * math.cos(swing)) for x, y in bell]
        canvas.faceted(rotated, PALETTE["orange"], strength=0.3, seed=31)
        canvas.ngon(bx, by + 20, 5, 6, PALETTE["orange"], faceted=False)
    if 0 < fly < 1:
        # Paper plane on an arc from the laptop to the phone.
        ex = lx + (px - lx) * ease_in_out(fly)
        ey = ly - 30 - math.sin(fly * math.pi) * 120 + (py - ly) * fly
        angle = math.atan2(-math.cos(fly * math.pi) * 120 * math.pi, px - lx)
        size = 22
        shape = [(size, 0), (-size, -size * 0.7), (-size * 0.45, 0), (-size, size * 0.7)]
        points = [(ex + x * math.cos(angle) - y * math.sin(angle), ey + x * math.sin(angle) + y * math.cos(angle))
                  for x, y in shape]
        canvas.faceted(points, PALETTE["blue_mid"], strength=0.4, seed=41)
    check_badge(canvas, px + 60, py - 118, 24, done)


# ---------------------------------------------------------------------------- rendering

def render_frames(step, width, height, fps):
    _name, duration, scene_name = STEPS[step]
    scene = globals()[scene_name]
    background = Background(width, height, seed=step * 13)
    count = round(duration * fps)
    fade = 0.35  # seconds of fade at both ends - the clip loops seamlessly
    for index in range(count):
        t = index / fps
        canvas = Canvas(width, height)
        background.draw(canvas, t)
        plain = canvas.img.copy()
        scene(canvas, t, duration)
        edge = min(t, duration - t)
        if edge < fade:
            cv2.addWeighted(canvas.img, edge / fade, plain, 1 - edge / fade, 0, dst=canvas.img)
        yield canvas.frame()


def encode(frames, out_base, width, height, fps):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        sys.exit("ffmpeg not found on PATH - use --preview, or install ffmpeg")
    frames = list(frames)
    poster = frames[int(len(frames) * 0.72)]
    cv2.imwrite(str(out_base.with_suffix(".png")), poster)
    raw = ["-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}", "-r", str(fps), "-i", "-"]
    targets = [
        (out_base.with_suffix(".webm"), ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "36", "-row-mt", "1",
                                         "-pix_fmt", "yuv420p", "-an"]),
        (out_base.with_suffix(".mp4"), ["-c:v", "libx264", "-preset", "slow", "-crf", "26", "-pix_fmt", "yuv420p",
                                        "-movflags", "+faststart", "-an"]),
    ]
    for path, codec in targets:
        process = subprocess.Popen([ffmpeg, "-y", "-loglevel", "error", *raw, *codec, str(path)],
                                   stdin=subprocess.PIPE)
        for frame in frames:
            process.stdin.write(frame.tobytes())
        process.stdin.close()
        if process.wait() != 0:
            sys.exit(f"ffmpeg failed for {path.name}")
        print(f"  {path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} KB")


def contact_sheet(frames, out_path, columns=6):
    frames = list(frames)
    picks = [frames[int(i * (len(frames) - 1) / (columns - 1))] for i in range(columns)]
    small = [cv2.resize(frame, (frame.shape[1] // 2, frame.shape[0] // 2), interpolation=cv2.INTER_AREA)
             for frame in picks]
    cv2.imwrite(str(out_path), np.hstack(small))
    print(f"  {out_path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--step", type=int, choices=sorted(STEPS), help="Only this step (default: all).")
    parser.add_argument("--size", default="720x450", help="Output size WxH (default 720x450).")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--preview", action="store_true",
                        help="Only a contact sheet per step (<out>/preview-<name>.png), no video.")
    args = parser.parse_args()
    width, height = (int(value) for value in args.size.lower().split("x"))
    args.out.mkdir(parents=True, exist_ok=True)
    for step in ([args.step] if args.step else sorted(STEPS)):
        name = STEPS[step][0]
        print(f"step {step}: {name}")
        frames = render_frames(step, width, height, args.fps)
        if args.preview:
            contact_sheet(frames, args.out / f"preview-{name}.png")
        else:
            encode(frames, args.out / name, width, height, args.fps)


if __name__ == "__main__":
    main()
