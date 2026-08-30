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
            # 조사(는/へ/를 등)는 표기(kana)와 발음(pron)이 갈리는 자리다 -- は는
            # '하'가 아니라 '와'로, へ는 '헤'가 아니라 '에'로 읽는다. UniDic은 이
            # 발음을 pron에 따로 준다. 조사에만 pron을 쓰는 이유는 pron이 장음을
            # 'ー'로 뭉개기 때문이다(学校 -> ガッコー): 조사가 아닌 토큰까지
            # pron으로 바꾸면 gakkou가 gakkoo가 된다. 후리가나(ruby)는 어느
            # 쪽이든 항상 표기(kana)를 그대로 쓴다 -- 학습자가 읽는 글자 위에는
            # 원래 표기가 있어야 한다.
            pos1 = getattr(word.feature, "pos1", None)
            pron = getattr(word.feature, "pron", None)
            romaji_source = pron if (pos1 == "助詞" and pron and pron != "*") else kana
            tokens.append({
                "surface": word.surface,
                "reading": hira,
                "romaji": to_romaji(romaji_source),
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
    return {"surface": text, "reading": None, "romaji": None,
            "parts": [{"text": text, "ruby": None}]}
