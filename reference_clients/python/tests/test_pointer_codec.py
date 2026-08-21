import unittest

from tasknode_pftl.pointers import Pointer, build_memo, decode_pointer, encode_pointer


class PointerCodecTests(unittest.TestCase):
    def test_encode_decode_task_pointer(self):
        pointer = Pointer(
            cid="bafkreitestcid",
            kind="TASK_SUBMISSION",
            schema=1,
            task_id="task_abc",
        )
        decoded = decode_pointer(encode_pointer(pointer))
        self.assertEqual(decoded["cid"], "bafkreitestcid")
        self.assertEqual(decoded["kind"], "TASK_SUBMISSION")
        self.assertEqual(decoded["schema"], 1)
        self.assertEqual(decoded["task_id"], "task_abc")
        self.assertEqual(decoded["flags"], 1)

    def test_build_memo_uses_pf_ptr_v4(self):
        memo = build_memo(Pointer(cid="bafkreitestcid", kind="REWARD", schema=1, task_id="task_abc"))
        self.assertEqual(bytes.fromhex(memo["memo_type"]).decode("utf-8"), "pf.ptr")
        self.assertEqual(bytes.fromhex(memo["memo_format"]).decode("utf-8"), "v4")
        self.assertTrue(memo["memo_data"])


if __name__ == "__main__":
    unittest.main()

