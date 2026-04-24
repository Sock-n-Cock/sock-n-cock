import pathlib
import sys
import unittest


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from collab import apply_operation, rebase_operation, transform_operation


class CollaborationTransformTests(unittest.TestCase):
    def test_later_insert_moves_after_earlier_insert(self):
        transformed = transform_operation(
            {"docId": "main-room", "opId": "local", "start": 0, "end": 0, "text": "cat"},
            {"docId": "main-room", "opId": "remote", "start": 0, "end": 0, "text": "dog"},
        )

        self.assertEqual(transformed["start"], 3)
        self.assertEqual(transformed["end"], 3)

    def test_rebase_operation_over_concurrent_insert(self):
        history = [
            {
                "docId": "main-room",
                "opId": "remote",
                "start": 0,
                "end": 0,
                "text": "dog",
                "baseVersion": 0,
                "userId": "peer",
                "version": 1,
            }
        ]
        rebased = rebase_operation(
            {
                "docId": "main-room",
                "opId": "local",
                "start": 0,
                "end": 0,
                "text": "cat",
                "baseVersion": 0,
                "userId": "local",
            },
            history,
        )

        self.assertEqual(rebased["start"], 3)
        self.assertEqual(rebased["end"], 3)
        self.assertEqual(apply_operation("dog", rebased), "dogcat")


if __name__ == "__main__":
    unittest.main()
