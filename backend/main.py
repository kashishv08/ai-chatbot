"""
main.py - FastAPI application: routes, CORS, lifecycle.

Run with a SINGLE worker because in-memory sessions and cache require it:
    uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1

All state (sessions, cache, debug flags) lives in-process.
For multi-instance deployments switch to Redis + a DB session store.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import llm_client
from config import settings
from llm_client import (
    chat_completion,
    get_key_usage_counts,
    get_simulated_down,
    set_key_simulated_down,
)
from schemas import (
    ChatRequest,
    ChatResponse,
    DebugKeyState,
    DebugStatusResponse,
    HealthResponse,
    HistoryResponse,
    ResponseMetadata,
    SessionDeleteResponse,
    TokenUsage,
)
from session_store import session_store

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lifespan (initialise cache + router before first request)
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting up — initialising LiteLLM cache and router…")
    llm_client.init()
    logger.info(
        "Ready — %d key(s) loaded, model=%s, cache=%s",
        len(settings.GEMINI_API_KEYS),
        settings.MODEL_NAME,
        "redis" if settings.REDIS_URL else "in-memory",
    )
    yield
    logger.info("Shutting down.")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Resilient AI Chatbot API",
    description=(
        "Multi-turn AI chat backed by LiteLLM Router with automatic key "
        "failover and in-memory response caching."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# POST /chat
# ---------------------------------------------------------------------------


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    """
    Send a message and get a reply from the AI.

    Multi-turn context is maintained server-side via session_id.
    The response always has HTTP 200; check the ``error`` field for failures.
    """
    # Validate message length (Pydantic catches empty/too-long, but belt+braces)
    if len(req.message) > 4000:
        return ChatResponse(reply=None, error="Message exceeds 4 000 character limit.", metadata=None)

    # Append the new user turn and get the full history for the LLM call.
    # If the call fails we ROLL BACK the user turn so it's not orphaned.
    history = await session_store.append_user(req.session_id, req.message)

    # Build the messages list: optional system prompt + conversation history
    messages = list(history)
    if req.system_prompt and req.system_prompt.strip():
        messages.insert(0, {"role": "system", "content": req.system_prompt.strip()})

    # ------------------------------------------------------------------ #
    # Call the LLM (all error handling is inside chat_completion)
    # ------------------------------------------------------------------ #
    result = await chat_completion(messages=messages, session_id=req.session_id)

    if result.error:
        # Roll back the user turn — it was not answered successfully
        await session_store.pop_last_user(req.session_id)
        logger.warning(
            "[session=%s] Request failed, user message rolled back: %s",
            req.session_id,
            result.error,
        )
        return ChatResponse(reply=None, error=result.error, metadata=None)

    # Persist assistant reply ONLY after success
    await session_store.append_assistant(req.session_id, result.reply or "")

    return ChatResponse(
        reply=result.reply,
        error=None,
        metadata=ResponseMetadata(
            resolution_source=result.resolution_source,
            model_used=result.model_used,
            latency_ms=result.latency_ms,
            token_usage=TokenUsage(
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
            ),
            key_index_used=result.key_index_used,
            fallback_attempts=result.fallback_attempts,
        ),
    )


# ---------------------------------------------------------------------------
# GET /history/{session_id}
# ---------------------------------------------------------------------------


@app.get("/history/{session_id}", response_model=HistoryResponse)
async def get_history(session_id: str) -> HistoryResponse:
    """Return the full conversation history for a session."""
    messages = await session_store.get_raw(session_id)
    return HistoryResponse(messages=messages)


# ---------------------------------------------------------------------------
# DELETE /session/{session_id}
# ---------------------------------------------------------------------------


@app.delete("/session/{session_id}", response_model=SessionDeleteResponse)
async def delete_session(session_id: str) -> SessionDeleteResponse:
    """Clear the conversation history for a session (New Chat)."""
    await session_store.delete(session_id)
    return SessionDeleteResponse(cleared=True)


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness + configuration check."""
    return HealthResponse(
        status="ok",
        keys_loaded=len(settings.GEMINI_API_KEYS),
        model=settings.MODEL_NAME,
        cache_enabled=True,
    )


# ---------------------------------------------------------------------------
# POST /debug/fail-key/{index}/{state}
# ---------------------------------------------------------------------------


@app.post("/debug/fail-key/{index}/{state}")
def debug_fail_key(index: int, state: str) -> dict:
    """
    Simulate a key failure for demonstration purposes.

    index: 1-based key index (1, 2, or 3).
    state: "on" to mark the key as down, "off" to restore it.

    When a key is marked down the router is rebuilt so that key uses an
    invalid api_key, causing immediate authentication failures that trigger
    failover to the next available key.
    """
    if index < 1 or index > 3:
        raise HTTPException(status_code=400, detail="Key index must be 1, 2, or 3.")
    if state not in ("on", "off"):
        raise HTTPException(status_code=400, detail="State must be 'on' or 'off'.")

    set_key_simulated_down(index, state == "on")
    logger.info("Debug: key-%d simulated_down=%s", index, state == "on")
    return {
        "key_index": index,
        "simulated_down": state == "on",
        "all_simulated_down": get_simulated_down(),
    }


# ---------------------------------------------------------------------------
# GET /debug/status
# ---------------------------------------------------------------------------


@app.get("/debug/status", response_model=DebugStatusResponse)
def debug_status() -> DebugStatusResponse:
    """Return which keys are simulated-down and per-key usage counts."""
    down = get_simulated_down()
    counts = get_key_usage_counts()
    key_states = [
        DebugKeyState(
            key_index=i,
            simulated_down=i in down,
            usage_count=counts.get(i, 0),
        )
        for i in range(1, 4)
    ]
    return DebugStatusResponse(simulated_down=down, key_states=key_states)