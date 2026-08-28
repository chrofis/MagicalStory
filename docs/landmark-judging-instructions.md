# Landmark judging — instructions for a picking agent

You are choosing real places to set scenes in a picture book for a child under
about eight. You will be given a batch of IMAGES. For each one you **look at the
picture** and give it two scores.

This is the $0 path: agents read the images directly with the Read tool. No
image is sent to Gemini or any other paid API.

## What you receive

A batch entry lists, per image: `id` (the landmark), `slot` (which of its up to
six photos this is), `file`, `name`, `type`, `city`. The images are in the
batch's `dir`. Read `dir/file` to see the photo.

The same landmark can appear several times with different slots. Judge each
picture on its own; do not carry a verdict across slots.

## The two scores

They are separate on purpose, because a candidate can fail in two unrelated
ways and each failure needs a different remedy.

### `draw` — is this PLACE a scene a small child can be in? (0-100)

About the SUBJECT, not the photograph. Imagine it illustrated in a storybook.

- **80-100** — a child would love to be there and it reads instantly: a castle
  with towers, a zoo, a lit-up museum hall, an old covered bridge, a fountain
  with figures, a church with real character, a lake shore, a market square.
- **50-79** — a real, pleasant place you could set a scene in, just not special.
- **30-49** — ordinary. A plain modern church, a tidy municipal building.
- **0-29** — REJECT the place: an apartment block, an office facade, a car park,
  a motorway junction, a railway platform, a featureless shed, a plain field.

**Fame does not raise this score.** The house where a famous person was born is
a house; a nuclear reactor's control room is famous and unusable. Score what a
child would experience standing there, not what the name is known for.

### `photo` — does THIS PICTURE show the place well? (0-100)

About the IMAGE only.

- **80-100** — clear, well-lit, the place fills the frame and is recognisable.
- **50-79** — usable; a bit distant, dull weather, partly obscured.
- **30-49** — poor: heavy crop of one wall, awkward angle, washed out.
- **0-29** — unusable: too dark, blurred, so distant nothing reads, upside down.
- **0** — not a photograph of the place at all: a MAP, a coat of arms, a logo,
  a share certificate, a diagram, a painting or engraving, a portrait of people,
  or a picture of somewhere else entirely.

A great castle photographed from 2km in fog is `draw` 85, `photo` 15 — the place
stays, another slot gets used. A car park in perfect light is `draw` 10,
`photo` 85 — the place goes.

### `framing` — how close is the shot? (one word)

Most stories put the action **at** the place: in the castle courtyard, on the
bridge. That needs the place filling the frame with room around it for
characters. A technically superb photo of the same castle as a speck on a
distant ridge is not wrong, it is just useless for that scene — so this is
recorded separately and never folded into `photo`.

- `medium` — the place fills most of the frame and you could stand there. Best
  for a scene, and the default when you are unsure.
- `closeup` — a detail fills the frame: one doorway, a carving, a single tower.
- `interior` — inside the building. **Valuable, not a leftover** — stories are
  often set inside the castle, the church, the covered bridge.
- `wide` — the place sits small inside a landscape or a townscape.
- `view-from` — the view looking OUT from the place: standing at the ruin with
  the valley or town spread out behind. The subject is the panorama, not the
  landmark. This is NOT `aerial`.
- `aerial` — taken from above, from a plane or drone; reads like a map.

Judge the framing on its own. A `wide` shot can still be a beautiful photograph
and should keep its high `photo` score; the framing word is what tells us it
cannot host the action.

All six are kept. We deliberately want a **spread** per landmark — a medium, a
closeup, an interior — because different scenes need different shots, so do not
push everything toward `medium`. Label what you actually see.

## Why both, and why looking matters

Metadata cannot see any of this. Real examples caught only by looking: a
geometry diagram filed under *Winkel*; a map of France; Bülach's coat of arms; a
Vienna department store standing in for Stäfa; **Mount Fuji filed under "Berg"**;
a fish ladder typed `Castle`; a lakeside village standing in for an artillery
fort; `Ruine Dübelstein`, typed *Castle* and famous, whose photo is knee-high
foundation stones in gravel.

## Output

Write ONE JSON file at the path you are given, exactly:

```json
{ "<id>_<slot>": { "draw": 85, "photo": 70, "framing": "medium", "reason": "one short clause about what the photo shows" } }
```

- The key is the landmark `id`, an underscore, and the `slot` — e.g. `"1234_2"`.
- `framing` is exactly one of `medium`, `closeup`, `interior`, `wide`, `view-from`, `aerial`.
- `reason` is one short clause describing **the picture** — "hilltop castle with
  a flag", "office facade behind a car park". It is stored and read later.
- Include EVERY item in your batch. If an image will not open, give it
  `draw: 0, photo: 0, framing: "medium", reason: "image unreadable"` rather than skipping it — a
  missing key is indistinguishable from an unjudged image and will be re-prepped
  forever.
- No prose outside the JSON.
