#!/usr/bin/env python3
"""Interactive pytest wrapper with group/test selection.

Controls:
- Arrow keys: move
- Space: select/deselect
- Enter: confirm
- Esc: cancel
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

from prompt_toolkit.shortcuts import button_dialog, checkboxlist_dialog, message_dialog


TEST_SETTINGS_MODULE = "progeo.tests.settings"
TEST_ENV_FLAG = "1"


@dataclass(frozen=True)
class TestCollection:
    nodeids: list[str]
    groups: dict[str, list[str]]


def get_repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def collect_tests(repo_root: Path) -> TestCollection:
    env = os.environ.copy()
    env["TESTS_ACTIVE"] = TEST_ENV_FLAG
    env["DJANGO_SETTINGS_MODULE"] = TEST_SETTINGS_MODULE

    cmd = [
        sys.executable,
        "-m",
        "pytest",
        "--ds=progeo.tests.settings",
        "--collect-only",
        "-q",
    ]
    result = subprocess.run(
        cmd,
        cwd=repo_root,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(
            "Failed to collect tests.\n"
            f"stdout:\n{result.stdout}\n\n"
            f"stderr:\n{result.stderr}"
        )

    nodeids: list[str] = []
    for line in result.stdout.splitlines():
        item = line.strip()
        if not item:
            continue
        if item.startswith("="):
            continue
        if "::" not in item and not item.endswith(".py"):
            continue
        nodeids.append(item)

    nodeids = sorted(set(nodeids))

    groups: dict[str, list[str]] = defaultdict(list)
    for nodeid in nodeids:
        parts = nodeid.split("::")
        file_part = parts[0]
        groups[f"file: {file_part}"].append(nodeid)

        if len(parts) >= 2 and parts[1].startswith("Test"):
            cls_key = f"class: {file_part}::{parts[1]}"
            groups[cls_key].append(nodeid)

    ordered_groups = dict(sorted(groups.items(), key=lambda item: item[0].lower()))
    return TestCollection(nodeids=nodeids, groups=ordered_groups)


def pick_groups(collection: TestCollection, selected_groups: set[str]) -> set[str]:
    values = []
    defaults = []
    for group_name, tests in collection.groups.items():
        label = f"{group_name} ({len(tests)} tests)"
        values.append((group_name, label))
        if group_name in selected_groups:
            defaults.append(group_name)

    chosen = checkboxlist_dialog(
        title="Select Test Groups",
        text=(
            "Choose groups to include.\n"
            "Use arrow keys + space to toggle, enter to confirm."
        ),
        values=values,
        default_values=defaults,
        ok_text="Apply",
        cancel_text="Back",
    ).run()

    if chosen is None:
        return selected_groups
    return set(chosen)


def pick_tests(collection: TestCollection, selected_tests: set[str]) -> set[str]:
    values = [(nodeid, nodeid) for nodeid in collection.nodeids]
    defaults = [nodeid for nodeid in collection.nodeids if nodeid in selected_tests]

    chosen = checkboxlist_dialog(
        title="Select Individual Tests",
        text=(
            "Choose individual tests to include.\n"
            "Use arrow keys + space to toggle, enter to confirm."
        ),
        values=values,
        default_values=defaults,
        ok_text="Apply",
        cancel_text="Back",
    ).run()

    if chosen is None:
        return selected_tests
    return set(chosen)


def compute_effective_selection(
    collection: TestCollection,
    selected_groups: set[str],
    selected_tests: set[str],
) -> list[str]:
    selected: set[str] = set(selected_tests)
    for group_name in selected_groups:
        selected.update(collection.groups.get(group_name, []))
    return sorted(selected)


def run_selected_tests(repo_root: Path, selected_nodeids: list[str]) -> int:
    env = os.environ.copy()
    env["TESTS_ACTIVE"] = TEST_ENV_FLAG
    env["DJANGO_SETTINGS_MODULE"] = TEST_SETTINGS_MODULE

    cmd = [
        sys.executable,
        "-m",
        "pytest",
        "--ds=progeo.tests.settings",
        *selected_nodeids,
    ]

    print("\nRunning command:")
    print(" ".join(cmd))
    print("")

    result = subprocess.run(cmd, cwd=repo_root, env=env, check=False)
    return int(result.returncode)


def show_summary(collection: TestCollection, selected_groups: set[str], selected_tests: set[str]) -> str:
    effective = compute_effective_selection(collection, selected_groups, selected_tests)
    return (
        f"Collected tests: {len(collection.nodeids)}\n"
        f"Selected groups: {len(selected_groups)}\n"
        f"Selected individual tests: {len(selected_tests)}\n"
        f"Effective selected tests: {len(effective)}"
    )


def main() -> int:
    repo_root = get_repo_root()

    try:
        collection = collect_tests(repo_root)
    except Exception as exc:
        message_dialog(title="Pytest Selector", text=str(exc)).run()
        return 1

    if not collection.nodeids:
        message_dialog(title="Pytest Selector", text="No tests were collected.").run()
        return 1

    selected_groups: set[str] = set()
    selected_tests: set[str] = set()

    while True:
        summary = show_summary(collection, selected_groups, selected_tests)
        action = button_dialog(
            title="Pytest Selector",
            text=summary,
            buttons=[
                ("Select groups", "groups"),
                ("Select tests", "tests"),
                ("Run selected", "run"),
                ("Run all", "all"),
                ("Quit", "quit"),
            ],
        ).run()

        if action in (None, "quit"):
            return 0

        if action == "groups":
            selected_groups = pick_groups(collection, selected_groups)
            continue

        if action == "tests":
            selected_tests = pick_tests(collection, selected_tests)
            continue

        if action == "all":
            return run_selected_tests(repo_root, collection.nodeids)

        if action == "run":
            effective = compute_effective_selection(
                collection,
                selected_groups,
                selected_tests,
            )
            if not effective:
                message_dialog(
                    title="Pytest Selector",
                    text="No tests selected. Choose tests/groups first.",
                ).run()
                continue
            return run_selected_tests(repo_root, effective)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
