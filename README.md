# Resilient AI Chatbot

A production-grade, resilient conversational AI web application designed to withstand individual API key rate limits, authentication failures, and network timeouts through automatic multi-key pool failover, low-latency in-memory response caching, and session persistence.

---

## Architecture Overview

- **Backend**: Python 3.11+, FastAPI, LiteLLM (`litellm.Router`), Pydantic v2, Uvicorn
- **Frontend**: Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS
- **AI Provider**: Google Gemini (`gemini/gemini-3.5-flash-lite` by default, configurable via `MODEL_NAME`)
- **Key Failover Pool**: Automatic multi-key rotation and cooldown using `litellm.Router` across `GEMINI_API_KEY_1` and `GEMINI_API_KEY_2`.
- **Response Caching**: LiteLLM dual caching with configurable TTL (`CACHE_TTL_SECONDS`), dramatically reducing latency and token costs on repeated identical prompts.
- **Failover Simulation & Debug Tools**: Real-time simulated outage toggle for individual API keys (`/debug/fail-key/{index}/{on|off}`) to test and demonstrate graceful degradation live in the browser.

---

## Directory Structure

```
ai-chatbot/
├── backend/
│   ├── config.py             # Environment configuration (Pydantic / python-dotenv)
│   ├── main.py               # FastAPI application routes, CORS, lifespan
│   ├── llm_client.py         # LiteLLM Router setup, caching, chat completion
│   ├── schemas.py            # Pydantic request/response models
│   ├── session_store.py      # Thread-safe in-memory session history with rollback
│   ├── requirements.txt      # Pinned dependency versions
│   ├── Procfile              # Single-worker Uvicorn deployment command
│   ├── .env.example          # Environment variables template
│   └── tests/
│       └── test_api.py       # 20 automated integration tests (mocked, no real keys needed)
├── frontend/
│   ├── app/
│   │   ├── layout.tsx        # Root HTML layout and font definitions
│   │   ├── page.tsx          # Full chatbot UI with real-time debug controls & telemetry
│   │   └── globals.css       # Tailwind CSS & custom design system styling
│   ├── package.json          # Dependencies and build scripts
│   ├── tsconfig.json         # TypeScript configuration
│   └── .env                  # Frontend environment configuration (NEXT_PUBLIC_API_BASE_URL)
└── README.md
```

---

## Quick Start

### 1. Backend Setup

```bash
cd backend

# Create virtual environment (if not already present)
python -m venv venv

# Activate virtual environment
# Windows (PowerShell):
.\venv\Scripts\Activate.ps1
# Linux / macOS:
# source venv/bin/activate

# Install pinned dependencies
pip install -r requirements.txt

# Configure environment variables
# Copy .env.example to .env and insert your real Gemini API keys
copy .env.example .env
```

Edit `backend/.env`:
```env
GEMINI_API_KEY_1=your_gemini_api_key_1
GEMINI_API_KEY_2=your_gemini_api_key_2
MODEL_NAME=gemini/gemini-3.5-flash-lite
ALLOWED_ORIGINS=*
CACHE_TTL_SECONDS=3600
```

Start the backend server (single worker recommended for in-memory session/cache state):
```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000 --workers 1
```

### 2. Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Verify configuration
# .env contains: NEXT_PUBLIC_API_BASE_URL=http://localhost:8000

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Running the Automated Test Suite

The test suite runs entirely offline using LiteLLM mock responses and doesn't consume API credits.

```bash
cd backend
.\venv\Scripts\python.exe -m pytest tests/test_api.py -v
```

Tests cover:
- Health check and key loading status
- Single-turn and multi-turn conversational context
- Input validation (empty, blank, length boundaries)
- Session history retrieval and deletion
- In-memory response caching and latency reduction verification
- Key failover simulation (Key 1 outage -> Key 2 automatic promotion)
- Total pool outage handling (graceful error response, no unhandled 500s)
- History rollback on inference failure (preventing orphan user messages)

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Server health, number of active keys loaded, cache status |
| `POST` | `/chat` | Send message in a session with optional system prompt |
| `GET` | `/history/{session_id}` | Retrieve full conversation turn history for a session |
| `DELETE` | `/session/{session_id}` | Clear conversation history for a session |
| `GET` | `/debug/status` | List simulated down keys and per-key usage counters |
| `POST` | `/debug/fail-key/{index}/{state}` | Toggle simulated down state for key 1 or 2 (`on` or `off`) |

