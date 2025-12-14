import{b as i}from"./vendor-react-BhxjzHy9.js";import{j as s}from"./index-B81BdM2Y.js";/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const x=r=>r.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase(),u=(...r)=>r.filter((e,t,a)=>!!e&&e.trim()!==""&&a.indexOf(e)===t).join(" ").trim();/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */var h={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const b=i.forwardRef(({color:r="currentColor",size:e=24,strokeWidth:t=2,absoluteStrokeWidth:a,className:o="",children:n,iconNode:d,...l},c)=>i.createElement("svg",{ref:c,...h,width:e,height:e,stroke:r,strokeWidth:a?Number(t)*24/Number(e):t,className:u("lucide",o),...l},[...d.map(([m,p])=>i.createElement(m,p)),...Array.isArray(n)?n:[n]]));/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const g=(r,e)=>{const t=i.forwardRef(({className:a,...o},n)=>i.createElement(b,{ref:n,iconNode:e,className:u(`lucide-${x(r)}`,a),...o}));return t.displayName=`${r}`,t};/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const j=g("BookOpen",[["path",{d:"M12 7v14",key:"1akyts"}],["path",{d:"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",key:"ruj8y"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const N=g("Users",[["path",{d:"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",key:"1yyitq"}],["circle",{cx:"9",cy:"7",r:"4",key:"nufk8"}],["path",{d:"M22 21v-2a4 4 0 0 0-3-3.87",key:"kshegd"}],["path",{d:"M16 3.13a4 4 0 0 1 0 7.75",key:"1da9ce"}]]),f={primary:"bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg hover:shadow-xl",secondary:"bg-indigo-100 text-indigo-700 hover:bg-indigo-200",outline:"border-2 border-indigo-600 text-indigo-600 hover:bg-indigo-50",ghost:"text-indigo-600 hover:bg-indigo-50",danger:"bg-red-600 text-white hover:bg-red-700"},y={sm:"px-3 py-1.5 text-sm",md:"px-4 py-2 text-base",lg:"px-6 py-3 text-lg"};function C({variant:r="primary",size:e="md",icon:t,iconPosition:a="left",loading:o=!1,disabled:n,className:d="",children:l,...c}){const m=n||o;return s.jsxs("button",{className:`
        inline-flex items-center justify-center gap-2 rounded-lg font-medium
        transition-all duration-200 transform hover:scale-[1.02]
        disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none
        ${f[r]}
        ${y[e]}
        ${d}
      `,disabled:m,...c,children:[o?s.jsxs("svg",{className:"animate-spin h-5 w-5",viewBox:"0 0 24 24",children:[s.jsx("circle",{className:"opacity-25",cx:"12",cy:"12",r:"10",stroke:"currentColor",strokeWidth:"4",fill:"none"}),s.jsx("path",{className:"opacity-75",fill:"currentColor",d:"M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"})]}):t&&a==="left"?s.jsx(t,{size:e==="sm"?16:e==="lg"?24:20}):null,l,!o&&t&&a==="right"&&s.jsx(t,{size:e==="sm"?16:e==="lg"?24:20})]})}const w=i.forwardRef(({label:r,error:e,helperText:t,className:a="",...o},n)=>s.jsxs("div",{className:"w-full",children:[r&&s.jsxs("label",{className:"block text-sm font-medium text-gray-700 mb-1",children:[r,o.required&&s.jsx("span",{className:"text-red-500 ml-1",children:"*"})]}),s.jsx("input",{ref:n,className:`
            w-full px-4 py-2 rounded-lg border
            transition-all duration-200
            focus:outline-none focus:ring-2
            ${e?"border-red-300 focus:ring-red-500 focus:border-red-500":"border-gray-300 focus:ring-purple-500 focus:border-purple-500"}
            disabled:bg-gray-100 disabled:cursor-not-allowed
            ${a}
          `,...o}),e&&s.jsx("p",{className:"mt-1 text-sm text-red-600",children:e}),t&&!e&&s.jsx("p",{className:"mt-1 text-sm text-gray-500",children:t})]}));w.displayName="Input";export{C as B,w as I,N as U,j as a,g as c};
