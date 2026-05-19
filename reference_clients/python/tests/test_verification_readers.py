import tempfile
import unittest
from pathlib import Path

from tasknode_pftl.scenarios.verification_evidence_examples import write_sample_docx, write_sample_pdf
from tasknode_pftl.verification import (
    build_evidence_packet,
    classify_external_url,
    extract_gist_id,
    read_file_evidence,
)


class VerificationReaderTests(unittest.TestCase):
    def test_docx_reader_extracts_text(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "evidence.docx"
            write_sample_docx(path)
            read = read_file_evidence(path)

        self.assertEqual(read.status, "extracted")
        self.assertEqual(read.parser, "docx_zip_xml")
        self.assertIn("Task Node DOCX evidence", read.text)
        self.assertIn("canonical pf.task.evidence.v1 payload", read.text)

    def test_pdf_reader_extracts_text_with_dependency_or_fallback(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "evidence.pdf"
            write_sample_pdf(path)
            read = read_file_evidence(path)

        self.assertEqual(read.status, "extracted")
        self.assertIn(read.parser, {"pypdf", "pdf_literal_fallback"})
        self.assertIn("Task Node PDF evidence", read.text)
        self.assertIn("canonical PFTL evidence", read.text)

    def test_external_url_policy_only_validates_transport_shape(self):
        gist = "https://gist.github.com/goodalexander/d390caddb019ec3cb08748a15a97a760"
        self.assertEqual(extract_gist_id(gist), "d390caddb019ec3cb08748a15a97a760")
        self.assertTrue(classify_external_url(gist)["ok"])

        binary = classify_external_url("https://example.com/evidence.pdf")
        self.assertTrue(binary["ok"])

    def test_evidence_packet_has_canonical_shape(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "evidence.docx"
            write_sample_docx(path)
            read = read_file_evidence(path)
            packet = build_evidence_packet(read, task_id="task_1", submission_id="sub_1")

        self.assertEqual(packet["schema"], "pf.task.evidence.v1")
        self.assertEqual(packet["artifact_type"], "file")
        self.assertEqual(packet["artifact"]["status"], "extracted")
        self.assertTrue(packet["artifact"]["content_digest"].startswith("sha256:"))


if __name__ == "__main__":
    unittest.main()
