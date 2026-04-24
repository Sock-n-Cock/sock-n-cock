from __future__ import annotations

from typing import Literal, TypedDict


class ClientTextOperation(TypedDict):
    docId: str
    opId: str
    text: str
    start: int
    end: int
    baseVersion: int


class ServerTextOperation(ClientTextOperation):
    userId: str
    version: int


class DocumentRecord(TypedDict):
    content: str
    version: int
    history: list[ServerTextOperation]


TransformSide = Literal["before", "after"]
PositionKind = Literal["cursor", "start", "end"]


def utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _code_unit_offset_to_index(text: str, offset: int) -> int:
    if offset < 0:
        raise ValueError("Offsets must be non-negative.")

    current_offset = 0

    for index, char in enumerate(text):
        if current_offset == offset:
            return index

        current_offset += utf16_length(char)

        if current_offset > offset:
            raise ValueError(f"Offset {offset} points inside a UTF-16 code unit pair.")

    if current_offset == offset:
        return len(text)

    raise ValueError(f"Offset {offset} is outside the current document.")


def apply_text_operation(content: str, operation: ClientTextOperation | ServerTextOperation) -> str:
    start_index = _code_unit_offset_to_index(content, int(operation["start"]))
    end_index = _code_unit_offset_to_index(content, int(operation["end"]))
    return f"{content[:start_index]}{operation['text']}{content[end_index:]}"


def _map_position(
    position: int,
    applied: ClientTextOperation | ServerTextOperation,
    *,
    kind: PositionKind,
    side: TransformSide,
) -> int:
    start = int(applied["start"])
    end = int(applied["end"])
    insert_length = utf16_length(str(applied["text"]))
    delete_length = end - start
    delta = insert_length - delete_length

    if position < start:
        return position

    if position > end:
        return position + delta

    if start == end and position == start:
        return start + insert_length if side == "after" else start

    if position == start:
        return start

    if position == end:
        return start + insert_length

    if kind == "start":
        return start

    if kind == "end":
        return start + insert_length

    return start + insert_length if side == "after" else start


def transform_text_operation(
    operation: ClientTextOperation | ServerTextOperation,
    applied: ClientTextOperation | ServerTextOperation,
    *,
    side: TransformSide,
) -> ClientTextOperation | ServerTextOperation:
    if int(operation["start"]) == int(operation["end"]):
        position = _map_position(
            int(operation["start"]),
            applied,
            kind="cursor",
            side=side,
        )
        return {
            **operation,
            "start": position,
            "end": position,
        }

    start = _map_position(
        int(operation["start"]),
        applied,
        kind="start",
        side=side,
    )
    end = _map_position(
        int(operation["end"]),
        applied,
        kind="end",
        side=side,
    )

    return {
        **operation,
        "start": start,
        "end": max(start, end),
    }


def create_document_record() -> DocumentRecord:
    return {
        "content": "",
        "version": 0,
        "history": [],
    }


def apply_incoming_operation(
    document: DocumentRecord,
    operation: ClientTextOperation,
    *,
    user_id: str,
) -> ServerTextOperation:
    transformed_operation: ClientTextOperation | ServerTextOperation = operation

    for applied_operation in document["history"][int(operation["baseVersion"]):]:
        transformed_operation = transform_text_operation(
            transformed_operation,
            applied_operation,
            side="after",
        )

    document["content"] = apply_text_operation(document["content"], transformed_operation)
    document["version"] += 1

    server_operation: ServerTextOperation = {
        **transformed_operation,
        "userId": user_id,
        "version": document["version"],
    }

    document["history"].append(server_operation)
    return server_operation
