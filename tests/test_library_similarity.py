"""The similarity check on conversation-length scripts, in both languages.

difflib's autojunk heuristic treats any character appearing in more than 1% of
a 200+ character string as junk -- in a 16-line script that is every common
letter and kana -- and the ratio collapses: a copy with 4 of 16 lines reworded
measured 0.293 with autojunk on and 0.909 with it off (review, 2026-09-14).
Short synthetic lines in test_library.py cannot show that, these can.

Measured on these fixtures (autojunk on -> off): en 4-reworded 0.280 -> 0.908,
en different-same-situation 0.014 -> 0.256; ja 4-reworded 0.915 -> 0.922, ja
different 0.075 -> 0.269. Japanese happened to survive autojunk (kana spread
too thinly for the 1% rule), English did not.
"""
import difflib

from app import library


def _script(texts):
    return [{"speaker": "bot" if i % 2 == 0 else "user", "text": t} for i, t in enumerate(texts)]


EN_CAFE = [
    "Hi there, welcome to Bean Street. What can I get started for you today?",
    "Hi, could I get a medium latte, please?",
    "Sure thing. Would you like whole milk, or would you prefer oat or almond?",
    "Oat milk, please. Is there an extra charge for that?",
    "Yes, it's fifty cents extra. Anything else to go with your latte?",
    "Do you have any pastries that aren't too sweet?",
    "Our cheese scone is pretty popular, and the plain croissant is fresh this morning.",
    "I'll take the cheese scone, then.",
    "Great choice. Is that for here or to go?",
    "For here, please. I'm going to work for a bit.",
    "No problem. The Wi-Fi password is on the receipt. That'll be seven twenty-five.",
    "Can I pay by card?",
    "Of course, just tap your card on the reader whenever you're ready.",
    "Okay, done. Where should I wait for my drink?",
    "Just by the end of the counter. We'll call your name when it's ready.",
    "Thanks so much, I appreciate it.",
]
EN_CAFE_REWORDED = list(EN_CAFE)
EN_CAFE_REWORDED[3] = "Oat, please. Does that cost more?"
EN_CAFE_REWORDED[7] = "The scone sounds good, I'll have that."
EN_CAFE_REWORDED[11] = "Do you take credit cards?"
EN_CAFE_REWORDED[0] = "Hello, welcome to Bean Street! What would you like today?"

EN_CAFE_OTHER = [
    "Good afternoon! Are you ready to order, or do you need a minute with the menu?",
    "I think I'm ready. What would you recommend if I don't like coffee much?",
    "Our hibiscus iced tea is really refreshing, and the hot chocolate is rich.",
    "It's pretty warm out, so the iced tea sounds nice.",
    "Would you like it sweetened, or should I leave the syrup out?",
    "Just a little syrup, not the full amount.",
    "Got it, half sweet. What size would you like, small or large?",
    "A large, please. And do you have anything with no gluten?",
    "We have a flourless chocolate brownie and some fruit cups in the fridge.",
    "A fruit cup would be perfect.",
    "Okay. Your name for the order? It gets a bit busy around lunch.",
    "It's Dana, spelled D-A-N-A.",
    "Thanks, Dana. Your total comes to six fifty. Cash or card?",
    "I have exact change here, actually.",
    "Perfect. Your tea will be out in about three minutes at the pickup window.",
    "Sounds good, I'll wait over there.",
]

JA_CAFE = [
    "いらっしゃいませ。ご注文はお決まりですか？",
    "はい、ホットのカフェラテをひとつお願いします。",
    "サイズはショート、トール、グランデがございますが、どちらになさいますか？",
    "トールでお願いします。",
    "ミルクは普通の牛乳でよろしいですか？豆乳にも変更できます。",
    "豆乳にしてください。追加料金はかかりますか？",
    "はい、豆乳は五十円追加になります。",
    "大丈夫です。あと、甘くないパンはありますか？",
    "チーズのスコーンが人気で、クロワッサンも今朝焼きたてです。",
    "じゃあ、チーズのスコーンをください。",
    "店内でお召し上がりですか、それともお持ち帰りですか？",
    "店内でお願いします。",
    "かしこまりました。お会計は七百八十円になります。",
    "カードで払えますか？",
    "はい、こちらの端末にカードをかざしてください。",
    "ありがとうございます。",
]
JA_CAFE_REWORDED = list(JA_CAFE)
JA_CAFE_REWORDED[3] = "トールサイズにします。"
JA_CAFE_REWORDED[7] = "はい。それと、甘さ控えめのパンはありますか？"
JA_CAFE_REWORDED[11] = "ここで食べます。"
JA_CAFE_REWORDED[0] = "いらっしゃいませ。何になさいますか？"

JA_CAFE_OTHER = [
    "こんにちは。メニューをご覧になって、お決まりになったらお呼びください。",
    "すみません、コーヒーが苦手なんですが、おすすめはありますか？",
    "それでしたら、季節限定の桃のアイスティーがさっぱりしていておすすめです。",
    "今日は暑いので、それにします。",
    "シロップの量はいかがなさいますか？少なめにもできますよ。",
    "半分くらいでお願いします。",
    "承知しました。お食事はよろしいですか？",
    "小麦を使っていないお菓子はありますか？",
    "米粉のマフィンと、冷蔵ケースにフルーツカップがございます。",
    "フルーツカップを一つお願いします。",
    "お名前をお伺いしてもよろしいですか？お昼は混み合いますので。",
    "田中です。",
    "田中様ですね。合計で六百五十円です。お支払いは現金ですか？",
    "ちょうど持っています。はい、どうぞ。",
    "ありがとうございます。三分ほどで受け取り口にお出しします。",
    "わかりました、あちらで待っています。",
]


def _ratio(a, b):
    return difflib.SequenceMatcher(None, library._joined(_script(a)), library._joined(_script(b)),
                                   autojunk=False).ratio()


def test_the_fixtures_are_themselves_valid_scripts():
    for texts, language in ((EN_CAFE, "en"), (EN_CAFE_REWORDED, "en"), (EN_CAFE_OTHER, "en"),
                            (JA_CAFE, "ja"), (JA_CAFE_REWORDED, "ja"), (JA_CAFE_OTHER, "ja")):
        assert library.check_script(_script(texts), language) is None, texts[0]


def test_english_twelve_of_sixteen_lines_kept_is_too_similar():
    assert library.check_script(_script(EN_CAFE_REWORDED), "en", [_script(EN_CAFE)]) == "too-similar"


def test_japanese_twelve_of_sixteen_lines_kept_is_too_similar():
    assert library.check_script(_script(JA_CAFE_REWORDED), "ja", [_script(JA_CAFE)]) == "too-similar"


def test_english_a_different_script_in_the_same_situation_passes():
    assert library.check_script(_script(EN_CAFE_OTHER), "en", [_script(EN_CAFE)]) is None
    assert _ratio(EN_CAFE_OTHER, EN_CAFE) < 0.7


def test_japanese_a_different_script_in_the_same_situation_passes():
    assert library.check_script(_script(JA_CAFE_OTHER), "ja", [_script(JA_CAFE)]) is None
    assert _ratio(JA_CAFE_OTHER, JA_CAFE) < 0.7
