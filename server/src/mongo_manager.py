from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError

class MongoManager:
    def __init__(self, mongo_url: str = "mongodb://localhost:27017"):
        self.mongo_url = mongo_url
        self.client = None
        self.db = None
        self.collection = None

    async def connect(self):
        """Инициализирует подключение к базе данных."""
        self.client = AsyncIOMotorClient(self.mongo_url)
        self.db = self.client.collab_database
        self.collection = self.db.documents

    async def close(self):
        """Закрывает подключение к базе данных."""
        if self.client:
            self.client.close()

    async def get_all_document_ids(self) -> list[str]:
        """Возвращает список ID всех документов (до 100 штук)."""
        cursor = self.collection.find({}, {"_id": 1})
        docs = await cursor.to_list(length=100)
        return [doc["_id"] for doc in docs]

    async def delete_document(self, doc_id: str):
        """Удаляет документ по его ID."""
        await self.collection.delete_one({"_id": doc_id})

    async def get_document(self, doc_id: str) -> dict | None:
        """Получает документ из БД по его ID."""
        return await self.collection.find_one({"_id": doc_id})

    async def create_document(self, doc_data: dict):
        """Создает новый документ, игнорируя ошибку дубликата (если он уже создан)."""
        try:
            await self.collection.insert_one(doc_data)
        except DuplicateKeyError:
            # Документ уже был создан параллельно другим запросом/воркером.
            pass
        except Exception as e:
            print(f"Failed to insert document {doc_data.get('_id')}: {e}")
            raise

    async def update_document_state(self, doc_id: str, content: str, version: int, history: list):
        """Обновляет состояние документа (upsert)."""
        await self.collection.update_one(
            {"_id": doc_id},
            {"$set": {
                "content": content,
                "version": version,
                "history": history
            }},
            upsert=True
        )