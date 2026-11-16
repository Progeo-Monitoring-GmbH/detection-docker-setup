"""
Klemmliste PDF -> sensor names per measuring position - the "klemmliste"
mode of the progeo-cad_factory container (cad_reader.py --klemmliste).

A Klemmliste (terminal list) is a table with, among others, the columns
"Sensor" (the sensor's name), "MUX Karte" (the multiplexer card, from 1)
and "PIN" (the card's input, 1-16). The measuring position of a row is

    position = (mux - 1) * PINS_PER_MUX + pin

which is the sensor_order of the location's measure point (or its pair on
a device). The backend gives that point the row's sensor name.

The PDFs come in several variants (Excel exports, CAD title blocks, with and
without ruled tables, columns in any order, headers wrapped over two lines,
tables over several pages, other header names - "dm Leitung" instead of
"Sensor"), so nothing here depends on positions, column order or exact
header names. The columns are found

- by their header text where it is known (HEADER_SYNONYMS), and
- for every column the header doesn't name, by what the column holds
  (infer_columns): PIN whole numbers 1-16, MUX "MUX 1" or small repeating
  numbers, the sensor short names ending in a number ("D_1", "dm 007").

in a grid of cells read in one of two ways:

1. PyMuPDF's table finder (ruled tables): the header is one of a table's
   first rows; a table without one on a later page continues the last one
   when it has as many columns.
2. Otherwise word positions: a header line (or two, when wrapped) with at
   least three labels; every column spans the room up to the middle between
   its label and the neighbouring ones, each line below is cut into them.

Rows without a readable MUX card and pin are skipped (sub-headings, sums);
an empty MUX cell repeats the card above (merged cells). Problems are
reported as warnings, never by guessing.

A location with several controllers has one Klemmliste for all of them: the
column "Measuring Unit" (Messeinheit) names the controller ("Area A", ...),
carried down like the MUX card, and the MUX cards count from 1 again for
each one - the positions are per unit, every row says its "unit".

Some lists give every sensor two rows - its two wires: the one with MUX card
and PIN, the other "block / GE". The sensor's cell spans both, so its name
may stand in either row: a PIN row without a name takes it from the row
right after it, when that one has no PIN of its own but is labelled where
MUX and PIN stand ("block" / "GE") - a sum or a heading leaves them empty.
"""
import re
import unicodedata

PINS_PER_MUX = 16

# Normalized header text (normalize_header) -> column. Checked in this
# order, so the specific labels win ("muxkarte" before "karte").
HEADER_SYNONYMS = (
    ("mux", ("muxkarte", "muxcard", "multiplexerkarte", "multiplexer", "muxplatine", "muxnr", "muxnummer", "mux",
             "karte")),
    ("pin", ("pinnr", "pinnummer", "pin", "eingang", "kanal")),
    ("sensor", ("sensorname", "sensorbezeichnung", "sensor", "dmleitung", "dmcable", "dmkabel", "dmsensor",
                "sensorleitung", "sensorcable", "leitung", "messpunkt", "messstelle", "bezeichnung")),
    # Optional: the controller of the row, when one list covers several.
    ("unit", ("measuringunit", "measurementunit", "messeinheit", "mea", "einheit", "unit")),
)
# Words of a header that rule a column out for a role ("Sensor-Typ" names no sensor).
HEADER_EXCLUDES = {"sensor": ("typ", "type", "art", "anzahl", "laenge", "lange")}
COLUMNS = ("sensor", "mux", "pin")

# What the cells of a column hold, for the columns the header doesn't name.
PIN_CELL_RE = re.compile(r"^\d{1,2}$")
MUX_CELL_RE = re.compile(r"^(?:mux|karte|m)\s*[-_.:]?\s*\d{1,2}$", re.IGNORECASE)
SENSOR_CELL_RE = re.compile(r"^[^\W\d_]{1,8}\s*[-_. /]?\s*\d{1,4}[^\W\d_]?$")
# A column is taken when this share of its filled cells fits (and enough are filled).
PIN_SHARE, MUX_SHARE, SENSOR_SHARE = 0.8, 0.8, 0.6
MIN_FILLED = 3
# A table counts as a Klemmliste with at least this many readable rows.
MIN_ROWS = 2

