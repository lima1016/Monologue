"""My page on a wide screen (docs/superpowers/specs/2026-09-19-monologue-desktop-layout-design.md,
Task 2, 시안 static/mock/mypage-b.html): the menu down the left, the 성장 tab's
grid, and the 900px fold back to the phone's page. No suite renders CSS, so
the rules are read -- and the numbers growth.js lays its charts out with are
checked against the CSS they must agree with."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS_DIR = ROOT / "static" / "css"


def _read(path):
    # The main tree checks out with autocrlf; compare on \n.
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


COMPONENTS = _read(CSS_DIR / "components.css")
TOKENS = _read(CSS_DIR / "tokens.css")
GROWTH_JS = _read(ROOT / "static" / "js" / "growth.js")


def _rule(selector, text=COMPONENTS):
    m = re.search(r"(?:^|\n)\s*" + re.escape(selector) + r"\s*\{([^}]*)\}", text)
    assert m, f"no rule for {selector}"
    return m.group(1)


def _media_blocks(text, width):
    blocks = []
    for m in re.finditer(r"@media \(max-width: " + str(width) + r"px\) \{", text):
        depth, i = 1, m.end()
        while depth:
            depth += {"{": 1, "}": -1}.get(text[i], 0)
            i += 1
        blocks.append(text[m.end():i - 1])
    return blocks


def _fold():
    blocks = [b for b in _media_blocks(COMPONENTS, 900) if "#mypage {" in b]
    assert len(blocks) == 1, "one 900px block owns my page's fold"
    return blocks[0]


def _js_const(name):
    m = re.search(r"const " + name + r" = (\d+);", GROWTH_JS)
    assert m, name
    return int(m.group(1))


def _px_token(name):
    m = re.search(r"--" + name + r":\s*(\d+)px;", TOKENS)
    assert m, name
    return int(m.group(1))


def test_my_page_fills_the_content_width_with_a_240px_menu():
    assert _px_token("mypage-nav-w") == 240
    page = _rule("#mypage")
    assert "max-width: var(--content-w)" in page
    assert "grid-template-columns: var(--mypage-nav-w) minmax(0, 1fr)" in page
    assert "align-items: start" in page, "a stretched menu could not stick"


def test_the_menu_stays_in_view_while_the_panel_scrolls():
    nav = _rule(".mypage-nav")
    assert "position: sticky" in nav and "top: var(--space-4)" in nav


def test_the_tabs_are_a_column_with_the_selected_one_on_the_accent_wash():
    assert "flex-direction: column" in _rule(".mypage-tabs")
    selected = _rule('.mypage-tabs [role="tab"][aria-selected="true"]')
    assert "background: var(--accent-soft)" in selected and "color: var(--accent-ink)" in selected
    assert "justify-content: space-between" in _rule('.mypage-tabs [role="tab"]'), "복습's count at the row's end"


def test_below_900px_the_menu_goes_back_above_the_panel_and_the_tabs_are_one_row():
    fold = _fold()
    assert re.search(r"#mypage \{ max-width: 640px; grid-template-columns: minmax\(0, 1fr\);", fold)
    assert re.search(r"\.mypage-nav \{ position: static; \}", fold)
    assert re.search(r"\.mypage-tabs \{ flex-direction: row;[^}]*border-bottom: 1px solid var\(--line\)", fold)
    assert re.search(r'\.mypage-tabs \[role="tab"\]\[aria-selected="true"\] \{[^}]*border-bottom-color: var\(--accent\)', fold)
    # The level is one line in the head again: no card, no 내 레벨.
    assert re.search(r"\.level-strip \{ background: none; border: 0;", fold)
    assert re.search(r"\.level-strip > \.level-label \{ display: none; \}", fold)
    assert re.search(r"\.level-sep, \.level-scale \{ display: inline; \}", fold)
    assert re.search(r"#weak-section \{ display: block; \}", fold)


def test_the_level_line_holds_the_room_of_what_lands_in_it_both_ways():
    """Wide: the level, the line under it and the button row. Narrow: one row
    of buttons (two on a phone, the 560px rule, which must come after the
    900px one to win)."""
    wide = _rule(".level-line")
    assert "flex-direction: column" in wide
    assert "min-height: calc(var(--text-lg) * 1.3 + var(--text-sm) * 1.55 +" in wide
    assert "display: none" in _rule(".level-sep")
    narrow = _fold()
    assert "min-height: calc(var(--text-xs) * 1.55 + var(--space-1) * 2 + 2px)" in narrow
    phone = [b for b in _media_blocks(COMPONENTS, 560) if ".level-line" in b]
    assert len(phone) == 1
    assert COMPONENTS.index(phone[0]) > COMPONENTS.index(narrow)


def test_growth_js_counts_with_the_same_numbers_as_the_css():
    """growth.js draws every chart at the inside width of its block, from the
    panel's width: a block's padding and border, the gaps, and the
    calendar's side column must be what the CSS gives them."""
    space4 = int(re.search(r"--space-4:\s*(\d+)px", TOKENS).group(1))
    assert _js_const("BLOCK_PAD") == 2 * space4 + 2
    block = _rule(".growth-block")
    assert "padding: var(--space-4)" in block and "border: 1px solid" in block
    assert _js_const("COL_GAP") == space4
    for sel in (".growth-grid", ".growth-cal-body"):
        assert "gap: var(--space-4)" in _rule(sel), sel
    assert _js_const("CAL_SIDE_W") == _px_token("growth-cal-side")
    assert "var(--growth-cal-side)" in _rule(".growth-cal-body.is-wide")
    # Below 900px my page is a 640px column: always one column there.
    wide_min = int(re.search(r"export const WIDE_MIN = (\d+);", GROWTH_JS).group(1))
    assert wide_min > 640


