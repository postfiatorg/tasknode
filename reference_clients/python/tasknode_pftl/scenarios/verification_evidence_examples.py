from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from tasknode_pftl.codec import now_iso, sha256_hex, short
from tasknode_pftl.config import PftlConfig
from tasknode_pftl.verification import (
    build_evidence_packet,
    build_verification_response_packet,
    describe_screenshot_with_openai,
    read_external_url_evidence,
    read_file_evidence,
)


ROOT = Path(__file__).resolve().parents[2]
RUNS_DIR = ROOT / "runs"
DEFAULT_URL = "https://gist.github.com/goodalexander/d390caddb019ec3cb08748a15a97a760"


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True), encoding="utf-8")


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
        "The verification engine extracted this DOCX without using the web app.",
        "Result: DOCX file evidence can become a canonical pf.task.evidence.v1 payload.",
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
        "The verification engine extracted this PDF for canonical PFTL evidence.",
        "Result: PDF file evidence can be summarized and hashed.",
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
    draw.text((32, 22), "Task Node Verification Surface", fill="#ffffff", font=title_font)
    draw.rounded_rectangle((42, 118, 1058, 610), radius=18, fill="#ffffff", outline="#d7dce5", width=2)
    draw.text((78, 154), "Canonical evidence packet", fill="#111827", font=title_font)
    rows = [
        ("Task", "Read screenshot evidence into pf.task.evidence.v1"),
        ("Status", "Completed"),
        ("Evidence type", "screenshot"),
        ("Visible proof", "Green completed state, task id, and verification digest"),
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


def ensure_sample_inputs(output_dir: Path) -> dict[str, Path]:
    inputs_dir = output_dir / "inputs"
    screenshot = inputs_dir / "verification-screenshot.png"
    pdf = inputs_dir / "verification-evidence.pdf"
    docx = inputs_dir / "verification-evidence.docx"
    if not screenshot.exists():
        write_sample_screenshot(screenshot)
    if not pdf.exists():
        write_sample_pdf(pdf)
    if not docx.exists():
        write_sample_docx(docx)
    return {"screenshot": screenshot, "pdf": pdf, "docx": docx}


def build_markdown_receipt(receipt: dict[str, Any]) -> str:
    lines = [
        "# PFTL Verification Evidence Examples",
        "",
        f"Run ID: `{receipt['run_id']}`",
        f"Generated: `{receipt['generated_at']}`",
        "",
        "These examples produce canonical `pf.task.evidence.v1` packets that can be encrypted, pinned to IPFS, and referenced by a `pf.task.verification_response.v1` pointer.",
        "",
        "## Evidence Reads",
    ]
    for name, summary in receipt["reads"].items():
        source = summary.get("source") or {}
        lines.extend([
            "",
            f"### {name}",
            "",
            f"- Status: `{summary.get('status')}`",
            f"- Parser: `{summary.get('parser')}`",
            f"- Source: `{source.get('url') or source.get('file_name') or source.get('path')}`",
            f"- SHA-256: `{summary.get('sha256') or 'n/a'}`",
            "",
            "Excerpt:",
            "",
            "```text",
            (summary.get("image_description") or summary.get("text_excerpt") or "").strip()[:1600],
            "```",
        ])
    lines.extend([
        "",
        "## Verification Response",
        "",
        f"- Artifact type: `{receipt['verification_response'].get('artifact_type')}`",
        f"- Evidence packet count: `{receipt['verification_response'].get('evidence_packet_count')}`",
        "",
        "Evidence refs:",
    ])
    for ref in receipt["verification_response"].get("evidence_refs", []):
        lines.append(f"- `{ref['artifact_type']}` `{ref['evidence_digest']}`")
    return "\n".join(lines).strip() + "\n"


def run_examples(args: argparse.Namespace) -> dict[str, Any]:
    config = PftlConfig.from_env()
    run_id = args.run_id or f"verification_examples_{now_iso().replace(':', '').replace('.', '').replace('Z', '')}"
    output_dir = Path(args.output_dir) if args.output_dir else RUNS_DIR / run_id
    output_dir.mkdir(parents=True, exist_ok=True)
    sample_inputs = ensure_sample_inputs(output_dir)

    screenshot_path = Path(args.screenshot_path) if args.screenshot_path else sample_inputs["screenshot"]
    pdf_path = Path(args.pdf_path) if args.pdf_path else sample_inputs["pdf"]
    docx_path = Path(args.docx_path) if args.docx_path else sample_inputs["docx"]
    task_id = args.task_id or "task_verification_examples_001"
    submission_id = args.submission_id or f"sub_{sha256_hex(run_id)[:24]}"

    reads = {
        "external_url": read_external_url_evidence(args.url),
        "pdf": read_file_evidence(pdf_path, artifact_type="file"),
        "docx": read_file_evidence(docx_path, artifact_type="file"),
        "screenshot": describe_screenshot_with_openai(
            screenshot_path,
            config=config,
            task_title="Read screenshot evidence into canonical PFTL verification",
            task_description="Verify that screenshot evidence can be transformed into a replayable evidence packet.",
            verification_criteria="The description should capture visible status, task identity, and proof signal.",
            model=args.vision_model,
            detail=args.vision_detail,
        ),
    }

    evidence_packets = {
        name: build_evidence_packet(
            read,
            task_id=task_id,
            submission_id=submission_id,
            response_text=(
                f"{name} evidence was read successfully by the Python PFTL verification engine."
            ),
        )
        for name, read in reads.items()
    }
    verification_response = build_verification_response_packet(
        task_id=task_id,
        submission_id=submission_id,
        evidence_packets=list(evidence_packets.values()),
        response_text="Screenshot, PDF, DOCX, and public URL evidence were read and normalized.",
    )

    packet_dir = output_dir / "packets"
    for name, packet in evidence_packets.items():
        write_json(packet_dir / f"{name}_evidence_packet.json", packet)
    write_json(packet_dir / "verification_response_packet.json", verification_response)

    receipt = {
        "run_id": run_id,
        "generated_at": now_iso(),
        "task_id": task_id,
        "submission_id": submission_id,
        "inputs": {name: str(path) for name, path in {
            "screenshot": screenshot_path,
            "pdf": pdf_path,
            "docx": docx_path,
        }.items()},
        "url": args.url,
        "reads": {name: read.to_summary() for name, read in reads.items()},
        "evidence_packet_digests": {
            name: "sha256:" + sha256_hex(packet) for name, packet in evidence_packets.items()
        },
        "verification_response": verification_response,
        "pftl_pointer_note": (
            "Each evidence packet is ready to encrypt/pin as TASK_SUBMISSION content; "
            "the verification_response packet is the payload a user wallet would point to on PFTL."
        ),
    }
    write_json(output_dir / "verification_examples_receipt.json", receipt)
    (output_dir / "verification_examples.md").write_text(build_markdown_receipt(receipt), encoding="utf-8")

    print("Verification evidence examples complete")
    print(f"  run_id: {run_id}")
    print(f"  output_dir: {output_dir}")
    for name, read in reads.items():
        digest = short(read.sha256 or sha256_hex(read.excerpt))
        print(f"  {name}: {read.status} via {read.parser} digest={digest}")
    print(f"  receipt: {output_dir / 'verification_examples_receipt.json'}")
    print(f"  markdown: {output_dir / 'verification_examples.md'}")
    return receipt


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run screenshot, PDF, DOCX, and URL evidence readers.")
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--task-id", default=None)
    parser.add_argument("--submission-id", default=None)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--screenshot-path", default=None)
    parser.add_argument("--pdf-path", default=None)
    parser.add_argument("--docx-path", default=None)
    parser.add_argument("--vision-model", default=None)
    parser.add_argument("--vision-detail", default="high", choices=["low", "high", "auto", "original"])
    return parser.parse_args()


def main() -> None:
    run_examples(parse_args())


if __name__ == "__main__":
    main()
