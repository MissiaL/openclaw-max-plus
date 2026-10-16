import { createPluginRuntimeStore, type PluginRuntime } from 'openclaw/plugin-sdk/runtime-store';

const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: 'openclaw-max-plus',
  errorMessage: 'MAX runtime not initialized',
});

export const setMaxRuntime = store.setRuntime;
export const getMaxRuntime = store.getRuntime;
