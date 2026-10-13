"""
session_store.py - In-memory per-session conversation history.

Uses an asyncio.Lock to protect the shared dict so concurrent requests
for the same session_id don't race.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Dict, List

from config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

MessageList = List[Dict[str, str]]
"""A list of {"role": "user"|"assistant"|"system", "content": "..."} dicts."""


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------


class SessionStore:
    """Thread-safe in-memory session history store."""

    def __init__(self, max_messages: int = settings.MAX_HISTORY_MESSAGES) -> None:
        self._sessions: Dict[str, MessageList] = {}
        self._lock: asyncio.Lock = asyncio.Lock()
        self._max_messages = max_messages

    async def get_history(self, session_id: str) -> MessageList:
        """Return a shallow copy of the history for a session."""
        async with self._lock:
            return list(self._sessions.get(session_id, []))

    async def append_user(self, session_id: str, content: str) -> MessageList:
        """
        Append a user turn to the session.

        Returns the FULL history (including new message) so the caller can
        build the messages array for the LLM call.  Caps at max_messages.
        """
        async with self._lock:
            history = self._sessions.setdefault(session_id, [])
            history.append({"role": "user", "content": content})
            # Cap: keep the last max_messages entries (always keep pairs)
            if len(history) > self._max_messages:
                history[:] = history[-self._max_messages :]
            return list(history)

    async def append_assistant(self, session_id: str, content: str) -> None:
        """
        Append an assistant turn.

        Called ONLY after a successful LLM response so that failed calls
        never leave dangling user turns without a matching assistant reply.
        """
        async with self._lock:
            history = self._sessions.setdefault(session_id, [])
            history.append({"role": "assistant", "content": content})
            if len(history) > self._max_messages:
                history[:] = history[-self._max_messages :]

    async def pop_last_user(self, session_id: str) -> None:
        """
        Remove the most-recent user turn.

        Used to roll back after a failed LLM call so we don't leave a
        dangling user message without an assistant reply.
        """
        async with self._lock:
            history = self._sessions.get(session_id, [])
            if history and history[-1]["role"] == "user":
                history.pop()
                logger.debug("Rolled back dangling user message for session %s", session_id)

    async def delete(self, session_id: str) -> None:
        """Delete a session entirely."""
        async with self._lock:
            self._sessions.pop(session_id, None)
            logger.info("Deleted session %s", session_id)

    async def get_raw(self, session_id: str) -> MessageList:
        """Return raw (non-copied) history — only use for read-only display."""
        async with self._lock:
            return list(self._sessions.get(session_id, []))


# Module-level singleton used by main.py
session_store = SessionStore()
