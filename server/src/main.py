import socketio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
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
# server-side snapshot used when a client joins after edits already happened.
rooms: dict[str, dict] = {}
documents: dict[str, dict[str, int | str]] = {}


def _position_to_index(text: str, line_number: int, column: int) -> int:
    if line_number < 1 or column < 1:
        raise ValueError("Line and column numbers must be 1-based.")

    current_line = 1
    current_column = 1

    for index, char in enumerate(text):
        if current_line == line_number and current_column == column:
            return index

        if char == "\n":
            current_line += 1
            current_column = 1
        else:
            current_column += 1

    if current_line == line_number and current_column == column:
        return len(text)

    raise ValueError(
        f"Position ({line_number}, {column}) is outside the current document."
    )


def _apply_document_change(content: str, change: dict) -> str:
    # Monaco ranges are line/column based, but the server snapshot is plain text.
    # Convert the incoming range into string offsets before patching the document.
    range_data = change["range"]
    start_index = _position_to_index(
        content,
        range_data["startLineNumber"],
        range_data["startColumn"],
    )
    end_index = _position_to_index(
        content,
        range_data["endLineNumber"],
        range_data["endColumn"],
    )
    return f"{content[:start_index]}{change['text']}{content[end_index:]}"


def _get_document(doc_id: str) -> dict[str, int | str]:
    if doc_id not in documents:
        documents[doc_id] = {"content": "", "version": 0}
    return documents[doc_id]


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
    document = _get_document(doc_id)

    await sio.emit('document-state', {
        'docId': doc_id,
        'content': document['content'],
        'version': document['version'],
    }, to=sid)
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
        document['content'] = _apply_document_change(str(document['content']), data)
        document['version'] = int(document['version']) + 1
        await sio.emit('server-update', {**data, 'version': document['version']}, room=doc_id)
    except Exception as e:
        print(f"Error applying edit: {e}")