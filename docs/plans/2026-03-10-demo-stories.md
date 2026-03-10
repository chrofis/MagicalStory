# Demo Story Test System

## Goal
A Playwright E2E test that generates real demo stories for the homepage, rotating through topics/art styles on each run.

## The Berger Family
- Emma Berger (5, girl) - brown hair pigtails, brown eyes
- Noah Berger (7, boy) - blonde hair short, blue eyes
- Daniel Berger (38, father) - dark brown hair, trimmed beard, brown eyes
- Sarah Berger (36, mother) - blonde shoulder-length hair, green eyes, glasses

## Tasks

- [x] 1. Research: Read existing E2E test setup (playwright config, helpers, auth flow)
- [x] 2. Create `scripts/admin/setup-demo-user.js` - one-time demo user creation
- [x] 3. Create `tests/helpers/demo-characters.ts` - Berger family character definitions
- [x] 4. Create `tests/helpers/demo-rotation.ts` - 18 topic/style rotation list
- [x] 5. Create `tests/demo-rotation-state.json` - initial state file
- [x] 6. Create `tests/demo-story.spec.ts` - main Playwright test
- [x] 7. Add `npm run test:demo`, `test:demo:local`, `test:demo:headed` to package.json
- [ ] 8. Test the setup-demo-user script
- [ ] 9. Run the demo test locally to verify

## Rotation (18 entries)
```
 0: life-challenge/first-kindergarten -> pixar
 1: adventure/pirate -> watercolor
 2: life-challenge/new-sibling -> cartoon
 3: adventure/space -> concept
 4: life-challenge/brushing-teeth -> chibi
 5: adventure/dinosaur -> comic
 6: life-challenge/going-to-bed -> oil
 7: adventure/knight -> steampunk
 8: educational/counting -> anime
 9: life-challenge/making-friends -> pixar
10: adventure/mermaid -> watercolor
11: historical/moon-landing -> concept
12: life-challenge/sharing -> cartoon
13: educational/planets -> cyber
14: adventure/superhero -> comic
15: historical/wilhelm-tell -> oil
16: life-challenge/managing-emotions -> manga
17: adventure/jungle -> lowpoly
```

## Art Style Gallery (separate, future)
One scene in all 13 styles: "the Berger family having a picnic in a Swiss meadow with mountains"

## Test Assertions
- Job status reaches `completed`
- Story has 14 pages with text
- Text is in German
- All 7 page images return 200
- Front cover exists
- No JS errors during wizard flow
