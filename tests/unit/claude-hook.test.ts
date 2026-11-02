/**
 * The one Claude Code hook (scripts/admin/claude-hook.js). Each check keeps the
 * rule it had as a separate script; the dispatcher combines their answers.
 * A paid story/trial run asks the owner first (owner, 2026-10-09). Hooks run for subagents too.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { respond, paidRunKind } = require('../../scripts/admin/claude-hook.js');

const ROOT = path.join(__dirname, '..', '..');
const noGrant = () => false;
const noRegistry = () => null;

describe('claude hook — paid runs', () => {
  it('catches every way a story or trial is started', () => {
    expect(paidRunKind('node scripts/admin/trial-showcase.js --entry=0 --idea=grounded')).toMatch(/trial/);
    expect(paidRunKind('node scripts/admin/rerun-story-on-staging.js job_1 --source=staging --pages=4 --yes')).toMatch(/rerun/);
    expect(paidRunKind('node scripts/test-scene-composite-smoke.js --pages=4 --skipEval=true')).toMatch(/smoke/);
    expect(paidRunKind('npm run showcase')).toMatch(/showcase/);
    expect(paidRunKind('curl -s -X POST https://staging.magicalstory.ch/api/trial/create-story -d {}')).toMatch(/create-story/);
  });
  it('lets dry runs, replays, Lab stages and DB reads through', () => {
    expect(paidRunKind('node scripts/admin/trial-showcase.js --entry=7 --dry-run')).toBeNull();
    expect(paidRunKind('node scripts/admin/rerun-story-on-staging.js job_1 --source=staging')).toBeNull();
    expect(paidRunKind('node scripts/test-scene-composite-smoke.js --pages=4 --dryRun')).toBeNull();
    expect(paidRunKind('node scripts/analysis/gaze-full-replay.js --days=21')).toBeNull();
    expect(paidRunKind('curl -s -X POST https://staging.magicalstory.ch/api/admin/testlab/experiments')).toBeNull();
    expect(paidRunKind('git push origin staging')).toBeNull();
  });
  it('asks, never silently blocks, and states the rule', () => {
    const d = respond({ tool_name: 'Bash', tool_input: { command: 'npm run showcase' } }, { grant: noGrant });
    expect(d.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(d.hookSpecificOutput.permissionDecisionReason).toMatch(/20 successful stage tests/);
  });
  it('an owner pre-approval lets the run through without asking', () => {
    const d = respond({ tool_name: 'Bash', tool_input: { command: 'npm run showcase' } }, { grant: () => true });
    expect(d).toEqual({ continue: true });
  });
});

describe('claude hook — dispatch', () => {
  it('a plain shell call and a plain edit answer allow with nothing added', () => {
    expect(respond({ tool_name: 'Bash', tool_input: { command: 'git status' } }, { grant: noGrant })).toEqual({ continue: true });
    expect(respond({ tool_name: 'Edit', tool_input: { file_path: path.join(ROOT, 'README.md') } }, { registry: noRegistry })).toEqual({ continue: true });
  });
  it('a prompt template gets the settled check and the prompt rules in one answer', () => {
    const d = respond({ tool_name: 'Write', tool_input: { file_path: path.join(ROOT, 'prompts', 'x.txt') } }, { registry: noRegistry });
    expect(d.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(d.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(d.hookSpecificOutput.additionalContext).toMatch(/SETTLED-VERDICT CHECK/);
    expect(d.hookSpecificOutput.additionalContext).toMatch(/PROMPT-RULES CHECK/);
  });
  it('a registered sibling names its counterpart; a critic names its generator', () => {
    const registry = () => ({
      sets: [
        { axis: 'a-vs-b', members: ['server/lib/a.js', 'server/lib/b.js'], reason: 'twins' },
        { axis: 'generator-vs-critic', generators: ['prompts/gen.txt'], critics: ['server/lib/a.js'], reason: 'judge' },
      ],
    });
    const ctx = respond({ tool_name: 'Edit', tool_input: { file_path: path.join(ROOT, 'server', 'lib', 'a.js') } }, { registry })
      .hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/a-vs-b: also check server\/lib\/b\.js/);
    expect(ctx).toMatch(/CRITIC.*Generator: prompts\/gen\.txt/);
  });
  it('a scratchpad script that requires server/lib gets the lab reminder, not a gate', () => {
    const readFile = () => "const x = require('../../server/lib/faceRepair.js');";
    const d = respond({ tool_name: 'Bash', tool_input: { command: 'cd /tmp/scratchpad && node run.js' } }, { grant: noGrant, readFile });
    expect(d.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(d.hookSpecificOutput.additionalContext).toMatch(/run\.js runs the pipeline/);
    const mention = () => "console.log('server/lib/faceRepair.js')";
    expect(respond({ tool_name: 'Bash', tool_input: { command: 'cd /tmp/scratchpad && node run.js' } }, { grant: noGrant, readFile: mention }))
      .toEqual({ continue: true });
  });
});
