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
| pdga     | https://www.pdga.com/technical-standards/equipment-certification/discs/export | every PDGA approved disc, and its specs |

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

**The PDGA** publishes every disc it has approved, from every manufacturer,
as one CSV, loaded as published into the `pdga_discs` table. It has specs,
a certification number and an approval date, but no flight numbers. Each
disc is linked to its approval (see below) and takes its specs from it.
Things to know about it:

- Manufacturer names are often legal or distributor names: "Innova
  Champion Discs", "RPM Discs/Disc Golf Aotearoa".
- Model names carry aliases and codes in parentheses: "Kahu (DGD2)",
  "Piwakawaka (MR1, originally Arcturus)".
- A retooled mold is approved again, as a row of its own: "Kiwi (DGD1,
  retooled)".
- Manufacturer and model together are unique; the certification number
  isn't quite (23-46 is both Compound's Barb and Discmania's MD5).
- "Last Year Production" is empty for every disc.

## Brands

`brands.toml` lists every brand we chart. A brand is what a disc is
marketed as: DGA's discs are DGA's, though some are approved under
Discraft. For each brand it gives:

- the PDGA manufacturer names its discs are approved under, often legal or
  distributor names ("Innova Champion Discs", "Innova Factory Store")
- its colors on the chart, if Marshall Street doesn't have them
- its website, once we read a source from it
- **lineage**: what we know of who makes its discs, or who it's related
  to, each fact with where it came from. Facts from memory are marked
  unverified. Nothing shows lineage yet; it's kept for later.

Its `[reassign]` section moves discs Marshall Street files under the wrong
brand. They put 21 discs from brands they don't carry under "Other", and
file Arsenal, Reptilian and Black Zombie discs under Gateway. Each was
matched to its PDGA approval by name, specs and approval date.
It also renames discs, such as the second of the two DD2s Marshall
Street lists. Where two discs share a name, `brands.toml` and `molds.toml`
can pick one out by Marshall Street's id: `"Discmania | DD2 #292"`.

The build fails on a brand `brands.toml` doesn't list, on a reassignment
that matches no disc, and on a PDGA manufacturer name the PDGA's list
doesn't have, which is how a renamed manufacturer shows up. So a new brand
is always a decision someone made, recorded in `brands.toml`.

## Linking discs to the PDGA

Each disc is linked to one approval of its brand's PDGA manufacturers
(`discs.pdga_manufacturer` and `discs.pdga_model`), and takes its specs and
approval date from it. Discs not linked keep Marshall Street's. Several
discs can share an approval: the Aviar Classic, KC Pro Aviar and Yeti Pro
Aviar are all the Aviar. The build tries, in order:

1. Marshall Street's name for the disc's approval, which they copied from
   the PDGA.
2. The disc's name against each approval's names, including the aliases
   in its parentheses: "Rook (renamed from P Model US)" is the P Model US.
3. Identical specs and approval date. Marshall Street copies specs from
   the PDGA, so this finds discs sold under another name: RPM's Kahu XG is
   the Kahu.

When more than one approval matches, it prefers one named exactly as the
disc is, then the one Marshall Street's approval date points at, then,
when they're all one mold approved again after retooling (DD2, DD2 (new),
DD2 (2025)), the latest.

`molds.toml` covers the rest: links the build can't find, like Yikun's
discs, approved under English names that Marshall Street doesn't use, or
discs approved under another company; and discs checked by hand and found
not to be approved, so that the build's report of unlinked discs shows only
new ones.

In October 2026 linking corrected Marshall Street's specs for three discs
they'd taken from another company's disc of the same name (Yikun's Crossbow
and Hammer, and Stokely's CHING Juju), and filled in specs for 52 discs
they had none for.

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
   (brand, model, speed, glide, turn, fade, url), and add it to
   `MANUFACTURERS`.
   Leave out special editions that give a mold's numbers a name of its own,
   like RPM's signature discs and Atua series, so they aren't reported as
   unmatched. Have the parser fail if it can't read a disc's numbers, so a
   change to the page fails the build instead of quietly dropping discs.
3. Add its brand to `brands.toml` if it's new, and set its `website`.
4. Run `mise run build` and read the report. Discs match on brand and model
   name, ignoring case, accents and punctuation (RPM's Tākapu is Marshall
   Street's Takapu). A name that fails to match shows up in the report as
   on one side only.
