/** One HTTP attempt per reserved invocation. No SDK retries, redirects or fallback. */
import {createHash} from 'node:crypto';
export interface ModelTransportConfig {
 provider:string; model:string; mode:'fixture'|'live'; endpoint:string;
 /** Header names map to explicit environment variable names. No secrets in config. */
 headerEnvironment:Record<string,string>;
 timeoutMs:number;
}
export function singleRequestModel(config:ModelTransportConfig,
 encode:(prompt:string,invocationId:string,model:string)=>unknown,
 decode:(response:unknown)=>unknown,
 environment:NodeJS.ProcessEnv=process.env,
 request:typeof fetch=fetch) {
 const url=new URL(config.endpoint);
 const local=['127.0.0.1','localhost'].includes(url.hostname);
 if(!['fixture','live'].includes(config.mode)||!config.provider||!config.model||url.username||url.password||url.search||url.hash||
   (url.protocol!=='https:'&&!(local&&url.protocol==='http:'))||
   (config.mode==='fixture'&&!local)||!Number.isFinite(config.timeoutMs)||config.timeoutMs<=0)throw Error('explicit valid one-attempt model configuration required');
 const headers:Record<string,string>={'content-type':'application/json'};
 for(const [header,name] of Object.entries(config.headerEnvironment)){
  const value=environment[name];if(!value)throw Error('configured model credential unavailable');headers[header]=value;
 }
 return {description:{provider:config.provider,model:config.model,mode:config.mode,configurationHash:createHash('sha256').update(JSON.stringify({config,encode:encode.toString(),decode:decode.toString()})).digest('hex')},invoke:async(prompt:string,invocationId:string)=>{
  const result=await request(config.endpoint,{method:'POST',headers,body:JSON.stringify(encode(prompt,invocationId,config.model)),redirect:'error',signal:AbortSignal.timeout(config.timeoutMs)});
  if(!result.ok)throw Error('model invocation outcome requires review');
  return decode(await result.json());
 }};
}
