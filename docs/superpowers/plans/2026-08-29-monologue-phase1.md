# Monologue Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-only web app where the user practices English and Japanese speaking with a local LLM bot across three modes (free roleplay, script roleplay, lesson), receiving grammar corrections, better-phrasing suggestions, and an end-of-session report with an automatic level estimate.

**Architecture:** A single FastAPI process serves a vanilla-JS page and owns all logic. It calls a natively-installed Ollama for the LLM, runs Kokoro in-process for English TTS, and calls a Dockerised VOICEVOX over HTTP for Japanese TTS. Speech-to-text happens in the browser via the Web Speech API; the browser also records the raw audio in parallel and uploads it for later use. All state lives in one SQLite file behind a thin hand-written data layer.

**Tech Stack:** Python 3.13, FastAPI, uvicorn, stdlib `sqlite3`, `kokoro-onnx`, `soundfile`, VOICEVOX Docker engine, Ollama (`qwen2.5:14b`), vanilla JS + Web Speech API + MediaRecorder, pytest.

**Spec:** `docs/superpowers/specs/2026-08-29-monologue-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Repo root:** `C:\git\Monologue`. Interpreter: `venv\Scripts\python.exe` (Python 3.13.1). Never use system Python.
- **Ollama:** native install, `http://127.0.0.1:11434`, model `qwen2.5:14b`.
- **VOICEVOX:** Docker (`docker compose up -d`), `http://127.0.0.1:50021`. Japanese TTS only.
- **Kokoro:** in-process. Model files already at `engines/kokoro/kokoro-v1.0.onnx` and `engines/kokoro/voices-v1.0.bin`. English TTS only.
- **English voices (US accent only — never expose `bf_`/`bm_` British voices):** `am_adam` (default), `am_fenrir`, `af_heart`, `af_bella`, `af_kore`.
- **Japanese voices (VOICEVOX speaker ids):** `21` 剣崎雌雄 (default), `13` 青山龍星, `74` 琴詠ニア, `8` 春日部つむぎ.
- **Languages:** exactly `en` and `ja`. **Modes:** exactly `free`, `script`, `lesson`.
- **Levels:** exactly `beginner`, `intermediate`, `advanced`. Default when no history: `beginner`.
- **Bot replies:** 1–3 sentences, contractions, colloquial, no markdown, no emoji, no lists, no parenthetical asides.
- **Corrections and suggestions:** at most 2 sentences each.
- **TTS sanitisation applies to the TTS input only.** Screen display and DB rows always store the original text.
- **SQLite:** stdlib `sqlite3`, WAL mode on, no ORM. All DB access goes through `app/db.py`.
- **Target browser:** Chrome.
- **Commit after every task.** Run `venv\Scripts\python.exe -m pytest` before each commit.

---

## File Structure

| Path | Responsibility |
|---|---|
| `requirements.txt` | Pinned Python dependencies |
| `app/config.py` | Paths, service URLs, voice catalogues, defaults, limits |
| `app/db.py` | SQLite schema + all queries. The only module touching the DB |
| `app/scenarios.py` | Load and query `data/scenarios.json` |
| `app/text_cleanup.py` | Strip markdown/emoji and cap length before TTS |
| `app/tts/__init__.py` | `synthesize()` dispatcher, on-disk cache, browser-fallback signalling |
| `app/tts/kokoro_backend.py` | English synthesis via Kokoro |
| `app/tts/voicevox_backend.py` | Japanese synthesis via VOICEVOX HTTP |
| `app/llm.py` | Ollama chat client, structured-output support, health check |
| `app/prompts.py` | System prompt assembly for the 3 modes, feedback, report |
| `app/api.py` | All HTTP routes; thin, delegates to the modules above |
| `app/main.py` | FastAPI app creation, static mount, startup init |
| `data/scenarios.json` | Seed scenarios for both languages, both scenario types |
| `static/index.html` | Single page shell |
| `static/app.js` | Session flow, STT, recording, audio playback, settings |
| `static/style.css` | Styling |
| `tests/` | pytest suite |
| `README.md` | Setup and run instructions |

---

### Task 1: Environment setup — Ollama, dependencies, config module

**Files:**
- Create: `requirements.txt`
- Create: `app/__init__.py`
- Create: `app/config.py`
- Create: `tests/__init__.py`
- Create: `tests/test_config.py`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `app.config` module exposing `REPO_ROOT`, `DATA_DIR`, `AUDIO_DIR`, `TTS_CACHE_DIR`, `DB_PATH`, `KOKORO_MODEL`, `KOKORO_VOICES`, `OLLAMA_URL: str`, `OLLAMA_MODEL: str`, `VOICEVOX_URL: str`, `LANGUAGES: tuple[str, str]`, `MODES: tuple[str, str, str]`, `LEVELS: tuple[str, str, str]`, `VOICE_CATALOG: dict[str, list[dict]]`, `DEFAULT_VOICE: dict[str, str]`, `PREVIEW_TEXT: dict[str, str]`, `MAX_TTS_CHARS: int`, `DEFAULT_MAX_TURNS: int`

- [ ] **Step 1: Install Ollama natively**

Run in PowerShell:

```powershell
winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
```

Then open a **new** shell (so `PATH` refreshes) and verify:

```powershell
ollama --version
```

Expected: a version string. If `ollama` is still not found, log out and back in.

- [ ] **Step 2: Pull the model and confirm it answers**

```powershell
ollama pull qwen2.5:14b
```

This downloads roughly 9 GB. Then:

```powershell
ollama run qwen2.5:14b "Reply with exactly: ready"
```

Expected: the model replies (wording may vary; any coherent reply proves it works).

- [ ] **Step 3: Confirm the HTTP API is reachable**

```powershell
curl.exe -s http://127.0.0.1:11434/api/tags
```

Expected: JSON containing `qwen2.5:14b`. If the daemon is not running, start it with `ollama serve` in a separate window.

- [ ] **Step 4: Write `requirements.txt`**

```text
fastapi==0.115.6
uvicorn[standard]==0.34.0
python-multipart==0.0.20
httpx==0.28.1
kokoro-onnx==0.6.1
soundfile==0.14.0
numpy==2.5.2
pytest==8.3.4
```

- [ ] **Step 5: Install dependencies**

```powershell
C:\git\Monologue\venv\Scripts\python.exe -m pip install -r C:\git\Monologue\requirements.txt
```

Expected: completes without error. `kokoro-onnx`, `soundfile`, `numpy` are already present and will be reported as satisfied.

- [ ] **Step 6: Write the failing test**

Create `tests/__init__.py` as an empty file, and `tests/test_config.py`:

```python
from app import config


def test_languages_and_modes_are_exactly_as_specified():
    assert config.LANGUAGES == ("en", "ja")
    assert config.MODES == ("free", "script", "lesson")
    assert config.LEVELS == ("beginner", "intermediate", "advanced")


def test_english_catalog_has_five_us_voices_and_no_british_ones():
    ids = [v["id"] for v in config.VOICE_CATALOG["en"]]
    assert ids == ["am_adam", "am_fenrir", "af_heart", "af_bella", "af_kore"]
    assert not any(i.startswith(("bf_", "bm_")) for i in ids)


def test_japanese_catalog_has_four_voicevox_speakers():
    ids = [v["id"] for v in config.VOICE_CATALOG["ja"]]
    assert ids == ["21", "13", "74", "8"]


def test_defaults_point_at_catalog_entries():
    assert config.DEFAULT_VOICE == {"en": "am_adam", "ja": "21"}
    for lang, voice in config.DEFAULT_VOICE.items():
        assert voice in [v["id"] for v in config.VOICE_CATALOG[lang]]


def test_kokoro_model_files_are_present():
    assert config.KOKORO_MODEL.exists()
    assert config.KOKORO_VOICES.exists()
```

- [ ] **Step 7: Run test to verify it fails**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app'`

- [ ] **Step 8: Write `app/__init__.py` and `app/config.py`**

`app/__init__.py` is an empty file.

`app/config.py`:

```python
"""Central configuration. Paths, service endpoints, catalogues, limits."""
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = REPO_ROOT / "data"
AUDIO_DIR = REPO_ROOT / "audio"
TTS_CACHE_DIR = REPO_ROOT / "tts_cache"
STATIC_DIR = REPO_ROOT / "static"
DB_PATH = REPO_ROOT / "monologue.db"

KOKORO_MODEL = REPO_ROOT / "engines" / "kokoro" / "kokoro-v1.0.onnx"
KOKORO_VOICES = REPO_ROOT / "engines" / "kokoro" / "voices-v1.0.bin"

OLLAMA_URL = "http://127.0.0.1:11434"
OLLAMA_MODEL = "qwen2.5:14b"
VOICEVOX_URL = "http://127.0.0.1:50021"

LANGUAGES = ("en", "ja")
MODES = ("free", "script", "lesson")
LEVELS = ("beginner", "intermediate", "advanced")

# English: US accent only. British voices (bf_/bm_) are deliberately excluded so
# the learner is never modelling a mixed accent.
VOICE_CATALOG = {
    "en": [
        {"id": "am_adam", "label": "Adam", "gender": "male"},
        {"id": "am_fenrir", "label": "Fenrir", "gender": "male"},
        {"id": "af_heart", "label": "Heart", "gender": "female"},
        {"id": "af_bella", "label": "Bella", "gender": "female"},
        {"id": "af_kore", "label": "Kore", "gender": "female"},
    ],
    # VOICEVOX speaker ids, default ("ノーマル") style only.
    "ja": [
        {"id": "21", "label": "剣崎雌雄", "gender": "male"},
        {"id": "13", "label": "青山龍星", "gender": "male"},
        {"id": "74", "label": "琴詠ニア", "gender": "female"},
        {"id": "8", "label": "春日部つむぎ", "gender": "female"},
    ],
}

DEFAULT_VOICE = {"en": "am_adam", "ja": "21"}

PREVIEW_TEXT = {
    "en": "Hi! Do you have a reservation? I can seat you by the window.",
    "ja": "いらっしゃいませ。ご予約はされていますか？",
}

MAX_TTS_CHARS = 400
DEFAULT_MAX_TURNS = 8
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_config.py -v`
Expected: 5 passed

- [ ] **Step 10: Commit**

```bash
git add requirements.txt app/__init__.py app/config.py tests/__init__.py tests/test_config.py
git commit -m "feat: add config module and pin dependencies"
```

---

### Task 2: SQLite data layer

**Files:**
- Create: `app/db.py`
- Create: `tests/test_db.py`

**Interfaces:**
- Consumes: `app.config.DB_PATH`
- Produces: `app.db` with `connect() -> sqlite3.Connection`, `init_db(path=None) -> None`, `create_session(language, mode, scenario_id=None, topic=None) -> int`, `get_session(session_id) -> dict | None`, `add_message(session_id, speaker, text, correction=None, suggestion=None) -> int`, `get_messages(session_id) -> list[dict]`, `set_message_audio(message_id, audio_path) -> None`, `end_session(session_id, report, level) -> None`, `latest_level(language) -> str`, `list_sessions(limit=20) -> list[dict]`, `get_setting(key, default=None) -> str | None`, `set_setting(key, value) -> None`

- [ ] **Step 1: Write the failing test**

Create `tests/test_db.py`:

