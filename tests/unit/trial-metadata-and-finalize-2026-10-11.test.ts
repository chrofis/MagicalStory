/**
 * Regressions (staging job_1791700480532_ul7f67gii):
 *  - finalize called scoring.logScoreModelSummary, deleted in 70d4df7e4 ("is not a function" in the log);
 *  - characters.metadata kept "Stofftier " while data held "Stofftier Elefant Eli": the PATCH rewrote data only.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
const { trialCharacterListFields } = require('../../server/lib/trialCharacterMeta');
const scoring = require('../../server/lib/scoring');
const root = path.resolve(__dirname, '../..');

describe('job finalize', () => {
  it('references no scoring export that does not exist', () => {
    const src = fs.readFileSync(path.join(root, 'storyJobPipeline.js'), 'utf8');
    for (const m of src.matchAll(/const \{([^}]+)\} = require\('\.\/server\/lib\/scoring'\)/g)) {
      for (const name of m[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean)) {
        expect(typeof scoring[name], `scoring.${name}`).toBe('function');
      }
    }
    expect(src).not.toContain('logScoreModelSummary');
  });
});

describe('trial character metadata', () => {
  it('mirrors the list fields of the character incl. the traits with specialDetails', () => {
    const c = { id: 1, name: 'Lukas', age: '8', gender: 'male', role: 'main', photos: { face: 'x' }, traits: { strengths: [], specialDetails: 'Stofftier Elefant Eli' } };
    expect(trialCharacterListFields(c)).toEqual({ id: 1, name: 'Lukas', age: '8', gender: 'male', traits: c.traits, role: 'main' });
  });
  it('the PATCH route syncs the metadata copy from the same helper', () => {
    const src = fs.readFileSync(path.join(root, 'server/routes/trial.js'), 'utf8');
    expect(src.match(/trialCharacterListFields\(/g)?.length).toBe(2);
  });
});
