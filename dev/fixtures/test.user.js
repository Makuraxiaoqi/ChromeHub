// ==UserScript==
// @name         ChromeHub Test Script
// @namespace    chromehub.test
// @version      1.0.0
// @description  fixture userscript
// @match        http://127.0.0.1:*/*
// @match        http://localhost:*/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// ==/UserScript==

document.documentElement.dataset.scriptTest = 'ok';
GM_setValue('greeting', 'hello-from-gm');
document.documentElement.dataset.gmValue = GM_getValue('greeting', 'missing');
GM_addStyle('body{--chromehub-test:1;}');
