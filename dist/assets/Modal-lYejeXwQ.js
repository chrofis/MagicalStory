import{c as t,j as e,X as h}from"./index-DhgOGsP4.js";import{b as o}from"./vendor-react-CqfXSjHo.js";/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const v=t("Image",[["rect",{width:"18",height:"18",x:"3",y:"3",rx:"2",ry:"2",key:"1m3agn"}],["circle",{cx:"9",cy:"9",r:"2",key:"af1f0g"}],["path",{d:"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",key:"1xmnt7"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const k=t("Mail",[["rect",{width:"20",height:"16",x:"2",y:"4",rx:"2",key:"18n3k1"}],["path",{d:"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7",key:"1ocrg3"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const w=t("RefreshCw",[["path",{d:"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",key:"v9h5vc"}],["path",{d:"M21 3v5h-5",key:"1q7to0"}],["path",{d:"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",key:"3uifl3"}],["path",{d:"M8 16H3v5",key:"1cv678"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const b=t("RotateCcw",[["path",{d:"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",key:"1357e3"}],["path",{d:"M3 3v5h5",key:"1xhq8a"}]]),u={sm:"max-w-md",md:"max-w-lg",lg:"max-w-2xl",xl:"max-w-4xl",full:"max-w-[95vw] max-h-[95vh]"};function p({isOpen:s,onClose:a,title:r,children:c,size:i="md",showCloseButton:l=!0,closeOnOverlayClick:m=!0,closeOnEscape:n=!0}){const d=o.useCallback(x=>{x.key==="Escape"&&n&&a()},[a,n]);return o.useEffect(()=>(s&&(document.addEventListener("keydown",d),document.body.style.overflow="hidden"),()=>{document.removeEventListener("keydown",d),document.body.style.overflow="unset"}),[s,d]),s?e.jsxs("div",{className:"fixed inset-0 z-50 flex items-center justify-center",children:[e.jsx("div",{className:"absolute inset-0 bg-black/50 backdrop-blur-sm",onClick:m?a:void 0}),e.jsxs("div",{className:`
          relative bg-white rounded-2xl shadow-2xl w-full mx-4
          transform transition-all duration-300 ease-out
          animate-in fade-in zoom-in-95
          ${u[i]}
        `,children:[(r||l)&&e.jsxs("div",{className:"flex items-center justify-between p-4 border-b border-gray-100",children:[r&&e.jsx("h2",{className:"text-xl font-bold text-gray-800",children:r}),l&&e.jsx("button",{onClick:a,className:"p-2 rounded-full hover:bg-gray-100 transition-colors","aria-label":"Close",children:e.jsx(h,{size:20})})]}),e.jsx("div",{className:"p-4 max-h-[80vh] overflow-y-auto",children:c})]})]}):null}export{v as I,k as M,w as R,p as a,b};
