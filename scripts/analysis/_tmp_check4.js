const fs=require('fs');
const SP=process.env.SP;
for (const f of ['staging','prod']) {
  const j=JSON.parse(fs.readFileSync(`${SP}/${f}.json`,'utf8'));
  const pages=j.data.sceneImages||[];
  console.log(`\n===== ${f} : ${j.title} =====`);
  for (const p of pages) {
    const rh=(p.retryHistory||[]).map(r=>`${r.type}/${r.source||''}${r.charName?'('+r.charName+')':''}=${r.score}`).join(' ; ');
    const iv=(p.imageVersions||[]).map(v=>`${v.source}:${v.finalScore}`).join(' ');
    console.log(`p${String(p.pageNumber).padStart(2)} fin=${String(p.finalScore).padStart(3)} q=${String(p.qualityScore).padStart(3)} | versions[${iv}] | retries: ${rh}`);
    const qr=p.qualityReasoning;
    if (qr) console.log('     reasoning:', String(qr).replace(/\s+/g,' ').slice(0,400));
  }
  // where do findings live?
  const p1=pages[0];
  console.log('\n-- qualityRawOutput sample --');
  console.log(String(p1.qualityRawOutput||'(none)').slice(0,2500));
}
