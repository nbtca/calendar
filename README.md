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

## Deployment

The project manages the existing Cloudflare Worker named `ical`. Always deploy
a preview and verify all routes before replacing the production deployment.

The production rollback baseline recorded before this migration is Worker
version `1487e0c0-a969-454f-8bcb-55f7f01876fb`.
