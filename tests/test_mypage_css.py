"""My page's stylesheet rules. No suite renders CSS, so the stability rules the
screen is built to (docs/superpowers/specs/2026-09-14-monologue-ui-stability-design.md)
are pinned by reading components.css."""
import re
from pathlib import Path

from tests.test_ui_stability_css import _all_css, _reduced_motion_blocks, _rule_body

ROOT = Path(__file__).resolve().parent.parent


def test_the_mypage_header_wraps_like_the_pick_header():
    assert "flex-wrap: wrap" in _rule_body(_all_css(), ".mypage-head {")


def test_the_screen_itself_never_transforms():
    """R1: a transform on the screen would break fixed/sticky descendants."""
    css = _all_css()
    for m in re.finditer(r"([^{}]*#mypage[^{}]*)\{([^}]*)\}", css):
        assert "transform" not in m.group(2), m.group(1)


def test_folds_open_by_grid_rows_like_the_chip_detail():
    """R8: the explanation, a history row's actions and a transcript."""
    css = _all_css()
    fold = _rule_body(css, ".fold {")
    assert "display: grid" in fold and "grid-template-rows: 1fr" in fold
    assert "transition: grid-template-rows var(--dur-fast)" in fold
    assert "grid-template-rows: 0fr" in _rule_body(css, ".fold.is-collapsed {")
    inner = _rule_body(css, ".fold-inner {")
    assert "overflow: hidden" in inner and "min-height: 0" in inner
    assert "visibility: hidden" in _rule_body(css, ".fold.is-collapsed > .fold-inner {")
    block = "\n".join(_reduced_motion_blocks(css))
    assert re.search(r"\.fold, \.fold-inner\s*\{[^}]*transition: none", block)


def test_the_review_buttons_whose_words_change_keep_a_width():
    """R7: ▶ 듣기 -> 음성 준비 중..., 🎤 말해보기 -> 🎤 그만 말하기."""
    body = _rule_body(_all_css(), ".review-card .btn-stable {")
    assert "min-width: calc(" in body


def test_the_more_button_carries_a_stable_width():
    html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
    m = re.search(r'<button id="btn-history-more"[^>]*>', html)
    assert m and "btn-stable" in m.group(0)


def test_the_result_line_holds_one_line_while_empty():
    assert "min-height:" in _rule_body(_all_css(), ".review-result {")


def test_the_loading_words_sit_over_the_skeleton_instead_of_adding_a_row():
    css = _all_css()
    assert "position: absolute" in _rule_body(css, ".mypage-loading {")
    for section in ("#level-body", "#review-list", "#tag-bars", "#history-list"):
        assert re.search(re.escape(section) + r"[^{]*\{[^}]*position: relative", css), section


def test_the_sections_ease_back_from_a_dim():
    css = _all_css()
    marker = ":where(#level-card, #growth-card, #review-section, #weak-section, #history-section) {"
    assert "transition: opacity var(--dur-fast) ease" in _rule_body(css, marker)


def test_a_tag_bar_is_name_track_count():
    css = _all_css()
    assert "display: grid" in _rule_body(css, ".tag-bar {")
    assert "background: var(--accent)" in _rule_body(css, ".tag-bar .fill {")


def test_history_rows_do_not_animate_in():
    """Bulk-rendered lists appear at once: no row eases in on its own."""
    css = _all_css()
    for m in re.finditer(r"([^{}]*(?:\.history-row|\.transcript)[^{}]*)\{([^}]*)\}", css):
        assert "animation" not in m.group(2), m.group(1)


def test_the_panel_label_rule_reaches_only_direct_children():
    """An id-scoped `#mypage .panel .label` outranked `.review-card .label`, so a
    card's 내가 한 말 turned into a block with no gap before the sentence."""
    css = _all_css()
    assert "margin: 0 0 var(--space-2)" in _rule_body(css, "#mypage .panel > .label {")
    assert "#mypage .panel .label" not in css
    inline = _rule_body(css, ".review-card .label {")
    assert "display: inline" in inline and "var(--space-2)" in inline


def test_the_level_line_resets_margin_at_zero_specificity():
    """`#level-body > p { margin: 0 }` once outranked the level's own classes;
    the level is one line now (.level-line), and the reset stays :where'd."""
    css = _all_css()
    assert "#level-body > p" not in css
    assert "margin: 0" in _rule_body(css, ":where(#level-body) > p {")
    assert "font-size: var(--text-sm)" in _rule_body(css, ".level-line {")
    assert ".level-note" not in css and ".level-value" not in css


def test_the_accuracy_line_keeps_its_gap_below():
    """`#mypage .hint { margin: 0 }` (id + class) outranked `#accuracy-line`'s
    margin, so the line sat flush on the first tag bar."""
    css = _all_css()
    assert "#mypage .hint {" not in css
    assert "margin: 0" in _rule_body(css, "#mypage :where(.hint) {")
    assert "margin: 0 0 var(--space-2)" in _rule_body(css, "#accuracy-line {")
    # Same specificity now, so the later rule has to be #accuracy-line's.
    assert css.index("#mypage :where(.hint) {") < css.index("#accuracy-line {")


def test_tab_panels_share_one_height_and_fade_without_transform():
    css = _all_css()
    assert re.search(r"\.mypage-panels\s*\{[^}]*min-height", css)
    block = re.search(r"@keyframes tab-in\s*\{(.*?)\}\s*\}", css, re.S).group(1)
    assert "opacity" in block and "transform" not in block


def test_tab_count_reserves_its_width():
    assert re.search(r"\.tab-n\s*\{[^}]*min-width", _all_css())


