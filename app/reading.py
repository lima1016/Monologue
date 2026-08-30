"""일본어 읽기 보조. 후리가나 정렬과 로마자 변환을 아는 유일한 모듈.

이 모듈의 어떤 함수도 예외를 밖으로 내보내지 않는다. 사전이 없거나 분석이
실패하면 원문을 그대로 담은 평문 토큰을 돌려준다 -- 학습자가 읽어야 할 줄이
비는 것이, 보조가 없는 것보다 나쁘다. app/api.py:148의 _speak가 TTS 장애에
대해 갖는 계약과 같다.
"""
import functools

# 헵번식. 훈령식(si/ti/tu)이 아니라 이쪽인 이유는 교재와 도로 표지판이
# 헵번식이어서, 앱 안에서 배운 표기가 앱 밖에서 그대로 통해야 하기 때문이다.
_DIGRAPHS = {
    "キャ": "kya", "キュ": "kyu", "キョ": "kyo",
    "ギャ": "gya", "ギュ": "gyu", "ギョ": "gyo",
    "シャ": "sha", "シュ": "shu", "ショ": "sho",
    "ジャ": "ja", "ジュ": "ju", "ジョ": "jo",
    "チャ": "cha", "チュ": "chu", "チョ": "cho",
    "ニャ": "nya", "ニュ": "nyu", "ニョ": "nyo",
    "ヒャ": "hya", "ヒュ": "hyu", "ヒョ": "hyo",
    "ビャ": "bya", "ビュ": "byu", "ビョ": "byo",
    "ピャ": "pya", "ピュ": "pyu", "ピョ": "pyo",
    "ミャ": "mya", "ミュ": "myu", "ミョ": "myo",
    "リャ": "rya", "リュ": "ryu", "リョ": "ryo",
}

_SINGLES = {
    "ア": "a", "イ": "i", "ウ": "u", "エ": "e", "オ": "o",
    "カ": "ka", "キ": "ki", "ク": "ku", "ケ": "ke", "コ": "ko",
    "ガ": "ga", "ギ": "gi", "グ": "gu", "ゲ": "ge", "ゴ": "go",
    "サ": "sa", "シ": "shi", "ス": "su", "セ": "se", "ソ": "so",
    "ザ": "za", "ジ": "ji", "ズ": "zu", "ゼ": "ze", "ゾ": "zo",
    "タ": "ta", "チ": "chi", "ツ": "tsu", "テ": "te", "ト": "to",
    "ダ": "da", "ヂ": "ji", "ヅ": "zu", "デ": "de", "ド": "do",
    "ナ": "na", "ニ": "ni", "ヌ": "nu", "ネ": "ne", "ノ": "no",
    "ハ": "ha", "ヒ": "hi", "フ": "fu", "ヘ": "he", "ホ": "ho",
    "バ": "ba", "ビ": "bi", "ブ": "bu", "ベ": "be", "ボ": "bo",
    "パ": "pa", "ピ": "pi", "プ": "pu", "ペ": "pe", "ポ": "po",
    "マ": "ma", "ミ": "mi", "ム": "mu", "メ": "me", "モ": "mo",
    "ヤ": "ya", "ユ": "yu", "ヨ": "yo",
    "ラ": "ra", "リ": "ri", "ル": "ru", "レ": "re", "ロ": "ro",
    "ワ": "wa", "ヲ": "o", "ン": "n",
    "ァ": "a", "ィ": "i", "ゥ": "u", "ェ": "e", "ォ": "o",
    "ヴ": "vu",
}


def to_romaji(kana):
    """카타카나 읽기를 헵번식 로마자로. 변환할 것이 없으면 None."""
    if not kana:
        return None
    out = []
    i = 0
    text = _to_katakana(kana)
    while i < len(text):
        pair = text[i:i + 2]
        if pair in _DIGRAPHS:
            out.append(_DIGRAPHS[pair])
            i += 2
            continue
        ch = text[i]
        if ch == "ッ":
            # 촉음: 다음 음의 첫 자음을 겹친다. 뒤에 아무것도 없으면 버린다.
            nxt = _romaji_of_next(text, i + 1)
            if nxt:
                out.append(nxt[0])
            i += 1
            continue
        if ch == "ー":
            # 장음: 앞 모음을 반복한다. 매크론(ō) 대신 이렇게 하는 이유는
            # 초보에게 가나 한 글자와 로마자의 대응이 눈에 보여야 하기 때문이다.
            if out and out[-1] and out[-1][-1] in "aiueo":
                out.append(out[-1][-1])
            i += 1
            continue
        out.append(_SINGLES.get(ch, ch))
        i += 1
    return "".join(out)


def _romaji_of_next(text, i):
    if i >= len(text):
        return None
    pair = text[i:i + 2]
    if pair in _DIGRAPHS:
        return _DIGRAPHS[pair]
    return _SINGLES.get(text[i])


def _to_katakana(text):
    """히라가나를 카타카나로. 두 글자군은 코드포인트가 0x60 떨어져 있다."""
    return "".join(
        chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in text
    )


def _to_hiragana(text):
    return "".join(
        chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in text
    )
