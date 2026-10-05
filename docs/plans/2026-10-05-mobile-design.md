# Making the guide usable on a phone

On a phone the page doesn't work. `body` is a fixed `280px 1fr` grid with no
breakpoint, so on a ~390px screen the filter sidebar takes most of the width.
The toolbar then wraps to four or five lines (count, color-by, ghosts toggle,
key, key text, zoom hint, legend), which takes most of the remaining height.
What's left for the chart is a small window, and nothing on the page lets you
get the filters out of the way.

Desktop stays exactly as it is. Everything below is behind a narrow-screen
breakpoint or a touch check.

## Decisions

- **Filters go in a left drawer, not a bottom sheet.** The drawer reuses the
  sidebar's look, and the long brand list scrolls the way it already does. A
  bottom sheet would feel more native, but it only feels right with drag-handle
  physics, which is more work than the problem deserves.
- **A tap on a disc opens a peek card, not the modal.** The card is docked at
  the bottom of the chart and shows what the tooltip shows on desktop. A
  "Details" button opens the full card. That way you can tap through several
  discs and compare them without a modal hiding the chart each time.

Both are starting points, and we expect to adjust them once we're using them on
a real phone.

## Phase 1: give the chart the screen

This phase fixes "unusable" on its own and should ship by itself.

**Breakpoint.** Use `@media (max-width: 700px)`. Below that width:

- `body` becomes a single column sized with `100dvh` rather than `100vh`. On
  iOS, `100vh` includes the area behind the address bar, which pushes the
  chart's bottom edge off screen.
- `#filters` becomes a fixed-position drawer from the left with a backdrop, and
  is closed by default. It stays the same `<form>` element, so `filterParams`,
  `restore` and the form's input/change listeners keep working unchanged. Only
  CSS and an open/closed class change.
- A compact top bar replaces the toolbar. It holds the title, the count
  ("142 of 1,203 discs"), a **Filters** button and **Reset zoom** when the chart
  is zoomed. The Filters button has a badge showing how many filters differ
  from the defaults, so you can see the chart is filtered without opening the
  drawer.
- The drawer closes on a backdrop tap, on Esc, or from a **Show N discs**
  button pinned to its bottom. The chart redraws live behind the drawer as
  filters change, so the count on that button is the feedback while you
  filter.

**Toolbar contents.** "Color by", "Show other discs", the line key and the
legend move into a "Display" fieldset at the top of the drawer. They're
settings you change once, not things you need to see all the time. Their
change listener is currently attached to `#toolbar`, so it has to move to
wherever those controls end up, or be delegated from `document`. `.key-text`
is hidden.

Moving these controls between the toolbar and the drawer depending on width
would mean moving DOM nodes when the viewport crosses the breakpoint. The
simpler option is to put them in the drawer's markup for every width and, on
desktop, lay that fieldset out with CSS. Check whether that layout holds up on
desktop before taking that route. If it doesn't, move the nodes once on a
`matchMedia` change.

## Phase 2: the chart under a finger

The pointer code in `chart.js` is mostly touch-ready already:
`touch-action: none` is set on the svg, and a touch reports `button === 0`, so
the brush works. These parts still need fixing:

- **Margins.** `MARGIN.left = 64` is about 17% of a phone's width. Make the
  margins a function of the container width in `measure()`, not a constant.
  Shorter axis titles, or ones moved inside the plot, free up the most space.
- **Brushing on a dense chart.** `brushStart` treats a pointerdown that lands
  on a disc as a click and won't start a brush. The hit reach is
  `HIT_X = 24` by `HIT_Y = 36`, so on a crowded phone-sized chart almost every
  touch lands on a disc and zooming becomes impossible. For touch, start every
  gesture as a candidate brush. A gesture that moves less than `MIN_BRUSH` is
  a tap on the nearest disc; anything longer is a brush.
- **Minimum height.** `measure()` floors the height at 360px. In landscape
  (about 390px tall, minus the top bar) the chart scrolls inside `#chart`.
  Decide whether a short plot beats scrolling. It probably does.
- **Labels.** `LABEL_LIMIT = 300` is a count of discs, and it doesn't take
  screen size into account. Base it on discs per unit of plot area, so a phone
  gets labels at the density where they can still be read.
- **Lanes.** Check that `MIN_LANE` packing still separates dots at about 300px
  of plot width. Dots that overlap here also make taps ambiguous.
- **Double-tap.** Mobile browsers don't reliably fire `dblclick`, so the Reset
  zoom button in the top bar is the reset. Leave the handler in for desktop.
- **Slider thumbs.** Grow `--thumb` from 14px to about 24px under
  `@media (pointer: coarse)`. 14px is too small to grab with a finger.

Pinch-to-zoom is out of scope for now, because the brush already covers
zooming.

## Phase 3: tapping a disc

- **Peek card.** On touch (`pointerType === "touch"` on the tap), `onClick`
  opens a card docked at the bottom of `#chart` instead of `#detail`. The card
  shows the tooltip content (name, brand, ratings, stability, the small flight
  path) and a **Details** button that opens the existing modal. Tapping another
  disc swaps the card's contents, and tapping empty space closes it. The
  tapped dot keeps its hover highlight while its card is open. Mouse clicks
  keep opening the modal directly.
- **`#detail` on a phone.** Make it a full-screen sheet. The 150px flight
  figure floated next to the text is cramped at `90vw`, so stack it above the
  text.
- **`#inline-detail` on a phone.** It's `min(300px, 45%)`, which is about
  175px wide and unreadable. Dock it at the bottom like the peek card,
  collapsed to the same summary, with a control to expand it to the full card.

## Phase 4: checking it

- Take Playwright screenshots at 390×844, 360×740 and 844×390 (landscape)
  against `dev.py`, both before and after each phase.
- Test on a real iPhone as well. The emulator doesn't reproduce iOS Safari's
  `dvh`, its `<dialog>` behaviour or its tap delays faithfully.
- Make sure desktop at 1440×900 looks the same as before the change.

## Deliberately not doing

- **Pinch-to-zoom and pan.** The brush plus Reset covers zooming. Pinch would
  mean taking over gestures the browser handles now and writing our own
  momentum. We'll come back to it only if the brush feels wrong under a finger.
- **A separate mobile chart** (a list view, or swapping the axes for portrait).
  The chart is the product. The aim is to make room for it, not to replace it.
