"""Render every speech line with its speaker's fixed voice, ahead of time (never at run time).

Uses the game's own voice runtime: ul-voice.exe from the ul_Voices mod (qwentts.cpp, Qwen3-TTS 0.6B
CustomVoice Q8, one JSON request per stdin line, see Tools/Voice/ul-voice.cpp in the game repo),
with each speaker's speech/voices/<slug>.spk (tools/speech/make_voices.py: a blend of free
speakers, never a real person's voice) passed as spk_b64. French, temperature 0.6 / sub 0.9 as in
the game.

Output: ~/.pixel-agents/speech/<speaker lower-case>/<id>.ogg (Opus 48 kb/s through ffmpeg, the
WAV is dropped; --wav keeps WAV: ~8x larger, 1 GB+ for the full banks), id = sha1(text)[:10] (the same id the
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
import concurrent.futures
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
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
# The adult register (situation "coquine") gets its own delivery.
SPICY_INSTRUCT = 'sultry, teasing and playful, low breathy voice, smiling'
BOSS_SPICY_INSTRUCT = 'amused and flattered, warm male voice, a knowing smile'
AUDIO_EXTS = ('.ogg', '.wav', '.mp3')


def instruct_for(speaker, situation):
    if situation == 'coquine':
        return BOSS_SPICY_INSTRUCT if speaker == 'Aytaç' else SPICY_INSTRUCT
    return INSTRUCT.get(speaker, 'warm, friendly')


def to_ogg(ffmpeg, wav, final_dir=None):
    # Opus at 48 kb/s: speech stays clean and the full banks fit in ~150 MB instead of 1 GB+.
    # ul-voice.exe opens its output path with a narrow fopen: a speaker folder like 'léa' or
    # 'aytaç' made every line fail (2026-10-28). The WAV is rendered under an ASCII folder and the
    # OGG lands in the speaker's real folder here, where Python handles Unicode paths.
    ogg = os.path.join(final_dir, os.path.basename(wav)[:-4] + '.ogg') if final_dir else wav[:-4] + '.ogg'
    # Qwen3-TTS leaves ~1.2 s of silence before and ~1 s after the voice: trimmed, so the voice
    # starts with the bubble (a little tail is kept).
    trim = ('silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,'
            'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.2,areverse')
    r = subprocess.run([ffmpeg, '-v', 'error', '-y', '-i', wav, '-af', trim, '-c:a', 'libopus', '-b:a', '48k', ogg],
                       capture_output=True)
    if r.returncode == 0 and os.path.getsize(ogg) > 0:
        os.remove(wav)
        return True
    print('ffmpeg failed on', wav, r.stderr.decode(errors='replace')[:200])
    return False


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
    ap.add_argument('--wav', action='store_true', help='keep WAV instead of converting to Ogg Opus')
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
        ren_dir = os.path.join(OUT_ROOT, '_render', slug(speaker))
        os.makedirs(ren_dir, exist_ok=True)
        n = 0
        for situation, lines in bank['situations'].items():
            for item in lines:
                text = item if isinstance(item, str) else item['text']
                lid = item.get('id') if isinstance(item, dict) and item.get('id') else line_id(text)
                out = os.path.join(ren_dir, f'{lid}.wav')
                done = any(os.path.exists(os.path.join(out_dir, lid + e)) for e in AUDIO_EXTS)
                if done or not spoken(text, speaker):
                    continue
                if args.limit and n >= args.limit:
                    break
                n += 1
                jobs.append({
                    'id': len(jobs) + 1,
                    'text': text,
                    'instruct': instruct_for(speaker, situation),
                    'spk_b64': spk_b64,
                    'lang': 'french',
                    'seed': int(lid[:6], 16),
                    'out': out.replace('\\', '/'),
                    'final_dir': out_dir,
                })
        print(f'{speaker}: {n} line(s) to render')
    if not jobs:
        print('nothing to render')
        return 0

    ffmpeg = None if args.wav else shutil.which('ffmpeg')
    if not args.wav and not ffmpeg:
        print('no ffmpeg on PATH: keeping WAV')
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)
    conversions = []
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
    seconds = gpu_ms = 0.0
    by_id = {j['id']: j for j in jobs}
    t0 = time.time()
    for i in range(len(jobs)):
        reply = json.loads(proc.stdout.readline())
        if reply.get('ok'):
            ok += 1
            seconds += reply.get('seconds', 0)
            gpu_ms += reply.get('ms', 0)
            if ffmpeg:
                conversions.append(pool.submit(to_ogg, ffmpeg, by_id[reply['id']]['out'], by_id[reply['id']]['final_dir']))
            if (i + 1) % 200 == 0:
                print(f'  {i + 1}/{len(jobs)} in {time.time() - t0:.0f} s', flush=True)
        else:
            bad += 1
            print('failed', reply)
    proc.stdin.close()
    proc.wait(timeout=60)
    converted = sum(1 for c in conversions if c.result())
    pool.shutdown()
    print(f'rendered {ok}, failed {bad}, {seconds:.0f} s of speech, {gpu_ms / 1000:.0f} s of synthesis, '
          f'{time.time() - t0:.0f} s wall; {converted} converted to ogg; files under {OUT_ROOT}')
    return 0 if bad == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
