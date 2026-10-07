import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

// Guard: an inline translation in a customer-facing client file covers all four UI languages.
// Two shapes are checked: `language === 'de' ? … : language === 'fr' ? … : …` chains whose branches are
// strings (the else branch is English), and `{ en, de, fr, it }` maps whose keys are only language codes.
// A chain that misses a language silently falls through to English for that visitor (found 2026-10-07:
// Italian/French visitors saw "credits", "Cancel" and "pages"). Developer-only panels are excluded by
// file below; language-neutral chains (every branch the same text, e.g. "Original") are ignored.
const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const ts = require(path.join(ROOT, 'client/node_modules/typescript'));

const LANGS = ['en', 'de', 'fr', 'it'] as const;
const LANG_VAR = /lang/i;
// A branch rendered only for the owner (`{developerMode && …}`, `isAdmin ? … : …`) is not customer copy.
const DEV_GATE = /developerMode|isAdmin|role === 'admin'|isImpersonating/;

// Developer-mode / admin-only surfaces: their ternaries are mostly de/en and are not shown to customers.
const EXCLUDED = [
  'client/src/pages/admin/',
  'client/src/pages/AdminDashboard.tsx',
  'client/src/pages/TestLab.tsx',
  'client/src/components/generation/StoryDisplay.tsx',
  'client/src/components/generation/ModelSelector.tsx',
  'client/src/components/generation/EntityConsistencyView.tsx',
  'client/src/components/generation/story/ImageHistoryModal.tsx',
  'client/src/components/generation/story/ReferencePhotosDisplay.tsx',
  'client/src/components/generation/story/ObjectDetectionDisplay.tsx',
  'client/src/components/generation/story/GenerationSettingsPanel.tsx',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

type Node = any;

function textOf(node: Node): string | null {
  if (!node) return null;
  if (ts.isParenthesizedExpression(node)) return textOf(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s: Node) => '{}' + s.literal.text).join('');
  return null;
}

function condLang(cond: Node): string | null {
  if (ts.isParenthesizedExpression(cond)) return condLang(cond.expression);
  if (!ts.isBinaryExpression(cond)) return null;
  const op = cond.operatorToken.kind;
  if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.EqualsEqualsToken) return null;
  const lit = [cond.left, cond.right].find((n: Node) => ts.isStringLiteral(n) && (LANGS as readonly string[]).includes(n.text));
  if (!lit) return null;
  const other = cond.left === lit ? cond.right : cond.left;
  const name = ts.isIdentifier(other) ? other.text : ts.isPropertyAccessExpression(other) ? other.name.text : '';
  return LANG_VAR.test(name) ? lit.text : null;
}

function devGated(node: Node): boolean {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && DEV_GATE.test(n.left.getText())) return true;
    if (ts.isConditionalExpression(n) && n.condition !== node && DEV_GATE.test(n.condition.getText())) return true;
    if (ts.isIfStatement(n) && DEV_GATE.test(n.expression.getText())) return true;
  }
  return false;
}

/** [file:line, missing languages] for every incomplete inline translation. */
function gaps(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const out: string[] = [];
  const seen = new Set<Node>();
  const at = (n: Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

  const visit = (n: Node) => {
    if (ts.isObjectLiteralExpression(n) && n.properties.length >= 2) {
      const keys = n.properties.map((p: Node) => (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null));
      if (keys.every((k: string | null) => k && (LANGS as readonly string[]).includes(k)) && n.properties.some((p: Node) => textOf(p.initializer) !== null)) {
        const missing = LANGS.filter((l) => !keys.includes(l));
        if (missing.length && !devGated(n)) out.push(`${at(n)} map missing ${missing.join(',')}`);
      }
    }
    if (ts.isConditionalExpression(n) && !seen.has(n) && condLang(n.condition)) {
      const slots: Record<string, string | null> = {};
      let cur: Node = n;
      while (ts.isConditionalExpression(cur) && condLang(cur.condition)) {
        seen.add(cur);
        slots[condLang(cur.condition) as string] = textOf(cur.whenTrue);
        cur = cur.whenFalse;
        while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
      }
      const elseText = textOf(cur);
      const texts = [...Object.values(slots), elseText];
      // only string chains; a chain of t() calls or JSX is someone else's business
      if (texts.every((t) => t !== null)) {
        const missing = LANGS.filter((l) => !(l in slots) && l !== 'en');
        const neutral = new Set(texts.map((t) => (t as string).trim().toLowerCase())).size === 1;
        if (missing.length && !neutral && !devGated(n)) out.push(`${at(n)} ternary missing ${missing.join(',')}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const FILES = walk(path.join(ROOT, 'client/src')).filter((f) => {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  return !EXCLUDED.some((x) => rel.startsWith(x));
});

describe('inline translations in customer-facing client files cover en, de, fr and it', () => {
  it('scans the expected sources', () => {
    const rels = FILES.map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
    for (const f of ['client/src/pages/StoryWizard.tsx', 'client/src/pages/MyOrders.tsx', 'client/src/components/character/CharacterForm.tsx', 'client/src/components/generation/story/SceneEditModal.tsx']) {
      expect(rels, f).toContain(f);
    }
  });

  it('has no language ternary or map that falls through to English for fr or it', () => {
    const all = FILES.flatMap(gaps);
    expect(all).toEqual([]);
  });
});
