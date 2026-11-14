'use strict';
/*
 * LaTeX -> HTML preview compiler. No DOM: it returns HTML strings.
 *
 *   compile(src)        -> { blocks: [{ html, s, e }], warnings, defs, state }
 *   fragment(tex, state) -> html for a snippet, using a compiled document's macros and labels
 *
 * Each block carries the source range [s, e) it came from, which is how the page maps
 * between the preview and the source. Math is left as TeX inside \( \) and .md blocks
 * for MathJax to typeset.
 */
var util = require('./util');
var esc = util.esc, escAttr = util.escAttr, reEsc = util.reEsc;

/* ---------- small helpers ---------- */
function stripTags(s) { return String(s).replace(/<[^>]*>/g, ''); }
function isLetter(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
function at(re, str, i) { re.lastIndex = i; return re.exec(str); }
function roman(n) {
  if (!(n > 0) || n > 3999) return String(n);
  var v = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1], s = ['m', 'cm', 'd', 'cd', 'c', 'xc', 'l', 'xl', 'x', 'ix', 'v', 'iv', 'i'], o = '';
  for (var k = 0; k < v.length; k++) while (n >= v[k]) { o += s[k]; n -= v[k]; }
  return o;
}
function alph(n) { return n >= 1 && n <= 26 ? String.fromCharCode(96 + n) : String(n); }
function fmtCounter(kind, n) {
  switch (kind) {
    case 'alph': return alph(n);
    case 'Alph': return alph(n).toUpperCase();
    case 'roman': return roman(n);
    case 'Roman': return roman(n).toUpperCase();
    case 'fnsymbol': return ['*', '†', '‡', '§', '¶', '‖'][n - 1] || String(n);
    default: return String(n);
  }
}
function stripComments(t) { return t.replace(/(^|[^\\])%[^\n]*/g, '$1'); }
function len2em(s) {
  var m = /(-?[\d.]+)\s*(pt|em|ex|cm|mm|in|bp|pc)?/.exec(s || '');
  if (!m) return /baselineskip/.test(s || '') ? 1.2 : 0.8;
  var v = parseFloat(m[1]), f = { pt: 0.1, bp: 0.1, em: 1, ex: 0.45, cm: 2.85, mm: 0.285, 'in': 7.2, pc: 1.2 }[m[2] || 'em'];
  if (/baselineskip/.test(s)) f = 1.2;
  return Math.max(0, Math.min(8, v * f));
}

var HF = '\u0001HF\u0002', TOC = '\u0001TOC\u0002';