# Words of one PDF line are at most this far apart vertically (points).
LINE_TOLERANCE = 3.0
_NUMBER_RE = re.compile(r"\d+")


def normalize_header(text) -> str:
    """'MUX-\\nKarte' -> 'muxkarte', 'Sensor Nr.' -> 'sensornr' (umlauts folded)."""
    text = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def header_match(text) -> tuple | None:
    """(column, rank) a header cell names - sensor / mux / pin, rank 0 the
    best label of HEADER_SYNONYMS - or None for any other column."""
    normalized = normalize_header(text)
    if not normalized:
        return None
    for role, synonyms in HEADER_SYNONYMS:
        for rank, synonym in enumerate(synonyms):
            if normalized == synonym or (len(synonym) > 3 and normalized.startswith(synonym)):
                excluded = HEADER_EXCLUDES.get(role, ())
                if any(word in normalized[len(synonym):] for word in excluded):
                    continue
                return role, rank
    return None


def header_role(text) -> str | None:
    """The column a header cell names (sensor / mux / pin), None for any other."""
    match = header_match(text)
    return match[0] if match else None


def header_roles(cells) -> dict:
    """{role: cell index} of the columns `cells` name - maybe not all three.
    Per column the best label wins ("Sensor" over "Messpunkt"), then the first."""
    best = {}
    for index, cell in enumerate(cells):
        match = header_match(cell)
        if match and (match[0] not in best or match[1] < best[match[0]][0]):
            best[match[0]] = (match[1], index)
    return {role: index for role, (_rank, index) in best.items()}


def header_map(cells) -> dict | None:
    """{role: cell index} when `cells` name all three columns, else None."""
    roles = header_roles(cells)
    return roles if all(role in roles for role in COLUMNS) else None


def _filled(rows, index) -> list:
    return [" ".join(str(row[index]).split()) for row in rows if index < len(row) and str(row[index] or "").strip()]


def _share(values, test) -> float:
    return sum(1 for value in values if test(value)) / len(values) if values else 0.0


def _is_pin(value) -> bool:
    return bool(PIN_CELL_RE.match(value)) and 1 <= int(value) <= PINS_PER_MUX


def infer_columns(known: dict, rows, width) -> dict | None:
    """`known` ({role: index} from the header) completed by what the other
    columns hold - None when a role stays without a column. A column the
    header names for another role is never taken."""
    mapping = dict(known)

    def free():
        return [index for index in range(width) if index not in mapping.values()]

    def best(test, share, minimum=MIN_FILLED, extra=lambda values: True):
        scored = []
        for index in free():
            values = _filled(rows, index)
            if len(values) >= minimum and _share(values, test) >= share and extra(values):
                scored.append((sum(1 for value in values if test(value)), -index, index))
        return max(scored)[2] if scored else None

    if "pin" not in mapping:
        found = best(_is_pin, PIN_SHARE, extra=lambda values: len(set(values)) > 1)
        if found is not None:
            mapping["pin"] = found
    if "mux" not in mapping:
        # "MUX 1", "Karte 2" - or bare card numbers, repeating down the column (merged cells: few filled).
        found = best(lambda value: bool(MUX_CELL_RE.match(value)), MUX_SHARE, minimum=1)
        if found is None:
            found = best(lambda value: bool(PIN_CELL_RE.match(value)) and int(value) >= 1, MUX_SHARE, minimum=1,
                         extra=lambda values: len(set(values)) < len(values) or len(values) <= 2)
        if found is not None:
            mapping["mux"] = found
    if "sensor" not in mapping:
        found = best(lambda value: bool(SENSOR_CELL_RE.match(value)), SENSOR_SHARE)
        if found is not None:
            mapping["sensor"] = found
    return mapping if all(role in mapping for role in COLUMNS) else None


def _readable_rows(rows, mapping) -> int:
    """How many PIN rows have a sensor name under `mapping` - in the row or,
    two rows per sensor, in the next one without a PIN. Is it a Klemmliste at all?"""
    def cell(row, role):
        return clean_name(row[mapping[role]]) if mapping[role] < len(row) else ""

    count = 0
    for index, row in enumerate(rows):
        if first_number(cell(row, "pin")) is None:
            continue
        following = rows[index + 1] if index + 1 < len(rows) else None
        if cell(row, "sensor") or (following and first_number(cell(following, "pin")) is None
                                   and (cell(following, "pin") or cell(following, "mux"))
                                   and cell(following, "sensor")):
            count += 1
    return count


