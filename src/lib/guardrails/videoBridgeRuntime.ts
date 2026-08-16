import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface VideoCommandOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export type VideoCommandRunner = (
  executable: "ffmpeg" | "ffprobe",
  args: readonly string[],
  options: VideoCommandOptions
) => Promise<{ stdout: string; stderr: string }>;

export interface VideoRuntimeStatus {
  available: boolean;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
  reason?: string;
}

export interface VideoFrameFile {
  path: string;
  timestampSeconds: number;
}

export interface VideoProbeMetadata {
  durationSeconds: number;
  formatName: string;
  height: number;
  streamIndex: number;
  width: number;
}

export interface ExtractedVideoFrame {
  dataUri: string;
  timestampSeconds: number;
}

export const VIDEO_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const VIDEO_FRAMES_TOTAL_MAX_BYTES = 23 * 1024 * 1024;
export const VIDEO_MAX_DIMENSION = 8_192;
export const VIDEO_MAX_PIXELS = 33_554_432;

const SAFE_FORMATS = new Set([
  "3g2",
  "3gp",
  "avi",
  "flac",
  "flv",
  "m4a",
  "matroska",
  "mj2",
  "mov",
  "mp4",
  "ogg",
  "webm",
]);
const SAFE_FORMAT_WHITELIST = [...SAFE_FORMATS].join(",");