var MATHENV = { equation: 1, align: 1, gather: 1, multline: 1, flalign: 1, alignat: 1, eqnarray: 1, displaymath: 1, math: 1, xalignat: 1, xxalignat: 1 };
var NUMBERED = /\\(begin|end)\{(equation|align|gather|multline|flalign|alignat|eqnarray)\}/g;
var VERBENV = { verbatim: 1, 'verbatim*': 1, Verbatim: 1, lstlisting: 1, minted: 1, alltt: 1 };
var PICENV = { tikzpicture: 1, asy: 1, asypicture: 1, tikzcd: 1, pgfpicture: 1, circuitikz: 1, pspicture: 1, picture: 1, forest: 1, axis: 1 };
var TABENV = { tabular: 1, 'tabular*': 1, tabularx: 1, tabulary: 1, longtable: 1, array: 1 };
var DIVENV = {
  center: 'center', flushleft: 'fl', flushright: 'fr', quote: 'quote', quotation: 'quote', verse: 'quote',
  figure: 'float', 'figure*': 'float', table: 'float', 'table*': 'float', wrapfigure: 'float', subfigure: 'float',
  minipage: 'minipage', framed: 'framed', mdframed: 'framed', tcolorbox: 'framed', titlepage: '', samepage: '',
  subequations: '', sloppypar: '', spacing: '', adjustwidth: '', landscape: '', small: 'small', footnotesize: 'small',
  large: 'large', appendices: '', multicols: 'cols', 'multicols*': 'cols', abstract: 'abstract'
};
var ENVARGS = { minipage: 'om', multicols: 'm', 'multicols*': 'm', wrapfigure: 'omm', tcolorbox: 'o', mdframed: 'o', figure: 'o', 'figure*': 'o', table: 'o', 'table*': 'o', spacing: 'm', adjustwidth: 'mm', subfigure: 'om' };
var BUILTIN_THM = {
  theorem: 'Theorem', thm: 'Theorem', lemma: 'Lemma', lem: 'Lemma', proposition: 'Proposition', prop: 'Proposition',
  corollary: 'Corollary', cor: 'Corollary', definition: 'Definition', defn: 'Definition', example: 'Example',
  remark: 'Remark', problem: 'Problem', exercise: 'Exercise', claim: 'Claim', conjecture: 'Conjecture',
  solution: 'Solution', note: 'Note', question: 'Question', fact: 'Fact', observation: 'Observation', notation: 'Notation', axiom: 'Axiom'
};
var WRAP = {
  textbf: ['<strong>', '</strong>'], textit: ['<em>', '</em>'], emph: ['<em>', '</em>'], textsl: ['<em>', '</em>'],
  underline: ['<u>', '</u>'], uline: ['<u>', '</u>'], texttt: ['<span class="tt">', '</span>'],
  textsc: ['<span class="sc">', '</span>'], textrm: ['<span class="rm">', '</span>'], textsf: ['<span class="sf">', '</span>'],
  textup: ['<span class="up">', '</span>'], textnormal: ['<span class="rm up">', '</span>'], textmd: ['<span>', '</span>'],
  mbox: ['<span class="nw">', '</span>'], hbox: ['<span class="nw">', '</span>'], fbox: ['<span class="fbox">', '</span>'],
  text: ['', ''], textsuperscript: ['<sup>', '</sup>'], textsubscript: ['<sub>', '</sub>'], sout: ['<s>', '</s>'],
  hl: ['<mark>', '</mark>'], centerline: ['<span class="cl">', '</span>'], smash: ['', ''], boxed: ['<span class="fbox">', '</span>']
};
var DECL = {
  bf: 'font-weight:700', bfseries: 'font-weight:700', it: 'font-style:italic', itshape: 'font-style:italic', em: 'font-style:italic',
  sl: 'font-style:italic', slshape: 'font-style:italic', sc: 'font-variant:small-caps', scshape: 'font-variant:small-caps',
  tt: 'font-family:var(--mono);font-size:.9em', ttfamily: 'font-family:var(--mono);font-size:.9em', rm: 'font-style:normal;font-weight:400',
  rmfamily: '', sf: 'font-family:var(--sans)', sffamily: 'font-family:var(--sans)', normalfont: 'font-weight:400;font-style:normal',
  upshape: 'font-style:normal', mdseries: 'font-weight:400',
  tiny: 'font-size:.6em', scriptsize: 'font-size:.7em', footnotesize: 'font-size:.8em', small: 'font-size:.9em', normalsize: 'font-size:1em',
  large: 'font-size:1.2em', Large: 'font-size:1.44em', LARGE: 'font-size:1.73em', huge: 'font-size:2.07em', Huge: 'font-size:2.49em',
  centering: 'text-align:center', raggedright: 'text-align:left', raggedleft: 'text-align:right'
};
var SYM = {
  ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø', O: 'Ø', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
  S: '§', P: '¶', dag: '†', ddag: '‡', copyright: '©', pounds: '£', ldots: '…', dots: '…', textellipsis: '…', cdots: '⋯',
  textbackslash: '&#92;\u200C', textasciitilde: '~', textasciicircum: '^', textbar: '|', textless: '&lt;', textgreater: '&gt;',
  textbullet: '•', textendash: '–', textemdash: '—', textquoteleft: '‘', textquoteright: '’', textquotedblleft: '“',
  textquotedblright: '”', textdegree: '°', textregistered: '®', texttrademark: '™', slash: '/', quad: '&emsp;', qquad: '&emsp;&emsp;',
  enspace: '&ensp;', thinspace: '&thinsp;', textdollar: '$', textunderscore: '_', textvisiblespace: '␣', checkmark: '✓',
  lq: '‘', rq: '’', guillemotleft: '«', guillemotright: '»', textperiodcentered: '·', space: ' ', and: ' &emsp; ',
  LaTeX: 'L<span class="la">a</span>T<span class="te">e</span>X', TeX: 'T<span class="te">e</span>X', textasteriskcentered: '∗'
};
var ACC = { "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307', c: '\u0327', v: '\u030C', u: '\u0306', H: '\u030B', k: '\u0328', r: '\u030A', d: '\u0323', b: '\u0331' };
/* commands swallowed silently: * = star, o = optional arg, m = mandatory arg */
var IGNORE = {
  noindent: '', indent: '', pagebreak: 'o', nopagebreak: 'o', nolinebreak: 'o', pagestyle: 'm', thispagestyle: 'm', pagenumbering: 'm',
  setlength: 'mm', addtolength: 'mm', usepackage: 'om', documentclass: 'om', RequirePackage: 'om', bibliographystyle: 'm', bibliography: 'm',
  nocite: 'm', index: 'm', phantom: 'm', vphantom: 'm', hphantom: 'm', protect: '', allowbreak: '', nobreak: '', sloppy: '', fussy: '',
  frenchspacing: '', relax: '', leavevmode: '', 'null': '', strut: '', hypersetup: 'm', geometry: 'm', graphicspath: 'm', tikzset: 'm',
  usetikzlibrary: 'm', pgfplotsset: 'm', captionsetup: 'om', linespread: 'm', selectfont: '', fontsize: 'mm', normalem: '',
  raggedbottom: '', flushbottom: '', onehalfspacing: '', doublespacing: '', singlespacing: '', columnbreak: '', FloatBarrier: '',
  goodbreak: '', 'break': '', enlargethispage: '*m', markboth: 'mm', markright: 'm', fancyhf: 'om', fancyhead: 'om', fancyfoot: 'om',
  lhead: 'm', chead: 'm', rhead: 'm', lfoot: 'm', cfoot: 'm', rfoot: 'm', addcontentsline: 'mmm', phantomsection: '', listfiles: '',
  xspace: '', vfill: '', vfil: '', hfil: '', qedhere: '', displaystyle: '', textstyle: '', marginpar: 'm',
  footnotemark: 'o', pagecolor: 'm', newcounter: 'mo', refstepcounter: 'm', toprule: '', midrule: '', bottomrule: '', hline: '',
  cline: 'm', noalign: 'm', itemsep: '', parskip: '', parindent: '', baselineskip: '', makeindex: '', printindex: '', balance: '',
  setstretch: 'm', onecolumn: '', twocolumn: 'o', clearpage: '', cleardoublepage: '', ignorespaces: '', unskip: '', centerhfill: '',
  setenumerate: 'om', setitemize: 'om', setlist: 'om', titleformat: 'mmmmm', titlespacing: '*mmmm', footnotetext: 'om', thanks: 'm',
  lstset: 'm', DeclareGraphicsExtensions: 'm', AtBeginDocument: 'm', allowdisplaybreaks: 'o', numberwithin: 'mm', left: '', right: '',
  fi: '', 'else': '', iftrue: '', reversemarginpar: '', listoftodos: 'o', todototoc: '', smallbreak: '', medbreak: '', bigbreak: '', hrulefill: '', dotfill: '', mathstrut: '', nonumber: '', notag: '', bibitemsep: ''
};
var PRE = { newcommand: 1, renewcommand: 1, providecommand: 1, DeclareRobustCommand: 1, def: 1, gdef: 1, edef: 1, xdef: 1, let: 1, DeclareMathOperator: 1, DeclarePairedDelimiter: 1, newtheorem: 1, theoremstyle: 1, newenvironment: 1, renewenvironment: 1, title: 1, author: 1, date: 1, makeatletter: 1, makeatother: 1, numberwithin: 1, newcounter: 1, setcounter: 1, usepackage: 1, documentclass: 1, mdfdefinestyle: 1, declaretheoremstyle: 1, declaretheorem: 1, definecolor: 1, colorlet: 1, iffalse: 1 };
var PROTECTED = { begin: 1, end: 1, item: 1, label: 1, ref: 1, eqref: 1, section: 1, subsection: 1, subsubsection: 1, newcommand: 1, renewcommand: 1, def: 1, par: 1, maketitle: 1, footnote: 1 };
var DVIPS = { Apricot: 'FBB982', Aquamarine: '00B5BE', Bittersweet: 'C04F17', Black: '221E1F', Blue: '2D2F92', BlueGreen: '00B3B8', BlueViolet: '473992', BrickRed: 'B6321C', Brown: '792500', BurntOrange: 'F7921D', CadetBlue: '74729A', CarnationPink: 'F282B4', Cerulean: '00A2E3', CornflowerBlue: '41B0E4', Cyan: '00AEEF', Dandelion: 'FDBC42', DarkOrchid: 'A4538A', Emerald: '00A99D', ForestGreen: '009B55', Fuchsia: '8C368C', Goldenrod: 'FFDF42', Gray: '949698', Green: '00A64F', GreenYellow: 'DFE674', JungleGreen: '00A99A', Lavender: 'F49EC4', LimeGreen: '8DC73E', Magenta: 'EC008C', Mahogany: 'A9341F', Maroon: 'AF3235', Melon: 'F89E7B', MidnightBlue: '006795', Mulberry: 'A93C93', NavyBlue: '006EB8', OliveGreen: '3C8031', Orange: 'F58137', OrangeRed: 'ED135A', Orchid: 'AF72B0', Peach: 'F7965A', Periwinkle: '7977B8', PineGreen: '008B72', Plum: '92268F', ProcessBlue: '00B0F0', Purple: '99479B', RawSienna: '974006', Red: 'ED1B23', RedOrange: 'F26035', RedViolet: 'A1246B', Rhodamine: 'EF559F', RoyalBlue: '0071BC', RoyalPurple: '613F99', RubineRed: 'ED017D', Salmon: 'F69289', SeaGreen: '3FBC9D', Sepia: '671800', SkyBlue: '46C5DD', SpringGreen: 'C6DC67', Tan: 'DA9D76', TealBlue: '00AEB3', Thistle: 'D883B7', Turquoise: '00B4CE', Violet: '58429B', VioletRed: 'EF58A0', White: 'FFFFFF', WildStrawberry: 'EE2967', Yellow: 'FFF200', YellowGreen: '98CC70', YellowOrange: 'FAA21A' };
/* names that svgnames redefines when it is loaded after dvipsnames */
var BOTH = { Aquamarine: 1, Black: 1, Blue: 1, BlueViolet: 1, Brown: 1, CadetBlue: 1, CornflowerBlue: 1, Cyan: 1, DarkOrchid: 1, ForestGreen: 1, Fuchsia: 1, Goldenrod: 1, Gray: 1, Green: 1, GreenYellow: 1, Lavender: 1, LimeGreen: 1, Magenta: 1, Maroon: 1, MidnightBlue: 1, Orange: 1, OrangeRed: 1, Orchid: 1, Plum: 1, Purple: 1, Red: 1, RoyalBlue: 1, Salmon: 1, SeaGreen: 1, SkyBlue: 1, SpringGreen: 1, Tan: 1, Thistle: 1, Turquoise: 1, Violet: 1, White: 1, Yellow: 1, YellowGreen: 1 };
var COLORS = { red: '#c0392b', blue: '#1f5fbf', green: '#1e7f4f', cyan: '#0e8a9a', magenta: '#b0388f', yellow: '#b58900', black: 'var(--ink)', white: 'var(--paper)', gray: '#777', grey: '#777', darkgray: '#555', lightgray: '#aaa', orange: '#e77500', purple: '#7d3c98', brown: '#8d5a2b', violet: '#7d3c98', teal: '#0e7c7b', olive: '#7a7a00', pink: '#d6619b', lime: '#7cb518' };

/* ---------- document state ---------- */
function State() {
  this.counters = { part: 0, section: 0, subsection: 0, subsubsection: 0, figure: 0, table: 0, footnote: 0, bib: 0 };
  this.within = { subsection: 'section', subsubsection: 'subsection' };
  this.theorems = {}; this.macros = {}; this.envs = {}; this.labels = {}; this.eqLabels = {};
  this.endAlias = {}; this.aliasEnd = {}; this.bib = {};
  this.mdf = {}; this.thmStyles = {}; this.colors = {}; this.svg = false; this.koma = false;
  this.footnotes = []; this.toc = []; this.warnings = []; this.mathDefs = []; this.floats = []; this.unk = {};
  this.title = null; this.author = null; this.date = null;
  this.appendix = false; this.preamble = false; this.atletter = false; this.quiet = false; this.frag = false;
  this.depth = 0; this.listDepth = 0; this.enumDepth = 0; this.itemDepth = 0; this.lastEnum = 0;
  this.theoremStyle = 'plain'; this.curLabel = ''; this.curType = ''; this.curPos = 0;
}
State.prototype.step = function (c) { this.counters[c] = (this.counters[c] || 0) + 1; this.resetKids(c, 0); };
State.prototype.resetKids = function (c, d) {
  if (d > 8) return;
  for (var k in this.within) if (this.within[k] === c && k !== c) { this.counters[k] = 0; this.resetKids(k, d + 1); }
};
State.prototype.the = function (c, parser, d) {
  d = d || 0;
  var m = this.macros['the' + c];
  if (m && parser && d < 4 && !m.n) return stripTags(parser.sub(m.body));
  var n = this.counters[c] || 0;
  if (c === 'section') return this.appendix ? alph(n).toUpperCase() : String(n);
  var p = this.within[c];
  return p && d < 6 ? this.the(p, parser, d + 1) + '.' + n : String(n);
};

/* ---------- parser ---------- */
function P(src, S, o) {
  this.src = src; this.n = src.length; this.i = 0; this.S = S; this.tok = 0;
  this.mapped = !!(o && o.mapped); this.base = 0; this.envStack = (o && o.envStack) || [];
}
P.prototype.warn = function (msg, pos) {
  var S = this.S; if (S.quiet || S.preamble) return null;
  var w = { msg: msg, pos: this.mapped ? (pos == null ? this.i : pos) : S.curPos };
  S.warnings.push(w); return w;
};
P.prototype.sub = function (text) { var b = this.subBlocks(text), o = []; for (var k = 0; k < b.length; k++) o.push(b[k].html); return o.join(' '); };
P.prototype.subBlocks = function (text) {
  var S = this.S;
  if (S.depth > 40) { this.warn('Macro expansion is nested too deeply'); return []; }
  S.depth++;
  var p = new P(String(text), S, { envStack: this.envStack }), b;
  try { b = p.parse({}); } finally { S.depth--; }
  return b;
};
P.prototype.o = function (b) { return this.mapped && b.s >= 0 ? ' data-o="' + (b.s - this.base) + ',' + (b.e - this.base) + '"' : ''; };
P.prototype.joinInline = function (bl) { var o = []; for (var k = 0; k < bl.length; k++) o.push(bl[k].html); return o.join(' '); };
P.prototype.joinBlocks = function (bl) {
  var o = '';
  for (var k = 0; k < bl.length; k++) o += bl[k].t === 'p' ? '<p' + this.o(bl[k]) + '>' + bl[k].html + '</p>' : bl[k].html;
  return o;
};
P.prototype.inl = function (ctx, h) { if (ctx.pStart < 0) ctx.pStart = ctx.t0; ctx.para.push(h); };
P.prototype.flush = function (ctx, end) {
  if (!ctx.para.length) { ctx.pStart = -1; return; }
  var h = ctx.para.join('').trim(), s = ctx.pStart, e = end == null ? ctx.t0 : end; ctx.para = []; ctx.pStart = -1;
  if (!h) return;
  if (e < s) e = this.i;
  if (/^(?:<span class="anc"[^>]*><\/span>\s*)+$/.test(h)) { ctx.blocks.push({ t: 'b', html: '<div class="anc-only">' + h + '</div>', s: s, e: e }); return; }
  if (h.indexOf(HF) >= 0) h = '<span class="hf"><span>' + h.split(HF).join('</span><span>') + '</span></span>';
  ctx.blocks.push({ t: 'p', html: h, s: s, e: e });
};
P.prototype.push = function (ctx, html, s) { this.flush(ctx); ctx.blocks.push({ t: 'b', html: html, s: s == null ? ctx.t0 : s, e: this.i }); };
P.prototype.emitBlocks = function (ctx, bl) {
  for (var k = 0; k < bl.length; k++) {
    var b = bl[k];
    if (b.t === 'p') { if (k > 0) this.flush(ctx); this.inl(ctx, b.html); }
    else { this.flush(ctx); ctx.blocks.push(b); }
  }
};
P.prototype.patch = function (ctx, nb, t0) {
  for (var k = nb; k < ctx.blocks.length; k++) { var b = ctx.blocks[k]; if (b.t !== 'p' || b.s < 0) { b.s = t0; b.e = this.i; } }
};
P.prototype.skipComment = function () { var e = this.src.indexOf('\n', this.i); this.i = e < 0 || e >= this.n ? this.n : e + 1; };
P.prototype.blankAt = function (i) { var s = this.src; while (i < this.n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r')) i++; return s[i] === '\n'; };
P.prototype.ws = function () {
  var s = this.src;
  for (;;) {
    while (this.i < this.n && /\s/.test(s[this.i])) this.i++;
    if (s[this.i] === '%' && this.i < this.n) this.skipComment(); else break;
  }
};
P.prototype.eatSp = function () {
  var s = this.src, k = this.i;
  while (k < this.n && (s[k] === ' ' || s[k] === '\t')) k++;
  if (s[k] === '\n' && k < this.n) { var q = k + 1; while (q < this.n && (s[q] === ' ' || s[q] === '\t')) q++; if (s[q] !== '\n') k = q; }
  this.i = k;
};
P.prototype.matchBrace = function (i) {
  var s = this.src, d = 0;
  for (; i < this.n; i++) {
    var c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '%') { var e = s.indexOf('\n', i); if (e < 0) return this.n; i = e; continue; }
    if (c === '{') d++; else if (c === '}') { d--; if (d === 0) return i; }
  }
  return this.n;
};
P.prototype.rawArg = function () {
  this.ws();
  var s = this.src, i = this.i;
  if (i >= this.n) return '';
  if (s[i] === '{') { var e = this.matchBrace(i); if (e >= this.n) this.warn('Missing }', i); this.i = Math.min(this.n, e + 1); return s.slice(i + 1, e); }
  if (s[i] === '\\') {
    var k = i + 1;
    if (k < this.n && (isLetter(s[k]) || (s[k] === '@' && this.S.atletter))) { while (k < this.n && (isLetter(s[k]) || (s[k] === '@' && this.S.atletter))) k++; } else k++;
    this.i = k; return s.slice(i, k);
  }
  this.i = i + 1; return s[i];
};
P.prototype.readOpt = function () {
  var s = this.src, k = this.i, nl = 0;
  while (k < this.n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) { if (s[k] === '\n' && ++nl > 1) return null; k++; }
  if (s[k] !== '[' || k >= this.n) return null;
  var d = 0;
  for (var m = k + 1; m < this.n; m++) {
    var c = s[m];
    if (c === '\\') { m++; continue; }
    if (c === '{') d++;
    else if (c === '}') { if (d === 0) return null; d--; }
    else if (c === ']' && d === 0) { this.i = m + 1; return s.slice(k + 1, m); }
  }
  return null;
};
P.prototype.argBlocks = function () {
  this.ws();
  var s = this.src;
  if (this.i >= this.n) return [];
  if (s[this.i] === '{') {
    this.i++;
    var b = this.parse({ brace: true });
    if (s[this.i] === '}' && this.i < this.n) this.i++; else this.warn('Missing }');
    return b;
  }
  var tmp = { blocks: [], para: [], pStart: -1, stop: {}, top: false, single: true, t0: this.i };
  if (s[this.i] === '\\') this.command(tmp); else { tmp.para.push(esc(s[this.i])); this.i++; }
  this.flush(tmp);
  return tmp.blocks;
};
P.prototype.inlineArg = function () { return this.joinInline(this.argBlocks()); };
P.prototype.skipSpec = function (spec) {
  for (var k = 0; k < spec.length; k++) {
    var c = spec[k];
    if (c === '*') { if (this.src[this.i] === '*') this.i++; }
    else if (c === 'o') this.readOpt();
    else this.rawArg();
  }
};
P.prototype.findCS = function (ch, from) {
  var s = this.src;
  for (var i = from; i < this.n - 1; i++) if (s[i] === '\\') { if (s[i + 1] === ch) return i; i++; }
  return -1;
};
P.prototype.findDollar = function (from) {
  var s = this.src, d = 0;
  for (var j = from; j < this.n; j++) {
    var c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '%') { var e = s.indexOf('\n', j); if (e < 0) return -1; j = e - 1; continue; }
    if (c === '{') d++;
    else if (c === '}') { d--; if (d < 0) return -1; }
    else if (c === '$') { if (d === 0) return j; var k = s.indexOf('$', j + 1); if (k < 0) return -1; j = k; }
    else if (c === '\n' && this.blankAt(j + 1)) return -1;
  }
  return -1;
};
P.prototype.regLabels = function (tex) {
  var re = /\\label\s*\{([^}]*)\}/g, m;
  while ((m = re.exec(tex))) this.S.eqLabels[m[1].trim()] = 1;
};
P.prototype.fragMath = function (tex) {
  return tex.replace(/\\label\s*\{[^}]*\}/g, '').replace(NUMBERED, function (x, a, b) { return '\\' + a + '{' + b + '*}'; });
};
P.prototype.mathInline = function (tex) {
  tex = stripComments(tex);
  return '<span class="mi">\\(' + esc(tex) + '\\)</span>';
};
P.prototype.mathBlock = function (tex) {
  tex = stripComments(tex);
  if (this.S.frag) tex = this.fragMath(tex); else this.regLabels(tex);
  return '<div class="md">' + esc(tex) + '</div>';
};
P.prototype.dollar = function (ctx) {
  var s = this.src, i = this.i;
  if (s[i + 1] === '$') {
    var e = s.indexOf('$$', i + 2);
    if (e < 0 || e >= this.n) { this.warn('$$ is never closed', i); this.i = i + 2; return; }
    this.i = e + 2;
    this.push(ctx, this.mathBlock('\\[' + s.slice(i + 2, e) + '\\]'), i);
    return;
  }
  var j = this.findDollar(i + 1);
  if (j < 0) { this.warn('$ is never closed', i); this.inl(ctx, '$'); this.i = i + 1; return; }
  this.i = j + 1;
  this.inl(ctx, this.mathInline(s.slice(i + 1, j)));
};

