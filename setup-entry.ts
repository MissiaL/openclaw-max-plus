/**
 * Lightweight setup entry: OpenClaw loads it instead of index.ts when the MAX
 * channel is disabled or unconfigured. No runtime, routes or CLI wiring here.
 */

import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/channel-core';

import { maxPlugin } from './src/channel.js';

export default defineSetupPluginEntry(maxPlugin);
