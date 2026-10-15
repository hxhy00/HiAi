import { describe, expect, test } from 'vitest';

import { EXPORT_FORMAT_TYPE, EXPORT_PASSWORD } from '../constants/app';
import { decryptWithPassword, encryptWithPassword } from './encryption';

describe('password-based export encryption', () => {
  test('round-trips a secret with the export password', async () => {
    const payload = await encryptWithPassword('sk-roundtrip', EXPORT_PASSWORD);

    await expect(decryptWithPassword(payload, EXPORT_PASSWORD)).resolves.toBe('sk-roundtrip');
  });

  test('rejects a payload encrypted under a different password', async () => {
    // Export files are read back by one build of the app, so the password is an
    // exact match rather than a list of candidates: a file from another build
    // must fail loudly instead of half-decoding.
    const payload = await encryptWithPassword('sk-secret', 'some-other-password');

    await expect(decryptWithPassword(payload, EXPORT_PASSWORD)).rejects.toThrow();
  });

  test('rejects a malformed payload instead of returning silently', async () => {
    await expect(
      decryptWithPassword({ encrypted: '', iv: '', salt: '' }, EXPORT_PASSWORD),
    ).rejects.toThrow();
  });

  test('uses the current export marker', () => {
    expect(EXPORT_FORMAT_TYPE).toBe('hiai.providers');
  });
});
