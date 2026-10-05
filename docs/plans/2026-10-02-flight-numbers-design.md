# Making flight numbers legible to people who don't know them

We present `12 | 5 | -1 | 3` as if every reader already knows what the four
numbers mean. Experienced players do, and they are most of this site's
audience, so nothing here may cost them a glance. But readers arrive on a
range from "I forget which one is turn" to "what is overstable", and right now
the page teaches neither.

## What we're changing

1. **Label the numbers.** Four labelled cells — label above, value below —
   replacing the bare `12 | 5 | -1 | 3` in both the tooltip and the detail
   card.
2. **Say the stability in words.** `stability_group` already holds
   "overstable", "very understable" and so on. Show that, and drop `grade G`:
   the A–Q letter is Marshall Street's chart column and means nothing away
   from their page.
3. **Draw the flight.** An estimated flight path generated from the four
   numbers, in the detail card, replacing the image we hotlink from Marshall
   Street's S3 bucket.

Labels and wording come first because they are the only part that helps on a
phone, where there is no hover at all.

## The flight path

Marshall Street's per-disc image is a composite: a real PDGA specification
table, and a flight curve of their own. The curve is derived from the four
numbers, not measured or filed. Zeus and Destroyer are different moulds from
different manufacturers that share `12 | 5 | -1 | 3`, and their curves match
within 2%. Their lateral finish is a clean linear function of two ratings:

    finish% = -18*fade - 13*turn

    Roc       -18(3) - 13(0)  = -54   measured -54
    Zeus      -18(3) - 13(-1) = -41   measured -41
    Destroyer -18(3) - 13(-1) = -41   measured -43
    Mako3       0              =   0   measured -4

So there is no upstream artifact to lose by drawing our own. We are
reimplementing a heuristic, not replacing a measurement, which is why the
drawing is captioned as an estimate.

Measured off their images, with the tee at the origin and lateral offset in
feet, positive toward the right of the fairway for a right-handed backhand:

    lateral(t) = -turn*21*T(t) - fade*18*F(t)

`T` rises to its peak at 70% of the flight and relaxes to 62% of that by the
end, as the disc comes out of its turn. `F` stays at zero until 78% and then
grows sharply: the fade is abrupt, not a gradual arc. Both are fit from four
discs covering two distinct number sets, so they pin down turn and fade and
say nothing yet about glide's effect on shape.

Distance is linear in speed, anchored so a putter carries ~200ft and a speed
13 driver ~400ft, with a much smaller glide term:

    distance = 200 + (speed - 2)*200/11 + (glide - 4)*4

clamped to 120..500ft. All four numbers are manufacturer marketing figures
rather than measurements, and glide is the softest of them, so it gets a low
weight deliberately: across its whole 0..7 range it moves the result by about
40ft, against 200ft for speed. The viewBox is a fixed 500ft tall so paths are
comparable between discs: a putter's is visibly shorter than a driver's.

## Handedness

A right/left toggle, which is a sign flip on the lateral offset. It is nearly
free and "it finishes left" is wrong for a third of players. The setting is
stored as a URL parameter alongside the existing filters, so it survives a
reload and a shared link, and the tooltip honours the same choice.

## Deliberately not doing

**Arm speed.** The reference widget offers Beginner/Intermediate/Advanced/Pro,
and it is tempting to read that as a distance multiplier. It isn't. A slower
arm doesn't fly a Destroyer shorter, it never gets the disc to turn at all, so
the -1 simply doesn't happen and the disc behaves as if it were more
overstable. Supporting it means modelling how arm speed interacts with the
turn rating, which is a different curve shape rather than a scaled one. Left
for later, deliberately.

**Forehand.** Same reasoning: a forehand is not a mirrored backhand.

## Known limitations

- The constants come from four discs. A wider sample would firm them up, and
  would be the natural next pass.
- The distance axis of Marshall's images could not be calibrated reliably:
  horizontal gridline detection found 7 rows on three images and 9 on another.
  The lateral axis is solid, since the vertical gridlines sit at the same
  pixels in all four. Distance is cosmetic for a sketch; lateral shape is what
  teaches.
- Any curve we draw is a heuristic. It must stay captioned as an estimate.
