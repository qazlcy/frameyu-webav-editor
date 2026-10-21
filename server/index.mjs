import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { configuration, generate, ApiError } from './service.mjs';
import { LIMITS } from '../shared/plan.mjs';
export function createServer(config=configuration(),fetcher=fetch,boundary={host:"127.0.0.1:8787",origins:["http://127.0.0.1:5173","http://localhost:5173"]}){let busy=false;return http.createServer(async(req,res)=>{
 const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
 const origin=req.headers.origin;if(req.headers.host!==boundary.host||(origin&&!boundary.origins.includes(origin))){send(403,{code:'ORIGIN',message:'仅允许本机工作台访问'});return;}
 if(req.url==='/api/ai/status'&&req.method==='GET'){send(200,{configured:!!(config.glm.key&&config.deepseek.key),models:{glm:config.glm.model,deepseek:config.deepseek.model}});return;}
 if(req.url!=='/api/ai/plan'||req.method!=='POST'){send(404,{message:'接口不存在'});return;}
 if(!origin||req.headers['content-type']!=='application/json'||req.headers['x-frameyu-request']!=='1'){send(403,{message:'请求来源或类型无效'});return;}
 if(busy){send(429,{code:'BUSY',message:'已有剪辑请求正在处理'});return;}busy=true;
 try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>LIMITS.bodyBytes)throw new ApiError('SIZE','抽帧请求超过 2 MB',413);chunks.push(chunk);}let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiError('JSON','请求不是有效 JSON');}send(200,await generate(body,config,fetcher));}catch(e){send(e instanceof ApiError?e.status:500,{code:e instanceof ApiError?e.code:'INTERNAL',message:e instanceof ApiError?e.message:'本机代理处理失败'});}finally{busy=false;}
 });}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 // Only the explicitly selected real startup loads the private file; mock never reads it.
 if(!process.argv.includes('--mock')){try{process.loadEnvFile('server/.env');}catch(e){if(e.code!=='ENOENT')throw Error('无法载入 server/.env');}}
 const server=createServer(configuration(process.argv.includes('--mock')?{}:process.env));server.requestTimeout=15000;server.headersTimeout=10000;server.listen(8787,'127.0.0.1',()=>console.log('Frameyu local proxy: http://127.0.0.1:8787'));}
