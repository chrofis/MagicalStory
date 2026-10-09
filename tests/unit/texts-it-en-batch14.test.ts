import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// Code review 2026-10-04, batch 14 (owner decisions #8, #9, #11, #13): Italian register is tu everywhere
// except the legal pages, English is US English, no raw template slots in the theme copy, the
// comparison cells exist in all four languages, German UI is du outside the legal pages.
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const C = '../../client/src/constants/';

type Lang = 'en' | 'de' | 'fr' | 'it';

/** Every string under a `lang` key (any depth), with its path. */
function slots(mod: unknown, lang: Lang): { at: string; s: string }[] {
  const out: { at: string; s: string }[] = [];
  const walk = (v: unknown, at: string, inLang: boolean) => {
    if (typeof v === 'string') { if (inLang) out.push({ at, s: v }); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, c] of Object.entries(v as Record<string, unknown>)) walk(c, `${at}.${k}`, inLang || k === lang);
  };
  walk(mod, '', false);
  return out;
}

async function load(name: string, lang: Lang) {
  const mod = await import(C + name);
  return slots(mod, lang);
}

const DATA_FILES = ['themeContent', 'guideData', 'giftData', 'occasionData', 'comparisonData', 'storyTypes', 'translations'];

function offenders(all: { f: string; at: string; s: string }[], re: RegExp, strip?: (s: string) => string) {
  const out: string[] = [];
  for (const { f, at, s } of all) {
    const text = strip ? strip(s) : s;
    const m = re.exec(text);
    if (m) out.push(`${f}${at}: ${JSON.stringify(text.slice(Math.max(0, m.index - 25), m.index + m[0].length + 25))}`);
  }
  return out;
}

async function allSlots(lang: Lang) {
  const all: { f: string; at: string; s: string }[] = [];
  for (const f of DATA_FILES) for (const x of await load(f, lang)) all.push({ f, ...x });
  return all;
}

describe('English copy is US English', () => {
  const UK = /\b(colour\w*|favourite\w*|paediatric\w*|behaviour\w*|centres?|counsell\w*|recognis(?:e|ed|es|ing)|anonymis\w*|practis(?:e|ed|es|ing)|mums?|mummy|organis\w*|personalis\w*|realis(?:e|ed|es|ing)|specialis(?:e|ed|es|ing)|minimis\w*|licence|catalogue|autumn|nappy|nappies|pram|torch|yoghurt|pyjamas?|analogue|travelling|modelled|mobilised|civilisation|grey|neighbour\w*|honour\w*|flavour\w*|humour\w*|cosy|whilst)\b/i;
  it('has no British spellings or vocabulary in the data files', async () => {
    const bad = offenders(await allSlots('en'), UK);
    expect(bad).toEqual([]);
  });

  it('uses curly quotes, not Swiss guillemets, in English', async () => {
    expect(offenders(await allSlots('en'), /[«»]/)).toEqual([]);
  });

  it('has no German or Swiss words left unglossed in English theme/gift copy', async () => {
    const bad = offenders(await allSlots('en'), /\b(Einschulung|Rütlischwur)\b/);
    expect(bad).toEqual([]);
  });

  it('does not leak hyphen-derived template slots into the theme descriptions', async () => {
    const bad = offenders(await allSlots('en'), /\b(numbers 1 10|numbers 1 20|colors basic|days week|swiss womens vote|swiss founding|wilhelm tell and)\b/);
    expect(bad).toEqual([]);
  });

  it('has no leaked placeholder X in the sharing quote', async () => {
    expect(offenders(await allSlots('en'), /\bX can have a turn\b/)).toEqual([]);
  });
});