def test_the_growth_grid_puts_accuracy_and_the_tests_beside_1min_speaking():
    grid = _rule(".growth-grid.is-wide")
    assert "grid-template-columns: repeat(2, minmax(0, 1fr))" in grid
    assert 'grid-template-areas: "acc timed" "tests timed"' in grid
    assert "grid-template-rows: auto 1fr" in grid, "the tests sit right under accuracy"
    assert "grid-template-columns: minmax(0, 1fr)" in _rule(".growth-grid")
    for block, area in (("acc", "acc"), ("timed", "timed"), ("tests", "tests")):
        assert f"grid-area: {area}" in _rule(f".growth-grid.is-wide > .growth-{block}-block")


def test_the_tiles_are_four_across_and_two_on_a_phone():
    assert "repeat(4, minmax(0, 1fr))" in _rule(".growth-tiles")
    phone = [b for b in _media_blocks(COMPONENTS, 600) if ".growth-tiles" in b]
    assert len(phone) == 1 and "repeat(2, minmax(0, 1fr))" in phone[0]


def test_review_cards_go_two_a_row_when_two_whole_ones_fit_each_its_own_height():
    body = _rule("#review-list")
    assert "grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr))" in body
    assert "align-items: start" in body, "a card's fold opening must not stretch the one beside it"
    assert "grid-column: 1 / -1" in _rule(".review-empty")


def test_weak_spots_are_the_coach_and_the_tags_side_by_side():
    assert "grid-template-columns: repeat(2, minmax(0, 1fr))" in _rule("#weak-section")
    assert "margin-bottom" not in _rule(".coach"), "the gap between the two is the grid's"
    assert "margin: 0 0 var(--space-2)" in _rule(".weak-tags > .label")


def test_nothing_new_on_my_page_moves_or_names_a_colour():
    for sel in (".mypage-nav", ".mypage-tabs", ".growth-tiles", ".growth-tile", ".growth-block",
                ".growth-grid", ".growth-cal-body", ".level-strip"):
        body = _rule(sel)
        assert "transform" not in body and "animation" not in body and "transition" not in body, sel
        assert not re.search(r"#[0-9a-fA-F]{3,8}\b|rgba?\(", body), sel
