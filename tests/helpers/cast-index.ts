/**
 * The brief checks take the story's cast index (castResolver.buildCastIndex,
 * built once by the real caller). Fixtures build theirs here, from the same
 * cast + Visual Bible the check is handed.
 */
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { buildCastIndex } = req('../../server/lib/castResolver');

export const castIndexOf = (cast: any[] = [], visualBible: any = null) =>
  buildCastIndex({ characters: (cast || []).map((c: any) => (typeof c === 'string' ? { name: c } : c)) }, visualBible);

/** A collectBriefFindings / runBriefChecks ctx with its cast index. */
export const ctxWithIndex = (ctx: any) => ({ ...ctx, castIndex: castIndexOf(ctx.inputData?.characters || [], ctx.visualBible || null) });

// Wrappers for the checks that compare names: same signatures the tests were
// written against, the index built from the cast and Visual Bible they pass.
const sbc = req('../../server/lib/sceneBriefCheck');
const sm = req('../../server/lib/sceneMetadata');
const ib = req('../../server/lib/iterateBeat');
const scc = req('../../server/lib/sceneConsistencyCheck');

export const checkPage = (page: any, cast: any[] = [], vb: any = null, opts: any = {}) =>
  sbc.checkPage(page, cast, vb, { ...opts, castIndex: castIndexOf(cast, vb) });
export const checkScenes = (pages: any, cast: any[] = [], vb: any = null, opts: any = {}) =>
  sbc.checkScenes(pages, cast, vb, { ...opts, castIndex: castIndexOf(cast, vb) });
export const checkBiblePageTable = (page: any, metadata: any, vb: any, cast: any[] = []) =>
  sbc.checkBiblePageTable(page, metadata, vb, castIndexOf(cast, vb));
export const checkCastNotInPlan = (page: any, metadata: any, names: string[] = []) =>
  sbc.checkCastNotInPlan(page, metadata, names, castIndexOf(names));
export const findCastMissingFromMetadata = (desc: any, cast: any, md: any = null, also: string[] = []) =>
  sm.findCastMissingFromMetadata(desc, cast, md, also, castIndexOf(Array.isArray(cast) ? cast : []));
export const checkRewrittenBrief = (args: any = {}) =>
  ib.checkRewrittenBrief({ ...args, castIndex: castIndexOf(args.castNames || [], args.visualBible || null) });
export const checkSceneConsistency = (pages: any, raw: any = null, opts: any = {}) =>
  scc.checkSceneConsistency(pages, raw, { ...opts, castIndex: castIndexOf(opts.knownCharacterNames || []) });
export const checkPlanCastCited = (page: any, metadata: any, vb: any, cast: any[] = []) =>
  sbc.checkPlanCastCited(page, metadata, vb, castIndexOf(cast, vb));
