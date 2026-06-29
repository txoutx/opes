import hashlib
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    import pdfplumber
except ImportError as exc:
    raise SystemExit("Falta pdfplumber. Ejecuta el importador con el Python incluido en Codex o instala pdfplumber.") from exc

ROOT = Path(__file__).resolve().parents[1]
PDF_DIR = Path(r"C:\Users\Adrian\Desktop\Nueva carpeta (2)")
OUT = ROOT / "data" / "questions.json"

BANKS = [
    {
        "id": "comun-a-bc1",
        "name": "Comun A-BC1",
        "file": "RESPUESTAS-T.-COMUN-A-BC1.pdf",
        "mode": "inline",
    },
    {
        "id": "comun-c2-c3-d-e",
        "name": "Comun C2-C3-D-E",
        "file": "RESPUESTAS-T.-COMUN-C2-C3-D-Y-E.pdf",
        "mode": "inline",
    },
    {
        "id": "tec-admin-gestion",
        "name": "Tecnico/a Medio Administracion y Gestion",
        "file": "RESPUESTAS-T.-ESPECIFICO-SUPUESTOS-PRACTICOS-TECNICOA-SUPERIOR-DE-ADMINISTRACION-Y-GESTION.pdf",
        "mode": "inline",
    },
    {
        "id": "tec-esp-informatica",
        "name": "Tecnico/a Especialista Informatica",
        "file": "TEC_ESP_INFORMATICA_respuestas_marcadas.pdf",
        "mode": "marked",
    },
    {
        "id": "tec-sup-informatica",
        "name": "Tecnico/a Superior Informatica",
        "file": "TEC_SUPERIOR_INFORMATICA_respuestas_marcadas.pdf",
        "mode": "marked",
    },
    {
        "id": "tec-sup-organizacion",
        "name": "Tecnico/a Superior Organizacion",
        "file": "TEC_SUP_ORGANIZACION_respuestas_marcadas.pdf",
        "mode": "marked",
    },
    {
        "id": "tec-sup-economico",
        "name": "Tecnico/a Superior Economico/a",
        "file": "TEC_SUP_ECONOMICO_respuestas_marcadas.pdf",
        "mode": "marked",
    },
]


def normalize(text):
    return re.sub(r"\s+", " ", text.replace("\ufb01", "fi").replace("\ufb02", "fl")).strip()


def question_id(bank_id, number, prompt):
    raw = f"{bank_id}:{number}:{prompt[:80]}".encode("utf-8", "ignore")
    return hashlib.sha1(raw).hexdigest()[:16]


def infer_topic(prompt):
    clean = normalize(prompt)
    if "." in clean[:90]:
        candidate = clean.split(".", 1)[0]
        if 4 <= len(candidate) <= 80 and not candidate.startswith(("¿", "Que", "Qué", "Cuál", "Cual")):
            return candidate
    return "General"


def explanation(correct_key, options):
    correct = normalize(options.get(correct_key, ""))
    if not correct:
        return "La respuesta correcta es la opcion indicada en el PDF original."
    return f"Es la correcta porque el enunciado se resuelve con: {correct[:220]}."


def as_question(bank, number, prompt, options, correct):
    options = {k: normalize(v) for k, v in options.items() if normalize(v)}
    if len(options) < 2 or correct not in options:
        return None
    prompt = normalize(prompt)
    if len(prompt) < 12:
        return None
    return {
        "id": question_id(bank["id"], number, prompt),
        "bankId": bank["id"],
        "bankName": bank["name"],
        "sourceFile": bank["file"],
        "sourceNumber": number,
        "topic": infer_topic(prompt),
        "prompt": prompt,
        "options": options,
        "correctAnswer": correct,
        "explanation": explanation(correct, options),
    }


def parse_inline(bank, text):
    text = text.replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    question_re = re.compile(r"(?m)^\s*(\d{1,4})[.\-]\s+")
    matches = list(question_re.finditer(text))
    questions = []
    for idx, match in enumerate(matches):
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        number = int(match.group(1))
        block = text[start:end]
        opt_re = re.compile(r"(?is)(?:^|\n)\s*\(?([abcd])\)\s*(.*?)(?=(?:\n\s*\(?[abcd]\)\s*)|\Z)")
        opts = list(opt_re.finditer(block))
        if len(opts) < 2:
            continue
        prompt = block[: opts[0].start()]
        options = {}
        correct = None
        for opt in opts:
            key = opt.group(1).lower()
            value = normalize(re.sub(r"\(\s*(?:In)?Correcta\s*\)", "", opt.group(2), flags=re.I))
            options[key] = value
            if re.search(r"\(\s*Correcta\s*\)", opt.group(2), flags=re.I):
                correct = key
        q = as_question(bank, number, prompt, options, correct)
        if q:
            questions.append(q)
    return questions