def is_header_row(cells) -> bool:
    """A repeated header (continuation page): it names two of the columns."""
    return len(header_roles(cells)) >= 2


def find_columns(header_rows, data_rows, width) -> dict | None:
    """The columns of a table: the header (one of `header_rows`, merged when
    a header is wrapped is the caller's business) names what it can,
    the cells below tell the rest."""
    cells = [" ".join(str(cell or "").split()) for cell in header_rows]
    if any(PIN_CELL_RE.match(cell) or MUX_CELL_RE.match(cell) for cell in cells):
        return None  # a data row ("MUX 1", a PIN), not a header
    known = header_roles(cells)
    mapping = infer_columns(known, data_rows, width)
    if mapping and _readable_rows(data_rows, mapping) >= MIN_ROWS:
        return mapping
    return None


def first_number(text) -> int | None:
    match = _NUMBER_RE.search(str(text or ""))
    return int(match.group()) if match else None


def clean_name(text) -> str:
    return " ".join(str(text or "").split())


class RowCollector:
    """Turns table rows ({role: text}) into Klemmliste entries."""

    def __init__(self):
        self.rows = []
        self.warnings = []
        self.units = []  # in the order of the list
        self._positions = {}
        self._last_mux = None
        self._unit = None
        # A PIN row without a name: its name may follow in the next row (two rows per sensor).
        self._pending = None

    def restart(self):
        """A new table: a merged MUX cell never reaches across tables (a
        measuring unit and a pending name do - pages break anywhere)."""
        self._last_mux = None

    def add(self, cells: dict, page: int) -> None:
        name = clean_name(cells.get("sensor"))
        mux_text = clean_name(cells.get("mux"))
        pin_text = clean_name(cells.get("pin"))
        unit_text = clean_name(cells.get("unit"))
        if unit_text and unit_text != self._unit:
            self._flush()
            self._unit = unit_text
            self._last_mux = None
            if unit_text not in self.units:
                self.units.append(unit_text)
        pin = first_number(pin_text)
        mux = first_number(mux_text) if mux_text else self._last_mux
        if mux_text:
            self._last_mux = mux
        if pin is None or mux is None:
            # A row without an input: the second wire of the PIN row above
            # ("block" / "GE" where MUX and PIN stand) may carry its name - not
            # a sum or a heading (nothing there), and not its own "GE" label.
            second_wire = bool(pin_text or mux_text)
            if name and self._pending and second_wire and name not in (pin_text, mux_text):
                self._store(self._pending, name)
                self._pending = None
            return
        self._flush()
        entry = {"unit": self._unit, "mux": mux, "pin": pin, "page": page}
        if not name:
            self._pending = entry
            return
        self._store(entry, name)

    def finish(self):
        """The end of the list: a PIN row still waiting for its name has none."""
        self._flush()

    def _flush(self):
        if self._pending:
            entry = self._pending
            self._pending = None
            self.warnings.append(f"Page {entry['page']}: {self._where(entry)} has no sensor name - skipped")

    @staticmethod
    def _where(entry):
        unit = f"{entry['unit']}: " if entry["unit"] else ""
        return f"{unit}MUX {entry['mux']} PIN {entry['pin']}"

    def _store(self, entry, name):
        mux, pin, page = entry["mux"], entry["pin"], entry["page"]
        if not 1 <= pin <= PINS_PER_MUX or mux < 1:
            self.warnings.append(
                f"Page {page}: {name}: {self._where(entry)} is no valid input (PIN 1-{PINS_PER_MUX}) - skipped")
            return
        position = (mux - 1) * PINS_PER_MUX + pin
        key = (entry["unit"], position)
        if key in self._positions:
            earlier = self._positions[key]
            if earlier != name:
                self.warnings.append(
                    f"Page {page}: position {position} ({self._where(entry)}) twice: "
                    f"'{earlier}' and '{name}' - the first is kept")
            return
        self._positions[key] = name
        self.rows.append({"sensor": name, "mux": mux, "pin": pin, "position": position, "page": page,
                          "unit": entry["unit"]})


