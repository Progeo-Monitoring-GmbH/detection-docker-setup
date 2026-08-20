#!/usr/bin/env python3
"""Standalone crawler: copies PDFs found in each project's "Anfrage_Angebot" folder into media/uploads/legacy_docs."""
import argparse
import os
import shutil
import sys
import unicodedata

# Windows consoles are often cp1252 and choke on filenames with combining diacritics (NFD).
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "progeo.settings")
import django

django.setup()

from progeo.settings import DATABASES
from progeo.v1.models import ProgeoLocation

ROOT_DIR = r"C:\Users\info\PROGEO Monitoring Systeme und Services GmbH & Co. KG\Operations - Projekte"
DEST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "media", "uploads", "legacy_docs")
TARGET_SUBFOLDER = "Anfrage_Angebot"


def extract_project_id(folder_name):
    """Project folders are named like "5802_Timber_Cove_ILD_NA"; project_id is the part before the first '_'."""
    prefix = folder_name.split("_", 1)[0].strip()
    try:
        return int(prefix)
    except ValueError:
        return None


def location_has_geo_position(project_id):
    """Looks up the ProgeoLocation for project_id across all configured databases.

    Returns True if a location was found with both latitude and longitude set, False otherwise
    (including when no location exists at all).
    """
    for db in DATABASES.keys():
        location = ProgeoLocation.objects.using(db).filter(project_id=project_id).first()
        if location is not None:
            return location.latitude is not None and location.longitude is not None
    return False


def find_target_subfolder(project_dir):
    """Case-insensitive lookup of the Anfrage_Angebot subfolder inside a project dir."""
    for entry in os.listdir(project_dir):
        full_path = os.path.join(project_dir, entry)
        if os.path.isdir(full_path) and entry.lower() == TARGET_SUBFOLDER.lower():
            return full_path
    return None


def collect_pdfs(folder):
    return [
        os.path.join(folder, entry)
        for entry in os.listdir(folder)
        if os.path.isfile(os.path.join(folder, entry)) and entry.lower().endswith(".pdf")
    ]


def crawl(root_dir=ROOT_DIR, dest_dir=DEST_DIR, dry_run=False):
    if not os.path.isdir(root_dir):
        raise NotADirectoryError(f"Root directory not found: {root_dir}")

    if not dry_run:
        os.makedirs(dest_dir, exist_ok=True)

    copied = 0
    skipped_invalid_id = 0
    skipped_no_subfolder = 0
    skipped_no_pdf = 0
    skipped_has_geo = 0

    for entry in sorted(os.listdir(root_dir)):
        project_dir = os.path.join(root_dir, entry)
        if not os.path.isdir(project_dir):
            continue

        project_id = extract_project_id(entry)
        if project_id is None:
            print(f"Skipping '{entry}': can't extract a project_id from the folder name")
            skipped_invalid_id += 1
            continue

        target_folder = find_target_subfolder(project_dir)
        if target_folder is None:
            skipped_no_subfolder += 1
            continue

        pdfs = collect_pdfs(target_folder)
        if not pdfs:
            skipped_no_pdf += 1
            continue

        if location_has_geo_position(project_id):
            skipped_has_geo += 1
            continue

        for pdf_path in pdfs:
            # Prefix with the project folder name to avoid collisions between projects;
            # normalize to NFC since filesystem paths may come back as decomposed (NFD) unicode.
            dest_name = unicodedata.normalize("NFC", f"{entry}__{os.path.basename(pdf_path)}")
            dest_path = os.path.join(dest_dir, dest_name)

            if dry_run:
                print(f"[dry-run] would copy {pdf_path} -> {dest_path}")
            else:
                shutil.copy2(pdf_path, dest_path)
                print(f"Copied {pdf_path} -> {dest_path}")
            copied += 1

    print(
        f"Done. Copied {copied} pdf(s). {skipped_invalid_id} project(s) with no parsable project_id, "
        f"{skipped_no_subfolder} without '{TARGET_SUBFOLDER}', "
        f"{skipped_no_pdf} with an empty '{TARGET_SUBFOLDER}' (no pdf inside), "
        f"{skipped_has_geo} already have a geo-position."
    )
    return copied


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=ROOT_DIR, help="Root projects directory")
    parser.add_argument("--dest", default=DEST_DIR, help="Destination directory for copied PDFs")
    parser.add_argument("--dry-run", action="store_true", help="Only print what would be copied")
    args = parser.parse_args()

    crawl(root_dir=args.root, dest_dir=args.dest, dry_run=args.dry_run)