```python
import pytest

from app import db


@pytest.fixture()
def store(tmp_path, monkeypatch):
    path = tmp_path / "test.db"
    monkeypatch.setattr(db.config, "DB_PATH", path)
    db.init_db()
    return db


def test_create_session_returns_id_and_roundtrips(store):
    sid = store.create_session("en", "free", scenario_id="airport-checkin-en")
    row = store.get_session(sid)
    assert row["language"] == "en"
    assert row["mode"] == "free"
    assert row["scenario_id"] == "airport-checkin-en"
    assert row["started_at"] is not None
    assert row["ended_at"] is None
    assert row["report"] is None


def test_lesson_session_stores_topic_and_null_scenario(store):
    sid = store.create_session("ja", "lesson", topic="て form")
    row = store.get_session(sid)
    assert row["scenario_id"] is None
    assert row["topic"] == "て form"


def test_messages_keep_insertion_order_and_feedback(store):
    sid = store.create_session("en", "free")
    store.add_message(sid, "bot", "Hi there!")
    store.add_message(
        sid, "user", "I go to store yesterday",
        correction="Use the past tense: I went to the store yesterday.",
        suggestion="More natural: I hit the store yesterday.",
    )
    msgs = store.get_messages(sid)
    assert [m["speaker"] for m in msgs] == ["bot", "user"]
    assert [m["turn"] for m in msgs] == [1, 2]
    assert msgs[1]["correction"].startswith("Use the past tense")
    assert msgs[0]["correction"] is None


def test_set_message_audio_attaches_path(store):
    sid = store.create_session("en", "free")
    mid = store.add_message(sid, "user", "Hello")
    store.set_message_audio(mid, "audio/1.webm")
    assert store.get_messages(sid)[0]["audio_path"] == "audio/1.webm"


def test_end_session_records_report_and_level(store):
    sid = store.create_session("en", "free")
    store.end_session(sid, "You did well.", "intermediate")
    row = store.get_session(sid)
    assert row["report"] == "You did well."
    assert row["level"] == "intermediate"
    assert row["ended_at"] is not None


def test_latest_level_defaults_to_beginner_then_follows_last_ended_session(store):
    assert store.latest_level("en") == "beginner"
    first = store.create_session("en", "free")
    store.end_session(first, "r", "intermediate")
    assert store.latest_level("en") == "intermediate"
    second = store.create_session("en", "lesson")
    store.end_session(second, "r", "advanced")
    assert store.latest_level("en") == "advanced"


def test_latest_level_is_scoped_per_language(store):
    sid = store.create_session("en", "free")
    store.end_session(sid, "r", "advanced")
    assert store.latest_level("ja") == "beginner"


def test_unfinished_sessions_do_not_affect_latest_level(store):
    done = store.create_session("en", "free")
    store.end_session(done, "r", "advanced")
    store.create_session("en", "free")  # still open, level is NULL
    assert store.latest_level("en") == "advanced"


def test_settings_get_set_and_default(store):
    assert store.get_setting("voice_en") is None
    assert store.get_setting("voice_en", "am_adam") == "am_adam"
    store.set_setting("voice_en", "af_kore")
    assert store.get_setting("voice_en") == "af_kore"
    store.set_setting("voice_en", "am_fenrir")
    assert store.get_setting("voice_en") == "am_fenrir"


def test_list_sessions_returns_newest_first(store):
    a = store.create_session("en", "free")
    b = store.create_session("ja", "lesson")
    ids = [s["id"] for s in store.list_sessions()]
    assert ids == [b, a]


def test_wal_mode_is_enabled(store):
    with store.connect() as conn:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "wal"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_db.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.db'`

- [ ] **Step 3: Write `app/db.py`**

```python
"""SQLite data layer. The only module that touches the database.

No ORM: three tables do not justify one, and keeping the surface small means a
future storage swap only rewrites this file.
"""
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from app import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    language    TEXT    NOT NULL,
    mode        TEXT    NOT NULL,
    scenario_id TEXT,
    topic       TEXT,
    started_at  TEXT    NOT NULL,
    ended_at    TEXT,
    report      TEXT,
    level       TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    INTEGER NOT NULL REFERENCES sessions(id),
    turn          INTEGER NOT NULL,
    speaker       TEXT    NOT NULL,
    text          TEXT    NOT NULL,
    correction    TEXT,
    suggestion    TEXT,
    audio_path    TEXT,
    pronunciation TEXT,
    created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, turn);
CREATE INDEX IF NOT EXISTS idx_sessions_language ON sessions(language, ended_at);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def connect():
    """Yield a connection with WAL enabled and rows accessible by column name.

    WAL keeps a reader from blocking the writer, which is what produces spurious
    "database is locked" errors under FastAPI's threadpool.
    """
    conn = sqlite3.connect(config.DB_PATH, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)


def create_session(language, mode, scenario_id=None, topic=None) -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO sessions (language, mode, scenario_id, topic, started_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (language, mode, scenario_id, topic, _now()),
        )
        return cur.lastrowid


def get_session(session_id):
    with connect() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return dict(row) if row else None


def add_message(session_id, speaker, text, correction=None, suggestion=None) -> int:
    with connect() as conn:
        turn = conn.execute(
            "SELECT COALESCE(MAX(turn), 0) + 1 FROM messages WHERE session_id = ?",
            (session_id,),
        ).fetchone()[0]
        cur = conn.execute(
            "INSERT INTO messages (session_id, turn, speaker, text, correction,"
            " suggestion, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (session_id, turn, speaker, text, correction, suggestion, _now()),
        )
        return cur.lastrowid


def get_messages(session_id) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY turn", (session_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def set_message_audio(message_id, audio_path) -> None:
    with connect() as conn:
        conn.execute("UPDATE messages SET audio_path = ? WHERE id = ?", (audio_path, message_id))


def end_session(session_id, report, level) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE sessions SET ended_at = ?, report = ?, level = ? WHERE id = ?",
            (_now(), report, level, session_id),
        )


def latest_level(language) -> str:
    """Level of the most recently finished session in this language.

    Open sessions have a NULL level and are ignored.
    """
    with connect() as conn:
        row = conn.execute(
            "SELECT level FROM sessions WHERE language = ? AND level IS NOT NULL"
            " ORDER BY ended_at DESC, id DESC LIMIT 1",
            (language,),
        ).fetchone()
    return row["level"] if row else "beginner"


def list_sessions(limit=20) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM sessions ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


def get_setting(key, default=None):
    with connect() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key, value) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_db.py -v`
Expected: 11 passed

- [ ] **Step 5: Commit**

```bash
git add app/db.py tests/test_db.py
git commit -m "feat: add SQLite data layer with WAL and per-language level tracking"
```

---

### Task 3: Scenario catalogue

**Files:**
- Create: `data/scenarios.json`
- Create: `app/scenarios.py`
- Create: `tests/test_scenarios.py`

**Interfaces:**
- Consumes: `app.config.DATA_DIR`
- Produces: `app.scenarios` with `load_scenarios(path=None) -> list[dict]`, `scenarios_for(language, mode=None) -> list[dict]`, `get_scenario(scenario_id) -> dict | None`, `ScenarioError(Exception)`

- [ ] **Step 1: Write `data/scenarios.json`**

Six scenarios: free and script, in both languages. Script lines stay in the 6–10 line range the spec calls for.

```json
[
  {
    "id": "restaurant-seating-en",
    "language": "en",
    "type": "free",
    "title": "레스토랑 자리 안내",
    "goal": "창가 자리를 요청하고 안내받는다",
    "max_turns": 8,
    "persona_prompt": "You are a friendly host at a mid-range American restaurant on a busy evening. The learner is a walk-in customer. Ask about party size, mention the wait, and offer seating options. Stay in character."
  },
  {
    "id": "airport-checkin-en",
    "language": "en",
    "type": "free",
    "title": "공항 체크인",
    "goal": "체크인하고 좌석을 배정받는다",
    "max_turns": 8,
    "persona_prompt": "You are an airline check-in agent at a US airport. The learner is a passenger flying to Seoul. Ask for their passport, ask about bags, and assign a seat. Stay in character."
  },
  {
    "id": "standup-meeting-en",
    "language": "en",
    "type": "script",
    "title": "회사 데일리 스탠드업",
    "lines": [
      { "speaker": "bot", "text": "Morning! Ready for standup?" },
      { "speaker": "user", "text": "Yeah, give me a sec. Okay, I'm ready." },
      { "speaker": "bot", "text": "Cool. What did you work on yesterday?" },
      { "speaker": "user", "text": "I finished the login bug and started on the report screen." },
      { "speaker": "bot", "text": "Nice. Anything blocking you?" },
      { "speaker": "user", "text": "Not really. I might need a review on the pull request later." },
      { "speaker": "bot", "text": "Sure, ping me when it's up. Thanks!" },
      { "speaker": "user", "text": "Will do. Thanks!" }
    ]
  },
  {
    "id": "restaurant-seating-ja",
    "language": "ja",
    "type": "free",
    "title": "レストランの案内",
    "goal": "窓際の席をお願いして案内してもらう",
    "max_turns": 8,
    "persona_prompt": "あなたは日本のレストランの店員です。学習者は予約なしで来たお客さんです。人数を聞き、待ち時間を伝え、席の希望を聞いてください。役に徹してください。"
  },
  {
    "id": "convenience-store-ja",
    "language": "ja",
    "type": "free",
    "title": "コンビニで買い物",
    "goal": "会計をして袋とお箸をもらう",
    "max_turns": 8,
    "persona_prompt": "あなたは日本のコンビニの店員です。学習者はレジに来たお客さんです。会計をして、袋やお箸が必要か聞いてください。役に徹してください。"
  },
  {
    "id": "office-greeting-ja",
    "language": "ja",
    "type": "script",
    "title": "会社での朝のやりとり",
    "lines": [
      { "speaker": "bot", "text": "おはようございます。今日は早いですね。" },
      { "speaker": "user", "text": "おはようございます。少し早く来ました。" },
      { "speaker": "bot", "text": "昨日の資料、もう見ましたか。" },
      { "speaker": "user", "text": "はい、さっき目を通しました。" },
      { "speaker": "bot", "text": "何か気になるところはありましたか。" },
      { "speaker": "user", "text": "一つだけ、数字を確認したいところがあります。" },
      { "speaker": "bot", "text": "わかりました。あとで一緒に見ましょう。" },
      { "speaker": "user", "text": "ありがとうございます。よろしくお願いします。" }
    ]
  }
]
```

- [ ] **Step 2: Write the failing test**

Create `tests/test_scenarios.py`:

```python
import json

import pytest

from app import scenarios


def test_seed_file_loads():
    items = scenarios.load_scenarios()
    assert len(items) >= 6


def test_every_seed_scenario_is_structurally_valid():
    for s in scenarios.load_scenarios():
        assert s["language"] in ("en", "ja")
        assert s["type"] in ("free", "script")
        assert s["title"]
        if s["type"] == "free":
            assert s["persona_prompt"]
            assert isinstance(s["max_turns"], int)
        else:
            assert 6 <= len(s["lines"]) <= 10
            assert all(l["speaker"] in ("bot", "user") and l["text"] for l in s["lines"])


def test_scenario_ids_are_unique():
    ids = [s["id"] for s in scenarios.load_scenarios()]
    assert len(ids) == len(set(ids))


def test_both_languages_have_free_and_script_scenarios():
    for lang in ("en", "ja"):
        assert scenarios.scenarios_for(lang, "free")
        assert scenarios.scenarios_for(lang, "script")


def test_scenarios_for_filters_by_language():
    assert all(s["language"] == "ja" for s in scenarios.scenarios_for("ja"))


def test_get_scenario_finds_by_id_and_returns_none_when_missing():
    assert scenarios.get_scenario("airport-checkin-en")["language"] == "en"
    assert scenarios.get_scenario("no-such-id") is None


def test_script_scenario_starts_with_a_bot_line():
    for s in scenarios.load_scenarios():
        if s["type"] == "script":
            assert s["lines"][0]["speaker"] == "bot"


def test_invalid_scenario_file_raises(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps([{"id": "x", "language": "fr", "type": "free", "title": "t"}]), encoding="utf-8")
    with pytest.raises(scenarios.ScenarioError):
        scenarios.load_scenarios(bad)


def test_script_without_lines_raises(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps([{"id": "x", "language": "en", "type": "script", "title": "t"}]), encoding="utf-8")
    with pytest.raises(scenarios.ScenarioError):
        scenarios.load_scenarios(bad)
```

- [ ] **Step 3: Run test to verify it fails**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_scenarios.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.scenarios'`

- [ ] **Step 4: Write `app/scenarios.py`**

```python
"""Loading and querying the static scenario catalogue.

Only `free` and `script` scenarios live here. `lesson` sessions are assembled at
request time and have no catalogue entry.
"""
import json
from functools import lru_cache

from app import config


class ScenarioError(Exception):
    """A scenario file is malformed."""


def _validate(item) -> None:
    where = f"scenario {item.get('id', '<no id>')}"
    if item.get("language") not in config.LANGUAGES:
        raise ScenarioError(f"{where}: language must be one of {config.LANGUAGES}")
    if item.get("type") not in ("free", "script"):
        raise ScenarioError(f"{where}: type must be 'free' or 'script'")
    if not item.get("title"):
        raise ScenarioError(f"{where}: title is required")
    if item["type"] == "free":
        if not item.get("persona_prompt"):
            raise ScenarioError(f"{where}: free scenarios need a persona_prompt")
        if not isinstance(item.get("max_turns"), int):
            raise ScenarioError(f"{where}: free scenarios need an integer max_turns")
    else:
        lines = item.get("lines")
        if not lines:
            raise ScenarioError(f"{where}: script scenarios need lines")
        for line in lines:
            if line.get("speaker") not in ("bot", "user") or not line.get("text"):
                raise ScenarioError(f"{where}: each line needs speaker and text")


def load_scenarios(path=None) -> list[dict]:
    """Read and validate the catalogue. Raises ScenarioError on bad content."""
    if path is None:
        return _load_default()
    return _read(path)


def _read(path) -> list[dict]:
    items = json.loads(path.read_text(encoding="utf-8"))
    seen = set()
    for item in items:
        _validate(item)
        if item["id"] in seen:
            raise ScenarioError(f"duplicate scenario id: {item['id']}")
        seen.add(item["id"])
    return items


@lru_cache(maxsize=1)
def _load_default() -> tuple:
    return tuple(_read(config.DATA_DIR / "scenarios.json"))


def scenarios_for(language, mode=None) -> list[dict]:
    """Catalogue entries for a language, optionally narrowed to one type."""
    items = [s for s in load_scenarios() if s["language"] == language]
    if mode is not None:
        items = [s for s in items if s["type"] == mode]
    return items


def get_scenario(scenario_id):
    for s in load_scenarios():
        if s["id"] == scenario_id:
            return s
    return None
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_scenarios.py -v`
Expected: 9 passed

