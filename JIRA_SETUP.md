# Optional Jira delivery bridge

The Worker includes a receipt-backed Jira integration. Website delivery defaults
to held: `JIRA_WEBSITE_AUTO_ENABLED` must be `true` to enable it. Configure one
ticket creator only. Reconcile any existing polling importer and its historical
report-to-issue mappings before enabling the immediate path.

Required Worker secrets are `JIRA_WEBHOOK_URL` and `JIRA_WEBHOOK_TOKEN`. Use an
authenticated native Jira incoming-webhook flow, not credentials in the public
browser. The flow must look up the stable report label, obtain the one-time
`/jira/claim`, create the issue only if `allow` is true, then POST the created
issue key to `/jira/receipt`. Both callbacks use the report-specific token from
the webhook body. The supplied bridge currently validates project TME issue keys.

The webhook payload contains `reportKey`, `deliveryToken`, `summary` and
`description`. Resolve the active sprint from the intended board in Jira rather
than hard-coding a sprint number. Retain any required assignment, attachment and
notification work on the same ticket. The evidence link is private and scoped
to one report; treat it as a secret link.

The D1 schema must be applied additively before deploying the Worker. A
five-minute recovery cron queues interrupted website saves and attempts pending
deliveries while website delivery is enabled. Ordinary submissions save first
and use `ctx.waitUntil` for delivery. Jira failure never changes an already saved
report into a failed submission.

Stable source IDs and normalized exact descriptions deduplicate repeated
delivery. Description matching normalizes case and whitespace. Different
wording for the same underlying defect still needs duplicate review. Unknown
creates are held instead of blindly retried, and conflicting callbacks are
rejected. A webhook acknowledgment is not proof that an issue was created.
Require an actual issue-key receipt and check the native flow audit.

The authenticated `/jira/import` route accepts bounded `published` or `studio`
report batches. `/jira/status` shows sanitized receipt state without private
tokens. It never changes the source game's bug status. Importer commands live
in `tools/jira-sync.mjs`; their upstream game-board exporter remains part of the
private game project. Do not publish exported player reports or credentials.

The original inbox and collection behavior remains separate. This integration
does not delete reports, implement fixes, or approve gameplay and publication.
Run `npm test` for the report, transaction, deduplication, claim, callback,
authentication and recovery checks before deployment.
