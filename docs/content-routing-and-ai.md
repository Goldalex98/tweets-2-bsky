# Content routing, moderation, deduplication, and AI

Configuration schema v5 makes Image Alt Text an explicit opt-in and adds an
explicit moderation dry-run flag. Its provider,
model, optional base URL, output limit, purpose, and privacy description are
stored in `ai`. Destination overrides can inherit, enable, or disable it.
Translation, summarization, cleanup/rewrite, and hashtag suggestions have
independent flags and are off by default. When enabled for a destination
(global setting or destination override), live posting applies them in fixed
order before attribution: cleanup → translation → summarization → hashtags
(appended). A failed capability is skipped and delivery continues with the
prior text. Settings and CLI previews use the same provider path.

Provider tests use a generated one-pixel transparent PNG, never user media.
Only purpose, provider/model, outcome, bounded error category, and latency are
recorded. API keys remain encrypted/redacted by the existing config traversal.

Routes support deterministic keyword, domain, content/media type, language,
timezone, and hour predicates. Destination and route moderation can block
keywords, domains, sources, or sensitive content. Preview endpoints and the
`policy-preview` CLI command return the ordered decision trace without
enqueuing or posting.

Duplicate suppression is optional and destination-scoped (or route-scoped when
the route override is enabled). Canonical text and URLs are SHA-256 hashed
within a configured time window. Optional image average hashes use Sharp.
Only hashes and identifying metadata are stored; image contents are not.
Perceptual hashing downloads at most four allowlisted X image URLs with strict
type, size, redirect, and timeout limits. Disabled policies make no media
request.

Every new queue item receives a versioned, SHA-256 policy snapshot containing
non-secret delivery, posting, AI, routing, moderation, and duplicate policies.
Workers use the saved posting and AI snapshot. Authorized users may rerun
routing, moderation, duplicate, and posting snapshot evaluation for a
non-processing item with explicit
`REEVALUATE_POLICY` confirmation; actor, time, reason, and prior hash are
retained. Failed items are requeued only when the current decision allows them.

Moderation and duplicate skips retain a secret-stripped, size-bounded candidate
for seven days. Authorized users can explicitly override and requeue it with
`OVERRIDE_POLICY_SKIP`; the decision trace and actor are written to the policy
override audit log. Expired candidates cannot be requeued.
