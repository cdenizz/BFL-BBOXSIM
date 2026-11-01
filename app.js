/* FPV Airspace Control v0.8.1 — offline file replay / map visualization. */
'use strict';

const $ = (s) => document.querySelector(s);
const ORDU = { lon: 37.8830, lat: 40.9847, height: 4700 };
const palette = ['#327ca8', '#c48a32', '#876ab8', '#4b9b80', '#c06472'];
const SETTINGS_KEY = 'fpv-airspace-map-settings-v4';
const SETTINGS_PREVIOUS = 'fpv-airspace-map-settings-v3';
const SETTINGS_MIGRATION = 'fpv-airspace-map-settings-v2';
const PREVIOUS_SETTINGS_KEY = 'fpv-airspace-map-settings-v1';
const defaultSettings = { token: '', imagery: true, terrain: true, buildings: true, quality: 'high', localTilesAsset: '', flightAltOffset: 0, blackboxAltitudeScale: 10, trailMode:'all', trailSeconds:120 };
let settings = { ...defaultSettings, ...readStoredSettings() };
let viewer = null, buildingsLayer = null, localTilesLayer = null, sceneEntities = [];
let aircraft = [], duration = 0, currentTime = 0, selectedId = null;
let playing = false, playbackRate = 1, showTrails = true, showFov = true, isFollowing = false;
let frameTime = 0, lastSidebarUpdate = 0, toastTimeout;
let dataSourceTitle = '';
let mouseLookYaw = 0, mouseLookPitch = 0;
let fpvDragPointer = null, fpvLastX = 0, fpvLastY = 0;
const FPV_DRAG_SENSITIVITY = 0.16;
const CAMERA_KEY = 'fpv-airspace-fpv-camera-v05';
const DEFAULT_CAMERA = Object.freeze({headingSource:'yaw',yawOffset:0,pitchOffset:-45,rollOffset:0,
  useAircraftPitch:true,useAircraftRoll:true,forward:0.025,right:0,up:0,fov:122, attitudeMode:'fused',stabilization:'balanced'});
function readCameraSettings() {
  try { return {...DEFAULT_CAMERA,...JSON.parse(localStorage.getItem(CAMERA_KEY)||'{}')}; }
  catch { return {...DEFAULT_CAMERA}; }
}
let cameraSettings=readCameraSettings(), cameraBeforeEdit=null, previousFov=null;
function storeCameraSettings(){try{localStorage.setItem(CAMERA_KEY,JSON.stringify(cameraSettings));}catch{}}
let cameraMode='free', importWarnings=[], lastHudUpdate=0;
let stableCam=null, previousCamT=NaN;
function resetStabilization(){stableCam=null;previousCamT=NaN;}
function wrapDiff(a,b){return ((a-b+540)%360)-180;} // 'free', 'follow', 'fpv'

function readStoredSettings() {
  try {
    const upgraded = localStorage.getItem(SETTINGS_KEY);
    if(upgraded) return JSON.parse(upgraded);
    const previous = localStorage.getItem(SETTINGS_PREVIOUS);
    if(previous){const prefs=JSON.parse(previous);return {...prefs,imagery:true,terrain:true,buildings:true,blackboxAltitudeScale:10,trailMode:'all',trailSeconds:120};}
    const prior = JSON.parse(localStorage.getItem(SETTINGS_MIGRATION) || localStorage.getItem(PREVIOUS_SETTINGS_KEY) || '{}');
    // Preserve the Cesium token and map preferences; intentionally discard
    // the v0.5 incorrect 0.1 altitude multiplier from browser storage.
    prior.blackboxAltitudeScale = 10;
    prior.imagery=true;prior.terrain=true;prior.buildings=true;prior.trailMode='all';prior.trailSeconds=120;
    return prior;
  } catch { return {}; }
}
function storeSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a,b,t) { return a + (b-a)*t; }
// Preserve decoder output for recalibration without compounding multipliers.
// Applied ONLY to the built-in BFL decoder and its exported lite JSON, never GPX/CSV.
function calibrateBlackboxAltitude(a) {
  if(!a?.blackbox)return;
  const factor=Number(settings.blackboxAltitudeScale)||1;
  for(const s of a.samples){
    if(!Object.hasOwn(s,'_decoderAltitude'))s._decoderAltitude=s.alt;
    if(Number.isFinite(s._decoderAltitude))s.alt=Math.round(s._decoderAltitude*factor*1000)/1000;
  }
}
function calibrateLoadedFlights() {
  for(const a of aircraft)calibrateBlackboxAltitude(a);
  if(cameraMode==='fpv')updateFpvCamera();
  renderSidebar();
}

