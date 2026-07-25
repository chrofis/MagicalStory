import{r as o,j as s}from"./vendor-react-B80FwXor.js";const i=o.forwardRef(({label:r,error:e,helperText:t,className:d="",...a},n)=>s.jsxs("div",{className:"w-full",children:[r&&s.jsxs("label",{className:"block text-sm font-medium text-gray-700 mb-1",children:[r,a.required&&s.jsx("span",{className:"text-red-500 ml-1",children:"*"})]}),s.jsx("input",{ref:n,className:`
            w-full px-4 py-2 rounded-lg border
            transition-all duration-200
            focus:outline-none focus:ring-2
            ${e?"border-red-300 focus:ring-red-500 focus:border-red-500":"border-gray-300 focus:ring-indigo-500 focus:border-indigo-500"}
            disabled:bg-gray-100 disabled:cursor-not-allowed
            ${d}
          `,...a}),e&&s.jsx("p",{className:"mt-1 text-sm text-red-600",children:e}),t&&!e&&s.jsx("p",{className:"mt-1 text-sm text-gray-500",children:t})]}));i.displayName="Input";export{i as I};
