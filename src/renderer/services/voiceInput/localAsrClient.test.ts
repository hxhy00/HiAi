import { beforeEach, describe, expect, test, vi } from 'vitest';

import { startBatchVoiceRecording } from './batchAudioRecorder';
import { AsrClientError } from './errors';
import { isLocalAsrAvailable, startLocalVoiceInput } from './localAsrClient';

vi.mock('./batchAudioRecorder', () => ({
  startBatchVoiceRecording: vi.fn(),
}));

const mockedStartRecording = vi.mocked(startBatchVoiceRecording);

const setAsrBridge = (bridge: {
  available?: boolean;
  transcribe?: ReturnType<typeof vi.fn>;
}) => {
  (globalThis as unknown as { window: { electron: unknown } }).window = {
    electron: {
      asr: {
        getAvailability: vi.fn(async () => ({ available: bridge.available ?? true })),
        transcribe: bridge.transcribe ?? vi.fn(async () => ({ success: true, text: 'hello' })),
      },
    },
  };
};

describe('localAsrClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('reports availability from the main process bridge', async () => {
    setAsrBridge({ available: true });
    await expect(isLocalAsrAvailable()).resolves.toBe(true);

    setAsrBridge({ available: false });
    await expect(isLocalAsrAvailable()).resolves.toBe(false);
  });

  test('returns false when the bridge throws', async () => {
    (globalThis as unknown as { window: { electron: unknown } }).window = {
      electron: {
        asr: {
          getAvailability: vi.fn(async () => { throw new Error('boom'); }),
        },
      },
    };
    await expect(isLocalAsrAvailable()).resolves.toBe(false);
  });

  test('records, transcribes and trims the recognized text', async () => {
    const wavBytes = new Uint8Array(512).fill(1);
    mockedStartRecording.mockResolvedValue({
      stop: vi.fn(async () => wavBytes),
      cancel: vi.fn(),
      getOutputSampleCount: vi.fn(() => 16000),
    } as never);
    const transcribe = vi.fn(async () => ({ success: true, text: '  你好  ' }));
    setAsrBridge({ transcribe });

    const session = await startLocalVoiceInput();
    await expect(session.stop()).resolves.toBe('你好');
    expect(transcribe).toHaveBeenCalledWith({ wavBytes, durationMs: 1000 });
  });

  test('throws an unavailable error when the sidecar is missing', async () => {
    setAsrBridge({ available: false });
    await expect(startLocalVoiceInput()).rejects.toBeInstanceOf(AsrClientError);
    await expect(startLocalVoiceInput()).rejects.toMatchObject({ code: 'unavailable' });
  });

  test('surfaces a recognition failure from the bridge', async () => {
    const wavBytes = new Uint8Array(512).fill(1);
    mockedStartRecording.mockResolvedValue({
      stop: vi.fn(async () => wavBytes),
      cancel: vi.fn(),
      getOutputSampleCount: vi.fn(() => 16000),
    } as never);
    setAsrBridge({
      transcribe: vi.fn(async () => ({ success: false, code: 'recognitionFailed' })),
    });

    const session = await startLocalVoiceInput();
    await expect(session.stop()).rejects.toMatchObject({ code: 'recognitionFailed' });
  });

  test('rejects an empty transcript', async () => {
    const wavBytes = new Uint8Array(512).fill(1);
    mockedStartRecording.mockResolvedValue({
      stop: vi.fn(async () => wavBytes),
      cancel: vi.fn(),
      getOutputSampleCount: vi.fn(() => 16000),
    } as never);
    setAsrBridge({ transcribe: vi.fn(async () => ({ success: true, text: '   ' })) });

    const session = await startLocalVoiceInput();
    await expect(session.stop()).rejects.toMatchObject({ code: 'recognitionFailed' });
  });

  test('cancel discards the recording', async () => {
    const cancel = vi.fn();
    mockedStartRecording.mockResolvedValue({
      stop: vi.fn(async () => new Uint8Array(0)),
      cancel,
      getOutputSampleCount: vi.fn(() => 0),
    } as never);
    setAsrBridge({});

    const session = await startLocalVoiceInput();
    session.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
