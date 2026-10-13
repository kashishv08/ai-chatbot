"""
llm_client.py - LiteLLM Router creation, cache setup, and the core chat call.

Key design decisions:
  1. One litellm.Router deployment per API key — same model_name "chat-model"
     so the router treats them as a pool and automatically fails over.
  2. litellm.cache is set globally (so it survives router rebuilds) before
     the router is created.  Router(cache_responses=True) uses this global cache.
  3. Cache-hit detection: we probe litellm.cache directly before the router
     call.  If a hit exists we mark resolution_source="LLM_CACHE".  The
     router still returns the cached response (fast), so latency_ms reflects
     the actual speed.
  4. Simulated failures: when a key is "simulated down" we replace its
     api_key with a deliberately invalid string AND set mock_response to an
     error marker so it always raises before touching the real API.  The
     router's retry logic then falls through to the next key.
  5. All exceptions are caught; the caller always gets a structured result.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

import litellm
from litellm import Router
from litellm.caching.caching import Cache

from config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level state (mutable by debug endpoints)
# ---------------------------------------------------------------------------

# Keys that the debug endpoint has "turned off" (1-based indices)
_simulated_down: Set[int] = set()

# Per-key call counters (key index -> count, 2 keys)
_key_usage_counts: Dict[int, int] = {1: 0, 2: 0}

# The live router instance — rebuilt whenever debug state changes
_router: Optional[Router] = None

# ---------------------------------------------------------------------------
# Cache setup
# ---------------------------------------------------------------------------


def _setup_cache() -> None:
    """Initialise LiteLLM global in-memory local cache."""
    ttl = settings.CACHE_TTL_SECONDS
    logger.info("Using in-memory local cache (TTL=%ds)", ttl)
    litellm.cache = Cache(type="local", ttl=ttl)


# ---------------------------------------------------------------------------
# Router builder
# ---------------------------------------------------------------------------


def _build_router() -> Router:
    """
    Build a litellm.Router with one deployment per API key.

    All deployments share model_name "chat-model" so the router
    treats them as a pool and retries across them on failure.

    Deployment order is 1, 2 — the router will prefer lower-order
    deployments.  When a key is in _simulated_down, its api_key is replaced
    with a sentinel string that will immediately fail, demonstrating failover.
    """
    if not settings.GEMINI_API_KEYS:
        logger.warning("No Gemini API keys configured — router has no deployments.")
        return Router(model_list=[], num_retries=0)

    model_list: List[Dict[str, Any]] = []
    for idx, api_key in enumerate(settings.GEMINI_API_KEYS, start=1):
        # When simulated down: use a bad key so the provider returns 401/429.
        # We do NOT use mock_response because some LiteLLM versions handle it
        # as a successful response rather than an error triggering failover.
        effective_key = "__SIMULATED_DOWN__" if idx in _simulated_down else api_key

        deployment: Dict[str, Any] = {
            "model_name": "chat-model",
            "litellm_params": {
                "model": settings.MODEL_NAME,
                "api_key": effective_key,
                # 'order' controls preferred priority: lower = tried first
                "order": idx,
                "timeout": settings.REQUEST_TIMEOUT,
            },
            # model_info.id is used to identify which key answered
            # (surfaced in response._hidden_params["model_id"])
            "model_info": {"id": f"key-{idx}"},
        }
        if settings.MOCK_RESPONSE:
            if idx in _simulated_down:
                deployment["litellm_params"]["mock_response"] = "litellm.RateLimitError"
            else:
                deployment["litellm_params"]["mock_response"] = settings.MOCK_RESPONSE

        model_list.append(deployment)
        logger.debug(
            "Registered deployment key-%d (simulated_down=%s)", idx, idx in _simulated_down
        )

    num_keys = len(settings.GEMINI_API_KEYS)
    router = Router(
        model_list=model_list,
        # Retry across all keys on any failure
        num_retries=num_keys,
        # After 1 failure, cool a deployment down for cooldown_time seconds
        allowed_fails=settings.ALLOWED_FAILS,
        cooldown_time=settings.COOLDOWN_TIME,
        # Use the global litellm.cache for response caching
        cache_responses=True,
        # Prefer key-1, fall back to key-2 in order
        routing_strategy="simple-shuffle",
        # Short retry delay to keep fallover fast during tests
        retry_after=1,
        timeout=settings.REQUEST_TIMEOUT,
        enable_pre_call_checks=True,
    )
    logger.info(
        "Router built with %d deployment(s); simulated_down=%s",
        len(model_list),
        sorted(_simulated_down),
    )
    return router


# ---------------------------------------------------------------------------
# Public initialisation
# ---------------------------------------------------------------------------


def init() -> None:
    """Call once at application startup to set up cache and build the router."""
    global _router
    _setup_cache()
    _router = _build_router()


def rebuild_router() -> None:
    """Rebuild the router — called by debug endpoints after changing key state."""
    global _router
    _router = _build_router()
    logger.info("Router rebuilt; simulated_down=%s", sorted(_simulated_down))


def get_router() -> Router:
    """Return the current router, auto-initialising if needed."""
    global _router
    if _router is None:
        init()
    return _router


# ---------------------------------------------------------------------------
# Debug helpers
# ---------------------------------------------------------------------------


def set_key_simulated_down(index: int, down: bool) -> None:
    """Mark a 1-based key index as simulated-down or restore it."""
    if down:
        _simulated_down.add(index)
    else:
        _simulated_down.discard(index)
    rebuild_router()


def get_simulated_down() -> List[int]:
    return sorted(_simulated_down)


def increment_key_usage(key_index: int) -> None:
    """Increment the per-key usage counter (thread-safe via GIL for simple ints)."""
    _key_usage_counts[key_index] = _key_usage_counts.get(key_index, 0) + 1


def get_key_usage_counts() -> Dict[int, int]:
    return dict(_key_usage_counts)


# ---------------------------------------------------------------------------
# Cache-hit detection helper
# ---------------------------------------------------------------------------


def _check_cache_hit(messages: List[Dict[str, str]]) -> bool:
    """
    Probe the LiteLLM cache BEFORE the router call.

    If a cached entry exists for this messages array the upcoming router call
    will return it from cache (fast path), so we can flag it as LLM_CACHE.

    Returns True if a cache entry exists.
    """
    if litellm.cache is None:
        return False
    try:
        cache_key = litellm.cache.get_cache_key(
            model=settings.MODEL_NAME,
            messages=messages,
        )
        cached = litellm.cache.get_cache(cache_key)
        return cached is not None
    except Exception as exc:
        # Never let cache inspection break the main flow
        logger.debug("Cache probe failed (non-fatal): %s", exc)
        return False


# ---------------------------------------------------------------------------
# Chat call result
# ---------------------------------------------------------------------------


@dataclass
class ChatResult:
    """Structured result returned by chat_completion()."""

    reply: Optional[str] = None
    error: Optional[str] = None
    resolution_source: str = "LIVE_INFERENCE"
    model_used: str = ""
    latency_ms: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    key_index_used: Optional[int] = None
    fallback_attempts: int = 0


# ---------------------------------------------------------------------------
# Main chat call
# ---------------------------------------------------------------------------


async def chat_completion(
    messages: List[Dict[str, str]],
    session_id: str = "",
) -> ChatResult:
    """
    Call the LiteLLM router and return a structured ChatResult.

    Args:
        messages: Full conversation (including the new user message and
                  optional system prompt) to send to the LLM.
        session_id: Used only for logging.

    Returns:
        ChatResult — always, even on total failure.
    """
    if not settings.GEMINI_API_KEYS:
        return ChatResult(
            error="No API keys are configured on the server. Please add at least GEMINI_API_KEY_1."
        )

    router = get_router()

    # Probe cache BEFORE the call so we can label the response correctly.
    # The router will still return the cached value (fast), but we know it
    # was a cache hit rather than live inference.
    is_cache_hit = _check_cache_hit(messages)

    start = time.perf_counter()
    try:
        response = await router.acompletion(
            model="chat-model",
            messages=messages,
            # This flag tells LiteLLM's caching layer to check + store results.
            # The router propagates it because cache_responses=True was set.
            caching=True,
        )
    except litellm.RateLimitError as exc:
        logger.error("[session=%s] All keys rate-limited: %s", session_id, exc)
        return ChatResult(
            error="All API keys are currently rate-limited. Please try again in a moment."
        )
    except litellm.APIConnectionError as exc:
        logger.error("[session=%s] API connection error: %s", session_id, exc)
        return ChatResult(error="Could not reach the AI provider. Please check your connection.")
    except litellm.AuthenticationError as exc:
        logger.error("[session=%s] Authentication error: %s", session_id, exc)
        return ChatResult(error="All API keys are invalid or unauthorised. Please check your configuration.")
    except litellm.Timeout as exc:
        logger.error("[session=%s] Request timed out: %s", session_id, exc)
        return ChatResult(error="The request timed out. Please try again.")
    except Exception as exc:  # pylint: disable=broad-except
        logger.error("[session=%s] Unexpected error: %s", session_id, exc, exc_info=True)
        return ChatResult(
            error="All providers are currently unavailable. Please try again in a moment."
        )

    latency_ms = int((time.perf_counter() - start) * 1000)

    # ------------------------------------------------------------------ #
    # Extract metadata from the response
    # ------------------------------------------------------------------ #
    hidden: Dict[str, Any] = getattr(response, "_hidden_params", {}) or {}

    # model_id is set to model_info["id"] ("key-N") by LiteLLM Router
    raw_model_id: str = hidden.get("model_id") or ""
    key_index_used: Optional[int] = None
    if raw_model_id.startswith("key-"):
        try:
            key_index_used = int(raw_model_id.split("-", 1)[1])
        except (ValueError, IndexError):
            pass

    # Fallback count from Router's additional_headers
    additional_headers: Dict[str, Any] = hidden.get("additional_headers") or {}
    fallback_attempts: int = int(
        additional_headers.get("x-litellm-attempted-fallbacks", 0) or 0
    )

    # Token usage — per-request from response.usage
    usage = getattr(response, "usage", None)
    input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
    output_tokens = int(getattr(usage, "completion_tokens", 0) or 0)

    # Model name
    model_used: str = getattr(response, "model", settings.MODEL_NAME) or settings.MODEL_NAME

    # Reply text
    try:
        reply = response.choices[0].message.content
    except (AttributeError, IndexError):
        return ChatResult(error="Received an empty response from the provider.", latency_ms=latency_ms)

    # Resolution source
    resolution_source = "LLM_CACHE" if (is_cache_hit or hidden.get("cache_hit") is True) else "LIVE_INFERENCE"

    # Track per-key usage — only for live inference calls that actually queried the upstream API key
    if key_index_used is not None and resolution_source != "LLM_CACHE":
        increment_key_usage(key_index_used)

    logger.info(
        "[session=%s] resolution=%s key=%s fallbacks=%d latency=%dms in=%d out=%d",
        session_id,
        resolution_source,
        key_index_used,
        fallback_attempts,
        latency_ms,
        input_tokens,
        output_tokens,
    )

    return ChatResult(
        reply=reply,
        resolution_source=resolution_source,
        model_used=model_used,
        latency_ms=latency_ms,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        key_index_used=key_index_used,
        fallback_attempts=fallback_attempts,
    )
