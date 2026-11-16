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
tables over several pages), so nothing here depends on positions or column
order - the columns are found by their header text:

1. PyMuPDF's table finder (ruled tables): every table whose header row
   names the three columns; a table without such a header on a later page
   continues the last one when it has as many columns.
2. Otherwise word positions: the line naming the three columns is the
   header, every column spans the room up to the middle between its label
   and the neighbouring ones, and each line below is cut into those columns.

Rows without a readable MUX card and pin are skipped (sub-headings, sums);
an empty MUX cell repeats the card above (merged cells). Problems are
reported as warnings, never by guessing.
"""
import re
import unicodedata

PINS_PER_MUX = 16

# Normalized header text (normalize_header) -> column. Checked in this
# order, so the specific labels win ("muxkarte" before "karte").
HEADER_SYNONYMS = (
    ("mux", ("muxkarte", "muxcard", "multiplexerkarte", "multiplexer", "muxnr", "muxnummer", "mux", "karte")),
    ("pin", ("pinnr", "pinnummer", "pin", "eingang", "kanal")),
    ("sensor", ("sensorname", "sensorbezeichnung", "sensor", "messpunkt", "messstelle")),
)
# Words of a header that rule a column out for a role ("Sensor-Typ" names no sensor).
HEADER_EXCLUDES = {"sensor": ("typ", "type", "art", "anzahl", "laenge", "lange")}
COLUMNS = ("sensor", "mux", "pin")

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


def header_map(cells) -> dict | None:
    """{role: cell index} when `cells` name all three columns, else None. Per
    column the best label wins ("Sensor" over "Messpunkt"), then the first."""
    best = {}
    for index, cell in enumerate(cells):
        match = header_match(cell)
        if match and (match[0] not in best or match[1] < best[match[0]][0]):
            best[match[0]] = (match[1], index)
    if not all(role in best for role in COLUMNS):
        return None
    return {role: index for role, (_rank, index) in best.items()}


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
        self._positions = {}
        self._last_mux = None

    def restart(self):
        """A new table: a merged MUX cell never reaches across tables."""
        self._last_mux = None

    def add(self, cells: dict, page: int) -> None:
        name = clean_name(cells.get("sensor"))
        mux_text = clean_name(cells.get("mux"))
        pin = first_number(cells.get("pin"))
        mux = first_number(mux_text) if mux_text else self._last_mux
        if mux_text:
            self._last_mux = mux
        if pin is None or mux is None:
            return  # a sub-heading, a sum or an empty line
        if not name:
            self.warnings.append(f"Page {page}: MUX {mux} PIN {pin} has no sensor name - skipped")
            return
        if not 1 <= pin <= PINS_PER_MUX or mux < 1:
            self.warnings.append(
                f"Page {page}: {name}: MUX {mux} PIN {pin} is no valid input (PIN 1-{PINS_PER_MUX}) - skipped")
            return
        position = (mux - 1) * PINS_PER_MUX + pin
        if position in self._positions:
            earlier = self._positions[position]
            if earlier != name:
                self.warnings.append(
                    f"Page {page}: position {position} (MUX {mux} PIN {pin}) twice: "
                    f"'{earlier}' and '{name}' - the first is kept")
            return
        self._positions[position] = name
        self.rows.append({"sensor": name, "mux": mux, "pin": pin, "position": position, "page": page})


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
            for index, row in enumerate(rows[:4]):  # the header is near the top
                mapping = header_map(row)
                if mapping:
                    columns, width, start = mapping, len(row), index + 1
                    break
            else:
                if columns is None or not rows or len(rows[0]) != width:
                    continue  # no Klemmliste table (title block, legend)
                log(f"Page {page_number}: table continues the Klemmliste above")
            used = True
            for row in rows[start:]:
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
        if labels and x0 - labels[-1][1] < 6 and not header_role(text):
            labels[-1] = (labels[-1][0], x1, f"{labels[-1][2]} {text}")
        else:
            labels.append((x0, x1, text))
    return labels


def _header_columns(lines, index) -> tuple | None:
    """(columns {role: (left, right)}, lines used) when line `index` - alone or
    with the next one, for headers wrapped over two lines - names the three columns."""
    for used in (1, 2):
        if index + used > len(lines):
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
        mapping = header_map([label[2] for label in merged])
        if not mapping:
            continue
        bounds = []
        for position, label in enumerate(merged):
            left = (merged[position - 1][1] + label[0]) / 2 if position else float("-inf")
            right = (label[1] + merged[position + 1][0]) / 2 if position + 1 < len(merged) else float("inf")
            bounds.append((left, right))
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
            if reader(doc, collector, log) and collector.rows:
                log(f"Klemmliste: {len(collector.rows)} sensor(s) read from the {method}")
                return {"rows": sorted(collector.rows, key=lambda row: row["position"]),
                        "warnings": collector.warnings, "method": method}
            log(f"Klemmliste: nothing found by {method}")
    return {"rows": [], "warnings": ["No table with the columns Sensor, MUX Karte and PIN found"], "method": None}
