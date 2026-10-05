import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

// Owner decision #10 (2026-10-05): French uses vous everywhere, narrow no-break space (U+202F)
// before ? ! : ; and inside « … », importer (never télécharger) for photo upload, sentence case in
// titles, the œ ligature and full accents. This scans every French string slot (fr: values, the true
// branch of `language === 'fr' ? … : …`, helper (de, fr, …) arguments) of the user-facing sources.
const require = createRequire(import.meta.url);
const { extractFrench } = require('../helpers/frenchStrings.js');

const ROOT = path.resolve(__dirname, '../..');
const NN = ' ';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const FILES = [
  ...walk(path.join(ROOT, 'client/src')),
  path.join(ROOT, 'server/lib/seoMeta.js'),
  path.join(ROOT, 'emails-src/i18n.ts'),
  path.join(ROOT, 'email.js'),
  path.join(ROOT, 'server/config/trialTitles.js'),
];

interface Slot { file: string; line: number; raw: string }
const SLOTS: Slot[] = [];
for (const f of FILES) {
  const text = fs.readFileSync(f, 'utf8');
  for (const s of extractFrench(f, text).slots) {
    SLOTS.push({ file: path.relative(ROOT, f).split(path.sep).join('/'), line: s.line, raw: s.raw });
  }
}

/** Slots whose raw text matches `re`, reported as file:line + the match. */
function offenders(re: RegExp, filter?: (s: Slot) => boolean): string[] {
  const out: string[] = [];
  for (const s of SLOTS) {
    if (filter && !filter(s)) continue;
    const m = re.exec(s.raw);
    if (m) out.push(`${s.file}:${s.line} ${JSON.stringify(s.raw.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20))}`);
  }
  return out;
}

describe('French slots are found', () => {
  it('extracts thousands of French strings from the expected sources', () => {
    expect(SLOTS.length).toBeGreaterThan(5000);
    const files = new Set(SLOTS.map((s) => s.file));
    for (const f of ['client/src/constants/translations.ts', 'server/lib/seoMeta.js', 'emails-src/i18n.ts', 'email.js', 'server/config/trialTitles.js']) {
      expect(files.has(f), f).toBe(true);
    }
  });
});

