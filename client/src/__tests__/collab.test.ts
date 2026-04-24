import { describe, expect, it } from 'vitest';

import { rebasePendingOperations, transformOperation } from '../collab';
import type { PendingClientOp, ServerOp } from '../types';

describe('collaboration transforms', () => {
  it('places a later insert after an earlier insert at the same offset', () => {
    const transformed = transformOperation(
      { docId: 'main-room', opId: 'local', start: 0, end: 0, text: 'cat' },
      { docId: 'main-room', opId: 'remote', start: 0, end: 0, text: 'dog' }
    );

    expect(transformed.start).toBe(3);
    expect(transformed.end).toBe(3);
  });

  it('keeps a delete range stable when another user inserts at its trailing edge', () => {
    const transformed = transformOperation(
      { docId: 'main-room', opId: 'delete', start: 1, end: 2, text: '' },
      { docId: 'main-room', opId: 'insert', start: 2, end: 2, text: 'X' }
    );

    expect(transformed.start).toBe(1);
    expect(transformed.end).toBe(2);
  });

  it('rebases pending local edits and transforms the remote insert for the optimistic document', () => {
    const pending: PendingClientOp[] = [
      { docId: 'main-room', opId: 'local', start: 0, end: 0, text: 'cat', sent: true }
    ];
    const remote: ServerOp = {
      docId: 'main-room',
      opId: 'remote',
      start: 0,
      end: 0,
      text: 'dog',
      baseVersion: 0,
      userId: 'peer',
      version: 1,
    };

    const rebased = rebasePendingOperations(pending, remote);

    expect(rebased.pending[0].start).toBe(3);
    expect(rebased.pending[0].end).toBe(3);
    expect(rebased.remote.start).toBe(0);
    expect(rebased.remote.end).toBe(0);
  });
});
