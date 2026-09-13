"""app/stt.py -- 가짜 모델로 적재 상태와 받아쓰기 계약을 고정한다.
실제 모델은 tests/test_stt_quality.py(-m engine)가 본다."""
import pytest

from app import stt


class Segment:
    def __init__(self, text):
        self.text = text


class FakeModel:
    def __init__(self, segments):
        self.segments = segments
        self.calls = []

    def transcribe(self, audio, **kw):
        self.calls.append((audio.read(), kw))
        return iter([Segment(t) for t in self.segments]), object()


@pytest.fixture(autouse=True)
def reset():
    stt._reset_for_tests()
    yield
    stt._reset_for_tests()


def test_transcribe_joins_the_segments_and_strips():
    model = FakeModel([" I went there", " yesterday. "])
    stt.load(lambda: model)
    assert stt.status() == "ready"
    assert stt.transcribe(b"webm-bytes", "en") == "I went there yesterday."


def test_transcribe_pins_the_language_and_the_options_the_spike_measured():
    model = FakeModel(["こんにちは"])
    stt.load(lambda: model)
    stt.transcribe(b"x", "ja")
    audio, kw = model.calls[0]
    assert audio == b"x"
    assert kw == {"language": "ja", "vad_filter": True, "beam_size": 1,
                  "condition_on_previous_text": False}


def test_silence_is_an_empty_string_not_an_error():
    stt.load(lambda: FakeModel([]))
    assert stt.transcribe(b"x", "en") == ""


def test_not_ready_means_unavailable():
    with pytest.raises(stt.SttUnavailable):
        stt.transcribe(b"x", "en")


def test_a_model_that_cannot_load_leaves_the_feature_off():
    """CUDA가 없는 PC, DLL이 없는 설치, 내려받기 실패 -- 전부 여기로 온다.
    앱은 브라우저 인식으로 계속 돈다."""
    def boom():
        raise RuntimeError("no CUDA")
    stt.load(boom)
    assert stt.status() == "unavailable"
    with pytest.raises(stt.SttUnavailable):
        stt.transcribe(b"x", "en")


def test_start_loading_runs_in_the_background_and_only_once():
    model = FakeModel(["ok"])
    thread = stt.start_loading(lambda: model)
    thread.join(timeout=5)
    assert stt.status() == "ready"
    assert stt.start_loading(lambda: model) is None


def test_a_load_failure_is_logged_with_the_exception(caplog):
    """A broken CUDA/DLL install or a failed download must leave a trace --
    not silently disappear into 'unavailable'."""
    def boom():
        raise RuntimeError("no CUDA")
    with caplog.at_level("WARNING", logger="app.stt"):
        stt.load(boom)
    records = [r for r in caplog.records if r.name == "app.stt" and r.levelname == "WARNING"]
    assert len(records) == 1
    assert records[0].exc_info is not None
