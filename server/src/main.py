import socketio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from collab import AppliedOperation, apply_operation, rebase_operation, IncomingOperation
from kafka import KafkaManager
from redis_manager import RedisManager
import asyncio
from pymongo.errors import DuplicateKeyError


MONGO_URL = "mongodb://localhost:27017"
mongo_client = AsyncIOMotorClient(MONGO_URL)
db = mongo_client.collab_database
documents_collection = db.documents

redis_manager = RedisManager()
kafka = KafkaManager()
sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')


@asynccontextmanager
async def lifespan(app: FastAPI):
    await kafka.start()
    yield
    await kafka.stop()
    mongo_client.close()


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
documents: dict[str, dict] = {}
save_tasks: dict[str, asyncio.Task] = {}

@fastapi_app.get("/documents")
async def list_documents():
    """Возвращает список всех ID документов из базы данных"""
    cursor = documents_collection.find({}, {"_id": 1})
    docs = await cursor.to_list(length=100)
    return [doc["_id"] for doc in docs]


@fastapi_app.delete("/documents/{doc_id}")
async def delete_document(doc_id: str):
    if doc_id in save_tasks:
        save_tasks[doc_id].cancel()
        del save_tasks[doc_id]

    await documents_collection.delete_one({"_id": doc_id})
    if doc_id in documents:
        del documents[doc_id]
    return {"status": "deleted"}


async def _save_to_db_delayed(doc_id: str, delay: float = 0.5):
    try:
        await asyncio.sleep(delay)  # Ждем полсекунды
        document = documents.get(doc_id)
        if document:
            await documents_collection.update_one(
                {"_id": doc_id},
                {"$set": {
                    "content": document['content'],
                    "version": document['version'],
                    "history": document['history']
                }},
                upsert=True
            )
    except asyncio.CancelledError:
        # Ожидаемо при debounce/отмене отложенного сохранения: ничего сохранять не нужно.
        pass


async def _get_document(doc_id: str):
    if doc_id not in documents:
        doc = await documents_collection.find_one({"_id": doc_id})
        if doc:
            documents[doc_id] = doc
        else:
            new_doc = {"_id": doc_id, "content": "", "version": 0, "history": []}
            documents[doc_id] = new_doc
            try:
                await documents_collection.insert_one(new_doc)
            except DuplicateKeyError:
                # Документ уже был создан параллельно другим запросом/воркером.
                pass
            except Exception as e:
                print(f"Failed to insert document {doc_id}: {e}")
                raise
    return documents[doc_id]


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
    try:
        doc_id = await redis_manager.remove_user(sid)

        if doc_id:
            users = await redis_manager.get_users(doc_id)
            await sio.emit('users-changed', users, room=doc_id)
            await sio.emit('user-left', sid, room=doc_id)
            await sio.leave_room(sid, doc_id)
            print(f"User {sid} removed from doc {doc_id}")
    except Exception as e:
        print(f"Error in disconnect for {sid}: {e}")

    print(f"Disconnected: {sid}")


@sio.event
async def join(sid, data):
    try:
        doc_id = data['docId']

        existing_users = await redis_manager.get_users(doc_id)
        if any(user['id'] == sid for user in existing_users):
            await sio.enter_room(sid, doc_id)
            await _emit_document_state(doc_id, sid)
            return

        await sio.enter_room(sid, doc_id)

        user_data = {
            'id': sid,
            'name': data['userName'],
            'color': data['color']
        }

        await redis_manager.add_user(doc_id, sid, user_data)

        users = await redis_manager.get_users(doc_id)

        await sio.emit('users-changed', users, room=doc_id)

        await _emit_document_state(doc_id, sid)

        print(f"User {sid} ({data['userName']}) joined doc {doc_id}")

    except Exception as e:
        print(f"Error in join for {sid}: {e}")
        await sio.emit('error', {'message': 'Failed to join document'}, to=sid)


@sio.event
async def leave(sid, data):
    try:
        doc_id = data.get('docId')
        if not doc_id:
            return

        removed_doc_id = await redis_manager.remove_user(sid)

        if removed_doc_id == doc_id:
            users = await redis_manager.get_users(doc_id)
            await sio.emit('users-changed', users, room=doc_id)
            await sio.emit('user-left', sid, room=doc_id)

        await sio.leave_room(sid, doc_id)
        print(f"User {sid} left room {doc_id}")

    except Exception as e:
        print(f"Error in leave for {sid}: {e}")


@sio.on('client-op')
async def client_op(sid, data):
    try:
        await kafka.produce(data['docId'], sid, data)
    except Exception as e:
        print(f"Error producing to Kafka: {e}")
        await sio.emit('error', {'message': 'Failed to process operation'}, to=sid)


@sio.on('cursor-move')
async def cursor_move(sid, data):
    try:
        doc_id = data['docId']
        await sio.emit('remote-cursor', {**data, 'userId': sid}, room=doc_id, skip_sid=sid)
    except Exception as e:
        print(f"Error in cursor-move: {e}")


async def broadcast_edit(doc_id: str, data: IncomingOperation):
    try:
        document = await _get_document(doc_id)
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

        if doc_id in save_tasks:
            save_tasks[doc_id].cancel()

        save_tasks[doc_id] = asyncio.create_task(_save_to_db_delayed(doc_id))

        await sio.emit('server-update', applied, room=doc_id)
    except ValueError as e:
        print(f"Discarding invalid edit for {doc_id}: {e}")
        user_id = data.get('userId')
        if user_id:
            await _emit_document_state(doc_id, user_id)
    except Exception as e:
        print(f"Error in broadcast_edit: {e}")