- [ ] **Step 6: Commit**

```bash
git add data/scenarios.json app/scenarios.py tests/test_scenarios.py
git commit -m "feat: add scenario catalogue with validation and seed content"
```

---

### Task 4: TTS text sanitisation

**Files:**
- Create: `app/text_cleanup.py`
- Create: `tests/test_text_cleanup.py`

**Interfaces:**
- Consumes: `app.config.MAX_TTS_CHARS`
- Produces: `app.text_cleanup.clean_for_tts(text: str, max_chars: int | None = None) -> str`

- [ ] **Step 1: Write the failing test**

Create `tests/test_text_cleanup.py`:

```python
from app.text_cleanup import clean_for_tts


def test_strips_markdown_emphasis_but_keeps_words():
    assert clean_for_tts("That's **really** good and *fine*") == "That's really good and fine"


def test_strips_backticks_and_headings():
    assert clean_for_tts("## Note\nUse `git status` now") == "Note Use git status now"


def test_strips_list_markers():
    assert clean_for_tts("- first\n- second") == "first second"
    assert clean_for_tts("1. first\n2. second") == "first second"


def test_removes_emoji():
    assert clean_for_tts("Nice work 👍🎉 today") == "Nice work today"


def test_removes_parenthetical_asides():
    assert clean_for_tts("Sure (as I said before), let's go") == "Sure, let's go"


def test_collapses_whitespace_and_newlines():
    assert clean_for_tts("Hello   there\n\n  friend") == "Hello there friend"


def test_truncates_at_a_sentence_boundary_when_over_the_cap():
    text = "One sentence here. Two sentence here. Three sentence here."
    assert clean_for_tts(text, max_chars=25) == "One sentence here."


def test_hard_truncates_when_no_sentence_boundary_fits():
    assert clean_for_tts("a" * 100, max_chars=10) == "a" * 10


def test_japanese_text_survives_untouched():
    text = "いらっしゃいませ。ご予約はされていますか？"
    assert clean_for_tts(text) == text


def test_japanese_sentence_truncation_uses_ideographic_period():
    text = "いらっしゃいませ。ご予約はされていますか？窓際もあります。"
    assert clean_for_tts(text, max_chars=12) == "いらっしゃいませ。"


def test_empty_and_whitespace_input_return_empty():
    assert clean_for_tts("") == ""
    assert clean_for_tts("   \n  ") == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_text_cleanup.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.text_cleanup'`

- [ ] **Step 3: Write `app/text_cleanup.py`**

```python
"""Prepare LLM output for speech synthesis.

The model is told not to emit markdown or emoji, but instructions are not a
guarantee, and a TTS engine will happily read asterisks aloud. This runs on the
TTS input only — the screen and the database always keep the original text.
"""
import re

from app import config

_EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF\uFE0F\u2934\u2935]+"
)
_PARENTHETICAL = re.compile(r"\s*[(（][^)）]*[)）]")
_LIST_MARKER = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+", re.MULTILINE)
_HEADING = re.compile(r"^\s*#{1,6}\s*", re.MULTILINE)
_EMPHASIS = re.compile(r"(\*{1,3}|_{1,3}|`+|~~)")
_SENTENCE_END = re.compile(r"[.!?。！？]")


def clean_for_tts(text: str, max_chars: int | None = None) -> str:
    if not text:
        return ""
    limit = config.MAX_TTS_CHARS if max_chars is None else max_chars

    out = _EMOJI.sub("", text)
    out = _PARENTHETICAL.sub("", out)
    out = _HEADING.sub("", out)
    out = _LIST_MARKER.sub("", out)
    out = _EMPHASIS.sub("", out)
    out = re.sub(r"\s+", " ", out).strip()

    if len(out) <= limit:
        return out
    return _truncate(out, limit)


def _truncate(text: str, limit: int) -> str:
    """Cut at the last sentence end that fits; fall back to a hard cut."""
    ends = [m.end() for m in _SENTENCE_END.finditer(text) if m.end() <= limit]
    if ends:
        return text[: ends[-1]].strip()
    return text[:limit]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_text_cleanup.py -v`
Expected: 11 passed

- [ ] **Step 5: Commit**

```bash
git add app/text_cleanup.py tests/test_text_cleanup.py
git commit -m "feat: sanitise LLM output before speech synthesis"
```

---

### Task 5: TTS engine layer

**Files:**
- Create: `app/tts/__init__.py`
- Create: `app/tts/kokoro_backend.py`
- Create: `app/tts/voicevox_backend.py`
- Create: `tests/test_tts.py`

**Interfaces:**
- Consumes: `app.config`, `app.text_cleanup.clean_for_tts`
- Produces:
  - `app.tts.synthesize(text, language, voice) -> bytes` (WAV bytes; raises `TTSError` on failure)
  - `app.tts.cache_key(text, language, voice) -> str`
  - `app.tts.cached_path(key) -> Path`
  - `app.tts.synthesize_to_cache(text, language, voice) -> str` (returns the cache key)
  - `app.tts.TTSError(Exception)`
  - `app.tts.kokoro_backend.synthesize_en(text, voice) -> bytes`
  - `app.tts.voicevox_backend.synthesize_ja(text, speaker_id) -> bytes`
  - `app.tts.voicevox_backend.is_healthy() -> bool`

- [ ] **Step 1: Write the failing test**

Create `tests/test_tts.py`:

```python
import wave
from io import BytesIO

import pytest

from app import config, tts


@pytest.fixture(autouse=True)
def cache_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")


def test_cache_key_is_stable_for_identical_input():
    assert tts.cache_key("hello", "en", "am_adam") == tts.cache_key("hello", "en", "am_adam")


def test_cache_key_changes_with_text_language_or_voice():
    base = tts.cache_key("hello", "en", "am_adam")
    assert tts.cache_key("hello!", "en", "am_adam") != base
    assert tts.cache_key("hello", "ja", "am_adam") != base
    assert tts.cache_key("hello", "en", "af_kore") != base


def test_cache_key_is_filesystem_safe():
    key = tts.cache_key("窓際のお席／" + "x" * 500, "ja", "21")
    assert key.isalnum()
    assert len(key) <= 64


def test_unknown_language_is_rejected():
    with pytest.raises(tts.TTSError):
        tts.synthesize("hello", "fr", "am_adam")


def test_voice_outside_the_catalog_is_rejected():
    with pytest.raises(tts.TTSError):
        tts.synthesize("hello", "en", "bm_george")


def test_empty_text_is_rejected():
    with pytest.raises(tts.TTSError):
        tts.synthesize("   ", "en", "am_adam")


def test_dispatch_routes_by_language(monkeypatch):
    calls = {}

    def fake_en(text, voice):
        calls["en"] = (text, voice)
        return b"EN"

    def fake_ja(text, voice):
        calls["ja"] = (text, voice)
        return b"JA"

    monkeypatch.setattr(tts.kokoro_backend, "synthesize_en", fake_en)
    monkeypatch.setattr(tts.voicevox_backend, "synthesize_ja", fake_ja)

    assert tts.synthesize("hello", "en", "am_adam") == b"EN"
    assert tts.synthesize("こんにちは", "ja", "21") == b"JA"
    assert calls["en"] == ("hello", "am_adam")
    assert calls["ja"] == ("こんにちは", "21")


def test_markdown_is_stripped_before_reaching_the_backend(monkeypatch):
    seen = {}

    def fake_en(text, voice):
        seen["text"] = text
        return b"EN"

    monkeypatch.setattr(tts.kokoro_backend, "synthesize_en", fake_en)
    tts.synthesize("That's **great**", "en", "am_adam")
    assert seen["text"] == "That's great"


def test_synthesize_to_cache_writes_once_and_reuses(monkeypatch):
    hits = []

    def fake_en(text, voice):
        hits.append(1)
        return b"RIFFfake"

    monkeypatch.setattr(tts.kokoro_backend, "synthesize_en", fake_en)
    key1 = tts.synthesize_to_cache("hello", "en", "am_adam")
    key2 = tts.synthesize_to_cache("hello", "en", "am_adam")
    assert key1 == key2
    assert tts.cached_path(key1).read_bytes() == b"RIFFfake"
    assert len(hits) == 1


@pytest.mark.engine
def test_kokoro_produces_real_playable_audio():
    data = tts.synthesize("Hello there, how are you today?", "en", "am_adam")
    with wave.open(BytesIO(data)) as w:
        assert w.getnchannels() == 1
        assert w.getnframes() / w.getframerate() > 0.5


@pytest.mark.engine
def test_voicevox_produces_real_playable_audio():
    if not tts.voicevox_backend.is_healthy():
        pytest.skip("VOICEVOX not running (docker compose up -d)")
    data = tts.synthesize("いらっしゃいませ。ご予約はされていますか？", "ja", "21")
    with wave.open(BytesIO(data)) as w:
        assert w.getnframes() / w.getframerate() > 0.5
```

- [ ] **Step 2: Register the `engine` marker**

Create `pytest.ini` at the repo root:

```ini
[pytest]
testpaths = tests
markers =
    engine: hits a real TTS engine; needs Kokoro model files and/or VOICEVOX running
```

- [ ] **Step 3: Run test to verify it fails**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_tts.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.tts'`

- [ ] **Step 4: Write `app/tts/kokoro_backend.py`**

```python
"""English synthesis via Kokoro, running in-process.

The model is ~310 MB and takes a moment to load, so it is created once on first
use and kept. Japanese is deliberately NOT routed here: kokoro-onnx phonemises
with espeak, which cannot read kanji and stretches a sentence to three or four
times its correct length.
"""
import io
import threading

import soundfile as sf

from app import config

_lock = threading.Lock()
_engine = None


def _get_engine():
    global _engine
    with _lock:
        if _engine is None:
            from kokoro_onnx import Kokoro

            _engine = Kokoro(str(config.KOKORO_MODEL), str(config.KOKORO_VOICES))
        return _engine


def synthesize_en(text: str, voice: str) -> bytes:
    samples, sample_rate = _get_engine().create(text, voice=voice, speed=1.0, lang="en-us")
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()
```

- [ ] **Step 5: Write `app/tts/voicevox_backend.py`**

```python
"""Japanese synthesis via the VOICEVOX HTTP engine (Docker).

VOICEVOX handles kanji and pitch accent internally, which is why Japanese goes
here rather than through Kokoro.
"""
import httpx

from app import config

_TIMEOUT = httpx.Timeout(60.0, connect=5.0)


def is_healthy() -> bool:
    try:
        r = httpx.get(f"{config.VOICEVOX_URL}/version", timeout=3.0)
        return r.status_code == 200
    except httpx.HTTPError:
        return False


def synthesize_ja(text: str, speaker_id: str) -> bytes:
    with httpx.Client(timeout=_TIMEOUT) as client:
        query = client.post(
            f"{config.VOICEVOX_URL}/audio_query",
            params={"text": text, "speaker": speaker_id},
        )
        query.raise_for_status()
        audio = client.post(
            f"{config.VOICEVOX_URL}/synthesis",
            params={"speaker": speaker_id},
            json=query.json(),
        )
        audio.raise_for_status()
        return audio.content
```

- [ ] **Step 6: Write `app/tts/__init__.py`**

```python
"""Speech synthesis: one entry point, a backend per language, an on-disk cache.

Callers never choose an engine. They pass a language and a voice id, and this
module routes to Kokoro (English, in-process) or VOICEVOX (Japanese, HTTP).
Swapping an engine means editing one backend module.
"""
import hashlib
from pathlib import Path

import httpx

from app import config
from app.text_cleanup import clean_for_tts
from app.tts import kokoro_backend, voicevox_backend


class TTSError(Exception):
    """Synthesis could not be performed. The caller should fall back to browser TTS."""


def _valid_voice(language: str, voice: str) -> bool:
    return any(v["id"] == voice for v in config.VOICE_CATALOG.get(language, []))


def cache_key(text: str, language: str, voice: str) -> str:
    raw = f"{language}\x00{voice}\x00{text}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:32]


def cached_path(key: str) -> Path:
    return config.TTS_CACHE_DIR / f"{key}.wav"


def synthesize(text: str, language: str, voice: str) -> bytes:
    """Return WAV bytes for `text`. Raises TTSError if it cannot be produced."""
    if language not in config.LANGUAGES:
        raise TTSError(f"unsupported language: {language}")
    if not _valid_voice(language, voice):
        raise TTSError(f"voice {voice!r} is not in the {language} catalogue")

    spoken = clean_for_tts(text)
    if not spoken:
        raise TTSError("nothing to speak after sanitisation")

    try:
        if language == "en":
            return kokoro_backend.synthesize_en(spoken, voice)
        return voicevox_backend.synthesize_ja(spoken, voice)
    except httpx.HTTPError as exc:
        raise TTSError(f"VOICEVOX unreachable: {exc}") from exc
    except Exception as exc:  # engine-level failure — caller falls back
        raise TTSError(str(exc)) from exc


def synthesize_to_cache(text: str, language: str, voice: str) -> str:
    """Synthesise if needed, store under a content hash, return the cache key.

    Script mode replays fixed lines, so the second run of a scenario is free.
    """
    key = cache_key(clean_for_tts(text), language, voice)
    path = cached_path(key)
    if not path.exists():
        data = synthesize(text, language, voice)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return key
```

