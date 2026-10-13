"""
tests/test_api.py - Pytest integration tests for the Resilient AI Chatbot API.

All tests use LiteLLM mock_response so NO real API keys are required.
The tests set environment variables before importing the app so the config
picks them up correctly.

Run with:
    cd backend
    venv\\Scripts\\pytest tests/ -v
"""

from __future__ import annotations

import asyncio
import os
import time

# ---------------------------------------------------------------------------
# Inject fake keys & mock response BEFORE importing anything from our app so
# config.py reads them when it loads.
# ---------------------------------------------------------------------------
os.environ.setdefault("GEMINI_API_KEY_1", "test-key-1")
os.environ.setdefault("GEMINI_API_KEY_2", "test-key-2")
os.environ.setdefault("GEMINI_API_KEY_3", "test-key-3")
os.environ.setdefault("MODEL_NAME", "openai/gpt-3.5-turbo")
os.environ.setdefault("CACHE_TTL_SECONDS", "3600")
os.environ.setdefault("MOCK_RESPONSE", "Test reply from mock LLM.")

import pytest
from fastapi.testclient import TestClient

import litellm
from litellm.caching.caching import Cache


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def reset_state():
    """
    Reset all mutable module-level state between tests so tests are isolated.
    """
    import llm_client
    from session_store import session_store

    # Reset cache
    litellm.cache = Cache(type="local", ttl=3600)

    # Reset simulated-down set
    llm_client._simulated_down.clear()
    llm_client._key_usage_counts.clear()

    # Reset session store
    session_store._sessions.clear()

    # Rebuild router in clean state
    llm_client.init()

    yield

    llm_client._simulated_down.clear()
    session_store._sessions.clear()
    llm_client.init()


@pytest.fixture()
def client():
    """Return a FastAPI test client with a clean app state."""
    from main import app
    import llm_client

    with TestClient(app, raise_server_exceptions=True) as c:
        llm_client.init()
        yield c


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestHealthEndpoint:
    def test_health_returns_ok(self, client: TestClient):
        r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["keys_loaded"] == 3
        assert body["cache_enabled"] is True


