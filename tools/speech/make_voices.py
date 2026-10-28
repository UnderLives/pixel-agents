"""Fixed voices for the office: one Qwen3-TTS speaker embedding (.spk) per speaker.

Each voice is a blend of 3 Common Voice speakers (CC0, declared sex and age decade) of the
speaker's sex and age bracket, pushed away from the bracket's average voice so it is nobody's
voice in particular (the Underlives voice rule: never a real person's voice). Same recipe as the
game's ul_Voices set (Tools in the game repo, voicepool/build_voices.py), CPU only, numpy only.

The result is stored in the fork and reused for every later generation, so a speaker always
sounds the same:
    speech/voices/<slug>.spk     raw 1024 float32 little-endian (qwentts.cpp --ref-spk / spk_b64)
    speech/voices/RECIPE.json    for each voice: the source speakers and the blend parameters

Deterministic: the seed is derived from the speaker's name, so re-running gives the same file.
A voice that already exists is never rebuilt (pass --force to rebuild one on purpose).

Usage (from the repo root):
    python -I tools/speech/make_voices.py --pool F:/.../voicepool/pool.npz
    python -I tools/speech/make_voices.py --pool ... --only Linda --force
"""

import argparse
import hashlib
import json
import os
import random
import sys
import unicodedata

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VOICES = os.path.join(ROOT, 'speech', 'voices')
DEFAULT_POOL = 'F:/ClaudeScratch/05026d2b-a0fb-4736-a25d-bf56f563b6ea/scratchpad/voicepool/pool.npz'

# speaker -> (sex, age decades of the bracket, nudge). The nudge picks among the candidate blends:
# 0 = the one farthest from the bracket average, higher = further down the list (a different voice).
CAST = {
    'Linda': ('f', (25, 35), 0),
    'Maya': ('f', (35, 45), 0),
    'Nora': ('f', (25,), 1),
    'Sacha': ('f', (25, 35), 2),
    'Iris': ('f', (25,), 3),
    'Léa': ('f', (25, 35), 4),
    'Zoé': ('f', (16, 25), 0),
    'Aytaç': ('m', (35, 45), 0),
}
BLEND_SIZE = 3
PUSH = 1.3          # away from the bracket's average voice (as in the game's set)
CANDIDATES = 400


def slug(name: str) -> str:
    return unicodedata.normalize('NFD', name).encode('ascii', 'ignore').decode().lower()


def build(name, sex, decades, nudge, emb, meta, norm_mean, voices_so_far):
    ids = [i for i, m in enumerate(meta) if m['src'] == 'cv' and m['sex'] == sex and m['age'] in decades]
    if len(ids) < BLEND_SIZE * 2:
        raise SystemExit(f'{name}: only {len(ids)} pool speakers for {sex} {decades}')
    unit = emb / np.linalg.norm(emb, axis=1, keepdims=True)
    centre = unit[ids].mean(0)
    seed = int(hashlib.sha1(name.encode('utf-8')).hexdigest()[:8], 16)
    rng = random.Random(seed)
    cands = []
    for _ in range(CANDIDATES):
        src = rng.sample(ids, BLEND_SIZE)
        v = centre + PUSH * (unit[src].mean(0) - centre)
        cands.append((v / np.linalg.norm(v) * norm_mean, src))

    # Unlike the bracket average AND unlike the voices already made, then the nudge-th best.
    def score(c):
        others = [np.linalg.norm(c[0] - o) for o in voices_so_far] or [0.0]
        return min(others) + 0.25 * np.linalg.norm(c[0] / norm_mean - centre)

    ranked = sorted(cands, key=score, reverse=True)
    vec, src = ranked[min(nudge, len(ranked) - 1)]
    recipe = {
        'speaker': name,
        'sex': sex,
        'ageDecades': list(decades),
        'pool': 'Common Voice en dev+test (CC0), Qwen3-TTS 0.6B Base speaker encoder',
        'sources': [f"cv:{meta[s]['id']}" for s in src],
        'blend': f'mean of {BLEND_SIZE}, pushed x{PUSH} from the bracket average, renormalised',
        'seed': seed,
        'nudge': nudge,
    }
    return vec.astype('<f4'), recipe


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--pool', default=DEFAULT_POOL)
    ap.add_argument('--only', help='comma-separated speakers')
    ap.add_argument('--force', action='store_true', help='rebuild voices that already exist')
    args = ap.parse_args()

    z = np.load(args.pool, allow_pickle=False)
    emb = z['emb'].astype(np.float64)
    meta = json.loads(str(z['meta']))
    norm_mean = float(np.linalg.norm(emb, axis=1).mean())
    os.makedirs(VOICES, exist_ok=True)
    recipe_path = os.path.join(VOICES, 'RECIPE.json')
    recipes = json.load(open(recipe_path, encoding='utf-8')) if os.path.exists(recipe_path) else {}
    only = {s.strip() for s in args.only.split(',')} if args.only else None

    made = []
    for name, (sex, decades, nudge) in CAST.items():
        path = os.path.join(VOICES, f'{slug(name)}.spk')
        if os.path.exists(path):
            made.append(np.fromfile(path, dtype='<f4').astype(np.float64))
            if not (args.force and (only is None or name in only)):
                continue
            made.pop()
        if only is not None and name not in only:
            continue
        vec, recipe = build(name, sex, decades, nudge, emb, meta, norm_mean, made)
        vec.tofile(path)
        made.append(vec.astype(np.float64))
        recipes[name] = recipe
        print(f'{name}: {path} <- {", ".join(recipe["sources"])}')
    with open(recipe_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(recipes, f, ensure_ascii=False, indent=2)
        f.write('\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
