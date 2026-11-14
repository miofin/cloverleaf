'use strict';
/*
 * Edit lists: parse what the AI sent, and find each edit's original text in the source.
 *
 *   parseEdits(text) -> [{ type: 'typo' | 'sentence' | 'passage', find, replace, reason, line }]
 *   locate(src, find, hint) -> { pos, len, count } | null
 *
 * Two input formats are accepted: ORIGINAL / REVISED conflict-style blocks (preferred,
 * because LaTeX backslashes need no escaping) and a JSON array.
 */
var reEsc = require('./util').reEsc;
var diff = require('./diff').diff;

function normType(t, find, replace) {
  t = String(t == null ? '' : t).toLowerCase();
  if (/typo|spell|gramm|punct|^1$/.test(t)) return 'typo';
  if (/sentence|word|^2$/.test(t)) return 'sentence';
  if (/passage|paragraph|rewrite|block|^3$/.test(t)) return 'passage';
  var a = String(find || ''), b = String(replace || '');
  var sents = (a.match(/[.!?](?=\s+[A-Z\\])/g) || []).length;
  if (/\n\s*\n/.test(a) || sents >= 1) return 'passage';
  var d = diff(a, b), changed = 0;
  for (var k = 0; k < d.length; k++) if (d[k][0] !== 'eq') changed += d[k][1].length;
  return changed <= 24 ? 'typo' : 'sentence';
}
function parseEditBlocks(text) {
  var lines = text.replace(/\r\n?/g, '\n').split('\n'), out = [], st = 'head', cur = null, a = [], b = [];
  function fresh() { return { type: '', reason: '', line: null }; }
  cur = fresh();
  for (var k = 0; k < lines.length; k++) {
    var L = lines[k], m;
    if (st === 'head') {
      if (/^\s*<{7}/.test(L)) { st = 'orig'; a = []; b = []; continue; }
      if ((m = /^\s*(?:[=#@*\-]+\s*)?EDIT\b[^A-Za-z\n]*([A-Za-z]+)?/.exec(L))) { cur = fresh(); cur.type = m[1] || ''; var lm = /line\s*:?\s*(\d+)/i.exec(L); if (lm) cur.line = +lm[1]; continue; }
      if ((m = /^\s*(?:REASON|WHY|NOTE|COMMENT)\s*:\s*(.*)$/i.exec(L))) { cur.reason = m[1].trim(); continue; }
      if ((m = /^\s*(?:TYPE|KIND)\s*:\s*(.*)$/i.exec(L))) { cur.type = m[1].trim(); continue; }
      if ((m = /^\s*LINE\s*:\s*(\d+)/i.exec(L))) { cur.line = +m[1]; continue; }
      continue;
    }
    if (st === 'orig') { if (/^={7}\s*$/.test(L)) { st = 'repl'; continue; } a.push(L); continue; }
    if (st === 'repl') {
      if (/^\s*>{7}/.test(L)) {
        var f = a.join('\n'), r = b.join('\n');
        if (f.trim() && f !== r) out.push({ type: normType(cur.type, f, r), find: f, replace: r, reason: cur.reason, line: cur.line });
        st = 'head'; cur = fresh(); continue;
      }
      b.push(L);
    }
  }
  return out;
}
function parseEditJSON(text) {
  var t = text.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '');
  var i1 = t.search(/[\[{]/), i2 = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (i1 < 0 || i2 <= i1) return null;
  var data;
  try { data = JSON.parse(t.slice(i1, i2 + 1)); } catch (e) { return null; }
  var arr = Array.isArray(data) ? data : (data && (data.edits || data.suggestions || data.changes));
  if (!Array.isArray(arr)) return null;
  var out = [];
  for (var k = 0; k < arr.length; k++) {
    var e = arr[k]; if (!e || typeof e !== 'object') continue;
    var f = e.find != null ? e.find : e.original != null ? e.original : e.old != null ? e.old : e.before;
    var r = e.replace != null ? e.replace : e.replacement != null ? e.replacement : e.revised != null ? e.revised : e['new'] != null ? e['new'] : e.after;
    if (typeof f !== 'string' || typeof r !== 'string' || !f.trim() || f === r) continue;
    out.push({ type: normType(e.type != null ? e.type : e.kind, f, r), find: f, replace: r, reason: String(e.reason || e.why || e.note || e.comment || ''), line: +e.line > 0 ? +e.line : null });
  }
  return out;
}
function parseEdits(text) {
  text = String(text || '');
  if (/^\s*<{7}/m.test(text)) return parseEditBlocks(text);
  return parseEditJSON(text) || [];
}

/* Find where an edit's original text sits in the source. hint = preferred offset (or -1). */
function locate(src, find, hint) {
  var hits = [], i = src.indexOf(find), k;
  while (i >= 0 && hits.length < 200) { hits.push([i, find.length]); i = src.indexOf(find, i + Math.max(1, find.length)); }
  if (!hits.length) {
    var toks = find.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return null;
    var re = new RegExp(toks.map(reEsc).join('\\s+'), 'g'), m;
    while ((m = re.exec(src)) && hits.length < 200) { hits.push([m.index, m[0].length]); if (!m[0].length) re.lastIndex++; }
  }
  if (!hits.length) return null;
  var best = hits[0];
  if (hint != null && hint >= 0) for (k = 1; k < hits.length; k++) if (Math.abs(hits[k][0] - hint) < Math.abs(best[0] - hint)) best = hits[k];
  return { pos: best[0], len: best[1], count: hits.length };
}

module.exports = { parseEdits: parseEdits, locate: locate };
