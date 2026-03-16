# Meta Ads Strategy — MagicalStory.ch

## Overview

Meta (Facebook + Instagram) is the primary paid acquisition channel for MagicalStory. The target audience — Swiss parents aged 25-45 — spends significant time on Instagram (discovery) and Facebook (community groups, marketplace). The visual nature of personalized storybooks makes this an ideal platform pair.

**Core insight:** We are not selling a book. We are selling the moment a child sees themselves as the hero of a story. Every ad must create or invoke that emotional moment.

---

## Audience Definitions

### Audience 1: Broad Swiss Parents (Awareness)

| Parameter | Value |
|-----------|-------|
| Location | Switzerland |
| Age | 25-45 |
| Gender | All (skew female 65%) |
| Interests | Parenting, children's books, family activities |
| Exclusions | Already converted (pixel-based) |
| Size estimate | 800K-1.2M |

### Audience 2: Engaged Parents (Conversion)

| Parameter | Value |
|-----------|-------|
| Location | Switzerland |
| Age | 28-42 |
| Gender | All |
| Interests | Children's education, personalized gifts, creative activities, reading with kids |
| Behaviors | Engaged shoppers, online buyers |
| Exclusions | Already converted |
| Size estimate | 200K-400K |

### Audience 3: Gift Givers (Seasonal)

| Parameter | Value |
|-----------|-------|
| Location | Switzerland + bordering regions (DE, FR, AT, IT) |
| Age | 30-65 |
| Gender | All |
| Interests | Gift shopping, children, grandchildren |
| Behaviors | Engaged shoppers, recent gift purchases |
| Life events | Friends/family with upcoming birthdays (when available) |
| Size estimate | 500K-800K |

### Audience 4: Town-Specific (Hyper-Local)

| Parameter | Value |
|-----------|-------|
| Location | 15km radius around specific Swiss city |
| Age | 25-45 |
| Gender | All |
| Interests | Parenting, local community |
| Custom targeting | City name in ad copy and creative |
| Rotation | Top 20 Swiss cities, one at a time |
| Size estimate | 20K-80K per city |

### Audience 5: Retargeting (Warm)

| Parameter | Value |
|-----------|-------|
| Source | Website visitors (pixel) |
| Segments | Started wizard but didn't complete, completed free story but didn't purchase, viewed pricing page, abandoned cart |
| Lookback | 30 days |
| Exclusions | Purchasers (last 14 days) |
| Size estimate | Grows with traffic; target 5K+ for meaningful delivery |

### Audience 6: Lookalike

| Parameter | Value |
|-----------|-------|
| Source | Story completers + purchasers (pixel) |
| Similarity | 1% (start narrow), expand to 3% as data grows |
| Location | Switzerland |
| Minimum seed | 100 conversions before activating |
| Size estimate | 50K-150K (1%), 150K-450K (3%) |

---

## Campaign Structure

### Campaign 1: Awareness — "Meet Your Story"

| Parameter | Value |
|-----------|-------|
| Objective | Video views / Reach |
| Placement | Instagram Reels, Instagram Stories, Facebook Feed |
| Audience | Audience 1 (Broad Swiss Parents) |
| Budget | 20% of total |
| Creative | 15-second video: story creation process from photo upload to printed book |
| Optimization | ThruPlay (15-sec view) |
| Bid strategy | Lowest cost |
| Goal | Build pixel data, warm audiences for retargeting |

**Why awareness first:** Meta's algorithm needs data. Running conversion campaigns with zero pixel history results in expensive, scattered delivery. 2-4 weeks of awareness builds a warm audience pool and teaches the pixel what our ideal visitor looks like.

**Success criteria:** CPM < CHF 8, ThruPlay rate > 15%, warm audience pool > 10,000 people.

### Campaign 2: Conversion — Emotional

| Parameter | Value |
|-----------|-------|
| Objective | Conversions (StoryCompleted event) |
| Placement | Instagram Feed, Instagram Stories, Facebook Feed |
| Audience | Audience 2 (Engaged Parents) |
| Budget | 30% of total |
| Creative | Carousel: child photo transforms into illustrated character across story pages |
| Copy angle | "Stell dir vor, dein Kind entdeckt sich selbst als Held einer Geschichte" |
| Optimization | Conversions (7-day click, 1-day view) |
| Bid strategy | Cost cap at CHF 15 per story completion |
| Goal | Drive free story completions that convert to print |

