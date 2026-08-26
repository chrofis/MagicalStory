require("dotenv").config();
process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL || process.env.DATABASE_URL;
process.env.PHOTO_ANALYZER_URL = "http://127.0.0.1:5000";
const dbsvc = require("./server/services/database"); dbsvc.initializePool();
const { dbQuery } = dbsvc;
const { runStageOnTarget } = require("./server/lib/testlab");

(async () => {
  await require("./server/services/prompts").loadPromptTemplates();
  const members = await dbQuery("SELECT target, params FROM testlab_set_members WHERE set_id=2 ORDER BY id");
  const ins = await dbQuery(
    `INSERT INTO testlab_experiments (stage,label,params,status,targets,created_by,target_count,results_count)
     VALUES ('avatar_eval',$1,$2,'running',$3,$4,$5,0) RETURNING id`,
    ["Set #2 re-run — headless-detection fix + single-source eval", JSON.stringify({ setId: 2 }),
     JSON.stringify([]), "claude (set verify)", members.length]);
  const expId = ins[0].id;
  console.log("Set-run experiment #" + expId + " (" + members.length + " members)");
  for (const m of members) {
    const t = m.target || {}; const p = m.params || {};
    const pass = Number(p.pass ?? 1);
    const startedAt = new Date().toISOString(); let entry;
    try {
      const r = await runStageOnTarget("avatar_eval", { storyId: t.storyId, character: t.character, pass },
        { params: { pass, model: "gemini-2.5-flash" }, experimentId: expId });
      const rep = r.report || {};
      entry = { storyId: t.storyId, character: t.character, pass, ok: true, startedAt, ...r };
      const bodies = rep.bodies?.fullBody;
      console.log(`  ${t.character} p${pass}: final=${rep.finalScore} valid=${rep.valid}` +
        (pass === 1 ? ` | bodies=${bodies?.fullBodyScore} (${(bodies?.reason||"").slice(0,60)})` : ` | identity=${rep.identityScore} style=${rep.styleScore}`));
    } catch (e) {
      entry = { storyId: t.storyId, character: t.character, pass, ok: false, startedAt, error: e.message };
      console.log(`  ${t.character} p${pass}: ERR ${e.message}`);
    }
    await dbQuery(`UPDATE testlab_experiments SET results=results||$2::jsonb, results_count=results_count+1 WHERE id=$1`, [expId, JSON.stringify([entry])]);
  }
  await dbQuery(`UPDATE testlab_experiments SET status='completed', completed_at=NOW() WHERE id=$1`, [expId]);
  console.log("DONE set-run #" + expId);
  process.exit(0);
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
