# Cheap-click plan — `Search-Cheap-CH` — 2026-09-09

Owner target (tasks/ads-reactivation-2026-09-09.md): **as many clicks as possible under CHF 0.20, then see what
converts** via `scripts/ads/attribution-report.js`. Everything below is read-only Keyword Planner data pulled on
2026-09-09 (`scripts/ads/keyword-ideas.js --seeds=… --max-cpc=0.20 --json=…`, German / Switzerland) plus GAQL reads.
**No mutate call was made; the creation script defaults to dry-run.**

## 1. Method

- Seed families probed one call each (the planner expands noun phrases and returns empty for anything else):
  age gifts boys 3–10, age gifts girls 3–10 (three phrasings), age gifts neutral, Göttikind / Göttibub / Göttimeitli /
  Patenkind, Einschulung / Schulanfang / Kindergartenstart, Geschwister / grosse Schwester / grosser Bruder,
  Kindergarten-Abschied for the child, personalised children's book. 3,220 distinct ideas with volume ≥ 10/mo.
- **Kept:** low top-of-page bid ≤ CHF 0.20, or no estimate at all (unbid = too few advertisers to price).
- **Rejected as direction traps** (recorded as negatives in §5): gift FOR the godparent (götti/gotti/gotte/pate/patin),
  gift for the teacher (kindergärtnerin, lehrerin, erzieher*), mug / craft / asking / card / money, toys and specific
  products (spielzeug, lego, schultüte inhalt, fahrrad …), baby as recipient (baby, taufe, geburt patenkind, 1. Geburtstag),
  adult godchild rites (konfirmation, firmung, kommunion, abitur, hochzeit, 18. Geburtstag), competitor / licensed /
  retailer brands. 1,058 ideas fell to these rules.
- Planner variant clusters (identical volume + bids, e.g. «geschenke für 3 jährige» ×11 spellings) were collapsed to
  one canonical keyword; PHRASE match covers the variants.
- Every landing page is a route in `client/src/App.tsx` (`/geschenk/:giftSlug`, `/anlass/:occasionSlug`) with the slug
  present in `client/src/constants/giftData.ts` / `occasionData.ts`: `geschenk-3-jahre`, `geschenk-4-jahre`,
  `geschenk-5-jahre`, `geschenk-6-jahre`, `geschenk-7-8-jahre`, `fuer-kinder`, `fuer-patenkind`, `einschulungsgeschenk`,
  `geschwisterchen`.

## 2. What the planner said per family

| Family | Verdict |
|---|---|
| Age gifts, boys + neutral 3–10 | **The only family with real volume under the cap.** Heads at CHF 0.10–0.20 low bid: «geschenke 3 jährige jungs» 390, «geschenk 4 jährige jungs» 320, «geschenke 8 jährige jungs» 320, «geschenke für jungs 6 jahre» 260, «geschenke für 7 jährige jungs» 210, «geschenke für 10 jährige jungs» 210 … Six age groups, 81 keywords, ~6,000 planner searches/mo (overlapping). |
| Age gifts, girls | **The planner refuses every `mädchen` seed for CH** — «geschenke für 5 jährige mädchen» etc. (8 seeds), «geschenk mädchen 5 jahre» (6 seeds), «geschenke für mädchen» / «…tochter» (6 seeds) returned 0, 0 and 2 rows. Re-probed with noun phrasing as instructed; still empty. The only girl terms with data anywhere in the 3,220 ideas: «mädchengeschenke 6 jahre» 50/mo CHF 0.18 and «geschenk für N jährige tochter» 10/mo unbid (N = 4–8). Those are in the age groups; the gender-neutral heads («geschenke für 4 jährige», «geschenk 5 jahre») cover girls' searches anyway. Girls' volume stays UNMEASURED, not absent. |
| Göttikind / Patenkind | **Changed since the Aug-26 measurement: the heads now carry bids above the cap** — «geschenk patenkind» 90/mo CHF 0.58–1.73, «geschenk göttikind» 20/mo CHF 0.52–2.30. «göttibub» / «göttimeitli» were not returned at all today (Aug-26: 30 / 50, unbid). Under the cap only the 10/mo unbid tail remains (patenkind + age / einschulung / weihnachten / personalisiert). 16 keywords kept, all unbid. The cluster is still structurally ours (no German competitor bids on dialect) but it is now a probe, not a volume source. |
| Einschulung / Schulanfang | **Heads above the cap:** «geschenk schulanfang» 210/mo CHF 0.42, «geschenk einschulung» 170 CHF 0.33, «geschenk schulstart» 170 CHF 0.45, «geschenk kindergartenstart» 140 CHF 0.36, «geschenk erster schultag» 50 CHF 0.41. Under the cap: «sinnvolle geschenke zur einschulung» 20 CHF 0.16, «geschenke für jungs zur einschulung» 20 CHF 0.18, plus the unbid «personalisiertes buch einschulung» tail. 12 keywords kept. |
| Kindergarten-Abschied (child) | «abschiedsgeschenk kindergarten» 480/mo is CHF 0.28 (above cap) and mostly teacher-directed; the child-directed unbid forms are kept: «kindergarten abschiedsgeschenk» 70, «abschiedsgeschenk für kindergartenkinder» 20, «geschenke zum abschied kindergarten» 20, «abschiedsgeschenk kindergarten schulkinder» 20 — 4 keywords, folded into the Einschulung group (same landing page, same moment). Teacher variants are negatives. |
| Geschwister | **Head above cap:** «geschenk geburt geschwister» 70/mo CHF 0.43; «buch grosse schwester» 40 CHF 0.35; «buch grosser bruder» 30 CHF 0.43. Under the cap: the unbid «kinderbuch / bilderbuch grosse schwester / grosser bruder», «… werden», «werdende grosse schwester» tail at 10/mo each. 11 keywords kept. The planner spells them with ß; we bid the Swiss ss form (Google treats ss/ß as close variants). |
| Personalised children's book | **Excluded from this campaign.** Every head is CHF 0.75–0.96 low bid («bilderbuch personalisiert» 880/mo, «personalisierte kinderbuch» 260 …) and the unbid 10/mo tail («individuelles kinderbuch», «bilderbuch mit namen») is PHRASE-contained in keywords Search-Deutschschweiz-v1 already bids at CHF 1.20 — the higher-ranked ad wins the auction, so a CHF 0.20 twin would never serve. |

Ungrouped cheap ideas (97, all ≤ 20/mo) were bare fragments («geschenk 5», «jungs geschenke 10») — not usable as PHRASE keywords.

## 3. Candidate keywords (all PHRASE; low bid ≤ CHF 0.20 or unbid)

### Alter-3 → `/geschenk/geschenk-3-jahre` (13 keywords, PHRASE)

| Keyword | Vol/mo | Low bid | High bid | Note |
|---|---|---|---|---|
| geschenke 3 jährige jungs | 390 | CHF 0.20 | CHF 0.95 |  |
| geschenk 3 jährig | 320 | CHF 0.13 | CHF 0.81 |  |
| geschenke für 3 jährige | 320 | CHF 0.13 | CHF 0.81 |  |
| geschenke für jungs 3 jahre | 170 | CHF 0.13 | CHF 0.93 |  |
| geschenk 3 jahre | 170 | CHF 0.10 | CHF 0.90 |  |
| geschenke 3 jährige | 170 | CHF 0.10 | CHF 0.90 |  |
| geschenke zum 3 geburtstag | 90 | CHF 0.09 | CHF 0.91 |  |
| geburtstagsgeschenk 3 jährige | 70 | CHF 0.13 | CHF 0.92 |  |
| geburtstagsgeschenk 3 jahre | 70 | CHF 0.13 | CHF 0.92 |  |
| weihnachtsgeschenk 3 jährige | 40 | unbid | – |  |
| geschenke für dreijährige | 30 | CHF 0.12 | CHF 0.83 |  |
| geschenke ab 3 jahren | 30 | CHF 0.13 | CHF 0.72 |  |
| sinnvolle geschenke 3 jährige | 20 | CHF 0.16 | CHF 0.87 |  |