**Key creative requirement:** The carousel must show a REAL transformation — actual photo on slide 1, illustrated version on slide 2-5. This is the "aha moment" in ad format.

**Success criteria:** CPA (story completion) < CHF 12, story-to-print conversion > 8%.

### Campaign 3: Conversion — Local/Town

| Parameter | Value |
|-----------|-------|
| Objective | Conversions (StoryCompleted event) |
| Placement | Facebook Feed, Instagram Feed |
| Audience | Audience 4 (Town-Specific) |
| Budget | 15% of total |
| Creative | Illustrated town landmark with child character + town name in headline |
| Copy angle | "Eine Geschichte aus [Stadtname] — mit deinem Kind als Held" |
| Optimization | Conversions |
| Bid strategy | Lowest cost (smaller audiences need flexibility) |
| Rotation | 1 city per week, cycle through top 20 |
| Goal | Hyper-relevant local engagement, word-of-mouth trigger |

**City rotation (priority order):**
1. Zuerich
2. Bern
3. Basel
4. Luzern
5. St. Gallen
6. Winterthur
7. Lausanne (FR creative)
8. Geneve (FR creative)
9. Biel/Bienne (bilingual)
10. Thun
11. Aarau
12. Schaffhausen
13. Chur
14. Baden
15. Zug
16. Olten
17. Frauenfeld
18. Rapperswil-Jona
19. Davos
20. Interlaken

**Success criteria:** CPA < CHF 10 (local relevance should boost CTR), engagement rate > 3%.

### Campaign 4: Conversion — Gift

| Parameter | Value |
|-----------|-------|
| Objective | Conversions (Purchase event) |
| Placement | Instagram Feed, Instagram Stories, Facebook Feed |
| Audience | Audience 3 (Gift Givers) |
| Budget | 15% of total |
| Creative | Gift card visual, child holding book, unboxing moment |
| Copy angle | "Das persoenlichste Geschenk der Welt" |
| Optimization | Conversions (Purchase) |
| Bid strategy | Cost cap at CHF 25 per purchase |
| Activation | 4 weeks before each major occasion, always-on at reduced budget between |
| Goal | Gift card and direct print purchases |

**Seasonal activation calendar:**

| Period | Occasion | Budget Multiplier |
|--------|----------|------------------|
| Nov 1 - Dec 24 | Christmas / Samichlaus | 3x |
| Mar 1 - Apr 15 | Easter | 1.5x |
| Apr 15 - May 12 | Mother's Day | 2x |
| May 15 - Jun 15 | Father's Day | 1.5x |
| Aug 1 - Sep 15 | Schulanfang | 2x |
| All other periods | Birthdays (always-on) | 1x |

**Success criteria:** ROAS > 3x on gift card purchases, CPA < CHF 25 per purchase.

### Campaign 5: Retargeting

| Parameter | Value |
|-----------|-------|
| Objective | Conversions |
| Placement | Instagram Stories, Facebook Feed, Audience Network |
| Audience | Audience 5 (Retargeting segments) |
| Budget | 10% of total |
| Creative | Dynamic — personalized based on behavior segment |
| Frequency cap | 3 impressions per person per week |
| Optimization | Conversions |
| Bid strategy | Lowest cost |
| Goal | Re-engage dropoffs, convert free-to-paid |

**Segment-specific creative:**

| Segment | Message | CTA |
|---------|---------|-----|
| Started wizard, didn't finish | "Deine Geschichte wartet auf dich" | Jetzt weitermachen |
| Completed free story, no purchase | "Dein Buch ist druckbereit" (show their theme) | Jetzt drucken lassen |
| Viewed pricing, no action | "Ab CHF 38 — inkl. Versand in der Schweiz" | Jetzt bestellen |
| Abandoned cart | "Deine Bestellung ist noch offen" | Jetzt abschliessen |

**Success criteria:** CPA < CHF 8 (warm audience should convert cheaply), frequency < 3/week.

