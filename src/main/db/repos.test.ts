import { describe, expect, it } from 'vitest';
import type { Db } from './open.js';
import * as repos from './repos.js';

function openFakeDb(): { db: Db; state: { body: string; editedAt: number | null; deletedAt: number | null }; sql: string[] } {
  const state = { body: 'first draft', editedAt: null as number | null, deletedAt: null as number | null };
  const sql: string[] = [];
  const db = {
    prepare(statement: string) {
      sql.push(statement);
      return {
        run(...args: unknown[]) {
          if (statement.startsWith('UPDATE room_messages SET body=')) {
            if (state.deletedAt !== null) return { changes: 0 };
            state.body = String(args[0]);
            state.editedAt = Number(args[1]);
            return { changes: 1 };
          }
          if (statement.startsWith('UPDATE room_messages SET deleted_at=')) {
            if (state.deletedAt !== null) return { changes: 0 };
            state.deletedAt = Number(args[0]);
            return { changes: 1 };
          }
          throw new Error(`Unexpected SQL: ${statement}`);
        },
      };
    },
  } as unknown as Db;
  return { db, state, sql };
}

describe('room message repositories', () => {
  it('prevents edits from changing deleted room messages', () => {
    const { db, state, sql } = openFakeDb();
    const msgId = '33333333-3333-4333-8333-333333333333';

    expect(repos.editRoomMessage(db, msgId, 'second draft', 200)).toBe(true);
    expect(repos.deleteRoomMessage(db, msgId, 300)).toBe(true);
    expect(repos.editRoomMessage(db, msgId, 'late edit', 400)).toBe(false);

    expect(state).toEqual({ body: 'second draft', editedAt: 200, deletedAt: 300 });
    expect(sql).toEqual([
      'UPDATE room_messages SET body=?, edited_at=? WHERE id=? AND deleted_at IS NULL',
      'UPDATE room_messages SET deleted_at=? WHERE id=? AND deleted_at IS NULL',
      'UPDATE room_messages SET body=?, edited_at=? WHERE id=? AND deleted_at IS NULL',
    ]);
  });
});