- [ ] **Step 7: Run the unit tests**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_tts.py -v -m "not engine"`
Expected: 9 passed

- [ ] **Step 8: Run the engine tests against the real engines**

Start VOICEVOX first:

```bash
docker compose up -d
```

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_tts.py -v -m engine`
Expected: 2 passed. The Kokoro test takes several seconds on first run while the model loads.

- [ ] **Step 9: Commit**

```bash
git add pytest.ini app/tts tests/test_tts.py
git commit -m "feat: add per-language TTS layer with caching"
```

---

### Task 6: Ollama client

**Files:**
- Create: `app/llm.py`
- Create: `tests/test_llm.py`

**Interfaces:**
- Consumes: `app.config.OLLAMA_URL`, `app.config.OLLAMA_MODEL`
- Produces: `app.llm.chat(messages, schema=None, temperature=0.8) -> str`, `app.llm.chat_json(messages, schema, temperature=0.3) -> dict`, `app.llm.is_healthy() -> bool`, `app.llm.LLMError(Exception)`

- [ ] **Step 1: Write the failing test**

Create `tests/test_llm.py`:

```python
import json

import httpx
import pytest

from app import config, llm


def _transport(handler):
    return httpx.MockTransport(handler)


def test_chat_sends_model_and_messages_and_returns_content(monkeypatch):
    captured = {}

    def handler(request):
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"message": {"content": "Hi there!"}})

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    out = llm.chat([{"role": "user", "content": "hello"}])

    assert out == "Hi there!"
    assert captured["url"] == f"{config.OLLAMA_URL}/api/chat"
    assert captured["body"]["model"] == config.OLLAMA_MODEL
    assert captured["body"]["stream"] is False
    assert captured["body"]["messages"] == [{"role": "user", "content": "hello"}]


def test_chat_omits_format_when_no_schema_given(monkeypatch):
    captured = {}

    def handler(request):
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"message": {"content": "ok"}})

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    llm.chat([{"role": "user", "content": "x"}])
    assert "format" not in captured["body"]


def test_chat_json_passes_schema_and_parses_the_reply(monkeypatch):
    schema = {"type": "object", "properties": {"correction": {"type": "string"}}}
    captured = {}

    def handler(request):
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"message": {"content": '{"correction": "fix it"}'}})

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    out = llm.chat_json([{"role": "user", "content": "x"}], schema)

    assert out == {"correction": "fix it"}
    assert captured["body"]["format"] == schema


def test_chat_json_raises_on_unparseable_content(monkeypatch):
    def handler(request):
        return httpx.Response(200, json={"message": {"content": "not json at all"}})

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    with pytest.raises(llm.LLMError):
        llm.chat_json([{"role": "user", "content": "x"}], {"type": "object"})


def test_connection_failure_becomes_a_clear_llm_error(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    with pytest.raises(llm.LLMError) as exc:
        llm.chat([{"role": "user", "content": "x"}])
    assert "Ollama" in str(exc.value)


def test_http_error_status_becomes_llm_error(monkeypatch):
    def handler(request):
        return httpx.Response(500, text="boom")

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    with pytest.raises(llm.LLMError):
        llm.chat([{"role": "user", "content": "x"}])


def test_is_healthy_is_false_when_unreachable(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    assert llm.is_healthy() is False


@pytest.mark.engine
def test_real_ollama_answers():
    if not llm.is_healthy():
        pytest.skip("Ollama not running")
    out = llm.chat([{"role": "user", "content": "Say the single word: ready"}])
    assert out.strip()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_llm.py -v -m "not engine"`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.llm'`

- [ ] **Step 3: Write `app/llm.py`**

```python
"""Ollama chat client.

`_transport_for_tests` exists so tests can inject an httpx.MockTransport without
a live server. Production code leaves it None and httpx opens a real connection.
"""
import json

import httpx

from app import config

_TIMEOUT = httpx.Timeout(180.0, connect=5.0)
_transport_for_tests = None


class LLMError(Exception):
    """The model could not be reached or produced unusable output."""


def _client() -> httpx.Client:
    return httpx.Client(timeout=_TIMEOUT, transport=_transport_for_tests)


def is_healthy() -> bool:
    try:
        with httpx.Client(timeout=3.0, transport=_transport_for_tests) as client:
            return client.get(f"{config.OLLAMA_URL}/api/tags").status_code == 200
    except httpx.HTTPError:
        return False


def chat(messages: list[dict], schema: dict | None = None, temperature: float = 0.8) -> str:
    """Send a chat completion and return the assistant's raw text."""
    payload = {
        "model": config.OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "options": {"temperature": temperature},
    }
    if schema is not None:
        payload["format"] = schema

    try:
        with _client() as client:
            response = client.post(f"{config.OLLAMA_URL}/api/chat", json=payload)
            response.raise_for_status()
            return response.json()["message"]["content"]
    except httpx.HTTPStatusError as exc:
        raise LLMError(f"Ollama returned {exc.response.status_code}") from exc
    except httpx.HTTPError as exc:
        raise LLMError(
            f"Could not reach Ollama at {config.OLLAMA_URL}. Is it running? ({exc})"
        ) from exc


def chat_json(messages: list[dict], schema: dict, temperature: float = 0.3) -> dict:
    """Chat with a forced JSON schema and return the parsed object."""
    raw = chat(messages, schema=schema, temperature=temperature)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise LLMError(f"model did not return valid JSON: {raw[:200]}") from exc
```

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_llm.py -v -m "not engine"`
Expected: 7 passed

- [ ] **Step 5: Run the live test**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_llm.py -v -m engine`
Expected: 1 passed (skipped if Ollama is not running)

- [ ] **Step 6: Commit**

```bash
git add app/llm.py tests/test_llm.py
git commit -m "feat: add Ollama chat client with structured output"
```

---

### Task 7: Prompt assembly

**Files:**
- Create: `app/prompts.py`
- Create: `tests/test_prompts.py`

**Interfaces:**
- Consumes: `app.config`, `app.scenarios.get_scenario`
- Produces: `app.prompts` with `build_system_prompt(mode, language, *, scenario=None, topic=None, level="beginner", turns_used=0) -> str`, `build_feedback_messages(language, user_text) -> list[dict]`, `build_report_messages(language, transcript) -> list[dict]`, `FEEDBACK_SCHEMA: dict`, `REPORT_SCHEMA: dict`

- [ ] **Step 1: Write the failing test**

Create `tests/test_prompts.py`:

```python
import pytest

from app import prompts


def test_every_mode_and_language_produces_a_prompt_with_spoken_style_rules():
    for mode in ("free", "script", "lesson"):
        for lang in ("en", "ja"):
            scenario = {"persona_prompt": "You are a host.", "goal": "seat them",
                        "max_turns": 8} if mode == "free" else None
            text = prompts.build_system_prompt(mode, lang, scenario=scenario)
            assert "1 to 3 sentences" in text
            assert "contractions" in text.lower()
            assert "markdown" in text.lower()
            assert "emoji" in text.lower()


def test_free_mode_embeds_persona_and_goal():
    scenario = {"persona_prompt": "You are an airline agent.", "goal": "assign a seat",
                "max_turns": 8}
    text = prompts.build_system_prompt("free", "en", scenario=scenario)
    assert "You are an airline agent." in text
    assert "assign a seat" in text


def test_free_mode_asks_the_bot_to_wind_down_near_the_turn_limit():
    scenario = {"persona_prompt": "p", "goal": "g", "max_turns": 8}
    early = prompts.build_system_prompt("free", "en", scenario=scenario, turns_used=1)
    late = prompts.build_system_prompt("free", "en", scenario=scenario, turns_used=7)
    assert "wrap" in late.lower() or "wind" in late.lower()
    assert "wrap" not in early.lower()


def test_lesson_mode_injects_the_estimated_level():
    text = prompts.build_system_prompt("lesson", "en", level="advanced")
    assert "advanced" in text


def test_lesson_mode_uses_the_topic_when_given():
    text = prompts.build_system_prompt("lesson", "ja", topic="て form", level="beginner")
    assert "て form" in text


def test_lesson_mode_delegates_topic_choice_when_none_given():
    text = prompts.build_system_prompt("lesson", "en", level="beginner")
    assert "choose" in text.lower()


def test_lesson_mode_describes_the_teaching_cycle():
    text = prompts.build_system_prompt("lesson", "en", level="beginner")
    for beat in ("explain", "example", "correct"):
        assert beat in text.lower()


def test_prompt_names_the_target_language():
    assert "English" in prompts.build_system_prompt("lesson", "en")
    assert "Japanese" in prompts.build_system_prompt("lesson", "ja")


def test_unknown_mode_raises():
    with pytest.raises(ValueError):
        prompts.build_system_prompt("quiz", "en")


def test_free_mode_without_scenario_raises():
    with pytest.raises(ValueError):
        prompts.build_system_prompt("free", "en")


def test_feedback_messages_carry_the_learner_text_and_two_sentence_cap():
    msgs = prompts.build_feedback_messages("en", "I go store yesterday")
    joined = " ".join(m["content"] for m in msgs)
    assert "I go store yesterday" in joined
    assert "two sentences" in joined.lower()


def test_feedback_schema_requires_correction_and_suggestion():
    props = prompts.FEEDBACK_SCHEMA["properties"]
    assert set(props) == {"correction", "suggestion"}
    assert set(prompts.FEEDBACK_SCHEMA["required"]) == {"correction", "suggestion"}


def test_report_schema_constrains_level_to_the_three_values():
    assert prompts.REPORT_SCHEMA["properties"]["level"]["enum"] == [
        "beginner", "intermediate", "advanced"
    ]
    assert set(prompts.REPORT_SCHEMA["required"]) == {"report", "level"}


def test_report_messages_include_the_transcript():
    msgs = prompts.build_report_messages("en", "bot: Hi\nuser: Hello")
    assert "user: Hello" in " ".join(m["content"] for m in msgs)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_prompts.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.prompts'`

- [ ] **Step 3: Write `app/prompts.py`**

