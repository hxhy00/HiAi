import { describe, expect, test } from 'vitest';

import {
  ACCEPTED_EXPORT_FORMAT_TYPES,
  EXPORT_FORMAT_TYPE,
  EXPORT_PASSWORD,
  EXPORT_PASSWORD_CANDIDATES,
  LEGACY_EXPORT_FORMAT_TYPE,
  LEGACY_EXPORT_PASSWORD,
} from '../constants/app';
import { decryptWithPassword, decryptWithPasswordCandidates, encryptWithPassword } from './encryption';

describe('decryptWithPasswordCandidates', () => {
  test('decrypts with the first candidate when it matches', async () => {
    const payload = await encryptWithPassword('sk-current', EXPORT_PASSWORD);

    await expect(decryptWithPasswordCandidates(payload, EXPORT_PASSWORD_CANDIDATES))
      .resolves.toBe('sk-current');
  });

  test('still decrypts a file written before the rename', async () => {
    // The point of the candidate list: a key encrypted under the old password
    // must keep opening after the password changed.
    const payload = await encryptWithPassword('sk-legacy', LEGACY_EXPORT_PASSWORD);

    await expect(decryptWithPasswordCandidates(payload, EXPORT_PASSWORD_CANDIDATES))
      .resolves.toBe('sk-legacy');
  });

  test('rejects when no candidate matches', async () => {
    const payload = await encryptWithPassword('sk-secret', 'some-other-password');

    await expect(decryptWithPasswordCandidates(payload, EXPORT_PASSWORD_CANDIDATES))
      .rejects.toThrow();
  });

  test('rejects an empty candidate list instead of returning silently', async () => {
    const payload = await encryptWithPassword('sk-secret', EXPORT_PASSWORD);

    await expect(decryptWithPasswordCandidates(payload, []))
      .rejects.toThrow();
  });

  test('leaves the shared decrypt path unchanged for a single password', async () => {
    const payload = await encryptWithPassword('sk-single', EXPORT_PASSWORD);

    await expect(decryptWithPassword(payload, EXPORT_PASSWORD)).resolves.toBe('sk-single');
    await expect(decryptWithPassword(payload, LEGACY_EXPORT_PASSWORD)).rejects.toThrow();
  });
});

describe('export format markers', () => {
  test('accepts both the current and the pre-rename marker', () => {
    expect(ACCEPTED_EXPORT_FORMAT_TYPES).toContain(EXPORT_FORMAT_TYPE);
    expect(ACCEPTED_EXPORT_FORMAT_TYPES).toContain(LEGACY_EXPORT_FORMAT_TYPE);
    expect(ACCEPTED_EXPORT_FORMAT_TYPES[0]).toBe(EXPORT_FORMAT_TYPE);
  });

  test('tries the current password before the legacy one', () => {
    expect(EXPORT_PASSWORD_CANDIDATES[0]).toBe(EXPORT_PASSWORD);
    expect(EXPORT_PASSWORD_CANDIDATES[1]).toBe(LEGACY_EXPORT_PASSWORD);
  });
});