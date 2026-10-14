import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// Spawning the real sidecar and running inference is CPU-heavy; when it shares
// a worker with the rest of the suite the machine can stall and trip the 20s
// default timeout. Give this file its own process-level timing budget so the
// assertion measures recognition, not scheduler contention.
const INTEGRATION_TIMEOUT_MS = 60_000;

import {
  buildPcm16Wav,
  encodePcm16Bytes,
  mergeAudioChunks,
  resampleLinear,
} from '../../../renderer/services/voiceInput/wavEncoder';
import {
  checkSenseVoiceAvailability,
  runSenseVoiceRecognition,
  SenseVoiceRecognitionError,
} from './sidecar';

/**
 * Integration test for the local SenseVoice sidecar (FR-3).
 *
 * Unlike the pure-parser unit tests, this suite exercises the real code path
 * used by the app's ASR IPC handler: it spawns the bundled
 * `sherpa-onnx-offline` binary against a real 16 kHz mono PCM16 WAV and
 * asserts the recognized transcript. It is skipped only when the bundled
 * binary/model is absent (e.g. fresh checkout before `setup-sherpa-onnx`), so
 * it stays green on CI without the large binary.
 */

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => os.tmpdir(),
  },
}));

const sidecarAvailable = checkSenseVoiceAvailability().available;

const writeTempWav = (bytes: Uint8Array): string => {
  const filePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'asr-sidecar-test-')),
    'recording.wav',
  );
  fs.writeFileSync(filePath, Buffer.from(bytes));
  return filePath;
};

const cleanupTempWav = (filePath: string): void => {
  try {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    // Best effort.
  }
};

/**
 * Build a 16 kHz mono PCM16 WAV whose samples come from a real TTS recording.
 * The fixture is generated once with macOS `say` + `afconvert` (see the spec
 * evidence log) and embedded here as raw PCM16 bytes so the test has no
 * external process dependency at assertion time.
 */
const buildWav = (pcm: Buffer): Uint8Array => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24); // sample rate
  header.writeUInt32LE(16000 * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([header, pcm]));
};

const FIXTURE_TTS_PATH = path.join(__dirname, '__fixtures__', 'speech-16k-mono.pcm');

describe('senseVoice sidecar integration', () => {
  const createdWavs: string[] = [];

  const makeWav = (): string | null => {
    if (!fs.existsSync(FIXTURE_TTS_PATH)) return null;
    const pcm = fs.readFileSync(FIXTURE_TTS_PATH);
    const wavPath = writeTempWav(buildWav(pcm));
    createdWavs.push(wavPath);
    return wavPath;
  };

  afterAll(() => {
    createdWavs.forEach(cleanupTempWav);
  });

  test('reports availability when the bundled binary and model exist', () => {
    const availability = checkSenseVoiceAvailability();
    // On a tree with the sidecar prepared this must be available; when the
    // repository has not run setup-sherpa-onnx yet we still assert the shape.
    expect(typeof availability.available).toBe('boolean');
    if (sidecarAvailable) {
      expect(availability).toEqual({ available: true });
    } else {
      expect(availability.reason).toBeTruthy();
    }
  });

  test.skipIf(!sidecarAvailable || !fs.existsSync(FIXTURE_TTS_PATH))(
    'transcribes a real 16 kHz mono PCM16 WAV end to end',
    async () => {
      const wavPath = makeWav();
      expect(wavPath).toBeTruthy();

      const text = await runSenseVoiceRecognition({ wavPath: wavPath as string });

      // The fixture is "今天天气真不错我们出去散步吧".
      expect(text).toContain('今天天气真不错我们出去散步吧');
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test.skipIf(!sidecarAvailable || !fs.existsSync(FIXTURE_TTS_PATH))(
    'transcribes a WAV produced by the renderer encoder path (48k capture -> 16k resample)',
    async () => {
      const pcm16 = fs.readFileSync(FIXTURE_TTS_PATH);
      // Rebuild a 48 kHz mono float stream from the fixture, then run it
      // through the exact renderer helpers the app uses: merge -> resample ->
      // encode -> WAV. This is the strongest automated proxy for a real
      // microphone capture.
      const sourceSamples = new Float32Array(pcm16.length / 2);
      for (let i = 0; i < sourceSamples.length; i += 1) {
        sourceSamples[i] = pcm16.readInt16LE(i * 2) / 0x8000;
      }
      const upsampled = resampleLinear(sourceSamples, 16000, 48000);
      const chunks: Float32Array[] = [];
      for (let i = 0; i < upsampled.length; i += 4096) {
        chunks.push(upsampled.subarray(i, Math.min(i + 4096, upsampled.length)));
      }
      const merged = mergeAudioChunks(chunks);
      const resampled = resampleLinear(merged, 48000, 16000);
      const wav = buildPcm16Wav(16000, encodePcm16Bytes(resampled));
      const wavPath = writeTempWav(wav);
      createdWavs.push(wavPath);

      const text = await runSenseVoiceRecognition({ wavPath });
      expect(text).toContain('今天天气真不错我们出去散步吧');
    },
    INTEGRATION_TIMEOUT_MS,
  );

  test.skipIf(!sidecarAvailable)(
    'rejects a missing audio file before spawning the binary',
    async () => {
      await expect(
        runSenseVoiceRecognition({ wavPath: path.join(os.tmpdir(), 'does-not-exist.wav') }),
      ).rejects.toBeInstanceOf(SenseVoiceRecognitionError);
    },
  );

  test.skipIf(!sidecarAvailable || !fs.existsSync(FIXTURE_TTS_PATH))(
    'honors the abort signal (cancel path)',
    async () => {
      const wavPath = makeWav();
      const controller = new AbortController();
      controller.abort();
      await expect(
        runSenseVoiceRecognition({ wavPath: wavPath as string, signal: controller.signal }),
      ).rejects.toThrow(/cancelled/i);
    },
  );
});

describe('fixture availability', () => {
  beforeAll(() => {
    // Surface a clear hint rather than a silent skip when the fixture is gone.
    if (sidecarAvailable && !fs.existsSync(FIXTURE_TTS_PATH)) {
      console.warn(
        `[senseVoice integration] fixture missing: ${FIXTURE_TTS_PATH}; TTS test skipped`,
      );
    }
  });

  test('fixture file exists when the sidecar is prepared', () => {
    if (!sidecarAvailable) {
      expect(true).toBe(true);
      return;
    }
    expect(fs.existsSync(FIXTURE_TTS_PATH)).toBe(true);
  });
});
