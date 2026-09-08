import { listNativeCommandSpecsForConfig } from 'openclaw/plugin-sdk/native-command-registry';
import { describe, expect, it, vi } from 'vitest';

import { resolveMaxAccount } from './accounts.js';
import { resolveMaxCommands, syncMaxCommands } from './commands.js';
import { MaxConfigSchema } from './config-schema.js';

describe('MAX command menu', () => {
  it('keeps externally managed menus untouched when commands is unset', async () => {
    const api = { setMyCommands: vi.fn() };
    const cfg = { channels: { max: { botToken: 'test' } } };
    await syncMaxCommands({ cfg, account: resolveMaxAccount({ cfg }), api });
    expect(api.setMyCommands).not.toHaveBeenCalled();
  });

  it('uses host commands and retains essential entries within MAX limits', () => {
    const menu = resolveMaxCommands({}, 'auto')!;
    const hostNames = listNativeCommandSpecsForConfig({}, { provider: 'max' }).map((s) => s.name);
    expect(menu.length).toBeLessThanOrEqual(32);
    expect(menu.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'help',
        'commands',
        'new',
        'stop',
        'status',
        'model',
        'models',
        'think',
      ]),
    );
    expect(new Set(menu.map((c) => c.name)).size).toBe(menu.length);
    for (const c of menu) {
      expect(hostNames).toContain(c.name);
      expect(c.description!.length).toBeLessThanOrEqual(128);
    }
    expect(menu.map((c) => c.name)).not.toContain('bash');
  });

  it.each([{ native: false }, { text: false }])(
    'clears automatic suggestions when %j',
    (commands) => {
      expect(resolveMaxCommands({ commands }, 'auto')).toEqual([]);
    },
  );

  it.each(['auto', [], [{ name: 'help', description: 'Помощь' }]])(
    'accepts command setting %j at channel and account level',
    (commands) => {
      expect(
        MaxConfigSchema.parse({ commands, accounts: { work: { commands } } }).commands,
      ).toEqual(commands);
    },
  );

  it('rejects more than 32 explicit commands', () => {
    expect(() =>
      MaxConfigSchema.parse({
        commands: Array.from({ length: 33 }, (_, i) => ({ name: `c${i}` })),
      }),
    ).toThrow();
  });

  it('inherits top-level commands but preserves a named account empty override', async () => {
    const cfg = {
      channels: {
        max: {
          commands: [{ name: 'help', description: 'Помощь' }],
          accounts: { work: { botToken: 'work' }, empty: { botToken: 'empty', commands: [] } },
        },
      },
    };
    const api = { setMyCommands: vi.fn().mockResolvedValue({ commands: [] }) };
    await syncMaxCommands({ cfg, account: resolveMaxAccount({ cfg, accountId: 'work' }), api });
    await syncMaxCommands({ cfg, account: resolveMaxAccount({ cfg, accountId: 'empty' }), api });
    expect(api.setMyCommands.mock.calls).toEqual([[cfg.channels.max.commands], [[]]]);
  });

  it('uses a named account menu instead of the top-level menu', () => {
    const cfg = {
      channels: {
        max: {
          commands: [{ name: 'help' }],
          accounts: { work: { commands: [{ name: 'status' }] } },
        },
      },
    };
    const account = resolveMaxAccount({ cfg, accountId: 'work' });
    expect(resolveMaxCommands(cfg, account.config.commands)).toEqual([{ name: 'status' }]);
  });

  it('reports registration failure without stopping the channel', async () => {
    const cfg = { channels: { max: { commands: [] } } };
    const api = { setMyCommands: vi.fn().mockRejectedValue(new Error('MAX unavailable')) };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    await expect(
      syncMaxCommands({ cfg, account: resolveMaxAccount({ cfg }), api, log }),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to register commands'));
  });
});
