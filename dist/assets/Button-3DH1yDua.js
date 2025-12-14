import{j as e}from"./index-CSE_lSUT.js";const x={primary:"bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg hover:shadow-xl",secondary:"bg-indigo-100 text-indigo-700 hover:bg-indigo-200",outline:"border-2 border-indigo-600 text-indigo-600 hover:bg-indigo-50",ghost:"text-indigo-600 hover:bg-indigo-50",danger:"bg-red-600 text-white hover:bg-red-700"},c={sm:"px-3 py-1.5 text-sm",md:"px-4 py-2 text-base",lg:"px-6 py-3 text-lg"};function h({variant:o="primary",size:t="md",icon:s,iconPosition:r="left",loading:i=!1,disabled:a,className:n="",children:l,...d}){const g=a||i;return e.jsxs("button",{className:`
        inline-flex items-center justify-center gap-2 rounded-lg font-medium
        transition-all duration-200 transform hover:scale-[1.02]
        disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none
        ${x[o]}
        ${c[t]}
        ${n}
      `,disabled:g,...d,children:[i?e.jsxs("svg",{className:"animate-spin h-5 w-5",viewBox:"0 0 24 24",children:[e.jsx("circle",{className:"opacity-25",cx:"12",cy:"12",r:"10",stroke:"currentColor",strokeWidth:"4",fill:"none"}),e.jsx("path",{className:"opacity-75",fill:"currentColor",d:"M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"})]}):s&&r==="left"?e.jsx(s,{size:t==="sm"?16:t==="lg"?24:20}):null,l,!i&&s&&r==="right"&&e.jsx(s,{size:t==="sm"?16:t==="lg"?24:20})]})}export{h as B};
