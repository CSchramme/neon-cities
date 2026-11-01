#!/usr/bin/env python3
"""Erzeugt die Spieldaten aus offiziellen Quellen.

Quellen:
  * Destatis Gemeindeverzeichnis "Gemeinden in Deutschland nach Fläche,
    Bevölkerung und Postleitzahl" (AuszugGV…Aktuell.xlsx)
    https://www.destatis.de/DE/Themen/Laender-Regionen/Regionales/Gemeindeverzeichnis/_inhalt.html
  * Bundesland-Grenzen: Natural Earth (Public Domain), 1:10 Mio.
    https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_10m_admin_1_states_provinces.geojson

Aufruf:
  python3 tools/build-data.py AuszugGV2QAktuell.xlsx ne_10m_admin_1_states_provinces.geojson

Ergebnis:
  public/data/germany.json  – Bundesländer (Umrisse) + alle Städte
  lib/gemeinden.json        – alle übrigen Gemeinden (für die Meldung
                              "… ist keine Stadt")
"""
import json
import math
import re
import sys
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent

# Reihenfolge = Index im Spiel (state index "s")
STATES = [
    ("01", "SH", "Schleswig-Holstein"),
    ("02", "HH", "Hamburg"),
    ("03", "NI", "Niedersachsen"),
    ("04", "HB", "Bremen"),
    ("05", "NW", "Nordrhein-Westfalen"),
    ("06", "HE", "Hessen"),
    ("07", "RP", "Rheinland-Pfalz"),
    ("08", "BW", "Baden-Württemberg"),
    ("09", "BY", "Bayern"),
    ("10", "SL", "Saarland"),
    ("11", "BE", "Berlin"),
    ("12", "BB", "Brandenburg"),
    ("13", "MV", "Mecklenburg-Vorpommern"),
    ("14", "SN", "Sachsen"),
    ("15", "ST", "Sachsen-Anhalt"),
    ("16", "TH", "Thüringen"),
]
CODE_TO_IDX = {c: i for i, (c, _, _) in enumerate(STATES)}
ISO_TO_IDX = {f"DE-{iso}": i for i, (_, iso, _) in enumerate(STATES)}

CAPITALS = {
    "Kiel", "Hamburg", "Hannover", "Bremen", "Düsseldorf", "Wiesbaden", "Mainz",
    "Stuttgart", "München", "Saarbrücken", "Berlin", "Potsdam", "Schwerin",
    "Dresden", "Magdeburg", "Erfurt",
}

# Sorbische Zweitnamen ohne Leerzeichen vor dem Schrägstrich
SORBIAN_SUFFIXES = [
    "Chóśebuz", "Kalawa", "Rań", "Zły Komorow", "Drjowk", "Baršć (Łužyca)",
    "Grodk", "Wjelcej", "Derbno", "Picnjo",
]

# Abkürzungen für die Anzeige ausschreiben (Reihenfolge wichtig)
EXPANSIONS = [
    (r"a\. d\. Eigen", "auf dem Eigen"),
    (r"\bi\.d\.OPf\.", "in der Oberpfalz"),
    (r"\bi\.d\.", "in der "),
    (r"\bi\.OB\b", "in Oberbayern"),
    (r"\bi\.Bay\.", "in Bayern"),
    (r"\bi\.UFr\.", "in Unterfranken"),
    (r"\bi\.", "im "),
    (r"\ba\. ?d\. ?", "an der "),
    (r"\ba\.", "am "),
    (r"\bb\.", "bei "),
    (r"\bv\. ?d\. ?", "vor der "),
    (r"/Erzgeb\.", "/Erzgebirge"),
    (r"/Vogtl\.", "/Vogtland"),
    (r"/Sa\.", "/Sachsen"),
    (r"/O\.L\.", "/Oberlausitz"),
    (r"/Sächs\. Schw\.", "/Sächsische Schweiz"),
    (r"/Thür\. Wald", "/Thüringer Wald"),
    (r"\(Rhld\.\)", "(Rheinland)"),
    (r"\(Westf\.\)", "(Westfalen)"),
    (r"^Hann\. Münden$", "Hann. Münden"),
]


def clean_official(raw: str):
    """'Bautzen / Budyšin, Stadt, …' -> ('Bautzen', ['Budyšin'])"""
    aliases = []
    name = raw.split(", ", 1)[0].strip()
    # "Weißwasser/O.L., Stadt / Běła Woda"
    tail = raw.split(", ", 1)[1] if ", " in raw else ""
    if tail.startswith("Stadt / "):
        aliases.append(tail.split(" / ", 1)[1].strip())
    if " / " in name:
        parts = [p.strip() for p in name.split(" / ")]
        name = parts[0]
        aliases.extend(parts[1:])
    for suf in SORBIAN_SUFFIXES:
        if name.endswith("/" + suf):
            name = name[: -len(suf) - 1]
            aliases.append(suf)
    name = re.sub(r"/\s+", "/", name)
    # "Lutherstadt Wittenberg" ist die übliche Schreibweise
    if ", Lutherstadt" in raw:
        aliases.append("Lutherstadt " + name)
    return name, aliases


def expand(name: str) -> str:
    out = name
    for pat, rep in EXPANSIONS:
        out = re.sub(pat, rep, out)
    return re.sub(r"\s+", " ", out).strip()


def num(v):
    return float(str(v).replace(",", "."))


