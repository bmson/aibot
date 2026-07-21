import type { Db, TaskRow } from '@assistant/db';
import { describe, expect, it } from 'vitest';
import { unreadSharedDocumentIntent } from './intent.js';

function makeDb(rows: Array<{ id: string }> = []) {
  const state = { limitCalls: 0 };
  const chain = {
    from() {
      return chain;
    },
    innerJoin() {
      return chain;
    },
    where() {
      return chain;
    },
    limit() {
      state.limitCalls += 1;
      return Promise.resolve(rows);
    },
  };

  const db = {
    select() {
      return chain;
    },
  } as unknown as Db;

  return { db, state };
}

describe('unreadSharedDocumentIntent', () => {
  const task = {
    trust: 'owner',
    conversationId: 'conv-1',
  } as Pick<TaskRow, 'trust' | 'conversationId'>;

  it('only auto-reads a document from the latest user turn', async () => {
    const { db, state } = makeDb();
    const intent = await unreadSharedDocumentIntent(db, task as TaskRow, [
      { role: 'user', content: 'https://docs.google.com/document/d/doc-old-12345/edit' },
      { role: 'assistant', content: 'I can help with that.' },
      { role: 'user', content: 'Please create a new one instead.' },
    ]);

    expect(intent).toBeUndefined();
    expect(state.limitCalls).toBe(0);
  });

  it('returns the latest document URL when it has not been handled yet', async () => {
    const { db } = makeDb();
    const intent = await unreadSharedDocumentIntent(db, task as TaskRow, [
      {
        role: 'user',
        content: 'Please read this: https://docs.google.com/document/d/doc-1234567890/edit',
      },
    ]);

    expect(intent).toEqual({
      toolName: 'docs.get',
      documentId: 'doc-1234567890',
    });
  });

  it('does not re-trigger a document that was already attempted', async () => {
    const { db } = makeDb([{ id: 'tool-call-1' }]);
    const intent = await unreadSharedDocumentIntent(db, task as TaskRow, [
      {
        role: 'user',
        content: 'Please read this: https://docs.google.com/document/d/doc-1234567890/edit',
      },
    ]);

    expect(intent).toBeUndefined();
  });
});