# -- 1. ruled tables ----------------------------------------------------------

def _cell_text(words, bbox) -> str:
    """The words whose middle lies in the cell `bbox`, line by line - not the
    table finder's own cell text, which tears words apart ("D_124" came out
    as "D 124\n_" in the 7078 Klemmliste)."""
    if bbox is None:
        return ""  # a merged cell - the collector repeats the MUX card above
    x0, y0, x1, y1 = bbox
    inside = [word for word in words
              if x0 <= (word[0] + word[2]) / 2 <= x1 and y0 <= (word[1] + word[3]) / 2 <= y1]
    inside.sort(key=lambda word: (round((word[1] + word[3]) / 2 / LINE_TOLERANCE), word[0]))
    return " ".join(word[4] for word in inside)


def _table_rows(page) -> list:
    """The tables PyMuPDF finds on `page`, each as a list of rows of cell texts."""
    try:
        found = page.find_tables()
    except Exception:  # noqa: BLE001 - no table finder (old PyMuPDF) or a page it chokes on
        return []
    words = page.get_text("words")
    tables = []
    for table in found.tables:
        try:
            rows = [[_cell_text(words, cell) for cell in row.cells] for row in table.rows]
        except AttributeError:  # an old PyMuPDF without cell boxes
            rows = [[cell or "" for cell in row] for row in table.extract()]
        tables.append(rows)
    return tables


def _read_tables(doc, collector, log) -> bool:
    columns = None
    width = None
    used = False
    for page_number, page in enumerate(doc, start=1):
        for rows in _table_rows(page):
            collector.restart()
            start = 0
            row_width = max((len(row) for row in rows), default=0)
            for index, row in enumerate(rows[:4]):  # the header is near the top
                mapping = find_columns(row, rows[index + 1:], row_width)
                if mapping:
                    columns, width, start = mapping, len(row), index + 1
                    named = {role for role in header_roles(row)}
                    guessed = [role for role in COLUMNS if role not in named]
                    if guessed:
                        log(f"Page {page_number}: column(s) {', '.join(guessed)} found by their content "
                            f"(header: {', '.join(clean_name(row[mapping[role]]) or '-' for role in guessed)})")
                    break
            else:
                if columns is None or not rows or len(rows[0]) != width:
                    continue  # no Klemmliste table (title block, legend)
                log(f"Page {page_number}: table continues the Klemmliste above")
            used = True
            for row in rows[start:]:
                if is_header_row(row):
                    continue
                collector.add({role: row[index] if index < len(row) else "" for role, index in columns.items()},
                              page_number)
    return used


# -- 2. word positions --------------------------------------------------------

def _lines(page) -> list:
    """The words of `page` grouped into lines (top to bottom), each a list of (x0, x1, text) left to right."""
    words = sorted(page.get_text("words"), key=lambda word: ((word[1] + word[3]) / 2, word[0]))
    lines = []
    for x0, y0, x1, y1, text, *_ in words:
        middle = (y0 + y1) / 2
        if lines and abs(lines[-1][0] - middle) <= LINE_TOLERANCE:
            lines[-1][1].append((x0, x1, text))
        else:
            lines.append([middle, [(x0, x1, text)]])
    return [sorted(words, key=lambda word: word[0]) for _middle, words in lines]


def _labels(line) -> list:
    """The column labels of a header line: words closer than a gap merged ("MUX Karte")."""
    labels = []
    for x0, x1, text in line:
        if labels and x0 - labels[-1][1] < 6:
            labels[-1] = (labels[-1][0], x1, f"{labels[-1][2]} {text}")
        else:
            labels.append((x0, x1, text))
    return labels


def _cut(line, bounds) -> list:
    """The words of `line` as cells, one per column (left, right)."""
    cells = [[] for _bound in bounds]
    for x0, x1, text in line:
        middle = (x0 + x1) / 2
        for index, (left, right) in enumerate(bounds):
            if left <= middle < right:
                cells[index].append(text)
    return [" ".join(words) for words in cells]


