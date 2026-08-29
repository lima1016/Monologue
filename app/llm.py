"""Ollama chat client.

`_transport_for_tests` exists so tests can inject an httpx.MockTransport without
a live server. Production code leaves it None and httpx opens a real connection.
"""
import json

import httpx

from app import config

_TIMEOUT = httpx.Timeout(180.0, connect=5.0)
_transport_for_tests = None


class LLMError(Exception):
    """The model could not be reached or produced unusable output."""


def _client() -> httpx.Client:
    return httpx.Client(timeout=_TIMEOUT, transport=_transport_for_tests)


def is_healthy() -> bool:
    try:
        with httpx.Client(timeout=3.0, transport=_transport_for_tests) as client:
            return client.get(f"{config.OLLAMA_URL}/api/tags").status_code == 200
    except httpx.HTTPError:
        return False


def chat(messages: list[dict], schema: dict | None = None, temperature: float = 0.8) -> str:
    """Send a chat completion and return the assistant's raw text."""
    payload = {
        "model": config.OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "options": {"temperature": temperature},
    }
    if schema is not None:
        payload["format"] = schema

    try:
        with _client() as client:
            response = client.post(f"{config.OLLAMA_URL}/api/chat", json=payload)
            response.raise_for_status()
            return response.json()["message"]["content"]
    except httpx.HTTPStatusError as exc:
        raise LLMError(f"Ollama returned {exc.response.status_code}") from exc
    except httpx.HTTPError as exc:
        raise LLMError(
            f"Could not reach Ollama at {config.OLLAMA_URL}. Is it running? ({exc})"
        ) from exc
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise LLMError(
            f"Ollama returned an unexpected response shape: {exc}"
        ) from exc


def chat_json(messages: list[dict], schema: dict, temperature: float = 0.3) -> dict:
    """Chat with a forced JSON schema and return the parsed object."""
    raw = chat(messages, schema=schema, temperature=temperature)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise LLMError(f"model did not return valid JSON: {raw[:200]}") from exc
