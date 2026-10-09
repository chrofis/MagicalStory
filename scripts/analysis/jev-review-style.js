#!/usr/bin/env node
// STYLE sub-rule classification of the blind audit's findings + sentence inventory (Jev review 2026-10-09).
const fs=require('fs'),path=require('path');
const DIR=path.join(__dirname,'../../evals/runs/2026-10-09_jev-review');
const s=JSON.parse(fs.readFileSync(path.join(DIR,'stories.json'),'utf8'));
const J=require('../../server/lib/jevAudit');
const RULES=[
 ['FRAGMENT',/fragment|caption|broken off|stage direction/i],
 ['ONEPARA',/one-sentence paragraph|drama/i],
 ['LOOK',/look|size|left to (the )?pictures|picture should|comparison|big as|colou?r/i],
 ['EXPLAIN',/explain|justif|excuse|narrator tells|tells what|tells why|sums up|reason to the reader/i],
 ['NAMEDFEEL',/names (his|her|their|its) own|own (shame|fear|sad)|feeling to|tells the feeling|states a feeling|names the feeling/i],
 ['INTENS',/intensifier/i],['BODY',/body clich/i],['SIMILE',/simile|metaphor|decorative/i],
 ['PERSONIF',/personif|wind whisper|acts like a person/i],['TENSE',/tense|präsens|perfekt|present tense/i],
 ['ROLLCALL',/roll call/i],['SETPIECE',/set-piece|paired negation|coined saying|incantation/i],['INVENTRULE',/invents a rule|rule/i],
];
const rows=[];
for(const x of s)for(const f of x.audits.blind.faults.filter(f=>f.cat==='STYLE')){
  const q=(f.text.match(/«([^»]+)»/)||[])[1]||'';const cls=(RULES.find(([,re])=>re.test(f.text))||['OTHER'])[0];
  rows.push({story:x.id,page:f.page,quote:q,cls,text:f.text});}
const c={};rows.forEach(r=>c[r.cls]=(c[r.cls]||0)+1);console.log(c);
fs.writeFileSync(path.join(DIR,'style_findings.json'),JSON.stringify(rows,null,1));
