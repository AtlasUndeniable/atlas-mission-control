export type Offer = {
  offerId: string; title: string; version: string; sha256: string; state: string;
  recipient: string; teamId: string; channelId: string; threadTs: string;
  requester: string | null; expiresAt: string; challenge?: string | null;
  reviewExpiresAt?: string;
  audience?: { isPrivate: boolean; isShared: boolean; memberIds: string[] };
};
export const states: Record<string, {label: string; next: string; tone: string}> = {
  review_required: {label: 'Needs your review', next: 'Open the file, review every page, then confirm the audience and approve.', tone: 'review'},
  held: {label: 'Delivery held', next: 'The operator must reconcile this offer and its request before review can continue.', tone: 'held'},
  expired: {label: 'Offer expired', next: 'This offer can no longer be approved. Ask the operator to reconcile the next step. Its deadline has not been extended.', tone: 'held'},
  awaiting_delivery: {label: 'Approved · awaiting delivery', next: 'Approval is recorded. Waiting for the existing worker and an exact delivery receipt.', tone: 'active'},
  completed: {label: 'Delivered · receipt verified', next: 'The exact file and destination match the delivery receipt. No further approval is needed.', tone: 'done'},
  uncertain: {label: 'Delivery outcome uncertain', next: 'A delivery may have started, but the exact receipt is not confirmed. The operator must reconcile it before any further delivery.', tone: 'held'},
};
export const stateInfo = (state: string) => states[state] || {label: 'Status unavailable', next: 'Ask the operator to reconcile this offer.', tone: 'held'};
export type ReviewIssue = {code: string; title: string; message: string; action: 'status' | 'review' | 'none'};
export function issueFor(code: string, approving = false): ReviewIssue {
  const issues: Record<string, Omit<ReviewIssue, 'code'>> = {
    review_expired: {title: 'Review session expired', message: 'The five-minute review session ended. Start a fresh review of the same offer and confirm the file and audience again. This does not extend the offer deadline.', action: 'review'},
    offer_expired: {title: 'Offer expired', message: 'This offer can no longer be approved. Ask the operator to reconcile the next step; checking status will not extend it.', action: 'status'},
    backend_held: {title: 'Review is paused', message: 'The review backend is held. Ask the operator when review will be available. Checking status does not activate it.', action: 'status'},
    backend_unavailable: {title: 'Review service unavailable', message: approving ? 'The approval response was not received. Its outcome is unknown. Check status before starting another review.' : 'The current status could not be checked. The backend may be deliberately paused. Ask the operator to confirm availability, then check status again.', action: 'status'},
    access_refused: {title: 'Review access refused', message: 'Use the intended reviewer’s login on the private review page. If access is still refused, ask the operator to check it.', action: 'status'},
    review_changed: {title: 'Review no longer matches', message: 'The file, request or destination changed. Check status, then start a fresh review of the current offer.', action: 'status'},
    review_refused: {title: approving ? 'Approval was not confirmed' : 'Review could not be verified', message: 'The current authorization or offer could not be verified. Check status first; if it still needs review, inspect the file and audience again.', action: 'status'},
  };
  return {code, ...(issues[code] || issues.backend_unavailable)};
}
export function sameBinding(a: Offer, b: Offer) {
  return ['offerId','version','sha256','recipient','teamId','channelId','threadTs','requester','expiresAt'].every(k => a[k as keyof Offer] === b[k as keyof Offer]) && JSON.stringify(a.audience) === JSON.stringify(b.audience);
}
const names: Record<string, string> = {U0ANCF85CUE: 'Dante', U068FRX5423: 'Rhys', U0AMX2WP8QY: 'Atlas'};
export const personName = (id: string | null) => id ? names[id] || 'Unrecognized person (see details)' : 'No verified request';
export function destinationName(offer: Offer) {
  if (offer.teamId === 'T069918AWRF' && offer.channelId === 'C0BQS3WR5UG') return '#dante-testing · private Slack channel';
  if (!offer.audience && offer.recipient === 'U068FRX5423' && offer.channelId === 'D0AM2R3H6SE') return 'Rhys’s private Slack conversation';
  return 'Slack destination (see details)';
}
