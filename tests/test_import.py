"""Offline normalized CSV fixture and local HTTP import smoke tests."""
from pathlib import Path
import io
import tempfile
import unittest
import sys
import urllib.error
import urllib.request
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from blackbox_convert import normalize_csv, ConvertError

ROOT = Path(__file__).resolve().parents[1]


def fake_csv(with_gps=True):
    header='time (s), GPS_coord[0], GPS_coord[1], GPS_numSat, GPS_altitude, GPS_speed (km/h), GPS_ground_course, roll (deg), pitch (deg), heading (deg), vbatLatest (V), rcCommand[3]\\n'
    header=header.replace('\\n','\n')
    records=[]
    for i in range(41):
        t=.13*i
        lat,lon,sats=(40.984+i*.00001,37.885+i*.00002,13) if with_gps else (0,0,0)
        records.append(f'{t:.3f}, {lat:.7f}, {lon:.7f}, {sats}, 180, 72.4, 108.1, -4.2, 9.2, 67.9, 23.6, 1440')
    return header+'\n'.join(records)+'\n'


class Tests(unittest.TestCase):
    def test_normalization(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'flight.01.csv';path.write_text(fake_csv())
            data=normalize_csv(path)
        self.assertTrue(data['gps'])
        self.assertGreater(data['duration'],5)
        self.assertAlmostEqual(data['samples'][-1]['speed'],72.4)
        self.assertEqual(data['samples'][0]['throttle'],44)
        self.assertAlmostEqual(data['samples'][0]['heading'],108.1)
        self.assertAlmostEqual(data['samples'][0]['yaw'],67.9)

    def test_no_gps(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'flight.01.csv';path.write_text(fake_csv(False))
            data=normalize_csv(path)
        self.assertFalse(data['gps'])
        self.assertTrue(all(s['lat'] is None and s['lon'] is None for s in data['samples']))
        self.assertAlmostEqual(data['samples'][0]['pitch'],9.2)

if __name__=='__main__':unittest.main()
