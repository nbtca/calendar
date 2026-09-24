# NBTCA Calendar

Calendar feeds for NBTCA, served from one Cloudflare Worker at
`ical.nbtca.space`.

## Routes

- `/` preserves the existing combined Google Calendar feed during migration.
- `/events.ics` proxies the configured Google Calendar. Until the source
  calendar is separated, this contains the same combined data as `/`.
- `/school.ics` is generated from the reviewed files in `data/school/`.

Birthday publication and access control are intentionally out of scope until a
privacy policy is agreed.

## Development

```sh
pnpm install
pnpm import:school
pnpm build
pnpm check
pnpm dev
```

The `DTEND` value in generated ICS is exclusive. Source data therefore uses the
explicit field name `endDateExclusive` to avoid accidental off-by-one errors.
The generated `dist/school.ics` is ignored by Git and is rebuilt from YAML for
every check and every direct Wrangler operation through its configured build
hook.

## Deployment

The project manages the existing Cloudflare Worker named `ical`. Always deploy
a preview and verify all routes before replacing the production deployment.

The production rollback baseline recorded before this migration is Worker
version `1487e0c0-a969-454f-8bcb-55f7f01876fb`.

## Project schedule sync

`sync/` is a second Worker, `nbtca-project-calendar`. Every 15 minutes it reads
organization project 5 and mirrors items with a Start date or End date onto a
separate Google Calendar. `pnpm deploy` does not publish this Worker, and it
does not add a route to `ical.nbtca.space`.

A project end date is inclusive. Google Calendar's all-day end date is
exclusive, matching `endDateExclusive` in the school calendar. An item with
only one of the two dates becomes a one-day event. Items that lose both dates,
and items that leave the project, have the event created by this sync removed.
Events on that calendar without this sync's private marker stay in place.

Credentials stay in Worker secrets:

```sh
wrangler secret put GITHUB_TOKEN -c sync/wrangler.jsonc
wrangler secret put GOOGLE_CLIENT_ID -c sync/wrangler.jsonc
wrangler secret put GOOGLE_CLIENT_SECRET -c sync/wrangler.jsonc
wrangler secret put GOOGLE_REFRESH_TOKEN -c sync/wrangler.jsonc
wrangler secret put GOOGLE_CALENDAR_ID -c sync/wrangler.jsonc
pnpm deploy:sync
```

`GITHUB_TOKEN` needs access to read the organization project. The Google
refresh token is the one issued for scope
`https://www.googleapis.com/auth/calendar.app.created` on the calendar that
application created. A local run uses the same variables:

```sh
GITHUB_TOKEN=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... GOOGLE_CALENDAR_ID=... pnpm sync
```
