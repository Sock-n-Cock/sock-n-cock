### <div align="center"><img src="./client/public/sock-n-cock-logo.png" width="200"> 
# sock-n-cock

Collaborative real-time text editor with Socket.IO, FastAPI, Monaco, and Kafka.

## What It Does

- Multiple clients can edit the same document in real time.
- The client talks to the backend over Socket.IO using the WebSocket transport.
- Edit operations are published to Kafka and then replayed back through the server.
- The server keeps an in-memory snapshot of each document so late joiners receive
  the current content immediately instead of starting from an empty editor.

## Requirements

Server:
- Docker
- Python 3.11+
- [uv](https://docs.astral.sh/uv/) — package manager and runner

Client:
- Node.js 20+ and npm

## Project Layout

```text
.
├── client/              # React + Vite + Monaco frontend
├── server/              # FastAPI + Socket.IO + Kafka backend
└── docker-compose.yml   # Kafka broker for edit distribution
```

## Launch

1. Start Kafka and Redis (Docker) from the project root:
ц
```bash
docker compose up -d
```

2. Install backend dependencies:

```bash
cd server
uv sync
```

3. Start the backend on port `3001`:

```bash
cd server/src
uv run uvicorn main:app --reload --port 3001
```

4. In a second terminal, install frontend dependencies:

```bash
cd client
npm install
```

5. Start the frontend on port `5173`:

```bash
cd client
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in multiple tabs to collaborate.

## How To Use It 

- Type in one client and the edits should appear in the others.
- Open a fresh client instance after making edits; it should receive the current document
  snapshot on join.
- The left sidebar shows connected users and simple activity logs.

## Stop

- Stop the frontend and backend with `Ctrl+C` in their terminals.
- Stop Kafka with `docker compose down`.

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) with System overview, Data flow and Tech Stack

## Notes

- The server depends on Kafka at `localhost:9092`; if Kafka is not running, the
  backend will fail during startup.
- Document state is kept in memory on the backend right now, so restarting the
  server resets the shared document.
