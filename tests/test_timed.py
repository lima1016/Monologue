from app import timed

SEG = lambda s, e, t: {"start": s, "end": e, "text": t}


def test_english_words_ignore_punctuation_only_tokens():
    assert timed.count_words("Well, I went there -- yesterday.", "en") == 5


def test_japanese_counts_characters_without_punctuation():
    assert timed.count_words("昨日、公園に行きました。", "ja") == 10


def test_sentences_split_on_end_marks_and_short_tails_join_the_previous():
    segs = [SEG(0, 3, "I went to the park yesterday."), SEG(3.2, 5, "It was fun. Yes."), SEG(5.5, 8, "Then I ate lunch with my friend.")]
    assert timed.split_sentences(segs, "en") == [
        "I went to the park yesterday.", "It was fun. Yes.", "Then I ate lunch with my friend."]


def test_a_short_first_piece_stays():
    assert timed.split_sentences([SEG(0, 1, "Okay. I like trains a lot.")], "en") == ["Okay.", "I like trains a lot."]


def test_japanese_splits_on_japanese_marks():
    segs = [SEG(0, 2, "昨日は雨でした。"), SEG(2, 4, "だから家で本を読みました。")]
    assert timed.split_sentences(segs, "ja") == ["昨日は雨でした。", "だから家で本を読みました。"]


def test_long_pauses_count_gaps_of_three_seconds_or_more():
    segs = [SEG(0, 2, "a"), SEG(5, 6, "b"), SEG(7, 8, "c"), SEG(11.5, 12, "d")]
    assert timed.long_pauses(segs) == 2


def test_round_stats_per_minute():
    segs = [SEG(0, 10, "I went to the park and played soccer with my friends.")]
    s = timed.round_stats(segs, "en", 30)
    assert s["words"] == 11 and s["wpm"] == 22 and s["long_pauses"] == 0 and len(s["sentences"]) == 1


def test_empty_recording():
    assert timed.round_stats([], "en", 5) == {"words": 0, "wpm": 0, "long_pauses": 0, "sentences": []}
