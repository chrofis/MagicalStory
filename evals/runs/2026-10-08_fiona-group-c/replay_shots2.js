// node replay2.js <storyId|synthetic> <orig|v1|v2> [pageFilter]
process.chdir('C:/Users/roger/MagicalStory');
require('dotenv').config({path:'C:/Users/roger/MagicalStory/.env'});
const SV=require('C:/Users/roger/MagicalStory/server/lib/shotVocabulary');
const R={orig:"Over-the-shoulder never goes on a page where the near figure touches what they face — a hand laid on it, a grip, a lean against it, a hand-over: whatever is touched is within arm's reach and cannot sit small and deep in the far corner. Such a page takes another shot.",
v1:"Over-the-shoulder never goes on a page where the near figure's hands act — a hand laid on something, a grip, a lean against it, a hand-over, tucking something away or taking it out: the crop shows no hands, and whatever they act on is within arm's reach, not small and deep in the far corner. Such a page takes another shot."};
if(R[process.argv[3]])SV.OTS_NO_CONTACT_RULE=R[process.argv[3]];
const JD=require('C:/Users/roger/MagicalStory/server/lib/jevDecisions');
const {Pool}=require('pg');
(async()=>{
  const P=SV.PLAN_SHOT_PLACEHOLDER;let arc,pages,present;
  if(process.argv[2]==='synthetic'){
    arc='1. A hunter and his daughter reach the practice field.\n2. The hunter draws his bow at the straw target far down the field.\n3. The old guide hands the hunter a new arrow.\n4. The daughter takes the bow, steps back.\n5. The daughter points at the far hill.\n6. The guide tucks the map inside his coat.';
    const L=['Hunter, Daughter — they walk onto the practice field at dawn — the field is theirs','Hunter, Guide — the hunter draws his bow and aims at the straw target far down the field — the shot is about to fly','Hunter, Guide — the guide hands the hunter a new arrow from his quiver — the hunter now holds two arrows','Daughter, Hunter — the daughter points at the far hill while her father watches — they know where to go','Guide, Hunter — the guide tucks the folded map into his coat while the hunter watches him — the map is hidden','Hunter, Daughter — they walk off the field together — the day ends'];
    pages=L.map((l,i)=>({pageNumber:i+1,planLine:P+' — '+l}));
    present=new Map(L.map((l,i)=>[i+1,l.split(' — ')[0].split(', ')]));
  } else {
    const p=new Pool({connectionString:process.env.STAGING_DATABASE_URL,ssl:{rejectUnauthorized:false}});
    const r=await p.query("select data->'beatsReviewReport' b from stories where id=$1",[process.argv[2]]);const b=r.rows[0].b;
    arc=b.arc;
    pages=b.pagePlan.split('\n').map(l=>{const m=l.match(/^Page (\d+): (.*)$/);const parts=m[2].split(' — ');parts[0]=P;return {pageNumber:+m[1],planLine:parts.join(' — ')}});
    present=new Map(b.rosterLines.filter(x=>x.pageNumber>0).map(x=>[x.pageNumber,x.people]));
    await p.end();
  }
  const out=await JD.decideShots({arc,pages,present});
  console.log(process.argv[2],process.argv[3],'OTS scores',out.pages.map(p=>`p${p.pageNumber}:${p.scores['over-the-shoulder']}`).join(' '));
  console.log(' shots',out.shots.join(' '),'| cost',out.stats.costUsd);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
