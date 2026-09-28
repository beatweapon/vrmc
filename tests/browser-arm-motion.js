import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serve } from '../scripts/serve.js';

// Render an acquisition transition from rest, rather than just inspecting the
// final hand position. No camera permission or capture is used by this harness.
const server=serve(0);
if(!server.listening) await once(server,'listening');
let browser;
try {
  browser=await chromium.launch({headless:true,
    executablePath:process.env.CHROME_PATH || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined),
    args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:700,height:700},serviceWorkers:'block'});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/fullbody/app.js',route=>route.fulfill({contentType:'text/javascript',body:`
    import {Viewer} from './viewer.js';
    import {solveBody} from './body.js';
    import {measureHand} from './hand-rig.js';
    import {Vector3} from 'three';
    const viewer=new Viewer(document.getElementById('stage'));
    await viewer.load(null);
    document.getElementById('loading').remove();
    document.getElementById('stage-notice').remove();
    const {rig,vrm}=viewer.avatar, empty=solveBody(null,null);
    const position=name=>vrm.humanoid.getRawBoneNode(name).getWorldPosition(new Vector3());
    for(let i=0;i<180;i++){rig.update(empty,0,i/60,1/60,{});vrm.update(1/60);}
    const shoulder=position('rightUpperArm'), origin=shoulder.clone().add(position('leftUpperArm')).multiplyScalar(.5);
    const reach=shoulder.distanceTo(position('rightLowerArm'))+position('rightLowerArm').distanceTo(position('rightHand'));
    const target=shoulder.clone().add(new Vector3(-.03,.28,.096).multiplyScalar(reach/.6));
    const solution=solveBody(null,null);
    solution.armTargets.right={aspect:1,physicalId:1,
      shoulders:{x:.5,y:.5,span:rig.shoulderWidth,foreshorten:1},
      wrist:{x:.5+target.x-origin.x,y:.5-target.y+origin.y},depthRatio:(target.z-origin.z)/rig.shoulderWidth};
    const hand=Array.from({length:21},()=>({x:0,y:0,z:0}));
    for(const [base,x] of [[1,-.05],[5,-.035],[9,0],[13,.022],[17,.04]])
      for(let j=0;j<4;j++)hand[base+j]={x,y:-.065-j*.025,z:0};
    solution.hands.right=measureHand(hand,'right');
    const traces=[]; let render=0, observedAt=3;
    globalThis.motionHarness={
      advance(frame){while(render<frame){
        const now=3+render/60;if(Math.floor(render*7/60)!==Math.floor((render-1)*7/60))observedAt=now;
        rig.update(solution,observedAt,now,1/60,{});vrm.update(1/60);
        const elbow=position('rightLowerArm'),wrist=position('rightHand');
        traces.push({elbow:elbow.toArray(),wrist:wrist.toArray(),upperTwist:rig.wristRotations.get('right')?.upperTwist});render++;
      }},
      view(side){
        viewer.controls.target.copy(origin).add(new Vector3(0,-.08,0));
        viewer.camera.position.copy(viewer.controls.target).add(side?new Vector3(1.5,0,0):new Vector3(0,0,1.5));
        viewer.controls.update();viewer.renderer.setClearColor(0x26323c,1);viewer.renderer.render(viewer.scene,viewer.camera);
      },
      report(){return {traces,target:target.toArray(),shoulder:shoulder.toArray(),reach};}
    };
    motionHarness.view(false);
  `}));
  await page.goto(`http://127.0.0.1:${server.address().port}/fullbody/`);
  await page.waitForFunction(()=>!!globalThis.motionHarness);
  await mkdir('test-results',{recursive:true});
  for(const frame of [0,5,10,15,24,48,120]) {
    await page.evaluate(frame=>motionHarness.advance(frame),frame);
    for(const side of [false,true]) {
      await page.evaluate(side=>motionHarness.view(side),side);
      await page.locator('#stage').screenshot({path:`test-results/arm-raise-${side?'side':'front'}-${frame}.png`});
    }
  }
  const report=await page.evaluate(()=>motionHarness.report());
  await writeFile('test-results/arm-raise.json',JSON.stringify(report));
  const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
  assert.ok(distance(report.traces.at(-1).wrist,report.target)<.005,'the final observed wrist must be preserved');
  assert.ok(Math.max(...report.traces.map(frame=>frame.wrist[2]-report.shoulder[2]))>report.reach*.35,
    'the rendered acquisition must travel forwards');
  for(const frame of report.traces) {
    const y=frame.wrist[1]-report.shoulder[1];
    if(y<0 && y>-.5*report.reach) assert.ok(frame.elbow[1]<frame.wrist[1]+.07*report.reach,'elbow must not lead a rising hand');
    assert.ok([...frame.elbow,...frame.wrist,frame.upperTwist].every(Number.isFinite));
  }
  assert.deepEqual(errors,[]);
  console.log('Rendered VRM: forward acquisition arc, elbow below rising hand, final wrist accuracy; front/side frames saved in test-results/arm-raise-*.png.');
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
