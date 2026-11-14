'use strict';
/* Word-level diff used to mark up an edit: returns [['eq' | 'del' | 'ins', text], ...]. */

function tokens(s) { return s.match(/\s+|[A-Za-z0-9\u00C0-\u024F]+|\\[A-Za-z]+|[^\sA-Za-z0-9\u00C0-\u024F]/g) || []; }
function diff(a, b) {
  var A = tokens(a), B = tokens(b), p = 0, ea = A.length, eb = B.length, raw = [], i, j;
  while (p < ea && p < eb && A[p] === B[p]) p++;
  while (ea > p && eb > p && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  var X = A.slice(p, ea), Y = B.slice(p, eb), n = X.length, m = Y.length;
  if (p) raw.push(['eq', A.slice(0, p).join('')]);
  if (n * m > 4e6 || n > 60000 || m > 60000) { if (n) raw.push(['del', X.join('')]); if (m) raw.push(['ins', Y.join('')]); }
  else if (n || m) {
    var W = m + 1, T = new Uint16Array((n + 1) * W);
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) T[i * W + j] = X[i] === Y[j] ? T[(i + 1) * W + j + 1] + 1 : Math.max(T[(i + 1) * W + j], T[i * W + j + 1]);
    i = 0; j = 0;
    while (i < n && j < m) {
      if (X[i] === Y[j]) { raw.push(['eq', X[i]]); i++; j++; }
      else if (T[(i + 1) * W + j] >= T[i * W + j + 1]) raw.push(['del', X[i++]]);
      else raw.push(['ins', Y[j++]]);
    }
    while (i < n) raw.push(['del', X[i++]]);
    while (j < m) raw.push(['ins', Y[j++]]);
  }
  if (ea < A.length) raw.push(['eq', A.slice(ea).join('')]);
  /* group: fold short whitespace between two changes into the change, emit del before ins */
  var out = [], del = '', ins = '';
  function flush() { if (del) out.push(['del', del]); if (ins) out.push(['ins', ins]); del = ''; ins = ''; }
  function add(op, t) { if (!t) return; var l = out[out.length - 1]; if (l && l[0] === op) l[1] += t; else out.push([op, t]); }
  for (var k = 0; k < raw.length; k++) {
    var op = raw[k][0], t = raw[k][1];
    if (op === 'del') del += t;
    else if (op === 'ins') ins += t;
    else {
      var nxt = raw[k + 1];
      if ((del || ins) && nxt && nxt[0] !== 'eq' && /^[ \t]{1,2}$/.test(t)) { del += t; ins += t; }
      else { flush(); add('eq', t); }
    }
  }
  flush();
  return out;
}

module.exports = { diff: diff, tokens: tokens };
