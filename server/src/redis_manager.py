import redis.asyncio as redis
import json

class RedisManager:
    """
    Provides fast, distributed caching and session management
    for WebSocket state across multiple application nodes.
    """
    def __init__(self):
        # Uses decode_responses=True to handle strings natively instead of bytes
        self.redis = redis.Redis(host='localhost', port=6379, decode_responses=True)

    async def add_user(self, doc_id: str, sid: str, user_data: dict):
        """Maps a user session ID to a document and stores their metadata in a hash map."""
        await self.redis.hset(f"doc:{doc_id}:users", sid, json.dumps(user_data))
        await self.redis.set(f"sid:{sid}:doc", doc_id)

    async def remove_user(self, sid: str):
        """Clears user session references on disconnect."""
        doc_id = await self.redis.get(f"sid:{sid}:doc")
        if not doc_id:
            return None

        await self.redis.hdel(f"doc:{doc_id}:users", sid)
        await self.redis.delete(f"sid:{sid}:doc")

        return doc_id

    async def get_users(self, doc_id: str):
        users = await self.redis.hgetall(f"doc:{doc_id}:users")
        return [json.loads(u) for u in users.values()]

    async def get_document_state(self, doc_id: str) -> dict | None:
        """Retrieves in-memory document state for immediate OT resolution."""
        data = await self.redis.get(f"doc:{doc_id}:state")
        return json.loads(data) if data else None

    async def set_document_state(self, doc_id: str, state: dict):
        await self.redis.set(f"doc:{doc_id}:state", json.dumps(state))

    async def delete_document_state(self, doc_id: str):
        await self.redis.delete(f"doc:{doc_id}:state")
