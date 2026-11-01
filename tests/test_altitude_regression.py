"""Regression tests: LOG00154.BFL actual data + official-decoder CSV units.
The real flight file is optional and is only used from BFL_TEST_FILE environment.
"""
from pathlib import Path
import os
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from blackbox_convert import convert_bytes, normalize_csv


class AltitudeRegression(unittest.TestCase):
    def test_official_csv_raw_dm_to_meters_betaflight_4(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/'flight.csv'
            p.write_text('time (s),GPS_coord[0],GPS_coord[1],GPS_numSat,GPS_altitude,GPS_speed (km/h)\n'
                         '0,40.9814,37.9618,12,1000,0\n'
                         '1,40.9814,37.9618,12,1100,25\n', encoding='utf-8')
            rows=normalize_csv(p, firmware_major=4)['samples']
        self.assertEqual(rows[0]['alt'], 100.0)
        self.assertEqual(rows[1]['alt'], 110.0)

    def test_official_csv_raw_cm_to_meters_betaflight_3(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/'flight.csv'
            p.write_text('time (s),GPS_coord[0],GPS_coord[1],GPS_numSat,GPS_altitude\n'
                         '0,40.9814,37.9618,12,10000\n'
                         '1,40.9814,37.9618,12,11000\n', encoding='utf-8')
            rows=normalize_csv(p, firmware_major=3)['samples']
        self.assertEqual(rows[0]['alt'], 100.0)
        self.assertEqual(rows[1]['alt'], 110.0)

    def test_regression_with_real_bee_bfl(self):
        source=os.environ.get('BFL_TEST_FILE')
        if not source:
            self.skipTest('BFL_TEST_FILE not set')
        raw=Path(source).read_bytes()
        # Exact same BFL must produce the same output irrespective of external
        # blackbox_decode availability, avoiding an unexpected ×10 height change.
        with patch('blackbox_convert.locate_decoder', return_value='/fake/blackbox_decode.exe'):
            one=convert_bytes(raw, 'LOG00154.BFL')
        with patch('blackbox_convert.locate_decoder', return_value=None):
            two=convert_bytes(raw, 'LOG00154.BFL')
        self.assertEqual(one['samples'], two['samples'])
        self.assertTrue(one['lite'])
        self.assertEqual(one['sampleCount'], 6294)
        altitudes=[s['alt'] for s in one['samples']]
        self.assertTrue(130 < max(altitudes) < 140)
        middle=min(one['samples'], key=lambda s:abs(s['t']-315))
        self.assertTrue(95 < middle['alt'] < 110)
        self.assertTrue(-5 < altitudes[0] < 5)
        self.assertEqual(one['metadata']['Craft name'], 'Bee')

if __name__=='__main__':
    unittest.main()