### Campaign 6: Lookalike Scaling

| Parameter | Value |
|-----------|-------|
| Objective | Conversions |
| Placement | Best-performing from campaigns 2-4 |
| Audience | Audience 6 (1-3% Lookalike) |
| Budget | 10% of total |
| Creative | Best-performing from campaigns 2-4 (rotate winners) |
| Optimization | Conversions |
| Bid strategy | Cost cap at CHF 15 per story completion |
| Activation | Once pixel has 100+ story completions |
| Goal | Scale acquisition beyond interest-based targeting |

**Scaling rules:**
- Start at 1% lookalike (most similar to converters)
- Expand to 2% when CPA is stable for 7 days
- Expand to 3% when 2% CPA is stable for 7 days
- Never go beyond 3% — quality drops sharply in Swiss market (small country)
- Refresh seed audience monthly (new converters improve the model)

**Success criteria:** CPA within 20% of Campaign 2 performance.

---

## Ad Creative Strategy

### Creative Type 1: Before/After Transformation

**Format:** Single image, split-screen
**Placements:** Instagram Feed, Facebook Feed
**Concept:** Left side shows child's photo (with permission/placeholder). Right side shows the same child as an illustrated character in a story scene.

**Why it works:**
- The IKEA effect in visual form — "that's MY child"
- Endowment effect — they see what they could own
- Incongruity — "wait, that's a real photo next to an illustration?"
- Scroll-stopping: the brain processes faces first, then tries to reconcile photo vs. illustration

**Production requirements:**
- Need 5-8 diverse example transformations (different ethnicities, ages, genders)
- Must show real quality of the product — no mockups or stock illustrations
- Use actual MagicalStory output, not idealized versions

### Creative Type 2: Story Flip-Through Video

**Format:** 15-second video, vertical
**Placements:** Instagram Reels, Instagram Stories
**Concept:** Camera angle looking down at a printed book being flipped through. Each page shows the child character in a different scene. Background music: gentle, wonder-filled.

**Why it works:**
- Peak-end rule: showing the best pages creates a disproportionately positive impression
- Social proof through format: feels like a real product review/unboxing
- Shows consistency — the same child appears on every page (our competitive advantage)
- Video drives higher engagement and cheaper CPMs than static images

**Production requirements:**
- Film with actual printed book (order sample from Gelato)
- Natural lighting, clean background (wooden table, cozy setting)
- Gentle page-turn sounds
- Subtitle overlay: "Jede Seite mit [Name] als Held"
- End frame: "Erste Geschichte gratis" + URL

### Creative Type 3: Town Hook

**Format:** Single image
**Placements:** Facebook Feed, Instagram Feed
**Concept:** Illustrated version of a recognizable town landmark (Zuerich Grossmuenster, Bern Baeregrabe, Luzern Kapellbruecke) with a child character in the foreground.

**Why it works:**
- Local identity triggers strong emotional response ("that's MY town!")
- Pattern interrupt: "Why is my town illustrated like a children's book?"
- Curiosity gap: people click to understand the connection
- Shares well in local Facebook groups and community pages

**Production requirements:**
- Generate illustrations for each target city's landmark using the MagicalStory pipeline
- Include city name prominently in the image
- Child character should be generic (not specific — the viewer projects their own child)
- Pair with city-specific ad copy

### Creative Type 4: Parent Quote / UGC Style

**Format:** Stories (vertical), Reels
**Placements:** Instagram Stories, Instagram Reels
**Concept:** Either (a) text overlay on simple background with a real parent quote, or (b) video of parent filming their child's reaction to seeing their personalized story.

**Why it works:**
- Social proof — real people, real reactions
- UGC aesthetic bypasses "ad blindness" — looks like organic content
- Emotional resonance — parents relate to other parents
- Lowest production cost of all creative types

**Production requirements:**
- Collect testimonials from beta users / early customers
- Ask 5-10 parents to film their child's reaction (offer free story as incentive)
- Low-fi is better — polished UGC looks fake
- Always get written permission for likeness

### Creative Type 5: Gift Occasion