describe('FR-A typography: narrow no-break space before ? ! : ; and inside « »', () => {
  const FOLLOW = String.raw`(?=$|[\s"'’»)<\\]|[?!]| )`;
  it('no ASCII/no-break space before ? ! : ;', () => {
    expect(offenders(new RegExp(String.raw`[  ][?!:;]` + FOLLOW))).toEqual([]);
  });
  it('no tight ? ! : ; directly after a word', () => {
    const tight = new RegExp(String.raw`(?<=[\p{L}\p{N})»%\]])[?!:;]` + FOLLOW, 'u');
    const bad = offenders(tight, (s) => true).filter((o) => !/&#?\w+;|https?:/.test(o));
    expect(bad).toEqual([]);
  });
  it('« and » carry a narrow no-break space on the inside', () => {
    expect(offenders(/«(?! )/)).toEqual([]);
    expect(offenders(/(?<! )»/)).toEqual([]);
  });
  it('uses the real narrow no-break space (U+202F) somewhere', () => {
    expect(SLOTS.filter((s) => s.raw.includes(NN)).length).toBeGreaterThan(500);
  });
});

describe('FR-E upload vocabulary: importer, never télécharger, for photos', () => {
  it('"télécharger" never refers to a photo / an upload', () => {
    const re = /t[ée]l[ée]charg\w*\s+(?:une?\s+|des\s+|la\s+|les\s+|votre\s+|vos\s+|mes\s+)?(?:autre\s+|nouvelle\s+)?photos?|photos?\s+t[ée]l[ée]charg|pour t[ée]l[ée]charger\s*(?:$|[.!?])|t[ée]l[ée]charg\w*\s+(?:un|le)\s+fichier\s+texte/i;
    expect(offenders(re)).toEqual([]);
  });
  it('"télécharger" is not used for importing content (photos, files) in the legal texts', () => {
    expect(offenders(/vous t[ée]l[ée]chargez|peuvent t[ée]l[ée]charger|lors du t[ée]l[ée]chargement|contenu t[ée]l[ée]charg/i)).toEqual([]);
  });
});

describe('FR-G: ligature, accents, quotes, ordinals', () => {
  it('œ ligature in cœur / sœur / vœu / œuf / œil / œuvre', () => {
    expect(offenders(/\b(?:[Cc]oeur|[Ss]oeur|[Vv]oeu|[Oo]euf|[Oo]eil|[Bb]oeuf|[Nn]oeud|[Oo]euvre)/)).toEqual([]);
    expect(offenders(/\/soeur/)).toEqual([]);
  });
  it('accents on the words that were found unaccented', () => {
    expect(offenders(/\b[Rr]einitialis/)).toEqual([]);
    expect(offenders(/(?<![{\w])[Cc]redits?\b/)).toEqual([]);
    expect(offenders(/\b[Cc]reer\b/)).toEqual([]);
    expect(offenders(/\b[Dd]eja\b/)).toEqual([]);
    expect(offenders(/\b[Aa]rreter\b/)).toEqual([]);
    expect(offenders(/\b[Rr]eg[eé]n[eé]rer\b|\bRegénér/)).toEqual([]);
    expect(offenders(/\bsucces\b|\bcaracteres\b|\bverification\b|\bete (?:mis|ajoute|annule)|\bajoutes\b/)).toEqual([]);
  });
  it('no straight double quotes (guillemets instead)', () => {
    // odd-count pieces of a template literal that is split around ${…} are legitimate halves
    const bad = SLOTS.filter((s) => (s.raw.match(/\\?"/g) || []).length > 0).map((s) => `${s.file}:${s.line}`);
    expect(bad).toEqual([]);
  });
  it('ordinals use e, not ème', () => {
    expect(offenders(/\d(?:ème|eme)\b/)).toEqual([]);
  });
  it('percent sign is spaced from the number', () => {
    expect(offenders(/\d%/)).toEqual([]);
  });
  it('typographic ellipsis, not three dots', () => {
    expect(offenders(/\.\.\./)).toEqual([]);
  });
});

describe('FR-D vocabulary is one term each', () => {
  it('école enfantine (not maternelle)', () => {
    expect(offenders(/maternelle/i)).toEqual([]);
  });
  it('hardcover is "couverture rigide", softcover "couverture souple"', () => {
    expect(offenders(/cartonn/i)).toEqual([]);
    expect(offenders(/\bbrochée?s?\b/i)).toEqual([]);
  });
  it('e-mail (hyphenated, lower case) and CG', () => {
    expect(offenders(/(?<![{@\w.-])E?mail\b(?!\w)/, (s) => !/@/.test(s.raw))).toEqual([]);
    expect(offenders(/\bEmail\b/)).toEqual([]);
    expect(offenders(/\bCGU\b/)).toEqual([]);
  });
  it('facultatif, not optionnel', () => {
    expect(offenders(/optionnel/i)).toEqual([]);
  });
  it('dates use the fr-CH locale', () => {
    const src = fs.readFileSync(path.join(ROOT, 'client/src/pages/MyStories.tsx'), 'utf8');
    expect(src).not.toContain("'fr-FR'");
    expect(src).toContain("'fr-CH'");
  });
});

describe('FR-C: vous everywhere in the UI', () => {
  it('trial wizard steps and wizard summary address the reader with vous', () => {
    const files = [
      'client/src/pages/trial/TrialTopicStep.tsx', 'client/src/pages/trial/TrialIdeasStep.tsx', 'client/src/pages/trial/TrialCharacterStep.tsx',
      'client/src/pages/wizard/WizardStep6Summary.tsx', 'client/src/pages/TrialGenerationPage.tsx', 'client/src/pages/LandingPage.tsx',
      'client/src/components/story/StoryCategorySelector.tsx', 'client/src/hooks/useRotatingMessage.ts', 'client/src/constants/storyTypes.ts',
      'client/src/components/character/CharacterForm.tsx', 'server/config/trialTitles.js',
    ];
    const re = /(?<![\p{L}'’-])(?:ton|ta|tes|toi|tu)(?![\p{L}-])|-(?:tu|toi)(?![\p{L}])|^(?:Choisis|Décris|Ajoute|Saisis|Définis|Sois)\b/iu;
    expect(offenders(re, (s) => files.includes(s.file))).toEqual([]);
  });
  it('theme card descriptions address the reader with vous', () => {
    const re = /^(?:Découvre|Rencontre|Apprends|Explore|Regarde|Plonge|Assiste|Cours|Marche|Suis|Franchis|Fais|Vole|Grimpe|Descends|Creuse|Rejoins|Prends|Chevauche|Retiens|Mélange|Aide|Voyage|Flotte|Navigue|Tire|Travaille|Accompagne|Acclame|Avance|Crie|Reste|Arpente|Célèbre|Tiens|Clique|Visite|Flâne|Déterre|Assieds-toi|Faufile-toi)(?![\p{L}-])/u;
    expect(offenders(re, (s) => s.file === 'client/src/constants/themeContent.ts')).toEqual([]);
  });
});

describe('FR-F: sentence case in titles and labels', () => {
  it('trial story titles are sentence case', () => {
    // a capitalised common word after the first word of a title (proper nouns excepted)
    const COMMON = /\s(?:Petit|Petite|Grande|Grand|Aventure|Voyage|Secret|Journée|Nuit|Garçon|Fille|Qui|Jour|Où|Monde|Trésor|Forêt|Dragon|Magique|Antique)\b/;
    const bad = SLOTS.filter((s) => s.file === 'server/config/trialTitles.js' && COMMON.test(s.raw)).map((s) => `${s.file}:${s.line} ${s.raw}`);
    expect(bad).toEqual([]);
  });
  it('numbered legal section titles are sentence case', () => {
    const bad = SLOTS.filter((s) => /^(?:client\/src\/pages\/(?:PrivacyPolicy|TermsOfService)\.tsx)$/.test(s.file) && /^\d+\. \S/.test(s.raw) && !/\n/.test(s.raw))
      .filter((s) => s.raw.replace(/^\d+\. \S+/, '').split(' ').some((w) => /^[A-ZÉÈÀ][a-zéèàâêîôûç]/.test(w)))
      .map((s) => `${s.file}:${s.line} ${s.raw}`);
    expect(bad).toEqual([]);
  });
  it('legal and label headings are sentence case', () => {
    // headings only: a defined term cited inside a legal paragraph keeps its capitals
    expect(offenders(/^(?:Politique de Confidentialité|Mentions Légales|Choisissez Votre Style Artistique|Nombre de Pages|Niveau de Lecture)$/)).toEqual([]);
    expect(offenders(/Janvier 2025/)).toEqual([]);
  });
});
