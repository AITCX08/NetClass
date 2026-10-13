// ==UserScript==
// @name         NC Hello Test
// @namespace    taskmesh.local/test
// @version      1.0
// @match        https://study.bjqiyang.com/*
// @run-at       document-start
// ==/UserScript==
window.__NC_HELLO__ = 'ran-' + Date.now();
console.log('[NC-HELLO] injected');
