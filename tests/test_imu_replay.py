import os, unittest, statistics
from pathlib import Path
from blackbox_lite import decode_lite

class IMUFusionTests(unittest.TestCase):
    def test_real_recording_when_available(self):
        path=os.environ.get('BFL_TEST_FILE')
        if not path:self.skipTest('Set BFL_TEST_FILE for optional regression')
        data=decode_lite(Path(path).read_bytes(),Path(path).name)
        samples=data['samples']
        self.assertEqual(data['attitudeSource'],'gyro-acc-complementary')
        self.assertTrue(all('accRoll' in x and 'accPitch' in x for x in samples))
        self.assertTrue(all(-180<=x['roll']<=180 and -89<=x['pitch']<=89 for x in samples))
        def steps(k):return statistics.median(abs(b[k]-a[k]) for a,b in zip(samples,samples[1:]))
        self.assertLess(steps('pitch'), steps('accPitch'))
        self.assertLess(steps('roll'),steps('accRoll'))
