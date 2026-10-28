"""Grow the speech banks (speech/<slug>.json) with a local Qwen, ahead of time.

Lines are always pre-generated: the office never asks a model anything at run time. Run this in a
quiet GPU moment, review the diff, commit. For each speaker and situation it asks the local
llama-server (the one the game's Tools/ModLoc/machine_translate.py uses: OpenAI-style
/v1/chat/completions, default http://127.0.0.1:8091, Qwen3.6-35B-A3B, thinking off) for lines in
French in the speaker's voice, then keeps only lines that are:
  - short enough for a bubble (<= 90 characters), not empty, no quotes/markdown;
  - new: not a near-duplicate of a kept line (normalised text, difflib ratio >= 0.82, or word
    Jaccard >= 0.6 — a simple semantic de-duplication);
  - varied: at most 2 lines per situation may open with the same two words, and lengths are
    spread (the prompt asks for short, medium and long ones);
  - on tone: nothing plaintive or sarcastic (a small blocklist), the shared trait being
    "motivante" (motivating: encourages, positive, proud of the work, a little humour).
It keeps asking until the situation holds --target lines (default 80) or --max-rounds is spent.
Existing lines are kept, in order, so their voice files (named by text hash) stay valid.

Usage (from the repo root):
    llama-server -m Qwen3.6-35B-A3B-...gguf -ngl 99 -fa on -np 8 -c 32768 --reasoning-budget 0 --port 8091
    python -I tools/speech/gen_lines.py --speakers Linda --situations done --target 20 --dry-run
    python -I tools/speech/gen_lines.py                                   every speaker, every situation
"""

import argparse
import difflib
import json
import os
import re
import socket
import sys
import unicodedata
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEECH = os.path.join(ROOT, 'speech')

SITUATIONS = {
    'start_item': 'elle commence une nouvelle tâche que le boss vient de lui confier',
    'building': 'elle lance une compilation (build) et attend qu’elle finisse',
    'waiting_lock': 'la machine partagée est prise par une collègue, elle attend son tour sans râler',
    'reading': 'elle lit des fichiers, du code ou de la documentation pour comprendre',
    'editing': 'elle modifie un fichier, écrit ou corrige',
    'running_game': 'elle lance le jeu pour vérifier son travail à l’écran',
    'done': 'elle vient de terminer sa tâche et en est fière',
    'permission': 'elle a besoin que le boss valide une action avant de continuer',
    'error': 'une erreur vient d’arriver ; elle reste positive et repart',
    'filler': 'un moment calme : une petite remarque personnelle liée à son métier ou à sa passion',
    'motivation': 'elle encourage le boss ou une collègue nommée (Linda, Maya, Nora, Sacha, Iris, Léa, Zoé)',
    # The boss's own.
    'visit': 'il passe au bureau d’une employée ; utilise {name} pour son prénom',
    'praise': 'une employée vient de finir ; il la félicite ; utilise {name} pour son prénom',
}
COMMON_TRAIT = 'motivante (encourage, positive, fière de son travail, un peu d’humour, jamais plaintive ni sarcastique)'
STYLES = {
    'Linda': 'coquette et précise ; vêtements et couture (ourlet, coupe, tissu, essayage)',
    'Maya': 'posée, œil d’architecte ; pièces et meubles (plan, lumière, proportions)',
    'Nora': 'geek du moteur ; PNJ et C++ (compilateur, pointeurs, Unreal)',
    'Sacha': 'chasseuse de mégaoctets ; taille du jeu et sorties (octets, compression, release)',
    'Iris': 'danseuse ; mouvement et animation (rythme, tempo, chorégraphie)',
    'Léa': 'polyglotte ; traduction (nuances, glisse des mots d’autres langues)',
    'Zoé': 'bricoleuse ; outillage et scripts (établi, clé à molette, automatiser)',
    'Aytaç': 'le boss, chef d’orchestre : bref, chaleureux, fier de son équipe (masculin)',
}
BLOCKLIST = re.compile(
    r"\b(marre|nul(le)?|déteste|pfff+|ras[- ]le[- ]bol|j'en peux plus|ennuyeux|pénible|idiot|stupide|"
    r"évidemment que non|bien sûr que non|super, encore)\b",
    re.I,
)
MAX_LEN = 90


def slug(name):
    return unicodedata.normalize('NFD', name).encode('ascii', 'ignore').decode().lower()


def norm(text):
    t = unicodedata.normalize('NFD', text.lower()).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9 ]+', ' ', t).split()