```python
"""System prompt assembly for the three modes, plus feedback and report prompts.

The spoken-style block is the single most important part of this file. Left to
itself an LLM writes prose: long sentences, no contractions, formal connectives.
Read aloud, that teaches the learner a register nobody actually speaks.
"""
from app import config

LANGUAGE_NAMES = {"en": "English", "ja": "Japanese"}

SPOKEN_STYLE = """\
You are speaking out loud, and your reply is read by a speech synthesiser.
Follow these rules without exception:
- Reply in {language} only.
- Keep every reply to 1 to 3 sentences. Never longer.
- Use contractions and everyday spoken wording, the way a real person talks.
- Never use markdown, asterisks, bullet points, numbered lists, or headings.
- Never use emoji.
- Never add parenthetical asides or stage directions.
- Ask a question back when it keeps the conversation going naturally."""

FREE_TEMPLATE = """\
{style}

You are role-playing a scene with a language learner.

Your character: {persona}
Scene goal: {goal}

Stay fully in character. Never break role to comment on the learner's {language}
— corrections are handled elsewhere. If the learner says something unclear, react
the way your character naturally would."""

SCRIPT_TEMPLATE = """\
{style}

You are performing a short scripted dialogue with a language learner, like two
actors reading a scene. Deliver your assigned line naturally and wait for the
learner to read theirs. Do not add lines that are not in the script."""

LESSON_TEMPLATE = """\
{style}

You are a warm, patient {language} teacher in a one-to-one spoken lesson.
The student's current level is {level}. Pitch everything to that level.

{topic_line}

Run the lesson in short spoken beats, never a lecture:
1. Explain one small point in a sentence or two.
2. Give one clear example sentence.
3. Ask the student to make their own sentence using it.
4. Correct what they say, briefly and kindly, then move on or go deeper.

Because this is spoken, never present more than one point at a time."""

WIND_DOWN = """

You are near the end of this scene. Start steering it to a natural close and
wrap it up within the next couple of exchanges."""

FEEDBACK_SCHEMA = {
    "type": "object",
    "properties": {
        "correction": {"type": "string"},
        "suggestion": {"type": "string"},
    },
    "required": ["correction", "suggestion"],
}

REPORT_SCHEMA = {
    "type": "object",
    "properties": {
        "report": {"type": "string"},
        "level": {"type": "string", "enum": list(config.LEVELS)},
    },
    "required": ["report", "level"],
}


def build_system_prompt(mode, language, *, scenario=None, topic=None,
                        level="beginner", turns_used=0) -> str:
    if mode not in config.MODES:
        raise ValueError(f"unknown mode: {mode}")
    if language not in config.LANGUAGES:
        raise ValueError(f"unknown language: {language}")

    language_name = LANGUAGE_NAMES[language]
    style = SPOKEN_STYLE.format(language=language_name)

    if mode == "free":
        if not scenario:
            raise ValueError("free mode needs a scenario")
        prompt = FREE_TEMPLATE.format(
            style=style,
            persona=scenario["persona_prompt"],
            goal=scenario.get("goal", "have a natural conversation"),
            language=language_name,
        )
        max_turns = scenario.get("max_turns", config.DEFAULT_MAX_TURNS)
        if turns_used >= max_turns - 2:
            prompt += WIND_DOWN
        return prompt

    if mode == "script":
        return SCRIPT_TEMPLATE.format(style=style)

    topic_line = (
        f"Today's topic, chosen by the student: {topic}"
        if topic
        else "The student has not chosen a topic. Choose one grammar point or "
             "theme that suits their level and teach that."
    )
    prompt = LESSON_TEMPLATE.format(
        style=style, language=language_name, level=level, topic_line=topic_line
    )
    if turns_used >= config.DEFAULT_MAX_TURNS - 2:
        prompt += WIND_DOWN
    return prompt


def build_feedback_messages(language, user_text) -> list[dict]:
    """Ask for a grammar correction and a more natural phrasing, 2 sentences each."""
    language_name = LANGUAGE_NAMES[language]
    system = (
        f"You are a {language_name} teacher reviewing one line a learner just spoke.\n"
        "Return two things:\n"
        "- correction: what was grammatically wrong and the fixed sentence. "
        "If it was already correct, say so briefly.\n"
        "- suggestion: a more natural way a native speaker would say it.\n"
        "Write each in at most two sentences. Explain in Korean, but keep the "
        f"{language_name} example sentences in {language_name}. "
        "No markdown, no emoji."
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": f"The learner said: {user_text}"},
    ]


def build_report_messages(language, transcript) -> list[dict]:
    """Ask for an end-of-session report and a level estimate in one call."""
    language_name = LANGUAGE_NAMES[language]
    system = (
        f"You are a {language_name} teacher writing a short end-of-lesson report "
        "for one student, in Korean.\n"
        "Cover: grammar mistakes that repeated, two or three expressions worth "
        "memorising, and a brief encouraging overall comment.\n"
        "Also estimate the student's level as exactly one of: beginner, "
        "intermediate, advanced.\n"
        "Keep the report under 200 words. No markdown, no emoji."
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": f"Here is the full session transcript:\n\n{transcript}"},
    ]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_prompts.py -v`
Expected: 14 passed

- [ ] **Step 5: Commit**

```bash
git add app/prompts.py tests/test_prompts.py
git commit -m "feat: assemble mode-specific prompts with spoken-style constraints"
```

---

### Task 8: FastAPI app shell — health, scenarios, voices, preview

**Files:**
- Create: `app/api.py`
- Create: `app/main.py`
- Create: `tests/test_api_config.py`

**Interfaces:**
- Consumes: `app.config`, `app.db`, `app.scenarios`, `app.tts`, `app.llm`
- Produces: `app.main.app` (FastAPI instance), `app.api.router`, and these endpoints:
  - `GET /api/health` → `{"ollama": bool, "voicevox": bool}`
  - `GET /api/scenarios?language=en&mode=free` → `{"scenarios": [{id,title,type,goal}]}`
  - `GET /api/voices?language=en` → `{"voices": [...], "selected": "am_adam"}`
  - `POST /api/voices` body `{"language","voice"}` → `{"selected": voice}`
  - `POST /api/tts/preview` body `{"language","voice"}` → `audio/wav`

- [ ] **Step 1: Write the failing test**

Create `tests/test_api_config.py`:

```python
import pytest
from fastapi.testclient import TestClient

from app import config, db, tts
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    db.init_db()
    return TestClient(app)


def test_health_reports_both_services(client, monkeypatch):
    monkeypatch.setattr("app.api.llm.is_healthy", lambda: True)
    monkeypatch.setattr("app.api.voicevox_backend.is_healthy", lambda: False)
    body = client.get("/api/health").json()
    assert body == {"ollama": True, "voicevox": False}


def test_scenarios_filtered_by_language(client):
    body = client.get("/api/scenarios", params={"language": "ja"}).json()
    assert body["scenarios"]
    assert all("ja" in s["id"] for s in body["scenarios"])


def test_scenarios_filtered_by_mode(client):
    body = client.get("/api/scenarios", params={"language": "en", "mode": "script"}).json()
    assert all(s["type"] == "script" for s in body["scenarios"])


def test_scenarios_rejects_unknown_language(client):
    assert client.get("/api/scenarios", params={"language": "fr"}).status_code == 422


def test_voices_returns_catalog_and_default_when_unset(client):
    body = client.get("/api/voices", params={"language": "en"}).json()
    assert [v["id"] for v in body["voices"]] == [
        "am_adam", "am_fenrir", "af_heart", "af_bella", "af_kore"
    ]
    assert body["selected"] == "am_adam"


def test_selecting_a_voice_persists_it(client):
    assert client.post("/api/voices", json={"language": "en", "voice": "af_kore"}).status_code == 200
    assert client.get("/api/voices", params={"language": "en"}).json()["selected"] == "af_kore"


def test_selecting_a_voice_outside_the_catalog_is_rejected(client):
    r = client.post("/api/voices", json={"language": "en", "voice": "bm_george"})
    assert r.status_code == 400


def test_voice_selection_is_independent_per_language(client):
    client.post("/api/voices", json={"language": "en", "voice": "af_kore"})
    assert client.get("/api/voices", params={"language": "ja"}).json()["selected"] == "21"


def test_preview_returns_wav_audio(client, monkeypatch):
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")
    r = client.post("/api/tts/preview", json={"language": "en", "voice": "am_adam"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.content == b"RIFFfake"


def test_preview_reports_failure_clearly(client, monkeypatch):
    def boom(text, language, voice):
        raise tts.TTSError("engine down")

    monkeypatch.setattr(tts, "synthesize", boom)
    r = client.post("/api/tts/preview", json={"language": "en", "voice": "am_adam"})
    assert r.status_code == 503
    assert "engine down" in r.json()["detail"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_api_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.main'`

- [ ] **Step 3: Write `app/api.py`**

```python
"""HTTP routes. Thin — every route delegates to a module and shapes the response."""
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel

from app import config, db, llm, scenarios, tts
from app.tts import voicevox_backend

router = APIRouter(prefix="/api")

Language = Literal["en", "ja"]
Mode = Literal["free", "script", "lesson"]


class VoiceSelection(BaseModel):
    language: Language
    voice: str


def _voice_setting_key(language: str) -> str:
    return f"voice_{language}"


def selected_voice(language: str) -> str:
    return db.get_setting(_voice_setting_key(language), config.DEFAULT_VOICE[language])


@router.get("/health")
def health():
    return {"ollama": llm.is_healthy(), "voicevox": voicevox_backend.is_healthy()}


@router.get("/scenarios")
def list_scenarios(language: Language, mode: Mode | None = Query(default=None)):
    kind = mode if mode in ("free", "script") else None
    items = scenarios.scenarios_for(language, kind)
    return {
        "scenarios": [
            {"id": s["id"], "title": s["title"], "type": s["type"], "goal": s.get("goal")}
            for s in items
        ]
    }


@router.get("/voices")
def list_voices(language: Language):
    return {"voices": config.VOICE_CATALOG[language], "selected": selected_voice(language)}


@router.post("/voices")
def choose_voice(payload: VoiceSelection):
    valid = [v["id"] for v in config.VOICE_CATALOG[payload.language]]
    if payload.voice not in valid:
        raise HTTPException(400, f"{payload.voice} is not available for {payload.language}")
    db.set_setting(_voice_setting_key(payload.language), payload.voice)
    return {"selected": payload.voice}


@router.post("/tts/preview")
def preview_voice(payload: VoiceSelection):
    try:
        audio = tts.synthesize(config.PREVIEW_TEXT[payload.language],
                               payload.language, payload.voice)
    except tts.TTSError as exc:
        raise HTTPException(503, str(exc)) from exc
    return Response(content=audio, media_type="audio/wav")
```

- [ ] **Step 4: Write `app/main.py`**

```python
"""Application entry point.

Run with:
    venv\\Scripts\\python.exe -m uvicorn app.main:app --reload --port 8000
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app import config, db
from app.api import router


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    for directory in (config.AUDIO_DIR, config.TTS_CACHE_DIR):
        directory.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="Monologue", lifespan=lifespan)
app.include_router(router)

if config.STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=config.STATIC_DIR, html=True), name="static")
```

- [ ] **Step 5: Create the static directory placeholder**

The static mount fails if the directory is missing. Create `static/.gitkeep` as an empty file so the mount is exercised from here on.

- [ ] **Step 6: Run tests to verify they pass**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_api_config.py -v`
Expected: 10 passed

- [ ] **Step 7: Commit**

```bash
git add app/api.py app/main.py static/.gitkeep tests/test_api_config.py
git commit -m "feat: add FastAPI shell with health, scenario, and voice endpoints"
```

---

### Task 9: Session and chat endpoints

**Files:**
- Modify: `app/api.py` (append routes; keep the existing ones untouched)
- Create: `tests/test_api_chat.py`

**Interfaces:**
- Consumes: everything from Tasks 2, 3, 5, 6, 7, 8
- Produces:
  - `POST /api/sessions` body `{"language","mode","scenario_id"?,"topic"?}` → `{"session_id", "mode", "opening"?, "opening_audio"?, "lines"?}`
  - `POST /api/chat` body `{"session_id","text"}` → `{"turn", "bot_reply", "audio_key", "correction", "suggestion"}`
  - `POST /api/sessions/{id}/audio` multipart `file`, form `message_id` → `{"audio_path"}`
  - `GET /api/audio/{key}.wav` → `audio/wav`

- [ ] **Step 1: Write the failing test**

Create `tests/test_api_chat.py`:

```python
import io

import pytest
from fastapi.testclient import TestClient

from app import config, db, tts
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(config, "AUDIO_DIR", tmp_path / "audio")
    (tmp_path / "audio").mkdir()
    db.init_db()
    return TestClient(app)


@pytest.fixture(autouse=True)
def fake_engines(monkeypatch):
    monkeypatch.setattr("app.api.llm.chat", lambda messages, **kw: "Sure, right this way!")
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"correction": "Use the past tense.",
                                                        "suggestion": "Try: I went there."})
    monkeypatch.setattr(tts, "synthesize", lambda t, l, v: b"RIFFfake")


def test_free_session_starts_and_returns_an_opening_line(client):
    r = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                           "scenario_id": "airport-checkin-en"})
    body = r.json()
    assert body["session_id"] > 0
    assert body["opening"]
    assert body["opening_audio"]
    assert db.get_messages(body["session_id"])[0]["speaker"] == "bot"


def test_script_session_returns_all_lines_with_audio_for_bot_lines(client):
    body = client.post("/api/sessions", json={"language": "en", "mode": "script",
                                              "scenario_id": "standup-meeting-en"}).json()
    lines = body["lines"]
    assert len(lines) == 8
    assert all(l["audio_key"] for l in lines if l["speaker"] == "bot")
    assert all(l["audio_key"] is None for l in lines if l["speaker"] == "user")


def test_lesson_session_stores_topic_and_needs_no_scenario(client):
    body = client.post("/api/sessions", json={"language": "ja", "mode": "lesson",
                                              "topic": "て form"}).json()
    assert db.get_session(body["session_id"])["topic"] == "て form"
    assert body["opening"]


def test_free_session_without_scenario_is_rejected(client):
    assert client.post("/api/sessions", json={"language": "en", "mode": "free"}).status_code == 400


def test_session_with_unknown_scenario_is_rejected(client):
    r = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                           "scenario_id": "nope"})
    assert r.status_code == 404


