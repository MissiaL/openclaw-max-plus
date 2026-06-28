/**
 * Tests for MAX monitor (interface verification)
 */

import { describe, expect, it, vi } from 'vitest';

import type { ResolvedMaxAccount } from './accounts.js';
import type { MaxApi, MaxMessage } from './api.js';
import { processIncomingMessage, startMaxPolling } from './monitor.js';
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
  });
});
