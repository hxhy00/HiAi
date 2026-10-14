import { describe, expect, test } from 'vitest';

import { parseSenseVoiceText } from './parsers';

describe('parseSenseVoiceText', () => {
  test('extracts the transcript after the text= marker', () => {
    const stdout = [
      'Started',
      'Done!',
      '----------',
      'text=你好世界',
    ].join('\n');

    expect(parseSenseVoiceText(stdout)).toBe('你好世界');
  });

  test('keeps the last result block when the tool prints multiple', () => {
    const stdout = [
      'text=第一句',
      'text=第二句',
    ].join('\n');

    expect(parseSenseVoiceText(stdout)).toBe('第二句');
  });

  test('trims surrounding whitespace', () => {
    expect(parseSenseVoiceText('text=  hello world  ')).toBe('hello world');
  });

  test('falls back to the first non-diagnostic line without the marker', () => {
    const stdout = [
      'Loading model...',
      'OfflineRecognizerConfig(...)',
      '今天天气不错',
    ].join('\n');

    expect(parseSenseVoiceText(stdout)).toBe('今天天气不错');
  });

  test('extracts the transcript from the JSON result line printed to stderr', () => {
    // v1.10.30 prints a JSON object (to stderr) per input file.
    const stderr = [
      '/path/parse-options.cc:Read:375 sherpa-onnx-offline --tokens=... /tmp/recording.wav',
      '',
      'OfflineRecognizerConfig(feat_config=FeatureExtractorConfig(...))',
      'Creating recognizer ...',
      'Started',
      'Done!',
      '',
      '{"lang": "<|zh|>", "emotion": "<|NEUTRAL|>", "event": "<|Speech|>", "text": "今天天气真不错我们出去散步吧", "timestamps": [0.06], "tokens":["今"], "words": []}',
      '----',
      'num threads: 2',
      'decoding method: greedy_search',
      'Elapsed seconds: 0.23 s',
      'Real time factor (RTF): 0.066',
    ].join('\n');

    expect(parseSenseVoiceText(stderr)).toBe('今天天气真不错我们出去散步吧');
  });

  test('finds the JSON result in combined stderr+stdout streams', () => {
    // sidecar.ts hands [stderr, stdout].join('\n') to the parser.
    const combined = [
      'OfflineRecognizerConfig(...)',
      '{"lang": "<|zh|>", "text": "你好世界"}',
      '',
    ].join('\n');
    expect(parseSenseVoiceText(combined)).toBe('你好世界');

    const stdoutOnly = [
      '{"lang": "<|en|>", "text": "hello world"}',
    ].join('\n');
    expect(parseSenseVoiceText(stdoutOnly)).toBe('hello world');
  });

  test('does not mistake the flag echo line for the transcript', () => {
    const stderr = [
      '/path/parse-options.cc:Read:375 sherpa-onnx-offline --tokens=tokens.txt --sense-voice-model=model.onnx /tmp/a.wav',
      'Creating recognizer ...',
      'Done!',
    ].join('\n');
    expect(parseSenseVoiceText(stderr)).toBe('');
  });

  test('returns an empty string when there is no transcript', () => {
    expect(parseSenseVoiceText('Done!\n')).toBe('');
    expect(parseSenseVoiceText('')).toBe('');
  });
});
