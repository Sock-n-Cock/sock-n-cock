import type { PendingClientOp, ServerOp, ClientOp } from './types';

type BoundaryAttachment = 'left' | 'right';

function transformBoundary(offset: number, applied: ClientOp, attachment: BoundaryAttachment): number {
  const insertedLength = applied.text.length;
  const deletedLength = applied.end - applied.start;

  if (offset < applied.start) {
    return offset;
  }

  if (offset > applied.end) {
    return offset + insertedLength - deletedLength;
  }

  if (deletedLength === 0) {
    return attachment === 'right' ? offset + insertedLength : offset;
  }

  if (offset === applied.start) {
    return applied.start;
  }

  if (offset === applied.end) {
    return applied.start + insertedLength;
  }

  return attachment === 'right' ? applied.start + insertedLength : applied.start;
}

export function transformOperation<T extends ClientOp>(operation: T, applied: ClientOp, insertAttachment: BoundaryAttachment = 'right'): T {
  if (operation.start === operation.end) {
    const offset = transformBoundary(operation.start, applied, insertAttachment);
    return { ...operation, start: offset, end: offset };
  }

  const start = transformBoundary(operation.start, applied, 'right');
  const end = transformBoundary(operation.end, applied, 'left');

  return {
    ...operation,
    start,
    end: Math.max(start, end),
  };
}

export function rebasePendingOperations(pending: PendingClientOp[], remote: ServerOp): {
  pending: PendingClientOp[];
  remote: ServerOp;
} {
  let transformedRemote = { ...remote };

  const rebasedPending = pending.map(op => {
    const rebasedOp = transformOperation(op, transformedRemote, 'right');
    transformedRemote = transformOperation(transformedRemote, op, 'left');
    return rebasedOp;
  });

  return {
    pending: rebasedPending,
    remote: transformedRemote,
  };
}
