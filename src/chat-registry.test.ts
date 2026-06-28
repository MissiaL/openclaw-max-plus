import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetChatRegistryForTest,
  flushChatRegistry,
  listChats,
  markTitleFetched,
  needsTitle,
  removeChat,
  setChatMeta,
  upsertChat,
} from './chat-registry.js';

let tempRoot: string;
let prevStateDir: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'max-registry-'));
  prevStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tempRoot;
  __resetChatRegistryForTest();
});

afterEach(() => {
  __resetChatRegistryForTest();
  if (prevStateDir == null) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = prevStateDir;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('chat-registry', () => {
  it('upserts and lists chats', () => {
    upsertChat('default', { chatId: -100, kind: 'group', seenAt: 1000 });
    upsertChat('default', { chatId: -200, kind: 'channel', seenAt: 2000 });
    const chats = listChats('default').sort((a, b) => a.chatId - b.chatId);
    expect(chats.map((c) => c.chatId)).toEqual([-200, -100]);
    expect(chats.find((c) => c.chatId === -200)?.kind).toBe('channel');
  });

  it('preserves title and addedAt across upserts, updates lastSeenAt', () => {
    upsertChat('default', { chatId: -1, kind: 'group', title: 'Team', seenAt: 1000 });
    const next = upsertChat('default', { chatId: -1, kind: 'group', seenAt: 5000 });
    expect(next.title).toBe('Team');
    expect(next.addedAt).toBe(1000);
    expect(next.lastSeenAt).toBe(5000);
  });

  it('clamps title to 256 chars', () => {
    upsertChat('default', { chatId: -1, kind: 'group', title: 'x'.repeat(1000), seenAt: 1 });
    expect(listChats('default')[0].title).toHaveLength(256);
  });

  it('persists to disk and reloads after cache reset', () => {
    upsertChat('acct', { chatId: -42, kind: 'group', title: 'Ops', seenAt: 1000 });
    flushChatRegistry('acct');
    __resetChatRegistryForTest();
    const chats = listChats('acct');
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ chatId: -42, kind: 'group', title: 'Ops' });
  });

  it('removes chats', () => {
    upsertChat('default', { chatId: -1, kind: 'group', seenAt: 1 });
    removeChat('default', -1);
    expect(listChats('default')).toHaveLength(0);
  });

  it('setChatMeta updates title and kind of an existing chat only', () => {
    upsertChat('default', { chatId: -1, kind: 'group', seenAt: 1 });
    setChatMeta('default', -1, { title: 'Renamed', kind: 'channel' });
    expect(listChats('default')[0]).toMatchObject({ title: 'Renamed', kind: 'channel' });
    setChatMeta('default', -999, { title: 'ghost' }); // unknown → no-op, no throw
    expect(listChats('default')).toHaveLength(1);
  });

  it('negative cache is session-scoped: resets with the in-memory cache', () => {
    upsertChat('default', { chatId: -1, kind: 'group', seenAt: 1 });
    expect(needsTitle('default', -1)).toBe(true);
    markTitleFetched('default', -1);
    expect(needsTitle('default', -1)).toBe(false);
    flushChatRegistry('default');
    __resetChatRegistryForTest(); // simulate gateway restart: negative cache must NOT survive
    expect(needsTitle('default', -1)).toBe(true);
  });

  it('needsTitle is false when a title already exists', () => {
    upsertChat('default', { chatId: -2, kind: 'group', title: 'Has', seenAt: 1 });
    expect(needsTitle('default', -2)).toBe(false);
  });

  it('isolates registries per account', () => {
    upsertChat('a', { chatId: -1, kind: 'group', seenAt: 1 });
    upsertChat('b', { chatId: -2, kind: 'group', seenAt: 1 });
    expect(listChats('a').map((c) => c.chatId)).toEqual([-1]);
    expect(listChats('b').map((c) => c.chatId)).toEqual([-2]);
  });

  it('sanitizes accountId used for the file name', () => {
    upsertChat('../evil/../x', { chatId: -1, kind: 'group', seenAt: 1 });
    flushChatRegistry('../evil/../x');
    // No throw, no traversal: the file lives under the state dir's max/ folder.
    expect(listChats('../evil/../x')).toHaveLength(1);
  });

  it('treats a corrupt file as an empty registry', () => {
    mkdirSync(join(tempRoot, 'max'), { recursive: true });
    writeFileSync(join(tempRoot, 'max', 'chats-default.json'), '{not json', 'utf8');
    __resetChatRegistryForTest();
    expect(listChats('default')).toEqual([]);
  });
});