_Group planner volume (overlapping variants summed): 1890/mo._

### Alter-4 → `/geschenk/geschenk-4-jahre` (15 keywords, PHRASE)

| Keyword | Vol/mo | Low bid | High bid | Note |
|---|---|---|---|---|
| geschenk 4 jährige jungs | 320 | CHF 0.16 | CHF 0.93 |  |
| geschenke für jungs 4 jahre | 210 | CHF 0.13 | CHF 0.94 |  |
| geschenk 4 jährig | 170 | CHF 0.16 | CHF 0.83 |  |
| geschenke für 4 jährige | 170 | CHF 0.16 | CHF 0.83 |  |
| geschenke für 4 jährige jungs | 140 | CHF 0.14 | CHF 0.76 |  |
| geschenk 4 jahre | 140 | CHF 0.12 | CHF 0.83 |  |
| geschenkideen 4 jährige jungs | 50 | CHF 0.12 | CHF 0.86 |  |
| geschenke zum 4 geburtstag | 50 | CHF 0.09 | CHF 0.88 |  |
| geburtstagsgeschenk 4 jährige | 30 | CHF 0.11 | CHF 0.87 |  |
| geburtstagsgeschenk 4 jahre | 30 | CHF 0.11 | CHF 0.87 |  |
| weihnachtsgeschenk 4 jährige | 30 | unbid | – |  |
| geschenkideen 4 jährige | 20 | CHF 0.11 | CHF 0.68 |  |
| geschenke für vierjährige | 20 | CHF 0.06 | CHF 0.79 |  |
| geschenk ab 4 jahren | 20 | CHF 0.09 | CHF 0.84 |  |
| geschenk für 4 jährige tochter | 10 | unbid | – |  |

_Group planner volume (overlapping variants summed): 1410/mo._

### Alter-5 → `/geschenk/geschenk-5-jahre` (14 keywords, PHRASE)

| Keyword | Vol/mo | Low bid | High bid | Note |
|---|---|---|---|---|
| geschenke für jungs 5 jahre | 210 | CHF 0.17 | CHF 0.94 |  |
| geschenk für 5 jährige jungs | 110 | CHF 0.18 | CHF 0.90 |  |
| sinnvolles geschenk für 5 jährige jungs | 110 | CHF 0.19 | CHF 0.98 |  |
| geschenke für 5 jährige | 110 | CHF 0.17 | CHF 0.97 |  |
| geschenk für 5 jährige | 110 | CHF 0.17 | CHF 0.97 |  |
| geschenk 5 jahre | 90 | CHF 0.15 | CHF 0.92 |  |
| geschenke 5 jährige | 90 | CHF 0.15 | CHF 0.92 |  |
| geschenke zum 5 geburtstag | 40 | CHF 0.15 | CHF 0.86 |  |
| weihnachtsgeschenk 5 jährige | 30 | unbid | – |  |
| geschenkideen 5 jährige | 20 | unbid | – |  |
| geburtstagsgeschenk 5 jährige | 20 | CHF 0.12 | CHF 0.87 |  |
| geburtstagsgeschenk 5 jahre | 20 | CHF 0.12 | CHF 0.87 |  |
| geschenk ab 5 jahre | 20 | unbid | – |  |
| geschenk für 5 jährige tochter | 10 | unbid | – |  |

_Group planner volume (overlapping variants summed): 990/mo._

### Alter-6 → `/geschenk/geschenk-6-jahre` (13 keywords, PHRASE)

| Keyword | Vol/mo | Low bid | High bid | Note |
|---|---|---|---|---|
| geschenke für jungs 6 jahre | 260 | CHF 0.16 | CHF 0.99 |  |
| kindergeschenke 6 jahre | 170 | CHF 0.14 | CHF 0.89 |  |
| geschenke 6 jährige | 110 | CHF 0.15 | CHF 1.06 |  |
| geschenk 6 jahre | 110 | CHF 0.15 | CHF 1.06 |  |
| sinnvolles geschenk für 6 jährigen | 70 | CHF 0.18 | CHF 1.14 |  |
| mädchengeschenke 6 jahre | 50 | CHF 0.18 | CHF 0.88 |  |
| geschenke zum 6 geburtstag | 30 | CHF 0.10 | CHF 0.92 |  |
| geburtstagsgeschenk 6 jährige | 20 | CHF 0.06 | CHF 1.14 |  |
| geburtstagsgeschenk 6 jahre | 20 | CHF 0.06 | CHF 1.14 |  |
| geschenk für 6 jährigen | 20 | CHF 0.18 | CHF 0.85 |  |
| geschenke kindergeburtstag 6 jahre | 20 | unbid | – |  |
| sinnvolle geschenke für 6 jährige jungs | 20 | unbid | – |  |
| geschenk für 6 jährige tochter | 10 | unbid | – |  |

_Group planner volume (overlapping variants summed): 910/mo._

### Alter-7-8 → `/geschenk/geschenk-7-8-jahre` (16 keywords, PHRASE)

| Keyword | Vol/mo | Low bid | High bid | Note |
|---|---|---|---|---|
| geschenke 8 jährige jungs | 320 | CHF 0.20 | CHF 0.91 |  |
| geschenke für 7 jährige jungs | 210 | CHF 0.18 | CHF 0.91 |  |
| sinnvolle geschenke für 8 jährige jungs | 90 | unbid | – |  |
| geschenke 7 jährige | 70 | CHF 0.19 | CHF 0.95 |  |
| geschenk 7 jahre | 70 | CHF 0.19 | CHF 0.95 |  |
| coole geschenke für 7 jährige | 50 | unbid | – |  |
| geschenke 8 jährige | 50 | CHF 0.20 | CHF 1.15 |  |
| geschenk 8 jahre | 50 | CHF 0.20 | CHF 1.15 |  |
| geschenke für jungs ab 8 | 30 | unbid | – |  |
| geschenk 7 jähriger | 30 | unbid | – |  |
| sinnvolle geschenke für 8 jährige | 20 | unbid | – |  |
| geschenke zum 7 geburtstag | 20 | unbid | – |  |
| geschenkideen 7 jährige jungs | 20 | CHF 0.13 | CHF 0.91 |  |
| geburtstagsgeschenk 7 jährige | 20 | CHF 0.11 | CHF 0.83 |  |
| geschenk für 7 jährige tochter | 10 | unbid | – |  |
| geschenk für 8 jährige tochter | 10 | unbid | – |  |

_Group planner volume (overlapping variants summed): 1070/mo._

### Alter-9-10 → `/geschenk/fuer-kinder` (10 keywords, PHRASE)

| Keyword | Vol/mo | Low bid | High bid | Note |
|---|---|---|---|---|
| geschenke für 10 jährige jungs | 210 | CHF 0.19 | CHF 1.10 |  |
| geschenke für jungs ab 10 | 90 | CHF 0.20 | CHF 0.86 |  |
| sinnvolle geschenke für 9 jährige | 90 | CHF 0.18 | CHF 0.80 |  |
| sinnvolle geschenke für 9 jährige jungs | 70 | CHF 0.12 | CHF 0.96 |  |
| geschenk 10 jährige | 50 | unbid | – |  |
| geschenke jungs 10 jahre | 50 | unbid | – |  |
| coole geschenke für 10 jährige jungs | 50 | CHF 0.05 | CHF 1.04 |  |
| geschenkideen 9 jährige jungs | 20 | unbid | – |  |
| geburtstagsgeschenk 10 jährige | 20 | unbid | – |  |
| coole geschenke für 9 jährige jungs | 20 | unbid | – |  |

