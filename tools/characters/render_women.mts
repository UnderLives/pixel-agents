// Render extra women characters as legacy 112x96 char_N.png sheets (the format v1.5 loads).
//
// The art is upstream's own pixel wardrobe (pixel-agents-hq/pixel-agents, branch
// stack/5-characters, MIT): its CharacterRenderer composes a profile from wardrobe parts.
// Usage (from the repo root):
//   git worktree add --detach ../wardrobe origin/stack/5-characters
//   npx tsx tools/characters/render_women.mts ../wardrobe webview-ui/public/assets/characters tools/characters/women.json 6
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { PNG } = require('pngjs');

const WT = process.argv[2];
const OUT = process.argv[3];
const profilesFile = process.argv[4];
// First char_N index to write (the bundled Metro City cast is char_0..char_5).
const FIRST = Number(process.argv[5] ?? 6);
const art = path.join(WT, 'webview-ui/src/characters/art');
const { CharacterRenderer } = await import(pathToUrl(path.join(WT, 'webview-ui/src/characters/renderer.ts')));
const { decodeWardrobe, parseWardrobeManifest } = await import(pathToUrl(path.join(WT, 'webview-ui/src/characters/wardrobe.ts')));
const { EYE_FOLDERS } = await import(pathToUrl(path.join(WT, 'webview-ui/src/characters/slots.ts')));
function pathToUrl(p: string) { return 'file:///' + p.split(String.fromCharCode(92)).join('/'); }

const files = new Map<string, { width: number; height: number; data: Uint8ClampedArray }>();
function walk(dir: string) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.png')) {
      const png = PNG.sync.read(readFileSync(p));
      const key = path.relative(art, p).split(path.sep).join('/').replace(/\.png$/, '');
      files.set(key, { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) });
    }
  }
}
walk(art);
const manifest = parseWardrobeManifest(JSON.parse(readFileSync(path.join(art, 'wardrobe.json'), 'utf8')));
const w = decodeWardrobe(manifest, files, EYE_FOLDERS);
const r = new CharacterRenderer(w);
const profiles = JSON.parse(readFileSync(profilesFile, 'utf8'));
mkdirSync(OUT, { recursive: true });
profiles.forEach((p: any, i: number) => {
  const sheet = r.sheet({ id: `w${i}`, v: 35, ...p });
  // 128x96 (8 frames, seated last) -> legacy 112x96 (7 frames) that v1.5.0 loads.
  const out = new PNG({ width: 112, height: 96 });
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 112; x++)
      for (let c = 0; c < 4; c++) out.data[(y * 112 + x) * 4 + c] = sheet[(y * 128 + x) * 4 + c];
  writeFileSync(path.join(OUT, `char_${FIRST + i}.png`), PNG.sync.write(out));
  console.log(i, p.name);
});
