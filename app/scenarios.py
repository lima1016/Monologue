"""Loading and querying the static scenario catalogue.

Only `free` and `script` scenarios live here. `lesson` sessions are assembled at
request time and have no catalogue entry.
"""
import json
from functools import lru_cache

from app import config, db


class ScenarioError(Exception):
    """A scenario file is malformed."""


def _validate(item) -> None:
    if not item.get("id"):
        raise ScenarioError("scenario is missing an id")
    where = f"scenario {item['id']}"
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
        return list(_load_default())
    return _read(path)


def _read(path) -> list[dict]:
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ScenarioError(f"{path} is not valid JSON: {exc}") from exc
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
    """Catalogue entries for a language, optionally narrowed to one type.

    Generated scenarios come first: the learner asked for those by name, while
    the built-in catalogue is what we offer when they have not.
    """
    items = [s for s in load_scenarios() if s["language"] == language]
    if mode is not None:
        items = [s for s in items if s["type"] == mode]
    return db.user_scenarios(language, mode) + items


def get_scenario(scenario_id):
    for s in load_scenarios():
        if s["id"] == scenario_id:
            return s
    return db.get_user_scenario(scenario_id)
