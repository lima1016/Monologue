"""SQLite data layer. The only module that touches the database.

No ORM: three tables do not justify one, and keeping the surface small means a
future storage swap only rewrites this file.
"""
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

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
    created_at    TEXT    NOT NULL,
    UNIQUE(session_id, turn)
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, turn);
CREATE INDEX IF NOT EXISTS idx_sessions_language ON sessions(language, ended_at);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# Each entry migrates the database from version i to version i+1. Entries are
# append-only: editing one that has already run would leave databases with
# different shapes depending on when they were created.
MIGRATIONS = [
    # v0 -> v1: the Phase 1 schema
    [SCHEMA],
    # v1 -> v2: structured feedback fields (Phase 2A)
    [
        "ALTER TABLE messages ADD COLUMN ok INTEGER",
        "ALTER TABLE messages ADD COLUMN fixed TEXT",
        "ALTER TABLE messages ADD COLUMN tag TEXT",
    ],
]


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


def schema_version() -> int:
    with connect() as conn:
        return conn.execute("PRAGMA user_version").fetchone()[0]


def _stamp_phase1_database(conn) -> None:
    """A database created before migrations existed sits at user_version 0 with
    the v1 schema already applied. Replaying MIGRATIONS[0] against it today would
    be harmless, since every statement in SCHEMA is CREATE ... IF NOT EXISTS — but
    that harmlessness is an accident of what SCHEMA happens to contain, and this
    repo's old habit was exactly "add a column to SCHEMA" (the bug this task
    exists to prevent). Stamping the database as v1 means the legacy path never
    executes MIGRATIONS[0] at all, so it stops depending on SCHEMA staying
    idempotent forever."""
    if conn.execute("PRAGMA user_version").fetchone()[0] != 0:
        return
    already = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).fetchone()
    if already:
        conn.execute("PRAGMA user_version = 1")


def init_db() -> None:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        _stamp_phase1_database(conn)
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        for step in MIGRATIONS[version:]:
            for statement in step:
                conn.executescript(statement)
            version += 1
            # PRAGMA does not accept bound parameters; version is an int we
            # computed ourselves, never user input.
            conn.execute(f"PRAGMA user_version = {version}")


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


def add_message(session_id, speaker, text, correction=None, suggestion=None,
                ok=None, fixed=None, tag=None) -> int:
    """Insert a message and auto-increment its turn within the session.

    Turn is computed inside the INSERT subquery to ensure atomicity: two concurrent
    calls for the same session will not both read MAX(turn) before either acquires
    the write lock, which would produce duplicate turn values. The UNIQUE constraint
    on (session_id, turn) catches any violation as a loud error.

    ok/fixed/tag are the structured half of the feedback; correction/suggestion
    stay as the prose explanation shown when the learner expands a chip.
    """
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO messages (session_id, turn, speaker, text, correction,"
            " suggestion, ok, fixed, tag, created_at)"
            " SELECT ?,"
            "        (SELECT COALESCE(MAX(turn), 0) + 1 FROM messages WHERE session_id = ?),"
            "        ?, ?, ?, ?, ?, ?, ?, ?",
            (session_id, session_id, speaker, text, correction, suggestion,
             ok, fixed, tag, _now()),
        )
        return cur.lastrowid


def get_messages(session_id) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY turn", (session_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def delete_last_turn(session_id) -> int:
    """Drop the most recent learner turn and the bot reply that followed it.

    Undo exists because speech recognition mishears: a turn built on a sentence
    the learner did not say carries a bot reply and a correction that teach
    nothing, so they are removed rather than kept as history. Deleting the rows
    also frees their turn numbers, which matters because messages carries
    UNIQUE(session_id, turn) and add_message derives the next turn from MAX.

    Returns the number of rows removed: 2 for a normal turn, 1 if the bot reply
    never landed, 0 if the learner has not spoken yet.
    """
    with connect() as conn:
        last_user = conn.execute(
            "SELECT turn FROM messages WHERE session_id = ? AND speaker = 'user'"
            " ORDER BY turn DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        if last_user is None:
            return 0
        cur = conn.execute(
            "DELETE FROM messages WHERE session_id = ? AND turn >= ?",
            (session_id, last_user["turn"]),
        )
        return cur.rowcount


def set_message_audio(message_id, audio_path) -> None:
    with connect() as conn:
        conn.execute("UPDATE messages SET audio_path = ? WHERE id = ?", (audio_path, message_id))


def clear_session_audio(session_id) -> list[str]:
    """Forget the learner's recordings for one session.

    Nothing reads a recording after its session ends -- the report is written
    from the text transcript, and both places that play a clip back (the
    session screen and, later, shadowing) do so while the session is still
    running. Keeping them only accumulates the learner's voice on disk for no
    purpose.

    Returns the stored paths so the caller can unlink the files; this module
    does not touch the filesystem.
    """
    with connect() as conn:
        rows = conn.execute(
            "SELECT audio_path FROM messages"
            " WHERE session_id = ? AND audio_path IS NOT NULL",
            (session_id,),
        ).fetchall()
        conn.execute(
            "UPDATE messages SET audio_path = NULL WHERE session_id = ?", (session_id,)
        )
    return [r["audio_path"] for r in rows]


def stale_open_sessions(hours=24) -> list[int]:
    """Unfinished sessions with a recording still waiting to be collected.

    A closed browser tab leaves a session open forever -- there were eight in
    the real database when this was written. "Abandoned" is judged by the last
    activity in the session, not by when it started: a session opened
    yesterday and still being actively used must not look identical to one
    nobody has touched since. COALESCE falls back to started_at only for a
    session that never got a single message, since that is the only timestamp
    such a session has.

    Restricted to sessions that still hold a recording so a session already
    swept by a previous call drops out on its own, rather than being
    reprocessed on every future call forever. Its ended_at is deliberately
    left NULL -- stamping it would make db.latest_level treat an abandoned
    session as a finished one with no level recorded.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(timespec="seconds")
    with connect() as conn:
        rows = conn.execute(
            "SELECT s.id FROM sessions s"
            " WHERE s.ended_at IS NULL"
            "   AND COALESCE("
            "         (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = s.id),"
            "         s.started_at"
            "       ) < ?"
            "   AND EXISTS (SELECT 1 FROM messages m2"
            "               WHERE m2.session_id = s.id AND m2.audio_path IS NOT NULL)"
            " ORDER BY s.id",
            (cutoff,),
        ).fetchall()
    return [r["id"] for r in rows]


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
