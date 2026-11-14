#!/usr/bin/env node
'use strict';
/*
 * Builds dist/galley.html: one self-contained page.
 * No dependencies. The core modules are CommonJS, so they are wrapped in a
 * minimal module registry and exposed to the page as window.Galley.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const inlineJson = (s) => JSON.stringify(s).replace(/<\//g, '<\\/');

function bundleCore() {
  const dir = 'src/core';
  const mods = fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.js')).sort();
  const defs = mods.map((f) => {
    const id = './' + f.replace(/\.js$/, '');
    return JSON.stringify(id) + ': function (module, exports, require) {\n' + read(dir + '/' + f) + '\n}';
  });
  return [
    '(function () {',
    'var defs = {\n' + defs.join(',\n') + '\n};',
    'var cache = {};',
    'function require(id) {',
    '  if (cache[id]) return cache[id].exports;',
    '  if (!defs[id]) throw new Error("Unknown module " + id);',
    '  var module = cache[id] = { exports: {} };',
    '  defs[id](module, module.exports, require);',
    '  return module.exports;',
    '}',
    'window.Galley = require("./index");',
    '})();'
  ].join('\n');
}

const parts = {
  '/*CSS*/': read('src/styles.css').trimEnd(),
  '/*EX_TEX*/': inlineJson(read('examples/example.tex')),
  '/*EX_EDITS*/': inlineJson(read('examples/example-edits.txt')),
  '/*CORE*/': bundleCore(),
  '/*UI*/': read('src/app/ui.js').trimEnd()
};

let html = read('src/index.html');
for (const [mark, text] of Object.entries(parts)) {
  if (!html.includes(mark)) throw new Error('src/index.html is missing the ' + mark + ' placeholder');
  if (/<\/script/i.test(text) && mark !== '/*CSS*/') throw new Error(mark + ' content contains </script, which would end the inline script');
  html = html.replace(mark, () => text);
}

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/galley.html'), html);
console.log('dist/galley.html  ' + (html.length / 1024).toFixed(0) + ' KB');