**Format:** Carousel or single image
**Placements:** Facebook Feed, Instagram Feed
**Concept:** Gift-wrapped book with visible child character peeking out. Seasonal context (Christmas tree, birthday cake, school bag). Gift card option prominently shown.

**Why it works:**
- Mental accounting: activates the "gift budget" (separate from personal spending)
- Occasion trigger: people actively searching for gifts see a solution
- Solves gift anxiety: "What do I get a kid who has everything?"
- Gift cards solve the "I don't have a photo" problem (addressed in copy)

**Production requirements:**
- Seasonal photo shoots (or generated imagery) for each major occasion
- Show both physical book AND gift card option
- Include pricing: "Geschenkkarte ab CHF 39"
- Emphasize "einzigartig" (unique) and "persoenlich" (personal) — differentiation from toys

---

## Ad Copy Templates

### Emotional — German (Primary)

**Version A (Discovery):**
> Dein Kind als Held seiner eigenen Geschichte.
>
> Lade ein Foto hoch, waehle ein Abenteuer — und halte ein Buch in den Haenden, das es nur einmal auf der Welt gibt.
>
> Die erste Geschichte ist kostenlos.
> magicalstory.ch

**Version B (Imagination):**
> Was waere, wenn dein Kind durch einen verzauberten Wald wandert, ein Raetsel loest und am Ende die ganze Stadt rettet?
>
> Bei MagicalStory wird daraus ein richtiges Buch — mit deinem Kind auf jeder Seite.
>
> Jetzt gratis ausprobieren.
> magicalstory.ch

**Version C (Quality):**
> Nicht irgendein KI-Bilderbuch.
>
> Jede Illustration individuell generiert. Jede Geschichte einzigartig geschrieben. Dein Kind auf jeder Seite wiedererkennbar.
>
> Professionell gedruckt. In die Schweiz geliefert.
>
> Erste Geschichte kostenlos.
> magicalstory.ch

### Local — German

**Version A (Town Pride):**
> Eine Geschichte aus [Stadtname] — und dein Kind mittendrin.
>
> [Kindername] erkundet [lokale Sehenswuerdigkeit], trifft [lokale Figur] und erlebt ein Abenteuer in der eigenen Stadt.
>
> Jetzt kostenlos ausprobieren.
> magicalstory.ch

**Version B (Neighborhood):**
> Stell dir vor: Ein Bilderbuch, das in [Stadtname] spielt. Und dein Kind ist die Hauptfigur.
>
> Abenteuer direkt vor der Haustuer — mit echten Orten, die dein Kind kennt.
>
> Gratis testen.
> magicalstory.ch

### Gift — German

**Version A (Personal):**
> Das persoenlichste Geschenk, das du je machen wirst.
>
> Ein illustriertes Buch, in dem [Kindername] die Hauptrolle spielt. Jede Seite individuell gestaltet. Jede Geschichte einzigartig.
>
> Geschenkkarte ab CHF 39.
> magicalstory.ch/gift

**Version B (Problem-Solving):**
> Schon wieder ein Spielzeug, das nach zwei Wochen in der Ecke liegt?
>
> Schenk stattdessen eine Geschichte. Ein Buch, in dem das Kind die Hauptfigur ist. Etwas, das bleibt.
>
> Geschenkkarte ab CHF 39 — die Eltern erstellen das Buch mit einem Foto.
> magicalstory.ch/gift

**Version C (Grandparent):**
> Oma- und Opa-Tipp: Ein Buch, in dem euer Enkelkind der Star ist.
>
> Ihr kauft die Geschenkkarte. Die Eltern laden ein Foto hoch. Und euer Enkelkind bekommt eine Geschichte, die es nur einmal auf der Welt gibt.
>
> Ab CHF 39.
> magicalstory.ch/gift

### Emotional — English (Expat Targeting)

**Version A:**
> Your child. The hero of their own story.
>
> Upload a photo, pick an adventure, and hold a one-of-a-kind illustrated book in your hands.
>
> Your first story is free.
> magicalstory.ch

**Version B:**
> What if your child could star in their very own picture book?
>
> Every page illustrated just for them. Every story written around their adventure. Professionally printed and delivered to your door.
>
> Try it free.
> magicalstory.ch

### Retargeting Copy

