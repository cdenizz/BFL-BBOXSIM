from pathlib import Path
from playwright.sync_api import sync_playwright
p=Path(__file__).resolve().parents[1]
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
    page=browser.new_page(viewport={'width':1500,'height':850})
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.set_content((p/'index.html').read_text(encoding='utf-8'),wait_until='domcontentloaded')
    page.add_style_tag(path=str(p/'style.css'))
    page.add_style_tag(path=str(p/'refine.css'))
    page.add_script_tag(path=str(p/'app.js'))
    page.evaluate("""() => {
      window.Cesium={SceneMode:{SCENE3D:3}};
      viewer={trackedEntity:null,camera:{frustum:{fov:1.25}},scene:{mode:3,screenSpaceCameraController:{enableInputs:true}}};
      aircraft=[{id:'DRONE',name:'DRONE',samples:[{t:0,lat:40.9,lon:37.8,alt:100,heading:90}]}];
      selectedId='DRONE';
      updateFpvCamera=()=>{};updateHud=()=>{};
      document.querySelector('#mapLoading').style.display='none';
    }""")
    page.locator('#fpvBtn').click()
    assert page.locator('#fpvLookLayer').is_visible()
    assert page.evaluate('cameraMode')=='fpv'
    assert page.evaluate('viewer.scene.screenSpaceCameraController.enableInputs') is False
    box=page.locator('#fpvLookLayer').bounding_box();x=box['x']+box['width']*.48;y=box['y']+box['height']*.5
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+240,y-60,steps=9)
    yaw,pitch=page.evaluate('[mouseLookYaw,mouseLookPitch]')
    assert abs(yaw)>20 and pitch>7,(yaw,pitch)
    assert page.evaluate('document.pointerLockElement===null')
    assert page.evaluate('fpvDragPointer!==null')
    page.mouse.up();page.mouse.move(x+250,y)
    assert page.evaluate('fpvDragPointer===null')
    assert page.evaluate('mouseLookYaw')==yaw
    page.locator('#hudLookReset').click()
    assert page.evaluate('mouseLookYaw===0&&mouseLookPitch===0')
    # Press Escape DURING an active drag: should release capture and exit.
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+20,y,steps=3)
    assert page.evaluate('fpvDragPointer!==null')
    page.keyboard.press('Escape')
    assert page.evaluate("cameraMode==='free'&&fpvDragPointer===null")
    assert page.evaluate('viewer.scene.screenSpaceCameraController.enableInputs') is True
    assert page.locator('#fpvLookLayer').is_hidden()
    page.mouse.up()
    # FPV -> HUD exit -> map, no lock ever.
    page.locator('#fpvBtn').click()
    page.locator('#hudExit').click()
    assert page.evaluate("cameraMode==='free'&&document.pointerLockElement===null")
    # Browser-tested locally; keep the release source clean.
    print('PASS: drag, drag stop, reset, ESC mid-drag, HUD exit, normal pointer and Cesium controls restored')
    print('PAGE JS errors:',errors)
    assert not errors
    browser.close()
