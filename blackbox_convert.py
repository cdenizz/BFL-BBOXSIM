"""Read Betaflight BFL/BBL/TXT using the official blackbox_decode executable.

The official decoder is an external optional dependency, not bundled here.
Only local uploaded files are processed; no uploads leave localhost.
"""
from __future__ import annotations
import csv
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

MAX_FILE_BYTES = 150 * 1024 * 1024

class ConvertError(Exception):
    pass


def locate_decoder() -> str | None:
    here = Path(__file__).resolve().parent
    candidates = [here / 'tools' / 'blackbox_decode.exe', here / 'tools' / 'blackbox_decode',
                  here / 'blackbox_decode.exe', here / 'blackbox_decode']
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return shutil.which('blackbox_decode') or shutil.which('blackbox_decode.exe')


def canonical(col):
    return re.sub(r'[^a-z0-9]+', '', col.lower())


def parse_float(value):
    try:
        v = float(str(value).strip())
        return v if math.isfinite(v) else None
    except (ValueError, TypeError):
        return None


def field(row, headings, *aliases):
    for alias in aliases:
        k = canonical(alias)
        for item, original in headings.items():
            if item == k:
                return parse_float(row.get(original))
    return None


def scaled_coords(v, latitude):
    if v is None:
        return None
    if abs(v) > (90 if latitude else 180):
        v /= 1e7  # raw Betaflight GPS_coord
    return v if ((-90 <= v <= 90) if latitude else (-180 <= v <= 180)) else None


def normalize_csv(csvpath: Path, firmware_major: int | None = None) -> dict:
    samples = []
    with csvpath.open(encoding='utf-8-sig', newline='', errors='replace') as f:
        reader = csv.DictReader(f, skipinitialspace=True)
        if not reader.fieldnames:
            raise ConvertError('Decoder CSV başlığı boş.')
        headers = {canonical(k): k for k in reader.fieldnames if k}
        timeheader = next((k for k in reader.fieldnames if canonical(k) in ('times','timeus','timems','time')), None)
        if timeheader is None:
            raise ConvertError('Blackbox kaydında zaman alanı bulunamadı.')
        headlow = timeheader.lower()
        divisor = 1e6 if ('us' in headlow or '(µs)' in headlow or 'micro' in headlow) else 1000 if 'ms' in headlow else 1.0
        start = None
        last = -1e10
        total_rows = 0
        gps_count = 0
        for row in reader:
            total_rows += 1
            absolute = parse_float(row.get(timeheader))
            if absolute is None:
                continue
            absolute /= divisor
            if start is None:
                start = absolute
            t = absolute - start
            if t < 0 or t <= last or (t-last < .10):
                continue
            lat = field(row, headers, 'GPS_coord[0]', 'gpsLat', 'lat')
            lon = field(row, headers, 'GPS_coord[1]', 'gpsLon', 'lon')
            lat = scaled_coords(lat, True)
            lon = scaled_coords(lon, False)
            sats = field(row, headers, 'GPS_numSat', 'GPS_numSatellites')
            valid = lat is not None and lon is not None and not (lat == 0 and lon == 0) and (sats is None or sats >= 5)
            if valid:
                gps_count += 1
            track = field(row, headers, 'GPS_ground_course', 'gpsGroundCourse')
            if track is not None and abs(track) > 360:
                track /= 10
            gs = field(row, headers, 'GPS_speed (km/h)', 'GPS_speed (kph)', 'GPS_speed')
            if gs is not None and gs > 3000:
                gs /= 100 # raw cm/s -> m/s, not kph; decoder normally --unit-gps-speed kph
                gs *= 3.6
            # Main stream attitude fields are simulated by the official decoder when sensors support it.
            roll = field(row, headers, 'roll (deg)', 'roll')
            pitch = field(row, headers, 'pitch (deg)', 'pitch')
            yaw = field(row, headers, 'heading (deg)', 'heading')
            # Always prioritize GPS ground course for geo heading. Simulated IMU yaw may have no absolute north reference.
            angle = track if track is not None else None
            voltage = field(row, headers, 'vbatLatest (V)', 'vbatLatest', 'vbat (V)', 'vbat')
            throttle = field(row, headers, 'rcCommand[3]', 'rcCommands[3]', 'throttle')
            if throttle is not None:
                if throttle >= 900:
                    throttle = (throttle - 1000) / 10
                elif throttle < 0:
                    throttle = None
                if throttle is not None: throttle = max(0, min(100, throttle))
            gps_alt = field(row, headers, 'GPS_altitude', 'gpsAltitude')
            baro_alt = field(row, headers, 'BaroAlt (m)', 'BaroAlt')
            # In the official blackbox_decode merged CSV, GPS_altitude is emitted
            # in raw logging units despite --unit-height=m (only BaroAlt uses
            # the height formatting flag). Betaflight >=4 stores decimeters.
            # Older Betaflight stored centimeters. Do NOT treat raw as meters.
            if valid and gps_alt is not None:
                factor = .1 if firmware_major is not None and firmware_major >= 4 else .01
                alt = gps_alt * factor
            else:
                alt = baro_alt
            sample = {'t': round(t, 3),
                      'lat': lat if valid else None, 'lon': lon if valid else None,
                      'alt': alt, 'speed': gs, 'heading': angle,
                      'yaw': yaw, 'roll': roll, 'pitch': pitch,
                      'voltage': voltage, 'throttle': throttle, 'sats': sats}
            samples.append(sample)
            last = t
            if len(samples) >= 100_000:
                break
    if len(samples) < 2:
        raise ConvertError('Decoder çıktısında en az iki zamanlı telemetri örneği bulunamadı.')
    return {'samples': samples, 'gps': gps_count >= 2,
            'rawRows': total_rows, 'sampleCount': len(samples), 'duration': samples[-1]['t']}