P.prototype.parse = function (stop, top) {
  var s = this.src, ctx = { blocks: [], para: [], pStart: -1, stop: stop || {}, top: !!top, t0: this.i };
  var RUN = /[^\\%\n \t\r{}$~&\-`'"#<>]+/y;
  while (this.i < this.n) {
    var c = s[this.i], t0 = this.i, nb = ctx.blocks.length, m;
    this.tok = t0; ctx.t0 = t0;
    if (c === '\\') {
      if (top) this.base = t0;
      if (this.command(ctx)) break;
      this.patch(ctx, nb, t0);
      continue;
    }
    if (c === '%') {
      this.skipComment();
      if (this.blankAt(this.i)) { this.flush(ctx); while (this.i < this.n && /\s/.test(s[this.i])) this.i++; }
      continue;
    }
    if (c === '\n') {
      if (this.blankAt(t0 + 1)) { this.flush(ctx); while (this.i < this.n && /\s/.test(s[this.i])) this.i++; }
      else { if (ctx.para.length) ctx.para.push(' '); this.i++; }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { if (ctx.para.length) ctx.para.push(' '); this.i++; continue; }
    if (c === '{') {
      if (top) this.base = t0;
      this.i++;
      var inner = this.parse({ brace: true });
      if (s[this.i] === '}' && this.i < this.n) this.i++; else this.warn('{ is never closed', t0);
      this.emitBlocks(ctx, inner);
      this.patch(ctx, nb, t0);
      continue;
    }
    if (c === '}') { if (ctx.stop.brace) break; this.warn('Unmatched }', t0); this.i++; continue; }
    if (c === '$') { if (top) this.base = t0; this.dollar(ctx); this.patch(ctx, nb, t0); continue; }
    if (c === '~') { this.inl(ctx, '&nbsp;'); this.i++; continue; }
    if (c === '&') { this.inl(ctx, '&amp;'); this.i++; continue; }
    if (c === '<') { this.inl(ctx, '&lt;'); this.i++; continue; }
    if (c === '>') { this.inl(ctx, '&gt;'); this.i++; continue; }
    if (c === '#') { this.i++; continue; }
    if (c === '-') {
      if (s[t0 + 1] === '-' && s[t0 + 2] === '-') { this.inl(ctx, '—'); this.i += 3; }
      else if (s[t0 + 1] === '-') { this.inl(ctx, '–'); this.i += 2; }
      else { this.inl(ctx, '-'); this.i++; }
      continue;
    }
    if (c === '`') { if (s[t0 + 1] === '`') { this.inl(ctx, '“'); this.i += 2; } else { this.inl(ctx, '‘'); this.i++; } continue; }
    if (c === "'") { if (s[t0 + 1] === "'") { this.inl(ctx, '”'); this.i += 2; } else { this.inl(ctx, '’'); this.i++; } continue; }
    if (c === '"') { this.inl(ctx, '”'); this.i++; continue; }
    m = at(RUN, s, t0);
    if (m) { var end = Math.min(this.n, t0 + m[0].length); this.inl(ctx, s.slice(t0, end)); this.i = end; }
    else { this.inl(ctx, esc(c)); this.i++; }
  }
  this.flush(ctx, this.i);
  return ctx.blocks;
};

P.prototype.symbol = function (ctx, ch, start) {
  var S = this.S, s = this.src, e, t;
  if (S.preamble) return false;
  switch (ch) {
    case '\\': if (s[this.i] === '*') this.i++; this.readOpt(); this.inl(ctx, '<br>'); return false;
    case '(':
      e = this.findCS(')', this.i);
      if (e < 0) { this.warn('\\( is never closed', start); return false; }
      t = s.slice(this.i, e); this.i = e + 2; this.inl(ctx, this.mathInline(t)); return false;
    case '[':
      e = this.findCS(']', this.i);
      if (e < 0) { this.warn('\\[ is never closed', start); return false; }
      t = s.slice(this.i, e); this.i = e + 2; this.push(ctx, this.mathBlock('\\[' + t + '\\]'), start); return false;
    case ')': case ']': this.warn('\\' + ch + ' without an opening', start); return false;
    case ' ': case '\n': case '\t': ctx.para.push(' '); return false;
    case ',': this.inl(ctx, '&thinsp;'); return false;
    case ';': case ':': case '>': this.inl(ctx, ' '); return false;
    case '!': case '/': case '-': case '@': return false;
    case "'": case '`': case '^': case '"': case '~': case '=': case '.':
      t = this.rawArg(); if (t === '\\i') t = 'i'; if (t === '\\j') t = 'j';
      this.inl(ctx, esc((t + ACC[ch]).normalize('NFC'))); return false;
    default: this.inl(ctx, esc(ch)); return false;
  }
};

