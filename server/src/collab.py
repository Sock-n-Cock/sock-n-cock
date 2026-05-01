from __future__ import annotations

from typing import Literal, TypedDict


class BaseOperation(TypedDict):
    docId: str
    opId: str
    start: int
    end: int
    text: str


class IncomingOperation(BaseOperation):
    baseVersion: int
    userId: str


class AppliedOperation(IncomingOperation):
    version: int


BoundaryAttachment = Literal["left", "right"]


def transform_boundary(
    offset: int, applied: BaseOperation, attachment: BoundaryAttachment
) -> int:
    """
    Adjusts an operation index offset based on a preceding applied operation.
    Identical logic to TypeScript `transformBoundary` implementation.
    """
    inserted_length = len(applied["text"])
    deleted_length = applied["end"] - applied["start"]

    if offset < applied["start"]:
        return offset

    if offset > applied["end"]:
        return offset + inserted_length - deleted_length

    if deleted_length == 0:
        return offset + inserted_length if attachment == "right" else offset

    if offset == applied["start"]:
        return applied["start"]

    if offset == applied["end"]:
        return applied["start"] + inserted_length

    return (
        applied["start"] + inserted_length
        if attachment == "right"
        else applied["start"]
    )


def transform_operation(
    operation: BaseOperation,
    applied: BaseOperation,
    insert_attachment: BoundaryAttachment = "right",
) -> BaseOperation:
    if operation["start"] == operation["end"]:
        offset = transform_boundary(operation["start"], applied, insert_attachment)
        return {**operation, "start": offset, "end": offset}

    start = transform_boundary(operation["start"], applied, "right")
    end = transform_boundary(operation["end"], applied, "left")
    return {
        **operation,
        "start": start,
        "end": max(start, end),
    }


def rebase_operation(
    operation: IncomingOperation, history: list[AppliedOperation]
) -> IncomingOperation:
    """
    Rebases an incoming operation incrementally against a history log.
    Ensures final execution coordinates align with current document state.
    """
    rebased: IncomingOperation = {**operation}
    for applied in history:
        rebased = {
            **rebased,
            **transform_operation(rebased, applied, "right"),
        }
    return rebased


def apply_operation(content: str, operation: BaseOperation) -> str:
    """Applies a resolved operation mutation to a text snapshot."""
    start = operation["start"]
    end = operation["end"]

    # Strict bounds checking to prevent index corruption during text slicing
    if start < 0 or end < start or end > len(content):
        raise ValueError(
            f"Offsets ({start}, {end}) are outside the current document of length {len(content)}."
        )

    return f"{content[:start]}{operation['text']}{content[end:]}"
