/**
 * MAX messenger channel plugin for OpenClaw — entry point.
 *
 * Registers the MAX channel and, for any account configured in webhook mode,
 * an HTTP route so the gateway delivers POST updates to handleMaxWebhookRequest.
 * (Long-polling accounts need no HTTP route.)
 *
 * This is the single canonical entry — it is what `npm run build` copies to
 * `dist/index.js` (see package.json). Do not reintroduce a second `src/index.ts`.
 */

import type { ChannelPlugin, OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { maxPlugin } from './src/channel.js';
import { setMaxRuntime } from './src/runtime.js';
import { handleMaxWebhookRequest, resolveMaxWebhookPaths } from './src/webhook.js';

const plugin = {
  id: 'openclaw-max',
  name: 'MAX',
  description: 'MAX messenger channel plugin (max.ru Bot API)',
  configSchema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {},
  },
  register(api: OpenClawPluginApi) {
    setMaxRuntime(api.runtime);
    api.registerChannel({ plugin: maxPlugin as ChannelPlugin });
    for (const path of resolveMaxWebhookPaths(api.config)) {
      api.registerHttpRoute({ path, auth: 'plugin', handler: handleMaxWebhookRequest });
    }
  },
};

export default plugin;