**Didn't finish wizard:**
> Du hast angefangen, eine Geschichte zu erstellen — aber noch nicht fertig.
>
> Dein Abenteuer wartet. In wenigen Minuten haeltst du eine einzigartige Geschichte in den Haenden.
>
> Jetzt weitermachen.

**Free story complete, no purchase:**
> Deine Geschichte ist bereit zum Drucken.
>
> Ab CHF 38 — professionell gedruckt, kostenloser Versand in der Schweiz. Inklusive digitale Version.
>
> Jetzt drucken lassen.

**Cart abandoner:**
> Deine Bestellung wartet noch auf dich.
>
> [Anzahl] Seiten voller Abenteuer, mit deinem Kind als Held.
>
> Jetzt abschliessen.

---

## Testing Framework

### Phase 1: Creative Testing (Weeks 1-2)

**Setup:**
- 5 creative types (Transformation, Flip-Through, Town, UGC, Gift)
- 2 copy angles per creative = 10 ad variants
- Single campaign, Audience 2 (Engaged Parents)
- Budget: CHF 50/day split evenly across variants (CHF 5/ad/day)
- Total Phase 1 spend: CHF 700

**Primary metric:** Cost per story completion (StoryCompleted pixel event)
**Secondary metrics:** CTR, CPC, ThruPlay rate (for video)

**Decision rules:**
- After 500 impressions per ad: kill any ad with CTR < 0.5%
- After 1,000 impressions per ad: kill any ad with CPC > CHF 2.00
- After 2,000 impressions per ad: kill any ad with cost per story completion > CHF 20
- Top 3 performers advance to Phase 2

### Phase 2: Audience Testing (Weeks 3-4)

**Setup:**
- Take winning 3 creatives from Phase 1
- Test across all 5 audiences (excl. Lookalike — not enough data yet)
- 3 creatives x 5 audiences = 15 ad sets
- Budget: CHF 75/day split across ad sets
- Total Phase 2 spend: CHF 1,050

**Primary metric:** Cost per story completion AND story-to-print conversion rate
**Secondary metrics:** CPM (audience quality indicator), frequency

**Decision rules:**
- After 1,000 impressions per ad set: kill any with CPC > CHF 1.50
- After 2,000 impressions per ad set: identify top 5 creative-audience combinations
- Calculate blended CPA and ROAS for each combination
- Top 5 advance to Phase 3

### Phase 3: Scaling (Weeks 5-8)

**Setup:**
- 80% of budget on winning 5 combinations from Phase 2
- 20% of budget on new creative tests (continuous iteration)
- Increase daily budget 20% every 3 days IF CPA holds within 15% of target
- Activate Lookalike campaign (Campaign 6) once 100+ conversions accumulated

