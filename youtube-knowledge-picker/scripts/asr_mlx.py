#!/usr/bin/env python3
"""Run MLX Whisper and write a minimal WEBVTT transcript."""

from __future__ import annotations

import argparse
from pathlib import Path


def timestamp(seconds: float) -> str:
    milliseconds = max(0, round(float(seconds) * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("output")
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    import mlx_whisper  # Imported only after CLI validation.

    result = mlx_whisper.transcribe(args.audio, path_or_hf_repo=args.model)
    segments = result.get("segments") or []
    if not segments:
        raise RuntimeError("MLX Whisper returned no transcript segments")

    lines = ["WEBVTT", ""]
    for index, segment in enumerate(segments, start=1):
        text = " ".join(str(segment.get("text") or "").split())
        if not text:
            continue
        text = text.replace("-->", "→")
        lines.extend(
            [
                str(index),
                f"{timestamp(segment['start'])} --> {timestamp(segment['end'])}",
                text,
                "",
            ]
        )
    Path(args.output).write_text("\n".join(lines), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
