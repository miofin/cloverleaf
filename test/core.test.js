'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const G = require('../src/core');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const html = (r) => r.blocks.map((b) => b.html).join('\n');
const text = (r) => html(r).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

test('example document compiles cleanly', () => {
  const r = G.compile(read('examples/example.tex'));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.blocks.length, 11);
  const t = text(r);
  for (const s of ['Definition 1.1.', 'Definition 1.2.', 'Theorem 1.3', 'Problem 2.1.', 'Problem 2.2.', '[5 points]', '(a)', '(b)']) assert.ok(t.includes(s), s);
  assert.ok(t.includes('Theorem 1.3 and Definition 1.1'), 'references resolve to numbers');
  assert.ok(html(r).includes('\\(\\eqref{eq:fire}\\)'), 'equation references are left to MathJax');
  assert.deepEqual(r.defs, ['\\newcommand{\\Z}{\\mathbb{Z}}', '\\newcommand{\\pts}[1]{\\textbf{[#1 points]}}', '\\DeclareMathOperator{\\chips}{chips}']);
});

test('blocks carry increasing source ranges', () => {
  const src = read('examples/example.tex');
  const r = G.compile(src);
  let prev = 0;
  for (const b of r.blocks) {
    assert.ok(b.s >= prev && b.e >= b.s && b.e <= src.length);
    prev = b.s;
  }
  const p = r.blocks.find((b) => b.html.startsWith('<p>Throughout'));
  assert.ok(src.slice(p.s, p.e).startsWith('Throughout this round'));
});

test('problems in the source are reported, not fatal', () => {
  const r = G.compile(read('test/fixtures/stress.tex'));
  assert.deepEqual(r.warnings.map((w) => w.msg), [
    'Reference to undefined label “nope”',
    'Unknown command \\unknowncmd in text',
    'Environment “lemma” is used without \\newtheorem; the preview guessed its heading',
    '{ is never closed',
    '$ is never closed',
    'Unknown environment “weird”; its contents are shown as plain text',
    '\\item outside a list'
  ]);
  const t = text(r);
  for (const s of ['Hello “world” — it’s 50% & more here', 'Naïve café ç', '(i)', '(ii)', 'Table 1.', 'Sketch.', 'A.1']) assert.ok(t.includes(s), s);
  assert.ok(html(r).includes('<div class="md">\\begin{equation}x=1 \\label{e1} \\end{equation}</div>'), '\\be ... \\ee aliases expand');
  assert.ok(html(r).includes('<pre class="verb no-mj">$raw$ \\stuff</pre>'));
});

test('thmtools, mdframed and xcolor preamble', () => {
  const r = G.compile(read('test/fixtures/thmtools.tex'));
  assert.deepEqual(r.warnings, []);
  const t = text(r), h = html(r);
  for (const s of ['Definition 1.1.1', 'Theorem 1.1.2', '(Cantor)', 'Lemma 1.1.3', 'Problem 1.1.1', '(5 points)', 'Problem 1.2.1']) assert.ok(t.includes(s), s);
  assert.ok(t.includes('Use Theorem 1.1.2 and Definition 1.1.1.'));
  assert.ok(!t.includes('Hidden'), '\\iffalse ... \\fi is skipped');
  assert.ok(!/Theorem\s+\d[\d.]*\s*An unnumbered/.test(t), 'starred theorem has no number');
  assert.ok(h.includes('border-radius:13px'), 'roundcorner becomes a radius');
  assert.ok(h.includes('border-width:0 0 0 3px'), 'left-bar style keeps only the left line');
  assert.ok(h.includes('color-mix(in srgb,forestgreen 5%,var(--paper))'), 'xcolor mix; svgnames wins for ForestGreen');
  assert.ok(h.includes('#00AEB3'), 'dvips-only name TealBlue');
  assert.ok(h.includes('class="sec l1 koma"'), 'scrartcl headings');
});

test('truncated input never throws', () => {
  const src = read('test/fixtures/stress.tex');
  for (let k = 0; k < src.length; k += 7) {
    G.compile(src.slice(0, k));
    G.compile(src.slice(k));
  }
});

test('fragment renders a snippet with the document’s macros and labels', () => {
  const r = G.compile(read('examples/example.tex'));
  const h = G.fragment('You may cite Theorem~\\ref{thm:abelian}, worth \\pts{3}.', r.state);
  assert.ok(h.includes('>1.3</a>'));
  assert.ok(h.includes('<strong>[3 points]</strong>'));
});

test('edit blocks parse', () => {
  const edits = G.parseEdits(read('examples/example-edits.txt'));
  assert.deepEqual(edits.map((e) => e.type), ['typo', 'typo', 'sentence', 'passage', 'typo']);
  assert.equal(edits[0].find, 'The the total');
  assert.equal(edits[0].replace, 'The total');
  assert.equal(edits[0].reason, 'Repeated word.');
});

test('JSON edit lists parse, and the kind is inferred when missing', () => {
  const edits = G.parseEdits('```json\n[{"type":"typo","find":"teh","replace":"the","reason":"r"},' +
    '{"original":"A long sentence that is here. And another one follows it.","replacement":"Shorter."},{"find":"same","replace":"same"}]\n```');
  assert.equal(edits.length, 2);
  assert.equal(edits[0].type, 'typo');
  assert.equal(edits[1].type, 'passage');
  assert.deepEqual(G.parseEdits('no edits here'), []);
});

test('every example edit is found exactly once in the example document', () => {
  const src = read('examples/example.tex');
  for (const e of G.parseEdits(read('examples/example-edits.txt'))) {
    const hit = G.locate(src, e.find, -1);
    assert.ok(hit, e.find);
    assert.equal(hit.count, 1);
    assert.equal(src.slice(hit.pos, hit.pos + hit.len), e.find);
  }
});

test('locate tolerates reflowed whitespace and prefers the hit nearest the hint', () => {
  assert.deepEqual(G.locate('one two\n   three four', 'two three', -1), { pos: 4, len: 12, count: 1 });
  assert.equal(G.locate('ab ab ab', 'ab', 5).pos, 6);
  assert.equal(G.locate('ab ab ab', 'ab', 5).count, 3);
  assert.equal(G.locate('abc', 'xyz', -1), null);
});

test('diff marks only what changed and reconstructs both sides', () => {
  const a = 'We place a number of chips on each vertex.', b = 'We place some chips on each vertex.';
  const ops = G.diff(a, b);
  assert.deepEqual(ops, [['eq', 'We place '], ['del', 'a number of'], ['ins', 'some'], ['eq', ' chips on each vertex.']]);
  assert.equal(ops.filter((o) => o[0] !== 'ins').map((o) => o[1]).join(''), a);
  assert.equal(ops.filter((o) => o[0] !== 'del').map((o) => o[1]).join(''), b);
});
