// Finds the French string slots of a source file: values of `fr` / `xxxFr` properties,
// the true branch of `language === 'fr' ? A : B` (incl. nested), and the 2nd argument of
// translation helpers declared as (de, fr, ...) => ... . Returns [{start, end, raw, line}]
// where raw is the source text between the quotes (escapes untouched), so callers can
// both scan and rewrite in place.
const path = require('path');
const ts = require(path.resolve(__dirname, '../../client/node_modules/typescript'));

const FR_PROP = /^(fr|FRENCH|French|[a-z]+Fr|fr[A-Z]\w*)$/;
const TEXT_JSX_ATTRS = new Set(['title', 'placeholder', 'alt', 'aria-label', 'label', 'description']);

function isFrTest(cond) {
  if (!ts.isBinaryExpression(cond)) return false;
  const op = cond.operatorToken.kind;
  if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.EqualsEqualsToken) return false;
  const lit = (n) => ts.isStringLiteral(n) && n.text === 'fr';
  return lit(cond.left) || lit(cond.right);
}

function extractFrench(file, text) {
  const kind = file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX
    : file.endsWith('.js') || file.endsWith('.cjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out = new Map(); // start -> slot
  const helpers = new Map(); // name -> index of the `fr` parameter of (…, fr, …) helpers

  function add(start, end) {
    if (end <= start) return;
    const key = start;
    if (out.has(key)) return;
    out.set(key, { start, end, raw: text.slice(start, end), line: sf.getLineAndCharacterOfPosition(start).line + 1 });
  }
  function collect(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const p = node.parent;
      if (ts.isPropertyAssignment(p) && p.name === node) return; // object key
      if (ts.isImportDeclaration(p) || ts.isExternalModuleReference(p)) return;
      if (ts.isJsxAttribute(p)) { if (!TEXT_JSX_ATTRS.has(p.name.getText())) return; }
      if (ts.isCaseClause(p)) return;
      if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind)) return;
      add(node.getStart() + 1, node.getEnd() - 1);
      return;
    }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
      add(node.getStart() + 1, node.getEnd() - 2);
      return;
    }
    if (ts.isTemplateTail(node)) {
      add(node.getStart() + 1, node.getEnd() - 1);
      return;
    }
    if (ts.isJsxText(node)) { add(node.getStart(), node.getEnd()); return; }
    if (ts.isJsxAttribute(node) && !TEXT_JSX_ATTRS.has(node.name.getText())) return;
    if (ts.isTypeNode(node)) return;
    ts.forEachChild(node, collect);
  }

  function visit(node) {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && FR_PROP.test(node.name.text)) {
      collect(node.initializer);
    } else if (ts.isConditionalExpression(node) && isFrTest(node.condition)) {
      collect(node.whenTrue);
    } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const idx = node.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === 'fr');
      const d = node.parent;
      if (idx >= 0 && node.parameters.length >= 2 && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name)) helpers.set(d.name.text, idx);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  // helper calls: 2nd argument
  (function calls(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.has(node.expression.text) && node.arguments.length > helpers.get(node.expression.text)) {
      collect(node.arguments[helpers.get(node.expression.text)]);
    }
    ts.forEachChild(node, calls);
  })(sf);
  return { slots: [...out.values()].sort((a, b) => a.start - b.start), helpers: [...helpers.keys()] };
}

module.exports = { extractFrench };
