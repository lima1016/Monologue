import json

import pytest

from app import db, scenarios


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    """scenarios_for/get_scenario now read the user_scenarios table on every
    call, so even tests that never touch generated scenarios need a real,
    migrated database underneath them rather than the repo's own
    monologue.db (which may not exist, or may predate this table, on a
    fresh checkout)."""
    monkeypatch.setattr(db.config, "DB_PATH", tmp_path / "test.db")
    db.init_db()


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


def test_scenario_without_id_raises(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps([{"language": "en", "type": "free", "title": "t", "persona_prompt": "p", "max_turns": 8}]), encoding="utf-8")
    with pytest.raises(scenarios.ScenarioError):
        scenarios.load_scenarios(bad)


def test_malformed_json_file_raises_scenario_error(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("{not valid json", encoding="utf-8")
    with pytest.raises(scenarios.ScenarioError):
        scenarios.load_scenarios(bad)


def test_generated_scenarios_join_the_catalogue_and_come_first(tmp_path, monkeypatch):
    """The learner's own scenarios are the ones they meant; the built-in
    catalogue is the fallback behind them."""
    monkeypatch.setattr(db.config, "DB_PATH", tmp_path / "test.db")
    db.init_db()
    db.add_user_scenario({"id": "user-x", "language": "en", "type": "free",
                          "title": "구직 면접", "goal": "g",
                          "persona_prompt": "p", "max_turns": 8})

    ids = [s["id"] for s in scenarios.scenarios_for("en", "free")]
    assert ids[0] == "user-x"
    assert "restaurant-seating-en" in ids


def test_get_scenario_finds_a_generated_one(tmp_path, monkeypatch):
    monkeypatch.setattr(db.config, "DB_PATH", tmp_path / "test.db")
    db.init_db()
    db.add_user_scenario({"id": "user-y", "language": "en", "type": "free",
                          "title": "t", "goal": "g", "persona_prompt": "p", "max_turns": 8})
    assert scenarios.get_scenario("user-y")["title"] == "t"
    assert scenarios.get_scenario("restaurant-seating-en")["language"] == "en"
    assert scenarios.get_scenario("nope") is None
