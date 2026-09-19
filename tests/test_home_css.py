"""The desktop home (docs/superpowers/specs/2026-09-19-monologue-desktop-layout-design.md,
Task 1): the content width token, the 900px fold, and the hero/tile rules that
keep the screen from jumping. No suite renders CSS, so the rules are read."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS_DIR = ROOT / "static" / "css"


def _read(name):
    # The main tree checks out with autocrlf; compare on \n.
    return (CSS_DIR / name).read_text(encoding="utf-8").replace("\r\n", "\n")


COMPONENTS = _read("components.css")


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


def test_content_width_is_a_1200px_token_and_main_uses_it():
    tokens = _read("tokens.css")
    assert re.search(r"--content-w:\s*1200px;", tokens)
    assert "max-width: var(--content-w)" in _rule("main", _read("base.css"))


def test_home_fills_the_content_width_with_a_360px_aside():
    tokens = _read("tokens.css")
    assert re.search(r"--home-aside-w:\s*360px;", tokens)
    home = _rule("#home")
    assert "max-width: var(--content-w)" in home
    assert "grid-template-columns: minmax(0, 1fr) var(--home-aside-w)" in home


def test_home_folds_to_one_column_at_900px_in_the_phone_order():
    blocks = [b for b in _media_blocks(COMPONENTS, 900) if "#home {" in b]
    assert len(blocks) == 1, "one 900px block owns the home fold"
    block = blocks[0]
    assert re.search(r"#home \{ grid-template-columns: 1fr;", block)
    # The hero, its left column and both body columns dissolve so `order`
    # can interleave their cards.
    assert re.search(r"#home \.home-main, #home \.home-aside, #home \.home-hero, #home \.hero-main \{ display: contents; \}",
                     block)
    order = {sel: int(n) for sel, n in re.findall(r"(#[\w-]+(?: \.[\w-]+)?) \{ order: (\d+);", block)}
    # 추천 -> 목표 문장 -> the aside's cards -> 모드 -> 최근 테마.
    assert order["#today-card"] < order["#home-target"] < order["#review-home"]
    assert order["#home-target"] >= order["#today-alt"]
    assert order["#resume-card"] < order["#home .modes-wrap"] < order["#recent-themes-wrap"]
    assert order["#week-card"] < order["#home .modes-wrap"]
    # No home rule is left on the old 880px breakpoint.
    assert not any("#home" in b for b in _media_blocks(COMPONENTS, 880))


def test_the_hero_splits_only_with_a_target_and_goes_with_its_recommendation():
    assert "grid-template-columns: minmax(0, 1fr);" in _rule(".home-hero")
    assert "grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr)" in _rule(".home-hero.has-target")
    assert "display: none" in _rule(".home-hero:has(#today-card[hidden])")


def test_the_target_play_button_keeps_one_width():
    assert "min-width: calc(" in _rule(".target-actions .btn-stable")


def test_the_target_panel_dims_by_opacity_and_not_under_reduced_motion():
    assert "transition: opacity var(--dur-fast) ease" in _rule(":where(#home-target)")
    reduced = COMPONENTS[COMPONENTS.index("@media (prefers-reduced-motion: reduce) {\n  .screen-enter"):]
    assert re.search(r":where\(#home-target\) \{ transition: none; \}", reduced)


def test_a_tiles_recent_line_holds_its_height_empty_or_not():
    assert "min-height: calc(var(--text-xs) * 1.45)" in _rule(".mode .m")
    assert "white-space: nowrap" in _rule(".mode .m"), "a long title must not grow the tile a line"


def test_the_conversation_tiles_are_wide_two_plus_three():
    assert "repeat(6, minmax(0, 1fr))" in _rule(".modes")
    assert "grid-column: span 2" in _rule(".mode")
    assert "grid-column: span 3" in _rule(".mode.wide")


def test_recent_themes_are_three_a_row_on_a_wide_screen():
    assert "repeat(3, minmax(0, 1fr))" in _rule(".recent-themes")


def test_the_goal_ring_is_a_still_shape():
    for sel in (".ring", ".ring-fill", ".home-hero", ".mode"):
        body = _rule(sel)
        assert "transition" not in body and "animation" not in body and "transform" not in body, sel
    assert "visibility: hidden" in _rule(".ring-fill.is-empty"), "a zero arc with a round cap draws a dot"


def test_the_start_button_skeleton_is_the_hero_buttons_height():
    """The hero's start buttons are space-3 tall on each side; the skeleton
    that stands in for them must be too, or the row grows when they land."""
    assert "padding: var(--space-3)" in _rule(".today-actions button")
    assert "height: calc(1.55em + var(--space-3) * 2 + 2px)" in _rule(".today-skel-btn")
    assert "font-size: var(--text-lg)" in _rule(".today-actions")