def test_chat_stores_both_turns_with_feedback_on_the_user_turn(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    body = client.post("/api/chat", json={"session_id": sid, "text": "I go there yesterday"}).json()

    assert body["bot_reply"] == "Sure, right this way!"
    assert body["correction"] == "Use the past tense."
    assert body["suggestion"] == "Try: I went there."
    assert body["audio_key"]

    msgs = db.get_messages(sid)
    user_turn = [m for m in msgs if m["speaker"] == "user"][0]
    assert user_turn["text"] == "I go there yesterday"
    assert user_turn["correction"] == "Use the past tense."
    assert msgs[-1]["speaker"] == "bot"
    assert msgs[-1]["correction"] is None


def test_chat_on_a_finished_session_is_rejected(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    db.end_session(sid, "done", "beginner")
    r = client.post("/api/chat", json={"session_id": sid, "text": "hello"})
    assert r.status_code == 409


def test_chat_on_an_unknown_session_is_rejected(client):
    assert client.post("/api/chat", json={"session_id": 999, "text": "hi"}).status_code == 404


def test_chat_with_blank_text_is_rejected(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    assert client.post("/api/chat", json={"session_id": sid, "text": "   "}).status_code == 400


def test_chat_still_succeeds_when_tts_fails(client, monkeypatch):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]

    def boom(text, language, voice):
        raise tts.TTSError("engine down")

    monkeypatch.setattr(tts, "synthesize", boom)
    body = client.post("/api/chat", json={"session_id": sid, "text": "hello"}).json()
    assert body["bot_reply"]
    assert body["audio_key"] is None  # frontend falls back to browser speech


def test_chat_survives_a_feedback_failure(client, monkeypatch):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]

    def boom(messages, schema, **kw):
        raise Exception("bad json")

    monkeypatch.setattr("app.api.llm.chat_json", boom)
    body = client.post("/api/chat", json={"session_id": sid, "text": "hello"}).json()
    assert body["bot_reply"]
    assert body["correction"] is None


def test_audio_endpoint_serves_cached_wav(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    key = client.post("/api/chat", json={"session_id": sid, "text": "hi"}).json()["audio_key"]
    r = client.get(f"/api/audio/{key}.wav")
    assert r.status_code == 200
    assert r.content == b"RIFFfake"


def test_audio_endpoint_404s_on_unknown_key(client):
    assert client.get("/api/audio/deadbeef.wav").status_code == 404


def test_recorded_audio_upload_attaches_to_the_message(client):
    sid = client.post("/api/sessions", json={"language": "en", "mode": "free",
                                             "scenario_id": "airport-checkin-en"}).json()["session_id"]
    client.post("/api/chat", json={"session_id": sid, "text": "hello"})
    message_id = [m for m in db.get_messages(sid) if m["speaker"] == "user"][0]["id"]

    r = client.post(
        f"/api/sessions/{sid}/audio",
        data={"message_id": str(message_id)},
        files={"file": ("clip.webm", io.BytesIO(b"webmdata"), "audio/webm")},
    )
    assert r.status_code == 200
    stored = [m for m in db.get_messages(sid) if m["id"] == message_id][0]["audio_path"]
    assert stored.endswith(".webm")
    assert (config.AUDIO_DIR / stored.split("/")[-1]).read_bytes() == b"webmdata"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_api_chat.py -v`
Expected: FAIL — `/api/sessions` returns 404 because the route does not exist

- [ ] **Step 3: Append the session and chat routes to `app/api.py`**

Add these imports to the existing import block at the top of `app/api.py`:

```python
from fastapi import File, Form, UploadFile
from app import prompts
```

Then append to the end of the file:

```python
class SessionStart(BaseModel):
    language: Language
    mode: Mode
    scenario_id: str | None = None
    topic: str | None = None


class ChatTurn(BaseModel):
    session_id: int
    text: str


def _history(session_id: int) -> list[dict]:
    """Conversation so far in Ollama's message format."""
    role = {"bot": "assistant", "user": "user"}
    return [
        {"role": role[m["speaker"]], "content": m["text"]}
        for m in db.get_messages(session_id)
    ]


def _speak(text: str, language: str) -> str | None:
    """Synthesise to the cache and return its key, or None if TTS is unavailable.

    A TTS outage must never stop a practice session — the browser falls back to
    its own speech synthesis when the key is None.
    """
    try:
        return tts.synthesize_to_cache(text, language, selected_voice(language))
    except tts.TTSError:
        return None


def _feedback(language: str, text: str) -> tuple[str | None, str | None]:
    try:
        result = llm.chat_json(prompts.build_feedback_messages(language, text),
                               prompts.FEEDBACK_SCHEMA)
        return result.get("correction"), result.get("suggestion")
    except Exception:
        return None, None


@router.post("/sessions")
def start_session(payload: SessionStart):
    scenario = None
    if payload.mode in ("free", "script"):
        if not payload.scenario_id:
            raise HTTPException(400, f"{payload.mode} mode needs a scenario_id")
        scenario = scenarios.get_scenario(payload.scenario_id)
        if scenario is None:
            raise HTTPException(404, f"no scenario {payload.scenario_id}")

    session_id = db.create_session(payload.language, payload.mode,
                                   scenario_id=payload.scenario_id, topic=payload.topic)

    if payload.mode == "script":
        lines = []
        for line in scenario["lines"]:
            key = _speak(line["text"], payload.language) if line["speaker"] == "bot" else None
            lines.append({"speaker": line["speaker"], "text": line["text"], "audio_key": key})
        return {"session_id": session_id, "mode": "script", "lines": lines}

    system = prompts.build_system_prompt(
        payload.mode, payload.language, scenario=scenario, topic=payload.topic,
        level=db.latest_level(payload.language),
    )
    opening = llm.chat([
        {"role": "system", "content": system},
        {"role": "user", "content": "Start the conversation with your first line."},
    ])
    db.add_message(session_id, "bot", opening)
    return {
        "session_id": session_id,
        "mode": payload.mode,
        "opening": opening,
        "opening_audio": _speak(opening, payload.language),
    }


@router.post("/chat")
def chat_turn(payload: ChatTurn):
    session = db.get_session(payload.session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    if session["ended_at"] is not None:
        raise HTTPException(409, "this session has already ended")
    text = payload.text.strip()
    if not text:
        raise HTTPException(400, "text is empty")

    language = session["language"]
    scenario = scenarios.get_scenario(session["scenario_id"]) if session["scenario_id"] else None
    turns_used = sum(1 for m in db.get_messages(payload.session_id) if m["speaker"] == "user")

    correction, suggestion = _feedback(language, text)
    db.add_message(payload.session_id, "user", text, correction, suggestion)

    system = prompts.build_system_prompt(
        session["mode"], language, scenario=scenario, topic=session["topic"],
        level=db.latest_level(language), turns_used=turns_used + 1,
    )
    reply = llm.chat([{"role": "system", "content": system}] + _history(payload.session_id))
    db.add_message(payload.session_id, "bot", reply)

    return {
        "turn": turns_used + 1,
        "bot_reply": reply,
        "audio_key": _speak(reply, language),
        "correction": correction,
        "suggestion": suggestion,
    }


@router.get("/audio/{key}.wav")
def get_audio(key: str):
    path = tts.cached_path(key)
    if not path.exists():
        raise HTTPException(404, "no such audio")
    return Response(content=path.read_bytes(), media_type="audio/wav")


@router.post("/sessions/{session_id}/audio")
async def upload_recording(session_id: int, message_id: int = Form(...),
                           file: UploadFile = File(...)):
    """Store the learner's raw recording. Phase 1 only keeps it; Phase 2 scores it."""
    if db.get_session(session_id) is None:
        raise HTTPException(404, "no such session")
    config.AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    name = f"s{session_id}_m{message_id}.webm"
    (config.AUDIO_DIR / name).write_bytes(await file.read())
    stored = f"audio/{name}"
    db.set_message_audio(message_id, stored)
    return {"audio_path": stored}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_api_chat.py -v`
Expected: 14 passed

- [ ] **Step 5: Run the whole suite to check nothing regressed**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest -m "not engine" -v`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add app/api.py tests/test_api_chat.py
git commit -m "feat: add session lifecycle and chat turn endpoints"
```

---

### Task 10: Session end — report and level estimation

**Files:**
- Modify: `app/api.py` (append routes)
- Create: `tests/test_api_report.py`

**Interfaces:**
- Consumes: `app.prompts.build_report_messages`, `app.prompts.REPORT_SCHEMA`, `app.db.end_session`
- Produces:
  - `POST /api/sessions/{id}/end` → `{"report": str, "level": str}`
  - `GET /api/sessions` → `{"sessions": [...]}`
  - `GET /api/sessions/{id}` → `{"session": {...}, "messages": [...]}`

- [ ] **Step 1: Write the failing test**

Create `tests/test_api_report.py`:

```python
import pytest
from fastapi.testclient import TestClient

from app import config, db
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(config, "TTS_CACHE_DIR", tmp_path / "cache")
    db.init_db()
    return TestClient(app)


@pytest.fixture()
def session(client):
    sid = db.create_session("en", "free", scenario_id="airport-checkin-en")
    db.add_message(sid, "bot", "Hello there!")
    db.add_message(sid, "user", "I go there yesterday", correction="Use past tense.")
    return sid


def test_ending_a_session_saves_report_and_level(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"report": "좋았습니다.",
                                                        "level": "intermediate"})
    body = client.post(f"/api/sessions/{session}/end").json()
    assert body == {"report": "좋았습니다.", "level": "intermediate"}

    row = db.get_session(session)
    assert row["report"] == "좋았습니다."
    assert row["level"] == "intermediate"
    assert row["ended_at"] is not None


def test_the_transcript_reaches_the_report_prompt(client, session, monkeypatch):
    seen = {}

    def capture(messages, schema, **kw):
        seen["text"] = " ".join(m["content"] for m in messages)
        return {"report": "r", "level": "beginner"}

    monkeypatch.setattr("app.api.llm.chat_json", capture)
    client.post(f"/api/sessions/{session}/end")
    assert "I go there yesterday" in seen["text"]
    assert "Use past tense." in seen["text"]


def test_script_mode_report_gets_the_original_script_for_comparison(client, monkeypatch):
    sid = db.create_session("en", "script", scenario_id="standup-meeting-en")
    db.add_message(sid, "user", "I finish the login bug yesterday")
    seen = {}

    def capture(messages, schema, **kw):
        seen["text"] = " ".join(m["content"] for m in messages)
        return {"report": "r", "level": "beginner"}

    monkeypatch.setattr("app.api.llm.chat_json", capture)
    client.post(f"/api/sessions/{sid}/end")

    assert "The script the learner was reading from" in seen["text"]
    assert "I finished the login bug" in seen["text"]      # the scripted line
    assert "I finish the login bug yesterday" in seen["text"]  # what they said


def test_free_mode_report_does_not_include_a_script_section(client, session, monkeypatch):
    seen = {}

    def capture(messages, schema, **kw):
        seen["text"] = " ".join(m["content"] for m in messages)
        return {"report": "r", "level": "beginner"}

    monkeypatch.setattr("app.api.llm.chat_json", capture)
    client.post(f"/api/sessions/{session}/end")
    assert "The script the learner was reading from" not in seen["text"]


def test_the_new_level_drives_the_next_session(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"report": "r", "level": "advanced"})
    client.post(f"/api/sessions/{session}/end")
    assert db.latest_level("en") == "advanced"


def test_an_invalid_level_from_the_model_falls_back_to_beginner(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"report": "r", "level": "wizard"})
    assert client.post(f"/api/sessions/{session}/end").json()["level"] == "beginner"


def test_ending_twice_is_rejected(client, session, monkeypatch):
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"report": "r", "level": "beginner"})
    client.post(f"/api/sessions/{session}/end")
    assert client.post(f"/api/sessions/{session}/end").status_code == 409


def test_ending_an_empty_session_still_closes_it(client, monkeypatch):
    sid = db.create_session("en", "free", scenario_id="airport-checkin-en")
    monkeypatch.setattr("app.api.llm.chat_json",
                        lambda messages, schema, **kw: {"report": "r", "level": "beginner"})
    assert client.post(f"/api/sessions/{sid}/end").status_code == 200
    assert db.get_session(sid)["ended_at"] is not None


def test_a_report_failure_still_closes_the_session(client, session, monkeypatch):
    def boom(messages, schema, **kw):
        raise Exception("model down")

    monkeypatch.setattr("app.api.llm.chat_json", boom)
    r = client.post(f"/api/sessions/{session}/end")
    assert r.status_code == 200
    assert "리포트" in r.json()["report"]
    assert db.get_session(session)["ended_at"] is not None


def test_history_lists_sessions_newest_first(client, session):
    later = db.create_session("ja", "lesson", topic="て form")
    ids = [s["id"] for s in client.get("/api/sessions").json()["sessions"]]
    assert ids[0] == later


def test_session_detail_returns_transcript(client, session):
    body = client.get(f"/api/sessions/{session}").json()
    assert body["session"]["id"] == session
    assert [m["speaker"] for m in body["messages"]] == ["bot", "user"]


def test_session_detail_404s_when_missing(client):
    assert client.get("/api/sessions/999").status_code == 404
```

- [ ] **Step 2: Run test to verify it fails**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_api_report.py -v`
Expected: FAIL — the end route returns 404

- [ ] **Step 3: Append the report routes to `app/api.py`**

