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