function toRad(d) { return d * Math.PI / 180; }
function formatTime(v) { v=Math.max(0,Math.floor(v));return `${String(Math.floor(v/60)).padStart(2,'0')}:${String(v%60).padStart(2,'0')}`; }
function safe(v, digits=0, fallback='—') { return Number.isFinite(v) ? v.toFixed(digits) : fallback; }
function stripTags(s) { return String(s).replace(/[<>"'&]/g, ''); }
function toast(msg, ms=3900) { const x=$('#toast');x.textContent=msg;x.classList.add('show');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>x.classList.remove('show'),ms); }
function setStatus(s) { /* status text intentionally not displayed */ }
function showLoading(title, detail, retry=false) { $('#mapLoading').style.display='flex';$('#mapLoading strong').textContent=title;$('#mapLoadingMessage').textContent=detail;$('#retryMap').hidden=!retry; }
function hideLoading() { $('#mapLoading').style.display='none'; }


function readFrame(a, t) {
  const s=a.samples;
  if (!s.length) return null;
  if(t<=s[0].t) return s[0];
  if(t>=s[s.length-1].t) return s[s.length-1];
  let lo=0,hi=s.length-1;
  while(hi-lo>1) {const mid=(hi+lo)>>1;if(s[mid].t<=t)lo=mid;else hi=mid;}
  const p=s[lo],q=s[hi],f=(t-p.t)/(q.t-p.t||1);
  const result={};
  const invalidGeo=!(Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&Number.isFinite(q.lat)&&Number.isFinite(q.lon));
  for(const key of ['lat','lon','alt','pitch','roll','accPitch','accRoll','yaw','sats','voltage','speed','throttle']) {
    if(Number.isFinite(p[key])&&Number.isFinite(q[key]))result[key]=lerp(p[key],q[key],f);
    else result[key]=Number.isFinite(p[key])?p[key]:q[key];
  }
  if(invalidGeo){result.lat=NaN;result.lon=NaN;}
  if(Number.isFinite(p.heading)&&Number.isFinite(q.heading)){
    const delta=((q.heading-p.heading+540)%360)-180;
    result.heading=(p.heading+delta*f+360)%360;
  } else result.heading=p.heading;
  if(Number.isFinite(p.roll)&&Number.isFinite(q.roll)){
    result.roll=p.roll+wrapDiff(q.roll,p.roll)*f;
  }
  if(cameraSettings.attitudeMode==='acc'){if(Number.isFinite(result.accRoll))result.roll=result.accRoll;if(Number.isFinite(result.accPitch))result.pitch=result.accPitch;}
  return result;
}
function atPosition(a, t) {
  if (!viewer) return null;
  const s=readFrame(a,t);
  return s && Number.isFinite(s.lat) && Number.isFinite(s.lon) && Number.isFinite(s.alt) ? Cesium.Cartesian3.fromDegrees(s.lon,s.lat,s.alt+Number(settings.flightAltOffset||0)) : null;
}
function bearing(p,q) {
  const phi1=toRad(p.lat),phi2=toRad(q.lat),dLon=toRad(q.lon-p.lon);
  const y=Math.sin(dLon)*Math.cos(phi2);
  const x=Math.cos(phi1)*Math.sin(phi2)-Math.sin(phi1)*Math.cos(phi2)*Math.cos(dLon);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}
function speedFrom(p,q) {
  const R=6371000, a1=toRad(p.lat),a2=toRad(q.lat),dl=toRad(q.lon-p.lon),dp=a2-a1;
  const h=Math.sin(dp/2)**2+Math.cos(a1)*Math.cos(a2)*Math.sin(dl/2)**2;
  return 3.6*(2*R*Math.asin(Math.min(1,Math.sqrt(h))))/Math.max(0.001,q.t-p.t);
}
function trailPositions(a,t) {
  if(!showTrails || !a?.samples?.length)return [];
  const samples=a.samples;
  const tick=Math.round(t*5)/5;
  const windowStart=settings.trailMode==='limited'?Math.max(0,tick-clamp(Number(settings.trailSeconds)||120,1,7200)):0;
  // Keep draw calls bounded for long recordings. Cache position buffers between time ticks.
  const key=[tick,settings.flightAltOffset,settings.trailMode,settings.trailSeconds].join(':');
  if(a._trailCache?.key===key)return a._trailCache.positions;
  let lo=0,hi=samples.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(samples[mid].t<windowStart)lo=mid+1;else hi=mid;}
  let endLo=lo,endHi=samples.length;
  while(endLo<endHi){const mid=(endLo+endHi)>>1;if(samples[mid].t<=tick)endLo=mid+1;else endHi=mid;}
  const end=endLo;
  const positions=[];
  const step=Math.max(1,Math.ceil((end-lo)/1400));
  for(let i=lo;i<end;i+=step){const p=samples[i];if(Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&Number.isFinite(p.alt))positions.push(Cesium.Cartesian3.fromDegrees(p.lon,p.lat,p.alt+Number(settings.flightAltOffset||0)));}
  const tip=atPosition(a,tick);if(tip)positions.push(tip);
  a._trailCache={key,positions};return positions;
}

function hexColor(color, alpha=1) { return Cesium.Color.fromCssColorString(color).withAlpha(alpha); }
function modelOrientation(frame, point) {
  // GLB local +X axis = aircraft nose. Heading is track clockwise from North.
  return Cesium.Transforms.headingPitchRollQuaternion(point, new Cesium.HeadingPitchRoll(toRad((frame.heading ?? 0)-90),toRad(frame.pitch||0),toRad(frame.roll||0)));
}
// One camera solution drives BOTH the FPV view and the selected drone's FOV cone.
function cameraPose(frame,world) {
  const cam=cameraSettings;
  const baseHeading=cam.headingSource==='yaw'&&Number.isFinite(frame.yaw)?frame.yaw:frame.heading;
  let heading=(baseHeading+Number(cam.yawOffset)+(cameraMode==='fpv'?mouseLookYaw:0)+360)%360;
  let pitch=clamp(Number(cam.pitchOffset)+(cam.useAircraftPitch?(frame.pitch||0):0)+(cameraMode==='fpv'?mouseLookPitch:0),-89,89);
  let roll=Number(cam.rollOffset)+(cam.useAircraftRoll?(frame.roll||0):0);
  if(cameraMode==='fpv' && cam.stabilization!=='off'){
    const dt=currentTime-previousCamT;
    if(!stableCam || !Number.isFinite(dt) || dt<0 || dt>0.35){stableCam={heading,pitch,roll};}
    else{
      const tau=({light:0.10,balanced:0.23,smooth:0.50})[cam.stabilization]||0.23;
      const blend=1-Math.exp(-dt/tau);
      stableCam.heading=(stableCam.heading+blend*wrapDiff(heading,stableCam.heading)+360)%360;
      stableCam.pitch+=blend*(pitch-stableCam.pitch);
      stableCam.roll+=blend*wrapDiff(roll,stableCam.roll);
    }
    previousCamT=currentTime;({heading,pitch,roll}=stableCam);
  }
  const h=toRad(heading);
  const p=toRad(pitch);
  const r=toRad(roll);
  const d=new Cesium.Cartesian3(Math.sin(h)*Math.cos(p),Math.cos(h)*Math.cos(p),Math.sin(p));
  const groundRight=new Cesium.Cartesian3(Math.cos(h),-Math.sin(h),0);
  const groundForward=new Cesium.Cartesian3(Math.sin(h),Math.cos(h),0);
  const right=Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(d,Cesium.Cartesian3.UNIT_Z,new Cesium.Cartesian3()),new Cesium.Cartesian3());
  const up=Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(right,d,new Cesium.Cartesian3()),new Cesium.Cartesian3());
  const rollUp=Cesium.Cartesian3.add(Cesium.Cartesian3.multiplyByScalar(up,Math.cos(r),new Cesium.Cartesian3()),Cesium.Cartesian3.multiplyByScalar(right,Math.sin(r),new Cesium.Cartesian3()),new Cesium.Cartesian3());
  const rollRight=Cesium.Cartesian3.subtract(Cesium.Cartesian3.multiplyByScalar(right,Math.cos(r),new Cesium.Cartesian3()),Cesium.Cartesian3.multiplyByScalar(up,Math.sin(r),new Cesium.Cartesian3()),new Cesium.Cartesian3());
  const frameENU=Cesium.Transforms.eastNorthUpToFixedFrame(world);
  const asWorld=v=>Cesium.Matrix4.multiplyByPointAsVector(frameENU,v,new Cesium.Cartesian3());
  const offset=new Cesium.Cartesian3(groundForward.x*Number(cam.forward)+groundRight.x*Number(cam.right),
    groundForward.y*Number(cam.forward)+groundRight.y*Number(cam.right),Number(cam.up));
  return {eye:Cesium.Cartesian3.add(world,asWorld(offset),new Cesium.Cartesian3()),
    direction:asWorld(d),right:asWorld(rollRight),up:asWorld(rollUp)};
}
function getConeCorners(a) {
  const frame=readFrame(a,currentTime),center=atPosition(a,currentTime);
  if(!frame||!center||!Number.isFinite(frame.heading))return null;
  const {eye,direction,right,up}=cameraPose(frame,center);
  const depth=110,halfW=depth*Math.tan(toRad(clamp(Number(cameraSettings.fov)||95,35,125)/2));
  const halfH=halfW/(16/9); // drone camera preview assumes 16:9 aspect ratio
  const centerFar=Cesium.Cartesian3.add(eye,Cesium.Cartesian3.multiplyByScalar(direction,depth,new Cesium.Cartesian3()),new Cesium.Cartesian3());
  const at=(x,y)=>Cesium.Cartesian3.add(centerFar,
    Cesium.Cartesian3.add(Cesium.Cartesian3.multiplyByScalar(right,x,new Cesium.Cartesian3()),
      Cesium.Cartesian3.multiplyByScalar(up,y,new Cesium.Cartesian3()),new Cesium.Cartesian3()),new Cesium.Cartesian3());
  return [eye,at(-halfW,-halfH),at(halfW,-halfH),at(halfW,halfH),at(-halfW,halfH)];
}