class TestChatEndpoint:
    def test_basic_reply(self, client: TestClient):
        """A well-formed request should return a non-null reply."""
        r = client.post(
            "/chat",
            json={"session_id": "sess-basic", "message": "Hello, world!"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["error"] is None
        assert body["reply"] is not None
        assert len(body["reply"]) > 0

    def test_reply_metadata_present(self, client: TestClient):
        """Reply must include the full metadata block."""
        r = client.post(
            "/chat",
            json={"session_id": "sess-meta", "message": "What is 2+2?"},
        )
        assert r.status_code == 200
        body = r.json()
        meta = body.get("metadata")
        assert meta is not None
        assert meta["resolution_source"] in ("LIVE_INFERENCE", "LLM_CACHE")
        assert "latency_ms" in meta
        assert "token_usage" in meta
        assert "input_tokens" in meta["token_usage"]
        assert "output_tokens" in meta["token_usage"]
        assert meta["key_index_used"] in (1, 2, 3)

    def test_empty_message_rejected(self, client: TestClient):
        r = client.post("/chat", json={"session_id": "sess-empty", "message": ""})
        assert r.status_code == 422  # Pydantic validation error

    def test_blank_message_rejected(self, client: TestClient):
        r = client.post("/chat", json={"session_id": "sess-blank", "message": "   "})
        assert r.status_code == 422

    def test_message_too_long_rejected(self, client: TestClient):
        r = client.post(
            "/chat",
            json={"session_id": "sess-toolong", "message": "x" * 10_001},
        )
        assert r.status_code == 422

    def test_with_system_prompt(self, client: TestClient):
        """System prompt should be accepted without errors."""
        r = client.post(
            "/chat",
            json={
                "session_id": "sess-sys",
                "message": "Hello",
                "system_prompt": "You are a helpful assistant.",
            },
        )
        assert r.status_code == 200
        assert r.json()["error"] is None


class TestMultiTurnConversation:
    def test_multi_turn_context_maintained(self, client: TestClient):
        """
        Sending multiple messages in the same session should accumulate history.
        We verify that /history returns the expected messages.
        """
        sid = "sess-multi"
        client.post("/chat", json={"session_id": sid, "message": "My name is Ravi."})
        client.post("/chat", json={"session_id": sid, "message": "What is my name?"})

        r = client.get(f"/history/{sid}")
        assert r.status_code == 200
        msgs = r.json()["messages"]
        assert len(msgs) == 4  # user, assistant, user, assistant
        assert msgs[0]["role"] == "user"
        assert msgs[0]["content"] == "My name is Ravi."
        assert msgs[1]["role"] == "assistant"
        assert msgs[2]["role"] == "user"
        assert msgs[2]["content"] == "What is my name?"
        assert msgs[3]["role"] == "assistant"


class TestSessionManagement:
    def test_history_empty_for_new_session(self, client: TestClient):
        r = client.get("/history/nonexistent-session")
        assert r.status_code == 200
        assert r.json()["messages"] == []

    def test_delete_session(self, client: TestClient):
        sid = "sess-del"
        client.post("/chat", json={"session_id": sid, "message": "Hello"})
        r = client.delete(f"/session/{sid}")
        assert r.status_code == 200
        assert r.json()["cleared"] is True

        # History should now be empty
        r2 = client.get(f"/history/{sid}")
        assert r2.json()["messages"] == []


class TestCachingBehaviour:
    def test_second_identical_message_is_cache_hit(self, client: TestClient):
        """
        Two requests with identical messages (different sessions, so no
        multi-turn context difference) should produce a cache hit on the second.
        """
        msg = "What is the capital of France?"
        # First call — live inference
        r1 = client.post("/chat", json={"session_id": "cache-sess-1", "message": msg})
        assert r1.status_code == 200
        meta1 = r1.json()["metadata"]
        assert meta1["resolution_source"] == "LIVE_INFERENCE"

        # Give async background cache-write 200ms to commit
        time.sleep(0.2)

        # Second call with same message in a fresh session — should hit cache
        r2 = client.post("/chat", json={"session_id": "cache-sess-2", "message": msg})
        assert r2.status_code == 200
        meta2 = r2.json()["metadata"]
        assert meta2["resolution_source"] == "LLM_CACHE"

    def test_cache_hit_has_lower_latency(self, client: TestClient):
        """Cache hits should be faster than live inference."""
        msg = "What is 7 times 8?"
        r1 = client.post("/chat", json={"session_id": "lat-1", "message": msg})
        time.sleep(0.2)
        r2 = client.post("/chat", json={"session_id": "lat-2", "message": msg})
        lat1 = r1.json()["metadata"]["latency_ms"]
        lat2 = r2.json()["metadata"]["latency_ms"]
        assert lat2 <= lat1, f"Cache hit latency ({lat2}ms) should be <= live ({lat1}ms)"


class TestDebugEndpoints:
    def test_debug_status_default(self, client: TestClient):
        r = client.get("/debug/status")
        assert r.status_code == 200
        body = r.json()
        assert body["simulated_down"] == []
        assert len(body["key_states"]) == 3

    def test_debug_fail_key_on(self, client: TestClient):
        r = client.post("/debug/fail-key/1/on")
        assert r.status_code == 200
        assert 1 in r.json()["all_simulated_down"]

    def test_debug_fail_key_off(self, client: TestClient):
        client.post("/debug/fail-key/1/on")
        r = client.post("/debug/fail-key/1/off")
        assert r.status_code == 200
        assert 1 not in r.json()["all_simulated_down"]

    def test_debug_invalid_index(self, client: TestClient):
        r = client.post("/debug/fail-key/99/on")
        assert r.status_code == 400

    def test_debug_invalid_state(self, client: TestClient):
        r = client.post("/debug/fail-key/1/maybe")
        assert r.status_code == 400


class TestKeyFailoverSimulation:
    def test_chat_succeeds_when_key1_down(self, client: TestClient):
        """
        With key-1 simulated down, the router should fall over to key-2
        and the user should still get a valid reply (no error).
        """
        # Mark key 1 as down
        r_down = client.post("/debug/fail-key/1/on")
        assert r_down.status_code == 200

        r = client.post("/chat", json={"session_id": "fo-sess", "message": "Test failover"})
        assert r.status_code == 200
        body = r.json()
        assert body["error"] is None
        assert body["reply"] is not None
        assert body["metadata"]["key_index_used"] == 2

    def test_all_keys_down_returns_friendly_error(self, client: TestClient):
        """
        When all keys fail, the API should return HTTP 200 with error != null,
        never a 500 or unhandled exception.
        """
        client.post("/debug/fail-key/1/on")
        client.post("/debug/fail-key/2/on")
        client.post("/debug/fail-key/3/on")

        # Clear cache so no cache hit can rescue us
        litellm.cache = Cache(type="local")

        r = client.post("/chat", json={"session_id": "all-down", "message": "Will this work?"})
        assert r.status_code == 200  # NEVER 500
        body = r.json()
        assert body["reply"] is None
        assert body["error"] is not None
        assert body["metadata"] is None

    def test_failed_request_does_not_leave_orphan_user_message(self, client: TestClient):
        """
        If the LLM call fails, the user message must be rolled back from
        the session history.
        """
        client.post("/debug/fail-key/1/on")
        client.post("/debug/fail-key/2/on")
        client.post("/debug/fail-key/3/on")

        litellm.cache = Cache(type="local")

        sid = "orphan-sess"
        r = client.post("/chat", json={"session_id": sid, "message": "Orphaned message?"})
        assert r.status_code == 200
        assert r.json()["error"] is not None

        # History should be empty — rollback worked
        hist = client.get(f"/history/{sid}").json()["messages"]
        assert hist == [], f"Expected empty history after failed request, got: {hist}"
