import asyncio
import json
import logging
from contextlib import suppress
from aiokafka import AIOKafkaProducer, AIOKafkaConsumer

KAFKA_BROKER = "localhost:9092"
TOPIC = "code-changes"

logger = logging.getLogger(__name__)


class KafkaManager:
    def __init__(self):
        self.producer = None
        self.consumer = None
        self.consumer_task = None

    async def start(self):
        # The producer publishes editor operations; the consumer replays them back
        # into the server so every client observes the same ordered stream.
        self.producer = AIOKafkaProducer(bootstrap_servers=KAFKA_BROKER)
        await self.producer.start()

        self.consumer = AIOKafkaConsumer(
            TOPIC,
            bootstrap_servers=KAFKA_BROKER,
            group_id="code-editor-group",
            enable_auto_commit=False,
        )
        await self.consumer.start()
        self.consumer_task = asyncio.create_task(self._consume_loop())

    async def stop(self):
        if self.consumer_task is not None:
            self.consumer_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.consumer_task
            self.consumer_task = None

        if self.producer is not None:
            await self.producer.stop()
            self.producer = None

        if self.consumer is not None:
            await self.consumer.stop()
            self.consumer = None

    async def produce(self, doc_id: str, user_id: str, data: dict):
        payload = json.dumps({**data, 'userId': user_id}).encode()
        await self.producer.send(TOPIC, value=payload, key=doc_id.encode())

    async def _commit_offset(self):
        if self.consumer is None:
            return

        await self.consumer.commit()

    async def _handle_message(self, msg, broadcast_edit):
        try:
            if msg.key is None:
                raise ValueError("Kafka message is missing a document key.")

            data = json.loads(msg.value.decode())
            doc_id = msg.key.decode()
            await broadcast_edit(doc_id, data)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "Failed to process Kafka message at partition=%s offset=%s. Skipping it to keep the consumer alive.",
                getattr(msg, 'partition', '?'),
                getattr(msg, 'offset', '?'),
            )
        finally:
            try:
                await self._commit_offset()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Failed to commit Kafka consumer offset.")

    async def _consume_loop(self):
        # Import lazily to avoid a module-level circular import with main.py.
        from main import broadcast_edit

        while self.consumer is not None:
            try:
                async for msg in self.consumer:
                    await self._handle_message(msg, broadcast_edit)
                return
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Kafka consumer loop crashed unexpectedly. Restarting in 1 second.")
                await asyncio.sleep(1)
