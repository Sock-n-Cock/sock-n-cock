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

rooms: dict[str, dict] = {}

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
    await sio.emit('users-changed', list(rooms[doc_id].values()), room=doc_id)

@sio.on('client-op')
async def client_op(sid, data):
    await kafka.produce(data['docId'], sid, data)

@sio.on('cursor-move')
async def cursor_move(sid, data):
    doc_id = data['docId']
    await sio.emit('remote-cursor', {**data, 'userId': sid}, room=doc_id, skip_sid=sid)

async def broadcast_edit(doc_id: str, data: dict):
    await sio.emit('server-update', data, room=doc_id)