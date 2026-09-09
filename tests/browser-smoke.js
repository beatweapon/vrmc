import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile, mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {serve} from '../scripts/serve.js';

const server=serve(0);
if (!server.listening) await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser=await chromium.launch({headless:true,
    executablePath:process.env.CHROME_PATH || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined),
    args:['--enable-unsafe-swiftshader','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['camera'],serviceWorkers:'block'});
  // Test-only access to the displayed rig, so assertions measure the loaded
  // model's actual hand positions after the complete app/detector path.
  const viewerSource=await readFile(new URL('../docs/fullbody/viewer.js',import.meta.url),'utf8');
  await context.route('**/fullbody/viewer.js',route=>route.fulfill({contentType:'text/javascript',
    body:viewerSource.replace('this.stage = stage;', 'this.stage = stage; globalThis.testViewer = this;')}));
  // Inference itself is exercised with real models by tracker-browser.js. Here
  // controlled detector output makes blink/calibration UI flows reproducible.
  await context.route('**/fullbody/tracker.js',route=>route.fulfill({contentType:'text/javascript',body:`
    export class Tracker {
      constructor(callbacks){this.callbacks=callbacks;}
      async start(){
        this.stop();
        // Reproduce the native Tasks JS container, including unused scores.
        // Omitting visibility here hid a bug which rejected every real hand.
        const nativePoints=groups=>groups?.map(points=>points.map(point=>({...point,visibility:0})));
        const tick=()=>{
          const face=window.testFace?{...testFace,faceLandmarks:nativePoints(testFace.faceLandmarks)}:null;
          const hands=window.testHands?{...testHands,landmarks:nativePoints(testHands.landmarks),worldLandmarks:nativePoints(testHands.worldLandmarks)}:null;
          this.callbacks.onResults({face,pose:window.testPose||null,hands,time:performance.now()/1000-(window.testLatency||0)});
          this.timer=setTimeout(tick,window.testInterval||40);
        };
        this.timer=setTimeout(tick,40);
      }
      stop(){clearInterval(this.timer);}
      setOptions(){}
    }`}));
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${origin}/fullbody/`);
  await page.waitForFunction(()=>document.getElementById('model-name').textContent==='サンプルVRM',{timeout:30000});
  assert.equal(await page.locator('#loading').isVisible(),false);
  assert.equal(await page.locator('#stage > canvas').count(),1);
  assert.ok(await page.locator('#stage > canvas').evaluate(canvas=>canvas.width>0&&canvas.height>0));
  await mkdir('test-results',{recursive:true});
  await page.screenshot({path:'test-results/fullbody-desktop.png'});

  // The exported image has a real alpha channel; CSS checkerboard is excluded.
  const downloadEvent=page.waitForEvent('download');
  await page.locator('#save').click();
  const download=await downloadEvent;
  const png=await readFile(await download.path());
  assert.equal(png.subarray(1,4).toString(),'PNG');
  const alpha=await page.evaluate(async data=>{
    const image=new Image();image.src=data;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    return ctx.getImageData(0,0,1,1).data[3];
  },`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(alpha,0,'transparent PNG must preserve alpha');

  // Use the asymmetric sample model, freeze its exact pose, and compare real
  // exported pixels. A CSS-only flip would fail this export regression.
  await page.locator('#freeze').click();
  async function saveImage() {
    const pending=page.waitForEvent('download');
    await page.locator('#save').click();
    return `data:image/png;base64,${(await readFile(await (await pending).path())).toString('base64')}`;
  }
  await page.locator('[data-setting="mirrorAvatar"]').uncheck();
  const original=await saveImage();
  await page.locator('[data-setting="mirrorAvatar"]').check();
  const mirrored=await saveImage();
  const reflection=await page.evaluate(async ([original,mirrored])=>{
    async function pixels(src) {
      const image=new Image();image.src=src;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const context=canvas.getContext('2d');context.drawImage(image,0,0);
      return context.getImageData(0,0,canvas.width,canvas.height);
    }
    const a=await pixels(original), b=await pixels(mirrored);
    let maxError=0, different=0;
    for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++)for(let c=0;c<4;c++) {
      const i=(y*a.width+x)*4+c,j=(y*a.width+a.width-1-x)*4+c;
      maxError=Math.max(maxError,Math.abs(a.data[i]-b.data[j]));
      if(Math.abs(a.data[i]-b.data[i])>10) different++;
    }
    return {maxError,different};
  },[original,mirrored]);
  assert.ok(reflection.maxError<=2,`PNG reflection mismatch: ${JSON.stringify(reflection)}`);
  assert.ok(reflection.different>300,'an asymmetric avatar must visibly change when mirrored');
  assert.equal(await page.locator('#stage > canvas').evaluate(canvas=>getComputedStyle(canvas).transform),'matrix(-1, 0, 0, 1, 0, 0)');
  await page.locator('#freeze').click();

  await page.locator('[data-setting="eyeOpenLeft"]').fill('0.34');
  await page.locator('[data-setting="background"]').selectOption('green');
  await page.reload();
  await page.waitForFunction(()=>document.getElementById('model-name').textContent==='サンプルVRM');
  assert.equal(await page.locator('[data-setting="eyeOpenLeft"]').inputValue(),'0.34');
  assert.equal(await page.locator('[data-setting="background"]').inputValue(),'green');
  assert.equal(await page.locator('[data-setting="mirrorAvatar"]').isChecked(),true);

  await page.locator('#files').setInputFiles({name:'bad.vrm',mimeType:'application/octet-stream',buffer:Buffer.from('invalid vrm')});
  await page.waitForFunction(()=>document.getElementById('status').dataset.error==='true');
  assert.equal(await page.locator('#model-name').textContent(),'サンプルVRM','failed load preserves existing avatar');

  // Set anatomically consistent landmark locations for deterministic EAR.
  await page.evaluate(()=>{
    window.testFace={faceLandmarks:[Array.from({length:478},()=>({x:.5,y:.5,z:0}))],facialTransformationMatrixes:[{rows:4,columns:4,data:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,-50,1]}]};
    window.setEyes=ear=>{
      const set=(i,x,y)=>testFace.faceLandmarks[0][i]={x:.5+x,y:.5-y*4/3,z:0};
      for(const [indices,iris,center] of [[[362,385,387,263,373,380],473,.13],[[33,160,158,133,153,144],468,-.13]]){
        const h=ear*.12/2;
        [[-.06,0],[-.03,h],[.03,h],[.06,0],[.03,-h],[-.03,-h]].forEach(([x,y],j)=>set(indices[j],center+x,.08+y));
        set(iris,center,.08);
      }
      set(13,0,-.1);set(14,0,-.105);set(61,-.1,-.1);set(291,.1,-.1);
    };
    setEyes(.28);
  });
  await page.locator('#camera').click();
  await page.waitForFunction(()=>document.getElementById('connection').dataset.live==='true');
  await page.waitForFunction(()=>document.getElementById('face-state').dataset.active==='true');
  await page.locator('[data-setting="mirrorPreview"]').uncheck();
  assert.equal(await page.locator('#video').evaluate(video=>getComputedStyle(video).transform),'none');
  assert.equal(await page.locator('#stage > canvas').evaluate(canvas=>getComputedStyle(canvas).transform),'matrix(-1, 0, 0, 1, 0, 0)','camera preview mirror must not change the avatar setting');
  await page.locator('[data-setting="mirrorPreview"]').check();
  assert.equal(await page.locator('#video').evaluate(video=>getComputedStyle(video).transform),'matrix(-1, 0, 0, 1, 0, 0)');
  await page.locator('[data-calibrate="neutral"]').click();
  await page.waitForFunction(()=>document.getElementById('calibration-state').textContent.includes('記録しました'),null,{timeout:10000});
  await page.locator('[data-calibrate="eyesOpen"]').click();
  await page.waitForFunction(()=>document.getElementById('calibration-state').textContent.includes('開いた目を記録しました'),null,{timeout:10000});
  await page.evaluate(()=>setEyes(.055));
  await page.locator('[data-calibrate="eyesClosed"]').click();
  await page.waitForFunction(()=>document.getElementById('calibration-state').textContent.includes('閉じた目を記録しました'),null,{timeout:10000});
  assert.ok(Number(await page.locator('[data-setting="eyeClosedLeft"]').inputValue())<.08);


  // Inspect the loaded mesh's actual morph influences, after VRM's authored
  // mouth/blink overrides, rather than only FaceSolver output coefficients.
  await page.evaluate(()=>{
    setEyes(.28);
    window.setFacePose=({width=1,gap=.025,shapes={}}={})=>{
      const aspect=document.getElementById('video').videoWidth/document.getElementById('video').videoHeight;
      const put=(i,x,y)=>testFace.faceLandmarks[0][i]={x:.5+x,y:.5-y*aspect,z:0};
      put(13,0,-.1+.1*gap);put(14,0,-.1-.1*gap);
      put(61,-.1*width,-.1);put(291,.1*width,-.1);
      testFace.faceBlendshapes=[{categories:Object.entries(shapes).map(([categoryName,score])=>({categoryName,score}))}];
    };
    window.actualMorph=name=>{
      const expression=testViewer.avatar.vrm.expressionManager.getExpression(name);
      return Math.max(0,...expression.binds.flatMap(bind=>(bind.primitives||[]).map(mesh=>mesh.morphTargetInfluences[bind.index]||0)));
    };
  });
  for (const [name,pose] of [
    ['happy',{width:1.2,shapes:{mouthSmileLeft:.8,mouthSmileRight:.8}}],
    ['angry',{shapes:{browDownLeft:.8,browDownRight:.8}}],
    ['surprised',{gap:.3,shapes:{browInnerUp:.8,eyeWideLeft:.8,eyeWideRight:.8,jawOpen:.6}}],
  ]) {
    await page.evaluate(pose=>setFacePose(pose),pose);
    await page.waitForFunction(name=>actualMorph(name)>.4,name);
    if(name==='happy') {
      await page.locator('[data-setting="smileStrength"]').fill('0');
      await page.waitForFunction(()=>actualMorph('happy')<.01);
      await page.locator('[data-setting="smileStrength"]').fill('1');
      await page.waitForFunction(()=>actualMorph('happy')>.4);
    }
  }
  for (const [name,pose] of [
    ['aa',{width:1.02,gap:.43,shapes:{jawOpen:.7}}],
    ['ih',{width:1.24,gap:.085,shapes:{jawOpen:.09,mouthStretchLeft:.78,mouthStretchRight:.78}}],
    ['ou',{width:.72,gap:.03,shapes:{jawOpen:.035,mouthPucker:.8}}],
    ['ee',{width:1.23,gap:.25,shapes:{jawOpen:.38,mouthStretchLeft:.7,mouthStretchRight:.7}}],
    ['oh',{width:.78,gap:.35,shapes:{jawOpen:.5,mouthFunnel:.8}}],
  ]) {
    await page.evaluate(pose=>setFacePose(pose),pose);
    try {
      await page.waitForFunction(name=>actualMorph(name)>.4 &&
        ['aa','ih','ou','ee','oh'].filter(other=>other!==name).every(other=>actualMorph(name)>actualMorph(other)*2),name,{timeout:10000});
    } catch(error) {
      const values=await page.evaluate(()=>Object.fromEntries(['aa','ih','ou','ee','oh'].map(name=>[name,actualMorph(name)])));
      throw new Error('Vowel '+name+' did not reach the mesh: '+JSON.stringify(values),{cause:error});
    }
    assert.ok(await page.locator('#vowel-'+name).evaluate(meter=>meter.value>.4));
  }
  assert.equal(await page.locator('#expression-support').isVisible(),false,'sample has all requested expression presets');
  await page.evaluate(()=>setFacePose());
  // Face and hands are visible, but neither shoulders nor elbows are in frame.
  // Before wrist IK this rotated the palms down beside the avatar's waist.
  await page.evaluate(()=>{
    setEyes(.28);
    // A close-up with both hands beside, rather than overlapping, the face.
    for(const [indices,iris,center] of [[[362,385,387,263,373,380],473,.536],[[33,160,158,133,153,144],468,.464]]) {
      const h=.28*.02/2;
      [[-.01,0],[-.005,h],[.005,h],[.01,0],[.005,-h],[-.005,-h]].forEach(([x,y],j)=>{
        testFace.faceLandmarks[0][indices[j]]={x:center+x,y:.35-y*4/3,z:0};
      });
      testFace.faceLandmarks[0][iris]={x:center,y:.35,z:0};
    }
    const worlds=['Left','Right'].map((side)=>{
      const sign=side==='Left'?1:-1;
      const points=Array.from({length:21},()=>({x:0,y:0,z:0}));
      points[1]={x:.035*sign,y:-.02,z:0};points[2]={x:.05*sign,y:-.035,z:0};points[3]={x:.065*sign,y:-.045,z:0};points[4]={x:.08*sign,y:-.05,z:0};
      for(const [base,x] of [[5,.035],[9,0],[13,-.022],[17,-.04]])for(let j=0;j<4;j++)points[base+j]={x:x*sign,y:-.065-j*.025,z:0};
      return points;
    });
    testHands={worldLandmarks:worlds,landmarks:worlds.map((points,i)=>points.map(point=>({x:(i===0?.72:.28)+point.x*.3,y:.38+point.y*.3,z:point.z}))),
      handedness:[[{categoryName:'Left',score:.99}],[{categoryName:'Right',score:.99}]]};
  });
  function handsBesideFace() {
    const avatar=globalThis.testViewer?.avatar;
    if(!avatar?.solution.armTargets.left || !avatar?.solution.armTargets.right) return false;
    const height=name=>{const bone=avatar.vrm.humanoid.getRawBoneNode(name);return bone.getWorldPosition(bone.position.clone()).y;};
    const head=height('head'),chest=height('chest');
    return ['left','right'].every(side=>{
      const name=`${side}Hand`,bone=avatar.vrm.humanoid.getRawBoneNode(name);
      const wrist=bone.getWorldPosition(bone.position.clone());
      const target=avatar.rig.imageWristTarget(avatar.solution.armTargets[side]);
      return height(name)>chest+.08 && Math.abs(height(name)-head)<.18 && wrist.distanceTo(target)<.025;
    });
  }
  await page.waitForFunction(handsBesideFace,null,{timeout:10000});

  // Reproduce the reported ~4fps and delayed inference. Capture age must not
  // suppress a fresh result or advance FaceSolver on intervening render ticks.
  await page.evaluate(async ()=>{
    const {Matrix4,Euler}=await import('three');
    window.testInterval=250; window.testLatency=.22;
    window.testHeadBefore=testViewer.avatar.vrm.humanoid.getRawBoneNode('head').getWorldQuaternion(
      testViewer.avatar.rig.bones.head.quaternion.clone()).toArray();
    testFace.facialTransformationMatrixes[0].data=new Matrix4().makeRotationFromEuler(new Euler(0,0,.3)).toArray();
  });
  await page.waitForFunction(async ()=>{
    const {Quaternion}=await import('three');
    const head=testViewer.avatar.vrm.humanoid.getRawBoneNode('head');
    return head.getWorldQuaternion(new Quaternion()).angleTo(new Quaternion().fromArray(testHeadBefore))>.2;
  });
  await page.waitForFunction(()=>document.getElementById('fps').textContent==='4 fps');
  await page.locator('[data-calibrate="eyesOpen"]').click();
  await page.waitForFunction(()=>document.getElementById('calibration-state').textContent.includes('開いた目を記録しました'),null,{timeout:12000});

  assert.ok(Number((await page.locator('#latency').textContent()).match(/\d+/)[0])>=220);
  await page.waitForFunction(handsBesideFace,null,{timeout:10000});
  const stability=await page.evaluate(async ()=>{
    const {Vector3}=await import('three');
    const rig=testViewer.avatar.vrm.humanoid;
    const points=[];
    for(let i=0;i<100;i++) {
      await new Promise(requestAnimationFrame);
      points.push(rig.getRawBoneNode('leftHand').getWorldPosition(new Vector3()));
    }
    const center=points.reduce((sum,p)=>sum.add(p),new Vector3()).divideScalar(points.length);
    return Math.max(...points.map(p=>p.distanceTo(center)));
  });
  assert.ok(stability<.015,'a stationary raised hand must not wave between slow results: '+stability);

  // Pose shoulders remain observable while the pelvis is cropped out. Verify
  // a real raw chest bone, independently of the solution's own tracked flag.
  await page.evaluate(()=>{
    const world=Array.from({length:33},()=>({x:0,y:0,z:0,visibility:0}));
    const landmarks=Array.from({length:33},()=>({x:.5,y:1.2,z:0,visibility:0}));
    for(const [index,sign] of [[11,1],[12,-1]]) {
      world[index]={x:sign*.2*Math.cos(.22),y:-.5-sign*.2*Math.sin(.22),z:0,visibility:1};
      landmarks[index]={x:.5+sign*.18,y:.64-sign*.04,z:0,visibility:1};
    }
    testPose={worldLandmarks:[world],landmarks:[landmarks]};
  });
  await page.waitForFunction(async ()=>{
    const {Vector3}=await import('three');
    const avatar=testViewer.avatar;
    const chest=avatar.vrm.humanoid.getRawBoneNode('chest');
    const up=new Vector3(0,1,0).applyQuaternion(chest.getWorldQuaternion(chest.quaternion.clone()));
    return !avatar.solution.hips && avatar.solution.tracked && Math.abs(up.x)>.12;
  });
  // Drive an actual fist, then a V sign. Check raw segment bend angles, not
  // the landmark solver's own quaternion targets or a hand-count indicator.
  await page.evaluate(()=>{
    window.testOpenHands=structuredClone(testHands.worldLandmarks);
    window.setGesture=extended=>{
      testHands.worldLandmarks=structuredClone(testOpenHands);
      for(const points of testHands.worldLandmarks)for(const base of [5,9,13,17]) {
        let total=0;
        for(let j=1;j<=3;j++) {
          total+=extended.includes(base)?0:[.9,1.4,1][j-1];
          points[base+j]={x:points[base].x,y:points[base+j-1].y-Math.cos(total)*.025,
            z:points[base+j-1].z+Math.sin(total)*.025};
        }
      }
    };
    setGesture([]);
  });
  function rawFingerPose(extended) {
    const avatar=testViewer.avatar;
    const bones=avatar.vrm.humanoid;
    return ['left','right'].every(side=>['Index','Middle','Ring','Little'].every(finger=>{
      const nodes=['Proximal','Intermediate','Distal'].map(joint=>bones.getRawBoneNode(side+finger+joint));
      const p=nodes.map(node=>node.getWorldPosition(node.position.clone()));
      const bend=p[1].clone().sub(p[0]).angleTo(p[2].clone().sub(p[1]));
      return extended.includes(finger)?bend<.3:bend>.9;
    }));
  }
  await page.waitForFunction(rawFingerPose,[],{timeout:10000});
  await page.evaluate(()=>setGesture([5,9]));
  await page.waitForFunction(rawFingerPose,['Index','Middle'],{timeout:10000});
  await page.screenshot({path:'test-results/fullbody-tracked-v-sign.png'});
  await page.evaluate(()=>{testPose=null; setGesture([5,9,13,17]);});
  await page.waitForFunction(handsBesideFace,null,{timeout:10000});
  await page.evaluate(()=>{
    window.bothHands=structuredClone(testHands);
    window.testInterval=100;window.testLatency=.099;
    window.raiseOneHand=(side,duplicate=false)=>{
      const index=side==='left'?0:1;
      const image=structuredClone(bothHands.landmarks[index]);
      const shift=.38-image[0].x;
      image.forEach(p=>p.x+=shift); // Both physical hands reuse the same screen position.
      const handWorld=structuredClone(bothHands.worldLandmarks[index]);
      const wrong=side==='left'?'Right':'Left';
      testHands={landmarks:[image],worldLandmarks:[handWorld],handedness:[[{categoryName:wrong,score:.99}]]};
      if(duplicate) {
        testHands.landmarks.push(structuredClone(image));testHands.worldLandmarks.push(structuredClone(handWorld));
        testHands.handedness.push([{categoryName:side==='left'?'Left':'Right',score:.99}]);
      }
      const world=Array.from({length:33},()=>({x:0,y:0,z:0,visibility:0}));
      const landmarks=Array.from({length:33},()=>({x:.5,y:1.2,z:0,visibility:0}));
      for(const [i,sign] of [[11,1],[12,-1]]) {
        world[i]={x:sign*.2,y:-.5,z:0,visibility:1};landmarks[i]={x:.5+sign*.18,y:.64,z:0,visibility:1};
      }
      landmarks[side==='left'?15:16]={...image[0],visibility:.99};
      testPose={worldLandmarks:[world],landmarks:[landmarks]};
    };
  });
  for(const [side,duplicate] of [['right',false],['left',false],['right',true],['left',true]]) {
    await page.evaluate(([side,duplicate])=>raiseOneHand(side,duplicate),[side,duplicate]);
    await page.waitForFunction(side=>{
      const avatar=testViewer.avatar,rig=avatar.vrm.humanoid;
      const other=side==='left'?'right':'left';
      const height=name=>{const node=rig.getRawBoneNode(name);return node.getWorldPosition(node.position.clone()).y;};
      return Object.keys(avatar.solution.armTargets).length===1 && avatar.solution.armTargets[side] &&
        height(side+'Hand')>height('chest')+.10 && height(other+'Hand')<height('chest')-.08 &&
        !avatar.rig.lastArmTargets.has(other);
    },side,{timeout:10000});
  }
  await page.evaluate(()=>{testPose=null;testHands=structuredClone(bothHands);});
  await page.waitForFunction(handsBesideFace,null,{timeout:10000});

  await page.locator('#freeze').click();
  assert.equal(await page.locator('#freeze').getAttribute('aria-pressed'),'true');
  const popupEvent=page.waitForEvent('popup');
  await page.locator('#output').click();
  const popup=await popupEvent;
  popup.on('pageerror',error=>errors.push(error.message));
  await popup.waitForFunction(()=>document.querySelector('#stage > canvas')?.width>0);
  await popup.waitForTimeout(1500);
  assert.equal(await popup.locator('aside').isVisible(),false);
  assert.equal(await popup.locator('.camera-preview').isVisible(),false);
  assert.equal(await popup.title(),'VRMC Full Body — 配信出力');
  assert.equal(await popup.locator('#stage > canvas').evaluate(canvas=>getComputedStyle(canvas).transform),'matrix(-1, 0, 0, 1, 0, 0)');
  await page.locator('[data-setting="mirrorAvatar"]').uncheck();
  await popup.waitForFunction(()=>getComputedStyle(document.querySelector('#stage > canvas')).transform==='none');
  await page.locator('[data-setting="mirrorAvatar"]').check();
  await popup.waitForFunction(()=>getComputedStyle(document.querySelector('#stage > canvas')).transform==='matrix(-1, 0, 0, 1, 0, 0)');
  await popup.screenshot({path:'test-results/fullbody-output.png'});
  await page.locator('#freeze').click();
  await popup.waitForFunction(handsBesideFace,null,{timeout:10000});
  await page.locator('#freeze').click();
  await page.locator('#camera').click();
  assert.equal(await page.locator('#camera-preview').isVisible(),false);
  assert.equal(await page.locator('[data-setting="quality"]').isEnabled(),true);
  await page.locator('#freeze').click();
  await page.locator('#reset').click();
  assert.equal(await page.locator('[data-setting="eyeOpenLeft"]').inputValue(),'0.28');
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile layout must not overflow horizontally');
  await page.screenshot({path:'test-results/fullbody-mobile.png',fullPage:true});
  await popup.close();
  assert.deepEqual(errors,[]);
  console.log('Browser UI: sample VRM, alpha PNG, saved settings, invalid VRM recovery, camera/calibration, 4fps + 220ms delay, stationary wrists, cropped torso, fist/V fingers, single-hand identity/duplicates, expression mesh and five vowels, frozen output, stop/reset and mobile layout passed.');
} finally {
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