function disposeAircraft() {
  // Importing a new flight must also release FPV mouse interaction.
  endFpvDrag();
  if(!viewer)return;
  setCameraMode('free');
  sceneEntities.forEach(e=>viewer.entities.remove(e));
  sceneEntities=[];
  viewer.trackedEntity=undefined;
}
function rebuildAircraft() {
  if(!viewer)return;
  disposeAircraft();
  for(const a of aircraft){
    const color=hexColor(a.color);
    if(a.hasGps===false || !a.samples.some(f=>Number.isFinite(f.lat)&&Number.isFinite(f.lon))) continue;
    const model=viewer.entities.add({
      id:a.id,
      name:a.id,
      position:new Cesium.CallbackProperty(()=>atPosition(a,currentTime),false),
      orientation:new Cesium.CallbackProperty(()=>{
        const f=readFrame(a,currentTime),p=atPosition(a,currentTime);
        return f&&p?modelOrientation(f,p):Cesium.Quaternion.IDENTITY;
      },false),
      model:{uri:a.type==='fixedwing'?'./assets/fixedwing.glb':'./assets/quad.glb', minimumPixelSize:32,maximumScale:80,scale:a.type==='fixedwing'?1.15:1.2, color:Cesium.Color.WHITE},
      label:{text:a.id,font:'12px Segoe UI',fillColor:color,outlineColor:Cesium.Color.WHITE,outlineWidth:4,style:Cesium.LabelStyle.FILL_AND_OUTLINE,pixelOffset:new Cesium.Cartesian2(0,-30),verticalOrigin:Cesium.VerticalOrigin.BOTTOM,disableDepthTestDistance:1000,distanceDisplayCondition:new Cesium.DistanceDisplayCondition(0,18000)}
    });
    a._entity=model;sceneEntities.push(model);
    const trail=viewer.entities.add({
      polyline:{positions:new Cesium.CallbackProperty(()=>trailPositions(a,currentTime),false),width:3,material:color.withAlpha(.87),clampToGround:false}
    });sceneEntities.push(trail);
    // Frustum: transparent faces + fine outer edges, each recomputed for playback timestamp.
    for(let edge=0;edge<4;edge++) {
      const face=viewer.entities.add({
        polygon:{hierarchy:new Cesium.CallbackProperty(()=>{
          if(!showFov || cameraMode==='fpv' || a.id!==selectedId)return undefined;
          const c=getConeCorners(a);return c?new Cesium.PolygonHierarchy([c[0],c[1+edge],c[1+((edge+1)%4)]]):undefined;
        },false),perPositionHeight:true,material:color.withAlpha(.12),outline:false}
      });sceneEntities.push(face);
    }
    const frustumOutline=viewer.entities.add({
      polyline:{positions:new Cesium.CallbackProperty(()=>{
        if(!showFov||cameraMode==='fpv'||a.id!==selectedId)return [];
        const c=getConeCorners(a);return c?[c[0],c[1],c[2],c[3],c[4],c[1]]:[];
      },false),width:1.3,material:color.withAlpha(.54)}
    });sceneEntities.push(frustumOutline);
  }
  if(aircraft[0])selectedId=aircraft.some(a=>a.id===selectedId)?selectedId:aircraft[0].id;
  renderSidebar();
}
function renderSidebar() {
  document.body.classList.toggle('has-flight',aircraft.length>0);
  $('#aircraftCount').textContent=`${aircraft.length} araç`;
  $('#aircraftList').replaceChildren();
  for (const a of aircraft) {
    const frame=readFrame(a,currentTime);if(!frame)continue;
    const card=document.createElement('button');card.className='aircraft-card'+(a.id===selectedId?' selected':'');
    card.innerHTML=`<div class="ac-header"><span class="ac-id"><i class="ac-color" style="background:${a.color}"></i>${stripTags(a.id)}</span><span class="ac-kind">${a.type==='fixedwing'?'Fixed-wing':'Quad'}</span></div><div class="ac-data"><div><b>${safe(frame.speed)} km/h</b><span>Hız</span></div><div><b>${safe(frame.alt)} m</b><span>İrtifa</span></div><div><b>${safe(frame.voltage,1)} V</b><span>Batarya</span></div><div><b>${safe(frame.heading)}°</b><span>GPS track</span></div></div>`;
    card.addEventListener('click',()=>selectAircraft(a.id));
    $('#aircraftList').append(card);
  }
  const a=aircraft.find(x=>x.id===selectedId)||aircraft[0];if(!a){$('#selectedInfo').replaceChildren();$('#selectedType').textContent='';$('#aircraftList').innerHTML='<span class="empty-state">Uçuş kaydı açın</span>';return;}
  const f=readFrame(a,currentTime);
  $('#selectedType').textContent=a.name;
  const rows=[['Hız',`${safe(f.speed,1)} km/h`],['GPS irtifası',`${safe(f.alt,1)} m`],['Track',`${safe(f.heading,0)}°`],['Batarya',`${safe(f.voltage,2)} V`],['Roll',`${safe(f.roll,1)}°`],['Pitch',`${safe(f.pitch,1)}°`],['Gaz',`${safe(f.throttle,0)} %`],['Zaman',formatTime(currentTime)]];

  $('#selectedInfo').innerHTML=`<div class="detail-name" style="color:${a.color}">${stripTags(a.id)}</div><div class="detail-grid">${rows.map(([k,v])=>`<div class="metric"><span>${k}</span><strong>${v}</strong></div>`).join('')}</div>`;
}
function selectAircraft(id) {selectedId=id;renderSidebar();const a=aircraft.find(x=>x.id===id);if(isFollowing && viewer && a)viewer.trackedEntity=a._entity;}
function refreshSourceUI() {

  $('#flightName').textContent=dataSourceTitle;
  $('#timeSlider').max=String(duration);
  $('#endTime').textContent=formatTime(duration);
  $('.playback-panel').hidden=!aircraft.length;


  $('#playBtn').textContent=playing?'Ⅱ Duraklat':'▶ Oynat';
}
function updateTimeline() { $('#currentTime').textContent=formatTime(currentTime);$('#timeSlider').value=String(currentTime); }
function jumpToOrdu(){if(!viewer)return;setCameraMode('free');viewer.camera.flyTo({destination:Cesium.Cartesian3.fromDegrees(ORDU.lon,ORDU.lat,ORDU.height),orientation:{heading:toRad(17),pitch:toRad(-47),roll:0},duration:1.2});}
function focusOnFlight(){if(!viewer||!aircraft.length)return;const a=aircraft.find(x=>x.id===selectedId)||aircraft[0];const s=readFrame(a,currentTime);if(!s||!Number.isFinite(s.lat)||!Number.isFinite(s.lon))return;viewer.camera.flyTo({destination:Cesium.Cartesian3.fromDegrees(s.lon,s.lat,1300),orientation:{heading:toRad(17),pitch:toRad(-40),roll:0},duration:1.1});}