describe('Italian copy uses tu', () => {
  // Quoted speech («…») may keep voi (parent talking to two children).
  const stripQuotes = (s: string) => s.replace(/«[^»]*»/g, '«»');
  const VOI = /\b(vostr[oaie]|voi(?! due)|potete|avete|volete|scegliete|caricate|inserite|leggete|aggiungete|sapete|vedete)\b/i;

  it('has no voi/vostro forms outside quoted speech in the data files', async () => {
    expect(offenders(await allSlots('it'), VOI, stripQuotes)).toEqual([]);
  });

  it('uses copertina rigida for hardcover and has no English leftovers', async () => {
    const bad = offenders(await allSlots('it'), /\b(cartonat\w*|flashcards?|workflow|problem solving|pattern|cool|referral)\b/i);
    expect(bad).toEqual([]);
  });

  it('has none of the concrete grammar errors reported by the review', async () => {
    const bad = offenders(await allSlots('it'), /\bQuale è\b|\bE importante\b|dell'trasloco|\bnon non\b|tocca a X\b|personagg\{s\}|nDSG/);
    expect(bad).toEqual([]);
  });

  it('keeps the factual price: hardcover from CHF 37, never "cartonato da CHF 29"', async () => {
    const bad = offenders(await allSlots('it'), /rigida[^.]{0,20}da CHF 29/);
    expect(bad).toEqual([]);
  });

  it('translations: gender "other" is Altro, character counter has no personagg{s}', async () => {
    const t = (await import(C + 'translations')) as any;
    const it = (t.translations ?? t.default).it;
    expect(it.other).toBe('Altro');
    expect(it.charactersCreated).not.toContain('{s}');
  });

  it('trial titles are sentence case (proper nouns excepted)', () => {
    const { TRIAL_TITLES } = require('../../server/config/trialTitles.js');
    const KEEP = new Set(['Roma', 'Olimpo', 'Sempach', 'Solferino', 'Alpi', 'Parigi', 'Grecia', 'Halloween', 'Natale', 'Pasqua', 'Capodanno', 'West', 'Selvaggio', 'San', 'Nicolao']);
    const titles: string[] = [];
    const walk = (v: any) => {
      if (!v || typeof v !== 'object') return;
      if (typeof v.it === 'string') titles.push(v.it);
      for (const c of Object.values(v)) walk(c);
    };
    walk(TRIAL_TITLES);
    expect(titles.length).toBeGreaterThan(100);
    const bad = titles.filter((t) => t.split(/[\s']+/).slice(1).some((w) => /^[A-ZÀ-Ý]/.test(w) && !KEEP.has(w)));
    expect(bad).toEqual([]);
  });

  it('email greeting and signoff are Ciao / Cordiali saluti', () => {
    const src = fs.readFileSync(path.join(ROOT, 'emails-src/i18n.ts'), 'utf8');
    expect(src).not.toMatch(/Caro\/Cara|Cari saluti/);
  });
});

describe('story types and traits', () => {
  it('has unique English short names for historical events and no "Chunnel"', async () => {
    const st = (await import(C + 'storyTypes')) as any;
    const names = st.historicalEvents.map((e: any) => e.shortName.en);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('Chunnel');
  });

  it('has no "Lying" trait in English', async () => {
    const t = (await import(C + 'traits')) as any;
    expect(t.defaultFlaws.en).not.toContain('Lying');
  });
});

describe('German UI is du outside the legal pages', () => {
  const FILES = [
    'client/src/components/auth/ChangePasswordModal.tsx',
    'client/src/components/auth/EmailVerificationModal.tsx',
    'client/src/components/character/FaceSelectionModal.tsx',
    'client/src/components/common/CreditsModal.tsx',
    'client/src/components/generation/story/SceneEditModal.tsx',
    'client/src/components/character/CharacterForm.tsx',
    'client/src/pages/MyStories.tsx',
    'client/src/components/character/PhotoUpload.tsx',
  ];
  it.each(FILES)('%s has no Sie-form German', (f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    expect(src).not.toMatch(/\b(Bitte \w+ Sie|Geben Sie|Wählen Sie|Beschreiben Sie|Bearbeiten Sie|Warten Sie|Prüfen Sie|Möchten Sie|Ihr(e|en|em|er)? (Passwort|Buch|Zahlung|Geschichte|Posteingang|Spam|Foto)|Ihnen)\b/);
  });
});

describe('the free story is promised in "a few minutes", not "under 3 minutes" (decision #8)', () => {
  it.each(['About', 'Contact', 'LandingPage', 'TrialWizard'])('%s.tsx', (page) => {
    const src = fs.readFileSync(path.join(ROOT, `client/src/pages/${page}.tsx`), 'utf8');
    expect(src).not.toMatch(/under 3 minutes|unter 3 Minuten|moins de 3 minutes|meno di 3 minuti|~3 (minutes|Minuten|minuti)|in 3 (minutes|Minuten|minuti)/);
  });
});

describe('comparison cells exist in every language (L-4)', () => {
  it('every feature us/them has en, de, fr and it text, and the page renders feature.us[lang] without an English fallback', async () => {
    const { comparisons } = (await import(C + 'comparisonData')) as any;
    const missing: string[] = [];
    let cells = 0;
    for (const c of comparisons) {
      for (const f of c.features ?? []) {
        for (const side of ['us', 'them']) {
          cells++;
          for (const l of ['en', 'de', 'fr', 'it']) {
            if (typeof f[side]?.[l] !== 'string' || f[side][l] === '') missing.push(`${c.id}/${f.label.en}/${side}/${l}`);
          }
        }
      }
    }
    expect(cells).toBeGreaterThan(100);
    expect(missing).toEqual([]);
    const page = fs.readFileSync(path.join(ROOT, 'client/src/pages/ComparisonPage.tsx'), 'utf8');
    expect(page).not.toMatch(/\{feature\.(us|them)\}/);
  });
});
