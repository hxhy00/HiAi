/**
 * Local SenseVoice ASR contract (FR-3).
 *
 * Voice input records a PCM16 WAV (16 kHz mono) in the renderer, then asks the
 * main process to run a single offline recognition pass through the bundled
 * sherpa-onnx SenseVoice sidecar. There is no server session, no streaming and
 * no quota: the previous realtime/server contract is gone.
 */

export const AsrIpcChannel = {
  /** Returns whether the local SenseVoice sidecar is usable. */
  GetAvailability: 'asr:local:getAvailability',
  /** Runs one offline recognition pass for a recorded WAV file. */
  Transcribe: 'asr:local:transcribe',
} as const;

export type AsrIpcChannel = typeof AsrIpcChannel[keyof typeof AsrIpcChannel];

export interface AsrAvailabilityResult {
  available: boolean;
  reason?: string;
}

export interface AsrTranscribeRequest {
  /** Complete PCM16 WAV payload (16 kHz, mono) captured by the renderer. */
  wavBytes: Uint8Array;
  /** Duration of the recording in milliseconds, used for validation. */
  durationMs?: number;
}

export type AsrTranscribeErrorCode =
  | 'unavailable'
  | 'invalidAudio'
  | 'recognitionFailed'
  | 'cancelled'
  | 'timeout';

export type AsrTranscribeResult =
  | { success: true; text: string }
  | { success: false; code: AsrTranscribeErrorCode; error?: string };
