from __future__ import annotations

import json
import os
import subprocess
import uuid
from pathlib import Path
from typing import Any

from knowledge_compiler.errors import KnowledgeCompilerError


def _run(validator_id: str, script: Path, arguments: list[Path]) -> dict[str, Any]:
    if not script.is_file():
        raise KnowledgeCompilerError(
            "UPSTREAM_VALIDATOR_MISSING", f"Required upstream validator is missing: {script}", validator=validator_id
        )
    try:
        process = subprocess.run(
            ["node", str(script), *(str(path) for path in arguments)],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise KnowledgeCompilerError(
            "UPSTREAM_VALIDATOR_UNAVAILABLE", f"Cannot execute upstream validator: {validator_id}", cause=str(error)
        ) from error
    if process.returncode != 0:
        raise KnowledgeCompilerError(
            "UPSTREAM_VALIDATION_FAILED",
            f"Upstream validator rejected a source: {validator_id}",
            validator=validator_id,
            stderr=process.stderr.strip(),
        )
    try:
        result = json.loads(process.stdout)
    except json.JSONDecodeError as error:
        raise KnowledgeCompilerError(
            "UPSTREAM_VALIDATOR_PROTOCOL", f"Upstream validator returned non-JSON: {validator_id}"
        ) from error
    if not isinstance(result, dict):
        raise KnowledgeCompilerError(
            "UPSTREAM_VALIDATOR_PROTOCOL", f"Upstream validator returned a non-object: {validator_id}"
        )
    return result


def verify_knowledge_note(path: Path) -> tuple[str, dict[str, Any]]:
    skill_root = Path(__file__).resolve().parents[2]
    validator = skill_root.parent / "knowledge-picker" / "scripts" / "verify-note.mjs"
    return "knowledge-picker/verify-note", _run("knowledge-picker/verify-note", validator, [path])


def verify_translation(original: Path, translation: Path) -> tuple[str, dict[str, Any]]:
    skill_root = Path(__file__).resolve().parents[2]
    validator = skill_root.parent / "knowledge-picker" / "scripts" / "verify-translation.mjs"
    return "knowledge-picker/verify-translation", _run(
        "knowledge-picker/verify-translation", validator, [original, translation]
    )


def verify_course_note(path: Path, vault: Path) -> tuple[str, dict[str, Any]]:
    skill_root = Path(__file__).resolve().parents[2]
    validator = skill_root.parent / "course-picker" / "scripts" / "verify-video-note.mjs"
    validation_path = path
    mirror: Path | None = None
    if path.parent != vault:
        mirror = vault / f".knowledge-compiler-source-validation-{uuid.uuid4().hex}.md"
        try:
            os.link(path, mirror)
            validation_path = mirror
            details = _run("course-picker/verify-video-note", validator, [validation_path])
        finally:
            if mirror is not None:
                mirror.unlink(missing_ok=True)
        details = dict(details)
        details["compatibility_validation"] = {
            "mode": "vault-root-hardlink",
            "source_path": str(path),
            "temporary_path_removed": True,
        }
        return "course-picker/verify-video-note", details
    return "course-picker/verify-video-note", _run("course-picker/verify-video-note", validator, [validation_path])
