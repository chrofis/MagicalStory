# Landmark judging — instructions for a picking agent

You are choosing real places to set scenes in a picture book for a child under
about eight. You will be given a batch of landmarks. For each one you **look at
its photo** and give it a score.

This is the $0 path: agents read the images directly with the Read tool. No
image is sent to Gemini or any other paid API.

## What you receive

A batch entry lists, per landmark: `id`, `file`, `name`, `type`, `city`.
The images are in the batch's `dir`. Read `dir/file` to see the photo.

## The one question

**How good is this as a place a small child visits in a story? 0-100.**

Judge **what the photo actually shows**, not what the name promises. This is the
whole reason a human/agent looks instead of trusting metadata:

- `Ruine Dübelstein` is typed *Castle* and scores 134 on fame — its photo is
  knee-high foundation stones in gravel. That is not a castle to a child.
- `Schulhausplatz (Baden)` is typed *Square* — its photo is an active
  construction site with excavators.
- `Sammlung Briner und Kern` — the photo is a *painting*, not the building.
- `The Hall` is filed in Dübendorf — its photo is Zürich's Limmat waterfront
  with the Grossmünster, i.e. a different city entirely.

## Scale

- **80-100** — a child would love to be there and it reads instantly: a castle
  with towers, a zoo, a lit-up museum hall, an old covered bridge, a fountain
  with figures, a church with real character.
- **50-79** — a real, pleasant place, recognisable, just not remarkable.
- **30-49** — ordinary. A plain modern church, a tidy municipal building.
- **0-29** — REJECT: an apartment block, an office facade, a car park, a
  construction site, a railway platform, a featureless shed, a photo so dark,
  blurred or distant that nothing is recognisable.
- **0** — the photo plainly does not show the named place, or shows a different
  town.

Anything scoring under 30 is never offered to a story, so use that band
deliberately: it is the only protection against a book set at a building site.

## Output

Write ONE JSON file at the path you are given, exactly:

```json
{ "<id>": { "score": 84, "reason": "one short clause about what the photo shows" } }
```

- Use the numeric `id` from the batch, as the key.
- `reason` is one short clause, describing **the photo** — "hilltop castle with
  a flag", "office facade behind a car park". It is stored and read later.
- Include EVERY id in your batch. If an image will not open, give it `score: 0`
  and `reason: "image unreadable"` rather than skipping it — a missing id is
  indistinguishable from an unjudged landmark and will be re-prepped forever.
- No prose outside the JSON.
