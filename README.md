# sock-n-cock

Collaborative real-time text editor over WebSockets.

## Structure

```
.
├── client/          # Frontend (TBD)
└── server/
    ├── pyproject.toml
    └── src/
        └── main.py  # WebSocket server entry point
```

## Requirements

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) — package manager and runner

## Setup

```bash
# Install uv (if not installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install dependencies
cd server
uv sync
```

## Setup

### 1. Kafka (Docker)

```bash
docker compose up -d
```

### 2. Server

```bash
cd server
uv sync
```

### 3. Client

```bash
cd client
npm install
```

## Run

### Server

```bash
cd server/src
uv run uvicorn main:app --reload --port 3001
```

### Client

```bash
cd client
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in multiple tabs to collaborate.

## Run

```bash
cd server
uv run src/main.py
```

## Dev

```bash
# Add a dependency
uv add websockets

# Add a dev dependency
uv add --dev pytest

# Run with auto-reload (if using watchfiles)
uv run --with watchfiles watchfiles "python src/main.py"
```

## pyproject.toml

Dependencies and metadata live in `server/pyproject.toml`. No `requirements.txt` needed — `uv.lock` pins exact versions.

```toml
[project]
name = "sock-n-cock"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "websockets>=13.0",
]
```
