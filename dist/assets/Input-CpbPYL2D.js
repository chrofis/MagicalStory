import{c as d,j as e}from"./index-cLPLUfti.js";import{b as m}from"./vendor-react-k5uhsfqB.js";/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const b=d("BookOpen",[["path",{d:"M12 7v14",key:"1akyts"}],["path",{d:"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",key:"ruj8y"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const f=d("CreditCard",[["rect",{width:"20",height:"14",x:"2",y:"5",rx:"2",key:"ynyp8z"}],["line",{x1:"2",x2:"22",y1:"10",y2:"10",key:"1b3vmo"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const v=d("Users",[["path",{d:"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",key:"1yyitq"}],["circle",{cx:"9",cy:"7",r:"4",key:"nufk8"}],["path",{d:"M22 21v-2a4 4 0 0 0-3-3.87",key:"kshegd"}],["path",{d:"M16 3.13a4 4 0 0 1 0 7.75",key:"1da9ce"}]]),g={primary:"bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg hover:shadow-xl",secondary:"bg-indigo-100 text-indigo-700 hover:bg-indigo-200",outline:"border-2 border-indigo-600 text-indigo-600 hover:bg-indigo-50",ghost:"text-indigo-600 hover:bg-indigo-50",danger:"bg-red-600 text-white hover:bg-red-700"},p={sm:"px-3 py-1.5 text-sm",md:"px-4 py-2 text-base",lg:"px-6 py-3 text-lg"};function j({variant:a="primary",size:s="md",icon:t,iconPosition:i="left",loading:r=!1,disabled:o,className:n="",children:l,...c}){const x=o||r;return e.jsxs("button",{className:`
        inline-flex items-center justify-center gap-2 rounded-lg font-medium
        transition-all duration-200 transform hover:scale-[1.02]
        disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none
        ${g[a]}
        ${p[s]}
        ${n}
      `,disabled:x,...c,children:[r?e.jsxs("svg",{className:"animate-spin h-5 w-5",viewBox:"0 0 24 24",children:[e.jsx("circle",{className:"opacity-25",cx:"12",cy:"12",r:"10",stroke:"currentColor",strokeWidth:"4",fill:"none"}),e.jsx("path",{className:"opacity-75",fill:"currentColor",d:"M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"})]}):t&&i==="left"?e.jsx(t,{size:s==="sm"?16:s==="lg"?24:20}):null,l,!r&&t&&i==="right"&&e.jsx(t,{size:s==="sm"?16:s==="lg"?24:20})]})}const u=m.forwardRef(({label:a,error:s,helperText:t,className:i="",...r},o)=>e.jsxs("div",{className:"w-full",children:[a&&e.jsxs("label",{className:"block text-sm font-medium text-gray-700 mb-1",children:[a,r.required&&e.jsx("span",{className:"text-red-500 ml-1",children:"*"})]}),e.jsx("input",{ref:o,className:`
            w-full px-4 py-2 rounded-lg border
            transition-all duration-200
            focus:outline-none focus:ring-2
            ${s?"border-red-300 focus:ring-red-500 focus:border-red-500":"border-gray-300 focus:ring-purple-500 focus:border-purple-500"}
            disabled:bg-gray-100 disabled:cursor-not-allowed
            ${i}
          `,...r}),s&&e.jsx("p",{className:"mt-1 text-sm text-red-600",children:s}),t&&!s&&e.jsx("p",{className:"mt-1 text-sm text-gray-500",children:t})]}));u.displayName="Input";export{j as B,f as C,u as I,v as U,b as a};