def convert_bytes(blob: bytes, original_filename: str) -> dict:
    if len(blob) > MAX_FILE_BYTES:
        raise ConvertError('150 MB sınırı aşıldı. Önce kaydı böl.')
    if not blob:
        raise ConvertError('Dosya boş.')
    # Prefer the regression-tested internal path for Betaflight 4.5 / Bee GPS
    # even if a separate blackbox_decode.exe is installed. Otherwise the
    # older code silently switched to another altitude interpretation.
    from blackbox_lite import decode_lite, LiteDecodeError
    try:
        return decode_lite(blob, Path(original_filename).name)
    except LiteDecodeError as lite_error:
        decoder = locate_decoder()
        if not decoder:
            raise ConvertError(str(lite_error) + ' Bu BFL çeşidi için harici blackbox_decode gerekir.') from lite_error

    # Only an unsupported log uses the optional official full decoder.
    import re
    firmware_major = None
    match = re.search(rb'^H Firmware revision:[^\n]*?Betaflight[ \t]+([0-9]+)\.', blob[:30000], re.MULTILINE | re.IGNORECASE)
    if match:
        firmware_major = int(match.group(1))
    with tempfile.TemporaryDirectory(prefix='fpvbb-') as tmp:
        root = Path(tmp)
        source = root / 'flight.bfl'
        source.write_bytes(blob)
        cmd = [decoder, '--merge-gps', '--simulate-imu', '--unit-frame-time', 's',
               '--unit-gps-speed', 'kph', '--unit-height', 'm', str(source)]
        try:
            p = subprocess.run(cmd, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=90, check=False, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ConvertError('Decoder başlatılamadı veya zaman aşımına uğradı: ' + str(exc)) from exc
        outputs = sorted(root.glob('*.csv'), key=lambda p:p.stat().st_size, reverse=True)
        if not outputs:
            details = (p.stderr or p.stdout).decode('utf-8', 'replace')[-350:]
            raise ConvertError('Blackbox çözümlenemedi. ' + details)
        # Multi-flight raw BFL can emit multiple CSVs, select first flight (largest data file for MVP).
        result = normalize_csv(outputs[0], firmware_major=firmware_major)
        result['filename'] = Path(original_filename).name
        result['warnings'] = ['Harici çözücü GPS irtifası: raw dm (Betaflight 4+) veya cm (eski sürümler) → metre olarak dönüştürüldü.']
        if len(outputs) > 1:
            result['warnings'].append(f'Bu dosyada {len(outputs)} kayıt bulundu; şimdilik en büyük kayıt oynatılıyor.')
        if not result['gps']:
            result['warnings'].append('Kullanılabilir GPS koordinatları yok. Konum ve arazi üzerinde hareket gösterilemiyor.')
        if not any(s['roll'] is not None and s['pitch'] is not None for s in result['samples']):
            result['warnings'].append('Attitude alanları bulunamadı. Blackbox kaydında gyro/accel olmayabilir.')
        result['warnings'].append('Blackbox GPS yüksekliği yerel jeoid / Cesium ellipsoid farkı için düzeltilmemiş olabilir.')
        return result
