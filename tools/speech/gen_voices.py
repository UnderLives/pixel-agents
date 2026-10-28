"""Render every speech line with its speaker's fixed voice, ahead of time (never at run time).

Uses the game's own voice runtime: ul-voice.exe from the ul_Voices mod (qwentts.cpp, Qwen3-TTS 0.6B
CustomVoice Q8, one JSON request per stdin line, see Tools/Voice/ul-voice.cpp in the game repo),
with each speaker's speech/voices/<slug>.spk (tools/speech/make_voices.py: a blend of free
speakers, never a real person's voice) passed as spk_b64. French, temperature 0.6 / sub 0.9 as in
the game.

Output: ~/.pixel-agents/speech/<speaker lower-case>/<id>.wav, id = sha1(text)[:10] (the same id the
extension computes, server/src/personaSettings.ts speechLineId), so a line keeps its audio when the
bank is reordered. Lines that already have a file are skipped: re-running only renders what is new.
Set pixel-agents.speech to "voice" to hear them.

Needs the GPU (or is slow on CPU): run it in a quiet moment, not while the game renders.

Usage (from the repo root):
    python -I tools/speech/gen_voices.py --speakers Linda --limit 5        a sample first
    python -I tools/speech/gen_voices.py                                   everything missing
"""

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEECH = os.path.join(ROOT, 'speech')
VOICES = os.path.join(SPEECH, 'voices')
ENGINE = 'C:/Users/hight/Documents/Unreal Projects/Underlives/Content/Modules/ul_Voices/Voice/Engine'
OUT_ROOT = os.path.join(os.path.expanduser('~'), '.pixel-agents', 'speech')

# Delivery per speaker (Qwen3-TTS instruct, English works best).
INSTRUCT = {
    'Linda': 'warm, playful and precise, smiling',
    'Maya': 'calm, soft-spoken, thoughtful',
    'Nora': 'enthusiastic, quick, geeky excitement',
    'Sacha': 'energetic, determined, upbeat',
    'Iris': 'light, musical, cheerful',
    'Léa': 'bright, friendly, expressive',
    'Zoé': 'cheerful, down-to-earth, confident',
    'Aytaç': 'warm, confident, encouraging male voice',
}


def slug(name):
    return unicodedata.normalize('NFD', name).encode('ascii', 'ignore').decode().lower()


def line_id(text):
    return hashlib.sha1(text.strip().encode('utf-8')).hexdigest()[:10]


def spoken(text, speaker):
    # Placeholders ({name}) cannot be voiced per employee: those lines stay text-only.
    return '{' not in text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--engine', default=ENGINE, help='folder with ul-voice.exe and the two GGUFs')
    ap.add_argument('--speakers', help='comma-separated (default: all)')
    ap.add_argument('--limit', type=int, default=0, help='at most N new lines per speaker (0 = all)')
    ap.add_argument('--device', default='', help='passed to ul-voice.exe --device (e.g. cpu)')
    args = ap.parse_args()

    exe = os.path.join(args.engine, 'ul-voice.exe')
    model = os.path.join(args.engine, 'qwen-talker-0.6b-customvoice-Q8_0.gguf')
    codec = os.path.join(args.engine, 'qwen-tokenizer-12hz-Q8_0.gguf')
    for p in (exe, model, codec):
        if not os.path.exists(p):
            print(f'missing {p}')
            return 2
    want = {s.strip() for s in args.speakers.split(',')} if args.speakers else None

    jobs = []
    for f in sorted(os.listdir(SPEECH)):
        if not f.endswith('.json'):
            continue
        bank = json.load(open(os.path.join(SPEECH, f), encoding='utf-8'))
        speaker = bank['speaker']
        if want and speaker not in want:
            continue
        spk = os.path.join(VOICES, f'{slug(speaker)}.spk')
        if not os.path.exists(spk):
            print(f'{speaker}: no voice ({spk}); run tools/speech/make_voices.py first')
            continue
        spk_b64 = base64.b64encode(open(spk, 'rb').read()).decode()
        out_dir = os.path.join(OUT_ROOT, speaker.lower())
        os.makedirs(out_dir, exist_ok=True)
        n = 0
        for lines in bank['situations'].values():
            for item in lines:
                text = item if isinstance(item, str) else item['text']
                lid = item.get('id') if isinstance(item, dict) and item.get('id') else line_id(text)
                out = os.path.join(out_dir, f'{lid}.wav')
                if os.path.exists(out) or not spoken(text, speaker):
                    continue
                if args.limit and n >= args.limit:
                    break
                n += 1
                jobs.append({
                    'id': len(jobs) + 1,
                    'text': text,
                    'instruct': INSTRUCT.get(speaker, 'warm, friendly'),
                    'spk_b64': spk_b64,
                    'lang': 'french',
                    'seed': int(lid[:6], 16),
                    'out': out.replace('\\', '/'),
                })
        print(f'{speaker}: {n} line(s) to render')
    if not jobs:
        print('nothing to render')
        return 0

    cmd = [exe, '--model', model, '--codec', codec]
    if args.device:
        cmd += ['--device', args.device]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8', cwd=args.engine)
    ready = json.loads(proc.stdout.readline())
    if not ready.get('ready'):
        print('ul-voice did not start:', ready)
        return 1
    for job in jobs:
        proc.stdin.write(json.dumps(job, ensure_ascii=False) + '\n')
    proc.stdin.flush()
    ok = bad = 0
    for _ in jobs:
        reply = json.loads(proc.stdout.readline())
        if reply.get('ok'):
            ok += 1
        else:
            bad += 1
            print('failed', reply)
    proc.stdin.close()
    proc.wait(timeout=60)
    print(f'rendered {ok}, failed {bad}; files under {OUT_ROOT}')
    return 0 if bad == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
