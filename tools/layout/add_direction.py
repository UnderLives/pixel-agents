"""Build default-layout-2.json: upstream's default-layout-1 plus a "Direction" office.

The lead session (the boss) works in his own small office, apart from the open
space where the employees (named sub-agents) sit; he walks over to their desks
from time to time. The office is added east of the lounge, behind a door in the
lounge's east wall, and painted as Area "Direction" (pixel-agents.bossArea).

Run from the repo root:  python -I tools/layout/add_direction.py
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ASSETS = os.path.join(ROOT, 'webview-ui', 'public', 'assets')

WALL, WOOD, VOID = 0, 7, 255
EXTRA_COLS = 7
# The office: top wall on row 10 (shared with the other rooms), floor rows 11-15,
# floor cols 20-25, east wall on col 26; door through the lounge's east wall (col 19).
FLOOR_COLS = range(20, 26)
FLOOR_ROWS = range(11, 16)
DOOR = [(19, 13), (19, 14)]
EAST_WALL_COL = 26
AREA = {'label': 'Direction', 'color': '#c9a227'}
# Dark walnut floor, a step apart from the open space's wood.
FLOOR_COLOR = {'h': 18, 's': 45, 'b': -58, 'c': -80}

FURNITURE = [
    # Desk with its PC, the boss's seat in front (same arrangement as the open space).
    ('DESK_FRONT', 21, 12),
    ('PC_FRONT_OFF', 22, 12),
    ('CUSHIONED_BENCH', 22, 14),
    # On the north wall.
    ('DOUBLE_BOOKSHELF', 20, 9),
    ('LARGE_PAINTING', 23, 9),
    # Corners.
    ('PLANT', 25, 11),
    ('PLANT_2', 20, 11),
    ('BIN', 25, 15),
]


def main() -> int:
    src = json.load(open(os.path.join(ASSETS, 'default-layout-1.json'), encoding='utf-8'))
    cols, rows = src['cols'], src['rows']
    new_cols = cols + EXTRA_COLS

    def widen(arr, fill):
        out = []
        for r in range(rows):
            out.extend(arr[r * cols:(r + 1) * cols])
            out.extend([fill] * EXTRA_COLS)
        return out

    tiles = widen(src['tiles'], VOID)
    colors = widen(src['tileColors'], None)
    wall_color = src['tileColors'][10 * cols + 0]
    lounge_color = src['tileColors'][13 * cols + 18]

    def put(col, row, tile, color):
        tiles[row * new_cols + col] = tile
        colors[row * new_cols + col] = color

    for col in range(19, EAST_WALL_COL + 1):
        put(col, 10, WALL, wall_color)
    for row in range(10, FLOOR_ROWS.stop):
        put(EAST_WALL_COL, row, WALL, wall_color)
    for row in FLOOR_ROWS:
        for col in FLOOR_COLS:
            put(col, row, WOOD, FLOOR_COLOR)
    for col, row in DOOR:
        put(col, row, src['tiles'][row * cols + 18], lounge_color)

    area_tiles = [None] * (new_cols * rows)
    for row in FLOOR_ROWS:
        for col in FLOOR_COLS:
            area_tiles[row * new_cols + col] = AREA['label']

    furniture = list(src['furniture'])
    for i, (ftype, col, row) in enumerate(FURNITURE):
        furniture.append({'uid': f'f-direction-{i}', 'type': ftype, 'col': col, 'row': row})

    out = dict(src)
    out.update(
        cols=new_cols,
        tiles=tiles,
        tileColors=colors,
        furniture=furniture,
        layoutRevision=2,
        areas=[AREA],
        areaTiles=area_tiles,
    )
    path = os.path.join(ASSETS, 'default-layout-2.json')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, separators=(',', ':'))
        f.write('\n')
    print(f'wrote {path} ({new_cols}x{rows}, {len(furniture)} furniture)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
