import{c as x,j as e,X as u}from"./index-B32rVI4f.js";import{b as n}from"./vendor-react-DeDwXAjR.js";/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const v=x("RotateCcw",[["path",{d:"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",key:"1357e3"}],["path",{d:"M3 3v5h5",key:"1xhq8a"}]]),f={sm:"max-w-md",md:"max-w-lg",lg:"max-w-2xl",xl:"max-w-4xl",full:"max-w-[95vw] max-h-[95vh]"};function w({isOpen:t,onClose:a,title:s,children:d,size:i="md",showCloseButton:l=!0,closeOnOverlayClick:c=!0,closeOnEscape:o=!0}){const r=n.useCallback(m=>{m.key==="Escape"&&o&&a()},[a,o]);return n.useEffect(()=>(t&&(document.addEventListener("keydown",r),document.body.style.overflow="hidden"),()=>{document.removeEventListener("keydown",r),document.body.style.overflow="unset"}),[t,r]),t?e.jsxs("div",{className:"fixed inset-0 z-50 flex items-center justify-center",children:[e.jsx("div",{className:"absolute inset-0 bg-black/50 backdrop-blur-sm",onClick:c?a:void 0}),e.jsxs("div",{className:`
          relative bg-white rounded-2xl shadow-2xl w-full mx-4
          transform transition-all duration-300 ease-out
          animate-in fade-in zoom-in-95
          ${f[i]}
        `,children:[(s||l)&&e.jsxs("div",{className:"flex items-center justify-between p-4 border-b border-gray-100",children:[s&&e.jsx("h2",{className:"text-xl font-bold text-gray-800",children:s}),l&&e.jsx("button",{onClick:a,className:"p-2 rounded-full hover:bg-gray-100 transition-colors","aria-label":"Close",children:e.jsx(u,{size:20})})]}),e.jsx("div",{className:"p-4 max-h-[80vh] overflow-y-auto",children:d})]})]}):null}export{w as M,v as R};
