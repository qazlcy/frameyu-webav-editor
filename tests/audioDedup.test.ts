import { describe, expect, it } from 'vitest';
import { MediaContentDeduplicator, hashVideoFile } from '../src/editor/videoDedup';
import {addAsset,addAudioClip} from '../src/editor/commands';
import {emptyProject,type Asset} from '../src/editor/types';
const audio=(id:string,hash:string):Asset=>({id,type:'audio',audioKind:'music',name:'same.wav',mimeType:'audio/wav',durationMs:1000,fileSize:3,contentHash:hash});
describe('audio content deduplication',()=>{
 it('hashes real bytes: renamed copies duplicate across kinds; equal names with different bytes are new',async()=>{
  const dedup=new MediaContentDeduplicator(hashVideoFile,'audio');
  const first=await dedup.claim(new File(['abc'],'same.wav'),[]);
  if(first.kind!=='new') throw Error('new claim expected');
  const asset=audio('music',first.fingerprint.contentHash);first.commit(asset.id);
  expect(await dedup.claim(new File(['abc'],'effect.wav'),[asset])).toMatchObject({kind:'duplicate',assetId:'music'});
  expect(asset.audioKind).toBe('music');
  const changed=await dedup.claim(new File(['xyz'],'same.wav'),[asset]);
  expect(changed.kind).toBe('new');if(changed.kind==='new')changed.abort();
  const project=addAsset(emptyProject(),asset);
  const twice=addAudioClip(addAudioClip(project,asset,'music'),asset,'sfx');
  expect(twice.assets).toHaveLength(1);expect(twice.clips).toHaveLength(2);
 });
 it('serializes cross-category imports and releases failed decode reservations for waiting retries',async()=>{
  const dedup=new MediaContentDeduplicator(async()=> 'same','audio');
  const first=await dedup.claim(new File(['abc'],'music.wav'),[]);
  const waiting=dedup.claim(new File(['abc'],'sfx.wav'),[]);
  if(first.kind!=='new')throw Error('new claim expected');first.abort();
  const retry=await waiting;if(retry.kind!=='new')throw Error('retry must own reservation');retry.commit('winner');
  expect(await dedup.claim(new File(['abc'],'third.wav'),[])).toMatchObject({kind:'duplicate',assetId:'winner'});
 });
 it('retries a rejected hash for the same File without poisoning its cache',async()=>{
  let attempt=0;const dedup=new MediaContentDeduplicator(async()=>{if(!attempt++)throw Error('cancelled');return 'ok';},'audio');
  const file=new File(['abc'],'retry.wav');
  await expect(dedup.claim(file,[])).rejects.toThrow('cancelled');
  const retry=await dedup.claim(file,[]);expect(retry.kind).toBe('new');if(retry.kind==='new')retry.abort();
 });
 it('does not mistake a video fingerprint for an audio asset',async()=>{
  const dedup=new MediaContentDeduplicator(async()=> 'same','audio');
  const result=await dedup.claim(new File(['abc'],'audio.wav'),[{...audio('video','same'),type:'video'}]);
  expect(result.kind).toBe('new');if(result.kind==='new')result.abort();
 });
});
