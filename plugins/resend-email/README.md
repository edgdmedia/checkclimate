# resend-email

A native EmDash plugin that delivers the CMS's transactional mail through
Resend. It registers the exclusive `email:deliver` hook, so magic links,
invite emails and comment notifications actually leave the site.

## What it does not do

The claim form's desk notification (`src/utils/email.ts`) posts to the same
Resend API directly, because the form needs to know right away whether the
send worked and must still succeed when it did not. This plugin is for
EmDash's own mail, where a failure is a log line and a retry.

## Configuration

The plugin reads its credentials from Worker secrets, not from the admin
form:

- `RESEND_API_KEY` — a Resend API key
- `EMAIL_FROM` — the default From: header, e.g.
  `Check Climate Africa <newsroom@checkclimate.africa>`

Set them with `wrangler secret put`. The capability
`hooks.email-transport:register` is declared in the descriptor, so the admin
shows the plugin as the site's mail transport.

## Development

The transport itself (`src/transport.ts`) is a plain function of its
arguments; the Worker environment is read in `src/env.mjs`, which is aliased
to a stub under vitest. Tests run with `pnpm test`.
