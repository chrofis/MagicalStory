require('dotenv').config();
const { Pool } = require('pg');
const want={ job_1788820396445_9erw6xc01:[9],job_1789227389389_z18dmvnt6:[10],job_1789853503332_riqncqg1i:[4],job_1790373080139_vnx5l8iy7:[12],job_1792078014622_uh8tj6ht1:[7],job_1792859316244_6429d0n83:[7,8],job_1791918618204_ssjxzvmp4:[1,2,3,13]};
(async()=>{const pool=new Pool({connectionString:process.env.DATABASE_PUBLIC_URL||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const pool2=new Pool({connectionString:process.env.STAGING_DATABASE_URL,ssl:{rejectUnauthorized:false}});
for(const [id,pp] of Object.entries(want)){ let r=await pool.query(`SELECT data->'beatsReviewReport'->'briefsIn' bi FROM stories WHERE id=$1`,[id]); if(!r.rows.length) r=await pool2.query(`SELECT data->'beatsReviewReport'->'briefsIn' bi FROM stories WHERE id=$1`,[id]);
 console.log('##',id); for(const b of r.rows[0].bi) if(pp.includes(b.pageNumber)) console.log(' p'+b.pageNumber+': '+((String(b.brief).match(/PLAN:\s*([\s\S]*)$/i)||[])[1]||'').trim().slice(0,400));}
await pool.end();await pool2.end();})();
