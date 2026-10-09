# Live drafting dispatch — blocked at the provider billing gate

Date: 2026-10-09. Two product dispatches attempted, one per in-scope recipe. Both settled as
Held with a bounded diagnostic. **Zero billed tokens, zero spend.**

| Recipe | Attempt | HTTP | Provider error type | Request id | Billed |
|---|---|---|---|---|---|
| role_sop | 8f746c55-067f-4551-a567-07aa1aa60956 | 400 | invalid_request_error | req_011CfrCGFYNmL3YQAVWYdSig | none |
| client_action_brief | 8b65de4f-375d-47c1-8878-1bafec95a19c | 400 | invalid_request_error | req_011CfrCGHd9D14RHxGAX5SM8 | none |

The product diagnostic retains documented identifiers only and never the provider message,
so the cause was not visible from those two attempts. One additional zero-cost diagnostic
probe (minimal 14-token synthetic body, request id req_011CfrCJDuhiW2a95KPcpL7X) returned the
same 400 with the message:

> Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to
> upgrade or purchase credits.

## What this does and does not establish

Established: the key file is read under the owner-only discipline and the key authenticates
(an invalid key returns 401, not a billing 400); the endpoint, headers, anthropic-version and
request body are accepted as well-formed by the API, which reached its billing check; the
cost bound is computed and journalled before dispatch; a failed dispatch settles as Held with
no retry and no fallback model, and spends its reserved invocation.

Not established: live generation, response-contract acceptance on real model output, real
token usage, or draft quality. Those remain unverified until the Console account holding this
key has a credit balance.

## Blocking human decision

The Anthropic Console account/workspace behind
`/Users/atlasai/.config/atlas/credentials/anthropic-intake.key` has no usable credit balance.
Dante or Rhys must purchase credits or attach billing, and set the workspace spend limit that
sprint DECISIONS.md item 1 already lists as outstanding. This blocks Lane A's live fixtures
on the same key. No retry, key change, account change or alternative provider was attempted.
