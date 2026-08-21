from __future__ import annotations

import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from tasknode_pftl.codec import now_iso, sha256_hex
from tasknode_pftl.config import PftlConfig
from tasknode_pftl.verification import (
    EvidenceError,
    EvidenceRead,
    build_evidence_packet,
    describe_screenshot_with_openai,
    read_external_url_evidence,
    read_file_evidence,
)


SUPPORTED_EVIDENCE_TYPES = {"text", "url", "github_commit", "screenshot", "file", "mixed", "code"}


@dataclass
class EvidencePlan:
    artifact_type: str = "url"
    url: str = ""
    path: str | None = None
    response_text: str | None = None
    faulty: bool = False
    screenshot_detail: str = "high"


def normalize_evidence_type(value: str | None) -> str:
    normalized = str(value or "url").strip().lower().replace("-", "_")
    if normalized not in SUPPORTED_EVIDENCE_TYPES:
        raise EvidenceError(f"unsupported_evidence_type:{normalized or 'missing'}")
    return normalized


def read_evidence(
    *,
    config: PftlConfig,
    run_dir: Path,
    task_offer: dict[str, Any],
    plan: EvidencePlan,
    phase: str,
) -> list[EvidenceRead]:
    artifact_type = normalize_evidence_type(plan.artifact_type)
    if artifact_type == "mixed":
        if not plan.url:
            raise EvidenceError("mixed_evidence_url_required")
        return [
            read_evidence(config=config, run_dir=run_dir, task_offer=task_offer, plan=EvidencePlan("url", url=plan.url), phase=phase)[0],
            read_evidence(config=config, run_dir=run_dir, task_offer=task_offer, plan=EvidencePlan("screenshot"), phase=phase)[0],
            text_evidence_read(plan.response_text or required_text_evidence(plan, phase)),
        ]
    if artifact_type in {"url", "github_commit"}:
        if not plan.url:
            raise EvidenceError(f"{artifact_type}_evidence_url_required")
        return [read_external_url_evidence(plan.url)]
    if artifact_type == "screenshot":
        path = Path(plan.path) if plan.path else ensure_sample_inputs(run_dir)["screenshot"]
        return [
            describe_screenshot_with_openai(
                path,
                config=config,
                task_title=str(task_offer.get("title") or ""),
                task_description=str(task_offer.get("description") or ""),
                verification_criteria=str((task_offer.get("submission_requirement") or {}).get("criteria") or ""),
                detail=plan.screenshot_detail,
            )
        ]
    if artifact_type == "file":
        path = Path(plan.path) if plan.path else ensure_sample_inputs(run_dir)["pdf"]
        return [read_file_evidence(path, artifact_type="file")]
    if artifact_type == "code":
        path = Path(plan.path) if plan.path else ensure_sample_inputs(run_dir)["code"]
        return [read_file_evidence(path, artifact_type="code")]
    return [text_evidence_read(plan.response_text or required_text_evidence(plan, phase))]


def build_evidence_packets(
    *,
    reads: list[EvidenceRead],
    task_id: str,
    submission_id: str,
    phase: str,
    response_text: str | None = None,
) -> list[dict[str, Any]]:
    return [
        build_evidence_packet(
            read,
            task_id=task_id,
            submission_id=submission_id,
            phase=phase,
            response_text=response_text,
        )
        for read in reads
    ]


def processed_evidence_summary(reads: list[EvidenceRead], packets: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema": "pf.task.processed_evidence.v1",
        "generated_at": now_iso(),
        "artifact_count": len(reads),
        "artifacts": [
            {
                "artifact_type": read.artifact_type,
                "source_type": read.source_type,
                "source": read.source,
                "status": read.status,
                "parser": read.parser,
                "mime_type": read.mime_type,
                "sha256": read.sha256,
                "excerpt": read.excerpt,
                "metadata": read.metadata,
            }
            for read in reads
        ],
        "packet_digests": ["sha256:" + sha256_hex(packet) for packet in packets],
    }


def text_evidence_read(text: str) -> EvidenceRead:
    return EvidenceRead(
        artifact_type="text",
        source_type="inline_text",
        source={"origin": "codex_reference_client"},
        text=text,
        status="extracted",
        parser="inline_text",
        mime_type="text/plain",
        size_bytes=len(text.encode("utf-8")),
        sha256=sha256_hex(text),
    )