# ---------- Projektion (Web-Mercator, auf Höhe 1000 skaliert) ----------
def merc(lon, lat):
    x = math.radians(lon)
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def main(xlsx_path, geo_path):
    geo = json.loads(Path(geo_path).read_text(encoding="utf-8"))
    rings_by_state = [[] for _ in STATES]
    for f in geo["features"]:
        props = f["properties"]
        iso = props.get("iso_3166_2") or props.get("id")
        if iso not in ISO_TO_IDX:
            continue
        idx = ISO_TO_IDX[iso]
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            for ring in poly:
                rings_by_state[idx].append([merc(lon, lat) for lon, lat in ring])

    xs = [p[0] for rs in rings_by_state for r in rs for p in r]
    ys = [p[1] for rs in rings_by_state for r in rs for p in r]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    H = 1000.0
    k = H / (maxy - miny)
    W = round((maxx - minx) * k, 1)

    def proj(lon, lat):
        x, y = merc(lon, lat)
        return round((x - minx) * k, 1), round((maxy - y) * k, 1)

    def to_px(pt):
        return round((pt[0] - minx) * k, 1), round((maxy - pt[1]) * k, 1)

    states_out = []
    for i, (code, iso, name) in enumerate(STATES):
        rings = []
        for r in rings_by_state[i]:
            pts = simplify([to_px(p) for p in r], 0.3)
            if len(pts) >= 4:
                rings.append([c for p in pts for c in p])
        lx, ly = label_point(rings)
        states_out.append({
            "id": iso, "code": code, "name": name,
            "rings": rings, "label": [lx, ly],
        })

    wb = openpyxl.load_workbook(xlsx_path, read_only=True)
    ws = wb[wb.sheetnames[1]]
    title = next(ws.iter_rows(values_only=True))[0]
    cities, gemeinden = [], []
    for r in ws.iter_rows(values_only=True):
        if r[0] != "60":
            continue
        tk, land, rb, kreis, gem = r[1], r[2], r[3], r[4], r[6]
        ags = f"{land}{rb}{kreis}{gem}"
        s = CODE_TO_IDX[land]
        official, aliases = clean_official(r[7])
        if tk in ("61", "62", "63", "67"):
            disp = expand(official)
            x, y = proj(num(r[14]), num(r[15]))
            c = {"id": ags, "n": disp, "s": s, "x": x, "y": y, "p": int(r[9])}
            if disp != official:
                c["o"] = official
            if aliases:
                c["a"] = aliases
            if disp in CAPITALS:
                c["cap"] = 1
            if "Hanse" in r[7]:
                c["h"] = 1  # Hansestadt (für den Erfolg "Die Hanse")
            cities.append(c)
        elif tk in ("60", "64"):
            gemeinden.append([official, s, "Markt" if tk == "60" else "Gemeinde"])

    for i, st in enumerate(states_out):
        st["total"] = sum(1 for c in cities if c["s"] == i)

    out = {
        "source": f"Städte: © Statistisches Bundesamt (Destatis), {title}, dl-de/by-2-0; Grenzen: Natural Earth (Public Domain)",
        "width": W, "height": H,
        "states": states_out,
        "cities": cities,
    }
    (ROOT / "public/data/germany.json").write_text(
        json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (ROOT / "lib/gemeinden.json").write_text(
        json.dumps(gemeinden, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(cities)} Städte, {len(gemeinden)} weitere Gemeinden, Karte {W}x{H}")
    caps = sorted(c["n"] for c in cities if c.get("cap"))
    print("Hauptstädte:", len(caps), caps)


# ---------- Douglas-Peucker-Vereinfachung ----------
def simplify(pts, tol):
    if len(pts) < 5:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy)
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / L if L else math.hypot(px - ax, py - ay)
            if d > best:
                best, bi = d, i
        if best > tol and bi > 0:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    out = [p for p, k in zip(pts, keep) if k]
    dedup = [out[0]]
    for p in out[1:]:
        if p != dedup[-1]:
            dedup.append(p)
    return dedup


# ---------- Label-Punkt: Punkt im Inneren mit größtem Randabstand ----------
def point_in_rings(x, y, rings):
    inside = False
    for flat in rings:
        n = len(flat) // 2
        j = n - 1
        for i in range(n):
            xi, yi, xj, yj = flat[2 * i], flat[2 * i + 1], flat[2 * j], flat[2 * j + 1]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
    return inside


def dist_to_edges(x, y, rings):
    best = float("inf")
    for flat in rings:
        n = len(flat) // 2
        for i in range(n):
            ax, ay = flat[2 * i], flat[2 * i + 1]
            bx, by = flat[2 * ((i + 1) % n)], flat[2 * ((i + 1) % n) + 1]
            dx, dy = bx - ax, by - ay
            L = dx * dx + dy * dy
            t = 0 if L == 0 else max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / L))
            px, py = ax + t * dx - x, ay + t * dy - y
            best = min(best, px * px + py * py)
    return math.sqrt(best)


def label_point(rings):
    xs = [v for r in rings for v in r[0::2]]
    ys = [v for r in rings for v in r[1::2]]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    best, bp = -1, ((x0 + x1) / 2, (y0 + y1) / 2)
    step = max(x1 - x0, y1 - y0) / 30
    for it in range(3):
        cx, cy = bp
        span = step * 15 if it == 0 else step * 3
        gx = x0 if it == 0 else cx - span
        while gx <= (x1 if it == 0 else cx + span):
            gy = y0 if it == 0 else cy - span
            while gy <= (y1 if it == 0 else cy + span):
                if point_in_rings(gx, gy, rings):
                    d = dist_to_edges(gx, gy, rings)
                    if d > best:
                        best, bp = d, (gx, gy)
                gy += step
            gx += step
        step /= 5
    return round(bp[0], 1), round(bp[1], 1)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