def _header_columns(lines, index) -> tuple | None:
    """(columns {role: (left, right)}, lines used) when line `index` - alone or
    with the next one, for headers wrapped over two lines - is the header of a
    Klemmliste: at least three labels, its roles named or found below."""
    for used in (1, 2):
        if index + used > len(lines):
            break
        # Every line of a header is free of data ("MUX 1", a PIN) - two data
        # lines stacked would look like a wrapped header otherwise.
        if any(PIN_CELL_RE.match(label[2]) or MUX_CELL_RE.match(label[2])
               for line in lines[index:index + used] for label in _labels(line)):
            break
        labels = _labels(sorted((word for line in lines[index:index + used] for word in line),
                                key=lambda word: word[0]))
        # Words stacked in one column ("MUX" over "Karte") become one label.
        merged = []
        for label in labels:
            if merged and label[0] < merged[-1][1] - 2:
                merged[-1] = (min(merged[-1][0], label[0]), max(merged[-1][1], label[1]),
                              f"{merged[-1][2]} {label[2]}")
            else:
                merged.append(label)
        # Without a ruled table the columns come from the labels. A header whose
        # labels are all unknown must at least label every column: the lines
        # below have no more word groups than it has labels - else a column
        # without a label would smear into its neighbours.
        if len(merged) < 3:
            continue
        if not header_roles([label[2] for label in merged]):
            groups = sorted(len(_labels(line)) for line in lines[index + used:index + used + 30])
            if not groups or groups[len(groups) // 2] > len(merged):
                continue
        bounds = []
        for position, label in enumerate(merged):
            left = (merged[position - 1][1] + label[0]) / 2 if position else float("-inf")
            right = (label[1] + merged[position + 1][0]) / 2 if position + 1 < len(merged) else float("inf")
            bounds.append((left, right))
        data = [_cut(line, bounds) for line in lines[index + used:]]
        mapping = find_columns([label[2] for label in merged], data, len(merged))
        if not mapping:
            continue
        return {role: bounds[index_] for role, index_ in mapping.items()}, used
    return None


def _read_words(doc, collector, log) -> bool:
    used = False
    columns = None
    for page_number, page in enumerate(doc, start=1):
        lines = _lines(page)
        start = 0
        for index in range(len(lines)):
            header = _header_columns(lines, index)
            if header:
                columns, skip = header
                start = index + skip
                break
        else:
            if columns is None:
                continue
            log(f"Page {page_number}: no header - the columns of the page before are used")
        used = True
        collector.restart()
        for line in lines[start:]:
            cells = {role: [] for role in columns}
            for x0, x1, text in line:
                middle = (x0 + x1) / 2
                for role, (left, right) in columns.items():
                    if left <= middle < right:
                        cells[role].append(text)
            collector.add({role: " ".join(words) for role, words in cells.items()}, page_number)
    return used


def read_klemmliste(path, log=lambda _line: None) -> dict:
    """{"rows": [{"sensor", "mux", "pin", "position", "page"}], "warnings": [...],
    "method": "tables" | "words" | None} of the Klemmliste PDF at `path`."""
    # Not "import fitz": that alias prints a deprecation notice to stdout,
    # which carries the JSON result.
    import pymupdf

    with pymupdf.open(path) as doc:
        log(f"Klemmliste: {doc.page_count} page(s)")
        for method, reader in (("tables", _read_tables), ("words", _read_words)):
            collector = RowCollector()
            used = reader(doc, collector, log)
            collector.finish()
            if used and collector.rows:
                log(f"Klemmliste: {len(collector.rows)} sensor(s) read from the {method}")
                order = {unit: index for index, unit in enumerate(collector.units)}
                rows = sorted(collector.rows, key=lambda row: (order.get(row["unit"], -1), row["position"]))
                units = [{"unit": unit, "rows": sum(1 for row in rows if row["unit"] == unit)}
                         for unit in collector.units]
                for unit in units:
                    log(f"Klemmliste: measuring unit {unit['unit']}: {unit['rows']} sensor(s)")
                return {"rows": rows, "warnings": collector.warnings, "method": method, "units": units}
            log(f"Klemmliste: nothing found by {method}")
    reason = "No table with sensor names, MUX cards and PINs found (e.g. the columns Sensor, MUX Karte and PIN)"
    return {"rows": [], "warnings": [reason], "method": None, "units": []}
