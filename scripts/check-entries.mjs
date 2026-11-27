import assert from 'node:assert/strict';

import pkg from '../package.json' with { type: 'json' };

// Load the same compiled entries as the host to catch missing SDK exports before packing.
const packageRoot = new URL('../', import.meta.url);
const { default: entry } = await import(new URL(pkg.openclaw.extensions[0], packageRoot));
const { default: setup } = await import(new URL(pkg.openclaw.setupEntry, packageRoot));
assert.equal(typeof entry.register, 'function');
assert.equal(setup.plugin.id, 'max');
