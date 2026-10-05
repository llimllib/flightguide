// An estimated flight path, drawn from a disc's four numbers.
//
// Marshall Street publish a per-disc flight image, and it turns out to be
// derived from the numbers rather than measured: Zeus and Destroyer are
// different moulds sharing 12 | 5 | -1 | 3, and their curves match within 2%.
// The constants below are measured off those images, so our paths look like
// the ones people already know from that site. See
// docs/plans/2026-10-02-flight-numbers-design.md.
//
// Everything is in feet, with the tee at the origin and the fairway running in
// -y. Positive x is the right of the fairway, which is where a right-handed
// backhand turns.

// speed carries the distance: a putter floats about 200ft, a speed 13 driver
// about 400. Glide is the softest of four already soft numbers, so it only
// adjusts the result by about 40ft across its whole range
const BASE_FT = 200;
const BASE_SPEED = 2;
const FT_PER_SPEED = 200 / 11;
const FT_PER_GLIDE = 4;
const GLIDE_REF = 4;
const MIN_FT = 120;
const MAX_FT = 500;

// lateral feet per unit of turn at the peak of the turn, and per unit of fade
// by the time the disc lands. These six are a least squares fit to fifteen
// points measured off Marshall Street's images, and land within 1.6ft rms
const TURN_FT = 23.5;
const FADE_FT = 18;
// the turn peaks at 80% of the flight and relaxes to 55% of that as the disc
// comes out of it; the fade creeps in from half way and then bites hard
const TURN_PEAK = 0.8;
const TURN_RELAX = 0.45;
const FADE_ONSET = 0.5;
const FADE_SHAPE = 4;

// half the width of the drawing, in feet. Fade tops out at 6 and turn at -5,
// so nothing reaches past about 110
const HALF_WIDTH = 125;

const smoothstep = (a, b, t) => {
  const s = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return s * s * (3 - 2 * s);
};

// flightDistance estimates how far a disc carries, in feet
export const flightDistance = (d) =>
  Math.max(
    MIN_FT,
    Math.min(MAX_FT, BASE_FT + (d.speed - BASE_SPEED) * FT_PER_SPEED + ((d.glide ?? GLIDE_REF) - GLIDE_REF) * FT_PER_GLIDE),
  );

// lateral is how far the disc has drifted at t, a fraction of the way through
// its flight. Turn pushes it right and fade pulls it back left
const lateral = (d, t) => {
  const turn = smoothstep(0, TURN_PEAK, t) - TURN_RELAX * smoothstep(TURN_PEAK, 1, t);
  const fade = Math.min(1, Math.max(0, (t - FADE_ONSET) / (1 - FADE_ONSET))) ** FADE_SHAPE;
  return -d.turn * TURN_FT * turn - d.fade * FADE_FT * fade;
};

// flightPath describes a disc's flight for drawing: an SVG path from the tee,
// the landing point, and the viewBox they sit in. A left-handed backhand is
// the mirror image, so hand only flips the sign. The viewBox is a fixed 500ft
// tall whatever the disc, so a putter's path reads as shorter than a driver's
export function flightPath(d, hand = "r", steps = 32) {
  const dist = flightDistance(d);
  const flip = hand === "l" ? -1 : 1;
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push([flip * lateral(d, t), -t * dist]);
  }
  const [lastX, lastY] = points.at(-1);
  return {
    path: points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" "),
    land: { x: lastX, y: lastY },
    dist: Math.round(dist),
    max: MAX_FT,
    viewBox: `${-HALF_WIDTH} ${-MAX_FT} ${2 * HALF_WIDTH} ${MAX_FT}`,
  };
}
