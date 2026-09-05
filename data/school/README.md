# School calendar data

Each YAML file contains one academic year of all-day school events.

Required event fields:

- `id`: permanent repository identifier; never reuse it for another event.
- `uid`: globally unique calendar identifier; never change it after publication.
- `title`: title shown to subscribers, without the former `[NBT]` prefix.
- `startDate`: first day in `YYYY-MM-DD` form.
- `endDateExclusive`: day after the final displayed day.
- `sequence`: increment when materially changing a published event.
- `updatedAt`: UTC timestamp for the latest material change.

Optional fields are `description` and `location`.

For a one-day event on September 14, use:

```yaml
startDate: 2026-09-14
endDateExclusive: 2026-09-15
```

Run `pnpm build` after editing data, then commit the YAML source and generated
`public/school.ics` together.
