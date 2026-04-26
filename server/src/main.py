import socketio
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from collab import AppliedOperation, apply_operation, rebase_operation, IncomingOperation
from kafka import KafkaManager
from redis_manager import RedisManager
from mongo_manager import MongoManager


mongo_manager = MongoManager()
redis_manager = RedisManager()
kafka = KafkaManager()
sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')

@asynccontextmanager
async def lifespan(app: FastAPI):
    await mongo_manager.connect()
    await kafka.start()
    yield
    await kafka.stop()
    await mongo_manager.close()

fastapi_app = FastAPI(lifespan=lifespan)
fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)

documents: dict[str, dict] = {}
save_tasks: dict[str, asyncio.Task] = {}

@fastapi_app.get("/documents")
async def list_documents():
    """Возвращает список всех ID документов из базы данных"""
    return await mongo_manager.get_all_document_ids()


@fastapi_app.delete("/documents/{doc_id}")
async def delete_document(doc_id: str):
    if doc_id in save_tasks:
        save_tasks[doc_id].cancel()
        del save_tasks[doc_id]

    await mongo_manager.delete_document(doc_id)

    if doc_id in documents:
        del documents[doc_id]
    return {"status": "deleted"}


# async def _save_to_db_delayed(doc_id: str, delay: float = 1000):
#     try:
#         await asyncio.sleep(delay)
#         document = documents.get(doc_id)
#         if document:
#             history_to_save = document['history'][-200:] if document.get('history') else []
#
#             await mongo_manager.update_document_state(
#                 doc_id=doc_id,
#                 content=document['content'],
#                 version=document['version'],
#                 history=history_to_save
#             )
#     except asyncio.CancelledError:
#         return
#     except Exception as e:
#         print(f"Error saving to MongoDB: {e}")


async def _save_to_db_delayed(doc_id: str, delay: float = 1.0):
    try:
        await asyncio.sleep(delay)
        document = documents.get(doc_id)
        if document:
            history_to_save = document['history'][-200:] if document.get('history') else []

            await mongo_manager.update_document_state(
                doc_id=doc_id,
                content=document['content'],
                version=document['version'],
                history=history_to_save
            )

            await sio.emit('document-saved', {'docId': doc_id}, room=doc_id)
            print(f"DEBUG: Document {doc_id} actually written to MongoDB")

    except asyncio.CancelledError:
        return
    except Exception as e:
        print(f"Error saving to MongoDB: {e}")


async def _get_document(doc_id: str):
    if doc_id not in documents:
        doc = await mongo_manager.get_document(doc_id)
        if doc:
            documents[doc_id] = doc
        else:
            new_doc = {"_id": doc_id, "content": "", "version": 0, "history": []}
            documents[doc_id] = new_doc
            await mongo_manager.create_document(new_doc)

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

        MAX_HISTORY = 200
        if len(history) > MAX_HISTORY:
            document['history'] = history[-MAX_HISTORY:]

        if doc_id in save_tasks:
            save_tasks[doc_id].cancel()

        save_tasks[doc_id] = asyncio.create_task(_save_to_db_delayed(doc_id, delay=1.0))

        await sio.emit('server-update', applied, room=doc_id)

    except ValueError as e:
        print(f"Discarding invalid edit for {doc_id}: {e}")
        user_id = data.get('userId')
        if user_id:
            await _emit_document_state(doc_id, user_id)
    except Exception as e:
        print(f"Error in broadcast_edit for doc {doc_id}: {e}")