```python
REPORT_UNAVAILABLE = "리포트를 만들지 못했습니다. 대화 기록은 그대로 저장되어 있습니다."


def _transcript(session_id: int) -> str:
    session = db.get_session(session_id)
    lines = []

    # In script mode the learner was reading fixed lines, so the report is far
    # more useful if the model can compare what they said against the original.
    if session and session["mode"] == "script" and session["scenario_id"]:
        scenario = scenarios.get_scenario(session["scenario_id"])
        if scenario:
            lines.append("The script the learner was reading from:")
            lines += [f"  {l['speaker']}: {l['text']}" for l in scenario["lines"]]
            lines.append("")
            lines.append("What the learner actually said:")

    for m in db.get_messages(session_id):
        lines.append(f"{m['speaker']}: {m['text']}")
        if m["correction"]:
            lines.append(f"  [correction] {m['correction']}")
        if m["suggestion"]:
            lines.append(f"  [suggestion] {m['suggestion']}")
    return "\n".join(lines)


@router.post("/sessions/{session_id}/end")
def finish_session(session_id: int):
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    if session["ended_at"] is not None:
        raise HTTPException(409, "this session has already ended")

    try:
        result = llm.chat_json(
            prompts.build_report_messages(session["language"], _transcript(session_id)),
            prompts.REPORT_SCHEMA,
        )
        report = result.get("report") or REPORT_UNAVAILABLE
        level = result.get("level")
    except Exception:
        report, level = REPORT_UNAVAILABLE, None

    # The schema constrains this, but a local model can still drift.
    if level not in config.LEVELS:
        level = "beginner"

    db.end_session(session_id, report, level)
    return {"report": report, "level": level}


@router.get("/sessions")
def session_history(limit: int = Query(default=20, ge=1, le=100)):
    return {"sessions": db.list_sessions(limit)}


@router.get("/sessions/{session_id}")
def session_detail(session_id: int):
    session = db.get_session(session_id)
    if session is None:
        raise HTTPException(404, "no such session")
    return {"session": session, "messages": db.get_messages(session_id)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest tests/test_api_report.py -v`
Expected: 12 passed

- [ ] **Step 5: Commit**

```bash
git add app/api.py tests/test_api_report.py
git commit -m "feat: generate session report and level estimate on session end"
```

---

### Task 11: Frontend — shell, styling, and conversation flow

**Files:**
- Create: `static/index.html`
- Create: `static/style.css`
- Create: `static/app.js`
- Delete: `static/.gitkeep`

**Interfaces:**
- Consumes: every `/api/*` endpoint from Tasks 8–10
- Produces: a working single-page UI. No automated tests — this task is verified by driving the real app in Chrome.

- [ ] **Step 1: Write `static/index.html`**

```html
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monologue</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header>
  <h1>Monologue</h1>
  <div class="status">
    <span id="status-ollama" class="dot" title="Ollama"></span>
    <span id="status-voicevox" class="dot" title="VOICEVOX"></span>
    <button id="btn-settings" class="ghost">설정</button>
  </div>
</header>

<main>
  <section id="setup">
    <div class="row">
      <label>언어
        <select id="language">
          <option value="en">English</option>
          <option value="ja">日本語</option>
        </select>
      </label>
      <label>모드
        <select id="mode">
          <option value="free">자유 상황극</option>
          <option value="script">스크립트 롤플레이</option>
          <option value="lesson">수업</option>
        </select>
      </label>
    </div>
    <label id="scenario-row">시나리오
      <select id="scenario"></select>
    </label>
    <label id="topic-row" hidden>오늘 배우고 싶은 것 <span class="hint">(비워두면 봇이 골라줍니다)</span>
      <input id="topic" type="text" placeholder="예: 과거형, 식당에서 쓰는 표현">
    </label>
    <button id="btn-start" class="primary">시작</button>
  </section>

  <section id="session" hidden>
    <div id="script-panel" hidden>
      <h2>대본</h2>
      <ol id="script-lines"></ol>
    </div>

    <div id="conversation"></div>

    <div id="controls">
      <button id="btn-mic" class="primary">🎤 말하기</button>
      <input id="text-input" type="text" placeholder="인식된 내용을 여기서 고칠 수 있습니다">
      <button id="btn-send">보내기</button>
      <button id="btn-next" hidden>다음 →</button>
      <button id="btn-end" class="ghost">세션 끝내기</button>
    </div>
    <p id="notice" class="notice" hidden></p>
  </section>

  <aside id="feedback" hidden>
    <h2>피드백</h2>
    <div id="feedback-list"></div>
  </aside>

  <section id="report" hidden>
    <h2>수업 리포트</h2>
    <p id="report-level"></p>
    <pre id="report-body"></pre>
    <button id="btn-restart" class="primary">새 세션</button>
  </section>
</main>

<dialog id="settings">
  <h2>설정</h2>
  <label>언어
    <select id="settings-language">
      <option value="en">English</option>
      <option value="ja">日本語</option>
    </select>
  </label>
  <div id="voice-list"></div>
  <button id="btn-close-settings">닫기</button>
</dialog>

<script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `static/style.css`**

```css
:root { color-scheme: light dark; --line: rgba(128,128,128,.3); }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
       margin: 0; padding: 0 20px 40px; line-height: 1.55; }
header { display: flex; align-items: center; justify-content: space-between;
         padding: 16px 0; border-bottom: 1px solid var(--line); margin-bottom: 20px; }