def test_the_learners_words_are_never_struck_through_on_my_page():
    """내 말 on a tag's sentences and in the coach is not a mistake to cross out."""
    css = _all_css()
    for sel in (r"\.tag-ex-mine[^{]*", r"\.tag-ex-text[^{]*"):
        for block in re.findall(sel + r"\{([^}]*)\}", css):
            assert "line-through" not in block


def test_the_coach_body_keeps_its_height_while_loading():
    """The 10-20 s wait holds the answer's room (two items), so it does not jump."""
    assert re.search(r"#coach-body\s*\{[^}]*min-height", _all_css())


def _growth_rules():
    """Every rule of the 성장 card and its fold (growth.js) -- selector and body -- read
    with Windows line endings folded away and comments dropped."""
    css = re.sub(r"/\*.*?\*/", "", _all_css().replace("\r\n", "\n"), flags=re.S)
    return [(m.group(1).strip(), m.group(2)) for m in re.finditer(r"([^{}]*)\{([^{}]*)\}", css)
            if re.search(r"growth|cal-cell|heat-", m.group(1))]


def test_the_growth_tab_never_transforms():
    """R1: opacity only -- the tooltip shows by opacity and is placed by
    left/right/bottom, not moved by a transform."""
    rules = _growth_rules()
    assert len(rules) > 20
    for selector, body in rules:
        assert not re.search(r"transform:(?!\s*none\s*;)", body), selector
    tip = dict(rules)[".growth-tip.is-shown"]
    assert "opacity: 1" in tip


def test_growth_empty_state_keeps_a_modest_floor():
    """A brand-new learner sees .growth-empty on every one of the four
    blocks instead of a chart -- without a floor, four one-line hints in a
    row read as the tab collapsing. Token-built (calc from --text-sm), not a
    literal pixel value, and still well short of a loaded chart's own height
    (growth.js's ACC_H/SMALL_H), which is the point: modest, not a stand-in
    for the chart itself."""
    body = dict(_growth_rules())[".growth-empty"]
    assert "min-height: calc(" in body
    assert "var(--text-sm)" in body


def test_the_calendar_is_one_hue_mixed_from_theme_tokens():
    """Sequential, one hue: nothing is the sunken surface, then four steps of
    --accent mixed into --surface, rising -- so it follows every theme and
    dark mode. The cells and the key read the same four steps."""
    rules = dict(_growth_rules())
    heat = rules["#growth-card"]
    steps = re.findall(r"--heat-(\d): color-mix\(in oklab, var\(--accent\) (\d+)%, var\(--surface\)\);", heat)
    assert [s for s, _ in steps] == ["1", "2", "3", "4"]
    percents = [int(p) for _, p in steps]
    assert percents == sorted(percents) and len(set(percents)) == 4 and percents[-1] == 100
    assert "var(--surface-sunken)" in rules[".cal-cell.lv0"]
    for n in range(1, 5):
        assert f"var(--heat-{n})" in rules[f".cal-cell.lv{n}"]
        assert f"var(--heat-{n})" in rules[f".heat-swatch.lv{n}"]


def test_the_growth_tab_names_no_colour_of_its_own():
    """Tokens only: a hex, rgb() or named colour here would not follow the theme."""
    for selector, body in _growth_rules():
        assert not re.search(r"#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|(?<![\w-])(white|black)(?![\w-])", body), selector


def test_growth_marks_wear_the_accent_and_its_text_wears_text_tokens():
    rules = dict(_growth_rules())
    assert "stroke: var(--accent)" in rules[".growth-chart .series-line"]
    assert "stroke-width: 2" in rules[".growth-chart .series-line"]
    dot = rules[".growth-chart .series-dot"]
    assert "fill: var(--accent)" in dot and "stroke: var(--surface)" in dot and "stroke-width: 2" in dot
    assert "stroke: var(--line)" in rules[".growth-chart .grid"]
    for sel in (".growth-chart .axis", ".growth-chart .end-label"):
        assert re.search(r"fill: var\(--text(-faint|-dim)?\)", rules[sel]), sel
        assert "accent" not in rules[sel], sel


def test_the_summary_card_keeps_a_modest_floor_with_nothing_to_show():
    """No practice at all: one guidance line, and the card holds a floor built
    from tokens rather than shrinking to that line."""
    body = dict(_growth_rules())[".growth-guide"]
    assert re.search(r"min-height: calc\([^;]*var\(--text-sm\)", body)


def test_the_details_toggle_holds_one_width_for_both_labels():
    """자세히 보기 ▾ and 접기 ▴ are different lengths; the button keeps one width."""
    assert "min-width: calc(" in dict(_growth_rules())[".growth-more"]


def test_the_summary_card_dims_and_eases_like_the_other_sections():
    css = re.sub(r"/\*.*?\*/", "", _all_css().replace("\r\n", "\n"), flags=re.S)
    lists = re.findall(r":where\(([^)]*)\)\s*\{\s*transition", css)
    assert any("#growth-card" in l and "#level-card" in l for l in lists)
    reduced = re.search(r"prefers-reduced-motion: reduce\)\s*\{[^@]*:where\(([^)]*#level-card[^)]*)\)\s*\{\s*transition: none", css)
    assert reduced and "#growth-card" in reduced.group(1)


def test_the_details_fold_keeps_its_room_as_a_margin_not_padding():
    """Padding on a fold's inner box would survive the 0fr row and leave a
    sliver showing while shut; the space above the first block is a margin."""
    rules = dict(_growth_rules())
    assert "padding" not in rules["#growth-details-body"]
    assert "margin-top" in rules["#growth-details-body > :first-child"]
