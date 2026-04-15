#!/usr/bin/env python3
"""
Import historical bingo data from Excel (sheet: Datagoc) into dataset/history.json.

Sheet structure:
  Row 1 header: STT | Time | Sum | Avg | Avg/10 | 111 | 222 | 333 | 444 | 555 | 666 | date1 | date2 | ...
  Row 2+ data:  idx | HH:MM | ... | draw_result_for_date1 | draw_result_for_date2 | ...

draw_result is a 3-digit int like 316 → n1=3, n2=1, n3=6 (each digit 1-6).

Usage:
  python3 scripts/import_excel.py
  python3 scripts/import_excel.py /path/to/other.xlsx
"""

import sys
import json
import hashlib
import datetime
import pathlib
import openpyxl

EXCEL_FILE   = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path('/Users/hien.nguyen13/Downloads/bingo6phut.xlsx')
HISTORY_FILE = pathlib.Path(__file__).parent.parent / 'dataset' / 'history.json'
SHEET_NAME   = 'Datagoc'

# Reference: ky=160598 at 2026-04-04T21:54:00+07:00 (from actual crawled data)
# Used to generate synthetic ky values for historical draws.
# Synthetic ky = REF_KY - round((REF_DT - draw_dt).total_seconds() / 360)
REF_KY = 160598
REF_DT = datetime.datetime(2026, 4, 4, 21, 54, 0,
                            tzinfo=datetime.timezone(datetime.timedelta(hours=7)))

TZ_VN = datetime.timezone(datetime.timedelta(hours=7))

# ── helpers ────────────────────────────────────────────────────────────────

def parse_draw(value):
    """Parse cell value into (n1, n2, n3) or None if invalid."""
    if not isinstance(value, int):
        return None
    if value < 111 or value > 666:
        return None
    s = str(value)
    if len(s) != 3:
        return None
    n1, n2, n3 = int(s[0]), int(s[1]), int(s[2])
    if any(d < 1 or d > 6 for d in (n1, n2, n3)):
        return None
    return n1, n2, n3


def classify_pattern(n1, n2, n3):
    if n1 == n2 == n3:
        return 'triple'
    if n1 == n2 or n2 == n3 or n1 == n3:
        return 'pair'
    return 'normal'


def make_id(ky, n1, n2, n3):
    raw = f'ky-{ky}-{n1}-{n2}-{n3}'
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def synthetic_ky(draw_dt):
    """Approximate ky based on elapsed 6-min slots from reference."""
    delta_secs = (REF_DT - draw_dt).total_seconds()
    slots = round(delta_secs / 360)
    return REF_KY - slots


# ── load existing history ──────────────────────────────────────────────────

print(f'Loading existing history from {HISTORY_FILE}...')
if HISTORY_FILE.exists():
    with open(HISTORY_FILE, encoding='utf-8') as f:
        history = json.load(f)
else:
    history = []
print(f'Existing records: {len(history)}')

# Build lookup by drawTime (minute-precision) to avoid duplicates
existing_times = set()
for r in history:
    dt = r.get('drawTime', '')
    if dt:
        # Normalise to "YYYY-MM-DDTHH:MM" prefix for minute-level dedup
        existing_times.add(dt[:16])

# ── parse Excel ────────────────────────────────────────────────────────────

print(f'Opening {EXCEL_FILE} (sheet: {SHEET_NAME})...')
wb = openpyxl.load_workbook(EXCEL_FILE, data_only=True)
ws = wb[SHEET_NAME]

rows      = list(ws.iter_rows(values_only=True))
header    = rows[0]
data_rows = rows[1:]

# Extract date columns (datetime objects in header from index 11 onward)
date_cols = []
for col_idx, cell in enumerate(header):
    if isinstance(cell, datetime.datetime):
        date_cols.append((col_idx, cell.date()))

print(f'Found {len(date_cols)} date columns: {date_cols[0][1]} → {date_cols[-1][1]}')
print(f'Found {len(data_rows)} time-slot rows')

# ── extract draws ──────────────────────────────────────────────────────────

new_records = []
skipped_dup = 0
skipped_bad = 0

for row in data_rows:
    raw_time = row[1]
    if not isinstance(raw_time, datetime.time):
        continue  # skip header or empty rows

    for col_idx, date in date_cols:
        value = row[col_idx] if col_idx < len(row) else None
        parsed = parse_draw(value)
        if parsed is None:
            skipped_bad += 1
            continue

        n1, n2, n3 = parsed

        draw_dt  = datetime.datetime.combine(date, raw_time, tzinfo=TZ_VN)
        draw_iso = draw_dt.strftime('%Y-%m-%dT%H:%M:00+07:00')
        dt_key   = draw_iso[:16]  # "YYYY-MM-DDTHH:MM"

        if dt_key in existing_times:
            skipped_dup += 1
            continue

        ky  = str(synthetic_ky(draw_dt))
        rid = make_id(ky, n1, n2, n3)

        new_records.append({
            'id':       rid,
            'ky':       ky,
            'drawTime': draw_iso,
            'n1':       n1,
            'n2':       n2,
            'n3':       n3,
            'sum':      n1 + n2 + n3,
            'pattern':  classify_pattern(n1, n2, n3),
        })
        existing_times.add(dt_key)

print(f'\nParsed:      {len(new_records)} new records')
print(f'Skipped dup: {skipped_dup}')
print(f'Skipped bad: {skipped_bad}')

if not new_records:
    print('Nothing to add — already up-to-date.')
    sys.exit(0)

# ── merge & sort ───────────────────────────────────────────────────────────

merged = history + new_records
merged.sort(key=lambda r: float(r['ky']), reverse=True)

print(f'\nTotal after merge: {len(merged):,} records')
print(f'ky range: {merged[-1]["ky"]} → {merged[0]["ky"]}')
print(f'drawTime range: {merged[-1]["drawTime"][:16]} → {merged[0]["drawTime"][:16]}')

# ── save ───────────────────────────────────────────────────────────────────

with open(HISTORY_FILE, 'w', encoding='utf-8') as f:
    json.dump(merged, f, ensure_ascii=False, separators=(',', ':'))

print(f'\n✓ Saved to {HISTORY_FILE}')

# Quick sanity check
with open(HISTORY_FILE, encoding='utf-8') as f:
    check = json.load(f)
print(f'✓ Verified JSON: {len(check):,} records readable')
