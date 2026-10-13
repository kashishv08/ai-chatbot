# Resilient AI Chatbot

A production-grade, resilient conversational AI web application designed to withstand individual API key rate limits, authentication failures, and network timeouts through automatic multi-key pool failover, low-latency in-memory response caching, and session persistence.

---

## Architecture Overview

- **Backend**: Python 3.11+, FastAPI, LiteLLM (`litellm.Router`), Pydantic v2, Uvicorn
- **Frontend**: Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS
- **AI Provider**: Google Gemini (`gemini/gemini-2.0-flash` by default, configurable via `MODEL_NAME`)
- **Key Failover Pool**: Automatic multi-key rotation and cooldown using `litellm.Router` across `GEMINI_API_KEY_1`, `GEMINI_API_KEY_2`, and `GEMINI_API_KEY_3`.
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
GEMINI_API_KEY_3=your_gemini_api_key_3
MODEL_NAME=gemini/gemini-2.0-flash
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
| `POST` | `/debug/fail-key/{index}/{state}` | Toggle simulated down state for key 1, 2, or 3 (`on` or `off`) |
