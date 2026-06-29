/**
 * Tests for MAX Bot API client
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxApi, MaxApiError } from './api.js';

const MOCK_TOKEN = 'test-bot-token';
const MOCK_BASE_URL = 'https://test-api.max.ru';

describe('MaxApi', () => {
  let api: MaxApi;

  beforeEach(() => {
    api = new MaxApi({ token: MOCK_TOKEN, baseUrl: MOCK_BASE_URL });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create instance with provided options', () => {
      const customApi = new MaxApi({
        token: 'custom-token',
        baseUrl: 'https://custom.api',
        timeoutMs: 5000,
      });
      expect(customApi).toBeInstanceOf(MaxApi);
    });

    it('should use default baseUrl if not provided', () => {
      const defaultApi = new MaxApi({ token: MOCK_TOKEN });
      expect(defaultApi).toBeInstanceOf(MaxApi);
    });
  });

  describe('baseUrl resolution', () => {
    const ENV_KEY = 'MAX_API_BASE_URL';
    let savedEnv: string | undefined;

    beforeEach(() => {
      savedEnv = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
    });

    afterEach(() => {
      if (savedEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = savedEnv;
    });

    it('should default to the migrated platform-api2 domain', async () => {
      // The bundled Минцифры root CA is auto-trusted (see ca-trust.ts), so the
      // platform-api2 domain works out of the box without a system cert install.
      const defaultApi = new MaxApi({ token: MOCK_TOKEN });
      global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await defaultApi.getMe();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('https://platform-api2.max.ru'),
        expect.anything(),
      );
    });

    it('should honor MAX_API_BASE_URL env override when no explicit baseUrl', async () => {
      process.env[ENV_KEY] = 'https://env-api.max.ru';
      const envApi = new MaxApi({ token: MOCK_TOKEN });
      global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await envApi.getMe();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('https://env-api.max.ru'),
        expect.anything(),
      );
    });

    it('should let explicit baseUrl win over the env override', async () => {
      process.env[ENV_KEY] = 'https://env-api.max.ru';
      const explicitApi = new MaxApi({ token: MOCK_TOKEN, baseUrl: 'https://explicit.max.ru' });
      global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await explicitApi.getMe();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('https://explicit.max.ru'),
        expect.anything(),
      );
    });
  });

  describe('getMe', () => {
    it('should fetch bot info', async () => {
      const mockUser = {
        user_id: 12345,
        first_name: 'TestBot',
        username: 'testbot',
        is_bot: true,
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockUser,
      });

      const result = await api.getMe();
      expect(result).toEqual(mockUser);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/me'),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: MOCK_TOKEN,
          }),
        }),
      );
    });

    it('should handle API errors', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Unauthorized' }),
      });

      await expect(api.getMe()).rejects.toThrow(MaxApiError);
    });
  });

  describe('sendMessage', () => {
    it('should send text message', async () => {
      const mockResult = {
        message: {
          body: { mid: 'msg-123', text: 'Hello' },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      const result = await api.sendMessage({ text: 'Hello' }, { chat_id: 123 });

      expect(result).toEqual(mockResult);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/messages'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: MOCK_TOKEN,
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('should send message with markdown format', async () => {
      const mockResult = {
        message: {
          body: { mid: 'msg-124', text: '**Bold**' },
          timestamp: Date.now(),
          recipient: { chat_id: 456 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      await api.sendMessage({ text: '**Bold**', format: 'markdown' }, { chat_id: 456 });

      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe('editMessage', () => {
    it('should edit existing message', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await api.editMessage('msg-123', { text: 'Updated text' });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/messages?message_id=msg-123'),
        expect.objectContaining({
          method: 'PUT',
        }),
      );
    });
  });

  describe('deleteMessage', () => {
    it('should delete message', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await api.deleteMessage('msg-456');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/messages?message_id=msg-456'),
        expect.objectContaining({
          method: 'DELETE',
        }),
      );
    });
  });

  describe('getChats', () => {
    it('should fetch chats list', async () => {
      const mockChats = {
        chats: [
          { chat_id: 1, type: 'dialog' as const, status: 'active' },
          { chat_id: 2, type: 'chat' as const, status: 'active', title: 'Group' },
        ],
        marker: null,
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockChats,
      });

      const result = await api.getChats({ count: 10 });
      expect(result.chats).toHaveLength(2);
    });
  });

  describe('getMessages', () => {
    function mockOk() {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) });
    }

    it('should clamp count above 100 down to 100', async () => {
      mockOk();
      await api.getMessages(123, { count: 500 });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('count=100'),
        expect.anything(),
      );
    });

    it('should clamp count below 1 up to 1', async () => {
      mockOk();
      await api.getMessages(123, { count: 0 });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('count=1'),
        expect.anything(),
      );
    });

    it('should pass an in-range count unchanged', async () => {
      mockOk();
      await api.getMessages(123, { count: 50 });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('count=50'),
        expect.anything(),
      );
    });
  });

  describe('getMyMembership', () => {
    it('should GET /chats/{id}/members/me', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_id: 1, is_admin: true, permissions: ['pin_message'] }),
      });

      const member = await api.getMyMembership(123);

      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(String(url)).toContain('/chats/123/members/me');
      expect(init.method).toBe('GET');
      expect(member.is_admin).toBe(true);
    });
  });

  describe('pin', () => {
    it('should pin a message via PUT /chats/{id}/pin', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

      await api.pinMessage(123, 'mid-1', { notify: false });

      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(String(url)).toContain('/chats/123/pin');
      expect(init.method).toBe('PUT');
      expect(String(init.body)).toContain('"message_id":"mid-1"');
      expect(String(init.body)).toContain('"notify":false');
    });

    it('should unpin via DELETE /chats/{id}/pin', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

      await api.unpinMessage(123);

      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(String(url)).toContain('/chats/123/pin');
      expect(init.method).toBe('DELETE');
    });

    it('should fetch the pinned message via GET /chats/{id}/pin', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ message: null }) });

      await api.getPinnedMessage(123);

      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(String(url)).toContain('/chats/123/pin');
      expect(init.method).toBe('GET');
    });
  });

  describe('getChat', () => {
    it('should fetch single chat info', async () => {
      const mockChat = {
        chat_id: 123,
        type: 'chat' as const,
        status: 'active',
        title: 'Test Group',
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockChat,
      });

      const result = await api.getChat(123);
      expect(result.chat_id).toBe(123);
    });
  });

  describe('getUpdates', () => {
    it('should poll for updates', async () => {
      const mockUpdates = {
        updates: [
          {
            update_type: 'message_created' as const,
            timestamp: Date.now(),
            message: {
              body: { mid: 'msg-789', text: 'Hello' },
              timestamp: Date.now(),
              recipient: { chat_id: 123 },
            },
          },
        ],
        marker: 456,
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockUpdates,
      });

      const result = await api.getUpdates({ timeout: 30, limit: 100 });
      expect(result.updates).toHaveLength(1);
      expect(result.marker).toBe(456);
    });
  });

  describe('setMyCommands', () => {
    it('should set bot commands', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const commands = [
        { name: 'start', description: 'Start bot' },
        { name: 'help', description: 'Show help' },
      ];

      await api.setMyCommands(commands);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/me'),
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ commands }),
        }),
      );
    });
  });

  describe('webhook subscriptions', () => {
    it('should subscribe to webhook', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await api.subscribe({
        url: 'https://example.com/webhook',
        secret: 'my-secret',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/subscriptions'),
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    it('should unsubscribe from webhook', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await api.unsubscribe('https://example.com/webhook');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/subscriptions'),
        expect.objectContaining({
          method: 'DELETE',
        }),
      );
    });

    it('should get subscriptions list', async () => {
      const mockSubs = {
        subscriptions: [{ url: 'https://example.com/webhook', time: Date.now() }],
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockSubs,
      });

      const result = await api.getSubscriptions();
      expect(result.subscriptions).toHaveLength(1);
    });
  });

  describe('timeout handling', () => {
    it('should abort request on timeout', async () => {
      const slowApi = new MaxApi({ token: MOCK_TOKEN, timeoutMs: 100 });

      global.fetch = vi
        .fn()
        .mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 500)));

      await expect(slowApi.getMe()).rejects.toThrow();
    });
  });
});
