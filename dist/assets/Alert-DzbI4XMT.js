import{f as a,T as c,C as b,I as x,j as e,X as d}from"./index-jRYXaeIp.js";const g={info:{bg:"bg-blue-50 border-blue-200",text:"text-blue-800",icon:x},success:{bg:"bg-green-50 border-green-200",text:"text-green-800",icon:b},warning:{bg:"bg-yellow-50 border-yellow-200",text:"text-yellow-800",icon:c},error:{bg:"bg-red-50 border-red-200",text:"text-red-800",icon:a}};function f({children:o,variant:t="info",title:s,onClose:n,className:i=""}){const r=g[t],l=r.icon;return e.jsxs("div",{className:`
        flex gap-3 p-4 rounded-lg border
        ${r.bg} ${r.text}
        ${i}
      `,role:"alert",children:[e.jsx(l,{className:"shrink-0 mt-0.5",size:20}),e.jsxs("div",{className:"flex-1",children:[s&&e.jsx("p",{className:"font-semibold mb-1",children:s}),e.jsx("div",{className:"text-sm",children:o})]}),n&&e.jsx("button",{onClick:n,className:"shrink-0 p-1 rounded hover:bg-black/10 transition-colors","aria-label":"Dismiss",children:e.jsx(d,{size:16})})]})}export{f as A};