_Group planner volume (overlapping variants summed): 670/mo._

### Goettikind → `/geschenk/fuer-patenkind` (16 keywords, PHRASE)

| Keyword | Vol/mo | Low bid | High bid | Note |
|---|---|---|---|---|
| göttikind geschenk | 10 | unbid | – |  |
| göttibub geschenk | – | – | – | not returned by the planner today; Aug-26 measurement göttibub 30 / göttimeitli 50 per month, unbid — kept as a Swiss-dialect probe at no cost |
| göttimeitli geschenk | – | – | – | not returned by the planner today; Aug-26 measurement göttibub 30 / göttimeitli 50 per month, unbid — kept as a Swiss-dialect probe at no cost |
| geschenk patenkind 3 jahre | 10 | unbid | – |  |
| geschenk patenkind 4 jahre | 10 | unbid | – |  |
| geschenk patenkind 6 jahre | 10 | unbid | – |  |
| geschenk patenkind schulanfang | 10 | unbid | – |  |
| patenkind geschenk einschulung | 10 | unbid | – |  |
| patenkind kindergarten geschenk | 10 | unbid | – |  |
| geburtstagsgeschenk patenkind | 10 | unbid | – |  |
| personalisierte geschenke patenkind | 10 | unbid | – |  |
| persönliches geschenk patenkind | 10 | unbid | – |  |
| personalisiertes buch patenkind | 10 | unbid | – |  |
| geschenkideen patenkind | 10 | unbid | – |  |
| weihnachtsgeschenk patenkind | 10 | unbid | – |  |
| kreatives geschenk patenkind | 10 | unbid | – |  |

_Group planner volume (overlapping variants summed): 140/mo._

### Einschulung → `/geschenk/einschulungsgeschenk` (16 keywords, PHRASE)

| Keyword | Vol/mo | Low bid | High bid | Note |
|---|---|---|---|---|
| sinnvolle geschenke zur einschulung | 20 | CHF 0.16 | CHF 1.17 |  |
| geschenke für jungs zur einschulung | 20 | CHF 0.18 | CHF 1.04 |  |
| personalisiertes buch einschulung | 10 | unbid | – |  |
| buch zur einschulung | 10 | unbid | – |  |
| personalisiertes kinderbuch einschulung | 10 | unbid | – |  |
| personalisierte einschulungsgeschenke | 10 | unbid | – |  |
| geschenkideen zur einschulung | 10 | unbid | – |  |
| schulanfangsgeschenke | 10 | unbid | – |  |
| geschenke für schulanfänger jungs | 10 | unbid | – |  |
| personalisiertes buch schulkind | 10 | unbid | – |  |
| coole geschenke zur einschulung | 10 | unbid | – |  |
| kleinigkeit zur einschulung | 10 | unbid | – |  |
| kindergarten abschiedsgeschenk | 70 | unbid | – |  |
| abschiedsgeschenk für kindergartenkinder | 20 | unbid | – |  |
| geschenke zum abschied kindergarten | 20 | unbid | – |  |
| abschiedsgeschenk kindergarten schulkinder | 20 | unbid | – |  |

_Group planner volume (overlapping variants summed): 270/mo._

### Geschwisterkind → `/anlass/geschwisterchen` (11 keywords, PHRASE)

| Keyword | Vol/mo | Low bid | High bid | Note |
|---|---|---|---|---|
| kinderbuch grosse schwester | 10 | unbid | – | planner row is «kinderbuch große schwester»; bid on the Swiss ss form |
| kinderbuch grosser bruder | 10 | unbid | – | planner row is «kinderbuch großer bruder»; bid on the Swiss ss form |
| bilderbuch grosse schwester | 10 | unbid | – | planner row is «bilderbuch große schwester»; bid on the Swiss ss form |
| bilderbuch grosser bruder | 10 | unbid | – | planner row is «bilderbuch großer bruder»; bid on the Swiss ss form |
| buch grosse schwester werden | 10 | unbid | – | planner row is «buch große schwester werden»; bid on the Swiss ss form |
| buch grosser bruder werden | 10 | unbid | – | planner row is «buch großer bruder werden»; bid on the Swiss ss form |
| geschenk für werdende grosse schwester | 10 | unbid | – | planner row is «geschenk für werdende große schwester»; bid on the Swiss ss form |
| geschenke für werdende geschwister | 10 | unbid | – |  |
| ich werde grosse schwester buch | 10 | unbid | – | planner row is «ich werde große schwester buch»; bid on the Swiss ss form |
| buch ich werde grosser bruder | 10 | unbid | – | planner row is «buch ich werde großer bruder»; bid on the Swiss ss form |
| einschulung geschenk geschwisterkind | 10 | unbid | – |  |

_Group planner volume (overlapping variants summed): 110/mo._

TOTAL 124 keywords, 64 unbid, planner volume 7460/mo

**Totals: 124 keywords in 9 ad groups — 60 with a measured low bid of CHF 0.05–0.20, 62 unbid (no estimate), 2 not
returned today (göttibub / göttimeitli, kept from the Aug-26 measurement). Planner volume 7,460 searches/mo, of which
~6,000 in the six age groups (variants overlap, so the distinct-query volume is lower — roughly 4,000–5,000/mo).**

## 4. Proposed campaign `Search-Cheap-CH`

- SEARCH, **status PAUSED at creation** (owner activates in the UI), budget **CHF 5/day** (own budget
  `Search-Cheap-CH-Budget`), **MANUAL_CPC, enhanced CPC off**, every ad group **max CPC CHF 0.20**.
- Geo: **read at runtime from Search-Deutschschweiz-v1** — the dry-run resolved 19 regions: Aargau, Appenzell
  Innerrhoden, Appenzell Ausserrhoden, Bern, Basel-Landschaft, Basel-Stadt, Glarus, Graubünden, Luzern, Nidwalden,
  Obwalden, St. Gallen, Schaffhausen, Solothurn, Schwyz, Thurgau, Uri, Zug, Zürich. Language German (1001).
- **No device bid modifiers** (the audit flagged the −30 % mobile modifier on the main campaign as self-inflicted rank loss
  at 75 % lost-to-rank; a CHF 0.20 campaign cannot afford another −30 %).
- Network: Google Search + search partners, no Display (same as the main campaign).
- Final URL per group: `https://magicalstory.ch{landing}?utm_source=google&utm_medium=search&utm_campaign=cheap-ch&utm_term={keyword}`
  — `{keyword}` is ValueTrack, so `trial_events.utm_term` → `attribution-report.js` attributes per keyword (the missing
  piece noted in the funnel memory).
- Ad groups (keywords in §3), one RSA each, 15 headlines / 4 descriptions, no pins, all lengths validated by the
  script (≤ 30 / ≤ 90, ss not ß, no quotes):

| Ad group | Landing page | Keywords | Keyword-mirroring headlines |
|---|---|---|---|
| Alter-3 | `/geschenk/geschenk-3-jahre` | 13 | Geschenk für 3-Jährige · Geschenkidee 3 Jahre · Geburtstagsgeschenk 3 Jahre · Sinnvolles Geschenk 3 Jahre |
| Alter-4 | `/geschenk/geschenk-4-jahre` | 15 | same pattern, 4 Jahre |
| Alter-5 | `/geschenk/geschenk-5-jahre` | 14 | same pattern, 5 Jahre |
| Alter-6 | `/geschenk/geschenk-6-jahre` | 13 | same pattern, 6 Jahre |
| Alter-7-8 | `/geschenk/geschenk-7-8-jahre` | 16 | Geschenk für 7- und 8-Jährige · Geschenkidee 7–8 Jahre · … |
| Alter-9-10 | `/geschenk/fuer-kinder` (no age page exists for 9–10) | 10 | Geschenk für 9- und 10-Jährige · … |
| Goettikind | `/geschenk/fuer-patenkind` | 16 | Geschenk fürs Göttikind · Geschenk fürs Patenkind · Göttibub oder Göttimeitli · Dein Göttikind als Held · Nur für dein Göttikind |
| Einschulung | `/geschenk/einschulungsgeschenk` | 16 | Geschenk zur Einschulung · Einschulungsgeschenk · Geschenk zum Schulanfang · Buch zur Einschulung · Dein Schulkind als Held |
| Geschwisterkind | `/anlass/geschwisterchen` | 11 | Buch für die grosse Schwester · Buch für den grossen Bruder · Geschenk fürs Geschwisterkind · Grosse Schwester werden · Grosser Bruder werden |

