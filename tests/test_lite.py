"""Optional full-file regression: set BFL_TEST_FILE to a locally available BFL."""
import os
from pathlib import Path
import unittest
from blackbox_lite import decode_lite, LiteDecodeError

class LiteParserTests(unittest.TestCase):
    def test_unsupported_input(self):
        with self.assertRaises(LiteDecodeError):
            decode_lite(b'nonsense', 'not-bfl.txt')
    def test_actual_file_if_provided(self):
        file=os.environ.get('BFL_TEST_FILE')
        if not file: self.skipTest('No private BFL file supplied for this optional test')
        data=decode_lite(Path(file).read_bytes(),Path(file).name)
        self.assertGreater(data['sampleCount'],6000)
        self.assertGreater(data['duration'],650)
        self.assertGreater(max(s['speed'] for s in data['samples']),100)
        self.assertTrue(all(s['voltage'] is not None for s in data['samples']))
