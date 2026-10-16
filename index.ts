/**
 * MAX messenger channel plugin for OpenClaw — entry point.
 *
 * defineChannelPluginEntry registers the MAX channel and stores the runtime in
 * every mode that has one. registerFull runs only for full gateway loads: it adds
 * an HTTP route for each account configured in webhook mode so the gateway
 * delivers POST updates to handleMaxWebhookRequest. (Long-polling accounts need
 * no HTTP route.)
 *
 * This is the single canonical entry — it is what `npm run build` copies to
 * `dist/index.js` (see package.json). Do not reintroduce a second `src/index.ts`.
 */

import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';

import { maxPlugin } from './src/channel.js';
import { setMaxRuntime } from './src/runtime.js';
import { handleMaxWebhookRequest, resolveMaxWebhookPaths } from './src/webhook.js';

export default defineChannelPluginEntry({
  id: 'openclaw-max-plus',
  name: 'MAX',
  description: 'MAX messenger channel plugin (max.ru Bot API)',
  plugin: maxPlugin,
  setRuntime: setMaxRuntime,
  registerFull(api) {
    for (const path of resolveMaxWebhookPaths(api.config)) {
      api.registerHttpRoute({ path, auth: 'plugin', handler: handleMaxWebhookRequest });
    }
  },
});
