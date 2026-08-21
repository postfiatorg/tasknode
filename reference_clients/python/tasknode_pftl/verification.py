from __future__ import annotations

import base64
import html
import json
import mimetypes
import re
import time
import zipfile
import zlib
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from xml.etree import ElementTree

import requests

from .codec import canonical_json, now_iso, sha256_hex
from .config import PftlConfig
from .prompt_registry import load_prompt, prompt_digest, render_prompt


MAX_FILE_TEXT_CHARS = 40000
MAX_FILE_EXCERPT_CHARS = 4000
MAX_URL_CONTENT_BYTES = 2 * 1024 * 1024
URL_CONTENT_CAP_NON_GIST = 30000
URL_CONTENT_CAP_GIST_SINGLE_FILE = 50000
URL_CONTENT_CAP_GIST_MULTI_FILE = 100000
URL_FETCH_TIMEOUT_SECONDS = 15
SCREENSHOT_DESCRIPTION_CHARS = 4000
SCREENSHOT_EVIDENCE_PROMPT_VERSION = "evidence_screenshot_read_v1"
SCREENSHOT_EVIDENCE_PROMPT_PATH = "task_engine/evidence_screenshot_read_v1.md"

TEXT_FILE_EXTENSIONS = {
    "adoc",
    "bash",
    "c",
    "cc",
    "cfg",
    "cjs",
    "conf",
    "cpp",
    "cs",
    "css",
    "csv",
    "dockerfile",
    "env",
    "go",
    "h",
    "hpp",
    "html",
    "ini",
    "java",
    "js",
    "json",
    "jsx",
    "kt",
    "log",
    "markdown",
    "md",
    "mjs",
    "php",
    "ps1",
    "py",
    "rb",
    "rs",
    "rst",
    "sh",
    "sql",
    "swift",
    "toml",
    "ts",
    "tsx",
    "txt",
    "xml",
    "yaml",
    "yml",
    "zsh",
}


class EvidenceError(RuntimeError):
    pass


@dataclass
class EvidenceRead:
    artifact_type: str
    source_type: str
    source: dict[str, Any]
    text: str = ""
    image_description: str = ""
    status: str = "ok"
    parser: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    sha256: str | None = None
    warnings: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def excerpt(self) -> str:
        value = self.image_description or self.text
        return trim_text(value, MAX_FILE_EXCERPT_CHARS)

    def to_summary(self) -> dict[str, Any]:
        return {
            "artifact_type": self.artifact_type,
            "source_type": self.source_type,
            "source": self.source,
            "status": self.status,
            "parser": self.parser,
            "mime_type": self.mime_type,
            "size_bytes": self.size_bytes,
            "sha256": self.sha256,
            "text_excerpt": trim_text(self.text, MAX_FILE_EXCERPT_CHARS),
            "image_description": trim_text(self.image_description, SCREENSHOT_DESCRIPTION_CHARS),
            "char_count": len(self.text or self.image_description or ""),
            "warnings": self.warnings,
            "metadata": self.metadata,
        }


def trim_text(value: Any, max_chars: int) -> str:
    text = str(value or "").replace("\x00", "").strip()
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    return f"{text[:max_chars]}\n[system_note: text_truncated]"


def file_sha256(path: Path) -> str:
    return sha256_hex(path.read_bytes())