P.prototype.color = function (opt, name) {
  name = String(name).trim();
  if (opt && /html/i.test(opt) && /^[0-9a-fA-F]{6}$/.test(name)) return '#' + name;
  if (opt && /^rgb$/i.test(opt.trim())) {
    var p = name.split(',').map(parseFloat);
    if (p.length === 3 && p.every(function (x) { return x >= 0; })) return 'rgb(' + p.map(function (x) { return Math.round((x <= 1 ? x * 255 : x)); }).join(',') + ')';
  }
  return this.colorExpr(name);
};
P.prototype.colorName = function (n) {
  n = String(n).trim();
  var S = this.S;
  if (S.colors[n]) return S.colors[n];
  if (COLORS[n]) return COLORS[n];
  if (DVIPS[n] && !(S.svg && BOTH[n])) return '#' + DVIPS[n];
  return /^[A-Za-z]+$/.test(n) ? n.toLowerCase() : '';
};
/* xcolor expressions such as TealBlue!5 or ForestGreen!70!black; white and black follow the page theme */
P.prototype.colorExpr = function (expr) {
  var parts = String(expr).split('!'), cur = this.colorName(parts[0]);
  if (!cur) return '';
  for (var k = 1; k < parts.length; k += 2) {
    var pct = parseFloat(parts[k]), other = parts[k + 1] != null ? this.colorName(parts[k + 1]) : 'var(--paper)';
    if (!(pct >= 0) || !other) break;
    cur = 'color-mix(in srgb,' + cur + ' ' + Math.min(100, pct) + '%,' + other + ')';
  }
  return cur;
};
P.prototype.textColor = function (c) { return 'color:color-mix(in srgb,' + c + ' var(--tmix),var(--ink));'; };
P.prototype.fontCss = function (f) {
  var c = /\\bfseries|\\bf(?![a-zA-Z])|\\textbf/.test(f) ? 'font-weight:600;' : 'font-weight:400;', m;
  if (/\\sffamily|\\sf(?![a-zA-Z])/.test(f)) c += 'font-family:var(--sans);font-size:.94em;';
  if (/\\itshape|\\it(?![a-zA-Z])|\\em(?![a-zA-Z])/.test(f)) c += 'font-style:italic;';
  if (/\\scshape/.test(f)) c += 'font-variant:small-caps;';
  if ((m = /\\color\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(f))) { var col = this.colorExpr(m[1]); if (col) c += this.textColor(col); }
  return c;
};
P.prototype.boxCss = function (k) {
  var line = k.linecolor ? this.colorExpr(k.linecolor) : '', bg = k.backgroundcolor ? this.colorExpr(k.backgroundcolor) : '';
  var lw = k.linewidth ? Math.max(1, Math.round(parseFloat(k.linewidth) * 1.33)) || 1 : 1;
  var css = 'border-style:solid;border-color:' + (line || 'var(--ink)') + ';border-width:' + ['top', 'right', 'bottom', 'left'].map(function (x) { return k[x + 'line'] === 'false' ? '0' : lw + 'px'; }).join(' ') + ';';
  if (bg) css += 'background:' + bg + ';';
  if (k.roundcorner) css += 'border-radius:' + (Math.round(parseFloat(k.roundcorner) * 1.33) || 0) + 'px;';
  return css;
};
function keyvals(str) {
  var o = {}, parts = splitTop(str || '', ',');
  for (var k = 0; k < parts.length; k++) {
    var p = parts[k], eq = p.indexOf('='), key = (eq < 0 ? p : p.slice(0, eq)).trim(), val = eq < 0 ? 'true' : p.slice(eq + 1).trim();
    if (key) o[key] = val.replace(/^\{([\s\S]*)\}$/, '$1');
  }
  return o;
}

P.prototype.decl = function (ctx, style) {
  if (ctx.top || ctx.single || !style) return;
  var inner = this.parse(ctx.stop);
  if (!inner.length) return;
  if (inner.length === 1 && inner[0].t === 'p') this.inl(ctx, '<span style="' + style + '">' + inner[0].html + '</span>');
  else this.push(ctx, '<div style="' + style + '">' + this.joinBlocks(inner) + '</div>');
};

