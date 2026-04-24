import socketio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from collab import AppliedOperation, apply_operation, rebase_operation
from kafka import KafkaManager

kafka = KafkaManager()
sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')


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
# server-side snapshot and operation history used to rebase stale edits.
rooms: dict[str, dict] = {}
documents: dict[str, dict] = {}


def _get_document(doc_id: str) -> dict:
    if doc_id not in documents:
        documents[doc_id] = {"content": "", "version": 0, "history": []}
    return documents[doc_id]


async def _emit_document_state(doc_id: str, target_sid: str):
    document = _get_document(doc_id)
    await sio.emit('document-state', {
        'docId': doc_id,
        'content': document['content'],
        'version': document['version'],
    }, to=target_sid)


@sio.event
async def connect(sid, environ):
    print(f"Connected: {sid}")


@sio.event
async def disconnect(sid):
    for doc_id, users in rooms.items():
        if sid in users:
            del users[sid]
            await sio.emit('users-changed', list(users.values()), room=doc_id)
            await sio.emit('user-left', sid, room=doc_id)
    print(f"Disconnected: {sid}")


@sio.event
async def join(sid, data):
    doc_id = data['docId']
    await sio.enter_room(sid, doc_id)
    if doc_id not in rooms:
        rooms[doc_id] = {}
    rooms[doc_id][sid] = {'id': sid, 'name': data['userName'], 'color': data['color']}
    await _emit_document_state(doc_id, sid)
    await sio.emit('users-changed', list(rooms[doc_id].values()), room=doc_id)


@sio.event
async def leave(sid, data):
    doc_id = data.get('docId')
    if doc_id:
        await sio.leave_room(sid, doc_id)
        if doc_id in rooms and sid in rooms[doc_id]:
            del rooms[doc_id][sid]
            await sio.emit('users-changed', list(rooms[doc_id].values()), room=doc_id)
            await sio.emit('user-left', sid, room=doc_id)
        print(f"User {sid} left room {doc_id}")


@sio.on('client-op')
async def client_op(sid, data):
    await kafka.produce(data['docId'], sid, data)


@sio.on('cursor-move')
async def cursor_move(sid, data):
    doc_id = data['docId']
    await sio.emit('remote-cursor', {**data, 'userId': sid}, room=doc_id, skip_sid=sid)


async def broadcast_edit(doc_id: str, data: dict):
    # All edits flow through Kafka and then through this function. That gives the
    # server one ordered place to update the snapshot and assign the next version.
    document = _get_document(doc_id)
    try:
        base_version = int(data['baseVersion'])
        current_version = int(document['version'])

        if base_version < 0 or base_version > current_version:
            raise ValueError(
                f"Client edit references invalid version {base_version}, current version is {current_version}."
            )

        history: list[AppliedOperation] = document['history']
        rebased = rebase_operation(data, history[base_version:])

        document['content'] = apply_operation(str(document['content']), rebased)
        document['version'] = current_version + 1

        applied: AppliedOperation = {
            **rebased,
            'version': int(document['version']),
        }
        history.append(applied)

        await sio.emit('server-update', applied, room=doc_id)
    except ValueError as e:
        print(f"Discarding invalid edit for {doc_id}: {e}")
        user_id = data.get('userId')
        if user_id:
            await _emit_document_state(doc_id, user_id)