def guess_mime_type(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or "application/octet-stream"


def file_extension(path_or_name: str | Path) -> str:
    name = str(path_or_name).strip().lower()
    if "." not in name:
        return ""
    return name.rsplit(".", 1)[-1]


def strip_html_markup(value: str) -> str:
    class _TextParser(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.parts: list[str] = []
            self.skip_stack: list[str] = []

        def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
            if tag.lower() in {"script", "style", "noscript"}:
                self.skip_stack.append(tag.lower())
            if tag.lower() in {"p", "br", "li", "tr", "h1", "h2", "h3", "h4"}:
                self.parts.append("\n")

        def handle_endtag(self, tag: str) -> None:
            if self.skip_stack and self.skip_stack[-1] == tag.lower():
                self.skip_stack.pop()
            if tag.lower() in {"p", "li", "tr", "h1", "h2", "h3", "h4"}:
                self.parts.append("\n")

        def handle_data(self, data: str) -> None:
            if not self.skip_stack:
                self.parts.append(data)

    parser = _TextParser()
    parser.feed(value or "")
    parser.close()
    text = html.unescape(" ".join(parser.parts))
    return re.sub(r"\s+", " ", text).strip()


def is_text_content_type(content_type: str) -> bool:
    normalized = str(content_type or "").lower().split(";", 1)[0].strip()
    if not normalized:
        return True
    if normalized.startswith("text/"):
        return True
    return any(token in normalized for token in ("json", "xml", "javascript", "yaml", "csv"))


def is_html_content_type(content_type: str) -> bool:
    normalized = str(content_type or "").lower().split(";", 1)[0].strip()
    return normalized in {"text/html", "application/xhtml+xml"}


def looks_like_text_filename(file_name: str) -> bool:
    normalized = str(file_name or "").strip().lower()
    if normalized in {"dockerfile", ".gitignore", ".gitattributes"}:
        return True
    ext = file_extension(normalized)
    return ext in TEXT_FILE_EXTENSIONS


def classify_external_url(raw_url: str) -> dict[str, Any]:
    value = str(raw_url or "").strip()
    if not value:
        return {"ok": False, "reason": "missing_url", "message": "Provide a full public http(s) URL."}
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return {"ok": False, "reason": "invalid_url", "message": "Provide a full public http(s) URL."}
    host = parsed.hostname.lower() if parsed.hostname else ""
    return {"ok": True, "host": host, "normalized_url": value}


def _fetch_text_response(url: str, *, force_read: bool = False) -> tuple[str, str]:
    headers = {
        "accept": "text/html,application/json,text/plain,*/*;q=0.8",
        "user-agent": "TaskNodePFTLVerificationReference/0.1",
    }
    response = requests.get(url, headers=headers, timeout=URL_FETCH_TIMEOUT_SECONDS, stream=True)
    response.raise_for_status()
    content_type = response.headers.get("content-type", "")
    if not force_read and not is_text_content_type(content_type):
        return "", content_type
    content_length = int(response.headers.get("content-length") or "0")
    if content_length > MAX_URL_CONTENT_BYTES:
        return "", content_type
    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_content(chunk_size=65536):
        if not chunk:
            continue
        total += len(chunk)
        if total > MAX_URL_CONTENT_BYTES:
            return "", content_type
        chunks.append(chunk)
    return b"".join(chunks).decode(response.encoding or "utf-8", errors="replace"), content_type


def normalize_fetched_text(text: str, content_type: str) -> str:
    if is_html_content_type(content_type):
        return strip_html_markup(text)
    return trim_text(text, max(len(text), 1))


def extract_gist_id(raw_url: str) -> str:
    parsed = urlparse(str(raw_url or "").strip())
    host = (parsed.hostname or "").lower()
    parts = [part for part in parsed.path.split("/") if part]

    def is_gist_token(value: str) -> bool:
        return bool(re.fullmatch(r"[a-f0-9]{8,}", value or "", re.I))

    if host == "gist.github.com" or host.endswith(".gist.github.com"):
        for part in reversed(parts):
            if is_gist_token(part):
                return part.lower()
    if host == "gist.githubusercontent.com":
        if len(parts) >= 2 and is_gist_token(parts[1]):
            return parts[1].lower()
        for part in reversed(parts):
            if is_gist_token(part):
                return part.lower()
    return ""


def _gist_file_priority(file_info: dict[str, Any]) -> tuple[int, str]:
    filename = str(file_info.get("filename") or "").strip().lower()
    if filename == "readme" or filename.startswith("readme."):
        return (0, filename)
    if filename.endswith((".md", ".markdown")):
        return (1, filename)
    if filename.endswith((".txt", ".rst", ".adoc")):
        return (2, filename)
    return (3, filename)


def _gist_file_is_text(file_info: dict[str, Any]) -> bool:
    content_type = str(file_info.get("type") or "")
    if is_text_content_type(content_type):
        return True
    if str(file_info.get("language") or "").strip():
        return True
    return looks_like_text_filename(str(file_info.get("filename") or ""))


def _allocate_gist_lengths(entries: list[dict[str, str]], cap: int) -> dict[str, int]:
    total = sum(len(entry.get("content", "")) for entry in entries)
    if total <= cap:
        return {entry["filename"]: len(entry.get("content", "")) for entry in entries}
    allocations = {entry["filename"]: 0 for entry in entries}
    first_pass = max(200, cap // max(len(entries), 1))
    remaining = cap
    for entry in entries:
        grant = min(len(entry.get("content", "")), first_pass, remaining)
        allocations[entry["filename"]] = grant
        remaining -= grant
        if remaining <= 0:
            break
    for entry in entries:
        if remaining <= 0:
            break
        current = allocations[entry["filename"]]
        grant = min(len(entry.get("content", "")) - current, remaining)
        allocations[entry["filename"]] = current + grant
        remaining -= grant
    return allocations


def _build_gist_aggregate_text(source_url: str, gist_id: str, entries: list[dict[str, str]], non_text_files: list[str], cap: int) -> str:
    allocations = _allocate_gist_lengths(entries, cap)
    manifest = []
    sections = []
    for entry in entries:
        content = entry.get("content", "")
        included = allocations.get(entry["filename"], 0)
        omitted = max(0, len(content) - included)
        manifest.append(
            f"- {entry['filename']} | original_chars={len(content)} | included_chars={included}"
            + (f" | omitted_chars={omitted}" if omitted else "")
        )
        section = [
            f"FILE: {entry['filename']}",
            f"MIME_TYPE: {entry.get('content_type') or 'unknown'}",
            content[:included] if included else "[omitted due to aggregate budget]",
        ]
        if omitted and included:
            section.append(f"[truncated omitted_chars={omitted}]")
        sections.append("\n".join(section))
    blocks = [
        f"[GIST_CONTENT_MANIFEST] gist_id={gist_id} source_url={source_url}",
        f"[GIST_CONTENT_MANIFEST] text_files={len(entries)} budget_chars={cap}",
        f"[GIST_CONTENT_MANIFEST] non_text_files_skipped={len(non_text_files)} files={', '.join(non_text_files[:10])}" if non_text_files else "",
        "FILE_MANIFEST:\n" + "\n".join(manifest),
        "\n\n".join(sections),
    ]
    return "\n\n".join(block for block in blocks if block).strip()


def fetch_gist_aggregate_text(url: str) -> tuple[str, dict[str, Any]]:
    gist_id = extract_gist_id(url)
    if not gist_id:
        return "", {}
    api_url = f"https://api.github.com/gists/{gist_id}"
    text, _content_type = _fetch_text_response(api_url, force_read=True)
    if not text:
        return "", {"gist_id": gist_id, "status": "empty_gist_api_response"}
    payload = json.loads(text)
    files = payload.get("files") if isinstance(payload.get("files"), dict) else {}
    entries: list[dict[str, str]] = []
    non_text_files: list[str] = []
    for file_info in sorted(files.values(), key=_gist_file_priority):
        filename = str(file_info.get("filename") or "untitled").strip() or "untitled"
        if not _gist_file_is_text(file_info):
            non_text_files.append(filename)
            continue
        raw_text = ""
        content_type = str(file_info.get("type") or "")
        if file_info.get("raw_url"):
            raw_text, content_type = _fetch_text_response(str(file_info["raw_url"]), force_read=True)
        if not raw_text and isinstance(file_info.get("content"), str):
            raw_text = file_info["content"]
        normalized = normalize_fetched_text(raw_text, content_type)
        if normalized or filename:
            entries.append({"filename": filename, "content_type": content_type, "content": normalized})
    if not entries:
        return "", {"gist_id": gist_id, "status": "no_text_files", "non_text_files": non_text_files}
    cap = URL_CONTENT_CAP_GIST_MULTI_FILE if len(entries) > 1 else URL_CONTENT_CAP_GIST_SINGLE_FILE
    aggregate = _build_gist_aggregate_text(url, gist_id, entries, non_text_files, cap)
    return trim_text(aggregate, cap), {
        "gist_id": gist_id,
        "status": "ok",
        "text_file_count": len(entries),
        "non_text_files": non_text_files,
        "api_url": api_url,
    }


def read_external_url_evidence(url: str) -> EvidenceRead:
    classification = classify_external_url(url)
    if not classification.get("ok"):
        raise EvidenceError(f"{classification.get('reason')}: {classification.get('message')}")
    started = time.time()
    gist_text, gist_meta = fetch_gist_aggregate_text(url)
    if gist_text:
        text = gist_text
        parser = "github_gist_api"
        metadata = gist_meta
    else:
        raw_text, content_type = _fetch_text_response(classification["normalized_url"])
        text = normalize_fetched_text(raw_text, content_type)
        parser = "http_text_fetch"
        metadata = {"content_type": content_type}
    if not text:
        raise EvidenceError("url_content_empty_or_not_text")
    metadata["latency_ms"] = int((time.time() - started) * 1000)
    return EvidenceRead(
        artifact_type="url",
        source_type="external_url",
        source={"url": classification["normalized_url"], "host": classification.get("host")},
        text=trim_text(text, URL_CONTENT_CAP_GIST_MULTI_FILE if gist_text else URL_CONTENT_CAP_NON_GIST),
        status="extracted",
        parser=parser,
        mime_type="text/plain",
        warnings=[],
        metadata=metadata,
    )


def _decode_pdf_literal_string(value: str) -> str:
    out = []
    i = 0
    while i < len(value):
        char = value[i]
        if char != "\\":
            out.append(char)
            i += 1
            continue
        i += 1
        if i >= len(value):
            break
        escaped = value[i]
        mapping = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "(": "(", ")": ")", "\\": "\\"}
        if escaped in mapping:
            out.append(mapping[escaped])
            i += 1
            continue
        if escaped in "\n\r":
            while i < len(value) and value[i] in "\n\r":
                i += 1
            continue
        if escaped in "01234567":
            digits = escaped
            i += 1
            while i < len(value) and len(digits) < 3 and value[i] in "01234567":
                digits += value[i]
                i += 1
            out.append(chr(int(digits, 8)))
            continue
        out.append(escaped)
        i += 1
    return "".join(out)


def _extract_pdf_literal_strings(text: str) -> str:
    strings = []
    i = 0
    while i < len(text):
        if text[i] != "(":
            i += 1
            continue
        i += 1
        start = i
        depth = 1
        escaped = False
        while i < len(text) and depth > 0:
            char = text[i]
            if escaped:
                escaped = False
                i += 1
                continue
            if char == "\\":
                escaped = True
                i += 1
                continue
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    strings.append(_decode_pdf_literal_string(text[start:i]))
                    i += 1
                    break
            i += 1
    return "\n".join(part.strip() for part in strings if part.strip())


def _extract_pdf_text_fallback(data: bytes) -> str:
    streams = []
    for match in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
        raw = match.group(1)
        prefix = data[max(0, match.start() - 200):match.start()]
        if b"FlateDecode" in prefix:
            try:
                raw = zlib.decompress(raw)
            except Exception:
                pass
        streams.append(raw.decode("latin-1", errors="ignore"))
    if not streams:
        streams.append(data.decode("latin-1", errors="ignore"))
    return _extract_pdf_literal_strings("\n".join(streams))


def extract_pdf_text(path: Path) -> tuple[str, dict[str, Any]]:
    warnings: list[str] = []
    try:
        from pypdf import PdfReader  # type: ignore

        reader = PdfReader(str(path))
        text_parts = [page.extract_text() or "" for page in reader.pages]
        return "\n".join(part for part in text_parts if part).strip(), {
            "parser": "pypdf",
            "page_count": len(reader.pages),
            "warnings": warnings,
        }
    except ImportError:
        warnings.append("pypdf_not_installed_pdf_literal_fallback_used")
    except Exception as exc:
        warnings.append(f"pypdf_failed_pdf_literal_fallback_used:{type(exc).__name__}")
    text = _extract_pdf_text_fallback(path.read_bytes())
    return text.strip(), {"parser": "pdf_literal_fallback", "page_count": None, "warnings": warnings}


def extract_docx_text(path: Path) -> tuple[str, dict[str, Any]]:
    paragraph_text: list[str] = []
    xml_names = [
        "word/document.xml",
        "word/footnotes.xml",
        "word/endnotes.xml",
        "word/header1.xml",
        "word/footer1.xml",
    ]
    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with zipfile.ZipFile(path) as archive:
        present_names = set(archive.namelist())
        for name in xml_names:
            if name not in present_names:
                continue
            root = ElementTree.fromstring(archive.read(name))
            for paragraph in root.findall(".//w:p", namespace):
                parts = [node.text or "" for node in paragraph.findall(".//w:t", namespace)]
                line = "".join(parts).strip()
                if line:
                    paragraph_text.append(line)
    return "\n".join(paragraph_text), {"parser": "docx_zip_xml", "paragraph_count": len(paragraph_text), "warnings": []}


def read_file_evidence(path: str | Path, *, artifact_type: str = "file") -> EvidenceRead:
    file_path = Path(path)
    if not file_path.exists() or not file_path.is_file():
        raise EvidenceError(f"file_not_found:{file_path}")
    mime_type = guess_mime_type(file_path)
    extension = file_extension(file_path)
    size_bytes = file_path.stat().st_size
    digest = file_sha256(file_path)
    if extension == "pdf" or mime_type == "application/pdf":
        text, meta = extract_pdf_text(file_path)
    elif extension == "docx" or mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        text, meta = extract_docx_text(file_path)
    elif extension in TEXT_FILE_EXTENSIONS or mime_type.startswith("text/"):
        text = file_path.read_text(encoding="utf-8", errors="replace")
        meta = {"parser": "utf8_text", "warnings": []}
    else:
        raise EvidenceError(f"unsupported_file_evidence_type:{extension or mime_type}")
    status = "extracted" if text.strip() else "empty"
    warnings = list(meta.get("warnings") or [])
    if status == "empty":
        warnings.append("no_extractable_text")
    return EvidenceRead(
        artifact_type=artifact_type,
        source_type="file_upload",
        source={"path": str(file_path), "file_name": file_path.name},
        text=trim_text(text, MAX_FILE_TEXT_CHARS),
        status=status,
        parser=meta.get("parser"),
        mime_type=mime_type,
        size_bytes=size_bytes,
        sha256=digest,
        warnings=warnings,
        metadata={key: value for key, value in meta.items() if key not in {"parser", "warnings"}},
    )


def _image_data_url(path: Path, mime_type: str) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _extract_openai_output_text(data: dict[str, Any]) -> str:
    if isinstance(data.get("output_text"), str):
        return data["output_text"]
    output = data.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "message" and isinstance(item.get("content"), list):
                for content in item["content"]:
                    if isinstance(content, dict):
                        if isinstance(content.get("text"), str):
                            return content["text"]
                        if isinstance(content.get("output_text"), str):
                            return content["output_text"]
            if item.get("type") == "text" and isinstance(item.get("text"), str):
                return item["text"]
    return ""


def describe_screenshot_with_openai(
    path: str | Path,
    *,
    config: PftlConfig,
    task_title: str = "",
    task_description: str = "",
    verification_criteria: str = "",
    model: str | None = None,
    detail: str = "high",
) -> EvidenceRead:
    file_path = Path(path)
    if not file_path.exists() or not file_path.is_file():
        raise EvidenceError(f"file_not_found:{file_path}")
    if not config.openai_api_key:
        raise EvidenceError("OPENAI_API_KEY is required for screenshot reads")
    mime_type = guess_mime_type(file_path)
    if not mime_type.startswith("image/"):
        raise EvidenceError(f"screenshot_file_must_be_image:{mime_type}")
    prompt_template = load_prompt(SCREENSHOT_EVIDENCE_PROMPT_PATH)
    prompt = render_prompt(
        prompt_template,
        {
            "TASK_TITLE": task_title,
            "TASK_DESCRIPTION": task_description,
            "VERIFICATION_CRITERIA": verification_criteria,
        },
    )
    image_part: dict[str, Any] = {
        "type": "input_image",
        "image_url": _image_data_url(file_path, mime_type),
    }
    if detail:
        image_part["detail"] = detail
    started = time.time()
    response = requests.post(
        f"{config.openai_base_url}/responses",
        headers={
            "authorization": f"Bearer {config.openai_api_key}",
            "content-type": "application/json",
        },
        json={
            "model": model or config.verification_vision_model,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        image_part,
                    ],
                }
            ],
            "max_output_tokens": 700,
        },
        timeout=90,
    )
    if not response.ok:
        raise EvidenceError(f"openai_screenshot_read_failed:{response.status_code}:{response.text[:240]}")
    payload = response.json()
    description = trim_text(_extract_openai_output_text(payload), SCREENSHOT_DESCRIPTION_CHARS)
    if not description:
        raise EvidenceError("openai_screenshot_read_empty")
    return EvidenceRead(
        artifact_type="screenshot",
        source_type="file_upload",
        source={"path": str(file_path), "file_name": file_path.name},
        image_description=description,
        status="described",
        parser="openai_responses_vision",
        mime_type=mime_type,
        size_bytes=file_path.stat().st_size,
        sha256=file_sha256(file_path),
        metadata={
            "model": payload.get("model") or model or config.verification_vision_model,
            "response_id": payload.get("id"),
            "latency_ms": int((time.time() - started) * 1000),
            "detail": detail,
            "prompt_version": SCREENSHOT_EVIDENCE_PROMPT_VERSION,
            "prompt_digest": prompt_digest(prompt_template),
        },
    )


