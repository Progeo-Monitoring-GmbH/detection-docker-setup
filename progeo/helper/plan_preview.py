"""Preview images of the automatic plan functions (auto_lageplans command):
the Lageplan with the measure points before (red) and after the auto
alignment (blue), the heat limitations (green outline, the plan dimmed
outside them), the dm bands the project type detection found (violet), the
tables (amber) and a header saying what was found and done.

Positions come as fractions of the image (0..1, y down), like the heat
limitations and plan_detect.sensor_fractions.
"""
from PIL import Image, ImageDraw, ImageFont, ImageOps

MAX_SIZE = 1600
BEFORE = (208, 59, 59, 255)
AFTER = (31, 98, 163, 255)
AREA = (12, 163, 12, 255)
DM_BAND = (149, 119, 179, 255)
TABLE = (230, 160, 0, 255)
OUTSIDE_SHADE = 90  # alpha of the dimming outside the areas


def _font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1: no sizes
        return ImageFont.load_default()


def _plan(path):
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGBA")
    background = Image.new("RGBA", image.size, (255, 255, 255, 255))
    background.alpha_composite(image)
    background.thumbnail((MAX_SIZE, MAX_SIZE), Image.Resampling.LANCZOS)
    return background


def _draw_sensors(draw, sensors, size, color, width):
    w, h = size
    for points in sensors or []:
        pixels = [(x * w, y * h) for x, y in points]
        if len(pixels) == 1:
            x, y = pixels[0]
            radius = width + 2
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)
        else:
            draw.line(pixels, fill=color, width=width)


def render_preview(path, before=None, after=None, areas=None, lines=(), outlines=None, tables=None):
    """The preview as an RGB image. `before` / `after`: per sensor its points
    (fractions); `areas`: [{"name", "points"}]; `outlines`: closed shapes
    (fractions) - the dm bands found; `tables`: [((left, top, right,
    bottom), label)] (fractions); `lines`: the header text."""
    image = _plan(path)
    size = image.size
    w, h = size

    if areas:
        # Dim everything, then cut the areas out of the dimming.
        shade = Image.new("L", size, OUTSIDE_SHADE)
        mask = ImageDraw.Draw(shade)
        for area in areas:
            mask.polygon([(x * w, y * h) for x, y in area["points"]], fill=0)
        dim = Image.new("RGBA", size, (0, 0, 0, 0))
        dim.putalpha(shade)  # black, as opaque as the shade
        image.alpha_composite(dim)

    draw = ImageDraw.Draw(image)
    label_font = _font(15)
    for area in areas or []:
        pixels = [(x * w, y * h) for x, y in area["points"]]
        draw.line([*pixels, pixels[0]], fill=AREA, width=3)
        if area.get("name"):
            cx = sum(x for x, _ in pixels) / len(pixels)
            cy = sum(y for _, y in pixels) / len(pixels)
            draw.text((cx, cy), area["name"], fill=AREA, font=label_font, anchor="mm", stroke_width=3,
                      stroke_fill=(255, 255, 255, 255))

    for outline in outlines or []:
        pixels = [(x * w, y * h) for x, y in outline]
        if len(pixels) >= 2:
            draw.line([*pixels, pixels[0]], fill=DM_BAND, width=2)

    for (left, top, right, bottom), label in tables or []:
        draw.rectangle((left * w, top * h, right * w, bottom * h), outline=TABLE, width=3)
        draw.text((left * w + 4, bottom * h + 4), label, fill=TABLE, font=label_font, stroke_width=3,
                  stroke_fill=(255, 255, 255, 255))

    _draw_sensors(draw, before, size, BEFORE, 2)
    _draw_sensors(draw, after, size, AFTER, 4)

    if lines:
        font = _font(16)
        line_height = 22
        width = max(draw.textlength(line, font=font) for line in lines) + 24
        height = line_height * len(lines) + 16
        header = Image.new("RGBA", size, (0, 0, 0, 0))
        ImageDraw.Draw(header).rounded_rectangle((8, 8, 8 + width, 8 + height), radius=10, fill=(255, 255, 255, 225))
        image.alpha_composite(header)
        draw = ImageDraw.Draw(image)
        for index, line in enumerate(lines):
            draw.text((20, 16 + index * line_height), line, fill=(30, 30, 30, 255), font=font)
    return image.convert("RGB")
