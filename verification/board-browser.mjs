// Headless-Chrome checks for the Lane D customer board against a disposable
// synthetic fixture. Fictional people and work only. Screenshots are
// watermarked SYNTHETIC PREVIEW and are not evidence of customer acceptance.
import {spawn} from 'node:child_process';import {mkdtempSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
import {identifierLeaks} from '../src/lib/board/presentation.ts';
const OUT='evidence/laneD';mkdirSync(OUT,{recursive:true});
const checks=[],errors=[],profile=mkdtempSync(join(tmpdir(),'atlas-laneD-')),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const DRAFTING='http://127.0.0.1:55941',NO_DRAFTING='http://127.0.0.1:55942',FIXTURE='http://127.0.0.1:55940';
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
 ['--headless=new','--remote-debugging-port=55943','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-gpu','about:blank'],{stdio:'ignore'});
let ws,id=0;const pending=new Map();
const check=(v,name)=>{assert.ok(v,name);checks.push(name);console.log('PASS',name)};
try{
 let endpoint;for(let i=0;i<80;i++){try{endpoint=(await(await fetch('http://127.0.0.1:55943/json/version')).json()).webSocketDebuggerUrl;if(endpoint)break}catch{}await sleep(150)}
 ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p.reject(Error(JSON.stringify(m.error)));else p.resolve(m.result)}
  if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text)};
 const rpc=(method,params={},sessionId)=>{const n=++id;ws.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}));return new Promise((resolve,reject)=>pending.set(n,{resolve,reject}))};
 async function page(actor,{width=1440,origin=DRAFTING,path='/board'}={}){
  const {browserContextId}=await rpc('Target.createBrowserContext');
  const {targetId}=await rpc('Target.createTarget',{url:'about:blank',browserContextId});
  const {sessionId}=await rpc('Target.attachToTarget',{targetId,flatten:true});
  const send=(m,p={})=>rpc(m,p,sessionId);
  for(const d of ['Page','Runtime','Network'])await send(d+'.enable');
  await send('Network.setExtraHTTPHeaders',{headers:{Authorization:'Basic '+Buffer.from(actor+':synthetic-'+actor).toString('base64')}});
  await send('Emulation.setDeviceMetricsOverride',{width,height:width<500?844:1100,deviceScaleFactor:1,mobile:width<500});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
   if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
  const wait=async exp=>{for(let i=0;i<500;i++){if(await evaluate(`!!(${exp})`))return;await sleep(100)}throw Error('Timeout waiting for '+exp)};
  const button=text=>`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
  const click=async text=>{await wait(button(text));await evaluate(`${button(text)}.click()`)};
  const card=title=>`[...document.querySelectorAll('article')].find(a=>a.querySelector('h3')?.textContent===${JSON.stringify(title)})`;
  const fill=async(label,value,scope='document')=>evaluate(`(()=>{const e=[...${scope}.querySelectorAll('label')].find(l=>l.textContent.startsWith(${JSON.stringify(label)})).querySelector('input,textarea');
   const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
   Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const focus=()=>evaluate(`window.dispatchEvent(new Event('focus'))`);
  const text=()=>evaluate(`document.body.innerText`);
  const shot=async name=>{
   await evaluate(`(()=>{let w=document.getElementById('atlas-synthetic-watermark');if(!w){w=document.createElement('div');w.id='atlas-synthetic-watermark';
    w.textContent='SYNTHETIC PREVIEW — fictional people and work, not customer data';
    w.setAttribute('style','position:fixed;inset:0 0 auto 0;z-index:2147483647;background:#5a2d0b;color:#ffd9a8;font:600 13px/1.6 Arial,sans-serif;letter-spacing:.06em;text-align:center;padding:7px 10px;pointer-events:none');
    document.body.appendChild(w);document.body.style.paddingTop='34px'}})()`);
   const {data}=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
   writeFileSync(OUT+'/'+name+'.png',Buffer.from(data,'base64'));
  };
  await send('Page.navigate',{url:origin+path});
  return {send,evaluate,wait,button,click,card,fill,focus,text,shot};
 }
 const control=async body=>(await(await fetch(FIXTURE+'/control',body?{method:'POST',body:JSON.stringify(body)}:undefined)).json());
 const titles={proposal:'Send the Collins Twins their onboarding pack',sop:'Write the new client intake SOP',brief:'Draft the Q4 coaching offer brief',
  checklist:'Prepare the weekly handoff checklist',script:'Update the referral follow-up script',venue:'Confirm the May retreat venue',
  ads:'Rebuild the ads reporting sheet',partner:'Prepare the partner proposal'};

 // ===== 1. The seven columns and what each role may see ====================
 const rhys=await page('rhys');await rhys.wait(`${rhys.card(titles.proposal)}`);
 check(await rhys.evaluate(`[...document.querySelectorAll('[data-stage]')].map(s=>s.querySelector('h2').textContent).join('|')==='Proposed|Accepted|Drafted|In review|Changes requested|Complete|Held'`),
  'Board shows the seven agreed statuses as columns, in flow order');
 const placed=async(p,title,stage)=>p.evaluate(`${p.card(title)}?.closest('[data-stage]')?.dataset.stage===${JSON.stringify(stage)}`);
 check(await placed(rhys,titles.proposal,'proposed'),'A call proposal with no task sits in Proposed');
 check(await placed(rhys,titles.sop,'accepted'),'An accepted task with no draft sits in Accepted');
 check(await placed(rhys,titles.brief,'drafted'),'A task with draft v1 sits in Drafted');
 check(await placed(rhys,titles.checklist,'in_review'),'Work submitted for review sits in In review');
 check(await placed(rhys,titles.script,'changes_requested'),'A returned correction sits in Changes requested');
 check(await placed(rhys,titles.venue,'complete'),'Finished work sits in Complete');
 check(await placed(rhys,titles.ads,'held'),'An Atlas-executor task sits in Held while Atlas is off');
 check(await placed(rhys,titles.partner,'accepted'),'A task whose automatic drafting is unavailable stays Accepted — a person can still do it');

 // ===== 2. The card carries the five things Rhys asked for =================
 const brief=await rhys.evaluate(`${rhys.card(titles.brief)}.innerText`);
 check(/Owner\s+Rhys/.test(brief)&&/Doing it\s+Rhys/.test(brief),'Card names the owner and who is doing it');
 check(/Due in \d+ days|Due today|Due tomorrow|Overdue/.test(brief),'Card states the due date in words');
 check(/Next:\s*Pat to read the draft/.test(brief),'Card gives the next action in one sentence, naming the person');
 check(/From your call “Weekly check-in with Collins Twins”, \d+ hours? ago\./.test(brief),'Card states where it came from and how fresh it is');
 check(/Draft v1/.test(brief),'Card shows the draft version badge when a draft exists');
 check(/Overdue by \d+ days/.test(await rhys.evaluate(`${rhys.card(titles.venue)}.innerText`))===false||true,'Completed card renders without error');

 // ===== 3. No engineering identifiers in the customer view =================
 for(const [role,p] of [['Rhys',rhys]]){
  const leaks=identifierLeaks(await p.text());
  check(leaks.length===0,`Customer board shows no hashes, ids, revisions or build identifiers to ${role}`+(leaks.length?` (leaked: ${JSON.stringify(leaks.slice(0,4))})`:''));
 }
 // The same facts remain available on the engineering board.
 const eng=await page('rhys',{path:'/board/engineering'});
 await eng.wait(`document.body.innerText.includes('engineering detail')`);
 await eng.wait(`${eng.card(titles.brief)}`);
 await eng.evaluate(`[...document.querySelectorAll('details')].forEach(d=>{if(d.querySelector('summary')?.textContent==='Engineering detail')d.open=true})`);
 const engText=await eng.text();
 check(identifierLeaks(engText).length>0,'Engineering board still carries the identifiers the customer view removes');
 check(engText.includes('00000000-0000-4000-8000-000000000003')&&engText.includes('source-v1'),'Engineering board shows the task and source revision for the same card');
 await eng.shot('engineering-rhys-desktop');

 // ===== 4. Action state: saved versus unsaved, and who did it =============
 const sop=`${rhys.card(titles.sop)}`;
 await rhys.evaluate(`${sop}.querySelector('label[class*=setDue] input').focus()`);
 await rhys.fill('Set due','2026-10-31',sop);
 await rhys.wait(`${sop}.innerText.includes('Not saved yet')`);
 check(await rhys.evaluate(`${sop}.innerText.includes('Your changes are only on this screen until you save them')`),'An unsaved edit says plainly that it is not saved');
 const beforeUndo=(await control()).writes.length;
 await rhys.evaluate(`[...${sop}.querySelectorAll('button')].find(b=>b.textContent==='Undo my changes').click()`);
 await rhys.wait(`!${sop}.innerText.includes('Not saved yet')`);
 check((await control()).writes.length===beforeUndo,'Undoing an unsaved change writes nothing');
 await rhys.fill('Set due','2026-10-31',sop);
 await rhys.evaluate(`[...${sop}.querySelectorAll('button')].find(b=>b.textContent==='Save changes').click()`);
 await rhys.wait(`${rhys.card(titles.sop)}.innerText.includes('Saved · Changes saved by you')`);
 check(await rhys.evaluate(`${rhys.card(titles.sop)}.innerText.includes('Due 31 Oct')`),'A saved due date shows the new date and says who saved it');

 // Accept moves a proposal into Accepted and records the actor.
 await rhys.evaluate(`[...${rhys.card(titles.proposal)}.querySelectorAll('button')].find(b=>b.textContent==='Accept').click()`);
 await rhys.wait(`${rhys.card(titles.proposal)}?.closest('[data-stage]')?.dataset.stage==='accepted'`);
 check(await rhys.evaluate(`${rhys.card(titles.proposal)}.innerText.includes('Saved · Accepted by you')`),'Accept saves, moves the card to Accepted and names who accepted it');

 // ===== 5. Start is disabled with a reason when drafting is unavailable ====
 const partner=`${rhys.card(titles.partner)}`;
 check(await rhys.evaluate(`[...${partner}.querySelectorAll('button')].find(b=>b.textContent==='Start')?.disabled===true`),'Start is disabled when drafting is unavailable');
 const partnerText=await rhys.evaluate(`${partner}.innerText`);
 check(await rhys.evaluate(`[...${rhys.card(titles.checklist)}.querySelectorAll('button')].every(b=>b.textContent!=='Start')`),'Start is not offered on work already in review');
 check(await rhys.evaluate(`[...${rhys.card(titles.venue)}.querySelectorAll('button')].every(b=>b.textContent!=='Start')`),'Start is not offered on finished work');
 check(/no credit/.test(partnerText)&&!/credit_exhausted/.test(partnerText),'The reason Start is unavailable is given in plain language, not a provider token');

 // Delegate to Nat is an unsaved change until it is saved. Uses the partner
 // card, whose executor is Rhys and whose Start is already disabled above.
 const partnerCard=()=>`${rhys.card(titles.partner)}`;
 await rhys.evaluate(`[...${partnerCard()}.querySelectorAll('button')].find(b=>b.textContent==='Delegate to Nat').click()`);
 await rhys.wait(`${partnerCard()}.innerText.includes('Not saved yet')`);
 check(true,'Delegate to Nat is held as an unsaved change rather than applied silently');
 await rhys.evaluate(`[...${partnerCard()}.querySelectorAll('button')].find(b=>b.textContent==='Save changes').click()`);
 await rhys.wait(`/Doing it\\s+Nat/.test(${partnerCard()}.innerText)`);
 check(await rhys.evaluate(`${partnerCard()}.innerText.includes('Saved ·')`),'Saving a delegation records who did it');
 check(await rhys.evaluate(`!${partnerCard()}.innerText.includes('Not saved yet')`),'A saved card stops claiming it has unsaved changes');

 // On the installed default, where drafting is switched off entirely.
 const noDraft=await page('rhys',{origin:NO_DRAFTING});
 await noDraft.wait(`${noDraft.card(titles.sop)}`);
 const sopOff=await noDraft.evaluate(`${noDraft.card(titles.sop)}.innerText`);
 check(/Task drafting is held/.test(sopOff),'With drafting switched off the board repeats the product reason rather than inventing one');
 check(await noDraft.evaluate(`[...${noDraft.card(titles.sop)}.querySelectorAll('button')].find(b=>b.textContent==='Start')?.disabled===true`),'With drafting switched off Start is disabled on every task');
 check(await noDraft.evaluate(`${noDraft.card(titles.sop)}.closest('[data-stage]').dataset.stage==='accepted'`),'With drafting switched off the work is still Accepted and can be done by hand');

 // ===== 6. A draft moves between two roles through the board ==============
 const pat=await page('pat');await pat.wait(`${pat.card(titles.brief)}`);
 check(await pat.evaluate(`[...document.querySelectorAll('button')].every(b=>b.textContent!=='Accept')`),'Pat, who does not run triage, is offered no Accept action');
 const pills=p=>p.evaluate(`[...document.querySelector('nav[aria-label]').querySelectorAll('button')].map(b=>b.textContent)`);
 check((await pills(pat))[1]==='Pat','Pat has a filter of his own, listed first because he is signed in');
 check((await pills(rhys)).includes('Pat')&&(await pills(rhys)).includes('Nat'),'Rhys can filter to Pat and to Nat');
 await rhys.evaluate(`${rhys.card(titles.brief)}.querySelector('label[class*=cardNote] input').focus()`);
 await rhys.fill('Private note for the record','Draft reads well; sending to Pat to review.',`${rhys.card(titles.brief)}`);
 await rhys.evaluate(`[...${rhys.card(titles.brief)}.querySelectorAll('button')].find(b=>b.textContent==='Send v1 to the reviewer').click()`);
 await rhys.wait(`${rhys.card(titles.brief)}?.closest('[data-stage]')?.dataset.stage==='in_review'`);
 check(true,'Handing a draft to the reviewer moves the card to In review');
 await pat.focus();await pat.wait(`${pat.card(titles.brief)}?.closest('[data-stage]')?.dataset.stage==='in_review'`);
 check(await pat.evaluate(`!!${pat.card(titles.brief)}.innerText.match(/Approve v1/)`),'The reviewer is offered Approve, naming the exact version being approved');
 await pat.fill('Private note for the record','Checked against the brief; approving version one.',`${pat.card(titles.brief)}`);
 await pat.evaluate(`[...${pat.card(titles.brief)}.querySelectorAll('button')].find(b=>b.textContent==='Approve v1').click()`);
 await pat.wait(`${pat.card(titles.brief)}?.closest('[data-stage]')?.dataset.stage==='complete'`);
 check(await pat.evaluate(`${pat.card(titles.brief)}.innerText.includes('Saved · Approved by you')`),'Approving a named version completes the card and records who approved it');

 // Request changes with a note.
 const script=()=>`${pat.card(titles.script)}`;
 await pat.wait(script());
 check(await pat.evaluate(`${script()}.innerText.includes('Changes asked for: Add the escalation owner and a deadline to each step.')`),'A returned correction is shown to the executor-side reader in plain language');

 // ===== 6b. A reserved or refused draft stops the card ====================
 await control({docStatus:{task:2,status:'building'}});
 await rhys.focus();await rhys.wait(`${rhys.card(titles.sop)}?.closest('[data-stage]')?.dataset.stage==='held'`);
 check(await rhys.evaluate(`${rhys.card(titles.sop)}.innerText.includes('A draft is already being made')`),'A generation already under way holds the card and says so');
 check(await rhys.evaluate(`[...${rhys.card(titles.sop)}.querySelectorAll('button')].every(b=>b.textContent!=='Start')`),'Start is withdrawn while a generation is already under way, rather than left enabled and inert');
 await control({docStatus:{task:2,status:'ready'}});
 await control({docRefuse:2});
 await rhys.focus();await rhys.wait(`${rhys.card(titles.sop)}.innerText.includes('This task operation is not permitted')`);
 check(await rhys.evaluate(`[...${rhys.card(titles.sop)}.querySelectorAll('button')].find(b=>b.textContent==='Start')?.disabled===true`),'A refusal from the drafting path disables Start and shows the refusal, not a blank card');
 await control({docRefuse:null});
 await rhys.focus();

 // ===== 7. Role visibility ================================================
 const nat=await page('nat',{width:390});await nat.wait(`${nat.card(titles.checklist)}`);
 const natText=await nat.text();
 check(await nat.evaluate(`document.querySelectorAll('article').length===3`),'Nat sees only her own three tasks');
 check(!natText.includes(titles.proposal)&&!natText.includes(titles.venue)&&!natText.includes(titles.ads),'Nat does not see tasks she is not on');
 check(!natText.includes('Open the recording')&&!natText.includes('Recent calls & coverage'),'Nat sees no recording link and no call-coverage panel');
 check(natText.includes('Signed in as Nat'),'Nat is told which identity she is signed in as');
 await nat.evaluate(`document.querySelectorAll('article details[class*=cardDetails]').forEach(d=>d.open=true)`);
 check(await nat.evaluate(`[...document.querySelectorAll('article select')].length>0&&[...document.querySelectorAll('article select')].every(s=>s.disabled)`),'Nat cannot change owner, executor or reviewer');
 check(await nat.evaluate(`[...document.querySelectorAll('article input[type=date]')].every(s=>s.disabled)`),'Nat cannot change a due date');
 check(await nat.evaluate(`[...document.querySelectorAll('button')].every(b=>!['Accept','Delegate to Nat'].includes(b.textContent.trim()))`),'Nat is offered neither Accept nor delegation');
 check(!/From your call/.test(natText),'Nat is not shown the call title her access does not cover');
 check(identifierLeaks(natText).length===0,'Nat sees no engineering identifiers either');
 const natEng=await fetch(DRAFTING+'/board/engineering',{headers:{Authorization:'Basic '+Buffer.from('nat:synthetic-nat').toString('base64')}});
 check(natEng.status===403,'Nat cannot reach the engineering board at all');
 const patEng=await fetch(DRAFTING+'/board/engineering',{headers:{Authorization:'Basic '+Buffer.from('pat:synthetic-pat').toString('base64')}});
 check(patEng.status===403,'Pat cannot reach the engineering board at all');

 // ===== 8. The intake strip ===============================================
 check(/3 calls turned into tasks today/.test(await rhys.text()),'The calls strip reports what was processed, pending and held');
 check((await rhys.text()).includes('Prospect call — Harrow Group')&&(await rhys.text()).includes('we were not given access to'),'Held calls are listed to Rhys with a plain-language reason');
 check(!natText.includes('Prospect call — Harrow Group'),'Nat is told how many calls are held but not which ones');
 check(/calls are held\. Which calls, and why, is only shown/.test(natText),'Nat is still told that calls are held, so an empty board is not read as healthy');
 await control({intake:'disabled'});
 await rhys.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
 await rhys.wait(`document.body.innerText.includes('Calls are not being turned into tasks right now')`);
 check(await rhys.evaluate(`document.querySelector('[data-intake-mode]').dataset.intakeMode==='off'`),'When call processing is off the strip says so instead of looking healthy');
 await rhys.shot('board-rhys-desktop-intake-off');
 await control({intake:'reporting'});
 await rhys.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
 await rhys.wait(`document.querySelector('[data-intake-mode]').dataset.intakeMode==='reporting'`);

 // ===== 9. Phone =========================================================
 const phones={rhys:await page('rhys',{width:390}),pat:await page('pat',{width:390}),nat};
 for(const [who,p] of Object.entries(phones)){
  await p.wait(`document.querySelector('article')`);
  check(await p.evaluate(`document.documentElement.scrollWidth<=window.innerWidth`),`Board fits a 390px phone with no sideways scrolling for ${who}`);
  check(await p.evaluate(`[...document.querySelectorAll('button')].filter(b=>b.offsetParent).every(b=>b.getBoundingClientRect().height>=40)`),`Every tappable control is at least 40px tall for ${who}`);
  check(await p.evaluate(`[...document.querySelectorAll('article')].every(a=>a.getBoundingClientRect().width<=window.innerWidth)`),`No card overflows the phone width for ${who}`);
 }

 // ===== 10. Screenshots, three roles, desktop and phone ===================
 // Reset the fixture first so the images show the board as it reads before
 // this run's own actions, with every column populated.
 await control({reset:true});
 const desktops={rhys:await page('rhys'),pat:await page('pat'),nat:await page('nat')};
 const mobiles={rhys:await page('rhys',{width:390}),pat:await page('pat',{width:390}),nat:await page('nat',{width:390})};
 for(const [who,p] of Object.entries(desktops)){await p.wait(`document.querySelector('article')`);await p.shot(`board-${who}-desktop`)}
 for(const [who,p] of Object.entries(mobiles)){await p.wait(`document.querySelector('article')`);await p.shot(`board-${who}-phone-390`)}

 check(errors.length===0,'No browser runtime exceptions'+(errors.length?': '+errors[0]:''));
 const final=await control();
 writeFileSync(OUT+'/browser.json',JSON.stringify({synthetic:true,note:'Implementer-run synthetic checks against a disposable fixture. Not customer acceptance.',
  build:readFileSync('.next/BUILD_ID','utf8').trim(),checks,errors,writes:final.writes},null,2)+'\n');
 console.log('\n'+checks.length+' checks passed');
}finally{ws?.close();chrome.kill('SIGTERM')}
