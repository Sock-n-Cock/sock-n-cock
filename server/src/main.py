import socketio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient  # <--- ДОБАВЛЕНО: импорт motor
from collab import AppliedOperation, apply_operation, rebase_operation, IncomingOperation
from kafka import KafkaManager

from fastapi import Query

# <--- ДОБАВЛЕНО: Настройка подключения к MongoDB
MONGO_URL = "mongodb://localhost:27017"
mongo_client = AsyncIOMotorClient(MONGO_URL)
db = mongo_client.collab_database  # Название базы данных
documents_collection = db.documents  # Название коллекции

kafka = KafkaManager()
sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')


@asynccontextmanager
async def lifespan(app: FastAPI):
    await kafka.start()
    yield
    await kafka.stop()
    mongo_client.close()  # <--- ДОБАВЛЕНО: Закрываем соединение с БД при остановке сервера


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

@fastapi_app.get("/documents")
async def list_documents():
    """Возвращает список всех ID документов из базы данных"""
    cursor = documents_collection.find({}, {"_id": 1})
    docs = await cursor.to_list(length=100)
    return [doc["_id"] for doc in docs]


# <--- ИЗМЕНЕНО: Функция стала асинхронной и теперь обращается к БД
async def _get_document(doc_id: str) -> dict:
    if doc_id not in documents:
        # Пытаемся найти документ в MongoDB
        doc_from_db = await documents_collection.find_one({"_id": doc_id})

        if doc_from_db:
            # Если нашли, загружаем в память
            documents[doc_id] = {
                "content": doc_from_db.get("content", ""),
                "version": doc_from_db.get("version", 0),
                "history": doc_from_db.get("history", [])
            }
        else:
            # Если нет, создаем пустой
            documents[doc_id] = {"content": "", "version": 0, "history": []}

    return documents[doc_id]


# <--- ИЗМЕНЕНО: Добавлен await перед _get_document
async def _emit_document_state(doc_id: str, target_sid: str):
    document = await _get_document(doc_id)
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


async def broadcast_edit(doc_id: str, data: IncomingOperation):
    # <--- ИЗМЕНЕНО: Добавлен await перед _get_document
    document = await _get_document(doc_id)
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

        # <--- ДОБАВЛЕНО: Сохраняем актуальное состояние в MongoDB
        # Используем upsert=True, чтобы документ создался, если его еще нет
        await documents_collection.update_one(
            {"_id": doc_id},
            {"$set": {
                "content": document['content'],
                "version": document['version'],
                "history": document['history']
            }},
            upsert=True
        )

        await sio.emit('server-update', applied, room=doc_id)
    except ValueError as e:
        print(f"Discarding invalid edit for {doc_id}: {e}")
        user_id = data.get('userId')
        if user_id:
            await _emit_document_state(doc_id, user_id)