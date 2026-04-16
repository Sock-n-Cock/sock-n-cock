import asyncio
import json
from aiokafka import AIOKafkaProducer, AIOKafkaConsumer

KAFKA_BROKER = "localhost:9092"
TOPIC = "code-changes"

class KafkaManager:
    def __init__(self):
        self.producer = None
        self.consumer = None

    async def start(self):
        self.producer = AIOKafkaProducer(bootstrap_servers=KAFKA_BROKER)
        await self.producer.start()

        self.consumer = AIOKafkaConsumer(
            TOPIC,
            bootstrap_servers=KAFKA_BROKER,
            group_id="code-editor-group"
        )
        await self.consumer.start()
        asyncio.create_task(self._consume_loop())

    async def stop(self):
        await self.producer.stop()
        await self.consumer.stop()

    async def produce(self, doc_id: str, user_id: str, data: dict):
        payload = json.dumps({**data, 'userId': user_id}).encode()
        await self.producer.send(TOPIC, value=payload, key=doc_id.encode())

    async def _consume_loop(self):
        from main import broadcast_edit
        async for msg in self.consumer:
            data = json.loads(msg.value.decode())
            doc_id = msg.key.decode()
            await broadcast_edit(doc_id, data)