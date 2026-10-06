// Console harness (no model calls): rebuild planner / typed / replan / plan-check prompts from stored inputs, replay counters.
const path = require('path'); const fs = require('fs');
const WT = 'C:/Users/roger/MagicalStory/.claude/worktrees/planner-apply';
const RV = path.join(__dirname, '../rv');
const OUT = __dirname;
process.chdir(WT);
(async () => {
  await require(WT + '/server/services/prompts').loadPromptTemplates();
  const PB = require(WT + '/server/lib/promptBuilders');
  const BR = require(WT + '/server/lib/beatsReplayInputs');
  const PC = require(WT + '/server/lib/planCounters');
  const BP = require(WT + '/server/lib/beatsPipeline');
  const { parseBeats } = require(WT + '/server/lib/storyHelpers');
  for (const tag of ['A', 'B']) {
    const raw = require(`${RV}/${tag}_story.json`);
    const storyData = BR.resolveReplayInputData(raw);
    const arc = BR.resolveReplayArc(storyData, { parseBeats });
    const hints = BR.resolveReplayArcHints(storyData);
    const central = BR.resolveReplayCentralFigure(storyData);
    const logicText = BR.resolveReplayStoryLogic(storyData);
    const pageCount = parseInt(storyData.pages, 10);
    const rep = raw.beatsReviewReport;
    const castTable = require(WT + '/server/lib/castCoverage').parsePlanCastBlock(rep.plannerReply, { listed: (storyData.characters || []).map(c => c.name) });
    const base = { finalArc: arc, arcHints: hints, storyLogic: logicText, centralFigure: central };
    fs.writeFileSync(`${OUT}/${tag}_prod.txt`, PB.buildBeatsPrompt(storyData, pageCount, base));
    fs.writeFileSync(`${OUT}/${tag}_typed.txt`, PB.buildBeatsPrompt(storyData, pageCount, { ...base, typedPlan: true }));
    fs.writeFileSync(`${OUT}/${tag}_check.txt`, PB.buildPlanCheckPrompt(storyData, new Array(pageCount).fill({}), arc, rep.pagePlan, { arcHints: hints, storyLogic: logicText, centralFigure: central, castTable }));
    // counters over the stored plan with the stored check reply's roster
    const pages = rep.pagePlan.split('\n').filter(l => /^Page \d+:/.test(l)).map(l => { const m = l.match(/^Page (\d+):\s*(.*)$/); return { pageNumber: +m[1], planLine: m[2] }; });
    const roster = PB.parsePlanCheckRoster(rep.checkReply);
    const inputs = BP.planCheckInputs(storyData, { arcPremiseNames: PB.parseStoryLogic(`STORY LOGIC:\n${logicText}`).commissioned, modelOverrides: storyData.modelOverrides });
    const logic = PB.parseStoryLogic(`STORY LOGIC:\n${logicText}`);
    const counters = PC.runPlanCounters({ pages, commissionedNames: inputs.commissionedNames, listedNames: inputs.commission.listed, placeNames: inputs.placeNames, maxCharactersPerScene: inputs.maxCast, declaredInvented: logic.invented, inventedAllowance: PB.arcInventedAllowance(storyData), roster, peoplelessPick: PB.parsePlanCheckPeoplelessPick(rep.checkReply), centralFigure: central, centralPages: PB.parsePlanCheckCentralPages(rep.checkReply), mainName: PB.pickMainCharacters(storyData).focus?.name || null, castTable, actions: PB.parsePlanCheckActions(rep.checkReply) });
    fs.writeFileSync(`${OUT}/${tag}_counters.txt`, counters.findings.map((f, i) => `${f.code} p${(f.pages || []).join(',')}: ${f.detail}`).join('\n'));
    // replan section from the stored findings
    const items = counters.findings.map((f, i) => ({ kind: 'counter', code: f.code, line: counters.lines[i] }));
    const sec = PB.buildReplanSection(rep.pagePlan, items, { pageCount, castFloor: 3, castTable });
    fs.writeFileSync(`${OUT}/${tag}_replan.txt`, PB.buildBeatsPrompt(storyData, pageCount, { ...base, castTable, replan: sec }));
    console.log(tag, 'counters:', counters.findings.map(f => f.code + '@' + (f.pages || []).join('/')).join(' | '));
  }
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
