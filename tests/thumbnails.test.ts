import { beforeEach, describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({calls:[] as {start:number;end:number;step:number}[],fail:false,destroy:0}));
vi.mock('@webav/av-cliper',()=>({AudioClip:class {},MP4Clip:class {
 ready=Promise.resolve({duration:3600_000_000});
 async thumbnails(_width:number,opts:{start:number;end:number;step:number}) {
  state.calls.push(opts); if(state.fail) throw Error('decode failed');
  return [{ts:opts.start,img:new Blob(['frame'])}];
 }
 destroy(){state.destroy++;}
}}));
import {TimelineMediaPreviewCache,sampleThumbnailsForClip} from '../src/timeline/mediaPreviewCache';
import type {Asset,TimelineClip} from '../src/editor/types';
const asset:Asset={id:'video',type:'video',name:'long.mp4',mimeType:'video/mp4',durationMs:3600000};
const file=new File(['video'],'long.mp4');
beforeEach(()=>{state.calls=[];state.fail=false;state.destroy=0;});
describe('visible thumbnail caching',()=>{
 it('shares concurrent source windows and bounds long-video sampling',async()=>{
  const cache=new TimelineMediaPreviewCache();
  const first=cache.ensureThumbnails(asset,file,{startMs:1000,durationMs:2000});
  expect(cache.ensureThumbnails(asset,file,{startMs:1500,durationMs:2000})).toBe(first);
  await first;
  await cache.ensureThumbnails(asset,file,{startMs:1000,durationMs:2000});
  expect(state.calls).toHaveLength(1);
  await cache.ensureThumbnails(asset,file,{startMs:100000,durationMs:80000});
  expect(state.calls.every(o=>(o.end-o.start)/o.step<=32)).toBe(true);
  expect(state.destroy).toBe(2);
  cache.dispose();
 });
 it('revokes evicted and forgotten URLs and does not retry failed windows on render',async()=>{
  const revoke=vi.spyOn(URL,'revokeObjectURL');
  const cache=new TimelineMediaPreviewCache();
  for(let i=0;i<10;i++) await cache.ensureThumbnails(asset,file,{startMs:i*8000,durationMs:1000});
  expect(cache.getThumbnails(asset.id)?.frames).toHaveLength(8);
  expect(revoke).toHaveBeenCalledTimes(2);
  cache.forgetAsset(asset.id,'video');
  expect(revoke).toHaveBeenCalledTimes(10);
  state.fail=true;
  await expect(cache.ensureThumbnails(asset,file)).rejects.toThrow('decode failed');
  await cache.ensureThumbnails(asset,file);
  expect(state.calls).toHaveLength(11);
  cache.dispose();revoke.mockRestore();
 });
 it('discards a result forgotten during decoding',async()=>{
  const revoke=vi.spyOn(URL,'revokeObjectURL');
  const cache=new TimelineMediaPreviewCache();
  const task=cache.ensureThumbnails(asset,file);
  cache.forgetAsset(asset.id,'video');
  expect((await task).frames).toHaveLength(0);
  expect(cache.getThumbnails(asset.id)).toBeUndefined();
  expect(revoke).toHaveBeenCalled();cache.dispose();revoke.mockRestore();
 });
 it('maps a split cropped source window identically at 0.5x and 2x',()=>{
  const data={durationMs:8000,frames:[1000,3000,5000,7000].map(timeMs=>({timeMs,url:String(timeMs)}))};
  const base:TimelineClip={id:'clip',type:'video',trackId:'v2',assetId:'video',name:'source',startMs:0,sourceStartMs:4000,sourceDurationMs:4000,durationMs:8000,playbackRate:.5,volume:1,sourceCrop:{x:.2,y:.2,w:.5,h:.5}};
  expect(sampleThumbnailsForClip(data,base,2).map(f=>f.timeMs)).toEqual([5000,7000]);
  expect(sampleThumbnailsForClip(data,{...base,durationMs:2000,playbackRate:2},2)).toEqual(sampleThumbnailsForClip(data,base,2));
 });
});
