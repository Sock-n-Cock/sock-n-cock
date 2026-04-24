from contextlib import asynccontextmanager

import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from kafka import KafkaManager
from operations import (
    ClientTextOperation,
    DocumentRecord,
    apply_incoming_operation,
    create_document_record,
)

kafka = KafkaManager()
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await kafka.start()
    yield
    await kafka.stop()


fastapi_app = FastAPI(lifespan=lifespan)
fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)

# `rooms` stores presence metadata, while `documents` is the authoritative
# server-side snapshot plus operation history used to rebase stale edits.
rooms: dict[str, dict] = {}
documents: dict[str, DocumentRecord] = {}


def _get_document(doc_id: str) -> DocumentRecord:
    if doc_id not in documents:
        documents[doc_id] = create_document_record()
    return documents[doc_id]


@sio.event
async def connect(sid, environ):
    print(f"Connected: {sid}")


@sio.event
async def disconnect(sid):
    for doc_id, users in rooms.items():
        if sid in users:
            del users[sid]
            await sio.emit("users-changed", list(users.values()), room=doc_id)
            await sio.emit("user-left", sid, room=doc_id)
    print(f"Disconnected: {sid}")


@sio.event
async def join(sid, data):
    doc_id = data["docId"]
    await sio.enter_room(sid, doc_id)

    if doc_id not in rooms:
        rooms[doc_id] = {}

    rooms[doc_id][sid] = {
        "id": sid,
        "name": data["userName"],
        "color": data["color"],
    }

    document = _get_document(doc_id)
    await sio.emit(
        "document-state",
        {
            "docId": doc_id,
            "content": document["content"],
            "version": document["version"],
        },
        to=sid,
    )
    await sio.emit("users-changed", list(rooms[doc_id].values()), room=doc_id)


@sio.on("client-op")
async def client_op(sid, data):
    await kafka.produce(data["docId"], sid, data)


@sio.on("cursor-move")
async def cursor_move(sid, data):
    doc_id = data["docId"]
    await sio.emit("remote-cursor", {**data, "userId": sid}, room=doc_id, skip_sid=sid)


async def broadcast_edit(doc_id: str, data: dict):
    document = _get_document(doc_id)
    operation: ClientTextOperation = {
        "docId": doc_id,
        "opId": str(data["opId"]),
        "text": str(data["text"]),
        "start": int(data["start"]),
        "end": int(data["end"]),
        "baseVersion": int(data["baseVersion"]),
    }

    # Every incoming edit is rebased onto the latest authoritative state before
    # it is applied and broadcast back to the room.
    server_operation = apply_incoming_operation(
        document,
        operation,
        user_id=str(data["userId"]),
    )

    await sio.emit("server-update", server_operation, room=doc_id)
