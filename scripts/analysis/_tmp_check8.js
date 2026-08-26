const fs=require('fs');
const SP=process.env.SP;
const MARKERS={
  'action-field rule':      /Name the physical activity/i,
  'hands one-pair rule':    /One object takes one pair of hands/i,
  'cap one action label':   /one action label per page beyond/i,
  '12c writing = marks':    /pictorial marks|as marks, not|never as legible/i,
  '12d held doc is read':   /read, not displayed|angled toward the (character|reader)|not toward the (viewer|camera)/i,
};
for (const f of ['staging','prod']) {
  const j=JSON.parse(fs.readFileSync(`${SP}/${f}.json`,'utf8'));
  const pages=j.data.sceneImages||[];
  const p=pages.find(x=>x.sceneDescriptionPrompt) || {};
  const t=String(p.sceneDescriptionPrompt||'');
  console.log(`\n== ${f} == prompt len ${t.length}, from page ${p.pageNumber}, model ${p.sceneDescriptionModelId}`);
  for (const [n,re] of Object.entries(MARKERS)) console.log(`   ${re.test(t)?'YES':'no '}  ${n}`);
  // is it the all-template (beats) or per-page?
  console.log('   template shape:', /ALL PAGES|every page below|PAGES TO EXPAND/i.test(t)?'ALL (beats)':'per-page');
}
