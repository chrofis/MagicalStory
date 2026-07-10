function e(t,r="image/jpeg"){return!t||typeof t!="string"?null:t.startsWith("data:")||/^https?:\/\//i.test(t)?t:`data:${r};base64,${t}`}export{e as t};