def is_red(value):
    return isinstance(value, tuple) and len(value) >= 3 and value[0] > 0.8 and value[1] < 0.25 and value[2] < 0.25


def page_lines(page):
    words = page.extract_words(x_tolerance=2, y_tolerance=3, keep_blank_chars=False)
    drawn_mark_tops = []
    for line in page.lines:
        if line.get("x0", 999) < 120 and is_red(line.get("stroking_color")):
            drawn_mark_tops.append((line["top"] + line["bottom"]) / 2)

    buckets = defaultdict(list)
    for word in words:
        top = round(word["top"] / 3) * 3
        buckets[top].append(word)
    lines = []
    for top in sorted(buckets):
        row = sorted(buckets[top], key=lambda w: w["x0"])
        text = " ".join(w["text"] for w in row)
        marks = [w for w in row if w["text"] in {"✓", ">>", "·", "•"}]
        if any(abs(mark_top - top) <= 12 for mark_top in drawn_mark_tops):
            marks.append({"text": "drawn-check", "top": top})
        lines.append({"top": top, "text": text, "words": row, "marks": marks})
    return lines


def parse_marked(bank, pdf):
    blocks = []
    current = None
    option_re = re.compile(r"^([abcd])\)\s*(.*)", re.I)
    question_re = re.compile(r"^(\d{1,4})\s*(?:\.|-|\.-)\s*(.*)")

    for page in pdf.pages:
        for line in page_lines(page):
            text = normalize(line["text"])
            if not text:
                continue
            match = question_re.match(text)
            if match:
                if current:
                    blocks.append(current)
                current = {
                    "number": int(match.group(1)),
                    "prompt": [match.group(2)],
                    "options": {},
                    "correct": None,
                    "last_option": None,
                }
                continue
            if not current:
                continue
            option = option_re.match(text.replace("✓ ", "").replace(">> ", "").replace("· ", "").replace("• ", ""))
            if option:
                key = option.group(1).lower()
                current["options"][key] = option.group(2)
                current["last_option"] = key
                if line["marks"] or text.startswith(("✓", ">>", "·", "•")):
                    current["correct"] = key
                continue
            if line["marks"]:
                option_words = [w for w in line["words"] if re.match(r"^[abcd]\)$", w["text"], re.I)]
                if option_words:
                    current["correct"] = option_words[0]["text"][0].lower()
                continue
            if current["last_option"]:
                current["options"][current["last_option"]] += " " + text
            else:
                current["prompt"].append(text)
    if current:
        blocks.append(current)

    questions = []
    for block in blocks:
        q = as_question(bank, block["number"], " ".join(block["prompt"]), block["options"], block["correct"])
        if q:
            questions.append(q)
    return questions


def extract_bank(bank):
    pdf_path = PDF_DIR / bank["file"]
    if not pdf_path.exists():
        print(f"AVISO: no encontrado {pdf_path}", file=sys.stderr)
        return []
    with pdfplumber.open(str(pdf_path)) as pdf:
        if bank["mode"] == "inline":
            text = "\n".join(page.extract_text(x_tolerance=2, y_tolerance=3) or "" for page in pdf.pages)
            return parse_inline(bank, text)
        return parse_marked(bank, pdf)


def main():
    all_questions = []
    bank_summaries = []
    for bank in BANKS:
        questions = extract_bank(bank)
        all_questions.extend(questions)
        bank_summaries.append({k: bank[k] for k in ("id", "name", "file")})
        bank_summaries[-1]["questions"] = len(questions)
        print(f"{bank['name']}: {len(questions)} preguntas")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "importedAt": datetime.now(timezone.utc).isoformat(),
                "banks": bank_summaries,
                "questions": all_questions,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Total: {len(all_questions)} preguntas -> {OUT}")


if __name__ == "__main__":
    main()
