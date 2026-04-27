import socketio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from collab import AppliedOperation, apply_operation, rebase_operation, IncomingOperation
from kafka import KafkaManager
from redis_manager import RedisManager

redis_manager = RedisManager()
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


async def _emit_document_state(doc_id: str, target_sid: str):
    document = await redis_manager.get_document(doc_id)
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
        doc = await redis_manager.get_document(doc_id)
        current_version = doc["version"]
        base_version = int(data['baseVersion'])

        if base_version < 0 or base_version > current_version:
            print(f"Discarding invalid edit for {doc_id}: {base_version} > {current_version}")
            user_id = data.get('userId')
            if user_id:
                await _emit_document_state(doc_id, user_id)
            return

        history = doc["history"]
        rebased = rebase_operation(data, history[base_version:])
        new_content = apply_operation(str(doc["content"]), rebased)
        new_version = current_version + 1

        applied: AppliedOperation = {
            **rebased,
            'version': new_version,
        }

        success = await redis_manager.update_document(
            doc_id, new_content, new_version, applied, current_version
        )
        if not success:
            print(f"Conflict on {doc_id}, resending state")
            user_id = data.get('userId')
            if user_id:
                await _emit_document_state(doc_id, user_id)
            return

        await sio.emit('server-update', applied, room=doc_id)

    except ValueError as e:
        print(f"Discarding invalid edit for {doc_id}: {e}")
        user_id = data.get('userId')
        if user_id:
            await _emit_document_state(doc_id, user_id)
    except Exception as e:
        print(f"Error in broadcast_edit: {e}")
