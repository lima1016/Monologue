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

# ---------- 한글 발음 ----------
#
# 소리 나는 대로 적는다. 외래어 표기법(도쿄, 규슈)이 아니라 발음 연습용이다:
# - か행은 늘 거센소리(카), が행은 예사소리(가) -- 맑은소리/흐린소리가 한글에서도 갈린다
# - 장음(ー)은 앞 모음을 한 번 더 적는다(토오쿄오). 표기법처럼 지우면 장음을 모르고 넘어간다
# - 촉음(ッ)은 앞 글자의 ㅅ 받침, ん은 ㄴ 받침 -- 받침이라 토큰 끝에 와도(言っ -> 잇) 사라지지 않는다
# 입력은 UniDic의 pron(발음)이다. は/へ/を가 와/에/오로 이미 바뀌어 있다.

_LEADS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
_VOWELS = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"
_FINALS = "_ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"


def _syllable(lead, vowel):
    return chr(0xAC00 + (_LEADS.index(lead) * 21 + _VOWELS.index(vowel)) * 28)


def _with_final(syllable, final):
    code = ord(syllable) - 0xAC00
    if not 0 <= code < 11172 or code % 28:
        return syllable  # 한글 음절이 아니거나 이미 받침이 있다
    return chr(ord(syllable) + _FINALS.index(final))