Shared proof-point headlines across all groups (each verified against site copy in the audit): Personalisiertes
Kinderbuch · Dein Kind, die Hauptfigur · Mit Foto deines Kindes · Mehr als Spielzeug · Erste Geschichte gratis · In 3
Minuten erstellt · Gedruckt in der Schweiz · Für Jungs und Mädchen · Nur für dein Kind gemacht · Ab CHF 5 starten ·
Jedes Kind hat eine Geschichte. Full text per group is in the dry-run output (§8).

## 5. Negatives (campaign level, 101)

The main campaign's 12 + the audit's 7 (B3b) + the direction traps measured for these families:

- **Gift FOR the godparent:** `götti geschenk` (PHRASE), `geschenk für götti` (PHRASE), `gotti geschenk` (PHRASE),
  `geschenk für gotti` (PHRASE), gotte, pate, paten, patin, patentante, patenonkel, taufpate.
- **Gift for the teacher:** kindergärtnerin, lehrerin, lehrer, erzieherin, erzieher, kita team, kindergarten team, tagesmutter.
- **Mug / craft / asking / card / money / rites:** tasse, basteln, bastelidee, fragen, glückwünsche, sprüche, spruch, gedicht,
  karte, geld, geldgeschenk, wieviel, konfirmation, firmung, kommunion, abitur, matura, hochzeit, führerschein,
  `18 geburtstag` (PHRASE).
- **Baby as recipient:** baby, taufe, taufgeschenk, neugeborene, `1 geburtstag` (PHRASE), `erster geburtstag` (PHRASE).
- **Specific products, not a book:** spielzeug, spielzeuge, spielsachen, lego, playmobil, puzzle, kuscheltier, fahrrad, velo,
  laufrad, trottinett, tonies, tonie, schultüte, schultüten, inhalt, gastgeschenk, gastgeschenke, fotoalbum, montessori,
  outdoor, fussball, fußball, einhorn, kleidung, gymnasium.
- **Competitor / licensed / retailer:** peppa, bibi und tina, feuerwehrmann sam, lausemaus, tchibo, etsy, amazon, galaxus,
  manor, migros, coop (+ the inherited librio, globi, pixastory, conni, paw patrol, elsa, bubbleboo, little yeti, wonderbly,
  eiskönigin, kinderbibel, freundebuch, kleinauflage, `drucken lassen`, pappbilderbuch, ausmalbuch, wimmelbuch, kostenlos,
  selber basteln).

Not negated on purpose: `geburt` (would block the Geschwister group's own occasion), `weihnachten` / `ostern` (seasonal
gifts for the child are valid intent and several kept keywords carry them), `mädchen` / `tochter`.

## 6. Expected clicks at CHF 0.20

Honest estimate, not a promise. Inputs: ~4,000–5,000 distinct searches/mo in scope (§3), a CHF 0.20 cap that sits at
or below the LOW top-of-page estimate for most heads (so the ad mostly serves below the top positions — expect
10–20 % impression share), and a CTR of 1.5–3 % for a book ad on generic gift queries (the main campaign gets 7 % on
product-intent terms; generic gift terms will not).

- Impressions: ~500–1,000/mo · **Clicks: ~15–45/mo** · avg CPC ~CHF 0.12–0.18 · **spend ~CHF 2–8/mo**.
- The CHF 5/day budget will not bind; the constraint is the bid. If impression share comes back near zero after a
  week, the lever is the cap (0.25–0.30), not the budget.
- At the account's historical 1.2 % click→trial rate that is 0–1 trial completion per month, so «see what converts»
  needs patience: ~CHF 30–50 and 3–6 months before any keyword-level read is meaningful. Read it with
  `node scripts/ads/attribution-report.js --days=90` (utm_term arrives once the S4 attribution commit is on production).

## 7. Above-cap heads recorded for the owner (not proposed — they fail the CHF 0.20 rule)

| Family | Keyword | Vol/mo | Low–high bid |
|---|---|---|---|
| Alter-6 | geschenke 6 jährige jungs | 390 | CHF 0.27–0.96 |
| Alter-7-8 | geschenke jungs 8 jahre | 320 | CHF 0.20–0.92 (low is 0.204, just above) |
| Alter-9-10 | jungs 10 jahre geschenk | 320 | CHF 0.22–0.92 |
| Alter-7-8 | geschenke für jungs 7 jahre | 260 | CHF 0.23–1.03 |
| Alter-9-10 | geschenke jungs 9 jahre | 210 | CHF 0.26–0.95 |
| Einschulung | geschenk schulanfang | 210 | CHF 0.42–1.35 |
| Einschulung | geschenk einschulung | 170 | CHF 0.33–1.13 |
| Einschulung | geschenk schulstart | 170 | CHF 0.45–1.39 |
| Kindergarten | abschiedsgeschenk kindergarten | 480 | CHF 0.28–1.15 (mostly teacher) |
| Kindergarten | geschenk kindergartenstart | 140 | CHF 0.36–0.93 |
| Göttikind | geschenk patenkind | 90 | CHF 0.58–1.73 |
| Göttikind | geschenk göttikind | 20 | CHF 0.52–2.30 |
| Geschwister | geschenk geburt geschwister | 70 | CHF 0.43–1.03 |
| Geschwister | buch grosse schwester | 40 | CHF 0.35–1.28 |
| Buch | bilderbuch personalisiert | 880 | CHF 0.83–3.27 (in the main campaign) |

If the owner later raises the cap to CHF 0.30, the first five rows (~1,500/mo) and both Geschwister book heads come
into range; the Einschulung / Göttikind heads need ≥ CHF 0.45 / 0.60.

## 8. Dry-run output 2026-09-09

`node scripts/ads/create-search-cheap.js` (dry-run default; `--apply` never passed; idempotent by campaign / budget /
ad-group / keyword / RSA / negative name). The length validator corrected five descriptions that were over 90 chars in
the first draft.

