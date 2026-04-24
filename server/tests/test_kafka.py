import json
import pathlib
import sys
import types
import unittest


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from kafka import KafkaManager


class FakeMessage:
    def __init__(self, *, value: bytes, key: bytes | None, partition: int = 0, offset: int = 0):
        self.value = value
        self.key = key
        self.partition = partition
        self.offset = offset


class FakeConsumer:
    def __init__(self, messages):
        self._messages = iter(messages)
        self.commits = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._messages)
        except StopIteration as exc:
            raise StopAsyncIteration from exc

    async def commit(self):
        self.commits += 1


class KafkaConsumerResilienceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_main = sys.modules.get("main")

    def tearDown(self):
        if self.original_main is None:
            sys.modules.pop("main", None)
        else:
            sys.modules["main"] = self.original_main

    async def test_consumer_skips_failed_operation_and_continues(self):
        processed: list[str] = []

        async def broadcast_edit(doc_id: str, data: dict):
            if data["opId"] == "bad":
                raise ValueError("Offset 3 is outside the current document.")
            processed.append(f"{doc_id}:{data['opId']}")

        fake_main = types.ModuleType("main")
        fake_main.broadcast_edit = broadcast_edit
        sys.modules["main"] = fake_main

        manager = KafkaManager()
        manager.consumer = FakeConsumer([
            FakeMessage(
                value=json.dumps({"opId": "bad"}).encode(),
                key=b"main-room",
                offset=10,
            ),
            FakeMessage(
                value=json.dumps({"opId": "good"}).encode(),
                key=b"main-room",
                offset=11,
            ),
        ])

        await manager._consume_loop()

        self.assertEqual(processed, ["main-room:good"])
        self.assertEqual(manager.consumer.commits, 2)

    async def test_consumer_skips_malformed_payload_and_continues(self):
        processed: list[str] = []

        async def broadcast_edit(doc_id: str, data: dict):
            processed.append(f"{doc_id}:{data['opId']}")

        fake_main = types.ModuleType("main")
        fake_main.broadcast_edit = broadcast_edit
        sys.modules["main"] = fake_main

        manager = KafkaManager()
        manager.consumer = FakeConsumer([
            FakeMessage(value=b"{broken-json", key=b"main-room", offset=20),
            FakeMessage(
                value=json.dumps({"opId": "good"}).encode(),
                key=b"main-room",
                offset=21,
            ),
        ])

        await manager._consume_loop()

        self.assertEqual(processed, ["main-room:good"])
        self.assertEqual(manager.consumer.commits, 2)


if __name__ == "__main__":
    unittest.main()
