"""
config.py - Environment loading and application settings.

All configuration is read from environment variables (or .env file).
No secrets are hardcoded here.
"""

import os
from typing import List
from dotenv import load_dotenv

# Load .env from the backend directory
load_dotenv(override=False)


class Settings:
    """Central settings object built from environment variables."""

    # ------------------------------------------------------------------ #
    # LLM / Provider
    # ------------------------------------------------------------------ #
    MODEL_NAME: str = os.getenv("MODEL_NAME", "gemini/gemini-3.5-flash")
    """Gemini model to use via LiteLLM, e.g. gemini/gemini-3.5-flash."""

    # Collect whichever Gemini API keys are present in the environment (Key 1 & Key 2).
    GEMINI_API_KEYS: List[str] = [
        v.strip()
        for v in (
            os.getenv("GEMINI_API_KEY_1"),
            os.getenv("GEMINI_API_KEY_2"),
        )
        if v and v.strip() and not v.strip().lower().startswith("your_")
    ]
    """List of non-empty, non-placeholder Gemini API keys loaded from GEMINI_API_KEY_1/2."""

    MOCK_RESPONSE: str | None = os.getenv("MOCK_RESPONSE")
    """Optional mock response string for tests / mock mode."""

    # ------------------------------------------------------------------ #
    # Caching
    # ------------------------------------------------------------------ #
    REDIS_URL: str | None = os.getenv("REDIS_URL")
    """Optional Redis URL.  If set, LiteLLM uses Redis cache; else in-memory."""

    CACHE_TTL_SECONDS: int = int(os.getenv("CACHE_TTL_SECONDS", "3600"))
    """Time-to-live for cached LLM responses (seconds). Default 1 hour."""

    # ------------------------------------------------------------------ #
    # Session
    # ------------------------------------------------------------------ #
    MAX_HISTORY_MESSAGES: int = int(os.getenv("MAX_HISTORY_MESSAGES", "30"))
    """Maximum number of messages (user + assistant) kept per session."""

    # ------------------------------------------------------------------ #
    # Router / reliability
    # ------------------------------------------------------------------ #
    REQUEST_TIMEOUT: float = float(os.getenv("REQUEST_TIMEOUT", "30"))
    """Per-request timeout in seconds for LLM calls."""

    ALLOWED_FAILS: int = int(os.getenv("ALLOWED_FAILS", "1"))
    """Failures before a deployment is cooled down."""

    COOLDOWN_TIME: int = int(os.getenv("COOLDOWN_TIME", "30"))
    """Cooldown window in seconds after a deployment exceeds ALLOWED_FAILS."""

    # ------------------------------------------------------------------ #
    # CORS
    # ------------------------------------------------------------------ #
    ALLOWED_ORIGINS: List[str] = os.getenv("ALLOWED_ORIGINS", "*").split(",")
    """Comma-separated list of allowed CORS origins. Default '*'."""


settings = Settings()
