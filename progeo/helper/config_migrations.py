"""Server-side migrations of a controller's config/device_config.lua between
config schemas (LUA_WLAN config/release.json "config_schema", in every flash
bundle's bundle.json) - used by the remote firmware update
(helper/firmware_update.py) when the next release needs another schema.

The file holds the controller's secrets (wifi.pwd, control.token), so it is
never part of a bundle: the server reads it from the controller ("get_config"),
migrates it here and sends it with the "upgrade".

A migration is a function from the text of schema N to the text of schema
N + 1, registered in MIGRATIONS under N. It edits the text in place with the
helpers below - like the controller's own set_params, the layout and the
comments stay:

    def _2_to_3(text):
        text = set_value(text, "measurement", "settle_ms", "1000")
        return remove_key(text, "wifi", "probe_port")

    MIGRATIONS = {2: _2_to_3}

The config is a Lua table of sections ("return { wifi = { ssid = "...", ... },
... }") with plain values; the helpers only touch the top-level sections.
"""
import re

# Schema N -> function(text of schema N) -> text of schema N + 1.
MIGRATIONS = {}

_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# A value: a string, or anything up to the comma, a comment, the closing
# brace or the end of its line (trailing spaces excluded).
_VALUE = r'("(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)*\'|(?:(?!--)[^,\n}])*?(?:(?!--)[^,\s}]))'
_VALUE_END = r"[ \t]*(?=,|--|\n|\}|$)"


class ConfigMigrationError(ValueError):
    pass


def migrate(text, from_schema, to_schema):
    """`text` (a device_config.lua of from_schema) migrated step by step to
    to_schema. Raises ConfigMigrationError when a step is missing or a step
    fails."""
    if to_schema < from_schema:
        raise ConfigMigrationError(f"config schema {from_schema} cannot go back to {to_schema}")
    for schema in range(from_schema, to_schema):
        step = MIGRATIONS.get(schema)
        if step is None:
            raise ConfigMigrationError(f"no config migration from schema {schema} to {schema + 1}")
        try:
            text = step(text)
        except ConfigMigrationError:
            raise
        except (ValueError, KeyError) as exc:
            raise ConfigMigrationError(f"config migration {schema} -> {schema + 1} failed: {exc}") from exc
        if not isinstance(text, str) or not text.lstrip().startswith("return"):
            raise ConfigMigrationError(f"config migration {schema} -> {schema + 1} did not return a config")
    return text


# ---------------------------------------------------------------------------- text helpers

def _skip_string_or_comment(text, index):
    """Index after the string or comment starting at `index`, None if there is none."""
    if text.startswith("--", index):
        if text.startswith("--[[", index):
            end = text.find("]]", index + 4)
            return len(text) if end < 0 else end + 2
        end = text.find("\n", index)
        return len(text) if end < 0 else end
    if text.startswith("[[", index):
        end = text.find("]]", index + 2)
        return len(text) if end < 0 else end + 2
    quote = text[index]
    if quote in "\"'":
        position = index + 1
        while position < len(text):
            if text[position] == "\\":
                position += 2
                continue
            if text[position] == quote or text[position] == "\n":
                return position + 1
            position += 1
        return len(text)
    return None


def _sections(text):
    """{section name: (start of its body, index of its closing brace)} of the
    top-level sections of the returned table."""
    sections = {}
    depth = 0
    index = 0
    while index < len(text):
        skipped = _skip_string_or_comment(text, index)
        if skipped is not None:
            index = skipped
            continue
        char = text[index]
        if char == "{":
            depth += 1
            if depth == 2:
                # "<name> = {" right before it.
                match = re.search(r"([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$", text[:index])
                if match:
                    sections[match.group(1)] = [index + 1, None]
                    current = match.group(1)
                else:
                    current = None
        elif char == "}":
            if depth == 2 and current is not None:
                sections[current][1] = index
            depth -= 1
        index += 1
    return {name: tuple(span) for name, span in sections.items() if span[1] is not None}


def _span(text, section):
    span = _sections(text).get(section)
    if span is None:
        raise ConfigMigrationError(f"section {section!r} not in the config")
    return span


def _entry(text, section, key):
    """(match of `key = value` inside the section, body start) or (None, body start)."""
    if not _KEY.fullmatch(key):
        raise ConfigMigrationError(f"invalid key {key!r}")
    start, end = _span(text, section)
    pattern = re.compile(r"(?m)^([ \t]*)" + key + r"[ \t]*=[ \t]*" + _VALUE + _VALUE_END)
    return pattern.search(text, start, end), start, end


def get_value(text, section, key):
    """The Lua literal of `key` in `section` as written ('"abc"', '600',
    'true'), None if the key is not set (or only commented out)."""
    match, _start, _end = _entry(text, section, key)
    return match.group(2).strip() if match else None


def set_value(text, section, key, literal):
    """`key = literal` in `section` (literal: Lua source, e.g. '"abc"' or
    '600'): the value replaced where the key is set, else a line added at
    the end of the section."""
    match, start, end = _entry(text, section, key)
    if match:
        return text[:match.start(2)] + literal + text[match.end(2):]

    # The last entry needs a comma before the new one (after its value, before a comment).
    last = _last_content(text, start, end)
    if last is not None and text[last] not in ",{;":
        text = text[:last + 1] + "," + text[last + 1:]
        end += 1
    existing = re.search(r"(?m)^([ \t]+)[A-Za-z_]", text[start:end])
    brace_line = text.rfind("\n", 0, end) + 1
    if text[brace_line:end].strip():
        # "{ a = 1 }" on one line: the entry goes before the brace.
        return f"{text[:end].rstrip()} {key} = {literal} {text[end:]}"
    indent = existing.group(1) if existing else text[brace_line:end] + "  "
    return f"{text[:brace_line]}{indent}{key} = {literal},\n{text[brace_line:]}"


def _last_content(text, start, end):
    """Index of the last character in text[start:end] that is neither space
    nor part of a comment (strings count), None if there is none."""
    last = None
    index = start
    while index < end:
        skipped = _skip_string_or_comment(text, index)
        if skipped is not None:
            if not text.startswith("--", index):
                last = min(skipped, end) - 1  # a string is content
            index = skipped
            continue
        if not text[index].isspace():
            last = index
        index += 1
    return last


def remove_key(text, section, key):
    """`text` without the line setting `key` in `section` (unchanged if it is not set)."""
    match, _start, _end = _entry(text, section, key)
    if not match:
        return text
    line_start = text.rfind("\n", 0, match.start()) + 1
    line_end = text.find("\n", match.end())
    line_end = len(text) if line_end < 0 else line_end + 1
    rest = text[match.end():line_end]
    if rest.strip() and not rest.strip().startswith("--"):
        # Something else on the same line - only the entry goes.
        return text[:match.start()] + text[match.end():].lstrip(" \t")
    return text[:line_start] + text[line_end:]


def lua_string(value):
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r")
    return f'"{escaped}"'