**Scaling discipline:**
- If CPA rises > 20% above target for 3 consecutive days, pause scaling
- Refresh creative every 2 weeks OR when frequency exceeds 3.0
- Monitor auction overlap between campaigns — merge or exclude as needed
- Never scale faster than 20% per 3 days (Meta's algorithm needs time to adjust)

**Budget ramp:**

| Week | Daily Budget | Monthly Run Rate | Cumulative Spend |
|------|-------------|-----------------|-----------------|
| 5 | CHF 100 | CHF 3,000 | CHF 2,450 |
| 6 | CHF 140 | CHF 4,200 | CHF 3,430 |
| 7 | CHF 200 | CHF 6,000 | CHF 4,830 |
| 8 | CHF 280 | CHF 8,400 | CHF 6,790 |

Total Phase 1-3 test budget: approximately CHF 6,800 over 8 weeks.

### Ongoing: Always-Be-Testing (Week 9+)

- Test 2-3 new creatives per week
- Kill underperformers within 3 days (at 1,000+ impressions)
- Winning creatives get scaled; losers get analyzed for learnings
- Monthly creative refresh for all active campaigns
- Seasonal creative swaps 4 weeks before each occasion

---

## Key Performance Benchmarks

| Metric | Our Target | Swiss Average | Industry Average |
|--------|-----------|--------------|-----------------|
| CTR (Feed) | 1.5-3.0% | 1.0-1.5% | 0.9% |
| CTR (Stories) | 0.8-1.5% | 0.5-0.8% | 0.5% |
| CTR (Reels) | 1.0-2.0% | 0.7-1.2% | 0.6% |
| CPC | CHF 0.30-0.80 | CHF 0.50-1.50 | CHF 0.50-1.50 |
| CPM | CHF 5-12 | CHF 6-15 | CHF 5-15 |
| Cost per story start | CHF 3-8 | N/A | N/A |
| Cost per story complete | CHF 8-15 | N/A | N/A |
| Cost per print purchase | CHF 15-30 | N/A | N/A |
| Story start to complete rate | 60-75% | N/A | N/A |
| Story complete to print rate | 8-15% | N/A | N/A |
| ROAS (print) | 3-5x | 2-4x | 2-4x |
| ROAS (blended incl. digital) | 2-4x | N/A | N/A |
| Frequency (retargeting) | < 3/week | N/A | N/A |

**Why our CTR targets are above average:** Personalized children's content is inherently scroll-stopping. A parent seeing a child in a story illustration will stop scrolling. Our product IS the creative — we are not selling a commodity.

---

## Meta Pixel Events to Track

### Standard Events

| Event | Trigger Point | Parameters |
|-------|--------------|------------|
| PageView | All pages | page_path, referrer |
| ViewContent | Theme selected in wizard | content_name (theme), content_type (story) |
| AddToCart | Story generation started | content_name (theme), value (CHF 0 or story price) |
| InitiateCheckout | Print order started | value, currency, content_ids |
| Purchase | Print order completed | value, currency, content_ids, content_type |
| CompleteRegistration | Account created | method (email, Google, etc.) |
| Lead | Free story completed | content_name (theme) |

### Custom Events

| Event | Trigger Point | Parameters |
|-------|--------------|------------|
| PhotoUploaded | Photo successfully processed | character_count |
| WizardStep | Each wizard step completed | step_number, step_name |
| StoryStarted | Story generation begins | theme, page_count, language |
| StoryCompleted | Story generation finishes | theme, page_count, duration_seconds |
| StoryViewed | User views completed story | story_id, view_duration |
| PrintSelected | User clicks "Print this story" | format (soft/hard), page_count |
| GiftCardViewed | User views gift card options | — |
| GiftCardPurchased | Gift card bought | value, type (digital/physical) |
| BundlePurchased | Digital bundle bought | bundle_size (3 or 5), value |

### Pixel Implementation Notes

- Install Meta Pixel via Google Tag Manager (single tag, all events)
- Server-side Conversions API for Purchase and Lead events (reliability)
- Deduplicate browser + server events using event_id parameter
- Set value and currency on ALL conversion events (even free story = CHF 0)
- Enable Advanced Matching: hash email + phone for better attribution
- Test all events in Meta Events Manager before launching campaigns

---

## Budget Allocation by Campaign

### Monthly Budget: CHF 3,000 (Starting Point)

| Campaign | % | Monthly | Purpose |
|----------|---|---------|---------|
| 1. Awareness | 20% | CHF 600 | Pixel training, warm audiences |
| 2. Conversion — Emotional | 30% | CHF 900 | Primary acquisition |
| 3. Conversion — Local | 15% | CHF 450 | Hyper-local engagement |
| 4. Conversion — Gift | 15% | CHF 450 | Gift purchases |
| 5. Retargeting | 10% | CHF 300 | Re-engage dropoffs |
| 6. Lookalike | 10% | CHF 300 | Scale winners |

### Budget Reallocation Rules

- **After Week 4:** If awareness CPM > CHF 15, reduce to 10% and shift to conversion
- **After Week 8:** If retargeting CPA < CHF 5, increase to 15% (high efficiency)
- **Seasonal:** During gift seasons, shift 10% from awareness to gift campaign
- **Lookalike:** Only activate after 100+ conversions. Before that, reallocate to conversion campaigns
- **Monthly review:** Rebalance based on CPA and ROAS data. No campaign gets budget just because it's in the plan — it earns budget with performance.

### Annual Budget Projection

| Month | Budget | Notes |
|-------|--------|-------|
| M1 | CHF 1,750 | Testing phase (Phases 1-2) |
| M2 | CHF 3,000 | Scaling phase (Phase 3) |
| M3-M5 | CHF 3,000/mo | Steady state, optimize |
| M6 (June) | CHF 2,000 | Summer dip, reduce |
| M7-M8 | CHF 2,500/mo | Summer, birthday focus |
| M9 (Sep) | CHF 4,000 | Schulanfang push |
| M10 | CHF 3,000 | Normal |
| M11-M12 | CHF 6,000/mo | Christmas peak |
| **Year 1 Total** | **~CHF 39,750** | |

Target Year 1 ROAS: 3x blended = CHF 119,000 in attributed revenue from Meta Ads.

---

## Reporting and Optimization Cadence

### Daily (5 minutes)
- Check spend vs. budget
- Flag any ad with CPC > 2x target
- Pause any ad hitting frequency > 5

### Weekly (30 minutes)
- Review CPA by campaign and ad set
- Identify top 3 and bottom 3 performers
- Kill bottom performers, reallocate budget to top
- Check creative fatigue (declining CTR over 7 days)

### Monthly (2 hours)
- Full funnel analysis: impression > click > story start > story complete > purchase
- Calculate true ROAS including all attribution windows
- Refresh audience exclusions (add new converters)
- Plan next month's creative calendar
- Compare performance to benchmarks table
- Adjust budget allocation based on data

### Quarterly (half day)
- Strategic review: which campaigns justify continued investment?
- Creative library audit: what themes/angles resonate?
- Audience insights: who is actually converting? (age, gender, location, device)
- Competitor ad library review: what are competitors running?
- Plan seasonal campaigns for next quarter

---

## Creative Production Calendar

| Week | Deliverable | Format | Campaign |
|------|------------|--------|----------|
| 1 | 5 transformation images | 1080x1080, 1080x1920 | C2 |
| 1 | 2 flip-through videos | 1080x1920 (9:16) | C1, C2 |
| 2 | 5 town illustrations | 1080x1080 | C3 |
| 2 | 3 gift card visuals | 1080x1080, 1080x1920 | C4 |
| 3 | UGC collection starts | Various | C2 |
| 4 | 3 retargeting variants | 1080x1080, 1080x1920 | C5 |
| Ongoing | 2-3 new creatives/week | Mixed | All |

### Creative Asset Specifications

| Placement | Dimensions | Max File Size | Format |
|-----------|-----------|---------------|--------|
| Feed (square) | 1080x1080 | 30MB | JPG, PNG |
| Feed (landscape) | 1200x628 | 30MB | JPG, PNG |
| Stories/Reels | 1080x1920 | 30MB (image), 4GB (video) | JPG, PNG, MP4 |
| Carousel | 1080x1080 per card | 30MB per card | JPG, PNG |
| Video (Feed) | 1080x1080 or 1200x628 | 4GB | MP4, MOV |
| Video (Stories) | 1080x1920 | 4GB | MP4, MOV |

**Text limits (Meta guidelines):**
- Primary text: 125 characters (visible without "See more")
- Headline: 40 characters
- Description: 30 characters
- Keep text on image below 20% of area (Meta reduces delivery otherwise)

---

## Risk Mitigation

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| High CPA (>CHF 25) | Medium | High | Quick creative iteration, pause underperformers fast |
| Ad fatigue (CTR decline) | High | Medium | Refresh creative every 2 weeks, large creative library |
| Policy rejection (child images) | Medium | High | Use illustrated characters only in ads, never real photos |
| Seasonal budget waste | Low | Medium | Strict seasonal calendar, pause non-performing campaigns |
| Competitor copying | Medium | Low | Speed of iteration > defensibility of any single ad |
| Privacy regulation (DSG) | Low | High | Use Conversions API, consent mode, first-party data |
| iOS attribution loss | High | Medium | Server-side tracking, model-based attribution |

**Critical policy note:** Meta's advertising policies restrict the use of children's images. All ad creatives must use illustrated characters, not real photographs of children. The "before/after" creative (Type 1) should use a clearly illustrative/artistic style for the "before" as well, or show the parent's phone screen displaying the photo (indirect depiction).