---

## API-Key Fallback Logic

When a chat request is made, `llm_client.py` builds a `litellm.Router` with one deployment per key (`GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`). Both deployments share the model name `"chat-model"` so the router treats them as a pool.

**Failover flow:**
1. The router tries Key 1 first (`order: 1`).
2. If Key 1 responds with HTTP 429 (rate limit), HTTP 401 (auth failure), a 5xx error, or times out — the router's `allowed_fails=1` cooldown mechanism marks Key 1 as unavailable.
3. The router automatically retries on Key 2 (`order: 2`) with no user-visible error.
4. If **both** keys are exhausted, the backend returns a friendly `error` field (HTTP 200) — the user sees an error bubble instead of a 500 crash.

All exception types are caught: `RateLimitError`, `AuthenticationError`, `APIConnectionError`, `Timeout`, and a broad `Exception` fallback.

---

## LiteLLM Response Caching

The backend initialises a `Cache(type="local", ttl=3600)` (in-memory, 1 hour TTL) on startup. `litellm.Router` is created with `cache_responses=True`.

**Cache hit detection works in two layers:**
1. **Pre-call probe** (`_check_cache_hit`): before calling the router, the backend probes `litellm.cache.get_cache()` with the same message hash. If a match is found, `resolution_source` is set to `LLM_CACHE`.
2. **Post-call fallback**: LiteLLM also sets `response._hidden_params["cache_hit"] = True` for cached responses, which is also checked.

Cache keys are based on the full `messages` array hash (model + prompt content). A new conversation turn changes the hash, so cache hits occur when the **exact same message history** is sent again (e.g. starting a fresh chat and sending the same first message).

---

## How to Verify: API-Key Failover

### Option A — Live UI Debug Panel (Recommended)

1. Open the frontend in your browser.
2. Click **Debug controls** in the right sidebar.
3. Send any message — note the `Key #1` badge in the metadata below the reply.
4. Toggle **Key 1** to OFF (simulated down). Send a **new message**.
5. The response metadata now shows `Key #2` — automatic failover worked.
6. Toggle **Key 2** to OFF as well. Send a message.
7. An error bubble appears: *"All API keys are invalid or unauthorised..."* — no 500 crash, no blank screen.
8. Toggle both keys back ON. Requests recover immediately.

### Option B — Direct API

```bash
# Simulate Key 1 as down
curl -X POST https://<your-backend-url>/debug/fail-key/1/on

# Send a message — backend uses Key 2
curl -X POST https://<your-backend-url>/chat \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test-1","message":"Hello"}'
# Response metadata: "key_index_used": 2

# Restore Key 1
curl -X POST https://<your-backend-url>/debug/fail-key/1/off
```

---

## How to Verify: Cache Hits

1. Open the frontend. Send the message: **"What is the capital of France?"**
   - The metadata bar shows: `LIVE_INFERENCE` + a latency value (e.g. `850ms`).
2. Click **New chat** (top right) to start a fresh session.
3. Send the **exact same message**: `"What is the capital of France?"`
   - The metadata bar now shows: `LLM_CACHE` + a much lower latency (e.g. `3ms`).
4. The cache TTL is 1 hour (`CACHE_TTL_SECONDS=3600`). Restarting the backend clears the in-memory cache.

---

## How to Verify: Per-Request Token Usage

1. Send any message in the chat. Below the AI reply you will see:
   ```
   LIVE_INFERENCE   gemini-3.5-flash-lite   ⏱ 834 ms   In: 12 | Out: 341   Key #1
   ```
2. The `In:` field is the **input token count for this specific request** (includes conversation history).
3. The `Out:` field is the **output token count for this specific reply**.
4. Send a follow-up message in the **same session**. The `In:` count will be higher (because the conversation history grew) while `Out:` reflects only the new reply.
5. These values come from `response.usage.prompt_tokens` and `response.usage.completion_tokens` in the LiteLLM response — they are **per-request**, not cumulative totals.