def _vowel_of(syllable):
    code = ord(syllable) - 0xAC00
    return _VOWELS[(code // 28) % 21] if 0 <= code < 11172 else None


_GOJUON = {
    "ㅇ": "アイウエオ", "ㅋ": "カキクケコ", "ㄱ": "ガギグゲゴ", "ㅅ": "サシスセソ",
    "ㅈ": "ザジズゼゾ", "ㅌ": "タチツテト", "ㄷ": "ダヂヅデド", "ㄴ": "ナニヌネノ",
    "ㅎ": "ハヒフヘホ", "ㅂ": "バビブベボ", "ㅍ": "パピプペポ", "ㅁ": "マミムメモ",
    "ㄹ": "ラリルレロ",
}
_HANGUL_SINGLES = {kana: (lead, vowel)
                   for lead, row in _GOJUON.items()
                   for kana, vowel in zip(row, "ㅏㅣㅜㅔㅗ")}
_HANGUL_SINGLES.update({
    # u단은 한국어 '우'보다 입술을 덜 내민다. 스/즈/쓰는 '으'로 적는 편이 소리에 가깝다.
    "ス": ("ㅅ", "ㅡ"), "ズ": ("ㅈ", "ㅡ"), "ヅ": ("ㅈ", "ㅡ"), "ツ": ("ㅆ", "ㅡ"),
    "チ": ("ㅊ", "ㅣ"), "ヂ": ("ㅈ", "ㅣ"),
    "ヤ": ("ㅇ", "ㅑ"), "ユ": ("ㅇ", "ㅠ"), "ヨ": ("ㅇ", "ㅛ"),
    "ワ": ("ㅇ", "ㅘ"), "ヲ": ("ㅇ", "ㅗ"), "ヴ": ("ㅂ", "ㅜ"),
    "ァ": ("ㅇ", "ㅏ"), "ィ": ("ㅇ", "ㅣ"), "ゥ": ("ㅇ", "ㅜ"), "ェ": ("ㅇ", "ㅔ"), "ォ": ("ㅇ", "ㅗ"),
    "ヰ": ("ㅇ", "ㅣ"), "ヱ": ("ㅇ", "ㅔ"), "ヮ": ("ㅇ", "ㅘ"),
})
# 요음(キャ): 앞 글자의 초성 + 작은 ャュョ의 모음. ジャ/チャ는 자/차 -- ㅈ·ㅊ 뒤의
# ㅑ는 ㅏ와 소리가 같으니 쟈·챠로 적을 이유가 없다. シャ는 사와 달라서 샤로 둔다.
_YOON_VOWEL = {"ャ": "ㅑ", "ュ": "ㅠ", "ョ": "ㅛ"}
_YOON_PLAIN_VOWEL = {"ャ": "ㅏ", "ュ": "ㅜ", "ョ": "ㅗ"}
_YOON_LEAD = {"キ": "ㅋ", "ギ": "ㄱ", "シ": "ㅅ", "ジ": "ㅈ", "チ": "ㅊ", "ヂ": "ㅈ",
              "ニ": "ㄴ", "ヒ": "ㅎ", "ビ": "ㅂ", "ピ": "ㅍ", "ミ": "ㅁ", "リ": "ㄹ", "ヴ": "ㅂ"}
_YOON_PLAIN = {"ジ", "チ", "ヂ"}
# 외래어의 작은 모음(ファ, ティ, ウィ): 앞 글자의 초성 + 그 모음 한 음절.
_SMALL_VOWEL = {"ァ": "ㅏ", "ィ": "ㅣ", "ゥ": "ㅜ", "ェ": "ㅔ", "ォ": "ㅗ"}
_SMALL_LEAD = {"フ": "ㅍ", "ヴ": "ㅂ", "テ": "ㅌ", "デ": "ㄷ", "ト": "ㅌ", "ド": "ㄷ",
               "シ": "ㅅ", "ジ": "ㅈ", "チ": "ㅊ", "ツ": "ㅊ", "ク": "ㅋ", "グ": "ㄱ"}
_W_VOWEL = {"ァ": "ㅘ", "ィ": "ㅟ", "ェ": "ㅞ", "ォ": "ㅝ"}
# 작은 ヮ(クヮ, グヮ): 앞 글자의 초성 + ㅘ.
_SMALL_WA_LEAD = {"ク": "ㅋ", "グ": "ㄱ"}
# 장음으로 한 번 더 적을 모음. 이중모음은 끝소리만 남긴다(쿄오, 뉴우, 와아).
_LONG_VOWEL = {"ㅑ": "ㅏ", "ㅛ": "ㅗ", "ㅠ": "ㅜ", "ㅘ": "ㅏ", "ㅝ": "ㅓ", "ㅞ": "ㅔ", "ㅟ": "ㅣ"}


def to_hangul(pron):
    """카타카나(또는 히라가나) 발음을 소리 나는 대로 한글로. 변환할 것이 없으면 None."""
    if not pron:
        return None
    text = _to_katakana(pron)
    out = []
    i = 0
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if nxt in _YOON_VOWEL and ch in _YOON_LEAD:
            vowel = (_YOON_PLAIN_VOWEL if ch in _YOON_PLAIN else _YOON_VOWEL)[nxt]
            out.append(_syllable(_YOON_LEAD[ch], vowel))
            i += 2
            continue
        if nxt in _SMALL_VOWEL and (ch in _SMALL_LEAD or ch == "ウ"):
            if ch == "ウ":
                out.append(_syllable("ㅇ", _W_VOWEL.get(nxt, _SMALL_VOWEL[nxt])))
            else:
                out.append(_syllable(_SMALL_LEAD[ch], _SMALL_VOWEL[nxt]))
            i += 2
            continue
        if nxt == "ヮ" and ch in _SMALL_WA_LEAD:
            out.append(_syllable(_SMALL_WA_LEAD[ch], "ㅘ"))
            i += 2
            continue
        if ch == "ッ":
            # 받침을 붙일 한글 음절이 없으면(맨 앞, 숫자 뒤) 적을 소리도 없다.
            if out:
                out[-1] = _with_final(out[-1], "ㅅ")
        elif ch == "ン":
            joined = _with_final(out[-1], "ㄴ") if out else None
            if joined and joined != out[-1]:
                out[-1] = joined
            else:
                # 받침으로 붙일 음절이 없다(맨 앞, 숫자·부호 뒤, 이미 받침이 있음).
                # 사라지게 두지 않고 제 음절로 적는다.
                out.append("응")
        elif ch == "ー":
            vowel = _vowel_of(out[-1]) if out else None
            if vowel:
                out.append(_syllable("ㅇ", _LONG_VOWEL.get(vowel, vowel)))
        elif ch in _HANGUL_SINGLES:
            out.append(_syllable(*_HANGUL_SINGLES[ch]))
        else:
            out.append(ch)
        i += 1
    return "".join(out)



def _to_katakana(text):
    """히라가나를 카타카나로. 두 글자군은 코드포인트가 0x60 떨어져 있다."""
    return "".join(
        chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in text
    )


def _to_hiragana(text):
    return "".join(
        chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in text
    )


def _is_kana(ch):
    return "ぁ" <= ch <= "ゖ" or "ァ" <= ch <= "ヺ" or ch == "ー"


def _has_kanji(text):
    """CJK 통합 한자 범위에 속하는 문자가 하나라도 있는지.

    '가나가 아니다'와 '한자다'는 다르다 -- 숫자('100円'의 '100')는 가나가
    아니지만 한자도 아니다. 이 구분이 없으면 4번 규칙("한자가 없으면 루비를
    붙이지 않는다")이 숫자 섞인 표기의 루비까지 지워 버린다.
    """
    return any("一" <= c <= "鿿" for c in text)


def align(surface, reading_kana):
    """읽기를 표기 위에 앉힌다. 규칙은 설계 문서에 있다:

    1. 읽기를 히라가나로 맞춘다
    2. 표기와 읽기에서 앞뒤로 일치하는 가나를 벗겨낸다
    3. 남은 표기가 한자 한 덩어리면 그 위에 남은 읽기를 올린다
    4. 남은 표기에 한자가 없으면 루비를 붙이지 않는다
    5. 그 밖의 모든 경우 -- 한자 덩어리가 둘 이상이거나, 읽기가 표기와
       아귀가 안 맞거나 -- 토큰 전체 위에 읽기를 통째로 올린다

    5번이 이 함수의 안전망이다. 어떤 입력에도 '틀린 위치의 읽기'를 만들지
    않는다.

    4번은 표기 전체에 한자가 하나도 없으면 제일 먼저 적용된다 -- 읽기가
    표기와 글자 단위로 어긋나더라도(사전이 이상한 것을 줬거나) 순수 가나
    표기 위에 불완전한 읽기를 얹지 않기 위해서다.
    """
    if not reading_kana:
        return [{"text": surface, "ruby": None}]

    if not _has_kanji(surface):
        return [{"text": surface, "ruby": None}]

    kana_reading = _to_hiragana(reading_kana)
    kana_surface = _to_hiragana(surface)

    head = 0
    while (head < len(surface) and head < len(kana_reading)
           and _is_kana(surface[head]) and kana_surface[head] == kana_reading[head]):
        head += 1

    tail = 0
    while (tail < len(surface) - head and tail < len(kana_reading) - head
           and _is_kana(surface[-1 - tail])
           and kana_surface[-1 - tail] == kana_reading[-1 - tail]):
        tail += 1

    core = surface[head:len(surface) - tail]
    core_reading = kana_reading[head:len(kana_reading) - tail]

    # 남은 표기 안에 가나가 섞여 있으면 한자 덩어리가 둘 이상이라는 뜻이다.
    if not core or not core_reading or any(_is_kana(c) for c in core):
        return [{"text": surface, "ruby": kana_reading}]

    parts = []
    if head:
        parts.append({"text": surface[:head], "ruby": None})
    parts.append({"text": core, "ruby": core_reading})
    if tail:
        parts.append({"text": surface[len(surface) - tail:], "ruby": None})
    return parts


@functools.lru_cache(maxsize=1)
def _tagger():
    """Tagger는 사전을 통째로 메모리에 올리므로 한 번만 만든다.
    lru_cache가 프로세스당 1회를 보장한다."""
    from fugashi import Tagger
    return Tagger()


def analyse(text):
    """일본어 문장을 토큰 목록으로. 절대 raise하지 않는다."""
    if not text:
        return []
    try:
        words = list(_tagger()(text))
    except Exception:
        return [_plain(text)]

    tokens = []
    cursor = 0
    for word in words:
        # MeCab은 공백(ASCII 스페이스, 탭, 개행)을 표면형으로 돌려주지 않는다
        # -- 토큰 사이 어딘가에서 그냥 사라진다. 원문에서 이 토큰이 시작하는
        # 자리를 찾아, 직전 토큰이 끝난 자리부터 그 사이에 남는 것이 있으면
        # 평문 토큰으로 얹어 원문을 그대로 복원한다. find가 -1을 주는(사전이
        # 원문에 없는 표면형을 준) 경우는 통째로 건너뛴다 -- 이 함수는 절대
        # raise하지 않는다는 계약이 문서 찾기 실패보다 우선한다.
        start = text.find(word.surface, cursor)
        if start > cursor:
            tokens.append(_plain(text[cursor:start]))
        if start >= cursor:
            cursor = start + len(word.surface)
        try:
            kana = getattr(word.feature, "kana", None)
            if not kana or kana == "*":
                tokens.append(_plain(word.surface))
                continue
            hira = _to_hiragana(kana)
            # 표기(kana)와 발음(pron)이 갈리는 자리가 있다 -- は는 '와', へ는 '에',
            # を는 '오'로 읽는다. UniDic은 그 발음을 pron에 따로 준다. 그런데 pron은
            # 장음도 'ー'로 뭉갠다(学校 -> ガッコー, ありがとう -> アリガトー).
            # 그래서 규칙은 품사가 아니라 'ー'로 가른다: pron에 'ー'가 없으면
            # pron, 있으면 kana. 예전에는 조사일 때만 pron을 봤는데, 그러면 감동사
            # 하나로 굳은 こんにちは의 は가 konnichiha로 나왔다. 후리가나(ruby)는
            # 어느 쪽이든 항상 표기(kana)를 쓴다 -- 학습자가 읽는 글자 위에는 원래
            # 표기가 있어야 한다.
            pron = getattr(word.feature, "pron", None)
            usable_pron = pron and pron != "*" and "ー" not in pron
            romaji_source = pron if usable_pron else kana
            tokens.append({
                "surface": word.surface,
                "reading": hira,
                "romaji": to_romaji(romaji_source),
                # 한글은 늘 발음을 따른다. 장음을 모음 반복으로 적으므로 로마자처럼
                # 'ー'를 피해 kana로 돌아갈 이유가 없다.
                "hangul": to_hangul(pron if pron and pron != "*" else kana),
                "parts": align(word.surface, hira),
            })
        except Exception:
            # 토큰 하나가 실패해도 문장 전체가 비면 안 된다 -- 실패한
            # 토큰만 평문으로 떨어지고 나머지는 읽기를 유지한다.
            tokens.append(_plain(word.surface))
    if cursor < len(text):
        tokens.append(_plain(text[cursor:]))
    return tokens


def _plain(text):
    return {"surface": text, "reading": None, "romaji": None, "hangul": None,
            "parts": [{"text": text, "ruby": None}]}
