/**
 * Editing a trial idea's text must not deselect it.
 *
 * The ideas step says "You can click into the text to edit the story idea
 * before creating". The textarea's onChange went through onIdeasGenerated,
 * whose wizard handler resets selectedIdeaIndex (right for a fresh pair from
 * the stream, wrong for an edit): the first keystroke in the card the visitor
 * had just picked greyed out "Create my story", and the card had to be
 * selected again. Edits now go through onIdeaEdited, which only stores them.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const read = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'pages', ...p), 'utf8').split('\r\n').join('\n');
const STEP = read('trial', 'TrialIdeasStep.tsx');
const WIZARD = read('TrialWizard.tsx');

describe('an idea edit keeps the selection', () => {
  it('the textarea reports edits through onIdeaEdited, never onIdeasGenerated', () => {
    const textarea = STEP.slice(STEP.indexOf('<textarea'), STEP.indexOf('</textarea>') > 0 ? STEP.indexOf('</textarea>') : STEP.indexOf('/>', STEP.indexOf('<textarea')));
    expect(textarea).toContain('onIdeaEdited(updated);');
    expect(textarea).not.toContain('onIdeasGenerated(');
  });

  it('a fresh pair from the stream still goes through onIdeasGenerated', () => {
    const finalEffect = STEP.slice(STEP.indexOf('// When both ideas are final'), STEP.indexOf('// Auto-generate on mount'));
    expect(finalEffect).toContain('onIdeasGenerated([parseIdea(');
  });

  it('the wizard resets the selection on a generation and keeps it on an edit', () => {
    const generated = WIZARD.slice(WIZARD.indexOf('const handleIdeasGenerated'), WIZARD.indexOf('const handleIdeaEdited'));
    expect(generated).toContain('setSelectedIdeaIndex(null);');
    const editedStart = WIZARD.indexOf('const handleIdeaEdited');
    const edited = WIZARD.slice(editedStart, WIZARD.indexOf('}, []);', editedStart));
    expect(edited).toContain('setGeneratedIdeas(ideas);');
    expect(edited).not.toContain('setSelectedIdeaIndex');
    expect(WIZARD).toContain('onIdeaEdited={handleIdeaEdited}');
  });
});
