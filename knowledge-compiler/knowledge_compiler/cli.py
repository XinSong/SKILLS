from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from knowledge_compiler.algorithms.alignment import suggest_alignments
from knowledge_compiler.compiler.prepare import prepare
from knowledge_compiler.errors import KnowledgeCompilerError
from knowledge_compiler.publication.transaction import publish
from knowledge_compiler.validators.canonical import validate_canonical
from knowledge_compiler.validators.evaluation import validate_evaluation
from knowledge_compiler.validators.evidence import validate_evidence
from knowledge_compiler.validators.pages import validate_pages
from knowledge_compiler.verifier import verify_published


def _job(value: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_dir() or not (path / "job-state.json").is_file():
        raise argparse.ArgumentTypeError(f"Not a Knowledge Compiler job: {path}")
    return path


def _file(value: str) -> Path:
    return Path(value).expanduser().resolve()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="knowledge-compiler", description="Compile local Markdown into traceable knowledge")
    subcommands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = subcommands.add_parser("prepare", help="register Sources and create evidence work items")
    prepare_parser.add_argument("--vault", required=True)
    prepare_parser.add_argument("--knowledge-base", required=True)
    prepare_parser.add_argument("--source", action="append", default=[])
    prepare_parser.add_argument("--language")
    prepare_parser.add_argument("--job-root")

    validate_parser = subcommands.add_parser("validate", help="run a deterministic validation gate")
    validation = validate_parser.add_subparsers(dest="validation", required=True)
    evidence = validation.add_parser("evidence-claims")
    evidence.add_argument("--job", required=True, type=_job)
    evidence.add_argument("--claims", type=_file)
    canonical = validation.add_parser("canonical-claims")
    canonical.add_argument("--job", required=True, type=_job)
    canonical.add_argument("--claims", type=_file)
    pages = validation.add_parser("pages")
    pages.add_argument("--job", required=True, type=_job)
    pages.add_argument("--generated", type=_file)

    align = subcommands.add_parser("suggest-alignments", help="generate decomposed Claim alignment signals")
    align.add_argument("--job", required=True, type=_job)
    align.add_argument("--threshold", type=float, default=0.55)
    compile_parser = subcommands.add_parser("compile", help="run deterministic candidate-generation passes")
    compile_parser.add_argument("--job", required=True, type=_job)
    compile_parser.add_argument("--threshold", type=float, default=0.55)
    evaluate_parser = subcommands.add_parser("evaluate", help="validate probes and publication gates")
    evaluate_parser.add_argument("--job", required=True, type=_job)
    publish_parser = subcommands.add_parser("publish", help="atomically publish a validated job")
    publish_parser.add_argument("--job", required=True, type=_job)
    for name, help_text in [("verify", "independently verify a published knowledge base"), ("lint", "read-only verification of a knowledge base")]:
        command = subcommands.add_parser(name, help=help_text)
        command.add_argument("--vault", required=True)
        command.add_argument("--knowledge-base", required=True)
    return parser


def _dispatch(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "prepare":
        return prepare(
            vault_value=args.vault,
            knowledge_base_id=args.knowledge_base,
            source_values=args.source,
            language=args.language,
            job_root=args.job_root,
        )
    if args.command == "validate":
        if args.validation == "evidence-claims":
            return validate_evidence(args.job, args.claims)
        if args.validation == "canonical-claims":
            return validate_canonical(args.job, args.claims)
        if args.validation == "pages":
            return validate_pages(args.job, args.generated)
    if args.command in {"suggest-alignments", "compile"}:
        return suggest_alignments(args.job, args.threshold)
    if args.command == "evaluate":
        return validate_evaluation(args.job)
    if args.command == "publish":
        return publish(args.job)
    if args.command in {"verify", "lint"}:
        result = verify_published(args.vault, args.knowledge_base)
        if args.command == "lint":
            result = {**result, "status": "lint-passed", "read_only": True}
        return result
    raise KnowledgeCompilerError("UNKNOWN_COMMAND", f"Unknown command: {args.command}")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        result = _dispatch(args)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
        return 0
    except KnowledgeCompilerError as error:
        sys.stdout.write(json.dumps(error.envelope(), ensure_ascii=False, sort_keys=True, indent=2) + "\n")
        sys.stderr.write(f"{error.code}: {error.message}\n")
        return 1
    except Exception as error:
        envelope = {
            "ok": False,
            "error_code": "INTERNAL_ERROR",
            "message": str(error),
            "details": {"exception_type": type(error).__name__},
        }
        sys.stdout.write(json.dumps(envelope, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
        sys.stderr.write(f"INTERNAL_ERROR: {type(error).__name__}: {error}\n")
        return 1