function applyDisplayQuality() {
  if(!viewer)return;
  const quality=['balanced','high','ultra'].includes(settings.quality)?settings.quality:'high';
  const presets={
    balanced:{resolution:1.0,terrainSse:2.3,buildingsSse:16},
    high:{resolution:1.15,terrainSse:1.15,buildingsSse:8},
    ultra:{resolution:1.4,terrainSse:0.65,buildingsSse:4}
  };
  const p=presets[quality];
  viewer.resolutionScale=p.resolution;
  viewer.scene.globe.maximumScreenSpaceError=p.terrainSse;
  if(buildingsLayer)buildingsLayer.maximumScreenSpaceError=p.buildingsSse;
  if(localTilesLayer)localTilesLayer.maximumScreenSpaceError=p.buildingsSse;

}
async function applyLocalTiles() {
  if(!viewer)return;
  if(localTilesLayer){viewer.scene.primitives.remove(localTilesLayer);localTilesLayer=null;}
  const raw=String(settings.localTilesAsset||'').trim();
  if(!raw)return;
  if(!/^[1-9]\d*$/.test(raw)){toast('3D Tiles varlık ID geçersiz.');return;}
  try {
    if(settings.token)Cesium.Ion.defaultAccessToken=settings.token;
    const tileset=await Cesium.Cesium3DTileset.fromIonAssetId(Number(raw));
    localTilesLayer=viewer.scene.primitives.add(tileset);
    applyDisplayQuality();
    toast('Özel 3D Tiles katmanı yüklendi.');
  } catch(e) {console.error(e);toast('Özel 3D Tiles yüklenemedi. Asset ID, token yetkisi ve veri türünü kontrol et.',6000);}
}

async function applyMapLayers(){
  if(!viewer) return;
  if(settings.token)Cesium.Ion.defaultAccessToken=settings.token;
  try {
    viewer.imageryLayers.removeAll();
    if (settings.imagery) {
      if(settings.token)Cesium.Ion.defaultAccessToken=settings.token;
      viewer.imageryLayers.add(Cesium.ImageryLayer.fromWorldImagery());
    } else {
      viewer.imageryLayers.add(new Cesium.ImageryLayer(new Cesium.OpenStreetMapImageryProvider({url:'https://tile.openstreetmap.org/'})));
    }
  } catch (e) {console.warn(e);toast('Görüntü kaynağı değiştirilemedi. Token kontrol et.');}
  if (settings.terrain) {
    try{Cesium.Ion.defaultAccessToken=settings.token;const t=Cesium.Terrain.fromWorldTerrain();viewer.scene.setTerrain(t);
      t.readyEvent.addEventListener(()=>{setStatus('Hazır');});
      t.errorEvent.addEventListener(e=>{setStatus('Arazi servisi hatası');toast('Arazi yüklenemedi. Token erişim izinlerini kontrol et.');console.warn(e);});
    }catch(e){console.warn(e);toast('Arazi açılamadı: '+e.message);}
  }else{
    viewer.terrainProvider=new Cesium.EllipsoidTerrainProvider();

  }
  if(buildingsLayer){viewer.scene.primitives.remove(buildingsLayer);buildingsLayer=null;}
  if(settings.buildings){
    try{if(settings.token)Cesium.Ion.defaultAccessToken=settings.token;buildingsLayer=await Cesium.createOsmBuildingsAsync();viewer.scene.primitives.add(buildingsLayer);}
    catch(e){console.warn(e);toast('3D binalar yüklenemedi. Token ve varlık erişimini kontrol et.');}
  }
  applyDisplayQuality();
  await applyLocalTiles();
}
async function initMap() {
  if(!window.Cesium){showLoading('Harita motoru yüklenemedi','CesiumJS CDN erişilemedi. İnternet bağlantısını kontrol edip yeniden dene.',true);setStatus('Harita bağlantısı yok');return;}
  try{
    if(viewer){viewer.destroy();viewer=null;}
    const C=window.Cesium;
    if(settings.token)C.Ion.defaultAccessToken=settings.token;
    viewer=new C.Viewer('cesiumContainer',{
      baseLayer:false,terrainProvider:new C.EllipsoidTerrainProvider(),
      timeline:false,animation:false,baseLayerPicker:false,homeButton:false,geocoder:false,
      sceneModePicker:false,selectionIndicator:false,infoBox:false,navigationHelpButton:false,fullscreenButton:false,
      skyBox:false,shadows:false,requestRenderMode:false,
      scene3DOnly:false,shouldAnimate:false
    });
    viewer.scene.globe.enableLighting=false;
    viewer.scene.globe.depthTestAgainstTerrain=false;
    viewer.scene.screenSpaceCameraController.minimumZoomDistance=25;
    viewer.scene.screenSpaceCameraController.maximumZoomDistance=150000;
    viewer.camera.setView({destination:C.Cartesian3.fromDegrees(ORDU.lon,ORDU.lat,ORDU.height),orientation:{heading:toRad(17),pitch:toRad(-47),roll:0}});
    viewer.screenSpaceEventHandler.setInputAction(ev=>{
      const p=viewer.scene.pick(ev.position);
      if(C.defined(p)&&p.id&&aircraft.some(a=>a._entity===p.id))selectAircraft(p.id.id);
    },C.ScreenSpaceEventType.LEFT_CLICK);

    rebuildAircraft();
    hideLoading();
    setStatus('3D harita hazır · Ordu / Altınordu');
    await applyMapLayers();
  }catch(e){console.error(e);showLoading('Harita başlatılamadı',String(e.message||e),true);setStatus('Harita başlatma hatası');}
}

