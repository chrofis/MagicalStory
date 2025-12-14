import{c as i}from"./Input-I7_OcrMN.js";/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const l=i("ArrowLeft",[["path",{d:"m12 19-7-7 7-7",key:"1l729n"}],["path",{d:"M19 12H5",key:"x3x0zl"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const u=i("Download",[["path",{d:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",key:"ih7n3h"}],["polyline",{points:"7 10 12 15 17 10",key:"2ggqvy"}],["line",{x1:"12",x2:"12",y1:"15",y2:"3",key:"1vk2je"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const k=i("FileText",[["path",{d:"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",key:"1rqfz7"}],["path",{d:"M14 2v4a2 2 0 0 0 2 2h4",key:"tnqrlb"}],["path",{d:"M10 9H8",key:"b1mrlr"}],["path",{d:"M16 13H8",key:"t4e002"}],["path",{d:"M16 17H8",key:"z1uh3a"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const f=i("LoaderCircle",[["path",{d:"M21 12a9 9 0 1 1-6.219-8.56",key:"13zald"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const T=i("Pen",[["path",{d:"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",key:"1a8usu"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const w=i("Trash2",[["path",{d:"M3 6h18",key:"d0wm0j"}],["path",{d:"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6",key:"4alrt4"}],["path",{d:"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2",key:"v07s0e"}],["line",{x1:"10",x2:"10",y1:"11",y2:"17",key:"1uufr5"}],["line",{x1:"14",x2:"14",y1:"11",y2:"17",key:"xtxkd"}]]),h="";class d{getToken(){return localStorage.getItem("auth_token")}getHeaders(t=!1){const e={"Content-Type":"application/json"};if(!t){const r=this.getToken();r&&(e.Authorization=`Bearer ${r}`)}return e}async request(t,e={}){const{skipAuth:r=!1,...o}=e,a=await fetch(`${h}${t}`,{...o,headers:{...this.getHeaders(r),...o.headers}});if(!a.ok){const n=await a.json().catch(()=>({error:"Request failed"}));throw new Error(n.error||n.message||`HTTP ${a.status}`)}const s=await a.text();return s?JSON.parse(s):{}}async get(t,e){return this.request(t,{...e,method:"GET"})}async post(t,e,r){return this.request(t,{...r,method:"POST",body:e?JSON.stringify(e):void 0})}async put(t,e,r){return this.request(t,{...r,method:"PUT",body:e?JSON.stringify(e):void 0})}async patch(t,e,r){return this.request(t,{...r,method:"PATCH",body:e?JSON.stringify(e):void 0})}async delete(t,e){return this.request(t,{...e,method:"DELETE"})}async uploadFile(t,e,r){const o=new FormData;o.append("file",e),r&&Object.entries(r).forEach(([n,c])=>{o.append(n,c)});const a=this.getToken(),s=await fetch(`${h}${t}`,{method:"POST",headers:a?{Authorization:`Bearer ${a}`}:{},body:o});if(!s.ok){const n=await s.json().catch(()=>({error:"Upload failed"}));throw new Error(n.error||"Upload failed")}return s.json()}}const m=new d;export{l as A,u as D,k as F,f as L,T as P,w as T,m as a};
