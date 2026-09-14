"""The pick screen's header on a narrow phone. No suite renders CSS, so the two
rules the review asked for are pinned by reading the stylesheet."""
import re
from pathlib import Path

CSS = (Path(__file__).resolve().parent.parent / "static" / "css" / "components.css").read_text(encoding="utf-8")


def _rule(selector, text=CSS):
    m = re.search(re.escape(selector) + r"\s*\{([^}]*)\}", text)
    assert m, f"no rule for {selector}"
    return m.group(1)


def test_the_pick_header_wraps():
    assert re.search(r"flex-wrap:\s*wrap", _rule(".pick-head"))


def test_the_mode_name_steps_down_under_480px():
    blocks = re.findall(r"@media \(max-width: 480px\)\s*\{(.*?)\n\}", CSS, re.S)
    assert blocks, "no 480px block"
    assert any(re.search(r"font-size:\s*var\(--text-xl\)", _rule("#pick-mode", b)) for b in blocks if "#pick-mode" in b)


def test_the_loading_note_spans_the_grid():
    assert re.search(r"grid-column:\s*1\s*/\s*-1", _rule(".theme-loading"))


def test_the_step_line_holds_one_line_while_empty():
    # #start-status is kept in place with .is-invisible (spec R5); an empty
    # flex row is zero tall, so without a floor it would still collapse.
    assert re.search(r"min-height:", _rule(".start-status"))


def test_buttons_whose_neighbourhood_changes_keep_a_floor_width():
    # spec R7: the recommendation's start buttons and #btn-start.
    assert re.search(r"min-width:", _rule(".btn-stable"))


def test_skeleton_cards_are_theme_card_sized():
    # The loading note sits over the placeholders instead of adding a row
    # above them, so the grid does not shrink by a line when the list lands.
    assert re.search(r"position:\s*absolute", _rule(".theme-loading"))
    assert re.search(r"position:\s*relative", _rule(".theme-grid"))


def test_home_placeholders_keep_their_lines():
    assert re.search(r"min-height:", _rule(".today-alt"))
    assert re.search(r"min-height:", _rule("#library-progress"))
    assert re.search(r"visibility:\s*hidden", _rule("#week-card.is-skeleton .goal"))
