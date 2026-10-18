import {describe,expect,it,vi} from 'vitest';
import {ExportController,mp4FileName,type ExportWritable,type SavePicker} from '../src/export/saveVideo';
const blob=new Blob(['mp4'],{type:'video/mp4'});
const sink=():ExportWritable=>({write:vi.fn(async()=>{}),close:vi.fn(async()=>{}),abort:vi.fn(async()=>{})});
describe('MP4 export save lifecycle',()=>{
 it('normalizes empty names, paths, extensions and Windows reserved names',()=>{
  expect(mp4FileName(' ')).toBe('frameyu-demo.mp4');expect(mp4FileName('cut.webm')).toBe('cut.mp4');
  expect(mp4FileName('../my:film.mp4')).toBe('.._my_film.mp4');expect(mp4FileName('CON')).toBe('_CON.mp4');
 });
 it('invokes picker synchronously in the click stack and encodes only after opening a writable',async()=>{
  const calls:string[]=[];const writable=sink();
  const picker:SavePicker=async options=>{calls.push('picker');expect(options.suggestedName).toBe('film.mp4');return {createWritable:async()=>{calls.push('writable');return writable;}};};
  const result=new ExportController().start({fileName:'film',method:'picker'},async()=>{calls.push('encode');return blob;},picker);
  expect(calls).toEqual(['picker']);expect(await result).toBe('saved');expect(calls).toEqual(['picker','writable','encode']);
  expect(writable.write).toHaveBeenCalledWith(blob);expect(writable.close).toHaveBeenCalledOnce();expect(writable.abort).not.toHaveBeenCalled();
 });
 it('does not encode or download on picker cancellation, and allows retry',async()=>{
  const encode=vi.fn(async()=>blob);const download=vi.fn();const controller=new ExportController();
  expect(await controller.start({fileName:'a',method:'picker'},encode,async()=>{throw new DOMException('cancelled','AbortError');},download)).toBe('cancelled');
  expect(encode).not.toHaveBeenCalled();expect(download).not.toHaveBeenCalled();
  expect(await controller.start({fileName:'a',method:'download'},encode,undefined,download)).toBe('saved');expect(download).toHaveBeenCalledWith(blob,'a.mp4');
 });
 it.each(['encode','write','close'])('aborts partial output on %s failure',async(phase)=>{
  const writable=sink();if(phase==='write'||phase==='close')writable[phase]=vi.fn(async()=>{throw Error('disk failed');});
  const picker:SavePicker=async()=>({createWritable:async()=>writable});
  await expect(new ExportController().start({fileName:'a',method:'picker'},async()=>{if(phase==='encode')throw Error('encode failed');return blob;},picker)).rejects.toThrow('failed');
  expect(writable.abort).toHaveBeenCalledOnce();
 });
 it('blocks duplicate starts while the picker is pending',async()=>{
  let resolve!: (value:{createWritable:()=>Promise<ExportWritable>})=>void;
  const picker:SavePicker=()=>new Promise(r=>{resolve=r;});const controller=new ExportController();const encode=vi.fn(async()=>blob);
  const first=controller.start({fileName:'a',method:'picker'},encode,picker);
  expect(await controller.start({fileName:'b',method:'download'},encode,undefined,vi.fn())).toBe('busy');
  resolve({createWritable:async()=>sink()});await first;expect(encode).toHaveBeenCalledOnce();
 });
 it('rejects unsupported picker, permission failures, and empty or wrongly typed output',async()=>{
  const encode=vi.fn(async()=>blob);const controller=new ExportController();
  await expect(controller.start({fileName:'a',method:'picker'},encode)).rejects.toThrow('不支持');expect(encode).not.toHaveBeenCalled();
  await expect(controller.start({fileName:'a',method:'picker'},encode,async()=>{throw new DOMException('denied','NotAllowedError');})).rejects.toThrow('denied');expect(encode).not.toHaveBeenCalled();
  await expect(controller.start({fileName:'a',method:'download'},async()=>new Blob([]),undefined,vi.fn())).rejects.toThrow('有效');
 });
});
