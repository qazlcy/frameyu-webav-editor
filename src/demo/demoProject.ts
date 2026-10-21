import type { Asset, Project } from '../editor/types';
import { emptyProject } from '../editor/types';
import { addAsset, appendVideoClip, addAudioClip, addCaption, updateClip } from '../editor/commands';

export const scenes = [
  { id: 'coast', name: '01 · 向海而行', note: '海岸 / 开场', colors: ['#073a48','#137b89','#88c6bb'] },
  { id: 'dune', name: '02 · 风经过沙丘', note: '沙丘 / 呼吸', colors: ['#224646','#5b8580','#c4bf95'] },
  { id: 'sunset', name: '03 · 日落之前', note: '暮色 / 收尾', colors: ['#293f55','#6b7283','#d7a78c'] },
];

/** Original vector artwork; no stock photos, remote media or third-party graphics. */
export function sceneSvg(index: number): string {
  const scene = scenes[index];
  const waves = Array.from({ length: 19 }, (_, i) => `<path d="M ${400+i*38} -60 C ${260+i*40} 180 ${660+i*28} 360 ${380+i*54} 800" fill="none" stroke="#d4e7d8" stroke-width="${i%3===0?2:1}" opacity="${.06+(i%4)*.025}"/>`).join('');
  const contours = Array.from({length:9},(_,i)=>`<path d="M -80 ${70+i*30} Q ${180+i*8} ${110+i*30} ${140+i*10} 380 T ${300+i*20} 850" fill="none" stroke="#938f6c" stroke-width="1.4" opacity=".25"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs><linearGradient id="sea" x1="1" y1="0" x2="0" y2="1"><stop stop-color="${scene.colors[0]}"/><stop offset=".65" stop-color="${scene.colors[1]}"/><stop offset="1" stop-color="${scene.colors[2]}"/></linearGradient><linearGradient id="land" x1="0" x2="1"><stop stop-color="#b9bc95"/><stop offset="1" stop-color="#ebdabc"/></linearGradient><radialGradient id="light"><stop stop-color="#f5d8ae" stop-opacity=".35"/><stop offset="1" stop-color="#e5c5a2" stop-opacity="0"/></radialGradient><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".12"/></feComponentTransfer><feBlend in="SourceGraphic" mode="soft-light"/></filter></defs>
  <rect width="1280" height="720" fill="url(#sea)"/>
  <ellipse cx="1040" cy="80" rx="580" ry="430" fill="url(#light)"/>
  ${waves}
  <path d="M 0 0 H 285 C 300 100 170 150 210 245 C 255 350 350 360 310 460 C 285 530 420 600 550 720 H 0Z" fill="url(#land)"/>
  <path d="M 286 -20 C 320 100 185 150 228 243 C 275 350 365 360 331 460 C 300 545 440 612 585 750" fill="none" stroke="#d7e6cc" stroke-width="30" opacity=".5"/>
  <path d="M 302 -20 C 336 100 200 151 245 243 C 290 350 379 360 345 460 C 319 545 455 612 602 750" fill="none" stroke="#cce8dc" stroke-width="3" opacity=".9"/>
  ${contours}
  <path d="M 0 20 Q 170 80 130 230 Q 80 330 170 455 Q 190 560 330 720H0Z" fill="#5a7660" opacity=".6"/>
  <path d="M 0 30 Q 130 170 64 270 Q 24 380 110 520L180 720H0Z" fill="#365d50" opacity=".55"/>
  <g filter="url(#grain)"><rect width="1280" height="720" fill="transparent"/></g>
  <circle cx="1020" cy="156" r="${index===2?65:39}" fill="#f4d9ab" opacity="${index===2?.85:.18}"/>
  <g fill="none" stroke="#e8e2c7" opacity=".6"><path d="M843 260l32 12-30 5z"/><path d="M844 263l2 12"/></g>
  <g fill="#edf0dc" font-family="sans-serif" font-size="12" letter-spacing="4"><text x="58" y="62">A FIELD NOTE / ${String(index+1).padStart(2,'0')}</text><text x="1220" y="62" text-anchor="end">SLOW COAST</text></g>
  <g stroke="#ece7cd" opacity=".65"><path d="M58 82h94M1140 640h80M1180 600v80"/></g>
  <text x="58" y="665" fill="#e9e6cd" font-family="monospace" font-size="13" letter-spacing="2">24° 28′ N  /  118° 06′ E</text>
  </svg>`;
}

export function toneWav(): Blob {
  const rate=24000, count=rate*12, bytes=new ArrayBuffer(44+count*2), view=new DataView(bytes);
  const text=(offset:number,value:string)=>[...value].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));
  text(0,'RIFF');view.setUint32(4,36+count*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,count*2,true);
  const notes=[130.81,164.81,196,146.83,174.61,220];
  for(let i=0;i<count;i++){const t=i/rate, beat=t%2, envelope=Math.exp(-beat*2.2)*Math.min(1,beat*35)*Math.min(1,(12-t)*2), f=notes[Math.floor(t/2)];const sample=(Math.sin(t*f*Math.PI*2)+.24*Math.sin(t*f*4*Math.PI))*.16*envelope;view.setInt16(44+i*2,Math.round(sample*32767),true);}
  return new Blob([bytes],{type:'audio/wav'});
}
export function makeDemoProject(): Project {
  let p=emptyProject();
  scenes.forEach(s=>{const asset:Asset={id:s.id,name:s.name,type:'video',mimeType:'video/mp4',durationMs:4000,width:1280,height:720};p=appendVideoClip(addAsset(p,asset),asset);});
  const audio:Asset={id:'ambient',name:'海风来信 · 原创合成音',type:'audio',audioKind:'music',mimeType:'audio/wav',durationMs:12000};
  p=addAudioClip(addAsset(p,audio),audio,'music');
  ['把周末，还给海风。','走慢一点，听见自己。','下一站，不必着急。'].forEach((text,i)=>{p=addCaption(p,'caption',{text,startMs:i*4000,endMs:(i+1)*4000});});
  p={...p,tracks:p.tracks.map(t=>({...t,name:t.type==='video'?'主画面':t.type==='caption'?'叙事字幕':t.type==='music'?'氛围音乐':'环境音',heightPx:54}))};
  p.clips.filter(c=>c.type==='caption').forEach(c=>{p=updateClip(p,c.id,{captionStyle:{fontSize:48,color:'#ffffff',position:'bottom'}});});
  return p;
}
