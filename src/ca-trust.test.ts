/**
 * Tests for the bundled Russian Trusted Root CA auto-trust.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { __resetMaxTrustedCaForTest, ensureMaxTrustedCa } from './ca-trust.js';

const bundled = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'certs', 'russian_trusted_root_ca.pem'),
  'utf8',
);
const norm = (c: string): string => c.replace(/\s/g, '');

describe('ensureMaxTrustedCa', () => {
  it('bundles a valid Russian Trusted Root CA certificate', () => {
    expect(bundled).toContain('BEGIN CERTIFICATE');
  });

  it('appends the bundled CA to the default trust store', () => {
    __resetMaxTrustedCaForTest();
    ensureMaxTrustedCa();
    const certs = tls.getCACertificates();
    expect(certs.some((c) => norm(c) === norm(bundled))).toBe(true);
  });

  it('does not duplicate the CA on repeated calls', () => {
    __resetMaxTrustedCaForTest();
    ensureMaxTrustedCa();
    const count = tls.getCACertificates().filter((c) => norm(c) === norm(bundled)).length;
    __resetMaxTrustedCaForTest();
    ensureMaxTrustedCa();
    expect(tls.getCACertificates().filter((c) => norm(c) === norm(bundled)).length).toBe(count);
    expect(count).toBe(1);
  });
});