const defaultRunner: VideoCommandRunner = async (executable, args, options) => {
  const result = await execFileAsync(executable, [...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    signal: options.signal,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

function assertLocalPath(filePath: string): void {
  if (!isAbsolute(filePath) || filePath.includes("\0") || filePath.includes("://")) {
    throw new Error("Video runtime requires a local path");
  }
}

function parseVersion(output: string): string | null {
  const version = /\bversion\s+([^\s]+)/i.exec(output)?.[1];
  return version ? version.slice(0, 80).replace(/[^A-Za-z0-9._+-]/g, "_") : null;
}

let runtimeProbeCache: { expiresAt: number; value: VideoRuntimeStatus } | null = null;

export function resetVideoRuntimeProbeCacheForTests(): void {
  runtimeProbeCache = null;
}

export async function probeVideoRuntime(
  options: {
    cacheTtlMs?: number;
    runner?: VideoCommandRunner;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}
): Promise<VideoRuntimeStatus> {
  const now = Date.now();
  if (runtimeProbeCache && runtimeProbeCache.expiresAt > now) {
    return structuredClone(runtimeProbeCache.value);
  }

  const runner = options.runner ?? defaultRunner;
  const commandOptions = {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 5_000,
  };
  let value: VideoRuntimeStatus;
  try {
    const [ffmpeg, ffprobe] = await Promise.all([
      runner("ffmpeg", ["-version"], commandOptions),
      runner("ffprobe", ["-version"], commandOptions),
    ]);
    const ffmpegVersion = parseVersion(ffmpeg.stdout);
    const ffprobeVersion = parseVersion(ffprobe.stdout);
    value =
      ffmpegVersion && ffprobeVersion
        ? { available: true, ffmpegVersion, ffprobeVersion }
        : {
            available: false,
            ffmpegVersion,
            ffprobeVersion,
            reason: "FFmpeg and ffprobe versions could not be verified",
          };
  } catch {
    value = {
      available: false,
      ffmpegVersion: null,
      ffprobeVersion: null,
      reason: "FFmpeg and ffprobe are not available on PATH",
    };
  }

  runtimeProbeCache = {
    expiresAt: now + (options.cacheTtlMs ?? 30_000),
    value,
  };
  return structuredClone(value);
}

export function calculateFrameTimestamps(
  durationSeconds: number,
  requestedFrameCount: number
): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Video duration must be positive");
  }
  if (
    !Number.isInteger(requestedFrameCount) ||
    requestedFrameCount < 1 ||
    requestedFrameCount > 16
  ) {
    throw new Error("Video frame count must be between 1 and 16");
  }
  const frameCount = Math.min(requestedFrameCount, Math.max(1, Math.floor(durationSeconds)));
  return Array.from(
    { length: frameCount },
    (_unused, index) => ((index + 0.5) * durationSeconds) / frameCount
  );
}

export async function probeLocalVideo(
  inputPath: string,
  options: {
    maxDurationSeconds?: number;
    runner?: VideoCommandRunner;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}
): Promise<VideoProbeMetadata> {
  assertLocalPath(inputPath);
  const result = await (options.runner ?? defaultRunner)(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      SAFE_FORMAT_WHITELIST,
      "-threads",
      "1",
      "-show_entries",
      "format=duration,format_name:stream=index,codec_type,width,height:stream_disposition=default,attached_pic",
      "-of",
      "json",
      inputPath,
    ],
    { signal: options.signal, timeoutMs: options.timeoutMs ?? 30_000 }
  );
  let durationSeconds = Number.NaN;
  let formatName = "";
  let width = Number.NaN;
  let height = Number.NaN;
  let streamIndex = Number.NaN;
  let allVideoStreamsSafe = false;
  let playableVideoStreamCount = 0;
  try {
    const parsed = JSON.parse(result.stdout) as {
      format?: { duration?: unknown; format_name?: unknown };
      streams?: Array<{
        codec_type?: unknown;
        disposition?: unknown;
        height?: unknown;
        index?: unknown;
        width?: unknown;
      }>;
    };
    durationSeconds = Number(parsed.format?.duration);
    formatName = typeof parsed.format?.format_name === "string" ? parsed.format.format_name : "";
    const videoStreams = parsed.streams?.filter((stream) => stream.codec_type === "video") ?? [];
    const dispositionFlag = (stream: (typeof videoStreams)[number], key: string): boolean => {
      const disposition = stream.disposition;
      if (!disposition || typeof disposition !== "object" || Array.isArray(disposition)) {
        return false;
      }
      const value = (disposition as Record<string, unknown>)[key];
      return value === 1 || value === "1";
    };
    const playableVideoStreams = videoStreams.filter(
      (stream) => !dispositionFlag(stream, "attached_pic")
    );
    playableVideoStreamCount = playableVideoStreams.length;
    allVideoStreamsSafe =
      playableVideoStreams.length > 0 &&
      !playableVideoStreams.some((stream) => {
        const streamWidth = Number(stream.width);
        const streamHeight = Number(stream.height);
        const candidateIndex = Number(stream.index);
        return (
          !Number.isInteger(candidateIndex) ||
          candidateIndex < 0 ||
          !Number.isInteger(streamWidth) ||
          !Number.isInteger(streamHeight) ||
          streamWidth < 1 ||
          streamHeight < 1 ||
          streamWidth > VIDEO_MAX_DIMENSION ||
          streamHeight > VIDEO_MAX_DIMENSION ||
          streamWidth * streamHeight > VIDEO_MAX_PIXELS
        );
      });
    const selectedStream = [...playableVideoStreams].sort((left, right) => {
      const defaultPreference =
        Number(dispositionFlag(right, "default")) - Number(dispositionFlag(left, "default"));
      return defaultPreference || Number(left.index) - Number(right.index);
    })[0];
    if (selectedStream) {
      streamIndex = Number(selectedStream.index);
      width = Number(selectedStream.width);
      height = Number(selectedStream.height);
    }
  } catch {
    // The stable error below deliberately excludes raw ffprobe output.
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("Video runtime returned invalid duration metadata");
  }
  if (durationSeconds > (options.maxDurationSeconds ?? 600)) {
    throw new Error("Video exceeds the maximum duration");
  }
  const formats = formatName
    .toLowerCase()
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (formats.length === 0 || formats.some((entry) => !SAFE_FORMATS.has(entry))) {
    throw new Error("Video container format is not allowed");
  }
  if (playableVideoStreamCount === 0) {
    throw new Error("Video container has no playable video stream");
  }
  if (!allVideoStreamsSafe) {
    throw new Error("Video stream metadata or dimensions exceed the safe processing limit");
  }
  return { durationSeconds, formatName, height, streamIndex, width };
}

