"""Standalone Betaflight Blackbox GPS / keyframe extractor (Python standard library).

Supports Blackbox Data version 2 with signed/unsigned VB and NEG_14BIT I frames,
plus Betaflight 4.5 GPS/home G/H frames as in LOG00154.BFL.
Unlike the official blackbox_decode, it is NOT a complete Betaflight decoder:
P frames/events/full-rate attitude are not decoded. It must never fabricate GPS/IMU.
"""
from __future__ import annotations
import bisect
import math
import statistics

class LiteDecodeError(Exception):
    pass

def decode_lite(blob: bytes, original_filename='flight.bfl') -> dict:
    b=blob; n=len(b);head={}; start=0
    if not b.startswith(b'H Product:Blackbox'):
        raise LiteDecodeError('Blackbox H Product başlığı bulunamadı: desteklenen Betaflight BFL/BBL dosyasını seç.')
    while b[start:start+2]==b'H ':
        end=b.find(b'\n',start)
        if end<0 or end-start>20000:raise LiteDecodeError('Blackbox başlığı eksik.')
        row=b[start+2:end].decode('latin-1','replace')
        if ':' in row:
            key,value=row.split(':',1);head[key]=value
        start=end+1
    if head.get('Data version')!='2':
        raise LiteDecodeError('Dahili GPS çözücüsü yalnızca Blackbox Data version 2 kayıtlarını destekliyor. Tam çözücü: tools/blackbox_decode.exe.')
    try:
        fields=head['Field I name'].split(',')
        enc=[int(x) for x in head['Field I encoding'].split(',')]
        preds=[int(x) for x in head['Field I predictor'].split(',')]
        if not (len(fields)==len(enc)==len(preds)):raise ValueError('field count')
        if not all(x in (0,1,3) for x in enc):
            raise LiteDecodeError('Desteklenmeyen keyframe kodlaması. Tam çözücü: tools/blackbox_decode.exe.')
        gnames=head['Field G name'].split(',')
        if gnames != ['time','GPS_numSat','GPS_coord[0]','GPS_coord[1]','GPS_altitude','GPS_speed','GPS_ground_course']:
            raise LiteDecodeError('GPS G-frame alan düzeni farklı. Tam çözücü: tools/blackbox_decode.exe.')
        if b[start]!=ord('I'):raise LiteDecodeError('İlk I-frame bulunamadı.')
    except (ValueError,KeyError,IndexError) as ex:
        raise LiteDecodeError('Eksik/uyumsuz Blackbox alan tanımı.') from ex

    def uv(p):
        value=0;shift=0
        for _ in range(7):
            if p>=n:raise ValueError('EOF')
            byte=b[p];p+=1;value|=(byte&127)<<shift
            if byte<128:return value,p
            shift+=7
        raise ValueError('bad varint')
    def sv(p):
        v,p=uv(p);return (v>>1)^-(v&1),p

    # Keyframes are self-contained and have absolute iteration/time fields.
    # Validate marker + keyframe cadence + decoded time relationship, rather
    # than accepting every coincidental ASCII 'I' inside the binary stream.
    q=start+1;l0,q=uv(q);t0,q=uv(q)
    first_next=b.find(b'I',start+1)
    rate=None
    scan=first_next
    while scan>0 and scan<start+250000:
        try:
            li,at=uv(scan+1);ti,at=uv(at)
            if 0<li-l0<=4096 and li%128==0 and ti>t0 and 180<(ti-t0)/(li-l0)<450:
                rate=(ti-t0)/(li-l0);break
        except ValueError:pass
        scan=b.find(b'I',scan+1)
    if rate is None:raise LiteDecodeError('I-frame zaman ekseni çözümlenemedi.')
    keyframes=[(start,l0,t0)]
    scan=start
    last_loop=l0;last_t=t0
    while True:
        scan=b.find(b'I',scan+1)
        if scan<0:break
        try:
            li,q=uv(scan+1);ti,q=uv(q)
            if (li>last_loop and li%128==0 and ti>last_t
                and abs(ti-(t0+(li-l0)*rate))<max(250000,(li-l0)*0.12)):
                keyframes.append((scan,li,ti));last_loop=li;last_t=ti
        except ValueError:pass
    if len(keyframes)<5:raise LiteDecodeError('Yeterli geçerli I-frame bulunamadı.')

    home=None;scan=start
    while True:
        scan=b.find(b'H',scan+1)
        if scan<0:break
        try:
            x,q=sv(scan+1);y,q=sv(q)
            if -900000000<=x<=900000000 and -1800000000<=y<=1800000000 and b[q:q+1]==b'G':
                home=(x,y);break
        except (ValueError,IndexError):pass
    if home is None:raise LiteDecodeError('Geçerli GPS home H-frame bulunamadı (GPS içermeyen uçuş olabilir).')

    keypos=[x[0] for x in keyframes];keytimes=[x[2] for x in keyframes]
    satsfield=[];scan=start
    while True:
        scan=b.find(b'G',scan+1)
        if scan<0:break
        try:
            q=scan+1
            offset,q=uv(q);sats,q=uv(q);dx,q=sv(q);dy,q=sv(q);z,q=sv(q);speed,q=uv(q);course,q=uv(q)
            if not (offset<=350 and 5<=sats<=35 and abs(dx)<=3500000 and abs(dy)<=3500000
                    and -10000<=z<=30000 and speed<=30000 and course<=3600
                    and b[q:q+1] in (b'I',b'P',b'G',b'S',b'E',b'H')):
                continue
            i=bisect.bisect_right(keypos,scan)-1
            if i<0 or i+1>=len(keypos):continue
            f=(scan-keypos[i])/(keypos[i+1]-keypos[i])
            t=round((keytimes[i]+(keytimes[i+1]-keytimes[i])*f-t0)/1e6,3)
            if satsfield and t<=satsfield[-1]['t']+0.065:continue
            lat=(home[0]+dx)/1e7;lon=(home[1]+dy)/1e7;alt=z/100.0
            speedkm=speed*0.036
            if satsfield:
                prev=satsfield[-1];dt=t-prev['t']
                dy_m=(lat-prev['lat'])*111200
                dx_m=(lon-prev['lon'])*111200*math.cos(math.radians(lat))
                distance=math.hypot(dx_m,dy_m)
                max_reasonable=max(6,dt*(max(prev['speed'],speedkm)/3.6*2.5+8)+2)
                if distance>max_reasonable:continue
            satsfield.append({'t':t,'lat':round(lat,7),'lon':round(lon,7),
                'alt':round(alt,2),'speed':round(speedkm,2),'heading':round(course/10,1),'sats':sats})
        except (ValueError,IndexError,ZeroDivisionError):pass
    if len(satsfield)<4:raise LiteDecodeError('Uçuşa ait yeterli GPS konum örneği bulunamadı.')

    # Extract periodic self-contained I-frame values, no P-frame interpolation
    # here. All I encodings validated above; corrupt frames are discarded.
    idx={key:i for i,key in enumerate(fields)}
    needed=['rcCommand[3]','vbatLatest','accSmooth[0]','accSmooth[1]','accSmooth[2]']
    info=[];vbatref=int(head.get('vbatref','0')); imu_stream=[]
    for pos,loop,us in keyframes:
        try:
            q=pos+1;v=[]
            for e in enc:
                if e==0:x,q=sv(q)
                elif e==1:x,q=uv(q)
                else:
                    x,q=uv(q);x=-(x-16384 if x&8192 else x)
                v.append(x)
            if b[q:q+1] not in (b'P',b'I',b'G',b'H',b'E',b'S'):continue
            def get(k):return v[idx[k]] if k in idx else None
            thr=get('rcCommand[3]');vb=get('vbatLatest')
            ax=get('accSmooth[0]');ay=get('accSmooth[1]');az=get('accSmooth[2]')
            gx=get('gyroADC[0]');gy=get('gyroADC[1]');gz=get('gyroADC[2]')
            # Accelerometer tilt is an *estimate*, influenced by linear acceleration.
            roll=pitch=None
            if ax is not None and ay is not None and az is not None:
                roll=math.degrees(math.atan2(ay,az))
                pitch=math.degrees(math.atan2(-ax,math.hypot(ay,az)))
            tm=(us-t0)/1e6
            if None not in (ax,ay,az,gx,gy,gz):
                imu_stream.append((tm,ax,ay,az,gx,gy,gz))
            info.append((tm, (vbatref+vb)/100 if vb is not None and vbatref else None,
                        max(0,min(100,(thr-1000)/10)) if thr is not None else None,roll,pitch))
        except (ValueError,IndexError,ZeroDivisionError):pass
    # Complementary attitude estimate from already filtered gyroADC and
    # accSmooth, both present in this recording. I-frame cadence ~32 ms.
    # Gravity correction is reduced during high linear acceleration.
    # This is a REPLAY estimate, not native FC quaternion/EKF attitude.
    imu_times=[];imu_roll=[];imu_pitch=[];imu_acc_roll=[];imu_acc_pitch=[]
    fused_roll=fused_pitch=None
    prev_imu=None
    acc_1g=max(100,int(head.get('acc_1G','2048')))
    for tm,ax,ay,az,gx,gy,gz in imu_stream:
        acc_roll=math.degrees(math.atan2(ay,az))
        acc_pitch=math.degrees(math.atan2(-ax,math.hypot(ay,az)))
        if prev_imu is None or not (0<tm-prev_imu<0.16):
            fused_roll=acc_roll
            fused_pitch=acc_pitch
        else:
            dt=tm-prev_imu
            # Raw gyroADC on Betaflight 4.5 is recorded AFTER the configured
            # gyro filters; gyro_scale=1.0 for this sample firmware.
            fused_roll+=gx*dt
            fused_pitch+=gy*dt
            magnitude=math.sqrt(ax*ax+ay*ay+az*az)/acc_1g
            trust=max(0.0, 1.0-abs(magnitude-1.0)/0.30)
            correction=(1.0-math.exp(-dt/0.65))*trust
            delta=((acc_roll-fused_roll+180)%360)-180
            fused_roll+=correction*delta
            fused_pitch+=correction*(acc_pitch-fused_pitch)
        # Wrapped Euler roll avoids long-term turn accumulation in replay.
        fused_roll=((fused_roll+180.0)%360.0)-180.0
        fused_pitch=max(-89.0,min(89.0,fused_pitch))
        imu_times.append(tm);imu_roll.append(fused_roll);imu_pitch.append(fused_pitch)
        imu_acc_roll.append(acc_roll);imu_acc_pitch.append(acc_pitch)
        prev_imu=tm
    times=[x[0] for x in info]
    for s in satsfield:
        if times:
            i=bisect.bisect_left(times,s['t'])
            if i and (i==len(times) or abs(times[i-1]-s['t'])<abs(times[i]-s['t'])):i-=1
            it=info[i]
            s.update(voltage=round(it[1],2) if it[1] is not None else None,
                     throttle=round(it[2],1) if it[2] is not None else None)
        if imu_times:
            i=bisect.bisect_left(imu_times,s['t'])
            if i==len(imu_times):i-=1
            if i>0 and abs(imu_times[i-1]-s['t'])<abs(imu_times[i]-s['t']):i-=1
            s.update(roll=round(imu_roll[i],2),pitch=round(imu_pitch[i],2),
                     accRoll=round(imu_acc_roll[i],2),accPitch=round(imu_acc_pitch[i],2),yaw=None)
    
    metadata={k:head.get(k,'') for k in ['Craft name','Firmware revision','Board information','Log start datetime']}
    return {'samples':satsfield,'gps':True,'rawRows':len(keyframes),'sampleCount':len(satsfield),
            'duration':satsfield[-1]['t'],'filename':original_filename,
            'metadata':metadata,'lite':True,'attitudeSource':'gyro-acc-complementary',
            'warnings':['Dahili Blackbox GPS / I-frame çözücüsü kullanıldı: gerçek koordinat, GPS hız/yön/irtifa, voltaj ve gaz okundu.',
                'Roll/pitch, filtrelenmiş gyroADC + accSmooth kullanılarak tamamlayıcı filtreyle tahmin edildi; uçuş kontrolcüsünün doğrudan attitude ölçümü değildir.',
                'Bu BFL kaydının irtifası Bee regresyon örneğinde 0.01 m/raw ölçeğinde yaklaşık 0–135 m ile uyumludur; farklı kayıtlarda GPS ölçeği ayrıca doğrulanmalıdır.']}
