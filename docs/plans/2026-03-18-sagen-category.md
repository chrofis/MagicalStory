# Sagen Category in Swiss Stories — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Sagen" (fairy tales/legends) expandable section to the Swiss Stories category, alongside "Deine Stadt", "In der Nähe", and "Nach Kanton".

**Architecture:** The 14 Swiss fairy tales from `docs/FAIRY-TALES-RESEARCH.md` become a standalone array returned by the `/api/swiss-stories` endpoint. The frontend renders them as a new collapsible section with the same card style as city ideas. When selected, the story generation pipeline receives fairy-tale-specific instructions (character name, summary, themes) instead of city research.

**Tech Stack:** Express.js backend, React + TypeScript frontend, existing swiss stories infrastructure.

---

### Task 1: Add Sagen data to backend

**Files:**
- Create: `server/data/swiss-sagen.json`
- Modify: `server/lib/swissStories.js`

**Step 1: Create the Sagen JSON data file**

Create `server/data/swiss-sagen.json` with all 14 Swiss fairy tales from the research doc. Each entry follows the same multilingual `{id, title:{en,de,fr}, description:{en,de,fr}, context:{en,de,fr}}` pattern as swiss-story-ideas.json, plus extra metadata fields (`themes`, `age`, `realLocations`, `visualAppeal`).

```json
[
  {
    "id": "sage-heidi",
    "title": {
      "en": "Heidi",
      "de": "Heidi",
      "fr": "Heidi"
    },
    "description": {
      "en": "An orphan girl is sent to live with her gruff grandfather in the Swiss Alps. She befriends goatherd Peter and discovers the joy of mountain life.",
      "de": "Ein Waisenmädchen wird zu ihrem mürrischen Grossvater in die Schweizer Alpen geschickt. Sie freundet sich mit dem Geissenpeter an und entdeckt die Freude des Berglebens.",
      "fr": "Une orpheline est envoyée vivre chez son grand-père bourru dans les Alpes suisses. Elle se lie d'amitié avec le chevrier Peter et découvre la joie de la vie en montagne."
    },
    "context": {
      "en": "Based on Johanna Spyri's 1881 novel. Real locations: Maienfeld (GR), Heididorf museum, the Alp above Maienfeld.",
      "de": "Basierend auf Johanna Spyris Roman von 1881. Reale Orte: Maienfeld (GR), Heididorf-Museum, die Alp oberhalb Maienfeld.",
      "fr": "Basé sur le roman de Johanna Spyri de 1881. Lieux réels : Maienfeld (GR), musée Heididorf, l'alpage au-dessus de Maienfeld."
    },
    "themes": ["nature heals", "kindness", "home"],
    "age": "3+",
    "emoji": "🏔️"
  }
]
```

Full list of 14 tales (IDs): `sage-heidi`, `sage-devils-bridge`, `sage-dragons-pilatus`, `sage-st-gall-bear`, `sage-vogel-gryff`, `sage-white-chamois`, `sage-frost-giants`, `sage-cuckoo-clock-fairy`, `sage-edelweiss-fairy`, `sage-alpine-horn`, `sage-dwarf-chocolate`, `sage-palace-under-waves`, `sage-friendly-dragons`, `sage-gargantua-matterhorn`.

Use `docs/FAIRY-TALES-RESEARCH.md` as the source for all text. Translate descriptions/context to DE and FR based on the research doc content.

**Step 2: Load Sagen in swissStories.js and include in API response**

In `server/lib/swissStories.js`:

1. Add a `let swissSagenData = null;` module-level cache variable
2. Add `loadSwissSagen()` function that reads `server/data/swiss-sagen.json`
3. Call it from `initSwissStories()`
4. In `getSwissStoriesResponse()`, add the sagen array to the response:

```js
return {
  cantons: swissCitiesData.cantons,
  cities,
  sagen: swissSagenData || []
};
```

**Step 3: Verify backend**

Run: `node -e "const s = require('./server/lib/swissStories'); s.initSwissStories(); const r = s.getSwissStoriesResponse(); console.log('sagen count:', r.sagen.length); console.log('first:', r.sagen[0]?.id)"`
Expected: `sagen count: 14`, `first: sage-heidi`

**Step 4: Commit**

```bash
git add server/data/swiss-sagen.json server/lib/swissStories.js
git commit -m "feat: add Swiss Sagen data and include in swiss-stories API"
```

---

### Task 2: Update frontend types

**Files:**
- Modify: `client/src/types/story.ts`

**Step 1: Add SwissSage type and update SwissStoriesData**

```typescript
// After SwissStoryIdea interface
export interface SwissSage {
  id: string;
  title: SwissLocalizedString;
  description: SwissLocalizedString;
  context?: SwissLocalizedString;
  themes: string[];
  age: string;
  emoji: string;
}

// Update SwissStoriesData
export interface SwissStoriesData {
  cantons: Record<string, { en: string; de: string; fr: string }>;
  cities: SwissCity[];
  sagen?: SwissSage[];
}
```

**Step 2: Commit**

```bash
git add client/src/types/story.ts
git commit -m "feat: add SwissSage type to frontend"
```

---

### Task 3: Add Sagen section to StoryCategorySelector UI

**Files:**
- Modify: `client/src/components/story/StoryCategorySelector.tsx`

**Step 1: Update expandedSwissSection type**

Change line 132:
```typescript
const [expandedSwissSection, setExpandedSwissSection] = useState<'nearby' | 'cantons' | 'sagen' | null>(null);
```

