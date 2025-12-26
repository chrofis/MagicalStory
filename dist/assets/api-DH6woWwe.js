import{c as u,j as a}from"./index-DMhOpvgv.js";import{b as f}from"./vendor-react-CHhk3aw2.js";/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const w=u("BookOpen",[["path",{d:"M12 7v14",key:"1akyts"}],["path",{d:"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",key:"ruj8y"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const v=u("CreditCard",[["rect",{width:"20",height:"14",x:"2",y:"5",rx:"2",key:"ynyp8z"}],["line",{x1:"2",x2:"22",y1:"10",y2:"10",key:"1b3vmo"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const j=u("Users",[["path",{d:"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",key:"1yyitq"}],["circle",{cx:"9",cy:"7",r:"4",key:"nufk8"}],["path",{d:"M22 21v-2a4 4 0 0 0-3-3.87",key:"kshegd"}],["path",{d:"M16 3.13a4 4 0 0 1 0 7.75",key:"1da9ce"}]]),g={primary:"bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg hover:shadow-xl",secondary:"bg-indigo-100 text-indigo-700 hover:bg-indigo-200",outline:"border-2 border-indigo-600 text-indigo-600 hover:bg-indigo-50",ghost:"text-indigo-600 hover:bg-indigo-50",danger:"bg-red-600 text-white hover:bg-red-700"},y={sm:"px-3 py-1.5 text-sm",md:"px-4 py-2 text-base",lg:"px-6 py-3 text-lg"};function $({variant:l="primary",size:t="md",icon:e,iconPosition:r="left",loading:o=!1,disabled:i,className:d="",children:s,...n}){const h=i||o;return a.jsxs("button",{className:`
        inline-flex items-center justify-center gap-2 rounded-lg font-medium
        transition-all duration-200 transform hover:scale-[1.02]
        disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none
        ${g[l]}
        ${y[t]}
        ${d}
      `,disabled:h,...n,children:[o?a.jsxs("svg",{className:"animate-spin h-5 w-5",viewBox:"0 0 24 24",children:[a.jsx("circle",{className:"opacity-25",cx:"12",cy:"12",r:"10",stroke:"currentColor",strokeWidth:"4",fill:"none"}),a.jsx("path",{className:"opacity-75",fill:"currentColor",d:"M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"})]}):e&&r==="left"?a.jsx(e,{size:t==="sm"?16:t==="lg"?24:20}):null,s,!o&&e&&r==="right"&&a.jsx(e,{size:t==="sm"?16:t==="lg"?24:20})]})}const m=f.forwardRef(({label:l,error:t,helperText:e,className:r="",...o},i)=>a.jsxs("div",{className:"w-full",children:[l&&a.jsxs("label",{className:"block text-sm font-medium text-gray-700 mb-1",children:[l,o.required&&a.jsx("span",{className:"text-red-500 ml-1",children:"*"})]}),a.jsx("input",{ref:i,className:`
            w-full px-4 py-2 rounded-lg border
            transition-all duration-200
            focus:outline-none focus:ring-2
            ${t?"border-red-300 focus:ring-red-500 focus:border-red-500":"border-gray-300 focus:ring-purple-500 focus:border-purple-500"}
            disabled:bg-gray-100 disabled:cursor-not-allowed
            ${r}
          `,...o}),t&&a.jsx("p",{className:"mt-1 text-sm text-red-600",children:t}),e&&!t&&a.jsx("p",{className:"mt-1 text-sm text-gray-500",children:e})]}));m.displayName="Input";const p="";class x{getToken(){return localStorage.getItem("auth_token")}getHeaders(t=!1){const e={"Content-Type":"application/json"};if(!t){const r=this.getToken();r&&(e.Authorization=`Bearer ${r}`)}return e}async request(t,e={}){const{skipAuth:r=!1,...o}=e,i=await fetch(`${p}${t}`,{...o,headers:{...this.getHeaders(r),...o.headers}});if(!i.ok){const s=await i.json().catch(()=>({error:"Request failed"}));let n=s.error||s.message||`HTTP ${i.status}`;if(s.details){const c=s.details;c.message?n+=`: ${c.message}`:c.error?n+=`: ${c.error}`:typeof c=="string"&&(n+=`: ${c}`)}s.activeJobId&&(n+=`|ACTIVE_JOB:${s.activeJobId}`);const h=new Error(n);throw s.retryAfter&&(h.retryAfter=s.retryAfter),s.code&&(h.code=s.code),h}const d=await i.text();return d?JSON.parse(d):{}}async get(t,e){return this.request(t,{...e,method:"GET"})}async post(t,e,r){return this.request(t,{...r,method:"POST",body:e?JSON.stringify(e):void 0})}async put(t,e,r){return this.request(t,{...r,method:"PUT",body:e?JSON.stringify(e):void 0})}async patch(t,e,r){return this.request(t,{...r,method:"PATCH",body:e?JSON.stringify(e):void 0})}async delete(t,e){return this.request(t,{...e,method:"DELETE"})}async uploadFile(t,e,r){const o=new FormData;o.append("file",e),r&&Object.entries(r).forEach(([s,n])=>{o.append(s,n)});const i=this.getToken(),d=await fetch(`${p}${t}`,{method:"POST",headers:i?{Authorization:`Bearer ${i}`}:{},body:o});if(!d.ok){const s=await d.json().catch(()=>({error:"Upload failed"}));throw new Error(s.error||"Upload failed")}return d.json()}}const N=new x;export{$ as B,v as C,m as I,j as U,w as a,N as b};
