from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError

class MongoManager:
    def __init__(self, mongo_url: str = "mongodb://localhost:27017"):
        self.mongo_url = mongo_url
        self.client = None
        self.db = None
        self.collection = None

    async def connect(self):
        """Initializes the database connection pool."""
        self.client = AsyncIOMotorClient(self.mongo_url)
        self.db = self.client.collab_database
        self.collection = self.db.documents

    async def close(self):
        if self.client:
            self.client.close()

    async def get_all_document_ids(self) -> list[str]:
        """Returns a list of all document IDs (capped at 100 for safety)."""
        cursor = self.collection.find({}, {"_id": 1})
        docs = await cursor.to_list(length=100)
        return [doc["_id"] for doc in docs]

    async def delete_document(self, doc_id: str):
        """Delete document by ID."""
        await self.collection.delete_one({"_id": doc_id})

    async def get_document(self, doc_id: str) -> dict | None:
        """Get document by ID."""
        return await self.collection.find_one({"_id": doc_id})

    async def create_document(self, doc_data: dict):
        """
        Creates a new document, gracefully handling race conditions
        where multiple workers might attempt creation simultaneously.
        """
        try:
            await self.collection.insert_one(doc_data)
        except DuplicateKeyError:
            # Document was already created by parallel request/worker. Safe to ignore.
            pass
        except Exception as e:
            print(f"Failed to insert document {doc_data.get('_id')}: {e}")
            raise

    async def update_document_state(self, doc_id: str, content: str, version: int, history: list):
        """Updates document state using upsert behavior for resiliency."""
        await self.collection.update_one(
            {"_id": doc_id},
            {"$set": {
                "content": content,
                "version": version,
                "history": history
            }},
            upsert=True
        )
