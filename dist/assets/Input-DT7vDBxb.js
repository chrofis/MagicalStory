import{b as d}from"./vendor-react-BhxjzHy9.js";import{j as n}from"./index-CSE_lSUT.js";/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const x=r=>r.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase(),c=(...r)=>r.filter((e,t,s)=>!!e&&e.trim()!==""&&s.indexOf(e)===t).join(" ").trim();/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */var y={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const h=d.forwardRef(({color:r="currentColor",size:e=24,strokeWidth:t=2,absoluteStrokeWidth:s,className:o="",children:a,iconNode:i,...u},m)=>d.createElement("svg",{ref:m,...y,width:e,height:e,stroke:r,strokeWidth:s?Number(t)*24/Number(e):t,className:c("lucide",o),...u},[...i.map(([p,f])=>d.createElement(p,f)),...Array.isArray(a)?a:[a]]));/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const l=(r,e)=>{const t=d.forwardRef(({className:s,...o},a)=>d.createElement(h,{ref:a,iconNode:e,className:c(`lucide-${x(r)}`,s),...o}));return t.displayName=`${r}`,t};/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const w=l("BookOpen",[["path",{d:"M12 7v14",key:"1akyts"}],["path",{d:"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",key:"ruj8y"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const j=l("Users",[["path",{d:"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",key:"1yyitq"}],["circle",{cx:"9",cy:"7",r:"4",key:"nufk8"}],["path",{d:"M22 21v-2a4 4 0 0 0-3-3.87",key:"kshegd"}],["path",{d:"M16 3.13a4 4 0 0 1 0 7.75",key:"1da9ce"}]]),g=d.forwardRef(({label:r,error:e,helperText:t,className:s="",...o},a)=>n.jsxs("div",{className:"w-full",children:[r&&n.jsxs("label",{className:"block text-sm font-medium text-gray-700 mb-1",children:[r,o.required&&n.jsx("span",{className:"text-red-500 ml-1",children:"*"})]}),n.jsx("input",{ref:a,className:`
            w-full px-4 py-2 rounded-lg border
            transition-all duration-200
            focus:outline-none focus:ring-2
            ${e?"border-red-300 focus:ring-red-500 focus:border-red-500":"border-gray-300 focus:ring-purple-500 focus:border-purple-500"}
            disabled:bg-gray-100 disabled:cursor-not-allowed
            ${s}
          `,...o}),e&&n.jsx("p",{className:"mt-1 text-sm text-red-600",children:e}),t&&!e&&n.jsx("p",{className:"mt-1 text-sm text-gray-500",children:t})]}));g.displayName="Input";export{w as B,g as I,j as U,l as c};
