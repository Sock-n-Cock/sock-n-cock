import type { PendingClientOp, ServerOp, ClientOp } from './types';

// Defines how to resolve index conflicts when operations happen at the exact same offset
type BoundaryAttachment = 'left' | 'right';

/**
 * Adjusts a single positional index (offset) based on a previously applied operation.
 */
function transformBoundary(offset: number, applied: ClientOp, attachment: BoundaryAttachment): number {
  const insertedLength = applied.text.length;
  const deletedLength = applied.end - applied.start;

  // Offset is before the applied change; no shift required
  if (offset < applied.start) {
    return offset;
  }

  // Offset is after the applied change; shift by the net character delta
  if (offset > applied.end) {
    return offset + insertedLength - deletedLength;
  }

  // Offset falls exactly on an insertion
  if (deletedLength === 0) {
    return attachment === 'right' ? offset + insertedLength : offset;
  }

  // Offset falls at the boundaries of a deletion
  if (offset === applied.start) {
    return applied.start;
  }

  if (offset === applied.end) {
    return applied.start + insertedLength;
  }

  // Offset is inside a deleted region
  return attachment === 'right' ? applied.start + insertedLength : applied.start;
}

/**
 * Transforms an operation against a previously applied operation using Operational Transformation (OT).
 */
export function transformOperation<T extends ClientOp>(operation: T, applied: ClientOp, insertAttachment: BoundaryAttachment = 'right'): T {
  // Handle insertions
  if (operation.start === operation.end) {
    const offset = transformBoundary(operation.start, applied, insertAttachment);
    return { ...operation, start: offset, end: offset };
  }

  // Handle deletions and replacements
  const start = transformBoundary(operation.start, applied, 'right');
  const end = transformBoundary(operation.end, applied, 'left');

  return {
    ...operation,
    start,
    end: Math.max(start, end),
  };
}

/**
 * Rebase a queue of pending local operations against an incoming remote operation.
 * Ensures local changes remain valid after remote changes are applied.
 */
export function rebasePendingOperations(pending: PendingClientOp[], remote: ServerOp): {
  pending: PendingClientOp[];
  remote: ServerOp;
} {
  let transformedRemote = { ...remote };

  const rebasedPending = pending.map(op => {
    // Shift local pending operation against the remote one
    const rebasedOp = transformOperation(op, transformedRemote, 'right');
    // Shift the remote operation against the pending one for the next iteration
    transformedRemote = transformOperation(transformedRemote, op, 'left');
    return rebasedOp;
  });

  return {
    pending: rebasedPending,
    remote: transformedRemote,
  };
}