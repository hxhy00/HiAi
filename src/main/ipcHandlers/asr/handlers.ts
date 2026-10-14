import { app, ipcMain } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  type AsrAvailabilityResult,
  AsrIpcChannel,
  type AsrTranscribeRequest,
  type AsrTranscribeResult,
} from '../../../shared/asr/constants';
import {
  checkSenseVoiceAvailability,
  runSenseVoiceRecognition,
  SenseVoiceRecognitionError,
  SenseVoiceUnavailableError,
} from '../../libs/senseVoice/sidecar';

/**
 * Local-only ASR IPC handlers (FR-3).
 *
 * The previous implementation proxied a server-issued realtime session. It is
 * fully replaced: the renderer records a complete WAV and asks the main process
 * to run the bundled SenseVoice sidecar once. No auth, no server, no quota.
 */

const MIN_WAV_BYTES = 128;

const writeTempWav = (bytes: Uint8Array): string => {
  const dir = fs.mkdtempSync(path.join(app.getPath('temp') || os.tmpdir(), 'lobster-asr-'));
  const filePath = path.join(dir, 'recording.wav');
  fs.writeFileSync(filePath, Buffer.from(bytes));
  return filePath;
};

const cleanupTempWav = (filePath: string): void => {
  try {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; a leftover temp file is harmless.
  }
};

export function registerAsrIpcHandlers(): void {
  ipcMain.handle(
    AsrIpcChannel.GetAvailability,
    (): AsrAvailabilityResult => checkSenseVoiceAvailability(),
  );

  ipcMain.handle(
    AsrIpcChannel.Transcribe,
    async (_event, request?: AsrTranscribeRequest): Promise<AsrTranscribeResult> => {
      const availability = checkSenseVoiceAvailability();
      if (!availability.available) {
        return {
          success: false,
          code: 'unavailable',
          error: availability.reason || 'Local speech recognition is unavailable',
        };
      }

      const wavBytes = request?.wavBytes;
      if (!wavBytes || wavBytes.byteLength < MIN_WAV_BYTES) {
        console.warn('[ASR] rejected recording as empty', {
          byteLength: wavBytes?.byteLength ?? 0,
          minRequired: MIN_WAV_BYTES,
          durationMs: request?.durationMs,
        });
        return { success: false, code: 'invalidAudio', error: 'Captured audio is empty' };
      }

      let wavPath: string | null = null;
      try {
        wavPath = writeTempWav(wavBytes instanceof Uint8Array ? wavBytes : new Uint8Array(wavBytes));
        const text = await runSenseVoiceRecognition({
          wavPath,
          onDiagnostics: (d) => {
            // Field failures ("no valid speech recognized") are otherwise
            // invisible; record exactly what the binary saw and printed so the
            // main log is enough to diagnose without a local repro.
            console.warn('[ASR] sidecar run', {
              wavBytes: d.wavBytes,
              exitCode: d.exitCode,
              durationMs: d.durationMs,
              parsedChars: d.parsedText.length,
              executable: d.executable,
              stderr: d.stderr.slice(-2000),
              stdout: d.stdout.slice(-2000),
            });
          },
        });
        if (!text.trim()) {
          console.warn('[ASR] sidecar produced an empty transcript; returning recognitionFailed');
        }
        return { success: true, text };
      } catch (error) {
        if (error instanceof SenseVoiceUnavailableError) {
          return { success: false, code: 'unavailable', error: error.message };
        }
        if (error instanceof SenseVoiceRecognitionError) {
          const code = /timed out/i.test(error.message)
            ? 'timeout'
            : /cancelled/i.test(error.message)
              ? 'cancelled'
              : 'recognitionFailed';
          console.warn('[ASR] local recognition failed:', error.message);
          return { success: false, code, error: error.message };
        }
        console.warn('[ASR] local recognition failed with unexpected error:', error);
        return {
          success: false,
          code: 'recognitionFailed',
          error: error instanceof Error ? error.message : 'Speech recognition failed',
        };
      } finally {
        if (wavPath) cleanupTempWav(wavPath);
      }
    },
  );
}
