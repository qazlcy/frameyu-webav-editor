import type { Project, TimelineClip } from '../editor/types';
import { defaultVideoLayout } from '../editor/commands';
import { validatePlan, type MediaInfo, type Plan } from '../../shared/plan.mjs';
export const mediaInfo = (p:Project,ids:string[]):MediaInfo[] => ids.map(id=>{const a=p.assets.find(a=>a.id===id&&a.type==='video');if(!a)throw Error('素材已不存在');return {id:a.id,durationMs:Math.floor(a.durationMs),width:a.width??0,height:a.height??0};});
export function buildPlanProject(base:Project, raw:unknown, assets:MediaInfo[]):Project {
 const plan=validatePlan(raw,assets);for(const a of assets){const current=mediaInfo(base,[a.id])[0];if(JSON.stringify(current)!==JSON.stringify(a))throw Error('素材信息已变化');}
 if(base.tracks.some(t=>t.locked))throw Error('存在锁定轨道，请先解锁');
 const video=base.tracks.find(t=>t.type==='video'),caption=base.tracks.find(t=>t.type==='caption');if(!video||(!caption&&plan.titles.length))throw Error('缺少视频或字幕轨道');
 let startMs=0;const clips:TimelineClip[]=plan.segments.map(s=>{const durationMs=s.outMs-s.inMs;const c:TimelineClip={id:crypto.randomUUID(),trackId:video.id,type:'video',assetId:s.assetId,name:base.assets.find(a=>a.id===s.assetId)!.name,startMs,sourceStartMs:s.inMs,sourceDurationMs:durationMs,durationMs,playbackRate:1,volume:s.volume,videoLayout:defaultVideoLayout(base,base.assets.find(a=>a.id===s.assetId))};startMs+=durationMs;return c;});
 clips.push(...plan.titles.map(t=>({id:crypto.randomUUID(),trackId:caption!.id,type:'caption' as const,name:t.text,text:t.text,startMs:t.startMs,durationMs:t.endMs-t.startMs,sourceStartMs:0,volume:1,captionStyle:{fontSize:46,color:'#ffffff',position:t.position}})));
 return {...base,clips,tracks:base.tracks.map(t=>({...t,clipIds:clips.filter(c=>c.trackId===t.id).map(c=>c.id)}))};
}
export async function applyTransaction(base:Project,current:()=>Project,plan:Plan,assets:MediaInfo[],sync:(p:Project)=>Promise<void>,commit:(p:Project)=>void){
 if(current()!==base)throw Error('时间线已改变，请重新生成计划');const next=buildPlanProject(base,plan,assets);
 try{await sync(next);if(current()!==base)throw Error('时间线已改变，请重新生成计划');commit(next);}catch(error){await sync(current()).catch(()=>undefined);throw error;}
}
