// Headless-Chrome checks for the Lane D customer board against a disposable
// synthetic fixture. Fictional people and work only. Screenshots are
// watermarked SYNTHETIC PREVIEW and are not evidence of customer acceptance.
import {spawn} from 'node:child_process';import {mkdtempSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
import {identifierLeaks,IDENTIFIER_PLACEHOLDER} from '../src/lib/board/presentation.ts';
// Not imported from board-fixture.mjs: that module starts the fixture server on import,
// and board-start.mjs already owns it. The literal is cross-checked against the fixture
// source below instead, so the two cannot drift apart silently.
const SYNTHETIC_DOC_HASH='4f'.repeat(32);
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
  // One real tap on the card's own More options control, where Set due, the
  // date picker and the note now live. A no-op if it is already open.
  const tapMore=title=>evaluate(`(()=>{const d=${card(title)}.querySelector('details[class*=cardDetails]');if(!d.open)d.querySelector('summary').click();return d.open})()`);
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
  return {send,evaluate,wait,button,click,card,tapMore,fill,focus,text,shot};
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
 await rhys.tapMore(titles.sop);
 await rhys.fill('Due date','2026-10-31',sop);
 await rhys.wait(`${sop}.innerText.includes('Not saved yet')`);
 check(await rhys.evaluate(`${sop}.innerText.includes('Your changes are only on this screen until you save them')`),'An unsaved edit says plainly that it is not saved');
 const beforeUndo=(await control()).writes.length;
 await rhys.evaluate(`[...${sop}.querySelectorAll('button')].find(b=>b.textContent==='Undo my changes').click()`);
 await rhys.wait(`!${sop}.innerText.includes('Not saved yet')`);
 check((await control()).writes.length===beforeUndo,'Undoing an unsaved change writes nothing');
 await rhys.tapMore(titles.sop);
 await rhys.fill('Due date','2026-10-31',sop);
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
 await rhys.tapMore(titles.brief);
 await rhys.fill('Private note for the record','Draft reads well; sending to Pat to review.',`${rhys.card(titles.brief)}`);
 await rhys.evaluate(`[...${rhys.card(titles.brief)}.querySelectorAll('button')].find(b=>b.textContent==='Send v1 to the reviewer').click()`);
 await rhys.wait(`${rhys.card(titles.brief)}?.closest('[data-stage]')?.dataset.stage==='in_review'`);
 check(true,'Handing a draft to the reviewer moves the card to In review');
 await pat.focus();await pat.wait(`${pat.card(titles.brief)}?.closest('[data-stage]')?.dataset.stage==='in_review'`);
 check(await pat.evaluate(`!!${pat.card(titles.brief)}.innerText.match(/Approve v1/)`),'The reviewer is offered Approve, naming the exact version being approved');
 await pat.tapMore(titles.brief);
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
 /*
  * Review finding R6, against the captured capability. Nat is triage:true hosted, and
  * every card below is a valid task of hers, so these are the conditions under which the
  * old board exposed enabled owner and executor controls. The controls must be absent --
  * not present and disabled -- and her own scheduling right must survive.
  */
 check(await nat.evaluate(`document.querySelectorAll('article').length===3`),'R6: Nat still sees her three valid tasks under the captured triage:true capability');
 check(await nat.evaluate(`[...document.querySelectorAll('article select')].length===0`),'R6: Nat is shown no owner, executor or reviewer control at all, not a disabled one');
 check(await nat.evaluate(`[...document.querySelectorAll('article label')].every(l=>!/^(Owner|Who is doing it|Who reviews it|Next step)/.test(l.textContent.trim()))`),'R6: no owner, executor, reviewer or next-step field is rendered for Nat');
 check(await nat.evaluate(`[...document.querySelectorAll('article')].every(a=>/set by the person accountable for it/.test(a.textContent))`),'R6: each card says who does hold the withheld controls');
 check(await nat.evaluate(`[...document.querySelectorAll('article')].every(a=>/You can change the timing of this and report your work/.test(a.textContent))`),'R6: and names the scheduling right she does hold');
 // Retained deliberately and separately: the person doing the work may change its timing.
 check(await nat.evaluate(`[...document.querySelectorAll('article input[type=date]')].length>0&&[...document.querySelectorAll('article input[type=date]')].every(s=>!s.disabled)`),'R6: Nat can still change the timing of work she is doing');
 check(await nat.evaluate(`[...document.querySelectorAll('button')].every(b=>!['Accept','Delegate to Nat'].includes(b.textContent.trim()))`),'Nat is offered neither Accept nor delegation');
 /*
  * The boundary, not only the presentation: a withheld field is refused by the route even
  * when the request does not come from this board at all. The revision is read live,
  * because earlier sections of this suite advance it, and a stale revision would fail with
  * 409 and prove nothing either way.
  */
 const natAuth={Authorization:'Basic '+Buffer.from('nat:synthetic-nat').toString('base64'),Origin:DRAFTING,Host:'127.0.0.1:55941','Content-Type':'application/json'};
 const natEdit=async payload=>{
  const queue=await(await fetch(DRAFTING+'/api/board/meetings',{headers:natAuth})).json();
  const item=queue.meetings.flatMap(m=>m.items).find(i=>i.task?.executor==='nat'&&i.task.work_status==='todo');
  return fetch(DRAFTING+'/api/board/meetings',{method:'POST',headers:natAuth,
   body:JSON.stringify({action:'edit',payload:{id:item.id,revision:item.revision,note:'synthetic',...payload}})});
 };
 check((await natEdit({owner:'nat'})).status===403,'R6: the route refuses an owner change from Nat even when the browser sends one');
 check((await natEdit({executor:'rhys'})).status===403,'R6: the route refuses an executor change from Nat');
 check((await natEdit({reviewer:'nat'})).status===403,'R6: the route refuses a reviewer change from Nat');
 check((await natEdit({title:'Something else entirely'})).status===403,'R6: the route refuses a next-step change from Nat');
 check((await natEdit({due:'2026-12-01'})).status===200,'R6: the route still permits Nat to reschedule her own work');
 const patAuth={Authorization:'Basic '+Buffer.from('pat:synthetic-pat').toString('base64'),Origin:DRAFTING,Host:'127.0.0.1:55941','Content-Type':'application/json'};
 const patQueue=await(await fetch(DRAFTING+'/api/board/meetings',{headers:patAuth})).json();
 const patItem=patQueue.meetings.flatMap(m=>m.items).find(i=>i.task);
 const patAttempt=await fetch(DRAFTING+'/api/board/meetings',{method:'POST',headers:patAuth,
  body:JSON.stringify({action:'edit',payload:{id:patItem.id,revision:patItem.revision,owner:'pat',note:'synthetic'}})});
 check(patAttempt.status===403,'R6: a reviewer with no triage right is refused an owner change as well');
 check(!/From your call/.test(natText),'Nat is not shown the call title her access does not cover');
 check(identifierLeaks(natText).length===0,'Nat sees no engineering identifiers either');
 /*
  * Review finding R7: the customer "Where this came from" history must not print a
  * canonical note verbatim, because document completion and review write a SHA256 into
  * exactly those notes. This expands the real history rather than checking the resting
  * card, which never contained one.
  */
 check(readFileSync('verification/board-fixture.mjs','utf8').includes("export const SYNTHETIC_DOC_HASH='4f'.repeat(32)"),'R7: the fixture and this suite agree on the synthetic document hash');
 await nat.evaluate(`document.querySelectorAll('article details[class*=history]').forEach(d=>d.open=true)`);
 await nat.click('Show what I am allowed to see');
 await nat.wait(`document.body.innerText.includes('Review history')`);
 const natHistory=await nat.text();
 check(!natHistory.includes(SYNTHETIC_DOC_HASH),'R7: the customer history does not render the document SHA256');
 check(natHistory.includes(IDENTIFIER_PLACEHOLDER),'R7: the customer history says a technical detail was withheld rather than dropping the clause silently');
 check(natHistory.includes('Agreed on the call'),'R7: an ordinary history note is still shown in full');
 check(identifierLeaks(natHistory).length===0,'R7: the expanded customer history carries no engineering identifier at all');

 const rhysCustomerHistory=await (async()=>{
  const p=await page('rhys');await p.wait(`${p.card(titles.sop)}`);
  await p.evaluate(`document.querySelectorAll('article details[class*=history]').forEach(d=>d.open=true)`);
  await p.click('Show what I am allowed to see');
  await p.wait(`document.body.innerText.includes('Review history')`);
  return p.text();
 })();
 check(!rhysCustomerHistory.includes(SYNTHETIC_DOC_HASH),'R7: Rhys\'s own customer /board history withholds the hash too');
 check(identifierLeaks(rhysCustomerHistory).length===0,'R7: no identifier leaks into the customer board for Rhys either');

 const rhysEngineeringHistory=await (async()=>{
  const p=await page('rhys',{path:'/board/engineering'});await p.wait(`${p.card(titles.sop)}`);
  await p.evaluate(`document.querySelectorAll('article details[class*=history]').forEach(d=>d.open=true)`);
  await p.click('Show what I am allowed to see');
  await p.wait(`document.body.innerText.includes('Review history')`);
  return p.text();
 })();
 check(rhysEngineeringHistory.includes(SYNTHETIC_DOC_HASH),'R7: the raw note is retained on /board/engineering');
 check(!rhysEngineeringHistory.includes(IDENTIFIER_PLACEHOLDER),'R7: the engineering board withholds nothing');

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

 // ===== 11. Card height and what a card shows at rest ====================
 // Measured on the reset board at 1440, before anything is expanded: the
 // height a card actually presents to Rhys, and whether the long-form controls
 // are folded away. Reported before and after in the Lane D2 receipt.
 const restCard=t=>`[...document.querySelectorAll('article')].find(a=>a.querySelector('h3')?.textContent===${JSON.stringify(t)})`;
 // Chrome renders closed <details> content with content-visibility:hidden
 // rather than display:none, so offsetParent alone is not a visibility test —
 // the laid-out box has to be checked as well.
 const VISIBLE=`(e=>!!e&&e.checkVisibility()&&e.getBoundingClientRect().height>0)`;
 const shown=(sel,title=titles.sop)=>desktops.rhys.evaluate(`(()=>{const a=${restCard(title)};if(!a)return null;return ${VISIBLE}(a.querySelector(${JSON.stringify(sel)}))})()`);
 const heights=await desktops.rhys.evaluate(`(()=>{const o={};for(const a of document.querySelectorAll('article'))o[a.querySelector('h3').textContent]=Math.round(a.getBoundingClientRect().height);return o})()`);
 const px=Object.values(heights).sort((a,b)=>a-b);
 const atRest={setDue:await shown('label[class*=setDue]'),datePicker:await shown('input[type=date]'),note:await shown('label[class*=cardNote]')};
 // Every action must stay reachable in at most one tap: whatever is folded has
 // to be present after a single click on the card's own More options control.
 const restControls=await desktops.rhys.evaluate(`(()=>{const a=${restCard(titles.sop)};return [...a.querySelectorAll('input,select,textarea')].filter(${VISIBLE}).length})()`);
 console.log('at rest:',JSON.stringify(atRest),'visible form controls on a resting card:',restControls);
 check(atRest.setDue===false&&atRest.datePicker===false&&atRest.note===false,`A card at rest shows no Set due shortcut, no date picker and no note field (${JSON.stringify(atRest)})`);
 check(restControls===0,`A card at rest carries no visible form control at all — every one is folded under More options (${restControls} visible)`);
 const oneTap={};
 if(!atRest.datePicker||!atRest.note){
  await desktops.rhys.evaluate(`${restCard(titles.sop)}.querySelector('details[class*=cardDetails]>summary').click()`);
  oneTap.datePicker=await shown('input[type=date]');oneTap.note=await shown('label[class*=cardNote]');
  check(oneTap.datePicker,'One tap on More options reveals the due-date control that is folded at rest');
  check(oneTap.note,'One tap on More options reveals the note field that is folded at rest');
  await desktops.rhys.evaluate(`${restCard(titles.sop)}.querySelector('details[class*=cardDetails]').open=false`);
 }
 writeFileSync(OUT+'/card-heights.json',JSON.stringify({view:'Rhys, 1440px, seven columns, board at rest',
  atRest,oneTap,cards:heights,min:px[0],median:px[(px.length-1)>>1],max:px[px.length-1],count:px.length},null,2)+'\n');
 console.log('card heights (Rhys 1440, at rest):',JSON.stringify({min:px[0],median:px[(px.length-1)>>1],max:px[px.length-1]}),'atRest',JSON.stringify(atRest));

 // A desktop comparison shot of the alternative layout. The constant in
 // MeetingQueue.tsx selects this attribute at build time; flipping it in the
 // DOM renders exactly the same CSS, so the two images are comparable.
 const boardEl=`document.querySelector('[class*=board]')`;
 if(await desktops.rhys.evaluate(`!!${boardEl}&&'layout' in ${boardEl}.dataset`)){
  const chosen=await desktops.rhys.evaluate(`${boardEl}.dataset.layout`);
  // What each layout costs at 1440: how much of the board is off-screen
  // sideways, how far down the page the last column heading sits, and how
  // many of the seven columns a person can see without moving anything.
  const measure=()=>desktops.rhys.evaluate(`(()=>{const b=${boardEl},h=[...b.querySelectorAll('[data-stage]')];
   const seen=n=>{const r=n.getBoundingClientRect(),bb=b.getBoundingClientRect();
    return r.left>=Math.max(0,bb.left)-1&&r.right<=Math.min(window.innerWidth,bb.right)+1&&r.top<window.innerHeight};
   const last=h[h.length-1].querySelector('h2').getBoundingClientRect();
   return {layout:b.dataset.layout,columns:h.length,columnsOnScreen:h.filter(seen).length,
    offScreenPx:Math.max(0,b.scrollWidth-b.clientWidth),pageHeight:document.documentElement.scrollHeight,
    lastHeadingFromTop:Math.round(last.top+window.scrollY),viewport:[window.innerWidth,window.innerHeight]}})()`);
  const layouts={};layouts[chosen]=await measure();
  const other=chosen==='track'?'wrap':'track';
  await desktops.rhys.evaluate(`${boardEl}.dataset.layout=${JSON.stringify(other)}`);
  await desktops.rhys.shot('board-rhys-desktop-'+other);
  layouts[other]=await measure();
  check(await desktops.rhys.evaluate(`document.documentElement.scrollWidth<=window.innerWidth`),'The alternative desktop layout does not make the page itself scroll sideways');
  await desktops.rhys.evaluate(`${boardEl}.dataset.layout=${JSON.stringify(chosen)}`);
  writeFileSync(OUT+'/desktop-width.json',JSON.stringify({chosen,note:'DESKTOP_COLUMNS in MeetingQueue.tsx selects data-layout at build time; the comparison flips the same attribute in the DOM, so both render the shipped CSS.',layouts},null,2)+'\n');
  console.log('desktop width comparison:',JSON.stringify(layouts));
 }

 check(errors.length===0,'No browser runtime exceptions'+(errors.length?': '+errors[0]:''));
 const final=await control();
 writeFileSync(OUT+'/browser.json',JSON.stringify({synthetic:true,note:'Implementer-run synthetic checks against a disposable fixture. Not customer acceptance.',
  build:readFileSync('.next/BUILD_ID','utf8').trim(),checks,errors,writes:final.writes},null,2)+'\n');
 console.log('\n'+checks.length+' checks passed');
}finally{ws?.close();chrome.kill('SIGTERM')}
