export type TextOperationShape = {
  start: number;
  end: number;
  text: string;
};

export type LocalTextOperation = TextOperationShape & {
  docId: string;
  opId: string;
  baseVersion: number;
};

export type ServerTextOperation = LocalTextOperation & {
  userId: string;
  version: number;
};

type TransformSide = 'before' | 'after';
type PositionKind = 'cursor' | 'start' | 'end';

function mapPosition(
  position: number,
  applied: TextOperationShape,
  kind: PositionKind,
  side: TransformSide,
) {
  const insertLength = applied.text.length;
  const deleteLength = applied.end - applied.start;
  const delta = insertLength - deleteLength;

  if (position < applied.start) return position;
  if (position > applied.end) return position + delta;

  if (applied.start === applied.end && position === applied.start) {
    return side === 'after' ? applied.start + insertLength : applied.start;
  }

  if (position === applied.start) return applied.start;
  if (position === applied.end) return applied.start + insertLength;

  if (kind === 'start') return applied.start;
  if (kind === 'end') return applied.start + insertLength;

  return side === 'after' ? applied.start + insertLength : applied.start;
}

export function transformTextOperation<T extends TextOperationShape>(
  operation: T,
  applied: TextOperationShape,
  side: TransformSide,
): T {
  if (operation.start === operation.end) {
    const position = mapPosition(operation.start, applied, 'cursor', side);
    return {
      ...operation,
      start: position,
      end: position,
    };
  }

  const start = mapPosition(operation.start, applied, 'start', side);
  const end = mapPosition(operation.end, applied, 'end', side);

  return {
    ...operation,
    start,
    end: Math.max(start, end),
  };
}
