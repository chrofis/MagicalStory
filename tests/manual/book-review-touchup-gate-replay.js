// Replays stored Lab #1768 TOUCHUP plans through the inpaint type gates (free, no model call).
// usage: node tests/manual/book-review-touchup-gate-replay.js <plan.json> [<plan.json>...]
const { typesAreInpaintable } = require('../../server/lib/repairLogic');
for (const f of process.argv.slice(2)) {
  for (const e of [].concat(require(require('path').resolve(f)))) {
    if (e.stage !== 'inpaint') continue;
    const { consolidatedPlan: plan } = e.params;
    const stripped = { ...plan }; delete stripped.reviewerDecided; plan.reviewerDecided = true; // stored plans predate the flag; buildTouchupPlan now sets it
    const sceneTypes = plan.scene_fix?.types || [];
    const show = (label, p) => {
      const sceneOk = plan.scene_fix && typesAreInpaintable(sceneTypes, p);
      const chars = (plan.per_character_fixes || []).filter(c => typesAreInpaintable(c.types, p));
      const items = [];
      if (sceneOk) items.push(plan.scene_fix.instruction);
      for (const c of chars) items.push(`For ${c.visual_identifier || 'this character'}: ${c.fix_instruction}`);
      console.log(`  ${label}: ${items.length ? items.map((t, i) => `${i + 1}. ${t}`).join(' | ') : '(EMPTY - no image call)'}`);
    };
    console.log(`${e.storyId} p${e.page} sceneTypes=${sceneTypes} perChar=${(plan.per_character_fixes || []).map(c => c.types)}`);
    show('before', stripped); show('after ', plan);
  }
}
