const BASE='https://staging.magicalstory.ch';
(async()=>{
  const login=await fetch(`${BASE}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:process.env.TESTLAB_USER||'demo-b-hnecf@magicalstory.ch',password:process.env.TESTLAB_PASSWORD||'DemoStory2026!'})});
  const {token}=await login.json();
  const r=await fetch(`${BASE}/api/admin/testlab/experiments/852`,{headers:{Authorization:`Bearer ${token}`}});
  const j=await r.json();
  console.log('status:', j.status, '| results:', (j.results||[]).length, '| error:', j.error||'(none)');
  require('fs').writeFileSync(process.env.OUT, JSON.stringify(j));
})();
