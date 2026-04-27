import redis.asyncio as redis
import json
from typing import Optional, List

class RedisManager:
    def __init__(self):
        self.redis = redis.Redis(host='localhost', port=6379, decode_responses=True)

    async def add_user(self, doc_id: str, sid: str, user_data: dict):
        await self.redis.hset(f"doc:{doc_id}:users", sid, json.dumps(user_data))
        await self.redis.set(f"sid:{sid}:doc", doc_id)

    async def remove_user(self, sid: str) -> Optional[str]:
        doc_id = await self.redis.get(f"sid:{sid}:doc")
        if not doc_id:
            return None
        await self.redis.hdel(f"doc:{doc_id}:users", sid)
        await self.redis.delete(f"sid:{sid}:doc")
        return doc_id

    async def get_users(self, doc_id: str) -> List[dict]:
        users = await self.redis.hgetall(f"doc:{doc_id}:users")
        return [json.loads(u) for u in users.values()]

    async def get_document(self, doc_id: str) -> dict:
        key = f"doc:{doc_id}:data"
        data = await self.redis.get(key)
        if data is None:
            return {"content": "", "version": 0, "history": []}
        return json.loads(data)

    async def save_document(self, doc_id: str, document: dict):
        key = f"doc:{doc_id}:data"
        await self.redis.set(key, json.dumps(document))

    async def update_document(self, doc_id: str, new_content: str, new_version: int, applied_op: dict, previous_version: int) -> bool:
        key = f"doc:{doc_id}:data"
        async with self.redis.pipeline() as pipe:
            await pipe.watch(key)
            current = await pipe.get(key)
            if current:
                doc = json.loads(current)
                if doc.get("version", 0) != previous_version:
                    await pipe.unwatch()
                    return False
            else:
                doc = {"content": "", "version": 0, "history": []}
                if previous_version != 0:
                    await pipe.unwatch()
                    return False

            doc["content"] = new_content
            doc["version"] = new_version
            doc["history"].append(applied_op)

            pipe.multi()
            await pipe.set(key, json.dumps(doc))
            await pipe.execute()
            return True