P.prototype.defCommand = function (kind, start) {
  var S = this.S;
  if (this.src[this.i] === '*') this.i++;
  var name = this.rawArg().trim().replace(/^\\/, '');
  var nopt = this.readOpt(), dflt = nopt != null ? this.readOpt() : null, body = this.rawArg();
  if (!name) return;
  var n = parseInt(nopt, 10) || 0, m = { n: n, dflt: dflt, body: body }, x;
  if (kind === 'providecommand' && S.macros[name]) return;
  if ((x = /^\s*\\begin\s*\{([^}]+)\}\s*$/.exec(body))) m.beginOf = x[1];
  if ((x = /^\s*\\end\s*\{([^}]+)\}\s*$/.exec(body))) { m.endOf = x[1]; (S.endAlias[x[1]] = S.endAlias[x[1]] || []).push(name); S.aliasEnd[name] = x[1]; }
  S.macros[name] = m;
  if (name.indexOf('@') < 0) S.mathDefs.push('\\newcommand{\\' + name + '}' + (n ? '[' + n + ']' : '') + (dflt != null ? '[' + dflt + ']' : '') + '{' + body + '}');
};
P.prototype.defDef = function (start) {
  var S = this.S, s = this.src;
  this.ws();
  var name = this.rawArg().replace(/^\\/, ''), k = this.i;
  while (k < this.n && s[k] !== '{') k++;
  var params = s.slice(this.i, k), n = (params.match(/#\d/g) || []).length;
  this.i = k;
  var body = this.rawArg();
  if (!name) return;
  S.macros[name] = { n: n, dflt: null, body: body };
  if (name.indexOf('@') < 0 && /^(?:#\d)*$/.test(params.trim())) S.mathDefs.push('\\def\\' + name + params.trim() + '{' + body + '}');
};
P.prototype.newTheorem = function () {
  var S = this.S, star = false;
  if (this.src[this.i] === '*') { star = true; this.i++; }
  var name = this.rawArg().trim(), shared = this.readOpt(), title = this.rawArg(), within = this.readOpt();
  if (!name) return;
  var def = { title: title, style: S.theoremStyle, star: star, counter: name };
  if (shared && S.theorems[shared.trim()]) def.counter = S.theorems[shared.trim()].counter;
  else if (!star) { S.counters[name] = 0; if (within) S.within[name] = within.trim(); }
  S.theorems[name] = def;
};

P.prototype.expand = function (ctx, name, m, start) {
  var args = [], k = m.n;
  if (m.dflt != null && k > 0) { var o = this.src[this.i] === '[' ? this.readOpt() : null; args.push(o != null ? o : m.dflt); k--; }
  for (; k > 0; k--) args.push(this.rawArg());
  var body = m.body.replace(/#(\d)/g, function (x, d) { var a = args[d - 1]; return a == null ? '' : a; });
  this.emitBlocks(ctx, this.subBlocks(body));
};

P.prototype.heading = function (ctx, name, level, start) {
  var S = this.S, star = false;
  if (this.src[this.i] === '*') { star = true; this.i++; }
  this.readOpt();
  var title = this.inlineArg(), num = '';
  if (!star && !S.frag) { S.step(name); num = S.the(name, this); }
  S.curLabel = num; S.curType = name === 'section' ? 'Section' : name === 'part' ? 'Part' : 'Section';
  var id = 'h' + S.toc.length;
  S.toc.push({ level: level, num: num, html: title, id: id });
  var tag = 'h' + Math.min(6, level + 1);
  this.push(ctx, '<' + tag + ' class="sec l' + level + (S.koma ? ' koma' : '') + '" data-hid="' + id + '">' + (num ? '<span class="secno">' + esc(num) + '</span>' : '') + title + '</' + tag + '>', start);
};

P.prototype.refTok = function (kind, start) {
  if (this.src[this.i] === '*') this.i++;
  if (kind === 'cite') this.readOpt();
  var key = this.rawArg().replace(/[\u0001\u0002|]/g, '').trim();
  return '\u0001R|' + kind + '|' + (this.mapped ? start : this.S.curPos) + '|' + key + '\u0002';
};

P.prototype.command = function (ctx) {
  var s = this.src, S = this.S, start = this.i, j = start + 1, name, t, h, m, k, opt;
  if (j >= this.n) { this.i = j; return false; }
  if (!(isLetter(s[j]) || (s[j] === '@' && S.atletter))) { this.i = j + 1; return this.symbol(ctx, s[j], start); }
  k = j + 1; while (k < this.n && (isLetter(s[k]) || (s[k] === '@' && S.atletter))) k++;
  name = s.slice(j, k); this.i = k;
  if (this.mapped) S.curPos = start;
  if (S.preamble && !PRE[name]) return false;

  m = PROTECTED[name] ? null : S.macros[name];
  if (name === 'end' || (m && m.endOf)) {
    var en = m ? m.endOf : this.rawArg().trim();
    if (ctx.stop.env === en || this.envStack.indexOf(en) >= 0) { this.i = start; return true; }
    if (en === 'document') { this.i = this.n; return false; }
    this.warn('\\end{' + en + '} has no matching \\begin', start);
    return false;
  }
  if (name === 'item') {
    if (ctx.stop.item || S.listDepth > 0) { this.i = start; return true; }
    this.warn('\\item outside a list', start); return false;
  }
  var afterName = this.i;
  if (name !== 'verb') this.eatSp();
  if (m) {
    if (m.beginOf) { this.beginEnv(ctx, m.beginOf, start); return false; }
    this.expand(ctx, name, m, start); return false;
  }

  switch (name) {
    case 'begin': this.beginEnv(ctx, this.rawArg().trim(), start); return false;
    case 'par': this.flush(ctx); return false;
    case 'newline': case 'linebreak': this.readOpt(); this.inl(ctx, '<br>'); return false;
    case 'hfill': this.inl(ctx, HF); return false;
    case 'part': this.heading(ctx, 'part', 1, start); return false;
    case 'chapter': case 'section': this.heading(ctx, 'section', 1, start); return false;
    case 'subsection': this.heading(ctx, 'subsection', 2, start); return false;
    case 'subsubsection': this.heading(ctx, 'subsubsection', 3, start); return false;
    case 'paragraph': case 'subparagraph':
      if (s[this.i] === '*') this.i++;
      h = this.inlineArg(); this.flush(ctx); this.inl(ctx, '<strong class="runin">' + h + '</strong> '); return false;
    case 'appendix': S.appendix = true; S.counters.section = 0; return false;
    case 'maketitle':
      h = '<div class="ttl' + (S.koma ? ' koma' : '') + '">';
      if (S.title != null) h += '<h1>' + this.sub(S.title) + '</h1>';
      if (S.author) h += '<div class="au">' + this.sub(S.author) + '</div>';
      t = S.date == null ? '\\today' : S.date;
      if (t.trim()) h += '<div class="dt">' + this.sub(t) + '</div>';
      this.push(ctx, h + '</div>', start); return false;
    case 'title': S.title = this.rawArg(); return false;
    case 'author': S.author = this.rawArg(); return false;
    case 'date': S.date = this.rawArg(); return false;
    case 'today': this.inl(ctx, esc(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))); return false;
    case 'tableofcontents': this.push(ctx, TOC, start); return false;
    case 'label':
      t = this.rawArg().trim();
      if (S.frag) return false;
      if (S.labels[t] || S.eqLabels[t]) this.warn('Label “' + t + '” is defined more than once', start);
      S.labels[t] = { num: S.curLabel, type: S.curType };
      this.inl(ctx, '<span class="anc" data-label="' + escAttr(t) + '"></span>'); return false;
    case 'ref': case 'eqref': case 'cref': case 'Cref': case 'autoref': case 'pageref': case 'nameref': case 'cite': case 'citep': case 'citet':
      this.inl(ctx, this.refTok(name === 'citep' || name === 'citet' ? 'cite' : name, start)); return false;
    case 'hyperref': opt = this.readOpt(); this.inl(ctx, this.inlineArg()); return false;
    case 'footnote':
      this.readOpt(); h = this.inlineArg(); S.footnotes.push(h);
      this.inl(ctx, '<sup class="fn">' + S.footnotes.length + '</sup>'); return false;
    case 'caption':
      if (s[this.i] === '*') this.i++;
      this.readOpt(); h = this.inlineArg();
      t = S.floats.length ? S.floats[S.floats.length - 1] : 'figure';
      if (!S.frag) { S.step(t); S.curLabel = S.the(t); } else S.curLabel = '';
      S.curType = t === 'table' ? 'Table' : 'Figure';
      this.push(ctx, '<div class="cap"><strong>' + S.curType + (S.curLabel ? ' ' + S.curLabel : '') + '.</strong> ' + h + '</div>', start); return false;
    case 'href':
      t = this.rawArg().trim(); h = this.inlineArg();
      this.inl(ctx, /^(https?:|mailto:)/i.test(t) ? '<a class="ext" href="' + escAttr(t) + '" target="_blank" rel="noopener noreferrer">' + h + '</a>' : h); return false;
    case 'url': case 'nolinkurl':
      t = this.rawArg().trim();
      this.inl(ctx, /^https?:/i.test(t) ? '<a class="ext tt" href="' + escAttr(t) + '" target="_blank" rel="noopener noreferrer">' + esc(t) + '</a>' : '<span class="tt">' + esc(t) + '</span>'); return false;
    case 'includegraphics':
      if (s[this.i] === '*') this.i++;
      this.readOpt(); t = this.rawArg();
      this.inl(ctx, '<span class="gfx">Image: ' + esc(t) + '</span>'); return false;
    case 'tikz':
      this.readOpt(); this.ws();
      if (s[this.i] === '{') this.rawArg(); else { k = s.indexOf(';', this.i); this.i = k < 0 ? this.i : Math.min(this.n, k + 1); }
      this.inl(ctx, '<span class="gfx">TikZ drawing</span>'); return false;
    case 'verb':
      this.i = afterName; if (s[this.i] === '*') this.i++;
      t = s[this.i]; k = s.indexOf(t, this.i + 1);
      if (k < 0 || k >= this.n) { this.warn('\\verb is never closed', start); this.i = this.n; return false; }
      this.inl(ctx, '<span class="tt no-mj">' + esc(s.slice(this.i + 1, k)) + '</span>'); this.i = k + 1; return false;
    case 'textcolor': case 'colorbox':
      opt = this.readOpt(); t = this.color(opt, this.rawArg()); h = this.inlineArg();
      this.inl(ctx, t ? '<span style="' + (name === 'colorbox' ? 'background:' + t : this.textColor(t)) + '">' + h + '</span>' : h); return false;
    case 'color': opt = this.readOpt(); t = this.color(opt, this.rawArg()); this.decl(ctx, t ? this.textColor(t) : ''); return false;
    case 'parbox': this.readOpt(); this.readOpt(); this.readOpt(); this.rawArg(); this.inl(ctx, this.inlineArg()); return false;
    case 'makebox': case 'framebox': this.readOpt(); this.readOpt(); this.inl(ctx, this.inlineArg()); return false;
    case 'raisebox': this.rawArg(); this.readOpt(); this.readOpt(); this.inl(ctx, this.inlineArg()); return false;
    case 'scalebox': this.rawArg(); this.readOpt(); this.inl(ctx, this.inlineArg()); return false;
    case 'resizebox': if (s[this.i] === '*') this.i++; this.rawArg(); this.rawArg(); this.inl(ctx, this.inlineArg()); return false;
    case 'multirow': this.rawArg(); this.rawArg(); this.inl(ctx, this.inlineArg()); return false;
    case 'ensuremath': this.inl(ctx, this.mathInline(this.rawArg())); return false;
    case 'hrule': this.push(ctx, '<hr>', start); return false;
    case 'rule': this.readOpt(); t = this.rawArg(); this.rawArg(); this.inl(ctx, '<span class="rule" style="width:' + Math.min(30, len2em(t)).toFixed(2) + 'em"></span>'); return false;
    case 'newpage': case 'clearpage': case 'pagebreak': case 'cleardoublepage':
      this.readOpt(); if (!ctx.single) this.push(ctx, '<div class="pb" title="Page break"></div>', start); return false;
    case 'smallskip': case 'medskip': case 'bigskip':
      this.push(ctx, '<div class="vs" style="height:' + { smallskip: 0.3, medskip: 0.6, bigskip: 1.2 }[name] + 'em"></div>', start); return false;
    case 'vspace': case 'vskip':
      if (s[this.i] === '*') this.i++;
      if (name === 'vspace' || s[this.i] === '{') t = this.rawArg(); else { m = at(/\s*-?[\d.]+\s*[a-z]{2}/y, s, this.i); t = m ? m[0] : ''; if (m) this.i += m[0].length; }
      this.push(ctx, '<div class="vs" style="height:' + len2em(t).toFixed(2) + 'em"></div>', start); return false;
    case 'hspace': case 'hskip': case 'kern':
      if (s[this.i] === '*') this.i++;
      if (name === 'hspace' || s[this.i] === '{') t = this.rawArg(); else { m = at(/\s*-?[\d.]+\s*[a-z]{2}/y, s, this.i); t = m ? m[0] : ''; if (m) this.i += m[0].length; }
      this.inl(ctx, '<span style="display:inline-block;width:' + len2em(t).toFixed(2) + 'em"></span>'); return false;
    case 'setcounter': t = this.rawArg().trim(); S.counters[t] = parseInt(this.rawArg(), 10) || 0; return false;
    case 'addtocounter': t = this.rawArg().trim(); S.counters[t] = (S.counters[t] || 0) + (parseInt(this.rawArg(), 10) || 0); return false;
    case 'stepcounter': S.step(this.rawArg().trim()); return false;
    case 'numberwithin': t = this.rawArg().trim(); k = this.rawArg().trim(); if (t !== 'equation') S.within[t] = k; return false;
    case 'arabic': case 'alph': case 'Alph': case 'roman': case 'Roman': case 'fnsymbol':
      this.inl(ctx, esc(fmtCounter(name, S.counters[this.rawArg().trim()] || 0))); return false;
    case 'bibitem':
      this.readOpt(); t = this.rawArg().trim(); S.step('bib'); S.bib[t] = S.counters.bib;
      this.flush(ctx); this.inl(ctx, '<span class="bibn">[' + S.counters.bib + ']</span> '); return false;
    case 'input': case 'include': case 'subfile':
      t = this.rawArg(); this.warn('\\' + name + '{' + t + '} is skipped: the preview reads one file only', start);
      this.inl(ctx, '<span class="gfx">\\' + name + ': ' + esc(t) + '</span>'); return false;
    case 'qed': this.inl(ctx, '<span class="qed">□</span>'); return false;
    case 'newcommand': case 'renewcommand': case 'providecommand': case 'DeclareRobustCommand': this.defCommand(name, start); return false;
    case 'def': case 'gdef': case 'edef': case 'xdef': this.defDef(start); return false;
    case 'let':
      t = this.rawArg().replace(/^\\/, ''); this.ws(); if (s[this.i] === '=') this.i++;
      k = this.rawArg();
      if (S.macros[k.replace(/^\\/, '')]) S.macros[t] = S.macros[k.replace(/^\\/, '')];
      if (t && k) S.mathDefs.push('\\let\\' + t + '=' + k);
      return false;
    case 'DeclareMathOperator': case 'DeclarePairedDelimiter':
      if (s[this.i] === '*') this.i++;
      this.rawArg(); this.rawArg(); if (name === 'DeclarePairedDelimiter') this.rawArg();
      S.mathDefs.push(s.slice(start, this.i)); return false;
    case 'newtheorem': this.newTheorem(); return false;
    case 'theoremstyle': S.theoremStyle = this.rawArg().trim(); return false;
    case 'newenvironment': case 'renewenvironment':
      if (s[this.i] === '*') this.i++;
      t = this.rawArg().trim(); opt = this.readOpt(); k = opt != null ? this.readOpt() : null;
      S.envs[t] = { n: parseInt(opt, 10) || 0, dflt: k, begin: this.rawArg(), end: this.rawArg() };
      S.mathDefs.push(s.slice(start, this.i)); return false;
    case 'usepackage': case 'documentclass': case 'RequirePackage':
      opt = this.readOpt() || ''; t = this.rawArg();
      if (name === 'documentclass') { if (/^scr/.test(t.trim())) S.koma = true; }
      else if (/\bxcolor\b/.test(t) && /svgnames/.test(opt)) S.svg = true;
      return false;
    case 'definecolor': t = this.rawArg().trim(); opt = this.rawArg(); k = this.color(opt, this.rawArg()); if (k) S.colors[t] = k; return false;
    case 'colorlet': t = this.rawArg().trim(); k = this.colorExpr(this.rawArg()); if (k) S.colors[t] = k; return false;
    case 'mdfdefinestyle': t = this.rawArg().trim(); S.mdf[t] = keyvals(this.rawArg()); return false;
    case 'declaretheoremstyle': {
      var kv = keyvals(this.readOpt() || ''), ts = { head: kv.headfont != null ? this.fontCss(kv.headfont) : 'font-weight:600;', body: kv.bodyfont && /\\itshape|\\it(?![a-zA-Z])/.test(kv.bodyfont) ? 'font-style:italic;' : '', punct: kv.headpunct != null ? kv.headpunct : '.', box: null };
      t = this.rawArg().trim();
      if (kv.mdframed != null) {
        var mk = keyvals(kv.mdframed), all = {}, bs = mk.style && S.mdf[mk.style] ? S.mdf[mk.style] : {}, q;
        for (q in bs) all[q] = bs[q];
        for (q in mk) all[q] = mk[q];
        ts.box = this.boxCss(all);
      }
      S.thmStyles[t] = ts; return false;
    }
    case 'declaretheorem': {
      var kd = keyvals(this.readOpt() || ''), nms = this.rawArg().split(',');
      for (k = 0; k < nms.length; k++) {
        var nm = nms[k].trim(); if (!nm) continue;
        var bn = nm.replace(/\*$/, ''), def = { title: kd.name || kd.title || bn.charAt(0).toUpperCase() + bn.slice(1), style: /^(definition|remark)$/.test(kd.style || '') ? kd.style : 'plain', ts: kd.style || '', star: /^(no|false)$/.test(kd.numbered || ''), counter: nm };
        var sib = (kd.sibling || kd.numberlike || kd.sharenumber || kd.sharecounter || '').trim();
        if (sib && S.theorems[sib]) def.counter = S.theorems[sib].counter;
        else if (!def.star) { S.counters[nm] = 0; var wi = kd.numberwithin || kd.within || kd.parent; if (wi) S.within[nm] = wi.trim(); }
        S.theorems[nm] = def;
      }
      return false;
    }
    case 'iffalse': {
      var re = /\\(if[a-zA-Z@]*|fi)(?![a-zA-Z@])/g, dep = 0, mm; re.lastIndex = this.i;
      while ((mm = re.exec(s))) {
        if (mm.index >= this.n) break;
        if (mm[1] === 'fi') { if (dep === 0) { this.i = Math.min(this.n, mm.index + mm[0].length); return false; } dep--; }
        else if (mm[1] !== 'iff') dep++;
      }
      this.warn('\\iffalse without \\fi', start); this.i = this.n; return false;
    }
    case 'epigraph':
      h = this.inlineArg(); t = this.inlineArg();
      this.push(ctx, '<div class="epi"><div>' + h + '</div><div class="epi-s">' + t + '</div></div>', start); return false;
    case 'todo': case 'missingfigure':
      this.readOpt(); h = this.inlineArg();
      this.inl(ctx, '<span class="todo">' + (name === 'todo' ? 'To do: ' : 'Missing figure: ') + h + '</span>'); return false;
    case 'makeatletter': S.atletter = true; return false;
    case 'makeatother': S.atletter = false; return false;
    case 'c': case 'v': case 'u': case 'H': case 'k': case 'r': case 'd': case 'b':
      t = this.rawArg(); if (t === '\\i') t = 'i';
      this.inl(ctx, esc((t + ACC[name]).normalize('NFC'))); return false;
  }
  if (name.length > 3 && name.slice(0, 3) === 'the' && S.counters[name.slice(3)] != null) { this.inl(ctx, esc(S.the(name.slice(3), this))); return false; }
  if (WRAP[name]) { h = this.inlineArg(); this.inl(ctx, WRAP[name][0] + h + WRAP[name][1]); return false; }
  if (DECL[name] != null) { this.decl(ctx, DECL[name]); return false; }
  if (SYM[name] != null) { this.inl(ctx, SYM[name]); return false; }
  if (IGNORE[name] != null) { this.skipSpec(IGNORE[name]); return false; }
  if (!S.quiet) {
    if (S.unk[name]) S.unk[name].n++;
    else { var w = this.warn('Unknown command \\' + name + ' in text', start); if (w) S.unk[name] = { w: w, n: 1 }; }
  }
  this.inl(ctx, '<span class="unk">\\' + esc(name) + '</span>');
  return false;
};

/* ---------- environments ---------- */
P.prototype.endAt = function (i) {
  var m = at(/\\end\s*\{([^}]*)\}/y, this.src, i);
  if (m) return { name: m[1].trim(), next: i + m[0].length };
  m = at(/\\([a-zA-Z]+)/y, this.src, i);
  if (m && this.S.aliasEnd[m[1]]) return { name: this.S.aliasEnd[m[1]], next: i + m[0].length };
  return null;
};
P.prototype.closeEnv = function (name) {
  var e = this.i < this.n ? this.endAt(this.i) : null;
  if (e && e.name === name) { this.i = Math.min(this.n, e.next); return; }
  this.warn('Missing \\end{' + name + '}');
};
P.prototype.envBody = function (name, stop) {
  this.envStack.push(name);
  var b = this.parse(stop || { env: name });
  this.envStack.pop();
  this.closeEnv(name);
  return b;
};
P.prototype.findEnd = function (name, from) {
  var nm = reEsc(name), alts = '\\\\end\\s*\\{' + nm + '\\}', al = this.S.endAlias[name];
  if (al && al.length) alts += '|\\\\(?:' + al.map(reEsc).join('|') + ')(?![a-zA-Z])';
  var re = new RegExp('\\\\begin\\s*\\{' + nm + '\\}|(' + alts + ')', 'g'), d = 0, m;
  re.lastIndex = from;
  while ((m = re.exec(this.src))) {
    if (m.index >= this.n) break;
    if (!m[1]) { d++; continue; }
    if (d === 0) return { at: m.index, next: Math.min(this.n, m.index + m[0].length) };
    d--;
  }
  this.warn('Missing \\end{' + name + '}', from);
  return { at: this.n, next: this.n };
};

P.prototype.enumFmt = function (opt, depth) {
  var S = this.S, tpl = null, start = 1, resume = false, C = /\\(arabic|alph|Alph|roman|Roman)\s*\*/g;
  if (opt != null && opt.trim()) {
    if (/(^|,)\s*(label|start|resume|leftmargin|itemsep|topsep|noitemsep|nosep|ref|align|font|wide|labelindent|labelsep|itemindent|parsep|series|nolistsep)\b/.test(opt)) {
      var parts = splitTop(opt, ',');
      for (var q = 0; q < parts.length; q++) {
        var eq = parts[q].indexOf('='), key = (eq < 0 ? parts[q] : parts[q].slice(0, eq)).trim(), val = eq < 0 ? '' : parts[q].slice(eq + 1).trim();
        if (key === 'label') tpl = val.replace(/^\{([\s\S]*)\}$/, '$1');
        else if (key === 'start') start = parseInt(val, 10) || 1;
        else if (key === 'resume' || key === 'resume*') resume = true;
      }
    } else {
      var o = '', d = 0, done = false;
      for (var k = 0; k < opt.length; k++) {
        var c = opt[k];
        if (c === '\\') { var m = at(/\\(?:[a-zA-Z]+|.)/y, opt, k); o += m[0]; k += m[0].length - 1; continue; }
        if (c === '{') d++; else if (c === '}') d--;
        if (!done && d === 0 && 'AaIi1'.indexOf(c) >= 0) { o += { A: '\\Alph*', a: '\\alph*', I: '\\Roman*', i: '\\roman*', '1': '\\arabic*' }[c]; done = true; }
        else o += c;
      }
      tpl = o;
    }
  }
  if (!tpl) {
    var mac = S.macros['labelenum' + ['i', 'ii', 'iii', 'iv'][Math.min(depth, 3)]];
    if (mac) tpl = mac.body.replace(/\\(arabic|alph|Alph|roman|Roman)\s*\{enumi*v?\}/g, '\\$1*').replace(/\\theenumi*v?/g, '\\arabic*');
    else tpl = ['\\arabic*.', '(\\alph*)', '\\roman*.', '\\Alph*.'][Math.min(depth, 3)];
  }
  return { fmt: function (n) { return tpl.replace(C, function (x, kk) { return fmtCounter(kk, n); }); }, start: start, resume: resume };
};

P.prototype.list = function (ctx, name, start) {
  var S = this.S, s = this.src, opt = this.readOpt(), f = null, n = 0, items = [], IT = /\\item(?![a-zA-Z])/y;
  this.flush(ctx);
  S.listDepth++;
  if (name === 'enumerate') { f = this.enumFmt(opt, S.enumDepth); S.enumDepth++; n = f.resume ? S.lastEnum : f.start - 1; }
  else if (name === 'itemize') S.itemDepth++;
  this.envStack.push(name);
  var pre = this.parse({ env: name, item: true });
  while (this.i < this.n && at(IT, s, this.i)) {
    var s0 = this.i, label, lopt;
    this.i += 5;
    lopt = this.readOpt();
    if (name === 'enumerate') {
      if (lopt != null) label = this.sub(lopt);
      else { n++; var raw = f.fmt(n); label = this.sub(raw); S.curLabel = stripTags(this.sub(raw.replace(/[.:]\s*$/, ''))); S.curType = 'item'; }
    } else if (name === 'itemize') label = lopt != null ? this.sub(lopt) : ['•', '–', '∗', '·'][Math.min(S.itemDepth - 1, 3)];
    else label = lopt != null ? '<strong>' + this.sub(lopt) + '</strong>' : '';
    var body = this.parse({ env: name, item: true });
    items.push({ label: label, body: body, s: s0, e: this.i });
  }
  this.envStack.pop();
  S.listDepth--;
  if (name === 'enumerate') { S.enumDepth--; if (S.enumDepth === 0) S.lastEnum = n; } else if (name === 'itemize') S.itemDepth--;
  this.closeEnv(name);
  var h = '<div class="lst ' + (name === 'description' ? 'desc' : name === 'enumerate' ? 'enum' : 'item') + '">';
  if (pre.length && !items.length) h += this.joinBlocks(pre);
  for (var k = 0; k < items.length; k++) {
    var it = items[k], o = this.o(it);
    if (name === 'description') {
      var b = it.body.slice();
      if (b.length && b[0].t === 'p') b[0] = { t: 'p', html: it.label + ' ' + b[0].html, s: b[0].s, e: b[0].e }; else b.unshift({ t: 'p', html: it.label, s: -1, e: -1 });
      h += '<div class="li"' + o + '><div class="lc">' + this.joinBlocks(b) + '</div></div>';
    } else h += '<div class="li"' + o + '><div class="lb">' + it.label + '</div><div class="lc">' + this.joinBlocks(it.body) + '</div></div>';
  }
  ctx.blocks.push({ t: 'b', html: h + '</div>', s: start, e: this.i });
};

function splitTop(str, sep) {
  var out = [], d = 0, cur = '';
  for (var k = 0; k < str.length; k++) {
    var c = str[k];
    if (c === '\\') { cur += c + (str[k + 1] || ''); k++; continue; }
    if (c === '{') d++; else if (c === '}') d--;
    if (c === sep && d === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
function parseColSpec(spec) {
  var cols = [], bar = false;
  for (var k = 0; k < spec.length; k++) {
    var c = spec[k];
    if (c === '|') { bar = true; continue; }
    if (c === 'l' || c === 'c' || c === 'r') { cols.push({ a: c === 'l' ? 'left' : c === 'c' ? 'center' : 'right', bl: bar }); bar = false; continue; }
    if (c === 'p' || c === 'm' || c === 'b' || c === 'X' || c === 'L' || c === 'C' || c === 'R') { cols.push({ a: c === 'C' ? 'center' : c === 'R' ? 'right' : 'left', bl: bar }); bar = false; if (spec[k + 1] === '{') k = skipGroup(spec, k + 1); continue; }
    if (c === '@' || c === '!' || c === '>' || c === '<') { if (spec[k + 1] === '{') k = skipGroup(spec, k + 1); continue; }
    if (c === '*') {
      var e1 = skipGroup(spec, k + 1), cnt = parseInt(spec.slice(k + 2, e1), 10) || 1, e2 = skipGroup(spec, e1 + 1), inner = parseColSpec(spec.slice(e1 + 2, e2));
      for (var r = 0; r < Math.min(cnt, 40); r++) for (var q = 0; q < inner.length; q++) cols.push({ a: inner[q].a, bl: inner[q].bl || (q === 0 && bar) });
      bar = false; k = e2; continue;
    }
  }
  if (bar && cols.length) cols[cols.length - 1].br = true;
  return cols;
}
function skipGroup(str, i) {
  if (str[i] !== '{') return i;
  var d = 0;
  for (; i < str.length; i++) { if (str[i] === '\\') { i++; continue; } if (str[i] === '{') d++; else if (str[i] === '}') { d--; if (d === 0) return i; } }
  return str.length - 1;
}
function splitTable(body) {
  var rows = [[]], cur = '', d = 0, env = 0, math = false;
  for (var k = 0; k < body.length; k++) {
    var c = body[k];
    if (c === '%') { var e = body.indexOf('\n', k); k = e < 0 ? body.length : e; continue; }
    if (c === '\\') {
      var nx = body[k + 1];
      if (nx === '\\' && d === 0 && env === 0 && !math) {
        rows[rows.length - 1].push(cur); cur = ''; rows.push([]); k++;
        if (body[k + 1] === '*') k++;
        var m = at(/\s*\[[^\]]*\]/y, body, k + 1); if (m) k += m[0].length;
        continue;
      }
      var b = at(/\\(begin|end)\s*\{/y, body, k);
      if (b) env += b[1] === 'begin' ? 1 : -1;
      cur += c + (nx || ''); k++; continue;
    }
    if (c === '{') d++; else if (c === '}') d--;
    else if (c === '$') math = !math;
    if (c === '&' && d === 0 && env === 0 && !math) { rows[rows.length - 1].push(cur); cur = ''; continue; }
    cur += c;
  }
  rows[rows.length - 1].push(cur);
  return rows;
}

P.prototype.tabular = function (ctx, name, start) {
  var s = this.src;
  if (name === 'tabular*' || name === 'tabularx' || name === 'tabulary') this.rawArg();
  this.readOpt();
  var cols = parseColSpec(this.rawArg()), e = this.findEnd(name, this.i), rows = splitTable(s.slice(this.i, e.at));
  this.i = e.next;
  var RULE = /^\s*\\(?:hline|toprule|midrule|bottomrule|cline\s*\{[^}]*\}|cmidrule\s*(?:\([^)]*\))?\s*\{[^}]*\}|addlinespace(?:\[[^\]]*\])?|noalign\s*\{[^}]*\}|endhead|endfirsthead|endfoot|endlastfoot)\s*/;
  var h = '', pendingRule = false, bottom = false;
  for (var r = 0; r < rows.length; r++) {
    var cells = rows[r], rule = pendingRule, m;
    pendingRule = false;
    while ((m = RULE.exec(cells[0]))) { rule = true; cells[0] = cells[0].slice(m[0].length); }
    if (cells.length === 1 && !cells[0].trim()) { if (rule) { if (r === rows.length - 1) bottom = true; else pendingRule = true; } continue; }
    h += '<tr' + (rule ? ' class="rt"' : '') + '>';
    var ci = 0;
    for (var k = 0; k < cells.length; k++) {
      var raw = cells[k], col = cols[ci] || { a: 'left' }, span = 1, mc = /^\s*\\multicolumn\s*\{(\d+)\}\s*\{([^}]*)\}\s*/.exec(raw);
      if (mc) {
        span = parseInt(mc[1], 10) || 1;
        var cs = parseColSpec(mc[2])[0]; if (cs) col = cs;
        raw = raw.slice(mc[0].length).trim().replace(/^\{([\s\S]*)\}$/, '$1');
      }
      h += '<td' + (span > 1 ? ' colspan="' + span + '"' : '') + ' style="text-align:' + col.a + '"' + (col.bl || col.br ? ' class="' + (col.bl ? 'bl ' : '') + (col.br ? 'br' : '') + '"' : '') + '>' + this.sub(raw) + '</td>';
      ci += span;
    }
    h += '</tr>';
  }
  this.push(ctx, '<div class="tblw"><table class="tbl' + (bottom ? ' rb' : '') + '">' + h + '</table></div>', start);
};

