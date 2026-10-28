/**
 * Keep name tags from piling up: sub-agents stand right next to their lead, so
 * seven tags would print on top of each other. Greedy and pure: tags are placed
 * from the bottom of the screen up, and a tag that would overlap one already
 * placed is lifted just above it. Sizes are estimates from the text length (the
 * overlay never measures the DOM), which is enough to separate them.
 */

export interface TagBox {
  id: number;
  /** Centre x and bottom y of the tag, CSS px. */
  x: number;
  bottom: number;
  width: number;
  height: number;
}

/** Gap kept between two stacked tags. */
const TAG_GAP_PX = 2;

/** Estimated tag size for its text (pixel font, ~0.55em per glyph). */
export function estimateTagSize(
  name: string,
  role: string | null,
  nameFontPx: number,
  roleFontPx: number,
): { width: number; height: number } {
  const width =
    Math.max(name.length * nameFontPx * 0.55, (role?.length ?? 0) * roleFontPx * 0.55) + 10;
  const height = nameFontPx + (role ? roleFontPx + 2 : 0) + 4;
  return { width, height };
}

/** Estimated height of a speech bubble wrapping `text` at `maxWidth` (15px font). */
export function estimateBubbleHeight(text: string, maxWidth: number): number {
  const lines = Math.max(1, Math.ceil((text.length * 15 * 0.55) / (maxWidth - 14)));
  return lines * 18 + 12;
}

/** id -> how far up (px, >= 0) the tag must move to clear the ones below it. */
export function layoutTags(boxes: readonly TagBox[]): Map<number, number> {
  const lifts = new Map<number, number>();
  const placed: { left: number; right: number; top: number; bottom: number }[] = [];
  const order = [...boxes].sort((a, b) => b.bottom - a.bottom || a.id - b.id);
  for (const box of order) {
    const left = box.x - box.width / 2;
    const right = box.x + box.width / 2;
    let bottom = box.bottom;
    for (let moved = true; moved;) {
      moved = false;
      for (const p of placed) {
        const overlapsX = left < p.right && right > p.left;
        const overlapsY = bottom - box.height < p.bottom && bottom > p.top;
        if (overlapsX && overlapsY) {
          bottom = p.top - TAG_GAP_PX;
          moved = true;
        }
      }
    }
    placed.push({ left, right, top: bottom - box.height, bottom });
    lifts.set(box.id, box.bottom - bottom);
  }
  return lifts;
}
