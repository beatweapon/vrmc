import {Object3D, Quaternion, Vector3} from 'three';
import {BodyRetargeter} from '../../docs/fullbody/body.js';

export function replayHead({fps=7, response=.08, jitter=false, renderFps=60, turnBack=false, dropout=false, lostPackets=false}={}) {
  const chest=new Object3D(), neck=new Object3D(), head=new Object3D();
  chest.add(neck); neck.add(head); neck.position.y=.1; head.position.y=.1;
  const rig=new BodyRetargeter({chest,neck,head});
  const axis=new Vector3(0,1,0), speed=.16, inference=.04;
  const input=t=>turnBack ? speed*(t<3?Math.max(0,t):Math.max(0,6-t)) : speed*Math.max(0,Math.min(t,6));
  const packets=[];
  for(let time=0,index=0;time<9;index++) {
    if(!dropout || lostPackets || time<3 || time>=4) packets.push({capture:time,receipt:time+inference});
    time+=(jitter ? [1,.65,1.35,1,1.15,.85][index%6] : 1)/fps;
  }
  let packetIndex=0, packet=null, face=null, previous=0;
  const traces=[];
  for(let frame=0;frame<9*renderFps;frame++) {
    const now=frame/renderFps;
    while(packetIndex<packets.length && packets[packetIndex].receipt<=now) {
      packet=packets[packetIndex++];
      face={tracked:true,head:[0,0,0,1],headTarget:new Quaternion().setFromAxisAngle(axis,input(packet.capture)).toArray(),
        captureTime:packet.capture};
      if(dropout && lostPackets && packet.capture>=3 && packet.capture<4) face={tracked:false,captureTime:packet.capture};
    }
    if(face) rig.updateHead(face,packet.receipt,now,1/renderFps,{faceSmoothing:response});
    const rotation=head.getWorldQuaternion(new Quaternion());
    const angle=2*Math.atan2(rotation.y,rotation.w);
    traces.push({time:now,input:input(now),angle,velocity:(angle-previous)*renderFps,
      lag:(input(now)-angle)/speed});
    previous=angle;
  }
  const moving=traces.filter(point=>point.time>=2 && point.time<5.8);
  const quantile=(values,p)=>values.sort((a,b)=>a-b)[Math.floor((values.length-1)*p)];
  const speeds=moving.map(point=>point.velocity/speed);
  return {traces,metrics:{
    speedP10:quantile([...speeds],.1),speedP90:quantile([...speeds],.9),
    lagP50:quantile(moving.map(point=>point.lag),.5),lagP95:quantile(moving.map(point=>point.lag),.95),
    maxOvershoot:Math.max(0,...traces.map(point=>point.angle-input(point.time))),
    finalError:Math.abs(traces.at(-1).angle-input(9)),
  }};
}