def near_duplicate(text, kept):
    a = ' '.join(norm(text))
    wa = set(a.split())
    for k in kept:
        b = ' '.join(norm(k))
        if difflib.SequenceMatcher(None, a, b).ratio() >= 0.82:
            return True
        wb = set(b.split())
        if wa and wb and len(wa & wb) / len(wa | wb) >= 0.6:
            return True
    return False


def opening(text):
    return ' '.join(norm(text)[:2])


def server_up(server):
    u = urllib.parse.urlparse(server)
    try:
        with socket.create_connection((u.hostname, u.port or 80), timeout=2):
            return True
    except OSError:
        return False


def ask(server, speaker, situation, want, kept, temperature):
    gender = 'il' if speaker == 'Aytaç' else 'elle'
    system = (
        "Tu écris des répliques courtes en français pour un personnage de bureau en pixel art "
        "(une bulle de bande dessinée). Une réplique par ligne, sans numéro, sans guillemets, sans "
        "emoji, sans markdown. Varie la longueur (des très courtes de 3-5 mots, des moyennes, des "
        "longues jusqu'à 80 caractères) et les tournures : ne commence jamais deux répliques de la "
        "même façon. Ton : " + COMMON_TRAIT + "."
    )
    sample = '\n'.join(kept[-12:])
    user = (
        f"Personnage : {speaker}. Style : {STYLES.get(speaker, '')}.\n"
        f"Situation : {SITUATIONS[situation]}.\n"
        f"Le personnage parle à la première personne ({gender}).\n"
        f"Déjà écrites (ne les répète pas, ne les paraphrase pas) :\n{sample}\n\n"
        f"Écris {want} nouvelles répliques différentes."
    )
    body = {
        'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
        'temperature': temperature,
        'max_tokens': 3000,
    }
    req = urllib.request.Request(
        server + '/v1/chat/completions',
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        out = json.loads(r.read())['choices'][0]['message']['content']
    lines = []
    for raw in out.splitlines():
        t = re.sub(r'^\s*(?:[-*•]|\d+[.)])\s*', '', raw).strip().strip('"«» ').strip()
        if t:
            lines.append(t)
    return lines


def accept(text, kept, situation):
    if not text or len(text) > MAX_LEN or BLOCKLIST.search(text) or '*' in text or '#' in text:
        return False
    if situation in ('visit', 'praise') and '{name}' not in text:
        return False
    if near_duplicate(text, kept):
        return False
    op = opening(text)
    return sum(1 for k in kept if opening(k) == op) < 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--server', default='http://127.0.0.1:8091')
    ap.add_argument('--speakers', help='comma-separated (default: every speech/*.json)')
    ap.add_argument('--situations', help='comma-separated (default: every situation of the bank)')
    ap.add_argument('--target', type=int, default=80, help='lines per situation (60-100 advised)')
    ap.add_argument('--batch', type=int, default=20)
    ap.add_argument('--max-rounds', type=int, default=8)
    ap.add_argument('--temperature', type=float, default=0.9)
    ap.add_argument('--dry-run', action='store_true', help='print what would be added, write nothing')
    args = ap.parse_args()

    if not server_up(args.server):
        print(f'No model server at {args.server}: start llama-server first (see the header). Nothing done.')
        return 2
    want_speakers = {s.strip() for s in args.speakers.split(',')} if args.speakers else None
    want_sits = [s.strip() for s in args.situations.split(',')] if args.situations else None

    for f in sorted(os.listdir(SPEECH)):
        if not f.endswith('.json'):
            continue
        path = os.path.join(SPEECH, f)
        bank = json.load(open(path, encoding='utf-8'))
        speaker = bank['speaker']
        if want_speakers and speaker not in want_speakers:
            continue
        sits = want_sits or list(bank['situations'])
        for sit in sits:
            if sit not in SITUATIONS:
                print(f'{speaker}/{sit}: unknown situation, skipped')
                continue
            kept = list(bank['situations'].get(sit, []))
            added = []
            for _ in range(args.max_rounds):
                if len(kept) >= args.target:
                    break
                for text in ask(args.server, speaker, sit, min(args.batch, args.target - len(kept) + 5), kept, args.temperature):
                    if len(kept) >= args.target:
                        break
                    if accept(text, kept, sit):
                        kept.append(text)
                        added.append(text)
            print(f'{speaker}/{sit}: +{len(added)} -> {len(kept)}')
            for t in added:
                print('   ', t)
            bank['situations'][sit] = kept
        if not args.dry_run:
            with open(path, 'w', encoding='utf-8', newline='\n') as out:
                json.dump(bank, out, ensure_ascii=False, indent=2)
                out.write('\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
