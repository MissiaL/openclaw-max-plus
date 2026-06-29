/**
 * Tests for MAX monitor (interface verification)
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedMaxAccount } from './accounts.js';
import type { MaxApi, MaxChat, MaxMessage, MaxUpdate } from './api.js';
import {
  __resetChatRegistryForTest,
  flushChatRegistry,
  listChats,
  upsertChat,
} from './chat-registry.js';
import {
  dispatchUpdate,
  processIncomingMessage,
  recordInboundChat,
  startMaxPolling,
} from './monitor.js';
import { setMaxRuntime } from './runtime.js';

describe('MAX Monitor', () => {
  describe('startMaxPolling', () => {
    it('should be a function', () => {
      expect(typeof startMaxPolling).toBe('function');
    });

    it('should accept correct parameters', () => {
      // Interface test - verify function signature
      expect(startMaxPolling.length).toBe(1); // Single options object
    });
  });

  // Full integration tests for monitor would require:
  // - Mock PluginRuntime
  // - Mock MaxApi.getUpdates with long-polling simulation
  // - Mock inbound dispatch pipeline
  // These are better suited for E2E tests rather than unit tests.

  describe('slash command authorization', () => {
    // MAX delivers slash commands (/new, /status, …) as plain message_created
    // updates — identical to ordinary text. The core only executes a text-slash
    // command turn when CommandTurn.authorized === true; passing undefined
    // degrades to false in the core and the command is silently dropped.
    // A sender that reaches this point has already cleared every DM/group
    // allowlist gate, so the command turn must be marked authorized.
    function installRuntimeSpy() {
      const finalizeInboundContext = vi.fn((ctx: Record<string, unknown>) => ctx);
      setMaxRuntime({
        channel: {
          media: { fetchRemoteMedia: vi.fn(), saveMediaBuffer: vi.fn() },
          pairing: { readAllowFromStore: vi.fn(async () => [] as string[]) },
          routing: {
            resolveAgentRoute: vi.fn(() => ({
              agentId: 'agent',
              accountId: 'default',
              sessionKey: 'sess',
              mainSessionKey: 'sess',
            })),
          },
          session: {
            resolveStorePath: vi.fn(() => 'store'),
            readSessionUpdatedAt: vi.fn(() => undefined),
            recordSessionMetaFromInbound: vi.fn(async () => undefined),
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(() => ({})),
            formatAgentEnvelope: vi.fn(() => 'body'),
            finalizeInboundContext,
            dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => undefined),
          },
          text: {},
          media2: {},
        },
      } as never);
      return finalizeInboundContext;
    }

    const account = {
      accountId: 'default',
      token: 'tok',
      config: { dmPolicy: 'open', streamMode: 'off' },
    } as unknown as ResolvedMaxAccount;

    const api = {
      sendAction: vi.fn(async () => undefined),
    } as unknown as MaxApi;

    function dmMessage(text: string): MaxMessage {
      return {
        sender: { user_id: 44305013, first_name: 'P', is_bot: false },
        recipient: { chat_id: 291964873, chat_type: 'dialog' },
        timestamp: Date.now(),
        body: { mid: 'mid.test', text },
      } as unknown as MaxMessage;
    }

    it('marks a slash command turn as authorized', async () => {
      const finalizeInboundContext = installRuntimeSpy();
      await processIncomingMessage(dmMessage('/new'), 'ru', {
        api,
        account,
        config: {} as never,
        abortSignal: new AbortController().signal,
      });
      expect(finalizeInboundContext).toHaveBeenCalledTimes(1);
      const ctx = finalizeInboundContext.mock.calls[0][0] as {
        CommandSource?: string;
        CommandTurn?: { kind?: string; authorized?: unknown };
      };
      expect(ctx.CommandSource).toBe('text');
      expect(ctx.CommandTurn?.kind).toBe('text-slash');
      expect(ctx.CommandTurn?.authorized).toBe(true);
    });

    it('does not attach a command turn to ordinary text', async () => {
      const finalizeInboundContext = installRuntimeSpy();
      await processIncomingMessage(dmMessage('привет'), 'ru', {
        api,
        account,
        config: {} as never,
        abortSignal: new AbortController().signal,
      });
      const ctx = finalizeInboundContext.mock.calls[0][0] as { CommandTurn?: unknown };
      expect(ctx.CommandTurn).toBeUndefined();
    });

    it('acks a callback and routes the reply to the real chat_id (not the user_id)', async () => {
      const finalizeInboundContext = installRuntimeSpy();
      const answerCallback = vi.fn(async () => ({ success: true }));
      const apiWithCb = {
        sendAction: vi.fn(async () => undefined),
        answerCallback,
      } as unknown as MaxApi;

      // Real MAX shape: the original message (carrying recipient.chat_id) is a
      // sibling of `callback` on the update — NOT nested inside `callback`.
      const update = {
        update_type: 'message_callback',
        timestamp: Date.now(),
        callback: {
          callback_id: 'cb-xyz',
          payload: 'do_it',
          user: { user_id: 44305013, first_name: 'P', is_bot: false },
        },
        message: {
          recipient: { chat_id: 291964873, chat_type: 'dialog', user_id: 44305013 },
          timestamp: Date.now(),
          body: { mid: 'm0' },
        },
      } as unknown as MaxUpdate;

      await dispatchUpdate(update, {
        api: apiWithCb,
        account,
        config: {} as never,
        abortSignal: new AbortController().signal,
      });

      // Spinner-clearing ack fired with the callback id …
      expect(answerCallback).toHaveBeenCalledWith('cb-xyz', expect.anything());
      // … the payload was dispatched to the agent …
      expect(finalizeInboundContext).toHaveBeenCalledTimes(1);
      // … and the reply targets the real DM chat (291964873), not the user_id
      // (44305013), which would 404 on POST /messages.
      const ctx = finalizeInboundContext.mock.calls[0][0] as { To?: string };
      expect(ctx.To).toBe('max:291964873');
    });

    it('surfaces a forwarded message: origin author + the forwarded text', async () => {
      const finalizeInboundContext = installRuntimeSpy();
      // Real MAX shape: body.text is empty; the forwarded text + origin live in link.
      const forwarded = {
        sender: { user_id: 44305013, first_name: 'P', is_bot: false },
        recipient: { chat_id: 291964873, chat_type: 'dialog' },
        timestamp: Date.now(),
        link: {
          type: 'forward',
          sender: { user_id: 55, first_name: 'Alice', is_bot: false },
          chat_id: 999,
          message: { mid: 'orig', text: 'привет из другого чата' },
        },
        body: { mid: 'mid.fwd', text: '' },
      } as unknown as MaxMessage;

      await processIncomingMessage(forwarded, 'ru', {
        api,
        account,
        config: {} as never,
        abortSignal: new AbortController().signal,
      });

      // Must not be dropped as "empty", and must carry both attribution and text.
      expect(finalizeInboundContext).toHaveBeenCalledTimes(1);
      const ctx = finalizeInboundContext.mock.calls[0][0] as { BodyForAgent?: string };
      expect(ctx.BodyForAgent).toContain('[Forwarded from Alice]');
      expect(ctx.BodyForAgent).toContain('привет из другого чата');
    });

    it('labels a channel-origin forward with the registry title when known', async () => {
      const finalizeInboundContext = installRuntimeSpy();
      const prev = process.env.OPENCLAW_STATE_DIR;
      const dir = mkdtempSync(join(tmpdir(), 'max-fwd-'));
      process.env.OPENCLAW_STATE_DIR = dir;
      __resetChatRegistryForTest();
      try {
        upsertChat('default', {
          chatId: -100,
          kind: 'channel',
          title: 'Мой Канал',
          seenAt: Date.now(),
        });
        // Channel-origin forward: no link.sender, only link.chat_id.
        const fwd = {
          sender: { user_id: 44305013, first_name: 'P', is_bot: false },
          recipient: { chat_id: 291964873, chat_type: 'dialog' },
          timestamp: Date.now(),
          link: { type: 'forward', chat_id: -100, message: { mid: 'o', text: 'channel post' } },
          body: { mid: 'mid.fwd2', text: '' },
        } as unknown as MaxMessage;

        await processIncomingMessage(fwd, 'ru', {
          api,
          account,
          config: {} as never,
          abortSignal: new AbortController().signal,
        });

        const ctx = finalizeInboundContext.mock.calls[0][0] as { BodyForAgent?: string };
        expect(ctx.BodyForAgent).toContain('[Forwarded from Мой Канал]');
        expect(ctx.BodyForAgent).toContain('channel post');
      } finally {
        __resetChatRegistryForTest();
        if (prev == null) delete process.env.OPENCLAW_STATE_DIR;
        else process.env.OPENCLAW_STATE_DIR = prev;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('chat registry population', () => {
    let tempRoot: string;
    let prevStateDir: string | undefined;

    beforeEach(() => {
      tempRoot = mkdtempSync(join(tmpdir(), 'max-monitor-'));
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

    const regAccount = {
      accountId: 'default',
      token: 'tok',
      config: {},
    } as unknown as ResolvedMaxAccount;

    const chat = (over: Partial<MaxChat>): MaxChat =>
      ({ chat_id: -1, type: 'chat', status: 'active', ...over }) as MaxChat;

    function makeOpts(getChat: ReturnType<typeof vi.fn>) {
      return {
        api: { getChat } as unknown as MaxApi,
        account: regAccount,
        config: {} as never,
        abortSignal: new AbortController().signal,
      };
    }

    it('bot_added records a group and fetches title + kind via getChat', async () => {
      const getChat = vi.fn(async () => chat({ chat_id: -100, type: 'chat', title: 'Team Chat' }));
      await dispatchUpdate(
        {
          update_type: 'bot_added',
          timestamp: 1000,
          chat_id: -100,
          is_channel: false,
        } as MaxUpdate,
        makeOpts(getChat),
      );
      expect(getChat).toHaveBeenCalledWith(-100);
      expect(listChats('default')[0]).toMatchObject({
        chatId: -100,
        kind: 'group',
        title: 'Team Chat',
      });
    });

    it('bot_added with is_channel records a channel', async () => {
      const getChat = vi.fn(async () => chat({ chat_id: -200, type: 'channel', title: 'News' }));
      await dispatchUpdate(
        { update_type: 'bot_added', timestamp: 1000, chat_id: -200, is_channel: true } as MaxUpdate,
        makeOpts(getChat),
      );
      expect(listChats('default')[0].kind).toBe('channel');
    });

    it('bot_added survives a getChat failure (chat saved without title)', async () => {
      const getChat = vi.fn(async () => {
        throw new Error('boom');
      });
      await dispatchUpdate(
        {
          update_type: 'bot_added',
          timestamp: 1000,
          chat_id: -100,
          is_channel: false,
        } as MaxUpdate,
        makeOpts(getChat),
      );
      expect(listChats('default')).toHaveLength(1);
      expect(listChats('default')[0].title).toBeUndefined();
    });

    it('bot_removed deletes the chat', async () => {
      const getChat = vi.fn(async () => chat({ title: 'X' }));
      await dispatchUpdate(
        { update_type: 'bot_added', timestamp: 1, chat_id: -1, is_channel: false } as MaxUpdate,
        makeOpts(getChat),
      );
      await dispatchUpdate(
        { update_type: 'bot_removed', timestamp: 2, chat_id: -1, is_channel: false } as MaxUpdate,
        makeOpts(getChat),
      );
      expect(listChats('default')).toHaveLength(0);
    });

    it('chat_title_changed updates the title for free', async () => {
      const getChat = vi.fn(async () => chat({ title: 'Old' }));
      await dispatchUpdate(
        { update_type: 'bot_added', timestamp: 1, chat_id: -1, is_channel: false } as MaxUpdate,
        makeOpts(getChat),
      );
      await dispatchUpdate(
        {
          update_type: 'chat_title_changed',
          timestamp: 2,
          chat_id: -1,
          title: 'New Name',
        } as MaxUpdate,
        makeOpts(getChat),
      );
      expect(listChats('default')[0].title).toBe('New Name');
    });

    it('recordInboundChat upserts group/channel chats, ignores dialogs', () => {
      const getChat = vi.fn(async () => chat({ title: 'G' }));
      const opts = makeOpts(getChat);
      recordInboundChat(
        { recipient: { chat_id: -50, chat_type: 'chat' }, timestamp: 9 } as unknown as MaxMessage,
        opts,
      );
      recordInboundChat(
        { recipient: { chat_id: 777, chat_type: 'dialog' }, timestamp: 9 } as unknown as MaxMessage,
        opts,
      );
      expect(listChats('default').map((c) => c.chatId)).toEqual([-50]);
    });

    it('deduplicates concurrent getChat for the same chat (one request)', () => {
      const getChat = vi.fn(() => new Promise<MaxChat>(() => {})); // never resolves
      const opts = makeOpts(getChat as unknown as ReturnType<typeof vi.fn>);
      const msg = {
        recipient: { chat_id: -50, chat_type: 'chat' },
        timestamp: 1,
      } as unknown as MaxMessage;
      recordInboundChat(msg, opts);
      recordInboundChat(msg, opts);
      expect(getChat).toHaveBeenCalledTimes(1); // markTitleFetched (sync, before await) dedupes
    });

    it('seeds the registry from config.groups, skipping wildcard and non-numeric keys', async () => {
      const seeded = {
        accountId: 'default',
        token: 'tok',
        config: { groups: { '-100': {}, '*': {}, abc: {} } },
      } as unknown as ResolvedMaxAccount;
      const getChat = vi.fn(async () => chat({ title: 'X' }));
      const ctrl = new AbortController();
      ctrl.abort(); // loop exits immediately; seed runs synchronously at start
      await startMaxPolling({
        api: makeOpts(getChat).api,
        account: seeded,
        config: {} as never,
        abortSignal: ctrl.signal,
      });
      expect(listChats('default').map((c) => c.chatId)).toEqual([-100]);
    });

    it('persists end-to-end from dispatchUpdate through flush to disk', async () => {
      const getChat = vi.fn(async () => chat({ chat_id: -100, title: 'Team' }));
      await dispatchUpdate(
        { update_type: 'bot_added', timestamp: 1, chat_id: -100, is_channel: false } as MaxUpdate,
        makeOpts(getChat),
      );
      flushChatRegistry('default');
      const onDisk = JSON.parse(readFileSync(join(tempRoot, 'max', 'chats-default.json'), 'utf8'));
      expect(onDisk).toEqual([
        expect.objectContaining({ chatId: -100, kind: 'group', title: 'Team' }),
      ]);
    });
  });

  describe('group conversation label', () => {
    let tempRoot: string;
    let prevStateDir: string | undefined;

    beforeEach(() => {
      tempRoot = mkdtempSync(join(tmpdir(), 'max-label-'));
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

    function installRuntimeSpy() {
      const finalizeInboundContext = vi.fn((ctx: Record<string, unknown>) => ctx);
      setMaxRuntime({
        channel: {
          media: { fetchRemoteMedia: vi.fn(), saveMediaBuffer: vi.fn() },
          pairing: { readAllowFromStore: vi.fn(async () => [] as string[]) },
          routing: {
            resolveAgentRoute: vi.fn(() => ({
              agentId: 'agent',
              accountId: 'default',
              sessionKey: 'sess',
              mainSessionKey: 'sess',
            })),
          },
          session: {
            resolveStorePath: vi.fn(() => 'store'),
            readSessionUpdatedAt: vi.fn(() => undefined),
            recordSessionMetaFromInbound: vi.fn(async () => undefined),
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(() => ({})),
            formatAgentEnvelope: vi.fn(() => 'body'),
            finalizeInboundContext,
            dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => undefined),
          },
          text: {},
          media2: {},
        },
      } as never);
      return finalizeInboundContext;
    }

    const account = {
      accountId: 'default',
      token: 'tok',
      config: { groups: { '*': { requireMention: false } }, streamMode: 'off' },
    } as unknown as ResolvedMaxAccount;

    const api = { sendAction: vi.fn(async () => undefined) } as unknown as MaxApi;

    const groupMessage = (): MaxMessage =>
      ({
        sender: { user_id: 123, first_name: 'U', is_bot: false },
        recipient: { chat_id: -100, chat_type: 'chat' },
        timestamp: 1,
        body: { mid: 'm1', text: 'hello' },
      }) as unknown as MaxMessage;

    it('puts the registry group title into the conversation label', async () => {
      const finalizeInboundContext = installRuntimeSpy();
      upsertChat('default', { chatId: -100, kind: 'group', title: 'ИИ агент супер', seenAt: 1 });
      await processIncomingMessage(groupMessage(), 'ru', {
        api,
        account,
        config: {} as never,
        abortSignal: new AbortController().signal,
      });
      const ctx = finalizeInboundContext.mock.calls[0][0] as { ConversationLabel?: string };
      expect(ctx.ConversationLabel).toBe('ИИ агент супер id:-100');
    });

    it('falls back to chat:<id> when the title is unknown', async () => {
      const finalizeInboundContext = installRuntimeSpy();
      await processIncomingMessage(groupMessage(), 'ru', {
        api,
        account,
        config: {} as never,
        abortSignal: new AbortController().signal,
      });
      const ctx = finalizeInboundContext.mock.calls[0][0] as { ConversationLabel?: string };
      expect(ctx.ConversationLabel).toBe('chat:-100');
    });
  });
});
