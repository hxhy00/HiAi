import { i18nService } from '../i18n';
import {
  VOICE_INPUT_MIN_RECORDING_MS,
  VOICE_INPUT_TARGET_SAMPLE_RATE,
} from './constants';
import { AsrClientError } from './errors';
import { buildPcm16Wav, encodePcm16Bytes, mergeAudioChunks, resampleLinear } from './wavEncoder';

type AudioContextConstructor = typeof AudioContext;

export interface BatchVoiceRecordingSession {
  /** Stops capture and resolves the full PCM16 WAV payload (16 kHz, mono). */
  stop: () => Promise<Uint8Array>;
  /** Stops capture and discards the recording. */
  cancel: () => void;
  /** Captured output sample count at the target sample rate. */
  getOutputSampleCount: () => number;
}

const resolveAudioContext = (): AudioContextConstructor | null => {
  const windowWithWebkit = window as typeof window & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return window.AudioContext ?? windowWithWebkit.webkitAudioContext ?? null;
};

/**
 * Records a complete utterance for one-shot local SenseVoice recognition (FR-3).
 *
 * Unlike the previous streaming recorder this collects every PCM chunk and
 * produces a single WAV file when the user stops; nothing is sent until then.
 */
export const startBatchVoiceRecording = async (): Promise<BatchVoiceRecordingSession> => {
  const AudioContextImpl = resolveAudioContext();
  if (!AudioContextImpl || !navigator.mediaDevices?.getUserMedia) {
    throw new AsrClientError(i18nService.t('voiceInputMicrophoneUnavailable'));
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const audioContext = new AudioContextImpl();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const mutedOutput = audioContext.createGain();
  mutedOutput.gain.value = 0;

  const recordedChunks: Float32Array[] = [];
  let outputSampleCount = 0;
  let stopped = false;

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    recordedChunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };

  source.connect(processor);
  processor.connect(mutedOutput);
  mutedOutput.connect(audioContext.destination);

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    processor.disconnect();
    source.disconnect();
    mutedOutput.disconnect();
    stream.getTracks().forEach((track) => track.stop());
  };

  const buildWav = (): Uint8Array => {
    if (recordedChunks.length === 0) {
      return buildPcm16Wav(VOICE_INPUT_TARGET_SAMPLE_RATE, new Uint8Array(0));
    }
    const merged = mergeAudioChunks(recordedChunks);
    const resampled = resampleLinear(merged, audioContext.sampleRate, VOICE_INPUT_TARGET_SAMPLE_RATE);
    outputSampleCount = resampled.length;
    return buildPcm16Wav(VOICE_INPUT_TARGET_SAMPLE_RATE, encodePcm16Bytes(resampled));
  };

  return {
    stop: async () => {
      cleanup();
      const wav = buildWav();
      await audioContext.close();
      if (outputSampleCount < VOICE_INPUT_TARGET_SAMPLE_RATE * (VOICE_INPUT_MIN_RECORDING_MS / 1000)) {
        throw new AsrClientError(i18nService.t('voiceInputNoAudioCaptured'));
      }
      return wav;
    },
    cancel: () => {
      cleanup();
      void audioContext.close();
    },
    getOutputSampleCount: () => outputSampleCount,
  };
};