export async function extractFramesFromLocalVideo(
  inputPath: string,
  outputDirectory: string,
  options: {
    durationSeconds: number;
    frameCount: number;
    runner?: VideoCommandRunner;
    signal?: AbortSignal;
    streamIndex: number;
    timeoutMs?: number;
  }
): Promise<VideoFrameFile[]> {
  assertLocalPath(inputPath);
  assertLocalPath(outputDirectory);
  const timestamps = calculateFrameTimestamps(options.durationSeconds, options.frameCount);
  if (!Number.isInteger(options.streamIndex) || options.streamIndex < 0) {
    throw new Error("Video stream index is invalid");
  }
  const runner = options.runner ?? defaultRunner;
  const frames: VideoFrameFile[] = [];

  for (let index = 0; index < timestamps.length; index++) {
    const timestampSeconds = timestamps[index];
    const outputPath = join(outputDirectory, `frame-${String(index + 1).padStart(2, "0")}.jpg`);
    await runner(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        SAFE_FORMAT_WHITELIST,
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-ss",
        timestampSeconds.toFixed(3),
        "-i",
        inputPath,
        "-map",
        `0:${options.streamIndex}`,
        "-vf",
        "scale=w='min(1024,iw)':h='min(1024,ih)':force_original_aspect_ratio=decrease",
        "-frames:v",
        "1",
        "-q:v",
        "2",
        "-y",
        outputPath,
      ],
      { signal: options.signal, timeoutMs: options.timeoutMs ?? 120_000 }
    );
    frames.push({ path: outputPath, timestampSeconds });
  }
  return frames;
}

export async function readBoundedExtractedFrames(
  frames: readonly VideoFrameFile[],
  options: { maxFrameBytes?: number; maxTotalBytes?: number } = {}
): Promise<Buffer[]> {
  const maxFrameBytes = options.maxFrameBytes ?? VIDEO_FRAME_MAX_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? VIDEO_FRAMES_TOTAL_MAX_BYTES;
  let totalBytes = 0;
  const sizes: number[] = [];
  for (const frame of frames) {
    const metadata = await stat(frame.path);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maxFrameBytes) {
      throw new Error("Extracted video frame byte limit exceeded");
    }
    totalBytes += metadata.size;
    if (totalBytes > maxTotalBytes) {
      throw new Error("Extracted video total frame byte limit exceeded");
    }
    sizes.push(metadata.size);
  }

  const output: Buffer[] = [];
  for (let index = 0; index < frames.length; index++) {
    const bytes = await readFile(frames[index].path);
    if (bytes.byteLength !== sizes[index]) {
      throw new Error("Extracted video frame changed before it could be read");
    }
    output.push(bytes);
  }
  return output;
}

export async function extractVideoFramesFromBytes(
  bytes: Uint8Array,
  options: {
    frameCount: number;
    maxDurationSeconds: number;
    runner?: VideoCommandRunner;
    signal?: AbortSignal;
    timeoutMs: number;
  }
): Promise<{ durationSeconds: number; frames: ExtractedVideoFrame[] }> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "omniroute-video-broker-"));
  try {
    if (options.signal?.aborted) throw new Error("Video extraction request aborted");
    const inputPath = join(temporaryDirectory, "input.video");
    const framesDirectory = join(temporaryDirectory, "frames");
    await mkdir(framesDirectory, { mode: 0o700 });
    await writeFile(inputPath, bytes, { mode: 0o600 });
    const metadata = await probeLocalVideo(inputPath, {
      maxDurationSeconds: options.maxDurationSeconds,
      runner: options.runner,
      signal: options.signal,
      timeoutMs: Math.min(options.timeoutMs, 30_000),
    });
    const frameFiles = await extractFramesFromLocalVideo(inputPath, framesDirectory, {
      durationSeconds: metadata.durationSeconds,
      frameCount: options.frameCount,
      runner: options.runner,
      signal: options.signal,
      streamIndex: metadata.streamIndex,
      timeoutMs: options.timeoutMs,
    });
    const frameBytes = await readBoundedExtractedFrames(frameFiles);
    return {
      durationSeconds: metadata.durationSeconds,
      frames: frameFiles.map((frame, index) => ({
        dataUri: `data:image/jpeg;base64,${frameBytes[index].toString("base64")}`,
        timestampSeconds: frame.timestampSeconds,
      })),
    };
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}
