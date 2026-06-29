import hashlib
import json
import random
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
QUESTIONS_OUT = DATA / "questions.json"
SETS_OUT = DATA / "test_sets.json"

BANKS = [
    {
        "id": "comun-a-bc1",
        "name": "Comun A-BC1",
        "file": "RESPUESTAS-T.-COMUN-A-BC1.json",
        "expected": 200,
    },
    {
        "id": "comun-c2-c3-d-e",
        "name": "Comun C2-C3-D-E",
        "file": "RESPUESTAS-T.-COMUN-C2-C3-D-Y-E.json",
        "expected": 300,
    },
]


def normalize(value):
    return " ".join(str(value or "").split()).strip()


def question_id(bank_id, number, prompt):
    raw = f"{bank_id}:{number}:{prompt[:100]}".encode("utf-8", "ignore")
    return hashlib.sha1(raw).hexdigest()[:16]


def read_items(path):
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("preguntas"), list):
        return data["preguntas"]
    raise ValueError(f"Formato no reconocido en {path.name}")


def correct_key(value):
    if isinstance(value, dict):
        value = value.get("letra", "")
    return normalize(value).lower()


def import_bank(bank):
    path = DATA / bank["file"]
    items = read_items(path)
    questions = []
    for item in items:
        number = int(item["numero"])
        prompt = normalize(item["pregunta"])
        options = {
            normalize(key).lower(): normalize(value)
            for key, value in (item.get("opciones") or {}).items()
            if normalize(value)
        }
        correct = correct_key(item.get("respuesta_correcta"))
        if len(options) < 2 or correct not in options:
            raise ValueError(f"Pregunta invalida {bank['id']} #{number}")
        questions.append({
            "id": question_id(bank["id"], number, prompt),
            "bankId": bank["id"],
            "bankName": bank["name"],
            "sourceFile": bank["file"],
            "sourceNumber": number,
            "topic": bank["name"],
            "prompt": prompt,
            "options": options,
            "correctAnswer": correct,
            "impugnable": bool(item.get("impugnable", False)),
        })
    numbers = [q["sourceNumber"] for q in questions]
    if len(questions) != bank["expected"] or len(set(numbers)) != bank["expected"]:
        raise ValueError(f"{bank['id']} esperaba {bank['expected']} y tiene {len(questions)}")
    return sorted(questions, key=lambda q: q["sourceNumber"])


def make_set(pool, count, seed):
    rnd = random.Random(seed)
    by_topic = defaultdict(list)
    for question in pool:
        by_topic[question["topic"]].append(question)
    topics = sorted(by_topic)
    for questions in by_topic.values():
        questions.sort(key=lambda q: q["sourceNumber"])
        rnd.shuffle(questions)

    chosen = []
    used = set()
    cursor = rnd.randrange(max(1, len(topics)))
    while len(chosen) < count:
        topic = topics[cursor % len(topics)]
        candidates = [q for q in by_topic[topic] if q["id"] not in used]
        if not candidates:
            used.clear()
            candidates = list(by_topic[topic])
        question = candidates[len(chosen) % len(candidates)]
        chosen.append(question["id"])
        used.add(question["id"])
        cursor += 1
    return chosen


def build_test_sets(all_questions):
    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "oppositions": [],
    }
    for bank in BANKS:
        pool = [q for q in all_questions if q["bankId"] == bank["id"]]
        sets = []
        for number in range(1, 61):
            sets.append({
                "id": f"{bank['id']}-test-{number:02d}",
                "number": number,
                "mode": "test",
                "title": f"Test {number:02d}",
                "questionIds": make_set(pool, 20, f"{bank['id']}:test:{number}"),
            })
        for number in range(1, 9):
            sets.append({
                "id": f"{bank['id']}-exam-{number:02d}",
                "number": number,
                "mode": "exam",
                "title": f"Simulacro {number:02d}",
                "questionIds": make_set(pool, 100, f"{bank['id']}:exam:{number}"),
            })
        output["oppositions"].append({
            "id": bank["id"],
            "name": bank["name"],
            "sets": sets,
        })
    return output


def main():
    all_questions = []
    summaries = []
    for bank in BANKS:
        questions = import_bank(bank)
        all_questions.extend(questions)
        summaries.append({
            "id": bank["id"],
            "name": bank["name"],
            "file": bank["file"],
            "questions": len(questions),
        })
        print(f"{bank['name']}: {len(questions)} preguntas")

    QUESTIONS_OUT.write_text(json.dumps({
        "importedAt": datetime.now(timezone.utc).isoformat(),
        "banks": summaries,
        "questions": all_questions,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    SETS_OUT.write_text(json.dumps(build_test_sets(all_questions), ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Total: {len(all_questions)} preguntas")


if __name__ == "__main__":
    main()
