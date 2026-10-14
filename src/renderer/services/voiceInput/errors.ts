import type { AsrTranscribeErrorCode } from '../../../shared/asr/constants';
import { i18nService } from '../i18n';

export class AsrClientError extends Error {
  constructor(
    message: string,
    public code?: AsrTranscribeErrorCode | 'microphoneUnavailable' | 'noAudio',
  ) {
    super(message);
    this.name = 'AsrClientError';
  }
}

export const getFallbackAsrErrorMessage = (code?: AsrTranscribeErrorCode): string => {
  switch (code) {
    case 'unavailable':
      return i18nService.t('voiceInputServiceUnavailable');
    case 'invalidAudio':
      return i18nService.t('voiceInputAudioInvalid');
    case 'timeout':
      return i18nService.t('voiceInputAudioTooLong');
    case 'cancelled':
      return i18nService.t('voiceInputFailed');
    case 'recognitionFailed':
      return i18nService.t('voiceInputRecognitionFailed');
    default:
      return i18nService.t('voiceInputFailed');
  }
};

export const getAsrErrorMessage = (error: unknown): string => {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return i18nService.t('voiceInputMicrophoneDenied');
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return i18nService.t('voiceInputMicrophoneUnavailable');
  }
  if (error instanceof AsrClientError) {
    if (error.message) return error.message;
    if (error.code && error.code !== 'microphoneUnavailable' && error.code !== 'noAudio') {
      return getFallbackAsrErrorMessage(error.code);
    }
    return i18nService.t('voiceInputFailed');
  }
  return i18nService.t('voiceInputFailed');
};
