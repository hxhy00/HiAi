import type { AsrTranscribeErrorCode } from '../../../shared/asr/constants';
import { type BatchVoiceRecordingSession, startBatchVoiceRecording } from './batchAudioRecorder';
import { AsrClientError, getFallbackAsrErrorMessage } from './errors';

/**
 * Local SenseVoice voice input client (FR-3).
 *
 * Records a complete utterance and asks the main process to run the bundled
 * sherpa-onnx sidecar once. There is no realtime socket, no server session and
 * no quota bookkeeping; `maxSessionSeconds` is only the client-side auto-stop
 * ceiling for a single recording.
 */

export const VOICE_INPUT_MAX_RECORDING_SECONDS = 60;

export interface LocalVoiceInputSession {
  /** Stops recording and resolves the recognized text. */
  stop: () => Promise<string>;
  /** Stops recording and discards the utterance. */
  cancel: () => void;
  /** Maximum recording length for this session, in seconds. */
  maxSessionSeconds: number;
}

const mapErrorCode = (code: AsrTranscribeErrorCode): AsrClientError => (
  new AsrClientError(getFallbackAsrErrorMessage(code), code)
);

export const isLocalAsrAvailable = async (): Promise<boolean> => {
  try {
    const result = await window.electron.asr.getAvailability();
    return result.available;
  } catch {
    return false;
  }
};

export const startLocalVoiceInput = async (): Promise<LocalVoiceInputSession> => {
  const availability = await window.electron.asr.getAvailability();
  if (!availability.available) {
    throw mapErrorCode('unavailable');
  }

  let recorder: BatchVoiceRecordingSession;
  try {
    recorder = await startBatchVoiceRecording();
  } catch (error) {
    if (error instanceof AsrClientError) throw error;
    throw new AsrClientError(
      error instanceof Error ? error.message : getFallbackAsrErrorMessage('recognitionFailed'),
      'recognitionFailed',
    );
  }

  let cancelled = false;

  return {
    maxSessionSeconds: VOICE_INPUT_MAX_RECORDING_SECONDS,
    stop: async () => {
      const wavBytes = await recorder.stop();
      if (cancelled) {
        throw new AsrClientError(getFallbackAsrErrorMessage('cancelled'), 'cancelled');
      }
      const result = await window.electron.asr.transcribe({
        wavBytes,
        durationMs: Math.round((recorder.getOutputSampleCount() / 16000) * 1000),
      });
      if (!result.success) {
        throw mapErrorCode(result.code);
      }
      const text = result.text.trim();
      if (!text) {
        throw mapErrorCode('recognitionFailed');
      }
      return text;
    },
    cancel: () => {
      cancelled = true;
      recorder.cancel();
    },
  };
};
