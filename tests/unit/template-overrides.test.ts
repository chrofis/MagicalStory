/**
 * Per-call template overrides — the precondition for running Lab experiments
 * concurrently.
 *
 * Before this, `promptOverride` assigned onto the shared PROMPT_TEMPLATES
 * registry and restored in a `finally`. Two experiments at once meant one read
 * the other's prompt, or one's restore dropped the other's override mid-run —
 * results attributed to the wrong prompt. That is why the Lab was single-flight.
 * See docs/decisions.md (2026-08-25).
 */
import { describe, it, expect } from 'vitest';

const { PROMPT_TEMPLATES, withTemplates } = require('../../server/services/prompts');

// Populate through the proxy, exactly as loadPromptTemplates does.
PROMPT_TEMPLATES.__testA = 'BASE-A';
PROMPT_TEMPLATES.__testB = 'BASE-B';

const tick = () => new Promise(r => setTimeout(r, 1));

describe('withTemplates', () => {
  it('makes an override visible inside and invisible outside', () => {
    expect(PROMPT_TEMPLATES.__testA).toBe('BASE-A');
    withTemplates({ __testA: 'OVERRIDE' }, () => {
      expect(PROMPT_TEMPLATES.__testA).toBe('OVERRIDE');
    });
    expect(PROMPT_TEMPLATES.__testA).toBe('BASE-A');
  });

  it('leaves untouched keys reading their base value', () => {
    withTemplates({ __testA: 'OVERRIDE' }, () => {
      expect(PROMPT_TEMPLATES.__testB).toBe('BASE-B');
    });
  });

  it('survives awaits inside the callback', async () => {
    await withTemplates({ __testA: 'OVERRIDE' }, async () => {
      await tick();
      expect(PROMPT_TEMPLATES.__testA).toBe('OVERRIDE');
    });
    expect(PROMPT_TEMPLATES.__testA).toBe('BASE-A');
  });

  it('THE RACE: two concurrent overrides never see each other', async () => {
    // Interleaved on purpose — each reads after the other has entered its
    // scope. Under the old global-mutation scheme both would read the same
    // value and one restore would clobber the other.
    const seen: string[] = [];
    await Promise.all([
      withTemplates({ __testA: 'FROM-A' }, async () => {
        await tick();
        seen.push(`a:${PROMPT_TEMPLATES.__testA}`);
        await tick();
        seen.push(`a:${PROMPT_TEMPLATES.__testA}`);
      }),
      withTemplates({ __testA: 'FROM-B' }, async () => {
        await tick();
        seen.push(`b:${PROMPT_TEMPLATES.__testA}`);
        await tick();
        seen.push(`b:${PROMPT_TEMPLATES.__testA}`);
      }),
    ]);
    expect(seen.filter(s => s.startsWith('a:'))).toEqual(['a:FROM-A', 'a:FROM-A']);
    expect(seen.filter(s => s.startsWith('b:'))).toEqual(['b:FROM-B', 'b:FROM-B']);
    expect(PROMPT_TEMPLATES.__testA).toBe('BASE-A');
  });

  it('a concurrent run with NO override still reads the base', async () => {
    let plain = '';
    await Promise.all([
      withTemplates({ __testA: 'FROM-A' }, async () => { await tick(); }),
      (async () => { await tick(); plain = PROMPT_TEMPLATES.__testA; })(),
    ]);
    expect(plain).toBe('BASE-A');
  });

  it('nests, merging onto the parent view', () => {
    withTemplates({ __testA: 'OUTER' }, () => {
      withTemplates({ __testB: 'INNER' }, () => {
        expect(PROMPT_TEMPLATES.__testA).toBe('OUTER');
        expect(PROMPT_TEMPLATES.__testB).toBe('INNER');
      });
      expect(PROMPT_TEMPLATES.__testB).toBe('BASE-B');
    });
  });

  it('ignores empty and non-string overrides rather than blanking a template', () => {
    // The Lab passes promptOverride straight through; null/'' must mean
    // "no override", never "the template is now empty".
    withTemplates({ __testA: '' }, () => expect(PROMPT_TEMPLATES.__testA).toBe('BASE-A'));
    withTemplates({ __testA: null }, () => expect(PROMPT_TEMPLATES.__testA).toBe('BASE-A'));
    withTemplates({}, () => expect(PROMPT_TEMPLATES.__testA).toBe('BASE-A'));
  });

  it('returns the callback result', async () => {
    expect(withTemplates({ __testA: 'X' }, () => 42)).toBe(42);
    await expect(withTemplates({ __testA: 'X' }, async () => 'done')).resolves.toBe('done');
  });

  it('still behaves like a plain object for writes and enumeration', () => {
    // loadPromptTemplates assigns onto it and the derived-template pass walks
    // Object.keys(); the proxy must not break either.
    PROMPT_TEMPLATES.__testC = 'BASE-C';
    expect(Object.keys(PROMPT_TEMPLATES)).toContain('__testC');
    expect('__testA' in PROMPT_TEMPLATES).toBe(true);
    expect('__nope' in PROMPT_TEMPLATES).toBe(false);
  });
});
