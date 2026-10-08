import type { Metrics } from "../components/ExecDashboard";
import { selectionMatchesRange, type Selection } from "./exec-view-state";

const esc = (x: unknown) => String(x ?? "Unavailable").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const amount = (x: number) => `AUD ${x.toLocaleString("en-AU", {minimumFractionDigits:2, maximumFractionDigits:2})}`;
export const REPORT_PRINT_CSS = `
#exec-print-capture { display: none; }
.exec-report { font: 14px/1.5 system-ui,sans-serif; color:#17202a; }
.exec-report table { width:100%; border-collapse:collapse; margin:12px 0; }
.exec-report th,.exec-report td { border-bottom:1px solid #ccc; padding:7px; text-align:left; }
.exec-report h2 { font-size:18px; margin-top:22px; }
.exec-report section { break-inside:avoid; }
@media print {
 @page { size:A4; margin:16mm; }
 body > * { display:none !important; }
 body > #exec-print-capture { display:block !important; background:white; color:#17202a; }
 #exec-print-capture { font:11pt/1.4 system-ui,sans-serif; }
 #exec-print-capture table { width:100%; border-collapse:collapse; }
 #exec-print-capture th,#exec-print-capture td { border-bottom:1px solid #ccc; padding:5px; text-align:left; }
 #exec-print-capture section { break-inside:avoid; }
}`;
/** Allow-list report: never serialize the raw payload or Newie values. */
export function captureExecReport(data: Metrics | null, state: {loading:boolean; error:string|null; selection:Selection}): string | null {
  if (!data || state.loading || state.error || !selectionMatchesRange(data.range,state.selection)) return null;
  const usable = (key:string, feed:{freshness:{status:string}}|null) => !!feed && feed.freshness.status === 'fresh' && !data.incomplete?.includes(key) && !data.unavailable?.includes(key);
  const warning = (key:string, feed:{freshness:{status:string;latestRecordAt:string|null}}|null) => `${esc(key)}: unavailable (${esc(feed?.freshness.status ?? 'no feed')}${data.incomplete?.includes(key.toLowerCase()) ? ', incomplete' : ''}); latest source record ${esc(feed?.freshness.latestRecordAt)}.`;
  const row = (label:string, value:unknown) => `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`;
  const r=data.revenue, a=data.appointments, t=data.trend, p=data.pipeline;
  return `<article class="exec-report"><h1>Executive report</h1>
<p>Captured payload: ${esc(data.generatedAt)}. Business timezone: ${esc(data.timezone)}.</p>
<p><strong>Displayed period: ${esc(data.range.startDate)} to ${esc(data.range.endDate)}</strong> (${esc(data.range.label)}).</p>
<p>September month-to-date and completed August are unequal partial/full periods. Each report contains only its captured period; comparisons require the separately settled period report.</p>
<section><h2>GoHighLevel — selected period</h2>${usable('payments',r) && r ? `<table>${row('Successful payments',amount(r.collected))}${row('Payments',r.count)}${row('Average payment',amount(r.average))}${row('Excluded failed / refunded-status / test / non-AUD',`${r.excluded.failed} / ${r.excluded.refunded} / ${r.excluded.testMode} / ${r.excluded.nonAud}`)}</table><p>Source: GHL payments. Succeeded AUD payments; excludes failed, refunded-status, test and non-AUD. Partial refunds and fees are not deducted; these figures are not net collections or bank payouts. Freshness: ${esc(r.freshness.status)}; latest source record ${esc(r.freshness.latestRecordAt)}.</p>` : `<p>${warning('Payments',r)}</p>`}</section>
<section><h2>Appointments — selected period</h2>${usable('appointments',a) && a ? `<table>${row('Booked',a.booked)}${row('Cancelled',a.cancelled)}${row('Confirmed',a.confirmed)}${row('Cancellation rate',a.cancellationRate === null ? 'Unavailable' : `${a.cancellationRate.toFixed(1)}%`)}${row('Calendars queried',a.calendarsQueried)}</table><p>Source: GHL calendars. Cancellation denominator: booked appointments. Freshness ${esc(a.freshness.status)}; latest booking ${esc(a.freshness.latestRecordAt)}.</p>` : `<p>${warning('Appointments',a)}</p>`}</section>
<section><h2>Successful payments by month — fixed window</h2><p>${esc(t?.windowLabel ?? 'Last 8 months')}; does not follow the selected period.</p>${usable('trend',t) && t ? `<table>${t.months.map(m=>row(m.label,`${amount(m.total)}; ${m.count} payments${m.partial ? '; partial month' : ''}`)).join('')}</table><p>Source: GHL AUD payments; freshness ${esc(t.freshness.status)}; latest source record ${esc(t.freshness.latestRecordAt)}.</p>` : `<p>${warning('Trend',t)}</p>`}</section>
<section><h2>Pipeline — read-time snapshot</h2>${usable('pipeline',p) && p ? p.pipelines.map(x=>`<h3>${esc(x.name)}</h3><table>${x.stages.map(s=>row(s.name,s.count)).join('')}</table>`).join('')+`<p>Source: GHL opportunities. Snapshot, not period won sales. Freshness ${esc(p.freshness.status)}; latest stage change ${esc(p.freshness.latestRecordAt)}.</p>` : `<p>${warning('Pipeline',p)}</p>`}</section>
<section><h2>Newie — separate business line</h2><p>Collections, MRR and subscriber count: unavailable — pending verification. Currency and source authority unresolved. Private one-time native exports are evidence only, not dashboard inputs.</p><p>Combined revenue, leads and period won sales: unavailable.</p></section></article>`;
}
