import{spawn}from'node:child_process';import{mkdtempSync,writeFileSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import assert from'node:assert/strict';
const[task,actor,name,version='0',mobile='0']=process.argv.slice(2);const profile=mkdtempSync(join(tmpdir(),'atlas-task-doc-'));
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=55828','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-gpu','about:blank'],{stdio:'ignore'});let ws,id=0;const pending=new Map(),errors=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let endpoint;for(let i=0;i<60;i++){try{endpoint=(await(await fetch('http://127.0.0.1:55828/json/version')).json()).webSocketDebuggerUrl;if(endpoint)break}catch{}await sleep(100)}
 ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text)};
 const rpc=(method,params={},sessionId)=>{const n=++id;ws.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}));return new Promise((resolve,reject)=>pending.set(n,{resolve,reject}))};
 const{targetId}=await rpc('Target.createTarget',{url:'about:blank'}),{sessionId}=await rpc('Target.attachToTarget',{targetId,flatten:true}),send=(m,p={})=>rpc(m,p,sessionId);
 for(const n of['Page','Runtime','Network'])await send(n+'.enable');await send('Network.setExtraHTTPHeaders',{headers:{Authorization:'Basic '+Buffer.from(actor+':synthetic-'+actor).toString('base64')}});
 await send('Emulation.setDeviceMetricsOverride',{width:mobile==='1'?390:1440,height:1100,deviceScaleFactor:1,mobile:mobile==='1'});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error('Browser evaluation failed');return r.result.value};
 const sel=`document.querySelector('[data-task-id="${task}"]')`;
 const wait=async expression=>{for(let i=0;i<150;i++){if(await evaluate(`!!(${expression})`))return;await sleep(100)}throw Error('Timeout '+expression)};
 await send('Page.navigate',{url:'http://127.0.0.1:55827/board'});await wait(sel);await evaluate(`${sel}.querySelector('button').click()`);await wait(`${sel}.innerText.includes('Permitted context')||${sel}.innerText.includes('unavailable')||${sel}.innerText.includes('decisions')||${sel}.innerText.includes('changed')||${sel}.innerText.includes('not permitted')`);
 if(version!=='0'){await evaluate(`[...${sel}.querySelectorAll('button')].find(x=>x.textContent==='Read v${version}').click()`);await wait(`${sel}.querySelector('div[class*=document]')`)}
 await evaluate(`${sel}.querySelector('dialog').scrollTo(0,0)`);await sleep(150);
 const box=await evaluate(`(()=>{const b=${sel}.querySelector('dialog').getBoundingClientRect();return{x:Math.max(0,b.x),y:b.y+scrollY,width:b.width,height:b.height}})()`);
 assert.equal(errors.length,0);const overflow=await evaluate(`${sel}.querySelector('dialog').scrollWidth>${sel}.querySelector('dialog').clientWidth`);assert.equal(overflow,false,'Panel overflows');
 const{data}=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{...box,scale:1}});writeFileSync(new URL('../evidence/'+name+'.png',import.meta.url),Buffer.from(data,'base64'));
 writeFileSync(new URL('../evidence/'+name+'.json',import.meta.url),JSON.stringify({synthetic:true,actor,task,mobile:mobile==='1',panelOverflow:overflow,errors,text:await evaluate(`${sel}.innerText`)},null,2)+'\n');console.log('Screenshot',name,box);
}finally{ws?.close();chrome.kill('SIGTERM')}
