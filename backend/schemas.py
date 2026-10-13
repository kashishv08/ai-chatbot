"""
schemas.py - Pydantic models for request / response validation.

All data shapes shared between main.py and llm_client.py live here so
they can be imported without circular dependencies.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


# ---------------------------------------------------------------------------
# Request
# ---------------------------------------------------------------------------


class ChatRequest(BaseModel):
    """Payload for POST /chat."""

    session_id: str = Field(..., min_length=1, description="Unique session identifier.")
    message: str = Field(..., min_length=1, max_length=4000, description="User message text.")
    system_prompt: str | None = Field(
        None,
        description="Optional system prompt applied for this session.",
    )

    @field_validator("message")
    @classmethod
    def message_must_not_be_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("message must not be blank")
        return v


# ---------------------------------------------------------------------------
# Response inner types
# ---------------------------------------------------------------------------


class TokenUsage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0


class ResponseMetadata(BaseModel):
    resolution_source: str  # "LLM_CACHE" | "LIVE_INFERENCE"
    model_used: str
    latency_ms: int
    token_usage: TokenUsage
    key_index_used: int | None = None
    fallback_attempts: int = 0


# ---------------------------------------------------------------------------
# Chat response
# ---------------------------------------------------------------------------


class ChatResponse(BaseModel):
    """Shape returned by POST /chat — always HTTP 200."""

    reply: str | None = None
    error: str | None = None
    metadata: ResponseMetadata | None = None


# ---------------------------------------------------------------------------
# History / session
# ---------------------------------------------------------------------------


class HistoryResponse(BaseModel):
    messages: list[dict]


class SessionDeleteResponse(BaseModel):
    cleared: bool


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


class HealthResponse(BaseModel):
    status: str
    keys_loaded: int
    model: str
    cache_enabled: bool


# ---------------------------------------------------------------------------
# Debug
# ---------------------------------------------------------------------------


class DebugKeyState(BaseModel):
    key_index: int
    simulated_down: bool
    usage_count: int


class DebugStatusResponse(BaseModel):
    simulated_down: list[int]
    key_states: list[DebugKeyState]
