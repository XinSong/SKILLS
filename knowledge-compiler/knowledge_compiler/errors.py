from __future__ import annotations

from typing import Any


class KnowledgeCompilerError(RuntimeError):
    """Expected, stable failure returned by the CLI."""

    def __init__(self, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details

    def envelope(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "ok": False,
            "error_code": self.code,
            "message": self.message,
        }
        if self.details:
            result["details"] = self.details
        return result

