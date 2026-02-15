import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type SupertonicTtsConfig = {
  onnxDir: string;
  voiceStyle: string;
  lang: string;
  totalStep: number;
  speed: number;
};

const DEFAULT_SUPERTONIC_LANG = "en";
const DEFAULT_SUPERTONIC_TOTAL_STEP = 2;
const DEFAULT_SUPERTONIC_SPEED = 1.05;

/** Path to the Python TTS script that writes WAV to stdout. */
const TTS_SCRIPT = path.resolve(process.env.HOME ?? "/Users", "supertonic/py/tts_stdout.py");

export function resolveSupertoniConfig(raw?: {
  onnxDir?: string;
  voiceStyle?: string;
  lang?: string;
  totalStep?: number;
  speed?: number;
}): SupertonicTtsConfig | null {
  const onnxDir = raw?.onnxDir?.trim();
  const voiceStyle = raw?.voiceStyle?.trim();
  if (!onnxDir || !voiceStyle) {
    return null;
  }
  return {
    onnxDir,
    voiceStyle,
    lang: raw?.lang?.trim() || DEFAULT_SUPERTONIC_LANG,
    totalStep: raw?.totalStep ?? DEFAULT_SUPERTONIC_TOTAL_STEP,
    speed: raw?.speed ?? DEFAULT_SUPERTONIC_SPEED,
  };
}

export function isSupertonicConfigured(raw?: { onnxDir?: string; voiceStyle?: string }): boolean {
  const onnxDir = raw?.onnxDir?.trim();
  const voiceStyle = raw?.voiceStyle?.trim();
  if (!onnxDir || !voiceStyle) {
    return false;
  }
  return (
    existsSync(onnxDir) &&
    existsSync(path.join(onnxDir, "tts.json")) &&
    existsSync(voiceStyle) &&
    existsSync(TTS_SCRIPT)
  );
}

export async function supertonicTTS(params: {
  text: string;
  config: SupertonicTtsConfig;
  timeoutMs: number;
}): Promise<Buffer> {
  const { text, config, timeoutMs } = params;

  return new Promise<Buffer>((resolve, reject) => {
    const args = [
      TTS_SCRIPT,
      "--onnx-dir",
      config.onnxDir,
      "--voice-style",
      config.voiceStyle,
      "--text",
      text,
      "--lang",
      config.lang,
      "--total-step",
      String(config.totalStep),
      "--speed",
      String(config.speed),
    ];

    const child = execFile(
      "python3",
      args,
      {
        encoding: "buffer",
        maxBuffer: 50 * 1024 * 1024,
        timeout: timeoutMs,
        cwd: path.dirname(TTS_SCRIPT),
      },
      (error, stdout, stderr) => {
        if (error) {
          const stderrStr = stderr?.toString("utf8") ?? "";
          reject(new Error(`Supertonic TTS failed: ${error.message}\n${stderrStr}`));
          return;
        }
        if (!stdout || stdout.length < 44) {
          reject(new Error("Supertonic TTS returned empty or invalid WAV data"));
          return;
        }
        resolve(stdout);
      },
    );

    child.on("error", (err) => {
      reject(new Error(`Supertonic TTS spawn failed: ${err.message}`));
    });
  });
}