P.prototype.beginEnv = function (ctx, name, start) {
  var S = this.S, s = this.src, base = name.replace(/\*$/, ''), e, body, h, opt, k, blocks;
  if (name === 'document' || !name) return;
  if (MATHENV[base]) {
    e = this.findEnd(name, this.i); body = s.slice(this.i, e.at); this.i = e.next;
    if (base === 'math') { this.inl(ctx, this.mathInline(body)); return; }
    this.push(ctx, this.mathBlock(base === 'displaymath' ? '\\[' + body + '\\]' : '\\begin{' + name + '}' + body + '\\end{' + name + '}'), start);
    return;
  }
  if (VERBENV[name]) {
    if (name !== 'verbatim' && name !== 'verbatim*') { this.readOpt(); if (name === 'minted') this.rawArg(); }
    e = this.findEnd(name, this.i); body = s.slice(this.i, e.at).replace(/^\n/, '').replace(/\n[ \t]*$/, ''); this.i = e.next;
    this.push(ctx, '<pre class="verb no-mj">' + esc(body) + '</pre>', start); return;
  }
  if (name === 'comment') { e = this.findEnd(name, this.i); this.i = e.next; return; }
  if (PICENV[name]) {
    e = this.findEnd(name, this.i); this.i = e.next;
    this.push(ctx, '<div class="ph">Diagram (' + esc(name) + ') is not drawn in the preview</div>', start); return;
  }
  if (TABENV[name]) { this.tabular(ctx, name, start); return; }
  if (name === 'itemize' || name === 'enumerate' || name === 'description') { this.list(ctx, name, start); return; }
  if (name === 'proof') {
    opt = this.readOpt(); this.flush(ctx);
    blocks = this.envBody(name);
    h = '<em class="pf-h">' + (opt != null ? this.sub(opt) : 'Proof') + '.</em> ';
    var qed = '<span class="qed">' + (S.macros.qedsymbol ? this.sub(S.macros.qedsymbol.body) : '□') + '</span>';
    if (blocks.length && blocks[0].t === 'p') blocks[0] = { t: 'p', html: h + blocks[0].html, s: blocks[0].s, e: blocks[0].e }; else blocks.unshift({ t: 'p', html: h, s: -1, e: -1 });
    k = blocks.length - 1;
    if (blocks[k].t === 'p') blocks[k] = { t: 'p', html: blocks[k].html + qed, s: blocks[k].s, e: blocks[k].e }; else blocks.push({ t: 'b', html: '<div class="qedp">' + qed + '</div>', s: -1, e: -1 });
    ctx.blocks.push({ t: 'b', html: '<div class="proof">' + this.joinBlocks(blocks) + '</div>', s: start, e: this.i }); return;
  }
  var th = S.theorems[name];
  if (!th && !S.envs[name] && BUILTIN_THM[base]) {
    this.warn('Environment “' + name + '” is used without \\newtheorem; the preview guessed its heading', start);
    th = S.theorems[name] = { title: BUILTIN_THM[base], style: /^(definition|defn|example|problem|exercise|solution|remark|note|question|notation)$/.test(base) ? 'definition' : 'plain', star: name !== base || base === 'solution', counter: name };
    if (!th.star) S.counters[name] = 0;
  }
  if (th) {
    opt = this.readOpt(); this.flush(ctx);
    var num = '';
    if (!th.star && !S.frag) { S.step(th.counter); num = S.the(th.counter, this); }
    var title = this.sub(th.title);
    S.curLabel = num; S.curType = stripTags(title);
    var note = opt != null ? this.sub(opt) : '';
    blocks = this.envBody(name);
    var sty = th.ts && S.thmStyles[th.ts];
    if (sty) {
      h = '<span class="th-h" style="' + sty.head + '">' + title + (num ? ' ' + esc(num) : '') + '</span>' + (note ? ' <span class="th-h" style="' + sty.head + 'font-weight:400;">(' + note + ')</span>' : '');
      if (/^\s*(\\\\|\\newline)/.test(sty.punct)) blocks.unshift({ t: 'b', html: '<div class="th-hl">' + h + '</div>', s: -1, e: -1 });
      else {
        h += '<span class="th-h" style="' + sty.head + '">' + (/^\s/.test(sty.punct) ? ' ' : '') + this.sub(sty.punct) + '</span> ';
        if (blocks.length && blocks[0].t === 'p') blocks[0] = { t: 'p', html: h + blocks[0].html, s: blocks[0].s, e: blocks[0].e }; else blocks.unshift({ t: 'p', html: h, s: -1, e: -1 });
      }
      ctx.blocks.push({ t: 'b', html: '<div class="thm tts' + (sty.box ? ' tbox' : '') + '" style="' + (sty.box || '') + sty.body + '">' + this.joinBlocks(blocks) + '</div>', s: start, e: this.i });
      return;
    }
    h = '<span class="th-h">' + title + (num ? ' ' + esc(num) : '') + (note ? '' : '.') + '</span>' + (note ? ' <span class="th-n">(' + note + ')</span><span class="th-h">.</span>' : '') + ' ';
    if (blocks.length && blocks[0].t === 'p') blocks[0] = { t: 'p', html: h + blocks[0].html, s: blocks[0].s, e: blocks[0].e }; else blocks.unshift({ t: 'p', html: h, s: -1, e: -1 });
    ctx.blocks.push({ t: 'b', html: '<div class="thm ' + (th.style === 'plain' ? 'plain' : th.style === 'remark' ? 'remark' : 'defn') + '">' + this.joinBlocks(blocks) + '</div>', s: start, e: this.i });
    return;
  }
  var ue = S.envs[name];
  if (ue) {
    var args = [], n = ue.n;
    if (ue.dflt != null && n > 0) { opt = this.readOpt(); args.push(opt != null ? opt : ue.dflt); n--; }
    for (; n > 0; n--) args.push(this.rawArg());
    e = this.findEnd(name, this.i); body = s.slice(this.i, e.at); this.i = e.next;
    var beg = ue.begin.replace(/#(\d)/g, function (x, d) { return args[d - 1] == null ? '' : args[d - 1]; });
    this.emitBlocks(ctx, this.subBlocks(beg + body + ue.end));
    return;
  }
  if (name === 'thebibliography') {
    this.rawArg(); this.flush(ctx);
    blocks = this.envBody(name);
    ctx.blocks.push({ t: 'b', html: '<h2 class="sec l1">References</h2><div class="bibl">' + this.joinBlocks(blocks) + '</div>', s: start, e: this.i }); return;
  }
  if (DIVENV[name] != null) {
    if (ENVARGS[name]) this.skipSpec(ENVARGS[name]);
    this.flush(ctx);
    var fl = /^(figure|table|wrapfigure)/.test(base);
    if (fl) S.floats.push(base === 'table' ? 'table' : 'figure');
    blocks = this.envBody(name);
    if (fl) S.floats.pop();
    h = name === 'abstract' ? '<div class="abs-h">Abstract</div>' : '';
    ctx.blocks.push({ t: 'b', html: '<div class="env ' + DIVENV[name] + '">' + h + this.joinBlocks(blocks) + '</div>', s: start, e: this.i }); return;
  }
  this.warn('Unknown environment “' + name + '”; its contents are shown as plain text', start);
  this.readOpt(); this.flush(ctx);
  blocks = this.envBody(name);
  ctx.blocks.push({ t: 'b', html: '<div class="env unkenv">' + this.joinBlocks(blocks) + '</div>', s: start, e: this.i });
};

/* ---------- final resolution ---------- */
function resolver(S, p) {
  var tocHtml = null;
  function toc() {
    if (tocHtml != null) return tocHtml;
    var h = '<div class="toc"><div class="toc-h">Contents</div>';
    for (var k = 0; k < S.toc.length; k++) { var t = S.toc[k]; h += '<a class="toc-e l' + t.level + '" data-goto-h="' + t.id + '">' + (t.num ? '<span class="secno">' + esc(t.num) + '</span>' : '') + t.html + '</a>'; }
    return (tocHtml = h + '</div>');
  }
  function one(kind, pos, key) {
    var L = S.labels[key];
    if (kind === 'cite') { var n = S.bib[key]; return n ? String(n) : esc(key); }
    if (L && kind !== 'pageref') {
      var num = esc(L.num || '??'), txt = num;
      if (kind === 'eqref') txt = '(' + num + ')';
      else if (kind === 'cref') txt = (L.type || '').toLowerCase() + '&nbsp;' + num;
      else if (kind === 'Cref' || kind === 'autoref') txt = (L.type || '') + '&nbsp;' + num;
      return '<a class="ref" data-goto="' + escAttr(key) + '">' + txt + '</a>';
    }
    if (S.eqLabels[key] && kind !== 'pageref') return '\\(' + (kind === 'ref' ? '\\ref' : '\\eqref') + '{' + esc(key) + '}\\)';
    if (kind === 'pageref') return '<span class="undef" title="Page numbers do not exist in the preview">p.?</span>';
    if (!S.quiet) S.warnings.push({ msg: 'Reference to undefined label “' + key + '”', pos: pos });
    return '<span class="undef">??</span>';
  }
  return function (html) {
    if (html.indexOf('\u0001') < 0) return html;
    return html.replace(/\u0001R\|(\w+)\|(\d+)\|([^\u0002]*)\u0002/g, function (x, kind, pos, keys) {
      var out = keys.split(',').map(function (k) { return one(kind, +pos, k.trim()); }).join(kind === 'cite' ? ', ' : ', ');
      return kind === 'cite' ? '<span class="cite">[' + out + ']</span>' : out;
    }).split(TOC).join(toc()).split(HF).join(' ');
  };
}

function compile(src) {
  var S = new State(), p = new P(src, S, { mapped: true }), blocks;
  var m = /^(?:[^%\\\n]|\\.)*?\\begin\s*\{document\}/m.exec(src);
  if (m) {
    var b0 = m.index + m[0].lastIndexOf('\\begin');
    S.preamble = true; p.n = b0; p.parse({}); S.preamble = false; S.atletter = false;
    p.n = src.length; p.i = m.index + m[0].length; p.envStack.push('document');
    blocks = p.parse({ env: 'document' }, true);
    if (p.i >= p.n) S.warnings.push({ msg: 'Missing \\end{document}', pos: src.length });
  } else {
    blocks = p.parse({}, true);
  }
  if (S.footnotes.length) {
    var f = '<div class="fns">';
    for (var k = 0; k < S.footnotes.length; k++) f += '<div class="fnr"><sup>' + (k + 1) + '</sup><div>' + S.footnotes[k] + '</div></div>';
    blocks.push({ t: 'b', html: f + '</div>', s: src.length, e: src.length });
  }
  var res = resolver(S, p), out = [];
  for (var q = 0; q < blocks.length; q++) { var b = blocks[q]; out.push({ html: res(b.t === 'p' ? '<p>' + b.html + '</p>' : b.html), s: b.s, e: b.e }); }
  for (var u in S.unk) if (S.unk[u].n > 1) S.unk[u].w.msg += ' (' + S.unk[u].n + ' uses)';
  S.warnings.sort(function (a, b) { return a.pos - b.pos; });
  return { blocks: out, warnings: S.warnings, defs: S.mathDefs, state: S, hasDocument: !!m };
}

/* Render a snippet of LaTeX using the macros, theorems and labels of a compiled document. */
function fragment(tex, S0) {
  var S = new State(), k;
  if (S0) {
    S.macros = S0.macros; S.envs = S0.envs; S.theorems = S0.theorems; S.mdf = S0.mdf; S.thmStyles = S0.thmStyles; S.colors = S0.colors; S.svg = S0.svg; S.koma = S0.koma; S.endAlias = S0.endAlias; S.aliasEnd = S0.aliasEnd; S.bib = S0.bib;
    for (k in S0.labels) S.labels[k] = S0.labels[k];
    for (k in S0.eqLabels) S.eqLabels[k] = 1;
    for (k in S0.counters) S.counters[k] = S0.counters[k];
    for (k in S0.within) S.within[k] = S0.within[k];
  }
  S.quiet = true; S.frag = true;
  var p = new P(tex, S, {}), blocks = p.parse({}), res = resolver(S, p), h = '';
  for (k = 0; k < blocks.length; k++) h += res(blocks[k].t === 'p' ? '<p>' + blocks[k].html + '</p>' : blocks[k].html);
  for (k = 0; k < S.footnotes.length; k++) h += '<div class="fnr"><sup>' + (k + 1) + '</sup><div>' + res(S.footnotes[k]) + '</div></div>';
  return h;
}

module.exports = { compile: compile, fragment: fragment };
