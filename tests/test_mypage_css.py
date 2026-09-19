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
    marker = ":where(#level-card, #review-section, #weak-section, #history-section) {"
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
