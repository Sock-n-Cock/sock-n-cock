import unittest

from operations import (
    ClientTextOperation,
    ServerTextOperation,
    apply_incoming_operation,
    apply_text_operation,
    create_document_record,
    transform_text_operation,
)


class SimulatedClient:
    def __init__(self, client_id: str):
        self.client_id = client_id
        self.content = ""
        self.server_version = 0
        self.pending: list[ClientTextOperation] = []
        self.next_op_id = 0

    def local_insert(self, text: str, start: int) -> ClientTextOperation:
        operation: ClientTextOperation = {
            "docId": "main-room",
            "opId": f"{self.client_id}-{self.next_op_id}",
            "text": text,
            "start": start,
            "end": start,
            "baseVersion": self.server_version + len(self.pending),
        }
        self.next_op_id += 1
        self.pending.append(operation)
        self.content = apply_text_operation(self.content, operation)
        return operation

    def receive_server_operation(self, operation: ServerTextOperation):
        if operation["version"] <= self.server_version:
            return

        if operation["userId"] == self.client_id:
            self.pending = [
                pending_operation
                for pending_operation in self.pending
                if pending_operation["opId"] != operation["opId"]
            ]
            self.server_version = operation["version"]
            return

        rebased_remote_operation = operation
        for pending_operation in self.pending:
            rebased_remote_operation = transform_text_operation(
                rebased_remote_operation,
                pending_operation,
                side="before",
            )

        self.content = apply_text_operation(self.content, rebased_remote_operation)
        self.pending = [
            transform_text_operation(
                pending_operation,
                operation,
                side="after",
            )
            for pending_operation in self.pending
        ]
        self.server_version = operation["version"]


class OperationSyncTests(unittest.TestCase):
    def test_server_rebases_concurrent_inserts(self):
        document = create_document_record()

        first_operation = apply_incoming_operation(
            document,
            {
                "docId": "main-room",
                "opId": "a-0",
                "text": "cat",
                "start": 0,
                "end": 0,
                "baseVersion": 0,
            },
            user_id="user-a",
        )
        second_operation = apply_incoming_operation(
            document,
            {
                "docId": "main-room",
                "opId": "b-0",
                "text": "dog",
                "start": 0,
                "end": 0,
                "baseVersion": 0,
            },
            user_id="user-b",
        )

        self.assertEqual(first_operation["version"], 1)
        self.assertEqual(second_operation["version"], 2)
        self.assertEqual(second_operation["start"], 3)
        self.assertEqual(second_operation["end"], 3)
        self.assertEqual(document["content"], "catdog")

    def test_clients_converge_when_one_side_receives_updates_late(self):
        document = create_document_record()
        fast_client = SimulatedClient("user-a")
        slow_client = SimulatedClient("user-b")

        fast_local_operation = fast_client.local_insert("cat", 0)
        server_fast_operation = apply_incoming_operation(
            document,
            fast_local_operation,
            user_id=fast_client.client_id,
        )

        fast_client.receive_server_operation(server_fast_operation)

        slow_local_operation = slow_client.local_insert("dog", 0)
        server_slow_operation = apply_incoming_operation(
            document,
            slow_local_operation,
            user_id=slow_client.client_id,
        )

        fast_client.receive_server_operation(server_slow_operation)
        slow_client.receive_server_operation(server_fast_operation)
        slow_client.receive_server_operation(server_slow_operation)

        self.assertEqual(document["content"], "catdog")
        self.assertEqual(fast_client.content, "catdog")
        self.assertEqual(slow_client.content, "catdog")
        self.assertEqual(fast_client.pending, [])
        self.assertEqual(slow_client.pending, [])


if __name__ == "__main__":
    unittest.main()
