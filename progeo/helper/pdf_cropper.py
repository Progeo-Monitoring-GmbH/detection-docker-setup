import json
import os
from pathlib import Path

import cv2
import fitz
import numpy as np

from progeo.settings import UPLOAD_DIR


def find_pink_rectangle(image_bgr: np.ndarray):
    """Find the dominant non-white rectangle by searching down the diagonal for the first non-white pixel."""
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    white_threshold = 245

    seed = None
    for diag in range(0, max(h, w) + 1):
        x = min(diag, w - 1)
        y = diag - x
        if y < 0 or y >= h:
            continue
        while x < w and y < h:
            if gray[y, x] < white_threshold:
                seed = (x, y)
                break
            x += 1
            y += 1
        if seed is not None:
            break

    if seed is None:
        print("Warning: No non-white pixel found on the diagonal scan.")
        return None

    stack = [seed]
    visited = set()
    points = []

    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        if (x, y) in visited:
            continue
        visited.add((x, y))

        if gray[y, x] >= white_threshold:
            continue

        points.append((x, y))

        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in visited:
                    if gray[ny, nx] < white_threshold:
                        stack.append((nx, ny))

    if len(points) < 200:
        print(f"Warning: Region too small ({len(points)} pixels).")
        return None

    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    x1, x2 = min(xs), max(xs)
    y1, y2 = min(ys), max(ys)

    region_w = x2 - x1 + 1
    region_h = y2 - y1 + 1
    border_hits = 0
    for x in range(x1, x2 + 1):
        if gray[y1, x] < white_threshold:
            border_hits += 1
        if gray[y2, x] < white_threshold:
            border_hits += 1
    for y in range(y1, y2 + 1):
        if gray[y, x1] < white_threshold:
            border_hits += 1
        if gray[y, x2] < white_threshold:
            border_hits += 1

    if border_hits < max(20, (region_w + region_h) * 2 // 3):
        print("Warning: Detected region is not a closed rectangle.")
        return None

    pad = max(2, min(region_w, region_h) // 30)
    x1 = min(w - 1, x1 + pad)
    y1 = min(h - 1, y1 + pad)
    x2 = max(0, x2 - pad)
    y2 = max(0, y2 - pad)

    if x2 <= x1 or y2 <= y1:
        return None

    print(f"Detected rectangle at x={x1}:{x2}, y={y1}:{y2}, size={x2 - x1}x{y2 - y1}")
    return (x1, y1, x2, y2)


def crop_to_pink_rectangle(image_path: Path, output_path: Path) -> bool:
    image_bgr = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image_bgr is None:
        return False

    rect = find_pink_rectangle(image_bgr)
    if rect is None:
        print(f"Warning: No pink rectangle found in {image_path}. Saving original image.")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(output_path), image_bgr)
        return False

    x1, y1, x2, y2 = rect
    cropped = image_bgr[y1:y2, x1:x2]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output_path), cropped)
    return True


def find_blue_cross_centers(image_bgr: np.ndarray):
    """Find blue cross markers in the cropped image and return their centers."""
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    blue_mask = cv2.inRange(hsv, np.array([90, 60, 40], dtype=np.uint8), np.array([145, 255, 255], dtype=np.uint8))

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    blue_mask = cv2.morphologyEx(blue_mask, cv2.MORPH_OPEN, kernel)
    blue_mask = cv2.morphologyEx(blue_mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(blue_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    centers = []

    for contour in contours:
        area = cv2.contourArea(contour)
        if area < 8 or area > 2000:
            continue

        x, y, w, h = cv2.boundingRect(contour)
        if max(w, h) > 25:
            continue

        m = cv2.moments(contour)
        if m["m00"] == 0:
            continue

        cx = int(round(m["m10"] / m["m00"]))
        cy = int(round(m["m01"] / m["m00"]))
        centers.append((cx, cy))

    deduped = []
    for center in sorted(centers):
        if not deduped or all(abs(center[0] - existing[0]) > 2 or abs(center[1] - existing[1]) > 2 for existing in deduped):
            deduped.append(center)

    return deduped


def normalize_points(points, width, height):
    """Convert absolute coordinates to normalized coordinates within the crop bounds."""
    if not points or width <= 0 or height <= 0:
        return []

    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)

    normalized = []
    for _id, (x, y) in enumerate(points):
        nx = 0.0 if max_x == min_x else (x - min_x) / (max_x - min_x)
        ny = 0.0 if max_y == min_y else (y - min_y) / (max_y - min_y)
        normalized.append({"x": round(nx, 3), "y": round(ny, 3), "_id": _id + 1})

    return normalized


def process_pdf_to_png_and_extract_crosses(pdf_path: Path, dpi: int = 300):

    output_dir = os.path.join(UPLOAD_DIR, "pdf_2_png")
    output_dir.mkdir(exist_ok=True)

    print(f"Processing PDF: {pdf_path} at {dpi} DPI. Output directory: {output_dir}")

    doc = fitz.open(pdf_path)

    scale = dpi / 72
    matrix = fitz.Matrix(scale, scale)

    for page_number, page in enumerate(doc, start=1):
        pix = page.get_pixmap(
            matrix=matrix,
            alpha=False,
        )

        temp_path = output_dir / f"drawing_{page_number:03d}_raw.png"
        pix.save(temp_path)

        output_path = output_dir / f"drawing_{page_number:03d}.png"
        cropped = crop_to_pink_rectangle(temp_path, output_path)

        if output_path.exists():
            cropped_img = cv2.imread(str(output_path), cv2.IMREAD_COLOR)
            centers = find_blue_cross_centers(cropped_img) if cropped_img is not None else []
            normalized = normalize_points(centers, cropped_img.shape[1], cropped_img.shape[0]) if cropped_img is not None else []
            json_path = output_dir / f"drawing_{page_number:03d}_blue_crosses.json"
            payload = {
                "page": page_number,
                "points": normalized,
                "bounds": {
                    "width": cropped_img.shape[1] if cropped_img is not None else 0,
                    "height": cropped_img.shape[0] if cropped_img is not None else 0,
                },
            }
            with json_path.open("w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2)

        print(
            f"Page {page_number}: "
            f"{pix.width} × {pix.height} px → {output_path} "
            f"(pink crop: {'yes' if cropped else 'fallback'})"
        )
        print(f"  blue crosses: {len(find_blue_cross_centers(cv2.imread(str(output_path), cv2.IMREAD_COLOR)) if output_path.exists() and cv2.imread(str(output_path), cv2.IMREAD_COLOR) is not None else [])}")

    doc.close()
    return json_path
