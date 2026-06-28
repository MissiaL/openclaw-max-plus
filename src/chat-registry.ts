/**
 * Persistent registry of group/channel chats the bot belongs to.
 *
 * MAX deprecated GET /chats (no REST replacement); the API pushes an
 * event-driven model where the bot accumulates chat ids from updates and
 * stores them itself. This module is that store: an in-memory Map mirrored
 * to a per-account JSON file under the OpenClaw state dir. Writes are
 * debounced and atomic (temp file + rename). Best-effort: disk errors never
 * throw to callers — the registry keeps working from memory.
 *
 * Single writer: only the monitor (one gateway process) writes; listGroups in
 * the gateway and in the CLI process only read. Do NOT add a second writer.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';

export interface KnownChat {
  chatId: number;
  kind: 'group' | 'channel';
  title?: string;
  addedAt: number;
  /** Last activity; reserved for a future TTL — written but not read today. */
  lastSeenAt: number;
}

const WRITE_DEBOUNCE_MS = 500;
const TITLE_MAX = 256;

const cache = new Map<string, Map<number, KnownChat>>();
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** In-memory only (NOT persisted): chats whose getChat lookup was attempted this session. */
const titleAttempted = new Map<string, Set<number>>();
/** Resolved once per process so load() and flush() never diverge. */
let stateRoot: string | undefined;
/** Log only the first disk error per session to avoid debounce-flush spam. */
let diskWarned = false;

/** accountId is used as a file name — sanitize defensively (public API is open). */
function accountKey(accountId: string): string {
  return (accountId || 'default').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || 'default';
}

function maxStateRoot(): string {
  return (stateRoot ??= join(resolveStateDir(), 'max'));
}

function fileFor(accountId: string): string {
  return join(maxStateRoot(), `chats-${accountKey(accountId)}.json`);
}

function clampTitle(title: string | undefined): string | undefined {
  return title == null ? title : title.slice(0, TITLE_MAX);
}

function warnDisk(msg: string, err: unknown): void {
  if (diskWarned) return;
  diskWarned = true;
  console.warn(`[max chat-registry] ${msg}: ${String(err)}`);
}

function load(accountId: string): Map<number, KnownChat> {
  const key = accountKey(accountId);
  const cached = cache.get(key);
  if (cached) return cached;

  const map = new Map<number, KnownChat>();
  try {
    const raw = readFileSync(fileFor(accountId), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const entry of parsed as KnownChat[]) {
        if (entry && typeof entry.chatId === 'number') map.set(entry.chatId, entry);
      }
    }
  } catch (err) {
    // ENOENT is normal (no file yet); anything else (corrupt JSON) → warn once.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      warnDisk(`failed to read ${fileFor(accountId)}`, err);
    }
  }
  cache.set(key, map);
  return map;
}

function scheduleWrite(accountId: string): void {
  const key = accountKey(accountId);
  const existing = writeTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    writeTimers.delete(key);
    flush(accountId);
  }, WRITE_DEBOUNCE_MS);
  // Don't keep the process alive solely for a pending registry flush;
  // flushChatRegistry() on shutdown dumps anything still pending.
  if (typeof timer.unref === 'function') timer.unref();
  writeTimers.set(key, timer);
}

function flush(accountId: string): void {
  const map = cache.get(accountKey(accountId));
  if (!map) return;
  try {
    const file = fileFor(accountId);
    mkdirSync(maxStateRoot(), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...map.values()]), 'utf8');
    renameSync(tmp, file); // atomic replace
  } catch (err) {
    warnDisk(`failed to write registry for ${accountId}`, err);
  }
}

export function upsertChat(
  accountId: string,
  input: { chatId: number; kind: 'group' | 'channel'; title?: string; seenAt: number },
): KnownChat {
  const map = load(accountId);
  const existing = map.get(input.chatId);
  const next: KnownChat = {
    chatId: input.chatId,
    kind: input.kind,
    title: clampTitle(input.title) ?? existing?.title,
    addedAt: existing?.addedAt ?? input.seenAt,
    lastSeenAt: input.seenAt,
  };
  map.set(input.chatId, next);
  scheduleWrite(accountId);
  return next;
}

export function setChatMeta(
  accountId: string,
  chatId: number,
  meta: { title?: string; kind?: 'group' | 'channel' },
): void {
  const map = load(accountId);
  const existing = map.get(chatId);
  if (!existing) return;
  if (meta.title != null) existing.title = clampTitle(meta.title);
  if (meta.kind != null) existing.kind = meta.kind;
  scheduleWrite(accountId);
}

export function needsTitle(accountId: string, chatId: number): boolean {
  const existing = load(accountId).get(chatId);
  if (!existing || existing.title) return false;
  return !(titleAttempted.get(accountKey(accountId))?.has(chatId) ?? false);
}

export function markTitleFetched(accountId: string, chatId: number): void {
  const key = accountKey(accountId);
  let set = titleAttempted.get(key);
  if (!set) titleAttempted.set(key, (set = new Set()));
  set.add(chatId);
}

export function removeChat(accountId: string, chatId: number): void {
  const map = load(accountId);
  if (map.delete(chatId)) scheduleWrite(accountId);
}

export function listChats(accountId: string): KnownChat[] {
  return [...load(accountId).values()];
}

/** Force any pending debounced writes to disk now (shutdown / tests). */
export function flushChatRegistry(accountId?: string): void {
  if (accountId != null) {
    const key = accountKey(accountId);
    const timer = writeTimers.get(key);
    if (timer) clearTimeout(timer);
    writeTimers.delete(key);
    flush(accountId);
    return;
  }
  // No-arg: flush every account with a pending write. NOTE: every cache
  // mutation MUST call scheduleWrite, or its pending data is skipped here.
  for (const [key, timer] of writeTimers) {
    clearTimeout(timer);
    flush(key);
  }
  writeTimers.clear();
}

/** Test-only: clear in-memory cache, negative cache, timers and resolved path. */
export function __resetChatRegistryForTest(): void {
  for (const timer of writeTimers.values()) clearTimeout(timer);
  writeTimers.clear();
  cache.clear();
  titleAttempted.clear();
  stateRoot = undefined;
  diskWarned = false;
}
