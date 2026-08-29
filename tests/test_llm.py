import json

import httpx
import pytest

from app import config, llm


def _transport(handler):
    return httpx.MockTransport(handler)


def test_chat_sends_model_and_messages_and_returns_content(monkeypatch):
    captured = {}

    def handler(request):
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"message": {"content": "Hi there!"}})

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    out = llm.chat([{"role": "user", "content": "hello"}])

    assert out == "Hi there!"
    assert captured["url"] == f"{config.OLLAMA_URL}/api/chat"
    assert captured["body"]["model"] == config.OLLAMA_MODEL
    assert captured["body"]["stream"] is False
    assert captured["body"]["messages"] == [{"role": "user", "content": "hello"}]


def test_chat_omits_format_when_no_schema_given(monkeypatch):
    captured = {}

    def handler(request):
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"message": {"content": "ok"}})

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    llm.chat([{"role": "user", "content": "x"}])
    assert "format" not in captured["body"]


def test_chat_json_passes_schema_and_parses_the_reply(monkeypatch):
    schema = {"type": "object", "properties": {"correction": {"type": "string"}}}
    captured = {}

    def handler(request):
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"message": {"content": '{"correction": "fix it"}'}})

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    out = llm.chat_json([{"role": "user", "content": "x"}], schema)

    assert out == {"correction": "fix it"}
    assert captured["body"]["format"] == schema


def test_chat_json_raises_on_unparseable_content(monkeypatch):
    def handler(request):
        return httpx.Response(200, json={"message": {"content": "not json at all"}})

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    with pytest.raises(llm.LLMError):
        llm.chat_json([{"role": "user", "content": "x"}], {"type": "object"})


def test_connection_failure_becomes_a_clear_llm_error(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    with pytest.raises(llm.LLMError) as exc:
        llm.chat([{"role": "user", "content": "x"}])
    assert "Ollama" in str(exc.value)


def test_http_error_status_becomes_llm_error(monkeypatch):
    def handler(request):
        return httpx.Response(500, text="boom")

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    with pytest.raises(llm.LLMError):
        llm.chat([{"role": "user", "content": "x"}])


def test_is_healthy_is_false_when_unreachable(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    assert llm.is_healthy() is False


def test_chat_raises_on_missing_message_key(monkeypatch):
    def handler(request):
        return httpx.Response(200, json={"notmessage": {"content": "oops"}})

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    with pytest.raises(llm.LLMError):
        llm.chat([{"role": "user", "content": "x"}])


def test_chat_raises_on_non_json_response(monkeypatch):
    def handler(request):
        return httpx.Response(200, text="<html>proxy error</html>")

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))
    with pytest.raises(llm.LLMError):
        llm.chat([{"role": "user", "content": "x"}])


def test_chat_sends_temperature(monkeypatch):
    captured = {}

    def handler(request):
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"message": {"content": "ok"}})

    monkeypatch.setattr(llm, "_transport_for_tests", _transport(handler))

    # Test default temperature
    llm.chat([{"role": "user", "content": "x"}])
    assert captured["body"]["options"]["temperature"] == 0.8

    # Test custom temperature
    llm.chat([{"role": "user", "content": "x"}], temperature=0.3)
    assert captured["body"]["options"]["temperature"] == 0.3


@pytest.mark.engine
def test_real_ollama_answers():
    if not llm.is_healthy():
        pytest.skip("Ollama not running")
    out = llm.chat([{"role": "user", "content": "Say the single word: ready"}])
    assert out.strip()
