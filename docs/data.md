# Where the disc data comes from

The chart is built from web pages: a retailer's flight guide, which covers
every disc, and the manufacturers' own pages, which correct its flight
numbers. Three scripts turn those pages into the JSON the site loads:

    fetch.py        the web    -> sources/            downloads, the only step that uses the network
    build_db.py     sources/   -> discs.db            parses and merges
    build_json.py   discs.db   -> static/data/*.json  what the site serves

`mise run update` runs all three; `mise run build` rebuilds from the pages
already in `sources/`. Commit what changes, pages included: `git diff
sources/` is the record of what changed upstream, and a rebuild from a
checkout gives the same database every time.

## Sources

| name     | page                                               | provides |
|----------|----------------------------------------------------|----------|
| marshall | https://www.marshallstreetdiscgolf.com/flightguide | every disc and all its data |
| rpm      | https://www.rpmdiscs.com/disc-golf-discs/          | RPM's flight numbers |

`sources/fetched.json` records the URL, time and sha256 of each page's last
fetch. `build_db.py` copies it into the `sources` table of `discs.db`.

**Marshall Street** is the base dataset. Every disc in `discs.db` is one of
theirs, with their id, and their stability grade (A–Q) and category.

**Manufacturers** override the four flight numbers of the discs they list,
and nothing else. A retailer copies its numbers from manufacturers, and can
copy them wrong or miss a revision: in October 2026 Marshall Street had RPM's
Piwakawaka as 4 / 5 / 0 / 0, where RPM says 6 / 6 / -3 / 0. Marshall
Street's stability grade is their own judgement of a disc, not derived from
its numbers, so it stays theirs. The chart positions discs by turn + fade,
so corrected numbers move a disc on it.

## Checking a build

`build_db.py` prints, for each manufacturer, the discs whose numbers it
changed, and where the two listings don't line up:

    rpm: 13 discs listed, 12 matched, 3 with different numbers
      Piwakawaka: 4 / 5 / 0 / 0 -> 6 / 6 / -3 / 0
      Tui: 3 / 4 / -1 / 0 -> 3 / 4 / -1 / 0.5
      Ruru: 3 / 3 / 0 / 1 -> 2 / 3 / 0 / 1
      not in Marshall Street's guide: Kahu 2026
      only in Marshall Street's guide: Kahu OS, Kahu XG

A manufacturer's disc that isn't in Marshall Street's guide isn't added: it
would have no id, image, category or stability grade. Here "Kahu 2026" is a
new run of the Kahu. A disc only in Marshall Street's guide keeps their
numbers; RPM no longer lists the Kahu OS and Kahu XG.

Everything each source said is kept in `source_numbers`, which also holds the
numbers that lost. For example, every disc where Marshall Street disagrees
with a manufacturer:

```sql
select m.brand, m.model,
       m.speed, m.glide, m.turn, m.fade,  -- Marshall Street's
       s.source, s.speed, s.glide, s.turn, s.fade
from source_numbers m join source_numbers s using (disc_id)
where m.source = 'marshall' and s.source != 'marshall'
  and (m.speed, m.glide, m.turn, m.fade) is not (s.speed, s.glide, s.turn, s.fade);
```

`discs.numbers_source` names the source of each disc's numbers.

## Adding a manufacturer

1. Add the page to `SOURCES` in `fetch.py` and run `python fetch.py <name>`.
2. Write a parser in `build_db.py` that returns one row per stock mold
   (brand, model, speed, glide, turn, fade, url), and add it to `PARSERS`.
   Leave out special editions that give a mold's numbers a name of its own,
   like RPM's signature discs and Atua series, so they aren't reported as
   unmatched. Have the parser fail if it can't read a disc's numbers, so a
   change to the page fails the build instead of quietly dropping discs.
3. Run `mise run build` and read the report. Discs match on brand and model
   name, ignoring case, accents and punctuation (RPM's Tākapu is Marshall
   Street's Takapu). A name that fails to match shows up in the report as
   on one side only.
