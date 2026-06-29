/**
 * Auto-trust the Russian Trusted Root CA (Минцифры) for the current process so
 * that requests to platform-api2.max.ru succeed over TLS WITHOUT installing the
 * certificate system-wide. The CA is bundled with the plugin (certs/) and
 * appended to Node's default CA store the first time the MAX API client is used.
 *
 * Requires `tls.setDefaultCACertificates` (Node ≥ 22.15 / 24). On older runtimes
 * the call is a no-op — the legacy platform-api.max.ru domain still works, and an
 * operator can install the CA or set NODE_EXTRA_CA_CERTS to use platform-api2.
 *
 * Best-effort: this never throws, so it can be called safely from a constructor.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

let registered = false;

function readBundledCa(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  // Built layout: dist/src/ca-trust.js → ../certs (copied by build).
  // Dev/test layout: src/ca-trust.ts → ../certs.
  // Fallback: dist/src → ../../certs (repo root) when certs were not copied.
  const candidates = [
    join(here, '..', 'certs', 'russian_trusted_root_ca.pem'),
    join(here, '..', '..', 'certs', 'russian_trusted_root_ca.pem'),
  ];
  for (const path of candidates) {
    try {
      const pem = readFileSync(path, 'utf8');
      if (pem.includes('BEGIN CERTIFICATE')) return pem;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

/**
 * Append the bundled Минцифры root CA to the process default trust store, once.
 * @param log optional sink for a one-line confirmation.
 */
export function ensureMaxTrustedCa(log?: (message: string) => void): void {
  if (registered) return;
  registered = true;
  try {
    if (
      typeof tls.setDefaultCACertificates !== 'function' ||
      typeof tls.getCACertificates !== 'function'
    ) {
      return;
    }
    const pem = readBundledCa();
    if (!pem) return;
    const current = tls.getCACertificates();
    const norm = (c: string): string => c.replace(/\s/g, '');
    if (current.some((c) => norm(c) === norm(pem))) return; // already trusted
    tls.setDefaultCACertificates([...current, pem]);
    log?.('[max] registered Russian Trusted Root CA for platform-api2 TLS');
  } catch {
    // Best-effort: the legacy domain works without this; never break the caller.
  }
}

/** @internal test hook — reset the once-guard. */
export function __resetMaxTrustedCaForTest(): void {
  registered = false;
}