function interpolateFlightFromPoints(points, id, name) {
  if (points.length<2) throw new Error('En az iki GPS noktası gerekli.');
  const t0=points[0].t;
  const sorted=points.map(p=>({...p,t:p.t-t0})).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&Math.abs(p.lat)<=90&&Math.abs(p.lon)<=180).sort((a,b)=>a.t-b.t);
  if(sorted.length<2)throw new Error('Koordinat içeren yeterli nokta bulunamadı.');
  const sampled=[];
  const minGap=Math.max(0.12,(sorted[sorted.length-1].t-sorted[0].t)/3500);
  for(let i=0;i<sorted.length;i++){
    let p=sorted[i]; if(sampled.length && p.t-sampled[sampled.length-1].t <minGap && i!==sorted.length-1)continue;
    const q=sorted[Math.min(sorted.length-1,i+1)];const prev=sorted[Math.max(0,i-1)];
    const inferred=bearing(prev===p?p:prev, q===p?p:q);
    sampled.push({...p,heading:Number.isFinite(p.heading)?p.heading:inferred,speed:Number.isFinite(p.speed)?p.speed:speedFrom(prev,q),roll:p.roll??0,pitch:p.pitch??0,voltage:p.voltage??NaN,throttle:p.throttle??NaN});
  }
  return {id,name,color:palette[0],type:'quadcopter',samples:sampled,note:'İçe aktarılan GPS izi. Roll/pitch bulunmuyorsa 0° gösterilir; heading GPS noktalarından tahmin edilmiş olabilir.'};
}
function parseGPX(text, filename) {
  const xml=new DOMParser().parseFromString(text,'text/xml');
  if(xml.querySelector('parsererror'))throw new Error('Geçersiz GPX/XML dosyası.');
  const trk=[...xml.getElementsByTagName('trkpt')];
  const route=trk.length?trk:[...xml.getElementsByTagName('rtept')];
  if(route.length<2)throw new Error('GPX içinde en az iki trkpt/rtept gerekiyor.');
  const points=[];
  for(let i=0;i<route.length;i++) {
    const x=route[i];let lat=Number(x.getAttribute('lat')),lon=Number(x.getAttribute('lon'));
    const elev=x.getElementsByTagName('ele')[0];const tm=x.getElementsByTagName('time')[0];
    const t=tm?Date.parse(tm.textContent)/1000:i;
    points.push({t:Number.isFinite(t)?t:i,lat,lon,alt:elev?Number(elev.textContent):0});
  }
  return interpolateFlightFromPoints(points,filename.replace(/\.[^.]+$/,''),'GPX flight track');
}
function parseCSVLine(line){const result=[];let s='',quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){s+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){result.push(s.trim());s='';}else s+=c;}result.push(s.trim());return result;}
function parseCSV(text,filename) {
  const lines=text.replace(/\r/g,'').split('\n').filter(s=>s.trim());
  if(lines.length<3)throw new Error('CSV başlık ve en az iki veri satırı içermeli.');
  const names=parseCSVLine(lines[0]).map(x=>x.toLowerCase().replace(/[^a-z0-9]/g,''));
  const getIndex=(...aliases)=>names.findIndex(n=>aliases.some(x=>n===x));
  const latI=getIndex('lat','latitude','gpscoord0','gpslat');
  const lonI=getIndex('lon','longitude','lng','gpscoord1','gpslon');
  const altI=getIndex('altm','altitude','heightm','ele','gpsaltitudem','gpsaltitude');
  const timeI=getIndex('times','time','timems','timeus','timestamp','timeusec');
  const headingI=getIndex('heading','headingdeg','yaw','course','track','gpsgroundcourse');
  const rollI=getIndex('roll','rolldeg','attitude0');const pitchI=getIndex('pitch','pitchdeg','attitude1');
  const speedI=getIndex('speed','speedkmh','gpsspeedkmh');const voltageI=getIndex('voltage','vbat','batteryv','vbatlatestv');const throttleI=getIndex('throttle','throttlepercent');
  if(latI<0||lonI<0)throw new Error('CSV için lat/lon veya GPS_coord[0]/GPS_coord[1] sütunları gerekiyor.');
  const rawTime=names[timeI]||'';const divisor=rawTime.includes('us')?1e6:rawTime.includes('ms')?1e3:1;
  const points=[];
  for(let i=1;i<lines.length;i++){
    const r=parseCSVLine(lines[i]),num=k=>k<0?NaN:Number(r[k]);
    const lat=num(latI),lon=num(lonI);if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180||lat===0&&lon===0)continue;
    points.push({t:timeI<0?i-1:num(timeI)/divisor,lat,lon,alt:num(altI)||0,heading:num(headingI),roll:num(rollI),pitch:num(pitchI),speed:num(speedI),voltage:num(voltageI),throttle:num(throttleI)});
  }
  return interpolateFlightFromPoints(points,filename.replace(/\.[^.]+$/,''),'CSV flight track');
}
function parseJson(text,filename){
  const obj=JSON.parse(text);
  if(obj.type==='FeatureCollection'){
    const f=obj.features.find(f=>f.geometry?.type==='LineString');
    if(!f)throw new Error('GeoJSON LineString bulunamadı.');
    const times=f.properties?.times||[];
    return interpolateFlightFromPoints(f.geometry.coordinates.map((c,i)=>({lon:Number(c[0]),lat:Number(c[1]),alt:Number(c[2])||0,t:times[i]?Date.parse(times[i])/1000:i})),filename.replace(/\.[^.]+$/,''),'GeoJSON flight track');
  }
  const samples=Array.isArray(obj)?obj:obj.samples;
  if(!Array.isArray(samples))throw new Error('JSON samples dizisi içermeli.');
  // Replay exports from 0.4 include a built-in decoder signature: respect their calibration.
  if(obj?.lite===true && obj?.metadata?.['Firmware revision']) {
    const a={id:'BLACKBOX-01',name:obj.metadata['Craft name']||'Blackbox Replay',type:'quadcopter',
      color:palette[0],lite:true,blackbox:true,samples:structuredClone(samples),
      note:'Yerleşik BFL çözücüsünün JSON çıktısı; yükseklik düzeltmesi uygulanır.'};
    calibrateBlackboxAltitude(a);return a;
  }
  return interpolateFlightFromPoints(samples,filename.replace(/\.[^.]+$/,''),'JSON flight track');
}
async function importFile(file) {
  if(!file)return;
  const name=file.name.toLowerCase();
  if(/\.(bbl|bfl|txt)$/.test(name)){ await importBlackbox(file); return; }
  try{
    const text=await file.text();let a;
    if(name.endsWith('.gpx'))a=parseGPX(text,file.name);
    else if(name.endsWith('.csv'))a=parseCSV(text,file.name);
    else if(name.endsWith('.json')||name.endsWith('.geojson'))a=parseJson(text,file.name);
    else throw new Error('GPX, CSV veya GeoJSON dosyası seç.');
    aircraft=[a];duration=a.samples[a.samples.length-1].t;currentTime=0;playing=false;selectedId=a.id;
    dataSourceTitle=file.name;importWarnings=[];refreshSourceUI();rebuildAircraft();updateTimeline();renderSidebar();focusOnFlight();
    toast(`${a.samples.length} nokta yüklendi.`);
  }catch(e){console.error(e);toast('İçe aktarma hatası: '+e.message,6500);}
}