```
Campaign: Search-Cheap-CH
Mode: DRY-RUN — nothing is sent (pass --apply to execute)

Geo (from Search-Deutschschweiz-v1, 19 regions): Aargau, Appenzell Innerrhoden, Appenzell Ausserrhoden, Canton of Bern, Basel-Landschaft, Basel City, Glarus, Grisons, Lucerne, Nidwalden, Obwalden, St. Gallen, Schaffhausen, Solothurn, Schwyz, Thurgau, Uri, Zug, Zurich

━━━ 1. Budget + campaign
  [DRY] campaign_budgets.create Search-Cheap-CH-Budget
    amount_micros=5000000 (CHF 5.00/day) delivery_method=STANDARD explicitly_shared=false
  [DRY] campaigns.create Search-Cheap-CH
    status=PAUSED channel=SEARCH bidding=MANUAL_CPC enhanced_cpc=false
    budget=[NEW budget Search-Cheap-CH-Budget]
    network: google search + search partners, no display

━━━ 2. Geo + language criteria
  [DRY] campaign_criteria.create ×19 locations
    geoTargetConstants/20126 (Aargau)
    geoTargetConstants/20127 (Appenzell Innerrhoden)
    geoTargetConstants/20128 (Appenzell Ausserrhoden)
    geoTargetConstants/20129 (Canton of Bern)
    geoTargetConstants/20130 (Basel-Landschaft)
    geoTargetConstants/20131 (Basel City)
    geoTargetConstants/20134 (Glarus)
    geoTargetConstants/20135 (Grisons)
    geoTargetConstants/20137 (Lucerne)
    geoTargetConstants/20139 (Nidwalden)
    geoTargetConstants/20140 (Obwalden)
    geoTargetConstants/20141 (St. Gallen)
    geoTargetConstants/20142 (Schaffhausen)
    geoTargetConstants/20143 (Solothurn)
    geoTargetConstants/20144 (Schwyz)
    geoTargetConstants/20145 (Thurgau)
    geoTargetConstants/20147 (Uri)
    geoTargetConstants/20150 (Zug)
    geoTargetConstants/20151 (Zurich)
  [DRY] campaign_criteria.create language
    languageConstants/1001 (German)

━━━ 3. Ad group Alter-3 → https://magicalstory.ch/geschenk/geschenk-3-jahre (13 keywords)
  [DRY] ad_groups.create Alter-3
    campaign=[NEW campaign Search-Cheap-CH] status=ENABLED type=SEARCH_STANDARD cpc_bid_micros=200000 (CHF 0.20)
  [DRY] ad_group_criteria.create ×13 keywords in Alter-3
    [PHRASE] "geschenke 3 jährige jungs"
    [PHRASE] "geschenk 3 jährig"
    [PHRASE] "geschenke für 3 jährige"
    [PHRASE] "geschenke für jungs 3 jahre"
    [PHRASE] "geschenk 3 jahre"
    [PHRASE] "geschenke 3 jährige"
    [PHRASE] "geschenke zum 3 geburtstag"
    [PHRASE] "geburtstagsgeschenk 3 jährige"
    [PHRASE] "geburtstagsgeschenk 3 jahre"
    [PHRASE] "weihnachtsgeschenk 3 jährige"
    [PHRASE] "geschenke für dreijährige"
    [PHRASE] "geschenke ab 3 jahren"
    [PHRASE] "sinnvolle geschenke 3 jährige"
  [DRY] ad_group_ads.create RSA in Alter-3
    ad_group=[NEW ad_group Alter-3] status=ENABLED final_urls=[https://magicalstory.ch/geschenk/geschenk-3-jahre?utm_source=google&utm_medium=search&utm_campaign=cheap-ch&utm_term={keyword}] path=/Geschenk/3-Jahre
    H 1: Geschenk für 3-Jährige (22)
    H 2: Geschenkidee 3 Jahre (20)
    H 3: Geburtstagsgeschenk 3 Jahre (27)
    H 4: Sinnvolles Geschenk 3 Jahre (27)
    H 5: Personalisiertes Kinderbuch (27)
    H 6: Dein Kind, die Hauptfigur (25)
    H 7: Mit Foto deines Kindes (22)
    H 8: Mehr als Spielzeug (18)
    H 9: Erste Geschichte gratis (23)
    H10: In 3 Minuten erstellt (21)
    H11: Gedruckt in der Schweiz (23)
    H12: Für Jungs und Mädchen (21)
    H13: Nur für dein Kind gemacht (25)
    H14: Ab CHF 5 starten (16)
    H15: Jedes Kind hat eine Geschichte (30)
    D1: Ein Kinderbuch, in dem dein Kind (3 Jahre) der Held ist. Foto rein, fertig. (75)
    D2: Kein Spielzeug, das nach einer Woche vergessen ist: eine Geschichte nur über dein Kind. (87)
    D3: Erste Geschichte gratis testen. Als PDF sofort oder gedruckt in der Schweiz nach Hause. (87)
    D4: Personalisiertes Geschenk für Jungs und Mädchen. Dein Kind als Hauptfigur, in 3 Minuten. (88)

━━━ 3. Ad group Alter-4 → https://magicalstory.ch/geschenk/geschenk-4-jahre (15 keywords)
  [DRY] ad_groups.create Alter-4
    campaign=[NEW campaign Search-Cheap-CH] status=ENABLED type=SEARCH_STANDARD cpc_bid_micros=200000 (CHF 0.20)
  [DRY] ad_group_criteria.create ×15 keywords in Alter-4
    [PHRASE] "geschenk 4 jährige jungs"
    [PHRASE] "geschenke für jungs 4 jahre"
    [PHRASE] "geschenk 4 jährig"
    [PHRASE] "geschenke für 4 jährige"
    [PHRASE] "geschenke für 4 jährige jungs"
    [PHRASE] "geschenk 4 jahre"
    [PHRASE] "geschenkideen 4 jährige jungs"
    [PHRASE] "geschenke zum 4 geburtstag"
    [PHRASE] "geburtstagsgeschenk 4 jährige"
    [PHRASE] "geburtstagsgeschenk 4 jahre"
    [PHRASE] "weihnachtsgeschenk 4 jährige"
    [PHRASE] "geschenkideen 4 jährige"
    [PHRASE] "geschenke für vierjährige"
    [PHRASE] "geschenk ab 4 jahren"
    [PHRASE] "geschenk für 4 jährige tochter"
  [DRY] ad_group_ads.create RSA in Alter-4
    ad_group=[NEW ad_group Alter-4] status=ENABLED final_urls=[https://magicalstory.ch/geschenk/geschenk-4-jahre?utm_source=google&utm_medium=search&utm_campaign=cheap-ch&utm_term={keyword}] path=/Geschenk/4-Jahre
    H 1: Geschenk für 4-Jährige (22)
    H 2: Geschenkidee 4 Jahre (20)
    H 3: Geburtstagsgeschenk 4 Jahre (27)
    H 4: Sinnvolles Geschenk 4 Jahre (27)
    H 5: Personalisiertes Kinderbuch (27)
    H 6: Dein Kind, die Hauptfigur (25)
    H 7: Mit Foto deines Kindes (22)
    H 8: Mehr als Spielzeug (18)
    H 9: Erste Geschichte gratis (23)
    H10: In 3 Minuten erstellt (21)
    H11: Gedruckt in der Schweiz (23)
    H12: Für Jungs und Mädchen (21)
    H13: Nur für dein Kind gemacht (25)
    H14: Ab CHF 5 starten (16)
    H15: Jedes Kind hat eine Geschichte (30)
    D1: Ein Kinderbuch, in dem dein Kind (4 Jahre) der Held ist. Foto rein, fertig. (75)
    D2: Kein Spielzeug, das nach einer Woche vergessen ist: eine Geschichte nur über dein Kind. (87)
    D3: Erste Geschichte gratis testen. Als PDF sofort oder gedruckt in der Schweiz nach Hause. (87)
    D4: Personalisiertes Geschenk für Jungs und Mädchen. Dein Kind als Hauptfigur, in 3 Minuten. (88)

━━━ 3. Ad group Alter-5 → https://magicalstory.ch/geschenk/geschenk-5-jahre (14 keywords)
  [DRY] ad_groups.create Alter-5
    campaign=[NEW campaign Search-Cheap-CH] status=ENABLED type=SEARCH_STANDARD cpc_bid_micros=200000 (CHF 0.20)
  [DRY] ad_group_criteria.create ×14 keywords in Alter-5
    [PHRASE] "geschenke für jungs 5 jahre"
    [PHRASE] "geschenk für 5 jährige jungs"
    [PHRASE] "sinnvolles geschenk für 5 jährige jungs"
    [PHRASE] "geschenke für 5 jährige"
    [PHRASE] "geschenk für 5 jährige"
    [PHRASE] "geschenk 5 jahre"
    [PHRASE] "geschenke 5 jährige"
    [PHRASE] "geschenke zum 5 geburtstag"
    [PHRASE] "weihnachtsgeschenk 5 jährige"
    [PHRASE] "geschenkideen 5 jährige"
    [PHRASE] "geburtstagsgeschenk 5 jährige"
    [PHRASE] "geburtstagsgeschenk 5 jahre"
    [PHRASE] "geschenk ab 5 jahre"
    [PHRASE] "geschenk für 5 jährige tochter"
  [DRY] ad_group_ads.create RSA in Alter-5
    ad_group=[NEW ad_group Alter-5] status=ENABLED final_urls=[https://magicalstory.ch/geschenk/geschenk-5-jahre?utm_source=google&utm_medium=search&utm_campaign=cheap-ch&utm_term={keyword}] path=/Geschenk/5-Jahre
    H 1: Geschenk für 5-Jährige (22)
    H 2: Geschenkidee 5 Jahre (20)
    H 3: Geburtstagsgeschenk 5 Jahre (27)
    H 4: Sinnvolles Geschenk 5 Jahre (27)
    H 5: Personalisiertes Kinderbuch (27)
    H 6: Dein Kind, die Hauptfigur (25)
    H 7: Mit Foto deines Kindes (22)
    H 8: Mehr als Spielzeug (18)
    H 9: Erste Geschichte gratis (23)
    H10: In 3 Minuten erstellt (21)
    H11: Gedruckt in der Schweiz (23)
    H12: Für Jungs und Mädchen (21)
    H13: Nur für dein Kind gemacht (25)
    H14: Ab CHF 5 starten (16)
    H15: Jedes Kind hat eine Geschichte (30)
    D1: Ein Kinderbuch, in dem dein Kind (5 Jahre) der Held ist. Foto rein, fertig. (75)
    D2: Kein Spielzeug, das nach einer Woche vergessen ist: eine Geschichte nur über dein Kind. (87)
    D3: Erste Geschichte gratis testen. Als PDF sofort oder gedruckt in der Schweiz nach Hause. (87)
    D4: Personalisiertes Geschenk für Jungs und Mädchen. Dein Kind als Hauptfigur, in 3 Minuten. (88)

━━━ 3. Ad group Alter-6 → https://magicalstory.ch/geschenk/geschenk-6-jahre (13 keywords)
  [DRY] ad_groups.create Alter-6
    campaign=[NEW campaign Search-Cheap-CH] status=ENABLED type=SEARCH_STANDARD cpc_bid_micros=200000 (CHF 0.20)
  [DRY] ad_group_criteria.create ×13 keywords in Alter-6
    [PHRASE] "geschenke für jungs 6 jahre"
    [PHRASE] "kindergeschenke 6 jahre"
    [PHRASE] "geschenke 6 jährige"
    [PHRASE] "geschenk 6 jahre"
    [PHRASE] "sinnvolles geschenk für 6 jährigen"
    [PHRASE] "mädchengeschenke 6 jahre"
    [PHRASE] "geschenke zum 6 geburtstag"
    [PHRASE] "geburtstagsgeschenk 6 jährige"
    [PHRASE] "geburtstagsgeschenk 6 jahre"
    [PHRASE] "geschenk für 6 jährigen"
    [PHRASE] "geschenke kindergeburtstag 6 jahre"
    [PHRASE] "sinnvolle geschenke für 6 jährige jungs"
    [PHRASE] "geschenk für 6 jährige tochter"
  [DRY] ad_group_ads.create RSA in Alter-6
    ad_group=[NEW ad_group Alter-6] status=ENABLED final_urls=[https://magicalstory.ch/geschenk/geschenk-6-jahre?utm_source=google&utm_medium=search&utm_campaign=cheap-ch&utm_term={keyword}] path=/Geschenk/6-Jahre
    H 1: Geschenk für 6-Jährige (22)
    H 2: Geschenkidee 6 Jahre (20)
    H 3: Geburtstagsgeschenk 6 Jahre (27)
    H 4: Sinnvolles Geschenk 6 Jahre (27)
    H 5: Personalisiertes Kinderbuch (27)
    H 6: Dein Kind, die Hauptfigur (25)
    H 7: Mit Foto deines Kindes (22)
    H 8: Mehr als Spielzeug (18)
    H 9: Erste Geschichte gratis (23)
    H10: In 3 Minuten erstellt (21)
    H11: Gedruckt in der Schweiz (23)
    H12: Für Jungs und Mädchen (21)
    H13: Nur für dein Kind gemacht (25)
    H14: Ab CHF 5 starten (16)
    H15: Jedes Kind hat eine Geschichte (30)
    D1: Ein Kinderbuch, in dem dein Kind (6 Jahre) der Held ist. Foto rein, fertig. (75)
    D2: Kein Spielzeug, das nach einer Woche vergessen ist: eine Geschichte nur über dein Kind. (87)
    D3: Erste Geschichte gratis testen. Als PDF sofort oder gedruckt in der Schweiz nach Hause. (87)
    D4: Personalisiertes Geschenk für Jungs und Mädchen. Dein Kind als Hauptfigur, in 3 Minuten. (88)

━━━ 3. Ad group Alter-7-8 → https://magicalstory.ch/geschenk/geschenk-7-8-jahre (16 keywords)
  [DRY] ad_groups.create Alter-7-8
    campaign=[NEW campaign Search-Cheap-CH] status=ENABLED type=SEARCH_STANDARD cpc_bid_micros=200000 (CHF 0.20)
  [DRY] ad_group_criteria.create ×16 keywords in Alter-7-8
    [PHRASE] "geschenke 8 jährige jungs"
    [PHRASE] "geschenke für 7 jährige jungs"
    [PHRASE] "sinnvolle geschenke für 8 jährige jungs"
    [PHRASE] "geschenke 7 jährige"
    [PHRASE] "geschenk 7 jahre"
    [PHRASE] "coole geschenke für 7 jährige"
    [PHRASE] "geschenke 8 jährige"
    [PHRASE] "geschenk 8 jahre"
    [PHRASE] "geschenke für jungs ab 8"
    [PHRASE] "geschenk 7 jähriger"
    [PHRASE] "sinnvolle geschenke für 8 jährige"
    [PHRASE] "geschenke zum 7 geburtstag"
    [PHRASE] "geschenkideen 7 jährige jungs"
    [PHRASE] "geburtstagsgeschenk 7 jährige"
    [PHRASE] "geschenk für 7 jährige tochter"
    [PHRASE] "geschenk für 8 jährige tochter"
  [DRY] ad_group_ads.create RSA in Alter-7-8
    ad_group=[NEW ad_group Alter-7-8] status=ENABLED final_urls=[https://magicalstory.ch/geschenk/geschenk-7-8-jahre?utm_source=google&utm_medium=search&utm_campaign=cheap-ch&utm_term={keyword}] path=/Geschenk/7-8-Jahre
    H 1: Geschenk für 7- und 8-Jährige (29)
    H 2: Geschenkidee 7–8 Jahre (22)
    H 3: Geburtstagsgeschenk 7–8 Jahre (29)
    H 4: Sinnvolles Geschenk 7–8 Jahre (29)
    H 5: Personalisiertes Kinderbuch (27)
    H 6: Dein Kind, die Hauptfigur (25)
    H 7: Mit Foto deines Kindes (22)
    H 8: Mehr als Spielzeug (18)
    H 9: Erste Geschichte gratis (23)
    H10: In 3 Minuten erstellt (21)
    H11: Gedruckt in der Schweiz (23)
    H12: Für Jungs und Mädchen (21)
    H13: Nur für dein Kind gemacht (25)
    H14: Ab CHF 5 starten (16)
    H15: Jedes Kind hat eine Geschichte (30)
    D1: Ein Kinderbuch, in dem dein Kind (7–8 Jahre) der Held ist. Foto rein, fertig. (77)
    D2: Kein Spielzeug, das nach einer Woche vergessen ist: eine Geschichte nur über dein Kind. (87)
    D3: Erste Geschichte gratis testen. Als PDF sofort oder gedruckt in der Schweiz nach Hause. (87)
    D4: Personalisiertes Geschenk für Jungs und Mädchen. Dein Kind als Hauptfigur, in 3 Minuten. (88)

━━━ 3. Ad group Alter-9-10 → https://magicalstory.ch/geschenk/fuer-kinder (10 keywords)
  [DRY] ad_groups.create Alter-9-10
    campaign=[NEW campaign Search-Cheap-CH] status=ENABLED type=SEARCH_STANDARD cpc_bid_micros=200000 (CHF 0.20)
  [DRY] ad_group_criteria.create ×10 keywords in Alter-9-10
    [PHRASE] "geschenke für 10 jährige jungs"
    [PHRASE] "geschenke für jungs ab 10"
    [PHRASE] "sinnvolle geschenke für 9 jährige"
    [PHRASE] "sinnvolle geschenke für 9 jährige jungs"
    [PHRASE] "geschenk 10 jährige"
    [PHRASE] "geschenke jungs 10 jahre"
    [PHRASE] "coole geschenke für 10 jährige jungs"
    [PHRASE] "geschenkideen 9 jährige jungs"
    [PHRASE] "geburtstagsgeschenk 10 jährige"
    [PHRASE] "coole geschenke für 9 jährige jungs"
  [DRY] ad_group_ads.create RSA in Alter-9-10
    ad_group=[NEW ad_group Alter-9-10] status=ENABLED final_urls=[https://magicalstory.ch/geschenk/fuer-kinder?utm_source=google&utm_medium=search&utm_campaign=cheap-ch&utm_term={keyword}] path=/Geschenk/9-10-Jahre
    H 1: Geschenk für 9- und 10-Jährige (30)
    H 2: Geschenkidee 9–10 Jahre (23)
    H 3: Geburtstagsgeschenk 9–10 Jahre (30)
    H 4: Sinnvolles Geschenk 9–10 Jahre (30)
    H 5: Personalisiertes Kinderbuch (27)
    H 6: Dein Kind, die Hauptfigur (25)
    H 7: Mit Foto deines Kindes (22)
    H 8: Mehr als Spielzeug (18)
    H 9: Erste Geschichte gratis (23)
    H10: In 3 Minuten erstellt (21)
    H11: Gedruckt in der Schweiz (23)
    H12: Für Jungs und Mädchen (21)
    H13: Nur für dein Kind gemacht (25)
    H14: Ab CHF 5 starten (16)
    H15: Jedes Kind hat eine Geschichte (30)
    D1: Ein Kinderbuch, in dem dein Kind (9–10 Jahre) der Held ist. Foto rein, fertig. (78)
    D2: Kein Spielzeug, das nach einer Woche vergessen ist: eine Geschichte nur über dein Kind. (87)
    D3: Erste Geschichte gratis testen. Als PDF sofort oder gedruckt in der Schweiz nach Hause. (87)
    D4: Personalisiertes Geschenk für Jungs und Mädchen. Dein Kind als Hauptfigur, in 3 Minuten. (88)

━━━ 3. Ad group Goettikind → https://magicalstory.ch/geschenk/fuer-patenkind (16 keywords)
  [DRY] ad_groups.create Goettikind
    campaign=[NEW campaign Search-Cheap-CH] status=ENABLED type=SEARCH_STANDARD cpc_bid_micros=200000 (CHF 0.20)
  [DRY] ad_group_criteria.create ×16 keywords in Goettikind
    [PHRASE] "göttikind geschenk"
    [PHRASE] "göttibub geschenk"
    [PHRASE] "göttimeitli geschenk"
    [PHRASE] "geschenk patenkind 3 jahre"
    [PHRASE] "geschenk patenkind 4 jahre"
    [PHRASE] "geschenk patenkind 6 jahre"
    [PHRASE] "geschenk patenkind schulanfang"
    [PHRASE] "patenkind geschenk einschulung"
    [PHRASE] "patenkind kindergarten geschenk"
    [PHRASE] "geburtstagsgeschenk patenkind"
    [PHRASE] "personalisierte geschenke patenkind"
    [PHRASE] "persönliches geschenk patenkind"
    [PHRASE] "personalisiertes buch patenkind"
    [PHRASE] "geschenkideen patenkind"
    [PHRASE] "weihnachtsgeschenk patenkind"
    [PHRASE] "kreatives geschenk patenkind"
  [DRY] ad_group_ads.create RSA in Goettikind
    ad_group=[NEW ad_group Goettikind] status=ENABLED final_urls=[https://magicalstory.ch/geschenk/fuer-patenkind?utm_source=google&utm_medium=search&utm_campaign=cheap-ch&utm_term={keyword}] path=/Geschenk/Goettikind
    H 1: Geschenk fürs Göttikind (23)
    H 2: Geschenk fürs Patenkind (23)
    H 3: Göttibub oder Göttimeitli (25)
    H 4: Personalisiertes Kinderbuch (27)
    H 5: Dein Göttikind als Held (23)
    H 6: Mehr als Geld im Couvert (24)
    H 7: Mit Foto des Kindes (19)
    H 8: Erste Geschichte gratis (23)
    H 9: In 3 Minuten erstellt (21)
    H10: Gedruckt in der Schweiz (23)
    H11: Für Geburtstag und Weihnachten (30)
    H12: Zur Einschulung schenken (24)
    H13: Ein Geschenk, das bleibt (24)
    H14: Nur für dein Göttikind (22)
    H15: Jedes Kind hat eine Geschichte (30)
    D1: Ein Kinderbuch, in dem dein Göttikind die Hauptfigur ist. Foto rein, Thema wählen, fertig. (90)
    D2: Persönlicher als Geld: eine Geschichte nur über dein Patenkind, von dir geschenkt. (82)
    D3: Erste Geschichte gratis testen. Als PDF sofort oder gedruckt in der Schweiz nach Hause. (87)
    D4: Für Göttibub und Göttimeitli von 3 bis 10 Jahren. In 3 Minuten erstellt. (72)

━━━ 3. Ad group Einschulung → https://magicalstory.ch/geschenk/einschulungsgeschenk (16 keywords)
  [DRY] ad_groups.create Einschulung
    campaign=[NEW campaign Search-Cheap-CH] status=ENABLED type=SEARCH_STANDARD cpc_bid_micros=200000 (CHF 0.20)
  [DRY] ad_group_criteria.create ×16 keywords in Einschulung
    [PHRASE] "sinnvolle geschenke zur einschulung"
    [PHRASE] "geschenke für jungs zur einschulung"
    [PHRASE] "personalisiertes buch einschulung"
    [PHRASE] "buch zur einschulung"
    [PHRASE] "personalisiertes kinderbuch einschulung"
    [PHRASE] "personalisierte einschulungsgeschenke"
    [PHRASE] "geschenkideen zur einschulung"
    [PHRASE] "schulanfangsgeschenke"
    [PHRASE] "geschenke für schulanfänger jungs"
    [PHRASE] "personalisiertes buch schulkind"
    [PHRASE] "coole geschenke zur einschulung"
    [PHRASE] "kleinigkeit zur einschulung"
    [PHRASE] "kindergarten abschiedsgeschenk"
    [PHRASE] "abschiedsgeschenk für kindergartenkinder"
    [PHRASE] "geschenke zum abschied kindergarten"
    [PHRASE] "abschiedsgeschenk kindergarten schulkinder"
  [DRY] ad_group_ads.create RSA in Einschulung
    ad_group=[NEW ad_group Einschulung] status=ENABLED final_urls=[https://magicalstory.ch/geschenk/einschulungsgeschenk?utm_source=google&utm_medium=search&utm_campaign=cheap-ch&utm_term={keyword}] path=/Geschenk/Einschulung
    H 1: Geschenk zur Einschulung (24)
    H 2: Einschulungsgeschenk (20)
    H 3: Geschenk zum Schulanfang (24)
    H 4: Buch zur Einschulung (20)
    H 5: Dein Schulkind als Held (23)
    H 6: Personalisiertes Kinderbuch (27)
    H 7: Mit Foto deines Kindes (22)
    H 8: Mehr als eine Schultüte (23)
    H 9: Erste Geschichte gratis (23)
    H10: In 3 Minuten erstellt (21)
    H11: Gedruckt in der Schweiz (23)
    H12: Mut für den ersten Schultag (27)
    H13: Für Jungs und Mädchen (21)
    H14: Nur für dein Kind gemacht (25)
    H15: Jedes Kind hat eine Geschichte (30)
    D1: Ein Kinderbuch, in dem dein Kind den ersten Schultag als Held erlebt. Foto rein, fertig. (88)
    D2: Sinnvoller als Süsses in der Schultüte: eine Geschichte, die Mut für die Schule macht. (86)
    D3: Erste Geschichte gratis testen. Als PDF sofort oder gedruckt in der Schweiz nach Hause. (87)
    D4: Personalisiertes Einschulungsgeschenk für Jungs und Mädchen. Dein Kind als Hauptfigur. (86)

━━━ 3. Ad group Geschwisterkind → https://magicalstory.ch/anlass/geschwisterchen (11 keywords)
  [DRY] ad_groups.create Geschwisterkind
    campaign=[NEW campaign Search-Cheap-CH] status=ENABLED type=SEARCH_STANDARD cpc_bid_micros=200000 (CHF 0.20)
  [DRY] ad_group_criteria.create ×11 keywords in Geschwisterkind
    [PHRASE] "kinderbuch grosse schwester"
    [PHRASE] "kinderbuch grosser bruder"
    [PHRASE] "bilderbuch grosse schwester"
    [PHRASE] "bilderbuch grosser bruder"
    [PHRASE] "buch grosse schwester werden"
    [PHRASE] "buch grosser bruder werden"
    [PHRASE] "geschenk für werdende grosse schwester"
    [PHRASE] "geschenke für werdende geschwister"
    [PHRASE] "ich werde grosse schwester buch"
    [PHRASE] "buch ich werde grosser bruder"
    [PHRASE] "einschulung geschenk geschwisterkind"
  [DRY] ad_group_ads.create RSA in Geschwisterkind
    ad_group=[NEW ad_group Geschwisterkind] status=ENABLED final_urls=[https://magicalstory.ch/anlass/geschwisterchen?utm_source=google&utm_medium=search&utm_campaign=cheap-ch&utm_term={keyword}] path=/Geschenk/Geschwister
    H 1: Buch für die grosse Schwester (29)
    H 2: Buch für den grossen Bruder (27)
    H 3: Geschenk fürs Geschwisterkind (29)
    H 4: Grosse Schwester werden (23)
    H 5: Grosser Bruder werden (21)
    H 6: Personalisiertes Kinderbuch (27)
    H 7: Dein Kind, die Hauptfigur (25)
    H 8: Mit Foto deines Kindes (22)
    H 9: Erste Geschichte gratis (23)
    H10: In 3 Minuten erstellt (21)
    H11: Gedruckt in der Schweiz (23)
    H12: Stolz aufs Geschwisterchen (26)
    H13: Nur für dein Kind gemacht (25)
    H14: Ein Geschenk, das bleibt (24)
    H15: Jedes Kind hat eine Geschichte (30)
    D1: Ein Kinderbuch, in dem dein Kind grosse Schwester oder grosser Bruder wird. Mit Foto. (85)
    D2: Wenn das Baby kommt, ist das ältere Kind der Held: eine Geschichte nur über dein Kind. (86)
    D3: Erste Geschichte gratis testen. Als PDF sofort oder gedruckt in der Schweiz nach Hause. (87)
    D4: Personalisiertes Geschenk zur Geburt des Geschwisterchens, für das grosse Kind gemacht. (87)

━━━ 4. Campaign negatives (101)
  [DRY] campaign_criteria.create ×101 negatives
    [BROAD] "ausmalbuch"
    [BROAD] "bubbleboo"
    [BROAD] "conni"
    [BROAD] "elsa"
    [BROAD] "globi"
    [BROAD] "kostenlos"
    [BROAD] "librio"
    [BROAD] "little yeti"
    [BROAD] "paw patrol"
    [BROAD] "pixastory"
    [BROAD] "selber basteln"
    [BROAD] "wimmelbuch"
    [BROAD] "wonderbly"
    [BROAD] "eiskönigin"
    [BROAD] "kinderbibel"
    [BROAD] "freundebuch"
    [BROAD] "kleinauflage"
    [PHRASE] "drucken lassen"
    [BROAD] "pappbilderbuch"
    [PHRASE] "götti geschenk"
    [PHRASE] "geschenk für götti"
    [PHRASE] "gotti geschenk"
    [PHRASE] "geschenk für gotti"
    [BROAD] "gotte"
    [BROAD] "pate"
    [BROAD] "paten"
    [BROAD] "patin"
    [BROAD] "patentante"
    [BROAD] "patenonkel"
    [BROAD] "taufpate"
    [BROAD] "kindergärtnerin"
    [BROAD] "lehrerin"
    [BROAD] "lehrer"
    [BROAD] "erzieherin"
    [BROAD] "erzieher"
    [BROAD] "kita team"
    [BROAD] "kindergarten team"
    [BROAD] "tagesmutter"
    [BROAD] "tasse"
    [BROAD] "basteln"
    [BROAD] "bastelidee"
    [BROAD] "fragen"
    [BROAD] "glückwünsche"
    [BROAD] "sprüche"
    [BROAD] "spruch"
    [BROAD] "gedicht"
    [BROAD] "karte"
    [BROAD] "geld"
    [BROAD] "geldgeschenk"
    [BROAD] "wieviel"
    [BROAD] "konfirmation"
    [BROAD] "firmung"
    [BROAD] "kommunion"
    [BROAD] "abitur"
    [BROAD] "matura"
    [BROAD] "hochzeit"
    [BROAD] "führerschein"
    [PHRASE] "18 geburtstag"
    [BROAD] "baby"
    [BROAD] "taufe"
    [BROAD] "taufgeschenk"
    [BROAD] "neugeborene"
    [PHRASE] "1 geburtstag"
    [PHRASE] "erster geburtstag"
    [BROAD] "spielzeug"
    [BROAD] "spielzeuge"
    [BROAD] "spielsachen"
    [BROAD] "lego"
    [BROAD] "playmobil"
    [BROAD] "puzzle"
    [BROAD] "kuscheltier"
    [BROAD] "fahrrad"
    [BROAD] "velo"
    [BROAD] "laufrad"
    [BROAD] "trottinett"
    [BROAD] "tonies"
    [BROAD] "tonie"
    [BROAD] "schultüte"
    [BROAD] "schultüten"
    [BROAD] "inhalt"
    [BROAD] "gastgeschenk"
    [BROAD] "gastgeschenke"
    [BROAD] "fotoalbum"
    [BROAD] "montessori"
    [BROAD] "outdoor"
    [BROAD] "fussball"
    [BROAD] "fußball"
    [BROAD] "einhorn"
    [BROAD] "kleidung"
    [BROAD] "gymnasium"
    [BROAD] "peppa"
    [BROAD] "bibi und tina"
    [BROAD] "feuerwehrmann sam"
    [BROAD] "lausemaus"
    [BROAD] "tchibo"
    [BROAD] "etsy"
    [BROAD] "amazon"
    [BROAD] "galaxus"
    [BROAD] "manor"
    [BROAD] "migros"
    [BROAD] "coop"

Would send 32 operation(s), skipped 0.
DRY-RUN — nothing was sent to Google Ads.
```
