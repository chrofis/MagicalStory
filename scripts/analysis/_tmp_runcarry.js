const BASE='https://staging.magicalstory.ch';
const EMAIL=process.env.TESTLAB_USER||'demo-b-hnecf@magicalstory.ch';
const PASSWORD=process.env.TESTLAB_PASSWORD||'DemoStory2026!';
(async()=>{
  const login=await fetch(`${BASE}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:EMAIL,password:PASSWORD})});
  if(!login.ok){console.error('login failed',login.status);process.exit(1);}
  const {token}=await login.json();
  const body={
    stage:'beats_scenes',
    label:'Carry A/B — stored beats through the Art Director',
    params:{ useStoredBeats:true, alsoText:true },
    targets:[{storyId:'job_1787638394061_hs70901tfsn'}],
  };
  const res=await fetch(`${BASE}/api/admin/testlab/experiments`,{method:'POST',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
    body:JSON.stringify(body)});
  const out=await res.json().catch(()=>({}));
  console.log(res.status, JSON.stringify(out).slice(0,400));
})();