h1 { font-size: 1.2rem; margin: 0; }
h2 { font-size: .95rem; opacity: .75; margin: 0 0 10px; }
main { max-width: 860px; margin: 0 auto; }
.status { display: flex; align-items: center; gap: 10px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #999; }
.dot.up { background: #2a9d5c; } .dot.down { background: #c0392b; }
.row { display: flex; gap: 16px; }
label { display: block; margin-bottom: 14px; font-size: .85rem; }
select, input[type=text] { display: block; width: 100%; margin-top: 4px; padding: 8px;
    font: inherit; border: 1px solid var(--line); border-radius: 6px;
    background: transparent; color: inherit; }
.hint { opacity: .6; font-weight: normal; }
button { font: inherit; padding: 8px 18px; border-radius: 6px; cursor: pointer;
         border: 1px solid var(--line); background: transparent; color: inherit; }
button.primary { background: #2f6fed; color: #fff; border-color: #2f6fed; }
button.ghost { opacity: .8; }
button:disabled { opacity: .4; cursor: not-allowed; }
#conversation { margin: 20px 0; min-height: 160px; }
.msg { margin-bottom: 12px; padding: 10px 14px; border-radius: 10px; max-width: 78%; }
.msg.bot { background: rgba(128,128,128,.14); }
.msg.user { background: rgba(47,111,237,.16); margin-left: auto; }
#controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
#controls input { flex: 1; min-width: 220px; margin-top: 0; }
#feedback { margin-top: 28px; border-top: 1px solid var(--line); padding-top: 16px; }
.fb { border-left: 3px solid #2f6fed; padding: 8px 12px; margin-bottom: 12px;
      background: rgba(128,128,128,.08); font-size: .9rem; }
.fb .said { opacity: .65; font-style: italic; margin-bottom: 4px; }
.fb .label { font-weight: 600; font-size: .75rem; opacity: .7; }
.notice { background: rgba(200,140,0,.15); padding: 10px 14px; border-radius: 6px;
          font-size: .85rem; }
#script-lines li { padding: 6px 8px; border-radius: 6px; }
#script-lines li.current { background: rgba(47,111,237,.18); font-weight: 600; }
#script-lines li.done { opacity: .5; }
#report-body { white-space: pre-wrap; font: inherit;
               background: rgba(128,128,128,.1); padding: 14px; border-radius: 8px; }
dialog { border: 1px solid var(--line); border-radius: 10px; padding: 22px;
         min-width: 320px; background: Canvas; color: CanvasText; }
.voice { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.voice label { margin: 0; flex: 1; }
```

- [ ] **Step 3: Write `static/app.js`**

```javascript
'use strict';

const $ = (id) => document.getElementById(id);
const api = async (path, options) => {
  const res = await fetch(`/api${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || 'request failed');
  }
  return res;
};
const getJSON = async (path) => (await api(path)).json();
const postJSON = async (path, body) =>
  (await api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })).json();

const state = {
  sessionId: null,
  language: 'en',
  mode: 'free',
  scriptLines: [],
  scriptIndex: 0,
  recorder: null,
  chunks: [],
};

const BCP47 = { en: 'en-US', ja: 'ja-JP' };

/* ---------- status ---------- */

async function refreshHealth() {
  try {
    const h = await getJSON('/health');
    $('status-ollama').className = `dot ${h.ollama ? 'up' : 'down'}`;
    $('status-voicevox').className = `dot ${h.voicevox ? 'up' : 'down'}`;
    if (!h.ollama) notify('Ollama가 실행 중이 아닙니다. 터미널에서 ollama serve를 실행하세요.');
    else if (!h.voicevox && $('language').value === 'ja')
      notify('VOICEVOX가 꺼져 있습니다. docker compose up -d 를 실행하세요.');
  } catch {
    notify('서버에 연결할 수 없습니다.');
  }
}

function notify(message) {
  const el = $('notice');
  el.textContent = message;
  el.hidden = !message;
}

/* ---------- setup ---------- */

async function loadScenarios() {
  const language = $('language').value;
  const mode = $('mode').value;
  $('scenario-row').hidden = mode === 'lesson';
  $('topic-row').hidden = mode !== 'lesson';
  if (mode === 'lesson') return;

  const { scenarios } = await getJSON(`/scenarios?language=${language}&mode=${mode}`);
  $('scenario').innerHTML = scenarios
    .map((s) => `<option value="${s.id}">${s.title}</option>`)
    .join('');
}

async function startSession() {
  const payload = {
    language: $('language').value,
    mode: $('mode').value,
    scenario_id: $('mode').value === 'lesson' ? null : $('scenario').value,
    topic: $('topic').value.trim() || null,
  };
  $('btn-start').disabled = true;
  try {
    const data = await postJSON('/sessions', payload);
    state.sessionId = data.session_id;
    state.language = payload.language;
    state.mode = payload.mode;
    $('setup').hidden = true;
    $('session').hidden = false;
    $('feedback').hidden = false;
    $('conversation').innerHTML = '';
    $('feedback-list').innerHTML = '';
    notify('');

    if (data.mode === 'script') startScript(data.lines);
    else {
      $('script-panel').hidden = true;
      $('btn-next').hidden = true;
      $('btn-send').hidden = false;
      addMessage('bot', data.opening);
      play(data.opening_audio, data.opening);
    }
  } catch (err) {
    notify(`세션을 시작하지 못했습니다: ${err.message}`);
  } finally {
    $('btn-start').disabled = false;
  }
}

/* ---------- conversation ---------- */

function addMessage(who, text) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  $('conversation').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function addFeedback(said, correction, suggestion) {
  if (!correction && !suggestion) return;
  const div = document.createElement('div');
  div.className = 'fb';
  div.innerHTML = `<div class="said">"${said}"</div>`;
  if (correction) div.innerHTML += `<div><span class="label">교정</span><br>${correction}</div>`;
  if (suggestion) div.innerHTML += `<div><span class="label">이렇게도</span><br>${suggestion}</div>`;
  $('feedback-list').prepend(div);
}

async function sendTurn() {
  const text = $('text-input').value.trim();
  if (!text || !state.sessionId) return;
  $('text-input').value = '';
  addMessage('user', text);
  $('btn-send').disabled = true;
  try {
    const data = await postJSON('/chat', { session_id: state.sessionId, text });
    addMessage('bot', data.bot_reply);
    addFeedback(text, data.correction, data.suggestion);
    play(data.audio_key, data.bot_reply);
    await uploadPendingRecording();
  } catch (err) {
    notify(`전송 실패: ${err.message}`);
  } finally {
    $('btn-send').disabled = false;
  }
}

/* ---------- script mode ---------- */

function startScript(lines) {
  state.scriptLines = lines;
  state.scriptIndex = 0;
  $('script-panel').hidden = false;
  $('btn-next').hidden = false;
  $('btn-send').hidden = true;
  $('script-lines').innerHTML = lines
    .map((l, i) => `<li data-i="${i}"><b>${l.speaker === 'bot' ? '봇' : '나'}</b> ${l.text}</li>`)
    .join('');
  advanceScript();
}

function advanceScript() {
  const items = [...$('script-lines').children];
  items.forEach((li, i) => {
    li.classList.toggle('current', i === state.scriptIndex);
    li.classList.toggle('done', i < state.scriptIndex);
  });
  const line = state.scriptLines[state.scriptIndex];
  if (!line) {
    notify('대본이 끝났습니다. 세션을 끝내면 리포트를 받을 수 있습니다.');
    $('btn-next').disabled = true;
    return;
  }
  if (line.speaker === 'bot') play(line.audio_key, line.text);
}

async function nextScriptLine() {
  const line = state.scriptLines[state.scriptIndex];
  if (line && line.speaker === 'user') {
    const spoken = $('text-input').value.trim() || line.text;
    $('text-input').value = '';
    addMessage('user', spoken);
    try {
      const data = await postJSON('/chat', { session_id: state.sessionId, text: spoken });
      addFeedback(spoken, data.correction, data.suggestion);
      await uploadPendingRecording();
    } catch (err) {
      notify(`저장 실패: ${err.message}`);
    }
  } else if (line) {
    addMessage('bot', line.text);
  }
  state.scriptIndex += 1;
  advanceScript();
}

/* ---------- audio out ---------- */

function play(audioKey, fallbackText) {
  if (audioKey) {
    new Audio(`/api/audio/${audioKey}.wav`).play().catch(() => speakInBrowser(fallbackText));
    return;
  }
  notify('서버 음성 생성에 실패해 브라우저 음성으로 대체합니다. 품질이 떨어집니다.');
  speakInBrowser(fallbackText);
}

function speakInBrowser(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = BCP47[state.language];
  speechSynthesis.speak(u);
}

/* ---------- speech in ---------- */

function setupRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    $('btn-mic').disabled = true;
    notify('이 브라우저는 음성 인식을 지원하지 않습니다. Chrome을 쓰거나 아래 입력창에 직접 입력하세요.');
    return null;
  }
  const recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.onresult = (e) => { $('text-input').value = e.results[0][0].transcript; };
  recognition.onerror = (e) => notify(`음성 인식 실패(${e.error}). 입력창에 직접 입력하세요.`);
  recognition.onend = () => { $('btn-mic').textContent = '🎤 말하기'; stopRecording(); };
  return recognition;
}

const recognition = setupRecognition();

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.recorder = new MediaRecorder(stream);
    state.chunks = [];
    state.recorder.ondataavailable = (e) => state.chunks.push(e.data);
    state.recorder.start();
  } catch {
    state.recorder = null; // mic denied — text input still works
  }
}

function stopRecording() {
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
}

async function uploadPendingRecording() {
  if (!state.chunks.length) return;
  const blob = new Blob(state.chunks, { type: 'audio/webm' });
  state.chunks = [];
  try {
    const { messages } = await getJSON(`/sessions/${state.sessionId}`);
    const lastUser = [...messages].reverse().find((m) => m.speaker === 'user');
    if (!lastUser) return;
    const form = new FormData();
    form.append('message_id', lastUser.id);
    form.append('file', blob, 'clip.webm');
    await api(`/sessions/${state.sessionId}/audio`, { method: 'POST', body: form });
  } catch {
    /* recording is a Phase 2 nicety — never interrupt practice for it */
  }
}

/* ---------- end ---------- */

async function endSession() {
  if (!state.sessionId) return;
  $('btn-end').disabled = true;
  try {
    const data = await postJSON(`/sessions/${state.sessionId}/end`);
    $('session').hidden = true;
    $('report').hidden = false;
    $('report-level').textContent = `추정 수준: ${data.level}`;
    $('report-body').textContent = data.report;
  } catch (err) {
    notify(`리포트 생성 실패: ${err.message}`);
  } finally {
    $('btn-end').disabled = false;
  }
}

/* ---------- wiring ---------- */

$('language').addEventListener('change', () => { loadScenarios(); refreshHealth(); });
$('mode').addEventListener('change', loadScenarios);
$('btn-start').addEventListener('click', startSession);
$('btn-send').addEventListener('click', sendTurn);
$('btn-next').addEventListener('click', nextScriptLine);
$('btn-end').addEventListener('click', endSession);
$('btn-restart').addEventListener('click', () => window.location.reload());
$('text-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ($('btn-next').hidden ? sendTurn() : nextScriptLine());
});
$('btn-mic').addEventListener('click', () => {
  if (!recognition) return;
  notify('');
  $('btn-mic').textContent = '● 듣는 중...';
  startRecording();
  recognition.lang = BCP47[$('language').value];
  recognition.start();
});

loadScenarios();
refreshHealth();
```

- [ ] **Step 4: Remove the placeholder and start the server**

```bash
git rm static/.gitkeep
```

Start VOICEVOX and the app:

```bash
docker compose up -d
```

```powershell
C:\git\Monologue\venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

- [ ] **Step 5: Verify the free-roleplay flow in Chrome**

Open `http://127.0.0.1:8000`. Check, in order:

1. Both status dots are green.
2. English + 자유 상황극 + 공항 체크인 → 시작. The bot's opening line appears **and is spoken aloud** in `am_adam`.
3. Click 말하기, say a sentence, confirm the recognised text lands in the input box, then 보내기.
4. The bot replies in 1–3 sentences with no markdown, and it is spoken.
5. A correction and a suggestion appear in the 피드백 panel.
6. Switch 언어 to 日本語 and run a Japanese free scenario. Confirm the Japanese voice sounds like VOICEVOX (`剣崎雌雄`), not a robotic browser voice.

- [ ] **Step 6: Verify the script and lesson flows**

1. English + 스크립트 롤플레이 + 회사 데일리 스탠드업. The script panel lists 8 lines, the current one is highlighted, bot lines are spoken, and 다음 advances.
2. 수업 mode with the topic box empty, then again with a topic such as `past tense`. Confirm the teacher opens differently in each case and stays short.

- [ ] **Step 7: Verify session end**

Click 세션 끝내기 in any mode. A Korean report and an estimated level appear. Confirm the row was written:

```powershell
C:\git\Monologue\venv\Scripts\python.exe -c "from app import db; s=db.list_sessions(1)[0]; print(s['level']); print(s['report'])"
```

- [ ] **Step 8: Commit**

```bash
git add static/index.html static/style.css static/app.js
git commit -m "feat: add single-page frontend for all three practice modes"
```

---

### Task 12: Frontend — settings and voice preview

**Files:**
- Modify: `static/app.js` (append; do not alter existing functions)

**Interfaces:**
- Consumes: `GET /api/voices`, `POST /api/voices`, `POST /api/tts/preview`
- Produces: a working settings dialog. Verified by hand.

- [ ] **Step 1: Append the settings code to `static/app.js`**

```javascript
/* ---------- settings ---------- */

async function renderVoiceList() {
  const language = $('settings-language').value;
  const { voices, selected } = await getJSON(`/voices?language=${language}`);
  $('voice-list').innerHTML = voices
    .map(
      (v) => `<div class="voice">
        <input type="radio" name="voice" id="v-${v.id}" value="${v.id}" ${v.id === selected ? 'checked' : ''}>
        <label for="v-${v.id}">${v.label} <span class="hint">${v.gender === 'male' ? '남성' : '여성'}</span></label>
        <button data-preview="${v.id}">▶ 미리듣기</button>
      </div>`
    )
    .join('');
}

async function previewVoice(voice) {
  const language = $('settings-language').value;
  try {
    const res = await api('/tts/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language, voice }),
    });
    const url = URL.createObjectURL(await res.blob());
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  } catch (err) {
    notify(`미리듣기 실패: ${err.message}`);
  }
}

$('btn-settings').addEventListener('click', async () => {
  $('settings-language').value = $('language').value;
  await renderVoiceList();
  $('settings').showModal();
});
$('settings-language').addEventListener('change', renderVoiceList);
$('btn-close-settings').addEventListener('click', () => $('settings').close());
$('voice-list').addEventListener('click', (e) => {
  const preview = e.target.dataset.preview;
  if (preview) previewVoice(preview);
});
$('voice-list').addEventListener('change', async (e) => {
  if (e.target.name !== 'voice') return;
  await postJSON('/voices', {
    language: $('settings-language').value,
    voice: e.target.value,
  });
});
```

- [ ] **Step 2: Verify the settings dialog by hand**

With the server running, open `http://127.0.0.1:8000` and:

1. Click 설정. Five English voices are listed with `Adam` pre-selected.
2. Click 미리듣기 on each. All five play and sound distinct.
3. Select `Kore`, close the dialog, reload the page, reopen 설정 — `Kore` is still selected.
4. Switch the dialog language to 日本語. Four VOICEVOX speakers appear with `剣崎雌雄` selected. Preview each.
5. Start an English session and confirm the bot now speaks in `Kore`.

- [ ] **Step 3: Commit**

```bash
git add static/app.js
git commit -m "feat: add settings dialog with per-language voice preview"
```

---

### Task 13: README and end-to-end smoke run

**Files:**
- Create: `README.md`
- Create: `run.ps1`

**Interfaces:**
- Consumes: everything
- Produces: a documented, one-command start.

- [ ] **Step 1: Write `run.ps1`**

```powershell
# Start everything Monologue needs, then the app itself.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "Starting VOICEVOX..." -ForegroundColor Cyan
docker compose --project-directory $root up -d | Out-Null

Write-Host "Waiting for VOICEVOX..." -NoNewline
for ($i = 0; $i -lt 40; $i++) {
    try {
        Invoke-RestMethod "http://127.0.0.1:50021/version" -TimeoutSec 2 | Out-Null
        Write-Host " ready" -ForegroundColor Green
        break
    } catch { Write-Host "." -NoNewline; Start-Sleep -Seconds 2 }
}

try {
    Invoke-RestMethod "http://127.0.0.1:11434/api/tags" -TimeoutSec 3 | Out-Null
    Write-Host "Ollama is running" -ForegroundColor Green
} catch {
    Write-Host "Ollama is NOT running. Open another window and run: ollama serve" -ForegroundColor Yellow
}

Write-Host "Open http://127.0.0.1:8000 in Chrome" -ForegroundColor Cyan
& "$root\venv\Scripts\python.exe" -m uvicorn app.main:app --port 8000 --app-dir $root
```

- [ ] **Step 2: Write `README.md`**

````markdown
# Monologue

English and Japanese speaking practice with a local bot. Three modes — free
roleplay, script roleplay, and a lesson with a teacher persona — plus grammar
corrections, phrasing suggestions, and an end-of-session report that also
estimates your level.

Everything runs locally. Running cost is zero.

## What runs where

| Component | Form | Why |
|---|---|---|
| Ollama (`qwen2.5:14b`) | native install | uses the GPU directly, no WSL2 passthrough layer |
| VOICEVOX (Japanese TTS) | Docker | official image, one-line setup, restarts with the machine |
| Kokoro (English TTS) | in-process | a Python library, not a service |
| SQLite | a file | single user, tiny data, nothing to run |

## First-time setup

1. Install [Ollama](https://ollama.com) and pull the model:

   ```powershell
   winget install --id Ollama.Ollama -e
   ollama pull qwen2.5:14b
   ```

2. Download the Kokoro model files into `engines/kokoro/`:

   - `kokoro-v1.0.onnx`
   - `voices-v1.0.bin`

   Both come from the `kokoro-onnx` releases (`model-files-v1.0`).

3. Create the virtualenv and install dependencies:

   ```powershell
   python -m venv venv
   .\venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

## Running

```powershell
.\run.ps1
```

Then open <http://127.0.0.1:8000> in **Chrome** (speech recognition needs it).

The two dots in the header show whether Ollama and VOICEVOX are up.

## Tests

```powershell
.\venv\Scripts\python.exe -m pytest -m "not engine"
```

`-m engine` runs the tests that hit the real Kokoro and VOICEVOX engines; they
need the model files present and VOICEVOX running.

## Voices

English uses Kokoro with US-accent voices only — British voices are excluded on
purpose so the accent being modelled stays consistent. Japanese uses VOICEVOX.
Change either in 설정.

| English | Japanese (VOICEVOX) |
|---|---|
| `am_adam` (default), `am_fenrir`, `af_heart`, `af_bella`, `af_kore` | 剣崎雌雄 (default), 青山龍星, 琴詠ニア, 春日部つむぎ |

Japanese speech is produced with [VOICEVOX](https://voicevox.hiroshiba.jp/).

## Design notes

See `docs/superpowers/specs/2026-08-29-monologue-design.md` for why each engine
was chosen, including the listening comparison and the finding that Kokoro
cannot read kanji without a separate G2P step.
````

- [ ] **Step 3: Run the full test suite**

Run: `C:\git\Monologue\venv\Scripts\python.exe -m pytest -v`
Expected: everything passes (engine tests included, with VOICEVOX and Ollama running)

- [ ] **Step 4: Full end-to-end smoke run**

Stop everything, then start only with `.\run.ps1`. In Chrome, complete one full session in each of the six combinations:

| Language | Mode | Check |
|---|---|---|
| English | free | bot speaks in the selected US voice, corrections appear |
| English | script | 8 lines, highlight advances, bot lines are spoken |
| English | lesson | teacher pitches to the stored level, stays short |
| Japanese | free | VOICEVOX voice, kanji read correctly (no stretched audio) |
| Japanese | script | 8 lines, highlight advances |
| Japanese | lesson | teaches in Japanese, explanations stay brief |

Each must end with a Korean report and a level. Then confirm the level carried over:

```powershell
C:\git\Monologue\venv\Scripts\python.exe -c "from app import db; print(db.latest_level('en'), db.latest_level('ja'))"
```

- [ ] **Step 5: Commit**

```bash
git add README.md run.ps1
git commit -m "docs: add README and one-command run script"
```

---

## Phase 1 Done

Working: three modes in two languages, natural bot speech per language, live
corrections and suggestions, recorded learner audio stored for later, an
end-of-session report, and a level estimate that feeds the next lesson.

Phase 2 (pronunciation scoring) builds on `messages.audio_path`, which this
phase has been filling all along.
