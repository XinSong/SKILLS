# Acquisition and recovery contract

Read this file when preparation fails, a job must resume, or source retention
matters.

## Required local snapshot

Preparation materializes every remote input needed by the requested route
before knowledge generation begins:

| Route | Local source snapshot |
| --- | --- |
| Default, existing captions | metadata + complete video + original VTT |
| Default, no captions | metadata + complete video + local-ASR VTT |
| Slides requested | metadata + complete video + VTT or local-ASR VTT |
| Explicit `--discard-source`, no slides | metadata + VTT, or audio + local-ASR VTT |

Video downloads use yt-dlp continuation files. A completed video is checked by
ffprobe and SHA-256 before knowledge processing. Slide detection and ASR read
the local snapshot, not a remote media stream.

## Job location and resume

Large working files live in the platform cache outside the Obsidian Vault. A
job has a deterministic directory based on the video ID and Vault path. It
contains `job-state.json` and phase outputs.

Run the same `prepare.mjs` command to resume. Completed metadata, captions,
video, transcript chunks, sequential slide analysis, representative renders,
and final slide candidates are reused after validation. Slide recovery uses
internal checkpoints inside the same default pipeline; it is not a separate
user-facing repair mode.
An active PID lock prevents concurrent mutation of the same job; a stale lock
is replaced safely.

On failure or interruption:

- retain source files, `.part` downloads, state, and diagnostics;
- report the job directory and exact error;
- do not publish partial notes or assets;
- do not downgrade to snippets, description text, or a model summary.

## Retention

By default, successful publication retains the verified source video, metadata,
transcript, and completed job state in the external cache. Disposable audio,
slide analysis/render checkpoints, contact sheets, candidates, review JSON,
and transcript chunks are removed.
The Vault never becomes a video archive.

Use `--discard-source` only when the user explicitly wants the complete external
job and source video removed after publication. `--keep-source` is a compatible
explicit spelling of the default. The source video never enters the Vault.

## Dependencies

- Required by the default retained-video route: Node.js 20+, `yt-dlp`,
  `ffprobe`.
- Slides: `ffmpeg`; `tesseract` is optional but improves candidate
  evidence.
- Captionless video on Apple Silicon: Python 3 and `mlx-whisper`.

Missing capability is a hard failure for the requested route. Never silently
skip slides or ASR.
