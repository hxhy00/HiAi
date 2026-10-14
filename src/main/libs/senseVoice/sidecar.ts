import { spawn } from 'child_process';
import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseSenseVoiceText } from './parsers';

export { parseSenseVoiceText };

/**
 * sherpa-onnx SenseVoice sidecar management (FR-3).
 *
 * The app ships a prebuilt `sherpa-onnx-offline` executable plus the SenseVoice
 * Small int8 ONNX model under `resources/sherpa-onnx/` (see
 * scripts/setup-sherpa-onnx.js). Voice input records a PCM16 WAV (16 kHz mono)
 * in the renderer, hands the file path to the main process, and this module
 * runs the binary once per utterance and parses the recognized text back.
 *
 * There is no server fallback: when the binary or model is missing or broken
 * the feature reports "unavailable" so the UI can grey out the voice button.
 */

export interface SenseVoiceAvailability {
  available: boolean;
  reason?: string;
}

const RESOURCE_DIR_NAME = ['sherpa-onnx'];
const MODEL_SUBDIR = ['model', 'sense-voice'];
const EXECUTABLE_NAME = process.platform === 'win32' ? 'sherpa-onnx-offline.exe' : 'sherpa-onnx-offline';
const REQUIRED_MODEL_FILES = ['model.int8.onnx', 'tokens.txt'];
const DEFAULT_TIMEOUT_MS = 60_000;

const getProjectRoot = (): string => path.resolve(__dirname, '..', '..', '..', '..');

/**
 * Candidate roots that may contain the bundled sidecar, in priority order. The
 * packaged layout puts it under `process.resourcesPath`; the dev layout keeps it
 * in the repo `resources/` folder.
 */
export const getSidecarRootCandidates = (): string[] => {
  const candidates: string[] = [];
  if (app?.isPackaged) {
    candidates.push(path.join(process.resourcesPath, ...RESOURCE_DIR_NAME));
  }
  candidates.push(path.join(app.getAppPath(), 'resources', ...RESOURCE_DIR_NAME));
  candidates.push(path.join(getProjectRoot(), 'resources', ...RESOURCE_DIR_NAME));
  candidates.push(path.join(process.cwd(), 'resources', ...RESOURCE_DIR_NAME));
  return [...new Set(candidates)];
};

interface ResolvedSidecar {
  root: string;
  executable: string;
  modelDir: string;
}

const isNonEmptyFile = (filePath: string): boolean => {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
};

const resolveSidecar = (): ResolvedSidecar | null => {
  for (const root of getSidecarRootCandidates()) {
    const executable = path.join(root, 'bin', getTargetTriple(), EXECUTABLE_NAME);
    const modelDir = path.join(root, ...MODEL_SUBDIR);
    if (!isNonEmptyFile(executable)) continue;
    if (!REQUIRED_MODEL_FILES.every(file => isNonEmptyFile(path.join(modelDir, file)))) continue;
    return { root, executable, modelDir };
  }
  return null;
};

const getTargetTriple = (): string => {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
  if (process.platform === 'darwin') return `mac-${arch}`;
  if (process.platform === 'win32') return `win-${arch}`;
  return `${process.platform}-${arch}`;
};

export const checkSenseVoiceAvailability = (): SenseVoiceAvailability => {
  const sidecar = resolveSidecar();
  if (!sidecar) {
    return {
      available: false,
      reason: 'sherpa-onnx sidecar binary or SenseVoice model not found',
    };
  }
  return { available: true };
};

interface RunRecognitionOptions {
  wavPath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional diagnostics sink; called once with the raw run result. */
  onDiagnostics?: SenseVoiceDiagnosticsSink;
}

export class SenseVoiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SenseVoiceUnavailableError';
  }
}

export class SenseVoiceRecognitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SenseVoiceRecognitionError';
  }
}

/**
 * Diagnostic hook invoked once per sidecar run with the raw process output.
 * Used by the ASR IPC handler to log what the binary actually printed when a
 * recording yields no transcript, so a field failure is diagnosable from the
 * main log without reproducing locally. Kept out of the returned value so
 * callers that only need the text stay unchanged.
 */
export interface SenseVoiceRunDiagnostics {
  executable: string;
  modelDir: string;
  wavBytes: number;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  parsedText: string;
}

export type SenseVoiceDiagnosticsSink = (diagnostics: SenseVoiceRunDiagnostics) => void;

export const runSenseVoiceRecognition = async ({
  wavPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  onDiagnostics,
}: RunRecognitionOptions): Promise<string> => {
  const sidecar = resolveSidecar();
  if (!sidecar) {
    throw new SenseVoiceUnavailableError('sherpa-onnx sidecar binary or SenseVoice model not found');
  }
  if (!isNonEmptyFile(wavPath)) {
    throw new SenseVoiceRecognitionError('Recorded audio file is missing or empty');
  }

  let wavBytes = 0;
  try {
    wavBytes = fs.statSync(wavPath).size;
  } catch {
    // Non-fatal; diagnostics just report 0.
  }
  const startedAt = Date.now();

  const args = [
    `--tokens=${path.join(sidecar.modelDir, 'tokens.txt')}`,
    `--sense-voice-model=${path.join(sidecar.modelDir, 'model.int8.onnx')}`,
    '--num-threads=2',
    wavPath,
  ];

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(sidecar.executable, args, {
      cwd: os.tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    };

    const onAbort = () => {
      cleanup();
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore kill failures; the process is being torn down anyway.
      }
      reject(new SenseVoiceRecognitionError('Voice recognition was cancelled'));
    };

    const timer = setTimeout(() => {
      cleanup();
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore kill failures.
      }
      reject(new SenseVoiceRecognitionError('Voice recognition timed out'));
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      cleanup();
      reject(new SenseVoiceRecognitionError(
        `Failed to start sherpa-onnx sidecar: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });

    child.on('close', (code) => {
      cleanup();
      // Release binaries print the recognition result to stderr (stdout only
      // carries nothing in v1.10.30), so both streams are handed to the parser;
      // it locates the result wherever it appears.
      const parsed = code === 0
        ? parseSenseVoiceText([stderr, stdout].filter(s => s.trim()).join('\n'))
        : '';
      try {
        onDiagnostics?.({
          executable: sidecar.executable,
          modelDir: sidecar.modelDir,
          wavBytes,
          exitCode: code,
          durationMs: Date.now() - startedAt,
          stdout,
          stderr,
          parsedText: parsed,
        });
      } catch {
        // Diagnostics must never affect the recognition result.
      }
      if (code !== 0) {
        reject(new SenseVoiceRecognitionError(
          `sherpa-onnx sidecar exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`,
        ));
        return;
      }
      resolve(parsed);
    });
  });
};
