#!/usr/bin/env python3
"""Parse a Claude Code NDJSON session log into per-turn files.

Filters to: user prompts, assistant text replies, and configured tool
calls/results. Strips screenshot image blobs to a short placeholder.

Usage:
    parse_claude_conversation.py <session.jsonl> [output_dir] \\
        [--tool-prefix=mcp__mobilebuildmcp] [--tool-name=Bash]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


IMAGE_PLACEHOLDER = "<image-data-stripped>"


def short_tool_name(full_name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]+", "_", full_name.split("__")[-1]).strip("_") or "tool"


def strip_images(value):
    """Recursively replace base64 image payloads with a short placeholder."""
    if isinstance(value, dict):
        if value.get("type") == "image" and isinstance(value.get("source"), dict):
            src = value["source"]
            if "data" in src and isinstance(src["data"], str) and len(src["data"]) > 64:
                src = {**src, "data": IMAGE_PLACEHOLDER}
            return {**value, "source": src}
        return {k: strip_images(v) for k, v in value.items()}
    if isinstance(value, list):
        return [strip_images(v) for v in value]
    if isinstance(value, str) and len(value) > 4096 and value.startswith("/9j/"):
        return IMAGE_PLACEHOLDER
    return value


def _try_parse_json_string(s: str):
    """If s is a JSON object/array encoded as a string, return parsed value."""
    if not isinstance(s, str):
        return None
    stripped = s.lstrip()
    if not stripped or stripped[0] not in "{[":
        return None
    try:
        return json.loads(s)
    except (json.JSONDecodeError, ValueError):
        return None


def unwrap_embedded_json(value):
    """Recursively decode JSON-encoded strings so they pretty-print as objects."""
    if isinstance(value, dict):
        return {k: unwrap_embedded_json(v) for k, v in value.items()}
    if isinstance(value, list):
        return [unwrap_embedded_json(v) for v in value]
    if isinstance(value, str):
        parsed = _try_parse_json_string(value)
        if parsed is not None:
            return unwrap_embedded_json(parsed)
    return value


def render_content(content) -> str:
    content = unwrap_embedded_json(content)
    if isinstance(content, str):
        return content
    return json.dumps(content, indent=2, ensure_ascii=False)


def is_real_user_message(entry: dict) -> bool:
    """A user prompt (not a synthetic tool_result echo)."""
    msg = entry.get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return True
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") in ("tool_result",):
                return False
            if isinstance(block, dict) and "tool_use_id" in block:
                return False
        return any(isinstance(b, dict) and b.get("type") == "text" for b in content)
    return False


def extract_user_text(entry: dict) -> str:
    content = entry["message"]["content"]
    if isinstance(content, str):
        return content
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "\n\n".join(parts)


def matches_tool_name(name: str, tool_prefixes: list[str], tool_names: set[str]) -> bool:
    return name in tool_names or any(name.startswith(prefix) for prefix in tool_prefixes)


def parse(path: Path, out_dir: Path, tool_prefixes: list[str], tool_names: set[str]) -> bool:
    out_dir.mkdir(parents=True, exist_ok=True)

    # Track tool_use_ids that target configured tools so we keep matching results.
    tracked_ids: set[str] = set()
    tool_name_by_id: dict[str, str] = {}
    counter = 0
    had_errors = False

    def next_path(kind: str, label: str | None = None) -> Path:
        nonlocal counter
        counter += 1
        suffix = f"_{label}" if label else ""
        return out_dir / f"{counter:04d}_{kind}{suffix}.md"

    with path.open("r", encoding="utf-8") as f:
        for line_no, raw in enumerate(f, 1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                entry = json.loads(raw)
            except json.JSONDecodeError as exc:
                print(f"warn: skipping line {line_no}: {exc}", file=sys.stderr)
                had_errors = True
                continue

            etype = entry.get("type")
            ts = entry.get("timestamp", "")

            if etype == "user":
                if is_real_user_message(entry):
                    text = extract_user_text(entry).strip()
                    if not text:
                        continue
                    p = next_path("user_message")
                    p.write_text(
                        f"# user_message\n\n_timestamp_: {ts}\n\n---\n\n{text}\n",
                        encoding="utf-8",
                    )
                    continue

                # tool_result branch — keep only those matching tracked tool ids.
                content = entry.get("message", {}).get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    tool_id = block.get("tool_use_id")
                    if not tool_id or tool_id not in tracked_ids:
                        continue
                    name = tool_name_by_id.get(tool_id, "tool")
                    clean = strip_images(block.get("content"))
                    p = next_path("tool_result", short_tool_name(name))
                    body = (
                        f"# tool_result: {name}\n\n"
                        f"_timestamp_: {ts}\n"
                        f"_tool_use_id_: {tool_id}\n\n"
                        f"---\n\n"
                        f"```json\n{render_content(clean)}\n```\n"
                    )
                    p.write_text(body, encoding="utf-8")
                continue

            if etype == "assistant":
                content = entry.get("message", {}).get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type")
                    if btype == "text":
                        text = (block.get("text") or "").strip()
                        if not text:
                            continue
                        p = next_path("assistant_message")
                        p.write_text(
                            f"# assistant_message\n\n_timestamp_: {ts}\n\n---\n\n{text}\n",
                            encoding="utf-8",
                        )
                    elif btype == "tool_use":
                        name = block.get("name", "")
                        if not matches_tool_name(name, tool_prefixes, tool_names):
                            continue
                        tool_id = block.get("id", "")
                        tracked_ids.add(tool_id)
                        tool_name_by_id[tool_id] = name
                        inputs = unwrap_embedded_json(strip_images(block.get("input", {})))
                        p = next_path("tool_call", short_tool_name(name))
                        body = (
                            f"# tool_call: {name}\n\n"
                            f"_timestamp_: {ts}\n"
                            f"_tool_use_id_: {tool_id}\n\n"
                            f"---\n\n"
                            f"```json\n{json.dumps(inputs, indent=2, ensure_ascii=False)}\n```\n"
                        )
                        p.write_text(body, encoding="utf-8")
                continue

            # everything else (system, attachment, permission-mode, ai-title,
            # last-prompt, file-history-snapshot, thinking blocks) is dropped.

    print(f"Wrote {counter} files to {out_dir}")
    return not had_errors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("jsonl", type=Path, help="Path to session NDJSON file")
    ap.add_argument(
        "output",
        type=Path,
        nargs="?",
        help="Output directory (default: <jsonl-stem>_conversation next to input)",
    )
    ap.add_argument(
        "--tool-prefix",
        action="append",
        default=None,
        help="Only include tool calls whose name starts with this prefix",
    )
    ap.add_argument(
        "--tool-name",
        action="append",
        default=[],
        help="Also include tool calls whose name exactly matches this value",
    )
    args = ap.parse_args()

    if not args.jsonl.is_file():
        print(f"error: not a file: {args.jsonl}", file=sys.stderr)
        return 1

    out = args.output or args.jsonl.with_name(f"{args.jsonl.stem}_conversation")
    tool_prefixes = args.tool_prefix or ["mcp__mobilebuildmcp"]
    return 0 if parse(args.jsonl, out, tool_prefixes, set(args.tool_name)) else 1


if __name__ == "__main__":
    raise SystemExit(main())
