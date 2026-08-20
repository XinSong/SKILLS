from __future__ import annotations

import os
import re
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

from knowledge_compiler import IR_SCHEMA_VERSION, __version__
from knowledge_compiler.adapters.upstream import verify_course_note, verify_knowledge_note, verify_translation
from knowledge_compiler.common import (
    atomic_write_json,
    canonical_json,
    is_within,
    normalize_url,
    parse_frontmatter,
    read_json,
    sha256_file,
    sha256_text,
    stable_id,
    write_jsonl,
)
from knowledge_compiler.compiler.segment import segment_evidence_spans, segment_markdown
from knowledge_compiler.errors import KnowledgeCompilerError
from knowledge_compiler.models import PrimaryEvidenceAnchor, SourceRecord
from knowledge_compiler.models.ir import SourceVerification

DEFAULT_LIMITS = {
    "max_sources": 100,
    "max_source_bytes": 5_000_000,
    "max_total_bytes": 50_000_000,
    "max_evidence_units": 10_000,
    "max_canonical_claims": 5_000,
}
_KB_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")
_TRANSLATION_SUFFIX = "（中文翻译）"


def _target_for(vault: Path, knowledge_base_id: str) -> Path:
    return vault / "Compiled Knowledge" / knowledge_base_id


def _validate_vault(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise KnowledgeCompilerError("VAULT_NOT_ABSOLUTE", "--vault must be an absolute path")
    path = path.resolve()
    if not path.is_dir():
        raise KnowledgeCompilerError("VAULT_NOT_FOUND", f"Vault is not a directory: {path}")
    return path


def _walk_directory(root: Path) -> Iterable[Path]:
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        for directory in list(directories):
            child = current_path / directory
            if child.is_symlink():
                raise KnowledgeCompilerError("UNSAFE_SOURCE", f"Source directory contains a symlink: {child}")
        for name in files:
            child = current_path / name
            if child.is_symlink():
                raise KnowledgeCompilerError("UNSAFE_SOURCE", f"Source directory contains a symlink: {child}")
            if child.suffix.lower() == ".md":
                yield child


def _discover(vault: Path, target: Path, roots: list[str]) -> tuple[list[Path], list[str]]:
    discovered: set[Path] = set()
    relative_roots: list[str] = []
    for raw in roots:
        root = Path(raw)
        if not root.is_absolute():
            raise KnowledgeCompilerError("SOURCE_NOT_ABSOLUTE", "Every --source must be an absolute file or directory", source=raw)
        if root.is_symlink():
            raise KnowledgeCompilerError("UNSAFE_SOURCE", f"Source root is a symlink: {root}")
        root = root.resolve()
        if not is_within(root, vault):
            raise KnowledgeCompilerError("SOURCE_OUTSIDE_VAULT", f"Source is outside the Vault: {root}")
        if is_within(root, target) or is_within(target, root):
            raise KnowledgeCompilerError("SOURCE_TARGET_OVERLAP", f"Source overlaps compiler output: {root}")
        if not root.exists():
            raise KnowledgeCompilerError("MISSING_SOURCE", f"Source root does not exist: {root}")
        relative_roots.append(root.relative_to(vault).as_posix())
        candidates = [root] if root.is_file() else list(_walk_directory(root))
        for candidate in candidates:
            if candidate.suffix.lower() != ".md" or not candidate.is_file():
                continue
            if is_within(candidate, target) or ".knowledge-compiler" in candidate.parts:
                continue
            discovered.add(candidate)
    return sorted(discovered), sorted(set(relative_roots))


def _discover_from_config(vault: Path, target: Path, config: dict[str, Any]) -> list[Path]:
    roots = [str((vault / item["root"]).resolve()) for item in config.get("sources", [])]
    files, _ = _discover(vault, target, roots)
    return files


def _source_metadata(path: Path) -> tuple[dict[str, Any], str]:
    markdown = path.read_text(encoding="utf-8")
    metadata, _, _ = parse_frontmatter(markdown)
    title = str(metadata.get("title") or path.stem.replace(_TRANSLATION_SUFFIX, "")).strip()
    return metadata, title


def _classify(
    path: Path, metadata: dict[str, Any], known_paths: set[Path], vault: Path
) -> tuple[str, str, str, dict[str, Any]]:
    source_url = str(metadata.get("source_url") or "").strip()
    is_translation = path.stem.endswith(_TRANSLATION_SUFFIX)
    if is_translation:
        original = path.with_name(f"{path.stem.removesuffix(_TRANSLATION_SUFFIX)}{path.suffix}")
        if original not in known_paths:
            raise KnowledgeCompilerError(
                "TRANSLATION_ORIGINAL_MISSING", f"Faithful translation requires its sibling original in the selected sources: {path}"
            )
        validator, details = verify_translation(original, path)
        return "faithful-translation", "faithful-variant", validator, details
    if source_url and ("youtube.com/" in source_url or "youtu.be/" in source_url):
        validator, details = verify_course_note(path, vault)
        return "course-note", "derived-note", validator, details
    collection_keys = {"title", "author", "source_url", "captured", "tags"}
    if source_url and collection_keys.issubset(metadata):
        validator, details = verify_knowledge_note(path)
        return "collected-article", "local-source-snapshot", validator, details
    if metadata.get("knowledge_compiler_source") == "user-authored":
        return "user-note", "user-authored", "none", {}
    return "unknown-markdown", "unverified-local", "none", {}


def _identity_values(item: dict[str, Any]) -> tuple[str, str, str, str, str]:
    metadata = item["metadata"]
    document_key = item["relative"]
    work_key = item["source_url"] or f"local:{item['source_id']}"
    publisher_key = str(metadata.get("knowledge_compiler_publisher") or metadata.get("author") or "unknown").strip().casefold()
    if item["kind"] == "course-note":
        title = str(item["title"])
        course_name = re.split(r"\s*\|\s*Part\s+\d+", title, maxsplit=1, flags=re.IGNORECASE)[0]
        corpus_key = str(metadata.get("knowledge_compiler_corpus") or f"course:{publisher_key}:{course_name.casefold()}")
        independence_key = str(metadata.get("knowledge_compiler_independence_group") or corpus_key)
    else:
        corpus_key = str(metadata.get("knowledge_compiler_corpus") or work_key)
        independence_key = str(metadata.get("knowledge_compiler_independence_group") or work_key)
    return (
        stable_id("document", document_key),
        stable_id("work", work_key),
        stable_id("corpus", corpus_key),
        stable_id("publisher", publisher_key),
        stable_id("independence", independence_key),
    )


def _generated_hashes(generated: Path) -> dict[str, str]:
    if not generated.exists():
        return {}
    result: dict[str, str] = {}
    for path in sorted(generated.rglob("*")):
        if path.is_symlink():
            raise KnowledgeCompilerError("GENERATED_DRIFT", f"Generated tree contains a symlink: {path}")
        if path.is_file():
            result[path.relative_to(generated).as_posix()] = sha256_file(path)
    return result


def _load_previous(target: Path) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    state_path = target / ".knowledge-compiler" / "published-state.json"
    manifest_path = target / "generated" / "manifest.json"
    state = read_json(state_path) if state_path.exists() else None
    manifest = read_json(manifest_path) if manifest_path.exists() else None
    return state, manifest


def prepare(
    *, vault_value: str, knowledge_base_id: str, source_values: list[str], language: str | None, job_root: str | None
) -> dict[str, Any]:
    vault = _validate_vault(vault_value)
    if not _KB_ID.fullmatch(knowledge_base_id):
        raise KnowledgeCompilerError("INVALID_KNOWLEDGE_BASE_ID", "Knowledge-base ID must be lowercase kebab-case")
    target = _target_for(vault, knowledge_base_id)
    config_path = target / "knowledge-compiler.json"

    if target.exists() and not config_path.exists() and any(target.iterdir()):
        raise KnowledgeCompilerError("TARGET_NOT_OWNED", f"Refusing to take over an unsigned target: {target}")

    if config_path.exists():
        config = read_json(config_path)
        if config.get("schema_version") != 1 or config.get("knowledge_base_id") != knowledge_base_id:
            raise KnowledgeCompilerError("INVALID_CONFIG", f"Invalid compiler signature: {config_path}")
        if source_values:
            _, proposed_roots = _discover(vault, target, source_values)
            existing_roots = sorted(item["root"] for item in config.get("sources", []))
            if proposed_roots != existing_roots:
                raise KnowledgeCompilerError("CONFIG_CHANGE_REQUIRES_APPROVAL", "Source roots differ from the saved configuration")
        files = _discover_from_config(vault, target, config)
    else:
        if not source_values:
            raise KnowledgeCompilerError("SOURCE_REQUIRED", "The first build requires at least one --source")
        files, relative_roots = _discover(vault, target, source_values)
        config = {
            "schema_version": 1,
            "compiler_signature": "knowledge-compiler",
            "knowledge_base_id": knowledge_base_id,
            "output_language": language or "zh-CN",
            "sources": [{"root": root, "include": ["**/*.md"], "exclude": []} for root in relative_roots],
            "exclude": ["Compiled Knowledge/**", "**/.knowledge-compiler/**"],
            "source_variant_policy": "prefer-original-language",
            "page_types": ["concept", "comparison", "map", "question"],
            "algorithm_profile": "lexical-codex-v1",
            "semantic_backend": "codex-mediated",
            "random_seed": 0,
            "limits": DEFAULT_LIMITS,
        }
        target.mkdir(parents=True, exist_ok=True)
        atomic_write_json(config_path, config)

    if not files:
        raise KnowledgeCompilerError("NO_SOURCES", "No Markdown sources were discovered")
    limits = {**DEFAULT_LIMITS, **config.get("limits", {})}
    if len(files) > limits["max_sources"]:
        raise KnowledgeCompilerError("SOURCE_LIMIT_EXCEEDED", "Too many sources", actual=len(files), limit=limits["max_sources"])
    total_bytes = 0
    known_paths = set(files)
    previous_state, previous_manifest = _load_previous(target)
    previous_records = (previous_manifest or {}).get("sources", [])
    prior_by_path = {record["vault_relative_path"]: record for record in previous_records}
    prior_by_hash: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in previous_records:
        prior_by_hash[record["content_sha256"]].append(record)

    provisional: list[dict[str, Any]] = []
    for path in files:
        size = path.stat().st_size
        total_bytes += size
        if size > limits["max_source_bytes"]:
            raise KnowledgeCompilerError("SOURCE_BYTES_EXCEEDED", f"Source exceeds size limit: {path}", actual=size)
        relative = path.relative_to(vault).as_posix()
        digest = sha256_file(path)
        metadata, title = _source_metadata(path)
        source_url = normalize_url(str(metadata["source_url"])) if metadata.get("source_url") else None
        prior = prior_by_path.get(relative)
        if not prior and len(prior_by_hash[digest]) == 1:
            prior = prior_by_hash[digest][0]
        provenance_key = source_url or relative
        prior_matches_identity = prior and (not source_url or prior.get("source_url") == source_url)
        source_id = prior["source_id"] if prior_matches_identity else stable_id("src", provenance_key)
        kind, tier, validator, details = _classify(path, metadata, known_paths, vault)
        provisional.append(
            {
                "path": path,
                "relative": relative,
                "digest": digest,
                "size": size,
                "metadata": metadata,
                "title": title,
                "source_url": source_url,
                "source_id": source_id,
                "kind": kind,
                "tier": tier,
                "validator": validator,
                "details": details,
                "group_key": source_url or f"local:{source_id}",
            }
        )
    if total_bytes > limits["max_total_bytes"]:
        raise KnowledgeCompilerError("TOTAL_BYTES_EXCEEDED", "Selected sources exceed the total size limit", actual=total_bytes)

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in provisional:
        groups[item["group_key"]].append(item)
    records: list[SourceRecord] = []
    extraction_variants: list[dict[str, Any]] = []
    for group_key, variants in sorted(groups.items()):
        variants.sort(key=lambda item: (item["kind"] == "faithful-translation", item["relative"]))
        group_id = stable_id("variant", group_key)
        logical_source_id = variants[0]["source_id"]
        extraction_variants.append(variants[0])
        for index, item in enumerate(variants):
            role = "sole" if len(variants) == 1 else ("translation" if item["kind"] == "faithful-translation" else ("original" if index == 0 else "duplicate"))
            status = "unverified-local" if item["validator"] == "none" else "passed"
            document_id, work_id, corpus_id, publisher_id, independence_group_id = _identity_values(item)
            records.append(
                SourceRecord(
                    source_id=logical_source_id,
                    vault_relative_path=item["relative"],
                    content_sha256=item["digest"],
                    byte_size=item["size"],
                    source_url=item["source_url"],
                    title=item["title"],
                    published=str(item["metadata"].get("published")) if item["metadata"].get("published") else None,
                    source_kind=item["kind"],
                    evidence_tier=item["tier"],
                    document_id=document_id,
                    work_id=work_id,
                    corpus_id=corpus_id,
                    publisher_id=publisher_id,
                    independence_group_id=independence_group_id,
                    variant_group_id=group_id,
                    variant_role=role,
                    verification=SourceVerification(validator=item["validator"], status=status, details=item["details"]),
                )
            )

    previous_source_hashes = {(item["source_id"], item["vault_relative_path"]): item["content_sha256"] for item in previous_records}
    current_source_hashes = {(item.source_id, item.vault_relative_path): item.content_sha256 for item in records}
    changed_source_ids = sorted(
        {
            source_id
            for (source_id, path), digest in current_source_hashes.items()
            if previous_source_hashes.get((source_id, path)) != digest
        }
    )
    schema_rebuild = bool(previous_manifest and previous_manifest.get("ir_schema_version") != IR_SCHEMA_VERSION)
    if schema_rebuild:
        changed_source_ids = sorted({record.source_id for record in records})
    previous_logical_ids = {key[0] for key in previous_source_hashes}
    current_logical_ids = {key[0] for key in current_source_hashes}
    deleted_source_ids = sorted(previous_logical_ids - current_logical_ids)
    changed_source_ids = sorted(
        set(changed_source_ids)
        | {
            source_id
            for source_id in previous_logical_ids & current_logical_ids
            if {(path, digest) for (candidate, path), digest in previous_source_hashes.items() if candidate == source_id}
            != {(path, digest) for (candidate, path), digest in current_source_hashes.items() if candidate == source_id}
        }
    )

    units = []
    for item in extraction_variants:
        logical_id = next(record.source_id for record in records if record.vault_relative_path == item["relative"])
        units.extend(segment_markdown(item["path"], logical_id, item["relative"], item["source_url"]))
    if len(units) > limits["max_evidence_units"]:
        raise KnowledgeCompilerError("EVIDENCE_UNIT_LIMIT_EXCEEDED", "Too many evidence units", actual=len(units))

    spans = [span for unit in units for span in segment_evidence_spans(unit)]
    anchors: list[PrimaryEvidenceAnchor] = []
    record_by_source = {record.source_id: record for record in records}
    for unit in units:
        record = record_by_source[unit.source_id]
        for locator in unit.upstream_locators:
            if record.evidence_tier == "derived-note" and locator.type == "timestamp":
                transcript = str(record.verification.details.get("transcriptPath") or "")
                transcript_path = Path(transcript) if transcript else None
                local_asset_path = None
                local_asset_sha256 = None
                if transcript_path and transcript_path.is_file() and transcript_path.is_relative_to(vault):
                    local_asset_path = transcript_path.relative_to(vault).as_posix()
                    local_asset_sha256 = sha256_file(transcript_path)
                anchors.append(
                    PrimaryEvidenceAnchor(
                        primary_anchor_id=stable_id("pa", unit.evidence_unit_id, locator.value),
                        source_id=unit.source_id,
                        evidence_unit_id=unit.evidence_unit_id,
                        anchor_type="video-timestamp",
                        locator=locator.value,
                        local_asset_path=local_asset_path,
                        local_asset_sha256=local_asset_sha256,
                        verification_status="available" if local_asset_path else "unavailable",
                    )
                )
    decisions = target / "decisions"
    decision_hashes = {
        path.relative_to(target).as_posix(): sha256_file(path)
        for path in sorted(decisions.rglob("*.md"))
        if path.is_file() and not path.is_symlink()
    } if decisions.exists() else {}
    config_hash = sha256_text(canonical_json(config))
    fingerprint = sha256_text(
        canonical_json(
            {
                "compiler_version": __version__,
                "ir_schema_version": IR_SCHEMA_VERSION,
                "config_sha256": config_hash,
                "sources": sorted(current_source_hashes.items()),
                "decisions": decision_hashes,
                "algorithm_profile": config["algorithm_profile"],
                "semantic_backend": config["semantic_backend"],
                "random_seed": config["random_seed"],
            }
        )
    )
    generated = target / "generated"
    current_generated_hashes = _generated_hashes(generated)
    expected_generated_hashes = (previous_state or {}).get("generated_file_hashes", {})
    if previous_state and current_generated_hashes != expected_generated_hashes:
        changed = sorted(set(current_generated_hashes) | set(expected_generated_hashes))
        changed = [name for name in changed if current_generated_hashes.get(name) != expected_generated_hashes.get(name)]
        raise KnowledgeCompilerError("GENERATED_DRIFT", "Generated output changed outside a publish transaction", files=changed)
    if previous_state and previous_state.get("build_fingerprint") == fingerprint:
        return {
            "ok": True,
            "status": "noop",
            "error_code": None,
            "knowledge_base": str(target),
            "build_id": previous_state.get("build_id"),
            "source_count": len(records),
            "logical_source_count": len(groups),
        }

    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    build_id = f"build_{timestamp}_{fingerprint[:12]}"
    external_root = Path(job_root).expanduser().resolve() if job_root else Path.home() / "Library" / "Caches" / "knowledge-compiler" / knowledge_base_id
    job = external_root / build_id
    if job.exists():
        raise KnowledgeCompilerError("JOB_EXISTS", f"Job directory already exists: {job}")
    job.mkdir(parents=True)
    (job / "staged-generated").mkdir()
    (job / "diagnostics").mkdir()
    write_jsonl(job / "source-registry.jsonl", records)
    write_jsonl(job / "evidence-units.jsonl", units)
    write_jsonl(job / "evidence-spans.jsonl", spans)
    write_jsonl(job / "primary-evidence-anchors.jsonl", anchors)
    units_to_process = [unit for unit in units if unit.source_id in set(changed_source_ids)]
    unit_ids_to_process = {unit.evidence_unit_id for unit in units_to_process}
    spans_to_process = [span for span in spans if span.evidence_unit_id in unit_ids_to_process]
    write_jsonl(job / "evidence-units-to-process.jsonl", units_to_process)
    write_jsonl(job / "evidence-spans-to-process.jsonl", spans_to_process)
    write_jsonl(job / "evidence-claims.candidate.jsonl", [])
    write_jsonl(job / "span-dispositions.candidate.jsonl", [])
    write_jsonl(job / "primary-support-reviews.candidate.jsonl", [])
    state = {
        "schema_version": 1,
        "stage": "prepared",
        "build_id": build_id,
        "build_fingerprint": fingerprint,
        "config_sha256": config_hash,
        "vault": str(vault),
        "knowledge_base_id": knowledge_base_id,
        "target": str(target),
        "job": str(job),
        "previous_manifest": str(target / "generated" / "manifest.json") if previous_manifest else None,
        "previous_build_id": (previous_state or {}).get("build_id"),
        "changed_source_ids": changed_source_ids,
        "deleted_source_ids": deleted_source_ids,
        "base_generated_hashes": current_generated_hashes,
        "source_hashes": {record.vault_relative_path: record.content_sha256 for record in records},
        "algorithm_profile": config["algorithm_profile"],
        "semantic_backend": config["semantic_backend"],
        "random_seed": config["random_seed"],
        "limits": limits,
    }
    atomic_write_json(job / "job-state.json", state)
    return {
        "ok": True,
        "status": "prepared",
        "error_code": None,
        "job": str(job),
        "build_id": build_id,
        "build_type": "schema-rebuild" if schema_rebuild else ("incremental" if previous_state else "full"),
        "source_count": len(records),
        "logical_source_count": len(groups),
        "evidence_unit_count": len(units),
        "evidence_span_count": len(spans),
        "units_to_process": len(units_to_process),
        "spans_to_process": len(spans_to_process),
        "changed_source_ids": changed_source_ids,
        "deleted_source_ids": deleted_source_ids,
        "next": "Write evidence-claims, span dispositions, and primary-support reviews, then validate evidence-claims.",
    }
