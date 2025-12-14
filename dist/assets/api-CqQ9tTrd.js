import{c}from"./Input-C08XayKZ.js";/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const y=c("ArrowLeft",[["path",{d:"m12 19-7-7 7-7",key:"1l729n"}],["path",{d:"M19 12H5",key:"x3x0zl"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const f=c("Trash2",[["path",{d:"M3 6h18",key:"d0wm0j"}],["path",{d:"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6",key:"4alrt4"}],["path",{d:"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2",key:"v07s0e"}],["line",{x1:"10",x2:"10",y1:"11",y2:"17",key:"1uufr5"}],["line",{x1:"14",x2:"14",y1:"11",y2:"17",key:"xtxkd"}]]),i="";class d{getToken(){return localStorage.getItem("auth_token")}getHeaders(t=!1){const e={"Content-Type":"application/json"};if(!t){const r=this.getToken();r&&(e.Authorization=`Bearer ${r}`)}return e}async request(t,e={}){const{skipAuth:r=!1,...o}=e,s=await fetch(`${i}${t}`,{...o,headers:{...this.getHeaders(r),...o.headers}});if(!s.ok){const a=await s.json().catch(()=>({error:"Request failed"}));throw new Error(a.error||a.message||`HTTP ${s.status}`)}const n=await s.text();return n?JSON.parse(n):{}}async get(t,e){return this.request(t,{...e,method:"GET"})}async post(t,e,r){return this.request(t,{...r,method:"POST",body:e?JSON.stringify(e):void 0})}async put(t,e,r){return this.request(t,{...r,method:"PUT",body:e?JSON.stringify(e):void 0})}async patch(t,e,r){return this.request(t,{...r,method:"PATCH",body:e?JSON.stringify(e):void 0})}async delete(t,e){return this.request(t,{...e,method:"DELETE"})}async uploadFile(t,e,r){const o=new FormData;o.append("file",e),r&&Object.entries(r).forEach(([a,h])=>{o.append(a,h)});const s=this.getToken(),n=await fetch(`${i}${t}`,{method:"POST",headers:s?{Authorization:`Bearer ${s}`}:{},body:o});if(!n.ok){const a=await n.json().catch(()=>({error:"Upload failed"}));throw new Error(a.error||"Upload failed")}return n.json()}}const l=new d;export{y as A,f as T,l as a};