**Step 2: Add translations**

Add to all 3 translation objects (en, de, fr):
- en: `sagen: 'Legends & Fairy Tales'`
- de: `sagen: 'Sagen & Märchen'`
- fr: `sagen: 'Légendes & Contes'`

**Step 3: Add Sagen section in the JSX**

After the "Nach Kanton" section (line ~904, before the closing `</div>` of `space-y-3`), add a new expandable section:

```tsx
{/* Swiss Legends (Sagen) */}
{swissData?.sagen && swissData.sagen.length > 0 && (
  <div className="border border-gray-200 rounded-lg overflow-hidden">
    <button
      onClick={() => setExpandedSwissSection(prev => prev === 'sagen' ? null : 'sagen')}
      className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 transition-colors"
    >
      <span className="font-semibold text-gray-700 flex items-center gap-2">
        <span>📖</span> {t.sagen}
        <span className="text-xs text-gray-500 font-normal">({swissData.sagen.length})</span>
      </span>
      {expandedSwissSection === 'sagen' ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
    </button>
    {expandedSwissSection === 'sagen' && (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3">
        {swissData.sagen.map((sage) => {
          const title = localizeField(sage.title, lang);
          const description = localizeField(sage.description, lang);
          const context = sage.context ? localizeField(sage.context, lang) : '';
          return (
            <button
              key={sage.id}
              onClick={() => {
                onTopicChange(sage.id);
                onLegacyStoryTypeChange(sage.id);
              }}
              className="p-3 rounded-lg border border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all text-left"
            >
              <div className="flex items-start gap-2">
                <span className="text-xl flex-shrink-0">{sage.emoji}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-800 line-clamp-1">{title}</div>
                  {context && (
                    <div className="text-[11px] text-amber-700 bg-amber-50 rounded px-1.5 py-1 mt-1 line-clamp-2 border border-amber-100">{context}</div>
                  )}
                  <div className="text-xs text-gray-500 line-clamp-2 mt-0.5">{description}</div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    )}
  </div>
)}
```

**Step 4: Commit**

```bash
git add client/src/components/story/StoryCategorySelector.tsx
git commit -m "feat: add Sagen section to Swiss Stories UI"
```

---

### Task 4: Handle Sagen topics in story generation

**Files:**
- Modify: `server/routes/storyIdeas.js` (lines ~121-141)
- Modify: `server/lib/swissStories.js` (add getter)

**Step 1: Add getSageById() to swissStories.js**

```js
function getSageById(sageId) {
  if (!swissSagenData) initSwissStories();
  return swissSagenData?.find(s => s.id === sageId) || null;
}
```

Export it.

**Step 2: Handle sage topics in storyIdeas.js**

In the `swiss-stories` branch (line ~121), before the existing city logic, add a check:

```js
} else if (effectiveCategory === 'swiss-stories') {
  // Check if this is a Sage (fairy tale) topic
  if (storyTopic.startsWith('sage-')) {
    const { getSageById } = require('../lib/swissStories');
    const sage = getSageById(storyTopic);
    if (sage) {
      const sageTitle = typeof sage.title === 'object' ? sage.title.en : sage.title;
      const sageDesc = typeof sage.description === 'object' ? sage.description.en : sage.description;
      const sageContext = sage.context && typeof sage.context === 'object' ? sage.context.en : (sage.context || '');
      categoryInstructions = `IMPORTANT: This is a SWISS FAIRY TALE / LEGEND (Sage).
Story: "${sageTitle}" — ${sageDesc}

${sageContext}

Themes: ${(sage.themes || []).join(', ')}

INSTRUCTIONS:
- Retell this classic Swiss legend with the child characters as participants in the story
- Keep the core plot and moral but make it age-appropriate and magical
- Use vivid Swiss Alpine imagery and real Swiss cultural elements
- The child becomes part of the legend — they don't just observe it`;
    } else {
      categoryInstructions = `This is a SWISS FAIRY TALE. Create an engaging retelling of a Swiss legend.`;
    }
  } else {
    // Existing city logic...
  }
}
```

**Step 3: Also update server.js city derivation (~line 4466)**

In the `swiss-stories` section of `server.js` that derives `userLocation` from `storyTopic`, add a skip for sage topics (they don't have cities):

```js
if (inputData.storyCategory === 'swiss-stories' && inputData.storyTopic && !inputData.userLocation?.city) {
  if (!inputData.storyTopic.startsWith('sage-')) {
    // existing city derivation...
  }
}
```

**Step 4: Verify**

Run: `node -e "const s = require('./server/lib/swissStories'); s.initSwissStories(); console.log(s.getSageById('sage-heidi'))"`
Expected: The Heidi sage object.

**Step 5: Commit**

```bash
git add server/routes/storyIdeas.js server/lib/swissStories.js server.js
git commit -m "feat: handle Sagen topics in story generation pipeline"
```

---

### Task 5: Manual verification

**Step 1: Start dev servers**

```bash
npm run dev &
npm run dev:client &
```

**Step 2: Test the full flow**

1. Open http://localhost:5173
2. Start story wizard → select "Swiss Stories"
3. Verify "Sagen & Märchen" section appears below "Nach Kanton"
4. Expand it → verify 14 fairy tale cards show
5. Click one (e.g., Heidi) → verify it gets selected as the topic
6. Verify the wizard proceeds to next step

**Step 3: Test API directly**

```bash
curl http://localhost:3000/api/swiss-stories | jq '.sagen | length'
```
Expected: `14`
