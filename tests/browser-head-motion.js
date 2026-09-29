import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {serve} from '../scripts/serve.js';

// Same raw head observations, two rendered VRMs. Left reproduces the former
// fixed 80 ms head spring; right uses the runtime's cadence-aware head response.
// Synthetic time is 60 renders / 4 captures per second. No camera is accessed.
const server=serve(0);
if(!server.listening) await once(server,'listening');
let browser;
try {
  browser=await chromium.launch({headless:true,
    executablePath:process.env.CHROME_PATH || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined),
    args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:840,height:540},serviceWorkers:'block'});
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/fullbody/app.js',route=>route.fulfill({contentType:'text/javascript',body:`
    import {Viewer} from './viewer.js';
    import {solveBody} from './body.js';
    import {dampQuaternion} from './motion.js';
    import {Quaternion,Vector3} from 'three';
    document.body.innerHTML='<div id="views" style="display:flex"></div><canvas id="comparison" width="840" height="540"></canvas>';
    const viewers=[];
    for(let i=0;i<2;i++) {
      const stage=document.createElement('div');stage.style.cssText='width:420px;height:420px';
      document.getElementById('views').append(stage);
      const viewer=new Viewer(stage);await viewer.load(null);viewers.push(viewer);
      for(let frame=0;frame<120;frame++){viewer.avatar.rig.update(solveBody(null,null),0,frame/60,1/60,{});viewer.avatar.vrm.update(1/60);}
      const head=viewer.avatar.rig.bones.head.getWorldPosition(new Vector3());
      viewer.controls.target.copy(head).add(new Vector3(0,-.04,0));
      viewer.camera.position.copy(viewer.controls.target).add(new Vector3(0,0,.9));
      viewer.controls.update();viewer.renderer.setClearColor(0x26323c,1);
    }
    const canvas=document.getElementById('comparison'),ctx=canvas.getContext('2d');
    // Keep rendering canvases laid out for their dimensions, display the composite.
    document.getElementById('views').style.position='absolute';
    document.getElementById('views').style.top='-1000px';
    const chunks=[], stream=canvas.captureStream(60),recorder=new MediaRecorder(stream,{mimeType:'video/webm'});
    recorder.ondataavailable=e=>chunks.push(e.data);
    const baseline=new Quaternion(),velocity=new Vector3(),axis=new Vector3(0,1,0);
    const rest=viewers.map(v=>v.avatar.vrm.humanoid.getRawBoneNode('head').getWorldQuaternion(new Quaternion()).invert());
    const traces=[[],[]];let previous=[0,0];
    globalThis.recordHeadMotion=async()=>{
      recorder.start();
      for(let frame=0;frame<480;frame++) {
        const time=frame/60,capture=Math.floor(Math.max(0,time-.04)*4)/4;
        const turn=.16*(capture<3?capture:Math.max(0,6-capture));
        const target=new Quaternion().setFromAxisAngle(axis,turn);
        dampQuaternion(baseline,velocity,target,1/60,.08);
        for(let i=0;i<2;i++) {
          const viewer=viewers[i],{rig,vrm}=viewer.avatar;
          const face=i?{tracked:true,head:target.toArray(),headTarget:target.toArray(),captureTime:capture}
            :{tracked:true,head:baseline.toArray()};
          rig.updateHead(face,capture+.04,time,1/60,{faceSmoothing:.08});vrm.update(1/60);
          viewer.renderer.render(viewer.scene,viewer.camera);
          const q=vrm.humanoid.getRawBoneNode('head').getWorldQuaternion(new Quaternion()).multiply(rest[i]);
          const angle=2*Math.atan2(q.y,q.w);
          traces[i].push({time,angle,velocity:(angle-previous[i])*60});previous[i]=angle;
          ctx.drawImage(viewer.renderer.domElement,i*420,0,420,420);
        }
        ctx.fillStyle='#10191e';ctx.fillRect(0,420,840,120);ctx.fillStyle='white';ctx.font='16px sans-serif';
        ctx.fillText('Fixed 80 ms',12,445);ctx.fillText('Cadence-aware / 4 fps input',432,445);
        ctx.fillText('Synthetic time: '+time.toFixed(2)+' s',12,530);
        for(let i=0;i<2;i++) {
          ctx.strokeStyle=i?'#a9efd8':'#f0ac8c';ctx.beginPath();
          traces[i].forEach((p,j)=>{const x=i*420+p.time/8*420,y=505-p.velocity*80;if(j)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.stroke();
        }
        await new Promise(requestAnimationFrame);
      }
      await new Promise(resolve=>{recorder.onstop=resolve;recorder.stop();});stream.getTracks().forEach(track=>track.stop());
      const bytes=new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer());
      let binary='';for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      return {traces,video:btoa(binary)};
    };
  `}));
  await page.goto(`http://127.0.0.1:${server.address().port}/fullbody/`);
  await page.waitForFunction(()=>!!globalThis.recordHeadMotion);
  const {traces,video}=await page.evaluate(()=>recordHeadMotion());
  await mkdir('test-results',{recursive:true});
  await writeFile('test-results/head-motion.webm',Buffer.from(video,'base64'));
  await writeFile('test-results/head-motion-rendered.json',JSON.stringify(traces));
  await page.locator('#comparison').screenshot({path:'test-results/head-motion.png'});
  const quantile=(a,p)=>a.sort((x,y)=>x-y)[Math.floor((a.length-1)*p)];
  const spreads=traces.map(points=>{
    const speeds=points.filter(p=>p.time>=1.5&&p.time<2.9).map(p=>p.velocity);
    return quantile([...speeds],.9)-quantile([...speeds],.1);
  });
  assert.ok(spreads[1]<spreads[0]*.65,`raw VRM speed variation did not improve: ${spreads}`);
  assert.ok(traces.every(points=>Math.abs(points.at(-1).angle)<.001),'both heads settle after the turn');
  assert.deepEqual(errors,[]);
  console.log('Actual VRM head replay passed. Speed spread:',spreads,'Video: test-results/head-motion.webm');
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
