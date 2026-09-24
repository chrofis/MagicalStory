import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { entityIssuesForPage, entityFindingsForPage } = require('../../server/lib/scoring.js');
const { collectAllIssuesForPage } = require('../../server/lib/images.js');

// The repair panel's issue list and the page score read the entity report
// through ONE reader. Shape from staging job_1790100385959_1nitlympp's back
// cover (page -3), 2026-09-24: the report was assembled from the shipped picks,
// so Julian's crop-artefact finding sits in the root `issues` only while
// byClothing.standard carries 0 issues. The old byClothing-first list read the
// empty byClothing entry and never looked at the root.
const PAGE = -3;
const cropArtefact = {
  type: 'cutout_artifact',
  subType: 'cutout_artifact',
  severity: 'MAJOR',
  pageNumber: PAGE,
  pageNumbers: [PAGE],
  description: "The character's left arm shows jagged white edges, a cropping artifact.",
};

function listEntity(report: unknown, page = PAGE) {
  const storyData = { finalChecksReport: { entity: report } };
  return collectAllIssuesForPage({}, storyData, page).filter((i: any) => i.source === 'entity check');
}

describe('entity findings: the panel lists exactly what the score counts', () => {
  it('a root-only finding with an empty byClothing entry is listed once and billed', () => {
    const report = {
      characters: {
        Julian: { byClothing: { standard: { issues: [] } }, issues: [cropArtefact] },
      },
    };
    const listed = listEntity(report);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ character: 'Julian', type: 'cutout_artifact', severity: 'MAJOR' });
    const billed = entityIssuesForPage(PAGE, report);
    expect(billed.issues).toHaveLength(1);
    expect(billed.issues[0].name).toBe('Julian');
  });

  it('a finding carried both in byClothing and at the root is listed once', () => {
    const report = {
      characters: {
        Julian: {
          byClothing: { standard: { issues: [{ ...cropArtefact }] } },
          issues: [cropArtefact],
        },
      },
    };
    expect(listEntity(report)).toHaveLength(1);
    expect(entityIssuesForPage(PAGE, report).issues).toHaveLength(1);
  });

  it('the list and the bill hold the same findings, characters and objects, on-page only', () => {
    const report = {
      characters: {
        Julian: { byClothing: { standard: { issues: [] } }, issues: [cropArtefact] },
        Max: { issues: [{ type: 'consistency', subType: 'face_mismatch', severity: 'CRITICAL', pageNumber: 4, description: 'different face' }] },
      },
      objects: {
        Lantern: { issues: [{ type: 'consistency', subType: 'colour', severity: 'MINOR', pagesToFix: [PAGE], description: 'lantern colour differs' }] },
      },
    };
    const listed = listEntity(report).map((i: any) => i.character).sort();
    const billed = entityIssuesForPage(PAGE, report).issues.map((i: any) => i.name).sort();
    const raw = entityFindingsForPage(PAGE, report).map((f: any) => f.name).sort();
    expect(listed).toEqual(['Julian', 'Lantern']);
    expect(billed).toEqual(listed);
    expect(raw).toEqual(listed);
  });
});
