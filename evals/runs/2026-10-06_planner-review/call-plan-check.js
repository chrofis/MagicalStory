const path = require('path'); const fs = require('fs');
const WT = 'C:/Users/roger/MagicalStory/.claude/worktrees/planner-apply';
const OUT = __dirname; process.chdir(WT);
require(WT + '/node_modules/dotenv').config({ path: 'C:/Users/roger/MagicalStory/.env' });
(async () => {
  const tm = require(WT + '/server/lib/textModels');
  const M = require(WT + '/server/config/models');
  const model = 'gpt-5.6-luna-pro';
  let total = 0;
  for (const tag of process.argv.slice(2)) {
    const prompt = fs.readFileSync(`${OUT}/${tag}_check.txt`, 'utf8');
    const res = await tm.callTextModelStreaming(prompt, null, null, model, { usageLabel: 'planner_review_check', temperature: 0 });
    const cost = res.usage?.direct_cost ?? M.calculateTextCost(res.modelId || '', res.usage || {});
    total += cost || 0;
    fs.writeFileSync(`${OUT}/${tag}_checkReply_new.txt`, String(res.text || ''));
    console.log(tag, 'chars', String(res.text || '').length, 'cost', cost, JSON.stringify(res.usage || {}).slice(0, 200));
  }
  console.log('TOTAL', total);
})().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
