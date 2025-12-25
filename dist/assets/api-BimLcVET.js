import{c as h,j as o}from"./index-BkdvBRNB.js";import{b as p}from"./vendor-react-CHhk3aw2.js";/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const k=h("BookOpen",[["path",{d:"M12 7v14",key:"1akyts"}],["path",{d:"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",key:"ruj8y"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const w=h("CreditCard",[["rect",{width:"20",height:"14",x:"2",y:"5",rx:"2",key:"ynyp8z"}],["line",{x1:"2",x2:"22",y1:"10",y2:"10",key:"1b3vmo"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const v=h("Users",[["path",{d:"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",key:"1yyitq"}],["circle",{cx:"9",cy:"7",r:"4",key:"nufk8"}],["path",{d:"M22 21v-2a4 4 0 0 0-3-3.87",key:"kshegd"}],["path",{d:"M16 3.13a4 4 0 0 1 0 7.75",key:"1da9ce"}]]),g={primary:"bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg hover:shadow-xl",secondary:"bg-indigo-100 text-indigo-700 hover:bg-indigo-200",outline:"border-2 border-indigo-600 text-indigo-600 hover:bg-indigo-50",ghost:"text-indigo-600 hover:bg-indigo-50",danger:"bg-red-600 text-white hover:bg-red-700"},m={sm:"px-3 py-1.5 text-sm",md:"px-4 py-2 text-base",lg:"px-6 py-3 text-lg"};function j({variant:l="primary",size:t="md",icon:e,iconPosition:s="left",loading:r=!1,disabled:i,className:d="",children:a,...n}){const c=i||r;return o.jsxs("button",{className:`
        inline-flex items-center justify-center gap-2 rounded-lg font-medium
        transition-all duration-200 transform hover:scale-[1.02]
        disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none
        ${g[l]}
        ${m[t]}
        ${d}
      `,disabled:c,...n,children:[r?o.jsxs("svg",{className:"animate-spin h-5 w-5",viewBox:"0 0 24 24",children:[o.jsx("circle",{className:"opacity-25",cx:"12",cy:"12",r:"10",stroke:"currentColor",strokeWidth:"4",fill:"none"}),o.jsx("path",{className:"opacity-75",fill:"currentColor",d:"M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"})]}):e&&s==="left"?o.jsx(e,{size:t==="sm"?16:t==="lg"?24:20}):null,a,!r&&e&&s==="right"&&o.jsx(e,{size:t==="sm"?16:t==="lg"?24:20})]})}const f=p.forwardRef(({label:l,error:t,helperText:e,className:s="",...r},i)=>o.jsxs("div",{className:"w-full",children:[l&&o.jsxs("label",{className:"block text-sm font-medium text-gray-700 mb-1",children:[l,r.required&&o.jsx("span",{className:"text-red-500 ml-1",children:"*"})]}),o.jsx("input",{ref:i,className:`
            w-full px-4 py-2 rounded-lg border
            transition-all duration-200
            focus:outline-none focus:ring-2
            ${t?"border-red-300 focus:ring-red-500 focus:border-red-500":"border-gray-300 focus:ring-purple-500 focus:border-purple-500"}
            disabled:bg-gray-100 disabled:cursor-not-allowed
            ${s}
          `,...r}),t&&o.jsx("p",{className:"mt-1 text-sm text-red-600",children:t}),e&&!t&&o.jsx("p",{className:"mt-1 text-sm text-gray-500",children:e})]}));f.displayName="Input";const u="";class y{getToken(){return localStorage.getItem("auth_token")}getHeaders(t=!1){const e={"Content-Type":"application/json"};if(!t){const s=this.getToken();s&&(e.Authorization=`Bearer ${s}`)}return e}async request(t,e={}){const{skipAuth:s=!1,...r}=e,i=await fetch(`${u}${t}`,{...r,headers:{...this.getHeaders(s),...r.headers}});if(!i.ok){const a=await i.json().catch(()=>({error:"Request failed"}));let n=a.error||a.message||`HTTP ${i.status}`;if(a.details){const c=a.details;c.message?n+=`: ${c.message}`:c.error?n+=`: ${c.error}`:typeof c=="string"&&(n+=`: ${c}`)}throw a.activeJobId&&(n+=`|ACTIVE_JOB:${a.activeJobId}`),new Error(n)}const d=await i.text();return d?JSON.parse(d):{}}async get(t,e){return this.request(t,{...e,method:"GET"})}async post(t,e,s){return this.request(t,{...s,method:"POST",body:e?JSON.stringify(e):void 0})}async put(t,e,s){return this.request(t,{...s,method:"PUT",body:e?JSON.stringify(e):void 0})}async patch(t,e,s){return this.request(t,{...s,method:"PATCH",body:e?JSON.stringify(e):void 0})}async delete(t,e){return this.request(t,{...e,method:"DELETE"})}async uploadFile(t,e,s){const r=new FormData;r.append("file",e),s&&Object.entries(s).forEach(([a,n])=>{r.append(a,n)});const i=this.getToken(),d=await fetch(`${u}${t}`,{method:"POST",headers:i?{Authorization:`Bearer ${i}`}:{},body:r});if(!d.ok){const a=await d.json().catch(()=>({error:"Upload failed"}));throw new Error(a.error||"Upload failed")}return d.json()}}const $=new y;export{j as B,w as C,f as I,v as U,k as a,$ as b};
