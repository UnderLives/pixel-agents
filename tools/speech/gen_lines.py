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
Every batch then goes through a second, strict pass of the same model (judge(): correct French,
makes sense, on topic). It keeps asking until the situation holds --target lines (default 80)
or --max-rounds is spent. coquine (the adult register) is added to every bank.
Existing lines are kept, in order, so their voice files (named by text hash) stay valid.

The 2026-10-28 banks were made with Huihui-Qwen3.8-27B-abliterated (Q4_K_M, dense, in the same
F:/llama-b8182-bin-win-cuda-12.4-x64 folder): the 35B-A3B IQ3_M wrote too much broken French for
bubbles; any OpenAI-style server on --server works.

Usage (from the repo root):
    llama-server -m Huihui-Qwen3.8-27B-abliterated-UD-DW-Q4_K_M.gguf -ngl 99 -fa on -np 8 -c 32768 --reasoning-budget 0 --port 8091
    python -I tools/speech/gen_lines.py --speakers Linda --situations done --target 20 --dry-run
    python -I tools/speech/gen_lines.py                                   every speaker, every situation
"""

import argparse
import difflib
import json
import os
import random
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
    # Adult register (owner, 2026-10-28), mixed into fillers and visit answers when the
    # pixel-agents.speechSpicy setting is on. Employees play it fully; the boss only answers it.
    'coquine': 'un moment coquin : elle aguiche le boss Aytaç, se vante de son corps et de ce qu’elle sait faire au lit, salope assumée et fière de l’être : parle cru avec des mots directs (cul, seins, chatte, sucer, baiser, jouir…), explicite et joueuse, avec un clin d’œil à son métier une fois sur trois',
}
SPICY = 'coquine'
BOSS_SPICY = 'une employée vient de l’aguicher crûment : il répond au jeu, amusé, flatté, un brin coquin, puis la ramène gentiment au travail ; jamais vulgaire'
# Fewer lines where the owner asked for "a few" (the boss answers the game, no more).
TARGETS = {('Aytaç', 'coquine'): 20}
SPICY_GUARD = (
    "Registre adulte, explicite autorisé : personnages de fiction, toutes des femmes adultes, désir "
    "partagé et enthousiaste, humour. Jamais de mineur ni d’allusion à l’âge jeune, jamais de "
    "violence ni de contrainte, jamais d’inceste, jamais le nom d’une personne réelle ou d’une célébrité. "
    "Elle parle au boss, un homme (il a une queue, pas de seins) : « je », « mon cul », « ta queue ». "
    "Des phrases françaises naturelles et complètes, drôles, qu’une vraie femme dirait en riant ; "
    "pas de métaphore absurde. Exemples du ton (ne pas les recopier) :\n"
    "Patron, j’ai mis la jupe courte, à toi de deviner le reste.\n"
    "Je suce mieux que je ne compile, et je compile très bien.\n"
    "Ferme la porte de ton bureau, j’ai une réunion urgente avec ta queue.\n"
    "Mes seins méritent une augmentation, tu ne trouves pas ?\n"
    "Je suis une salope, mais une salope très bien organisée."
)
BOSS_SPICY_GUARD = (
    "Lui reste le boss : il est flatté et s’en amuse, répond par un sous-entendu léger ou un "
    "compliment, puis ramène au travail. Pas de mot cru, rien d’explicite. Exemples du ton (ne pas "
    "les recopier) :\n"
    "Tentant… mais d’abord ton rapport.\n"
    "Garde cette énergie pour la release, on fêtera ça après."
)
BAD_ELISION = re.compile(r"(?i)(?<![a-zà-ÿ])[jdlmnst]['’](?![aeiouyhàâäéèêëîïôöùûü])")
# The prompt's own examples: never kept as lines.
EXAMPLES = [l for g in (SPICY_GUARD, BOSS_SPICY_GUARD) for l in g.split('\n')[1:]]
# Outside the adult register a crude word means the model leaked: drop the line.
CRUDE = re.compile(
    r"\b(bais\w*|bites?|chattes?|cul|culs|seins?|nichons|salopes?|suce\w*|sucer|queues?|jouir|jouis|"
    r"orgasmes?|sexe|sexy|nue?s?|fesses|lingerie|string|excit\w*|coquin\w*|braguette)\b",
    re.I,
)
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


def chat(server, system, user, temperature, max_tokens=3000):
    body = {
        'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
        'temperature': temperature,
        'max_tokens': max_tokens,
    }
    req = urllib.request.Request(
        server + '/v1/chat/completions',
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read())['choices'][0]['message']['content']


def situation_prompt(speaker, situation):
    system = (
        "Tu écris des répliques en français pour un personnage de bureau en pixel art (une bulle de "
        "bande dessinée). Une réplique par ligne, sans numéro, sans guillemets, sans emoji, sans "
        "markdown. Chaque réplique est une phrase française naturelle et complète, qui a un sens "
        "clair et qui colle à la situation, comme une vraie personne la dirait à voix haute. Ne "
        "commence jamais deux répliques de la même façon. Ton : " + COMMON_TRAIT + ". Jamais le nom "
        "d'une personne réelle, d'une célébrité ou d'une marque ; pas de vulgarité gratuite."
    )
    situation_text = SITUATIONS[situation]
    if situation == SPICY:
        if speaker == 'Aytaç':
            situation_text = BOSS_SPICY
            system += ' ' + BOSS_SPICY_GUARD
        else:
            system += ' ' + SPICY_GUARD
    return system, situation_text


def ask(server, speaker, situation, want, seeds, kept, temperature):
    gender = 'il' if speaker == 'Aytaç' else 'elle'
    system, situation_text = situation_prompt(speaker, situation)
    # The hand-written seed lines show the expected quality; a random slice of the rest steers
    # away from repeats (the last lines alone let the model drift into one-word mush).
    rest = [k for k in kept if k not in seeds]
    avoid = random.sample(rest, min(15, len(rest)))
    short, long_ = max(1, want * 3 // 10), max(1, want * 3 // 10)
    user = (
        f"Personnage : {speaker}. Style : {STYLES.get(speaker, '')}.\n"
        f"Situation : {situation_text}.\n"
        f"Le personnage parle à la première personne ({gender}).\n"
        f"Exemples du niveau attendu :\n" + '\n'.join(seeds[:10]) + "\n\n"
        f"Déjà écrites (ne les répète pas, ne les paraphrase pas) :\n" + '\n'.join(avoid) + "\n\n"
        f"Écris {want} nouvelles répliques : {short} courtes (3 à 6 mots), {want - short - long_} "
        f"moyennes (7 à 12 mots), {long_} longues (13 à 16 mots, moins de 85 caractères)."
    )
    lines = []
    for raw in chat(server, system, user, temperature).splitlines():
        t = re.sub(r'^\s*(?:[-*•]|\d+[.)])\s*', '', raw).strip().strip('"«» ').strip()
        if t:
            lines.append(finish(t))
    return lines


def finish(text):
    # The model drops the final full stop on about one line in three; bubbles and TTS want it.
    return text if text[-1] in '.!?…' or text.endswith('}') else text + '.'



def judge(server, speaker, situation, candidates):
    """A second, strict pass of the same model: keeps lines that are correct, sensible and on topic.

    The quantised model writes plenty of nonsense ("Ma queue numérique dépasse la mienne", "Je
    ajuste ici", lines about compiling under "permission"); the first full run (2026-10-28) was
    unreadable without this filter.
    """
    if not candidates:
        return []
    _, situation_text = situation_prompt(speaker, situation)
    extra = ''
    if situation == SPICY and speaker != 'Aytaç':
        extra = (" Registre adulte cru accepté (personnages adultes fictifs) ; rejette ce qui n'a pas de "
                 "sens, les métaphores absurdes, ce qui donne au boss (un homme) un corps de femme, "
                 "toute violence, contrainte ou allusion à un mineur.")
    system = (
        "Tu es une correctrice exigeante de dialogues en français. On te donne des répliques "
        "numérotées. Garde uniquement celles qui sont en français correct et naturel (grammaire, "
        "accords, élisions), qui ont un sens clair, qui collent vraiment à la situation et au "
        "personnage, et qui ne citent aucune personne réelle ni marque." + extra +
        " Réponds seulement par les numéros gardés, séparés par des virgules."
    )
    numbered = '\n'.join(f'{i + 1}. {t}' for i, t in enumerate(candidates))
    user = (f"Personnage : {speaker} ({STYLES.get(speaker, '')}).\nSituation : {situation_text}.\n\n"
            f"{numbered}")
    out = chat(server, system, user, 0.0, max_tokens=400)
    keep = {int(n) for n in re.findall(r'\d+', out)}
    return [t for i, t in enumerate(candidates) if i + 1 in keep]


def is_short(text):
    return len(text.split()) <= 6


def accept(text, kept, situation, target):
    if not text or len(text) > MAX_LEN or BLOCKLIST.search(text) or '*' in text or '#' in text:
        return False
    if situation != SPICY and CRUDE.search(text):
        return False
    # Broken elisions the quantised model makes ("J’compilation", "j’get") read badly and voice worse.
    if BAD_ELISION.search(text):
        return False
    if near_duplicate(text, EXAMPLES):
        return False
    if situation in ('visit', 'praise') and '{name}' not in text:
        return False
    # Lengths stay spread: short lines pass de-duplication most easily and would take over.
    if is_short(text) and sum(1 for k in kept if is_short(k)) >= target * 0.35:
        return False
    if near_duplicate(text, kept):
        return False
    op = opening(text)
    return sum(1 for k in kept if opening(k) == op) < 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--server', default='http://127.0.0.1:8091')
    ap.add_argument('--speakers', help='comma-separated (default: every speech/*.json)')
    ap.add_argument('--situations', help='comma-separated (default: every situation of the bank + coquine)')
    ap.add_argument('--target', type=int, default=80, help='lines per situation (60-100 advised)')
    ap.add_argument('--batch', type=int, default=25)
    ap.add_argument('--max-rounds', type=int, default=14)
    ap.add_argument('--temperature', type=float, default=0.85)
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
        if not want_sits and SPICY not in sits:
            sits.append(SPICY)
        for sit in sits:
            if sit not in SITUATIONS:
                print(f'{speaker}/{sit}: unknown situation, skipped')
                continue
            kept = list(bank['situations'].get(sit, []))
            seeds = kept[:10] or ([l for l in EXAMPLES if sit == SPICY] if speaker != 'Aytaç' else [])
            added, asked, judged_out = [], 0, 0
            target = TARGETS.get((speaker, sit), args.target)
            for _ in range(args.max_rounds):
                if len(kept) >= target:
                    break
                fresh = []
                for text in ask(args.server, speaker, sit, args.batch, seeds, kept, args.temperature):
                    asked += 1
                    if accept(text, kept + fresh, sit, target):
                        fresh.append(text)
                good = judge(args.server, speaker, sit, fresh)
                judged_out += len(fresh) - len(good)
                for text in good:
                    if len(kept) >= target:
                        break
                    kept.append(text)
                    added.append(text)
            print(f'{speaker}/{sit}: +{len(added)} -> {len(kept)} (asked {asked}, judge dropped {judged_out})',
                  flush=True)
            for t in added:
                print('   ', t, flush=True)
            bank['situations'][sit] = kept
            # Saved after every situation: one speaker per process can run in parallel
            # (llama-server -np 8), and a stopped run keeps what it made.
            if not args.dry_run:
                with open(path, 'w', encoding='utf-8', newline='\n') as out:
                    json.dump(bank, out, ensure_ascii=False, indent=2)
                    out.write('\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
