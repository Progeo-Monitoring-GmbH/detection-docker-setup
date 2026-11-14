"""Grouping Lageplans that look (basically) the same into categories - the
auto_lageplans command (--categories): many plans are copies of a few
drawings, and which project type such a category gets is decided by hand
afterwards (--category-type).

  - image_signature: a difference hash of the plan - the image shrunk to
    17 x 16 gray pixels, one bit per pair of neighbours (brighter or not):
    256 bits that stay alike under scaling, compression and small edits;
  - group: plans whose signatures differ in at most MAX_DISTANCE bits are
    one category (single linkage);
  - category_id: a stable name for a category - from its first plan;
  - contact_sheet: thumbnails of a category's plans in one image.
"""
from PIL import Image, ImageDraw, ImageFont, ImageOps

SIGNATURE_SIZE = (17, 16)
SIGNATURE_BITS = (SIGNATURE_SIZE[0] - 1) * SIGNATURE_SIZE[1]
# At most this many of the 256 bits differ within a category (~10 %).
MAX_DISTANCE = 26
SHEET_COLUMNS = 4
SHEET_THUMB = 360
SHEET_MAX = 24


def image_signature(path: str) -> int:
    """The plan's difference hash (SIGNATURE_BITS bits) - EXIF rotation
    applied, transparency on white."""
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGBA")
    background = Image.new("RGBA", image.size, (255, 255, 255, 255))
    background.alpha_composite(image)
    small = background.convert("L").resize(SIGNATURE_SIZE, Image.Resampling.BOX)
    pixels = list(small.getdata())
    width = SIGNATURE_SIZE[0]
    bits = 0
    for row in range(SIGNATURE_SIZE[1]):
        for column in range(width - 1):
            left, right = pixels[row * width + column], pixels[row * width + column + 1]
            bits = (bits << 1) | (1 if right > left else 0)
    return bits


def distance(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def group(signatures: list[int], max_distance: int = MAX_DISTANCE) -> list[list[int]]:
    """Indices of `signatures` in groups: within max_distance bits of another
    member (single linkage) - in the order of their first member."""
    parent = list(range(len(signatures)))

    def root(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for a in range(len(signatures)):
        for b in range(a + 1, len(signatures)):
            if root(a) != root(b) and distance(signatures[a], signatures[b]) <= max_distance:
                parent[root(b)] = root(a)
    groups: dict[int, list[int]] = {}
    for index in range(len(signatures)):
        groups.setdefault(root(index), []).append(index)
    return sorted(groups.values(), key=lambda members: members[0])


def category_id(signature: int) -> str:
    """A short stable name from a category's first plan: "C" + 8 hex digits."""
    return f"C{signature >> (SIGNATURE_BITS - 32):08x}"


def contact_sheet(images: list[tuple[str, str]], title: str) -> Image.Image:
    """Thumbnails [(image path, caption)] of a category in one image."""
    shown = images[:SHEET_MAX]
    rows = max(1, -(-len(shown) // SHEET_COLUMNS))
    caption = 22
    sheet = Image.new("RGB", (SHEET_COLUMNS * SHEET_THUMB, 40 + rows * (SHEET_THUMB + caption)), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.load_default(size=15)
        title_font = ImageFont.load_default(size=20)
    except TypeError:  # Pillow < 10.1
        font = title_font = ImageFont.load_default()
    more = f" (first {SHEET_MAX} of {len(images)})" if len(images) > SHEET_MAX else ""
    draw.text((10, 10), title + more, fill=(20, 20, 20), font=title_font)
    for index, (path, label) in enumerate(shown):
        x = (index % SHEET_COLUMNS) * SHEET_THUMB
        y = 40 + (index // SHEET_COLUMNS) * (SHEET_THUMB + caption)
        try:
            with Image.open(path) as source:
                thumb = ImageOps.exif_transpose(source).convert("RGB")
            thumb.thumbnail((SHEET_THUMB - 10, SHEET_THUMB - 10))
            sheet.paste(thumb, (x + 5, y + 5))
        except OSError:
            draw.rectangle((x + 5, y + 5, x + SHEET_THUMB - 5, y + SHEET_THUMB - 5), outline=(200, 200, 200))
        draw.text((x + 5, y + SHEET_THUMB), label, fill=(60, 60, 60), font=font)
    return sheet
