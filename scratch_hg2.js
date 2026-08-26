require('dotenv').config();
const { Pool } = require('pg');
const fs=require('fs');
const D='C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/53ca16ce-9e51-4b2f-a36b-c324ee59638f/scratchpad/';
const ID='job_1786780194082_s980g4s9a';
const p=new Pool({connectionString:process.env.STAGING_DATABASE_URL,ssl:{rejectUnauthorized:false}});
(async()=>{
  const d=(await p.query("select data from stories where id=$1",[ID])).rows[0].data;
  const grids=d.finalChecksReport?.entityHistory?.[0]?.report?.grids||{};
  for(const [k,g] of Object.entries(grids)){
    const has=!!g.headGridImage, hasMain=!!g.gridImage;
    console.log(`grid ${k} ${g.entityName}: gridImage=${hasMain?'yes':'NO'} headGridImage=${has?'yes ('+Math.round(String(g.headGridImage).length/1024)+'kb)':'NO'}`);
    if(k==='0'){
      if(hasMain) fs.writeFileSync(D+'ent_body.jpg', Buffer.from(String(g.gridImage).split(',')[1],'base64'));
      if(has) fs.writeFileSync(D+'ent_head.jpg', Buffer.from(String(g.headGridImage).split(',')[1],'base64'));
    }
  }
  await p.end();
})();
