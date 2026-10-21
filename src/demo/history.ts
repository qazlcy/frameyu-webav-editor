import type { Project, TimelineClip } from '../editor/types';
import { updateClip } from '../editor/commands';
export interface HistoryState { past: Project[]; present: Project; future: Project[]; }
export type HistoryAction = {type:'edit'; project:Project}|{type:'undo'}|{type:'redo'};
export function historyReducer(state:HistoryState,action:HistoryAction):HistoryState {
  if(action.type==='edit')return action.project===state.present?state:{past:[...state.past.slice(-39),state.present],present:action.project,future:[]};
  if(action.type==='undo'&&state.past.length)return {past:state.past.slice(0,-1),present:state.past[state.past.length-1],future:[state.present,...state.future]};
  if(action.type==='redo'&&state.future.length)return {past:[...state.past,state.present],present:state.future[0],future:state.future.slice(1)};
  return state;
}
export interface DemoProposal { title:string; explanation:string; clipId:string; before:string; after:string; patch:Partial<TimelineClip>; base:Project; }
export function makeProposal(project:Project,kind:'caption'|'music'|'position'):DemoProposal {
  const clip=project.clips.find(c=>c.type===(kind==='music'?'audio':'caption'))!;
  if(kind==='music')return {title:'让音乐退后一点',explanation:'仅修改背景音乐片段音量，保留素材与剪辑时长。',clipId:clip.id,before:`${Math.round(clip.volume*100)}%`,after:'20%',patch:{volume:.2},base:project};
  if(kind==='position')return {title:'让开场文字成为焦点',explanation:'将第一段字幕移到画面中央，其他字幕保持不变。',clipId:clip.id,before:({top:'上方居中',center:'画面中央',bottom:'下方居中'})[clip.captionStyle?.position??'bottom'],after:'画面中央',patch:{captionStyle:{...clip.captionStyle!,position:'center'}},base:project};
  return {title:'让开场更有呼吸感',explanation:'替换第一段字幕文案，不改变字幕时长和位置。',clipId:clip.id,before:clip.text??'',after:'沿着海岸，把日子放慢。',patch:{text:'沿着海岸，把日子放慢。',name:'沿着海岸，把日子放慢。'},base:project};
}
export const applyProposal=(project:Project,proposal:DemoProposal)=>updateClip(project,proposal.clipId,proposal.patch);
