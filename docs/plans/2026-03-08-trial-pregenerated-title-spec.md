# Trial Pre-Generated Title Page — Requirement Spec

**Date:** 2026-03-08
**Status:** Requirement spec (not ready for implementation)
**Depends on:** Anonymous account creation (in progress by separate agent)

## Goal

Show the user a personalized title page image BEFORE they enter their email. Generate avatars + title page while they browse story ideas, so by the time they pick one, the title page is ready.

## Prerequisites

- **Anonymous accounts** must exist: when user uploads photo (step 1), an anonymous account + character is created in DB with face photo and avatar data. *(Separate agent is implementing this.)*

## Pre-Defined Titles

Each topic needs a pre-defined book title in all supported languages, with male/female variants.

### New config: Add to `server/config/trialCostumes.js` (or new file `server/config/trialTitles.js`)

```javascript
// Per topic, per gender, per language
{
  adventure: {
    pirate: {
      male: {
        en: "The Little Pirate's Great Adventure",
        de: "Das grosse Abenteuer des kleinen Piraten",
        'de-ch': "S grosse Abenteür vom chline Pirat",
        fr: "La Grande Aventure du Petit Pirate",
        // ... all supported languages
      },
      female: {
        en: "The Little Pirate's Great Adventure",
        de: "Das grosse Abenteuer der kleinen Piratin",
        'de-ch': "S grosse Abenteür vo de chline Piratin",
        fr: "La Grande Aventure de la Petite Pirate",
      }
    },
    knight: { ... },
    // ... all adventure themes
  },
  historical: {
    'moon-landing': {
      male: { en: "Journey to the Moon", de: "Reise zum Mond", ... },
      female: { en: "Journey to the Moon", de: "Reise zum Mond", ... }
    },
    // ... all historical events
  }
}
```

**Languages to support:** en, de, de-ch, fr (check `server/lib/languages.js` for full list)

## Flow

```
Step 1: Upload photo → anonymous account + character created in DB
         → preview avatar generated and stored

Step 2: Select topic/category

Step 3: See story ideas (Claude generates 2 ideas)
         → ON LOAD: Backend starts generating:
           1. Styled standard avatar (watercolor from preview avatar)
           2. Styled costumed avatar (watercolor + topic costume)
           3. Title page image (using pre-defined title + costumed avatar)
         → All runs in parallel with idea display
         → User browses ideas while generation happens (~15-20s)

Step 4: User selects an idea
         → Title page image shown immediately (already generated)
         → "Enter your email to get the full story"

Step 5: User enters email
         → Full story generation begins (text + remaining page images)
         → Avatar styling already done — reuse from step 3
```

## New Backend Endpoint

```
POST /api/trial/prepare-title
```

**Input:**
```json
{
  "characterId": "anonymous-char-id",
  "storyTopic": "pirate",
  "storyCategory": "adventure",
  "language": "de-ch"
}
```

**Processing (all parallel):**
1. Load character from DB (has face photo + preview avatar)
2. Look up costume from `trialCostumes.js`
3. Look up title from `trialTitles.js`
4. Generate styled standard avatar (`prepareStyledAvatars`)
5. Generate styled costumed avatar (`prepareStyledAvatars`)
6. Generate title page image (using cover model, pre-defined title, costumed avatar)

**Response:**
```json
{
  "titlePageImage": "data:image/jpeg;base64,...",
  "title": "S grosse Abenteür vom chline Pirat",
  "costumeType": "pirate"
}
```

**Timing:** ~15-20s total (avatar styling ~10s + title page ~10s, but parallel)

## Frontend Changes

- Step 3 component: on mount, call `/api/trial/prepare-title` in background
- Store result in state
- When user selects an idea: show title page image as a "preview" of their book
- CTA: "Enter your email to get your full story" with the title page visible

## Cost

| Item | Cost |
|------|------|
| 2 styled avatars | ~$0.08 |
| 1 title page (cover model) | ~$0.15 |
| **Total per trial visitor at step 3** | **~$0.23** |

**Note:** This cost is incurred even if the user doesn't register. Only trigger for users who actually reach step 3 (have uploaded a photo and selected a topic).

## Reuse in Story Generation

When the full story generation starts (after email registration):
- Styled avatars from step 3 should be cached and reused (already in `styledAvatarCache`)
- Title page image should be stored and used as the story's front cover (no regeneration needed)
- Pass `titlePageImage` to the story job so it skips title page generation
