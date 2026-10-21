import { describe,it,expect,vi } from 'vitest';
import { validatePlan,validateRequest,validateAnalysis,mockPlan } from '../shared/plan.mjs';
import { configuration,generate,completion } from '../server/service.mjs';
const assets=[{id:'a',durationMs:25000,width:1280,height:720}];
const frames=[2500,12500,22500].map(timeMs=>({assetId:'a',timeMs,image:'data:image/jpeg;base64,/9j/AAAA'}));
const request=()=>({mode:'mock',consent:true,prompt:'剪成20秒加标题降低原声',assets,frames});
const plan=()=>mockPlan(request());
describe('strict plan boundary',()=>{
 it('valid mock uses actual duration and volume',()=>{expect(plan().segments[0]).toMatchObject({outMs:20000,volume:.25});});
 for(const [name,mutate] of Object.entries({operation:p=>p.segments[0].op='eval',extra:p=>p.code='alert(1)',id:p=>p.segments[0].assetId='missing',unit:p=>p.unit='s',negative:p=>p.segments[0].inMs=-1,overflow:p=>p.segments[0].outMs=26000,fraction:p=>p.segments[0].inMs=.5,volume:p=>p.segments[0].volume=Infinity,title:p=>p.titles[0].endMs=22000,empty:p=>p.segments=[],source:p=>p.titles[0].source='transcript'}))it(`rejects ${name}`,()=>{const p=plan();mutate(p);expect(()=>validatePlan(p,assets)).toThrow();});
 it('rejects absent consent and remote frame URLs',()=>{expect(()=>validateRequest({...request(),consent:false})).toThrow();expect(()=>validateRequest({...request(),frames:frames.map(f=>({...f,image:'https://example.com'}))})).toThrow();});
 it('rejects invented analysis timestamps',()=>expect(()=>validateAnalysis({frames:frames.map(f=>({assetId:'a',timeMs:0,description:'x'}))},frames)).toThrow());
});
const reply=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
describe('proxy without paid network',()=>{
 it('mock never calls upstream',async()=>{const fetcher=vi.fn();const result=await generate(request(),configuration(),fetcher);expect(result.mode).toBe('mock');expect(fetcher).not.toHaveBeenCalled();});
 it('missing keys fail without mock fallback',async()=>{const fetcher=vi.fn();await expect(generate({...request(),mode:'real'},configuration(),fetcher)).rejects.toMatchObject({code:'MISSING_KEY'});expect(fetcher).not.toHaveBeenCalled();});
 it('real transport contract sends images only to GLM and validates plan',async()=>{const calls=[];const fetcher=vi.fn(async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return calls.length===1?reply({frames:frames.map(({image,...f})=>({...f,description:'测试画面'}))}):reply(plan());});const result=await generate({...request(),mode:'real'},configuration({DEEPSEEK_API_KEY:'test-placeholder',GLM_API_KEY:'test-placeholder'}),fetcher);expect(result.mode).toBe('real');expect(calls[0].url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');expect(JSON.stringify(calls[0].body)).toContain('image_url');expect(JSON.stringify(calls[1].body)).not.toContain('data:image');expect(calls[1].body.response_format.type).toBe('json_object');});
 for(const [status,code] of [[401,'AUTH'],[402,'QUOTA'],[429,'RATE_LIMIT'],[500,'UPSTREAM']])it(`sanitizes HTTP ${status}`,async()=>{const fetcher=vi.fn(async()=>new Response('sensitive upstream details',{status}));await expect(completion({url:'unused',key:'placeholder'},[],configuration(),fetcher)).rejects.toMatchObject({code});expect(fetcher).toHaveBeenCalledTimes(status===500?2:1);});
 it('handles network failure',async()=>await expect(completion({},[],configuration(),async()=>{throw Error('private network details');})).rejects.toMatchObject({code:'NETWORK'}));
 it('handles timeout with no unlimited retry',async()=>{const fetcher=(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))));await expect(completion({},[],{...configuration(),timeoutMs:5},fetcher)).rejects.toMatchObject({code:'TIMEOUT'});});
 it('rejects malformed and truncated output',async()=>{await expect(completion({},[],configuration(),async()=>new Response('{}'))).rejects.toMatchObject({code:'OUTPUT'});await expect(completion({},[],configuration(),async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]})))).rejects.toMatchObject({code:'OUTPUT'});});
});
