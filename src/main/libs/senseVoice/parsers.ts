/**
 * Parse the output of `sherpa-onnx-offline` (FR-3).
 *
 * Release binaries differ in where and how they print the transcript, so the
 * parser handles all observed formats in priority order:
 *
 * 1. JSON result line — current releases (e.g. v1.10.30) print a single JSON
 *    object per input file (to stderr), e.g.
 *    `{"lang": "<|zh|>", "text": "你好", ...}`.
 * 2. `text=` marker — older builds print the transcript after a `text=` marker
 *    on the last (usually only) result block.
 * 3. Raw transcript — final fallback for builds that print the plain text
 *    without any marker; diagnostic lines are skipped.
 */
export const parseSenseVoiceText = (output: string): string => {
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) continue;
    try {
      const parsed = JSON.parse(trimmed) as { text?: unknown };
      if (typeof parsed.text === 'string' && parsed.text.trim()) {
        return parsed.text.trim();
      }
    } catch {
      // Not a JSON result line; keep scanning.
    }
  }

  let text = '';
  for (const line of lines) {
    const match = line.match(/^\s*text\s*=\s*(.*)$/);
    if (match) {
      text = match[1];
    }
  }
  if (text) {
    return text.trim();
  }

  const fallback = lines.find((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^--/.test(trimmed)) return false;
    // Flag echo and tool diagnostics; a raw transcript never contains these.
    if (/--tokens=|parse-options|OfflineRecognizerConfig/i.test(trimmed)) return false;
    if (/^(Started|Done|Elapsed|Num|Model|Loading|Creating|Offline)/i.test(trimmed)) return false;
    return true;
  });
  return fallback?.trim() ?? '';
};