def required_text_evidence(plan: EvidencePlan, phase: str) -> str:
    if plan.faulty:
        return "I did something unrelated and cannot provide the requested artifact."
    raise EvidenceError(f"{phase}_text_response_required")


def ensure_sample_inputs(output_dir: Path) -> dict[str, Path]:
    inputs_dir = output_dir / "evidence"
    screenshot = inputs_dir / "canonical-screenshot.png"
    pdf = inputs_dir / "canonical-evidence.pdf"
    docx = inputs_dir / "canonical-evidence.docx"
    code = inputs_dir / "canonical-code-sample.py"
    if not screenshot.exists():
        write_sample_screenshot(screenshot)
    if not pdf.exists():
        write_sample_pdf(pdf)
    if not docx.exists():
        write_sample_docx(docx)
    if not code.exists():
        code.parent.mkdir(parents=True, exist_ok=True)
        code.write_text(
            "\n".join([
                "def tasknode_verification_digest(task_id: str, cid: str, tx_hash: str) -> str:",
                "    import hashlib",
                "    return hashlib.sha256(f'{task_id}:{cid}:{tx_hash}'.encode()).hexdigest()",
                "",
            ]),
            encoding="utf-8",
        )
    return {"screenshot": screenshot, "pdf": pdf, "docx": docx, "code": code}


def _xml_escape(value: str) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def write_sample_docx(path: Path) -> None:
    paragraphs = [
        "Task Node DOCX evidence",
        "This file proves DOCX evidence can be read outside the web app.",
        "Result: DOCX evidence becomes a canonical pf.task.evidence.v1 payload.",
    ]
    document_body = "".join(
        f"<w:p><w:r><w:t>{_xml_escape(paragraph)}</w:t></w:r></w:p>"
        for paragraph in paragraphs
    )
    files = {
        "[Content_Types].xml": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>""",
        "_rels/.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>""",
        "word/document.xml": f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>{document_body}</w:body>
</w:document>""",
        "word/_rels/document.xml.rels": """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>""",
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)


def _pdf_escape(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def write_sample_pdf(path: Path) -> None:
    lines = [
        "Task Node PDF evidence",
        "The Python task engine extracted this PDF evidence.",
        "Result: PDF evidence can be scored and rewarded.",
    ]
    stream_lines = ["BT", "/F1 13 Tf", "72 740 Td"]
    for index, line in enumerate(lines):
        if index > 0:
            stream_lines.append("0 -22 Td")
        stream_lines.append(f"({_pdf_escape(line)}) Tj")
    stream_lines.append("ET")
    stream = "\n".join(stream_lines).encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    output = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(obj)
        output.extend(b"\nendobj\n")
    xref_offset = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Root 1 0 R /Size {len(objects) + 1} >>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(output))


def write_sample_screenshot(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (1100, 680), "#f7f8fb")
    draw = ImageDraw.Draw(image)
    try:
        title_font = ImageFont.truetype("DejaVuSans-Bold.ttf", 34)
        body_font = ImageFont.truetype("DejaVuSans.ttf", 22)
        mono_font = ImageFont.truetype("DejaVuSansMono.ttf", 20)
    except Exception:
        title_font = body_font = mono_font = ImageFont.load_default()

    draw.rectangle((0, 0, 1100, 78), fill="#111827")
    draw.text((32, 22), "Task Node Evidence Submission", fill="#ffffff", font=title_font)
    draw.rounded_rectangle((42, 118, 1058, 610), radius=18, fill="#ffffff", outline="#d7dce5", width=2)
    draw.text((78, 154), "Canonical screenshot evidence", fill="#111827", font=title_font)
    rows = [
        ("Task", "Submit visible proof for the PFTL task engine"),
        ("Status", "Completed"),
        ("Evidence type", "screenshot"),
        ("Visible proof", "Green completed state and verification digest"),
        ("Task ID", "task_demo_screenshot_001"),
        ("Digest", "sha256:9d4c...2be1"),
    ]
    y = 220
    for label, value in rows:
        draw.text((92, y), label, fill="#5b6472", font=body_font)
        draw.text((290, y), value, fill="#111827", font=mono_font if label in {"Task ID", "Digest"} else body_font)
        y += 54
    draw.rounded_rectangle((820, 148, 1014, 208), radius=14, fill="#166534")
    draw.text((852, 164), "Verified", fill="#ffffff", font=body_font)
    image.save(path, format="PNG")
