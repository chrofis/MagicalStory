import{j as e,r as c}from"./vendor-react-CC-yJjhT.js";const g={primary:"bg-indigo-500 text-white hover:bg-indigo-600 shadow-lg hover:shadow-xl",secondary:"bg-indigo-100 text-indigo-700 hover:bg-indigo-200",outline:"border-2 border-indigo-500 text-indigo-500 hover:bg-indigo-50",ghost:"text-indigo-500 hover:bg-indigo-50",danger:"bg-red-600 text-white hover:bg-red-700"},m={sm:"px-3 py-1.5 text-sm",md:"px-4 py-2 text-base",lg:"px-6 py-3 text-lg",xl:"px-8 py-4 text-lg lg:px-10 lg:py-5 lg:text-xl"};function b({variant:i="primary",size:s="md",icon:t,iconPosition:l="left",loading:r=!1,disabled:o,className:a="",children:d,...n}){const x=o||r;return e.jsxs("button",{className:`
        inline-flex items-center justify-center gap-2 rounded-lg font-medium
        transition-all duration-200 transform hover:scale-[1.02]
        disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none
        ${g[i]}
        ${m[s]}
        ${a}
      `,disabled:x,...n,children:[r?e.jsxs("svg",{className:"animate-spin h-5 w-5",viewBox:"0 0 24 24",children:[e.jsx("circle",{className:"opacity-25",cx:"12",cy:"12",r:"10",stroke:"currentColor",strokeWidth:"4",fill:"none"}),e.jsx("path",{className:"opacity-75",fill:"currentColor",d:"M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"})]}):t&&l==="left"?e.jsx(t,{size:s==="sm"?16:s==="lg"?24:20}):null,d,!r&&t&&l==="right"&&e.jsx(t,{size:s==="sm"?16:s==="lg"?24:20})]})}const u=c.forwardRef(({label:i,error:s,helperText:t,className:l="",...r},o)=>e.jsxs("div",{className:"w-full",children:[i&&e.jsxs("label",{className:"block text-sm font-medium text-gray-700 mb-1",children:[i,r.required&&e.jsx("span",{className:"text-red-500 ml-1",children:"*"})]}),e.jsx("input",{ref:o,className:`
            w-full px-4 py-2 rounded-lg border
            transition-all duration-200
            focus:outline-none focus:ring-2
            ${s?"border-red-300 focus:ring-red-500 focus:border-red-500":"border-gray-300 focus:ring-indigo-500 focus:border-indigo-500"}
            disabled:bg-gray-100 disabled:cursor-not-allowed
            ${l}
          `,...r}),s&&e.jsx("p",{className:"mt-1 text-sm text-red-600",children:s}),t&&!s&&e.jsx("p",{className:"mt-1 text-sm text-gray-500",children:t})]}));u.displayName="Input";export{b as B,u as I};
