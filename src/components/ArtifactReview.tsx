'use client';
import {useState, useRef, useEffect, useCallback} from 'react';
import {type Offer, type ReviewIssue, issueFor, stateInfo, sameBinding, personName, destinationName} from '../lib/artifact-review-state';
import styles from './ArtifactReview.module.css';

export default function ArtifactReview({pilot=false}: {pilot?: boolean}) {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [selected, setSelected] = useState<Offer|null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<ReviewIssue|null>(null), [statusIssue, setStatusIssue] = useState<ReviewIssue|null>(null);
  const [notice, setNotice] = useState(''), [checkedAt, setCheckedAt] = useState('');
  const [text, setText] = useState(''), [url, setUrl] = useState(''), [proof, setProof] = useState('');
  const [contentChecked, setContentChecked] = useState(false), [destinationChecked, setDestinationChecked] = useState(false);
  const current = useRef<Offer|null>(null), sequence = useRef(0), blob = useRef('');
  const reading = useRef(false), working = useRef(false), mounted = useRef(false);
  const select = useCallback((offer: Offer|null) => {current.current = offer; setSelected(offer)}, []);
  const invalidate = useCallback(() => {
    setProof(''); setContentChecked(false); setDestinationChecked(false);
  }, []);
  const clearContent = useCallback(() => {
    invalidate(); if (blob.current) URL.revokeObjectURL(blob.current);
    blob.current=''; setUrl(''); setText('');
  }, [invalidate]);
  const api = useCallback(async (operation: string, body: object) => {
    try {
      const response = await fetch((pilot ? '/pilot/artifacts/api/' : '/api/board/artifacts/') + operation, {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(9000),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw issueFor(data.code || (response.status === 403 ? 'access_refused' : 'backend_unavailable'), operation === 'approve');
      }
      return response;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && 'action' in error) throw error;
      throw issueFor('backend_unavailable', operation === 'approve');
    }
  }, [pilot]);

  // Status checks only call list. They never request, approve or send a file.
  const checkStatus = useCallback(async () => {
    if (reading.current || working.current) return;
    reading.current=true; const n=sequence.current;
    try {
      const data = await (await api('list', {})).json();
      if (!Array.isArray(data.offers)) throw issueFor('backend_unavailable');
      if (!mounted.current || n !== sequence.current) return;
      setOffers(data.offers); setStatusIssue(null); setCheckedAt(new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}));
      const previous=current.current;
      if (previous) {
        const next: Offer|undefined=data.offers.find((o: Offer) => o.offerId === previous.offerId);
        if (!next) {clearContent(); select(null); setIssue(issueFor('review_changed'));}
        else if (sameBinding(previous,next) && previous.state === 'review_required' && next.state === 'review_required') select({...next, challenge:previous.challenge, reviewExpiresAt:previous.reviewExpiresAt});
        else {
          clearContent(); select({...next, challenge:null});
          if (next.state === 'completed' || next.state === 'awaiting_delivery' || next.state === 'uncertain') {setIssue(null); setNotice('');}
          else if (next.state === 'expired') setIssue(issueFor('offer_expired'));
          else if (!sameBinding(previous,next)) setIssue(issueFor('review_changed'));
        }
      }
    } catch (error) {
      if (mounted.current && n === sequence.current) {setStatusIssue(error as ReviewIssue); clearContent();}
    } finally {
      reading.current=false;
      if (mounted.current && n === sequence.current) setLoading(false);
    }
  }, [api, clearContent, select]);
  useEffect(() => {
    mounted.current=true; const lifetime=sequence; void checkStatus();
    const timer=setInterval(() => {if (!document.hidden) void checkStatus()}, 10000);
    const visible=() => {if (!document.hidden) void checkStatus()};
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange',visible);
    return () => {mounted.current=false; lifetime.current++; clearInterval(timer); window.removeEventListener('focus',visible); document.removeEventListener('visibilitychange',visible); if (blob.current) URL.revokeObjectURL(blob.current)};
  }, [checkStatus]);
  useEffect(() => {
    if (!selected?.challenge || !selected.reviewExpiresAt || !proof) return;
    const expire=() => {invalidate(); setIssue(issueFor('review_expired'))};
    const timer=setTimeout(expire, Math.max(0, Date.parse(selected.reviewExpiresAt)-Date.now()));
    return () => clearTimeout(timer);
  }, [selected?.challenge, selected?.reviewExpiresAt, proof, invalidate]);

  async function review(id: string) {
    if (working.current) return;
    const n=++sequence.current; working.current=true; setBusy(true); clearContent(); select(null); setIssue(null); setNotice('');
    try {
      const offer: Offer=await (await api('review',{offerId:id})).json();
      if (!mounted.current || n !== sequence.current) return;
      select(offer); setStatusIssue(null);
      setOffers(list => list.map(o => o.offerId===id ? offer : o));
      if (!offer.challenge) return;
      const response=await api('content',{challenge:offer.challenge});
      const token=response.headers.get('x-atlas-preview-proof');
      if (!token) throw issueFor('review_refused');
      const isText=response.headers.get('content-type')?.startsWith('text/plain');
      if (!isText && !response.headers.get('content-type')?.startsWith('application/pdf')) throw issueFor('review_refused');
      const content=isText ? await response.text() : await response.blob();
      if (!mounted.current || n !== sequence.current) return;
      if (typeof content === 'string') setText(content);
      else {blob.current=URL.createObjectURL(content); setUrl(blob.current)}
      setProof(token);
    } catch (error) {
      if (mounted.current && n===sequence.current) {setIssue(error as ReviewIssue); invalidate()}
    } finally {
      working.current=false;
      if (mounted.current && n===sequence.current) {setBusy(false); setLoading(false)}
    }
  }
  async function approve() {
    const offer=current.current;
    if (working.current || !offer?.challenge || !proof || !contentChecked || !destinationChecked || statusIssue) return;
    const n=++sequence.current; working.current=true; setBusy(true); setIssue(null);
    const token=proof; invalidate();
    try {
      await (await api('approve',{challenge:offer.challenge,previewProof:token,contentReviewed:true,deliveryApproved:true})).json();
      if (!mounted.current || n!==sequence.current) return;
      select({...offer,challenge:null}); setNotice('Approval recorded. Checking the current delivery status…');
    } catch (error) {
      if (mounted.current && n===sequence.current) {setIssue(error as ReviewIssue); select({...offer,challenge:null})}
    } finally {
      working.current=false;
      if (mounted.current && n===sequence.current) {setBusy(false); void checkStatus()}
    }
  }
  const state=selected ? stateInfo(selected.state) : null;
  const problem=statusIssue || issue;
  return <main className={styles.page}>
    <header className={styles.header}>
      <div className={styles.brand}><p className={styles.eyebrow}>UNDENIABLE</p><span>Artifact review</span></div>
      <div className={styles.headerActions}>{!pilot && <a href='/board'>← Action Board</a>}<button onClick={()=>void checkStatus()} disabled={busy}>Check status</button></div>
    </header>
    <div className={styles.intro}><div><p className={styles.kicker}>{pilot ? 'PRIVATE SYNTHETIC PILOT' : 'PRIVATE REVIEW'}</p><h1>Ready for your review</h1><p>Review the file. Confirm who receives it. Approve when it’s ready.</p></div><p className={styles.sync}>{statusIssue ? 'Status could not be updated' : checkedAt ? `Status checked ${checkedAt}` : 'Checking status…'}<br/><span>Checks update status only. They never resend a file.</span></p></div>
    {problem && <section role='alert' className={styles.alert}><h2>{problem.title}</h2><p>{problem.message}</p>{problem.action==='review' && selected?.state==='review_required' ? <button disabled={busy} onClick={()=>void review(selected.offerId)}>Start fresh review</button> : problem.action==='status' ? <button disabled={busy} onClick={()=>void checkStatus()}>Check status only</button> : null}</section>}
    {notice && <p role='status' className={styles.notice}>{notice}</p>}
    <div className={styles.layout}>
      <section aria-label='Artifact offers' className={styles.list}><div className={styles.sectionHeading}><h2>Files</h2><span>{offers.length}</span></div>
        {loading ? <p role='status'>Loading authorized offers…</p> : !offers.length && !problem ? <p>No authorized offers are available.</p> : offers.map(o => <button key={o.offerId} className={styles.offer} data-tone={stateInfo(o.state).tone} aria-pressed={selected?.offerId===o.offerId} onClick={()=>void review(o.offerId)} disabled={busy}><span className={styles.offerVersion}>{o.version}</span><strong>{o.title}</strong><span>{stateInfo(o.state).label}</span></button>)}
      </section>
      <section aria-label='Exact artifact review' className={styles.detail}>
        {!selected ? <div className={styles.empty}><h2>{busy ? 'Opening review…' : 'Choose a file to review'}</h2><p>The file, audience and next action will appear here.</p></div> : <>
          <div className={styles.detailHeader}><span className={styles.state} data-tone={state?.tone}>{state?.label}</span><span className={styles.version}>{selected.version}</span></div>
          <h2 className={styles.title}>{selected.title}</h2><p className={styles.next}>{state?.next}</p>
          <section aria-label='Delivery destination' className={styles.destination}><p className={styles.kicker}>DELIVERY DESTINATION</p><h3>{destinationName(selected)}</h3><p>In the original offer thread · Requested by {personName(selected.requester)}</p>
            <p><strong>Audience:</strong> {selected.audience ? selected.audience.memberIds.map(personName).join(', ') : personName(selected.recipient)}</p>
            {selected.audience && <p className={styles.note}>Everyone in this channel can view and download the file. The thread does not restrict access. Membership is checked again before approval and upload.</p>}
          </section>
          {busy && <p role='status'>Checking this review…</p>}
          {(text || url) && <section className={styles.preview} aria-label='File preview'><div className={styles.previewHeading}><div><h3>1. Review the file</h3><p>Read every page, including the final page.</p></div>{url && <a className={styles.primaryLink} href={url} target='_blank' rel='noopener noreferrer'>Open PDF ↗</a>}</div>
            {url && <><p className={styles.note}>Open PDF works independently of the inline preview. If your browser blocks viewing, <a href={url} download='review-artifact.pdf'>download this exact PDF</a> and open it locally.</p><details className={styles.inline}><summary>Show inline preview (optional)</summary><iframe title='Verified PDF content' src={url} className={styles.pdf} sandbox='allow-same-origin'/></details></>}
            {text && <pre aria-label='Verified artifact content' className={styles.content}>{text}</pre>}
          </section>}
          {selected.state==='review_required' && <section className={styles.approval}><h3>2. Confirm delivery</h3>{!proof && !busy && <p>Start a fresh review to verify the current file and audience. <button onClick={()=>void review(selected.offerId)}>Start fresh review</button></p>}
            <fieldset disabled={!proof || busy || !!statusIssue}><legend className={styles.srOnly}>Exact file and audience approval</legend><label><input type='checkbox' checked={contentChecked} onChange={e=>setContentChecked(e.target.checked)}/>I reviewed this exact file and version.</label><label><input type='checkbox' checked={destinationChecked} onChange={e=>setDestinationChecked(e.target.checked)}/>I approve delivery to the audience and original thread shown above.</label><button className={styles.approve} disabled={!proof || !contentChecked || !destinationChecked || busy || !!statusIssue} onClick={()=>void approve()}>Approve delivery</button></fieldset>
            <p className={styles.note}>{proof && selected.reviewExpiresAt ? `Review session ends at ${new Date(selected.reviewExpiresAt).toLocaleTimeString()}. ` : ''}Approval and delivery are separate. Status updates automatically.</p>
          </section>}
          <details className={styles.technical}><summary>Details &amp; verification</summary><dl>{Object.entries({'Intended recipient':selected.recipient,'Requester':selected.requester||'None','Workspace ID':selected.teamId,'Channel ID':selected.channelId,'Thread':selected.threadTs,'Offer ID':selected.offerId,'Version':selected.version,'SHA-256':selected.sha256,'Offer deadline':new Date(selected.expiresAt).toLocaleString(),'Audience IDs':selected.audience?.memberIds.join(', ')||selected.recipient}).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p>Later membership or sharing changes may extend access. Workspace retention and administrator policies still apply.</p></details>
        </>}
      </section>
    </div>
  </main>;
}
