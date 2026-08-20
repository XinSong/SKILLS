from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Iterable, TypeVar
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import yaml
from pydantic import BaseModel

from knowledge_compiler.errors import KnowledgeCompilerError

T = TypeVar("T", bound=BaseModel)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode("utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_id(prefix: str, *parts: str, length: int = 20) -> str:
    payload = "\x1f".join(parts)
    return f"{prefix}_{sha256_text(payload)[:length]}"


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise KnowledgeCompilerError("INVALID_JSON", f"Cannot read JSON: {path}", cause=str(error)) from error
    if not isinstance(value, dict):
        raise KnowledgeCompilerError("INVALID_JSON", f"Expected a JSON object: {path}")
    return value


def write_jsonl(path: Path, records: Iterable[BaseModel | dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for record in records:
        value = record.model_dump(mode="json") if isinstance(record, BaseModel) else record
        lines.append(canonical_json(value))
    path.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")


def read_jsonl(path: Path, model: type[T]) -> list[T]:
    result: list[T] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise KnowledgeCompilerError("MISSING_INPUT", f"Cannot read JSONL: {path}", cause=str(error)) from error
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            result.append(model.model_validate_json(line))
        except Exception as error:
            raise KnowledgeCompilerError(
                "INVALID_IR", f"Invalid {model.__name__} at {path}:{number}", cause=str(error)
            ) from error
    return result


def parse_frontmatter(markdown: str) -> tuple[dict[str, Any], str, int]:
    lines = markdown.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return {}, markdown, 1
    closing = next((index for index, line in enumerate(lines[1:], 1) if line.strip() == "---"), None)
    if closing is None:
        raise KnowledgeCompilerError("INVALID_FRONTMATTER", "Unclosed YAML frontmatter")
    raw = "".join(lines[1:closing])
    try:
        metadata = yaml.safe_load(raw) or {}
    except yaml.YAMLError as error:
        raise KnowledgeCompilerError("INVALID_FRONTMATTER", "Invalid YAML frontmatter", cause=str(error)) from error
    if not isinstance(metadata, dict):
        raise KnowledgeCompilerError("INVALID_FRONTMATTER", "YAML frontmatter must be a mapping")
    return metadata, "".join(lines[closing + 1 :]), closing + 2


def normalize_url(value: str) -> str:
    try:
        parts = urlsplit(value.strip())
    except ValueError as error:
        raise KnowledgeCompilerError("INVALID_SOURCE_URL", f"Invalid source_url: {value}") from error
    if parts.scheme.lower() not in {"http", "https"} or not parts.hostname:
        raise KnowledgeCompilerError("INVALID_SOURCE_URL", f"source_url must be HTTP(S): {value}")
    hostname = parts.hostname.lower()
    port = parts.port
    if port and not ((parts.scheme.lower() == "http" and port == 80) or (parts.scheme.lower() == "https" and port == 443)):
        hostname = f"{hostname}:{port}"
    path = re.sub(r"/{2,}", "/", parts.path or "/")
    if path != "/":
        path = path.rstrip("/")
    query = urlencode(sorted(parse_qsl(parts.query, keep_blank_values=True)))
    return urlunsplit((parts.scheme.lower(), hostname, path, query, ""))


def ensure_relative_path(value: str) -> Path:
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise KnowledgeCompilerError("UNSAFE_PATH", f"Expected a safe relative path: {value}")
    return path


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def require_regular_file(path: Path) -> None:
    try:
        info = path.lstat()
    except OSError as error:
        raise KnowledgeCompilerError("MISSING_SOURCE", f"Source does not exist: {path}") from error
    if path.is_symlink() or not info.is_file():
        raise KnowledgeCompilerError("UNSAFE_SOURCE", f"Source must be a regular non-symlink file: {path}")


def update_job_stage(job: Path, stage: str, **values: Any) -> dict[str, Any]:
    state_path = job / "job-state.json"
    state = read_json(state_path)
    state.update(values)
    state["stage"] = stage
    atomic_write_json(state_path, state)
    return state