// Blackbox binary path: local Python server delegates binary parsing to the official decoder.
async function importBlackbox(file) {
  toast('Blackbox kaydı çözümleniyor…',9000);
  try {
    const response=await fetch('/api/import-blackbox',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Flight-Filename':encodeURIComponent(file.name)},body:file});
    let payload;
    try {payload=await response.json();} catch {throw new Error('Yerel sunucu yanıt vermedi. start_windows.bat ile başlat.');}
    if(!response.ok)throw new Error(payload.error||'Blackbox çözümlenemedi.');
    const track=payload.samples.filter(x=>Number.isFinite(x.lat)&&Number.isFinite(x.lon)&&Number.isFinite(x.alt));
    const hasGps=track.length>=2;
    const a={id:'BLACKBOX-01',type:'quadcopter',name:payload.metadata?.['Craft name']||'Betaflight Blackbox',lite:!!payload.lite,blackbox:!!payload.lite,color:palette[0],samples:payload.samples,
      hasGps,note:`${stripTags(file.name)} · ${payload.sampleCount} örnek · ${payload.rawRows} ham satır · ${hasGps?'GPS mevcut':'GPS konumu yok'}`};
    calibrateBlackboxAltitude(a);
    aircraft=[a];duration=payload.duration;currentTime=0;playing=false;selectedId=a.id;
    dataSourceTitle=file.name;importWarnings=[...(payload.warnings||[]), ...(a.blackbox?[`BFL x${settings.blackboxAltitudeScale}`]:[])];
    refreshSourceUI();rebuildAircraft();updateTimeline();renderSidebar();
    if(hasGps) {focusOnFlight(); toast(`${payload.sampleCount} örnek yüklendi.`,3000);}
    else {setCameraMode('fpv');toast('GPS konumu bulunamadı.',3500);}
  } catch (err) {console.error(err);toast('BFL açılamadı: '+err.message,9500);window.alert('Blackbox içe aktarılamadı:\n'+err.message);}
}

// Normal cursor at all times: FPV only rotates while dragging the map.
// Pointer capture is local to the drag and NEVER uses browser Pointer Lock.
function endFpvDrag(){
  const layer=$('#fpvLookLayer');
  if(fpvDragPointer!==null && layer?.hasPointerCapture?.(fpvDragPointer)){
    try{layer.releasePointerCapture(fpvDragPointer);}catch{}
  }
  fpvDragPointer=null;
  layer?.classList.remove('dragging');
}
function resetFpvLook(){
  mouseLookYaw=0;mouseLookPitch=0;
  resetStabilization();
  if(cameraMode==='fpv')updateFpvCamera();
}
// Flight playback camera modes; FPV follows a measured GPS position, not a synthetic trajectory.
function setCameraMode(mode) {
  if(mode!=='free'&&!aircraft.length){toast('Önce uçuş aç.');return;}
  if(!viewer && mode!=='free') {toast('3D harita başlatılamadı.');return;}
  if(viewer)viewer.trackedEntity=undefined;
  if(cameraMode==='fpv' && mode!=='fpv' && viewer && Number.isFinite(previousFov)){
    viewer.camera.frustum.fov=previousFov;previousFov=null;
  }
  if(cameraMode!=='fpv' && mode==='fpv'){mouseLookYaw=0;mouseLookPitch=0;}
  // Recover from stale pointer locks left by older releases, if any.
  if(document.pointerLockElement && document.exitPointerLock)document.exitPointerLock();
  endFpvDrag();
  cameraMode=mode;isFollowing=mode==='follow';resetStabilization();
  if(viewer)viewer.scene.screenSpaceCameraController.enableInputs=mode!=='fpv';
  $('#followBtn').classList.toggle('active',mode==='follow');
  $('#fpvBtn').classList.toggle('active',mode==='fpv');
  $('#freeCamBtn').classList.toggle('active',mode==='free');
  $('#hudOverlay').hidden=mode!=='fpv';
  $('#noGpsCockpit').hidden=true;
  $('#fpvLookLayer').hidden=mode!=='fpv';
  const a=aircraft.find(a=>a.id===selectedId)||aircraft[0];
  if(viewer&&mode==='follow') {
    if(a?._entity)viewer.trackedEntity=a._entity;
    else {toast('Takip için GPS konumu bulunamadı.');setCameraMode('free');}
  }
  if(mode==='fpv') {
    if(previousFov===null && viewer)previousFov=viewer.camera.frustum.fov;
    if(viewer?.scene.mode!==Cesium.SceneMode.SCENE3D){toast('FPV görünümü için önce 3D moduna geç.');setCameraMode('free');return;}
    updateFpvCamera();updateHud();
  }
}
function updateHud() {
  const a=aircraft.find(a=>a.id===selectedId)||aircraft[0];
  if(!a)return;
  const f=readFrame(a,currentTime);
  if(!f)return;
  $('#hudName').textContent=a.name||a.id;
  $('#hudCompass').textContent='GPS TRACK '+(Number.isFinite(f.heading)?`${safe(f.heading)}°`:'—');
  $('#hudYaw').textContent='IMU YAW '+(Number.isFinite(f.yaw)?`${safe(f.yaw)}°`:'—');
  $('#hudSpeed').textContent=safe(f.speed,1);
  $('#hudAlt').textContent=safe(f.alt,1);$('#hudAltLabel').textContent=a.blackbox?'BFL GPS ALT':'GPS ALT';
  $('#hudThrottle').textContent='THR '+(Number.isFinite(f.throttle)?`${safe(f.throttle)}%`:'—');
  $('#hudVoltage').textContent='VBAT '+(Number.isFinite(f.voltage)?`${safe(f.voltage,1)} V`:'—');
  $('#hudRoll').textContent='ROLL '+(Number.isFinite(f.roll)?`${safe(f.roll,1)}°`:'—');
  $('#hudPitch').textContent='PITCH '+(Number.isFinite(f.pitch)?`${safe(f.pitch,1)}°`:'—');
  $('#hudFix').textContent='GPS '+(Number.isFinite(f.sats)?`${safe(f.sats)} SAT`:(Number.isFinite(f.lat)?'POS':'NO POSITION'));
  $('#hudTime').textContent=formatTime(currentTime);
  $('#hudHorizon').style.transform=`translate(-50%,-50%) translateY(${clamp(f.pitch||0,-45,45)*2}px) rotate(${-clamp(f.roll||0,-180,180)}deg)`;
}
function updateFpvCamera() {
  if(cameraMode!=='fpv')return;
  const a=aircraft.find(a=>a.id===selectedId)||aircraft[0];
  if(!a||!viewer)return;
  const f=readFrame(a,currentTime),world=atPosition(a,currentTime);
  const noPosition=!world||!f||!Number.isFinite(f.heading);
  $('#noGpsCockpit').hidden=!noPosition;
  $('#hudCameraMode').textContent=noPosition?'ATTITUDE': 'FPV';
  if(noPosition) {
    $('#instrumentHorizon').style.transform=`translateY(${clamp(f.pitch||0,-45,45)*2}px) rotate(${-clamp(f.roll||0,-180,180)}deg)`;
    return;
  }
  // View frustum and first-person camera share the same calibrated pose.
  const {eye,direction,up}=cameraPose(f,world);
  try{
    viewer.camera.frustum.fov=toRad(clamp(Number(cameraSettings.fov)||95,35,125));
    viewer.camera.setView({destination:eye,orientation:{direction,up}});
  }catch(e){console.warn('FPV camera:',e);setCameraMode('free');}

}

const cameraInputs={headingSource:'cameraHeadingSource',yawOffset:'cameraYawOffset',pitchOffset:'cameraPitchOffset',rollOffset:'cameraRollOffset',
  useAircraftPitch:'cameraFollowPitch',useAircraftRoll:'cameraFollowRoll',attitudeMode:'cameraAttitudeMode',stabilization:'cameraStabilization',forward:'cameraForward',right:'cameraRight',up:'cameraUp',fov:'cameraFov'};
function fillCameraDialog(){
  for(const [key,id] of Object.entries(cameraInputs)){
    const el=$('#'+id);el.type==='checkbox'?el.checked=!!cameraSettings[key]:el.value=String(cameraSettings[key]);
  }
}
function readCameraDialog(){
  const next={...cameraSettings};
  for(const [key,id] of Object.entries(cameraInputs)){
    const el=$('#'+id);
    next[key]=el.type==='checkbox'?el.checked:(key==='headingSource'||key==='attitudeMode'||key==='stabilization')?el.value:(el.value.trim()===''?cameraSettings[key]:Number(el.value));
  }
  next.yawOffset=clamp(next.yawOffset,-180,180);
  next.pitchOffset=clamp(next.pitchOffset,-89,89);
  next.rollOffset=clamp(next.rollOffset,-180,180);
  next.forward=clamp(next.forward,-5,5);next.right=clamp(next.right,-5,5);
  next.up=clamp(next.up,-5,5);next.fov=clamp(next.fov,35,125);
  cameraSettings=next;resetStabilization();
  if(cameraMode==='fpv')updateFpvCamera();
}
function openCameraSettings(){cameraBeforeEdit={...cameraSettings};fillCameraDialog();$('#cameraDialog').showModal();}
function setCameraDefault(){cameraSettings={...DEFAULT_CAMERA};fillCameraDialog();if(cameraMode==='fpv')updateFpvCamera();}

function attachUI() {
  $('#loadBtn').addEventListener('click',()=>$('#fileInput').click());
  $('#fileInput').addEventListener('change',e=>{importFile(e.target.files?.[0]);e.target.value='';});
  $('#settingsBtn').addEventListener('click',()=>{$('#flightAltOffset').value=Number(settings.flightAltOffset)||0;$('#blackboxAltScale').value=String(settings.blackboxAltitudeScale??10);$('#ionToken').value=settings.token;$('#imageryCheck').checked=settings.imagery;$('#terrainCheck').checked=settings.terrain;$('#buildingsCheck').checked=settings.buildings;$('#qualitySelect').value=settings.quality||'high';$('#localTilesAsset').value=settings.localTilesAsset||'';$('#trailMode').value=settings.trailMode||'all';$('#trailSeconds').value=String(settings.trailSeconds??120);$('#trailSeconds').disabled=$('#trailMode').value==='all';$('#settingsDialog').showModal();});
  $('#trailMode').addEventListener('change',()=>{$('#trailSeconds').disabled=$('#trailMode').value==='all';});
  $('#settingsDialog').addEventListener('close',async()=>{
    if($('#settingsDialog').returnValue!=='save')return;
    const token=$('#ionToken').value.trim();
    // Cesium's built-in evaluation token can be used temporarily. Public releases need a personal token.
    if(!token&&$('#localTilesAsset').value.trim()){toast('Özel 3D Tiles için ion token gir.');return;}
    settings={token,imagery:$('#imageryCheck').checked,terrain:$('#terrainCheck').checked,buildings:$('#buildingsCheck').checked,quality:$('#qualitySelect').value,localTilesAsset:$('#localTilesAsset').value.trim(),flightAltOffset:clamp(Number($('#flightAltOffset').value)||0,-2000,2000),blackboxAltitudeScale:Number($('#blackboxAltScale').value)||1,trailMode:$('#trailMode').value==='limited'?'limited':'all',trailSeconds:clamp(Number($('#trailSeconds').value)||120,1,7200)};
    storeSettings();calibrateLoadedFlights();for(const a of aircraft)delete a._trailCache;await applyMapLayers();
  });
  $('#cameraSettingsBtn').addEventListener('click',openCameraSettings);
  $('#hudCamSettings').addEventListener('click',openCameraSettings);
  for(const id of Object.values(cameraInputs))$('#'+id).addEventListener('input',readCameraDialog);
  $('#cameraReset').addEventListener('click',setCameraDefault);
  $('#cameraDialog').addEventListener('close',()=>{
    if($('#cameraDialog').returnValue==='save')storeCameraSettings();
    else if(cameraBeforeEdit){cameraSettings=cameraBeforeEdit;if(cameraMode==='fpv')updateFpvCamera();}
    cameraBeforeEdit=null;
  });
  $('#retryMap').addEventListener('click',initMap);
  $('#homeBtn').addEventListener('click',jumpToOrdu);
  $('#modeBtn').addEventListener('click',()=>{if(!viewer)return;if(cameraMode==='fpv')setCameraMode('free');const two=viewer.scene.mode===Cesium.SceneMode.SCENE3D;two?viewer.scene.morphTo2D(1):viewer.scene.morphTo3D(1);$('#modeBtn').textContent=two?'2D':'3D';});
  $('#followBtn').addEventListener('click',()=>{if(!viewer)return;setCameraMode(cameraMode==='follow'?'free':'follow');});
  $('#fpvBtn').addEventListener('click',()=>setCameraMode(cameraMode==='fpv'?'free':'fpv'));
  $('#freeCamBtn').addEventListener('click',()=>setCameraMode('free'));
  $('#sidebarFpv').addEventListener('click',()=>setCameraMode('fpv'));
  $('#sidebarMap').addEventListener('click',()=>setCameraMode('free'));
  $('#hudExit').addEventListener('click',()=>setCameraMode('free'));
  $('#hudLookReset').addEventListener('click',resetFpvLook);
  $('#trailsBtn').addEventListener('click',()=>{showTrails=!showTrails;$('#trailsBtn').classList.toggle('active',showTrails);});
  $('#fovBtn').addEventListener('click',()=>{showFov=!showFov;$('#fovBtn').classList.toggle('active',showFov);});
  $('#playBtn').addEventListener('click',()=>{playing=!playing;$('#playBtn').textContent=playing?'Ⅱ Duraklat':'▶ Oynat';});
  $('#restartBtn').addEventListener('click',()=>{currentTime=0;resetStabilization();updateTimeline();renderSidebar();});
  $('#speedSelect').addEventListener('change',e=>{playbackRate=Number(e.target.value)||1;});
  $('#timeSlider').addEventListener('input',e=>{currentTime=Number(e.target.value);resetStabilization();updateTimeline();renderSidebar();});
  window.addEventListener('keydown',e=>{
    const dialogOpen=$('#settingsDialog').open||$('#cameraDialog').open;
    if(e.code==='Escape' && !dialogOpen && cameraMode==='fpv'){
      e.preventDefault();endFpvDrag();setCameraMode('free');return;
    }
    if(dialogOpen || e.target?.matches?.('input,select,textarea'))return;
    if(e.code==='Space'){e.preventDefault();$('#playBtn').click();}
  });
  const look=$('#fpvLookLayer');
  look.addEventListener('pointerdown',e=>{
    if(cameraMode!=='fpv' || e.button!==0 || fpvDragPointer!==null)return;
    e.preventDefault();
    fpvDragPointer=e.pointerId;
    fpvLastX=e.clientX;fpvLastY=e.clientY;
    look.classList.add('dragging');
    try{look.setPointerCapture(e.pointerId);}catch{endFpvDrag();}
  });
  look.addEventListener('pointermove',e=>{
    if(cameraMode!=='fpv' || fpvDragPointer!==e.pointerId)return;
    const dx=e.clientX-fpvLastX,dy=e.clientY-fpvLastY;
    fpvLastX=e.clientX;fpvLastY=e.clientY;
    mouseLookYaw=((mouseLookYaw+dx*FPV_DRAG_SENSITIVITY)%360+360)%360;
    mouseLookPitch=clamp(mouseLookPitch-dy*FPV_DRAG_SENSITIVITY,-80,80);
    resetStabilization();updateFpvCamera();
  });
  look.addEventListener('pointerup',e=>{if(e.pointerId===fpvDragPointer)endFpvDrag();});
  look.addEventListener('pointercancel',e=>{if(e.pointerId===fpvDragPointer)endFpvDrag();});
  look.addEventListener('lostpointercapture',()=>{fpvDragPointer=null;look.classList.remove('dragging');});
  window.addEventListener('blur',endFpvDrag);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)endFpvDrag();});
  const map=$('.map-panel');
  map.addEventListener('dragover',e=>{e.preventDefault();});
  map.addEventListener('drop',e=>{e.preventDefault();importFile(e.dataTransfer?.files?.[0]);});
}
function loop(ts) {
  if(!frameTime)frameTime=ts;
  const dt=Math.min((ts-frameTime)/1000,.15);frameTime=ts;
  if(playing){currentTime+=dt*playbackRate;if(currentTime>=duration){currentTime=duration;playing=false;$('#playBtn').textContent='▶ Oynat';}}
  updateTimeline();
  if(cameraMode==='fpv')updateFpvCamera();
  if(ts-lastSidebarUpdate>150){renderSidebar();lastSidebarUpdate=ts;updateHud();}
  requestAnimationFrame(loop);
}
attachUI();refreshSourceUI();renderSidebar();showLoading('Harita yükleniyor','');
window.addEventListener('load',()=>{initMap();requestAnimationFrame(loop);});