def build_evidence_packet(
    read: EvidenceRead,
    *,
    task_id: str,
    submission_id: str,
    phase: str = "verification_response",
    response_text: str | None = None,
) -> dict[str, Any]:
    body_text = response_text or read.excerpt
    artifact = read.to_summary()
    artifact["content_digest"] = "sha256:" + sha256_hex({
        "source": read.source,
        "text": read.text,
        "image_description": read.image_description,
        "sha256": read.sha256,
    })
    return {
        "schema": "pf.task.evidence.v1",
        "evidence_schema": "pf.task.evidence_artifact.v1",
        "task_id": task_id,
        "submission_id": submission_id,
        "phase": phase,
        "artifact_type": read.artifact_type,
        "response": trim_text(body_text, MAX_FILE_EXCERPT_CHARS),
        "artifact": artifact,
        "created_at": now_iso(),
    }


def build_verification_response_packet(
    *,
    task_id: str,
    submission_id: str,
    evidence_packets: list[dict[str, Any]],
    actor_wallet: str = "rExampleUserWallet",
    subject_wallet: str = "rExampleUserWallet",
    response_text: str = "Verification evidence packet prepared.",
) -> dict[str, Any]:
    evidence_refs = []
    for index, packet in enumerate(evidence_packets, start=1):
        evidence_refs.append({
            "index": index,
            "artifact_type": packet.get("artifact_type"),
            "evidence_digest": "sha256:" + sha256_hex(packet),
            "source": (packet.get("artifact") or {}).get("source"),
            "status": (packet.get("artifact") or {}).get("status"),
        })
    return {
        "schema": "pf.task.verification_response.v1",
        "protocol": "tasknode.pftl",
        "created_at": now_iso(),
        "task_id": task_id,
        "submission_id": submission_id,
        "actor_wallet": actor_wallet,
        "subject_wallet": subject_wallet,
        "phase": "verification_response",
        "response_text": response_text,
        "artifact_type": "mixed" if len(evidence_packets) > 1 else evidence_packets[0].get("artifact_type", "unknown"),
        "evidence_refs": evidence_refs,
        "evidence_packet_count": len(evidence_packets),
    }


def evidence_packet_digest(packet: dict[str, Any]) -> str:
    return "sha256:" + sha256_hex(canonical_json(packet))
