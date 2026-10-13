/**
 * "The idea generator used to have a spinner, now idea gen takes much faster, but the spinner is gone for trial.
 * Fix it for trial and full story" (owner, 2026-10-13). The trial's page-wide spinner hides at the first streamed
 * word (~1.5 s); the cards then showed only a faint grey 20px spinner on white until each idea was complete. Both
 * wizards now show the shared LoadingSpinner (indigo) inside every card that is still being written.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', ...p), 'utf8');
const TRIAL = read('pages', 'trial', 'TrialIdeasStep.tsx');
const WIZARD = read('pages', 'wizard', 'WizardStep6Summary.tsx');

describe('idea cards show a visible spinner until the idea is complete', () => {
  it('trial: a card that is not final shows the shared LoadingSpinner with the generating text, never the faint grey one', () => {
    expect(TRIAL).toContain("import { LoadingSpinner } from '@/components/common';");
    expect((TRIAL.match(/<LoadingSpinner size="sm" message=\{t\.generating\} \/>/g) || []).length).toBe(2);
    expect(TRIAL).not.toMatch(/Loader2 className="w-5 h-5 text-gray-300 animate-spin"/);
  });

  it('full wizard: the loading card shows the same shared spinner above its progress bar', () => {
    expect(WIZARD).toContain("import { LoadingSpinner } from '@/components/common';");
    const loading = WIZARD.slice(WIZARD.indexOf('{isLoading ? ('), WIZARD.indexOf(') : hasIdea ? ('));
    expect(loading).toContain('<LoadingSpinner size="sm" />');
  });
});
