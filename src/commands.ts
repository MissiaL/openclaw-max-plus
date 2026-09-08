import type { ChannelLogSink } from 'openclaw/plugin-sdk/channel-contract';
import { resolveNativeCommandsEnabled } from 'openclaw/plugin-sdk/config-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { listNativeCommandSpecsForConfig } from 'openclaw/plugin-sdk/native-command-registry';

import type { MaxAccountConfig, ResolvedMaxAccount } from './accounts.js';
import type { MaxApi } from './api.js';
import type { MaxBotCommand } from './types.js';

const MAX_COMMANDS = 32;
// Keep everyday commands reachable when the host registry exceeds MAX's limit.
const MENU_PRIORITY = [
  'help',
  'commands',
  'new',
  'stop',
  'status',
  'models',
  'model',
  'think',
  'reasoning',
  'compact',
  'usage',
  'whoami',
  'tools',
  'skill',
  'tasks',
  'restart',
];

export function resolveMaxCommands(
  cfg: OpenClawConfig,
  setting: MaxAccountConfig['commands'],
): MaxBotCommand[] | undefined {
  // Opt-in: preserve menus configured outside OpenClaw when unset.
  if (setting !== 'auto') return setting;
  if (
    cfg.commands?.text === false ||
    !resolveNativeCommandsEnabled({
      providerId: 'max',
      globalSetting: cfg.commands?.native,
      autoDefault: true,
    })
  )
    return [];

  const specs = listNativeCommandSpecsForConfig(cfg, { provider: 'max' }).filter(
    (spec) => !spec.isAlias && spec.name.length > 0 && spec.name.length <= 64,
  );
  const priority = (name: string) => {
    const index = MENU_PRIORITY.indexOf(name);
    return index < 0 ? MENU_PRIORITY.length : index;
  };
  specs.sort((a, b) => priority(a.name) - priority(b.name));
  const commands = new Map<string, MaxBotCommand>();
  for (const spec of specs) {
    if (commands.has(spec.name.toLowerCase())) continue;
    commands.set(spec.name.toLowerCase(), {
      name: spec.name,
      description: (spec.descriptionLocalizations?.ru ?? spec.description).slice(0, 128),
    });
    if (commands.size === MAX_COMMANDS) break;
  }
  return [...commands.values()];
}

export async function syncMaxCommands(params: {
  cfg: OpenClawConfig;
  account: ResolvedMaxAccount;
  api: Pick<MaxApi, 'setMyCommands'>;
  log?: ChannelLogSink;
}): Promise<void> {
  const { cfg, account, api, log } = params;
  try {
    const commands = resolveMaxCommands(cfg, account.config.commands);
    if (commands === undefined) return;
    await api.setMyCommands(commands);
    log?.info(
      `[${account.accountId}] Registered ${commands.length} bot commands via PATCH /me/commands`,
    );
  } catch (err) {
    // A menu failure must not stop delivery of user messages.
    log?.error(`[${account.accountId}] Failed to register commands: ${String(err)}`);
  }
}
