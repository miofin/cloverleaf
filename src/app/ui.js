/* The page: source pane, preview, review queue, loading edits, persistence. Runs in the browser. */
(function () {
'use strict';
var G = window.Galley, esc = G.esc;
function $(id) { return document.getElementById(id); }
var ed = $('ed'), paper = $('paper'), main = $('main'), card = $('card'), mirror = $('mirror');
var KEY = 'galley.v1';
var NUMRE = /\\begin\{(?:equation|align|gather|multline|flalign|alignat|eqnarray)\}|\\tag\b|\\label\b/;
var KIND = { typo: 'Typo', sentence: 'Sentence', passage: 'Passage' };
var st = { name: 'example.tex', edits: [], cur: -1, nextId: 1, view: { typo: 'marks', sentence: 'marks', passage: 'split' }, filter: 'all', hideDone: false, example: true, editing: false };
var narrow = window.matchMedia('(max-width: 1079px)');
var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- small utilities ---------- */
var toastT;
function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 3600); }
function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
function copyText(t) {
  function fallback() {
    var ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} ta.remove(); return ok;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).then(function () { return true; }, fallback);
  return Promise.resolve(fallback());
}
function confirmBox(msg, okLabel) {
  return new Promise(function (resolve) {
    var d = $('dlgConfirm'); $('cfMsg').textContent = msg; $('cfOk').textContent = okLabel || 'Continue';
    function done(v) { $('cfOk').onclick = $('cfNo').onclick = d.oncancel = null; d.close(); resolve(v); }
    $('cfOk').onclick = function () { done(true); }; $('cfNo').onclick = function () { done(false); };
    d.oncancel = function (ev) { ev.preventDefault(); done(false); };
    d.showModal();
  });
}

/* ---------- source text ---------- */
var prevVal = '', lineStarts = null;
function lines() {
  if (!lineStarts) { lineStarts = [0]; var v = ed.value, i = -1; while ((i = v.indexOf('\n', i + 1)) >= 0) lineStarts.push(i + 1); }
  return lineStarts;
}
function lineOf(pos) { var L = lines(), lo = 0, hi = L.length - 1; while (lo < hi) { var m = (lo + hi + 1) >> 1; if (L[m] <= pos) lo = m; else hi = m - 1; } return lo + 1; }
function posOfLine(n) { var L = lines(); return L[Math.max(0, Math.min(L.length - 1, n - 1))]; }
function setSrc(v, delay) {
  var top = ed.scrollTop, a = ed.selectionStart, b = ed.selectionEnd;
  ed.value = v; prevVal = v; lineStarts = null;
  try { ed.setSelectionRange(Math.min(a, v.length), Math.min(b, v.length)); } catch (e) {}
  ed.scrollTop = top; showCaret();
  scheduleCompile(delay == null ? 80 : delay); scheduleSave();
}
function shift(a, del, ins, except) {
  var d = ins - del, end = a + del;
  st.edits.forEach(function (e) {
    if (e === except) return;
    if (e.status === 'accepted') {
      var ap = e.applied; if (!ap || ap.stale) return;
      if (ap.pos >= end) ap.pos += d; else if (ap.pos + ap.len > a) ap.stale = true;
    } else if (e.pos >= 0) {
      if (e.pos >= end) e.pos += d; else if (e.pos + e.len > a) { e.hint = e.pos; e.pos = -1; }
    }
  });
}
function relocate() {
  var src = ed.value, changed = false;
  st.edits.forEach(function (e) {
    if (e.status === 'accepted' || e.pos >= 0) return;
    var r = G.locate(src, e.find, e.hint != null ? e.hint : (e.line ? posOfLine(e.line) : -1));
    if (r) { e.pos = r.pos; e.len = r.len; e.count = r.count; changed = true; }
  });
  return changed;
}
function onTyped() {
  var a = prevVal, b = ed.value;
  if (a === b) return;
  var p = 0, mn = Math.min(a.length, b.length), sa = a.length, sb = b.length;
  while (p < mn && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  while (sa > p && sb > p && a.charCodeAt(sa - 1) === b.charCodeAt(sb - 1)) { sa--; sb--; }
  shift(p, sa - p, sb - p, null);
  prevVal = b; lineStarts = null; showCaret();
  if ($('auto').checked) scheduleCompile(550); else setStatus('Source changed since the last compile', 'stale');
  scheduleSave(); scheduleReviewRefresh();
}
function scrollEdTo(pos) {
  mirror.style.width = ed.clientWidth + 'px';
  mirror.textContent = ed.value.slice(0, pos) + '\u200b';
  ed.scrollTop = Math.max(0, mirror.scrollHeight - ed.clientHeight / 2);
  mirror.textContent = '';
}
function jumpTo(a, b, focus) {
  showPane('src');
  if (focus !== false) ed.focus();
  ed.setSelectionRange(a, b == null ? a : b);
  scrollEdTo(a); showCaret();
}
function showCaret() { var p = ed.selectionStart, ln = lineOf(p); $('pos').textContent = 'Line ' + ln + ', column ' + (p - posOfLine(ln) + 1); }

/* ---------- compile + preview ---------- */
var compiled = null, blocks = [], defsKey = null, compileT = null, mjChain = Promise.resolve(), gen = 0, mathErrors = [], mathOK = null;
function setStatus(text, cls) { var s = $('cstat'); s.textContent = text; s.title = text; s.className = 'cstat' + (cls ? ' ' + cls : ''); }
function scheduleCompile(ms) { clearTimeout(compileT); compileT = setTimeout(compile, ms); }
function mj(fn) {
  var p = mjChain.then(function () { return window.__mj; }).then(function (ok) { mathOK = !!ok; if (ok) return fn(window.MathJax); });
  mjChain = p.catch(function (e) { if (window.console) console.error(e); });
  return mjChain;
}
function mk(html) { var d = document.createElement('div'); d.className = 'blk'; d.innerHTML = html; d._num = NUMRE.test(html); return d; }
function compile() {
  clearTimeout(compileT);
  var src = ed.value, t0 = performance.now(), res;
  try { res = G.compile(src); }
  catch (e) { setStatus('The preview compiler hit an internal error: ' + e.message, 'bad'); if (window.console) console.error(e); return; }
  compiled = res;
  var my = ++gen, key = res.defs.join('\n'), pool = new Map(), full = key !== defsKey || !blocks.length, next = [], fresh = [], gone = [];
  blocks.forEach(function (b) { var a = pool.get(b.html); if (!a) pool.set(b.html, a = []); a.push(b.node); });
  res.blocks.forEach(function (b) {
    var a = pool.get(b.html), node = a && a.length ? a.shift() : null;
    if (!node) { node = mk(b.html); fresh.push(node); if (node._num) full = true; }
    next.push({ html: b.html, node: node, s: b.s, e: b.e });
  });
  pool.forEach(function (a) { a.forEach(function (n) { gone.push(n); if (n._num) full = true; }); });
  if (full) { next.forEach(function (b) { b.node = mk(b.html); }); }
  blocks = next;
  var sc = $('scroll'), keep = sc.scrollTop;
  paper.replaceChildren.apply(paper, next.map(function (b) { return b.node; }));
  sc.scrollTop = keep;
  if (!res.blocks.length) paper.innerHTML = '<p class="empty">Nothing to show yet. Type some LaTeX on the left, or open a .tex file.</p>';
  var ms = Math.max(1, Math.round(performance.now() - t0));
  setStatus('Typesetting math…', 'busy');
  mj(function (MJ) {
    var chain = Promise.resolve();
    if (key !== defsKey) {
      res.defs.forEach(function (d) { chain = chain.then(function () { return MJ.tex2svgPromise(d).catch(function () {}); }); });
      chain = chain.then(function () { defsKey = key; });
    }
    return chain.then(function () {
      if (full) { MJ.typesetClear(); MJ.texReset(); return MJ.typesetPromise([paper]); }
      if (gone.length) MJ.typesetClear(gone);
      var live = fresh.filter(function (n) { return n.isConnected; });
      return live.length ? MJ.typesetPromise(live) : null;
    });
  }).then(function () {
    if (my !== gen) return;
    mathErrors = [];
    if (mathOK) paper.querySelectorAll('[data-mjx-error]').forEach(function (el) {
      var blk = el.closest('.blk'), pos = 0;
      for (var k = 0; k < blocks.length; k++) if (blocks[k].node === blk) { pos = blocks[k].s; break; }
      mathErrors.push({ msg: 'Math: ' + el.getAttribute('data-mjx-error'), pos: pos });
    });
    renderLog(ms);
  });
  renderLog(ms, true);
  markPreview(false);
}
function renderLog(ms, pending) {
  if (!compiled) return;
  var items = compiled.warnings.concat(mathErrors).sort(function (a, b) { return a.pos - b.pos; });
  var n = items.length, h = '';
  items.slice(0, 300).forEach(function (w) { h += '<li><button type="button" data-pos="' + w.pos + '"><span class="ln">Line ' + lineOf(Math.min(w.pos, ed.value.length)) + '</span>' + esc(w.msg) + '</button></li>'; });
  if (!n) h = '<li class="none">No problems found.</li>';
  $('logL').innerHTML = h;
  $('logN').textContent = n ? plural(n, 'issue') : 'clean';
  $('logN').className = 'logn' + (n ? ' has' : '');
  if (pending && mathOK !== false) return;
  var tail = mathOK === false ? ' Math is shown as raw TeX because MathJax couldn’t load.' : '';
  setStatus('Compiled in ' + ms + ' ms, ' + (n ? plural(n, 'issue') : 'no issues') + '.' + tail, n ? 'warn' : 'ok');
}
function blockAt(pos) { var lo = 0, hi = blocks.length - 1, ans = -1; while (lo <= hi) { var m = (lo + hi) >> 1; if (blocks[m].s <= pos) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; }
function elementAt(pos) {
  var k = blockAt(pos); if (k < 0) return null;
  while (k > 0 && blocks[k].e <= pos && blocks[k].s === blocks[k].e) k--;
  var b = blocks[k], rel = pos - b.s, best = b.node, size = Infinity;
  b.node.querySelectorAll('[data-o]').forEach(function (el) {
    var o = el.getAttribute('data-o').split(','), a = +o[0], z = +o[1];
    if (a <= rel && rel < z && z - a < size) { best = el; size = z - a; }
  });
  return best;
}
function editRange(e) {
  if (!e) return null;
  if (e.status === 'accepted') return e.applied && !e.applied.stale ? [e.applied.pos, e.applied.pos + e.applied.len] : null;
  return e.pos >= 0 ? [e.pos, e.pos + e.len] : null;
}
function markPreview(scroll) {
  paper.querySelectorAll('.hl').forEach(function (el) { el.classList.remove('hl'); });
  var r = editRange(curEdit()); if (!r) return;
  var el = elementAt(r[0]); if (!el) return;
  el.classList.add('hl');
  if (!scroll) return;
  el.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  if (document.activeElement !== ed && ed.offsetParent) scrollEdTo(r[0]);
}
paper.addEventListener('click', function (ev) {
  var a = ev.target.closest('[data-goto],[data-goto-h]'); if (!a) return;
  var t = a.hasAttribute('data-goto') ? paper.querySelector('[data-label="' + window.CSS.escape(a.getAttribute('data-goto')) + '"]') : paper.querySelector('[data-hid="' + a.getAttribute('data-goto-h') + '"]');
  if (t) (t.closest('p,.li,.thm,.blk') || t).scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
});
paper.addEventListener('dblclick', function (ev) {
  var blk = ev.target.closest('.blk'); if (!blk) return;
  for (var k = 0; k < blocks.length; k++) if (blocks[k].node === blk) {
    var el = ev.target.closest('[data-o]'), a = blocks[k].s, z = blocks[k].e;
    if (el && blk.contains(el)) { var o = el.getAttribute('data-o').split(','); z = a + (+o[1]); a = a + (+o[0]); }
    var sel = window.getSelection(); if (sel) sel.removeAllRanges();
    jumpTo(a, Math.max(a, z)); return;
  }
});

/* ---------- edits ---------- */
function curEdit() { return st.cur >= 0 ? st.edits[st.cur] : null; }
function shown(e) { return (st.filter === 'all' || e.type === st.filter) && !(st.hideDone && e.status !== 'pending'); }
function sortKey(e) { return e.status === 'accepted' && e.applied ? e.applied.pos : e.pos >= 0 ? e.pos : 1e15 + e.id; }
function addEdits(list) {
  var src = ed.value, seen = {}, added = 0, lost = 0, cur = curEdit();
  st.edits.forEach(function (e) { seen[e.find + '\u0000' + e.replace] = 1; });
  list.forEach(function (x) {
    var k = x.find + '\u0000' + x.replace; if (seen[k]) return; seen[k] = 1;
    var e = { id: st.nextId++, type: x.type, find: x.find, replace: x.replace, reason: x.reason || '', line: x.line || null, status: 'pending', pos: -1, len: 0, count: 0, custom: null, applied: null, hint: null };
    var r = G.locate(src, e.find, e.line ? posOfLine(e.line) : -1);
    if (r) { e.pos = r.pos; e.len = r.len; e.count = r.count; } else lost++;
    st.edits.push(e); added++;
  });
  st.edits.sort(function (a, b) { return sortKey(a) - sortKey(b); });
  st.cur = cur ? st.edits.indexOf(cur) : -1;
  if (st.cur < 0 || curEdit().status !== 'pending') firstPending();
  return { added: added, lost: lost };
}
function firstPending() { st.cur = -1; for (var k = 0; k < st.edits.length; k++) if (st.edits[k].status === 'pending' && shown(st.edits[k])) { st.cur = k; return; } }
function advance() {
  var n = st.edits.length, i0 = Math.max(0, st.cur);
  for (var k = 1; k <= n; k++) { var j = (i0 + k) % n, e = st.edits[j]; if (e.status === 'pending' && shown(e)) { st.cur = j; return; } }
  st.cur = -1;
}
function step(dir) {
  var n = st.edits.length; if (!n) return;
  var i = st.cur < 0 ? (dir > 0 ? -1 : n) : st.cur;
  for (var k = 0; k < n; k++) { i += dir; if (i < 0 || i >= n) return; if (shown(st.edits[i])) { select(i); return; } }
}
function select(i) { st.cur = i; st.editing = false; renderReview(); markPreview(true); scheduleSave(); }
function accept(e) {
  if (e.status !== 'pending' || e.pos < 0) return false;
  var src = ed.value, pos = e.pos, orig = src.slice(pos, pos + e.len), rep = e.custom != null ? e.custom : e.replace;
  setSrc(src.slice(0, pos) + rep + src.slice(pos + orig.length));
  shift(pos, orig.length, rep.length, e);
  e.applied = { pos: pos, len: rep.length, orig: orig, rep: rep, stale: false }; e.status = 'accepted';
  relocate(); return true;
}
function undo(e) {
  if (e.status === 'rejected') { e.status = 'pending'; relocate(); return true; }
  if (e.status !== 'accepted') return false;
  var ap = e.applied, src = ed.value;
  if (!ap || ap.stale || src.slice(ap.pos, ap.pos + ap.len) !== ap.rep) { toast('That text was changed after you approved it, so it can’t be undone automatically.'); return false; }
  setSrc(src.slice(0, ap.pos) + ap.orig + src.slice(ap.pos + ap.len));
  shift(ap.pos, ap.len, ap.orig.length, e);
  e.pos = ap.pos; e.len = ap.orig.length; e.applied = null; e.status = 'pending';
  relocate(); return true;
}
function decide(ok) {
  var e = curEdit(); if (!e || e.status !== 'pending') return;
  if (ok) { if (!accept(e)) { toast('This edit’s original text isn’t in the source, so there is nothing to change.'); return; } }
  else e.status = 'rejected';
  st.editing = false; advance(); renderReview(); markPreview(true); scheduleSave();
}
function undoCur() { var e = curEdit(); if (e && e.status !== 'pending' && undo(e)) { st.editing = false; renderReview(); markPreview(true); scheduleSave(); } }

/* ---------- review rendering ---------- */
function vis(t) { return /^\s+$/.test(t) ? esc(t.replace(/\n/g, '↵\n').replace(/ /g, '·')) : esc(t); }
function opsHtml(ops, mode) {
  var h = '';
  ops.forEach(function (o) {
    if (o[0] === 'eq') h += esc(o[1]);
    else if (o[0] === 'del') { if (mode !== 'after') h += '<del>' + vis(o[1]) + '</del>'; }
    else if (mode !== 'before') h += '<ins>' + vis(o[1]) + '</ins>';
  });
  return h;
}
function around(src, a, z) {
  var s0 = Math.max(0, a - 150), e0 = Math.min(src.length, z + 150);
  var pre = src.slice(s0, a), post = src.slice(z, e0), k;
  if ((k = pre.lastIndexOf('\n\n')) >= 0) pre = pre.slice(k + 2); else if (s0 > 0) { k = pre.indexOf(' '); pre = '…' + (k >= 0 ? pre.slice(k + 1) : pre); }
  if ((k = post.indexOf('\n\n')) >= 0) post = post.slice(0, k); else if (e0 < src.length) { k = post.lastIndexOf(' '); post = (k > 0 ? post.slice(0, k) : post) + '…'; }
  return [pre, post];
}
function texts(e) {
  var src = ed.value;
  if (e.status === 'accepted' && e.applied) return { orig: e.applied.orig, rep: e.applied.rep, range: e.applied.stale ? null : [e.applied.pos, e.applied.pos + e.applied.len] };
  return { orig: e.pos >= 0 ? src.slice(e.pos, e.pos + e.len) : e.find, rep: e.custom != null ? e.custom : e.replace, range: e.pos >= 0 ? [e.pos, e.pos + e.len] : null };
}
function snippet(e) {
  var t = texts(e), ops = G.diff(t.orig, t.rep), d = '', i = '';
  for (var k = 0; k < ops.length && (d + i).length < 60; k++) { if (ops[k][0] === 'del') d += ops[k][1]; else if (ops[k][0] === 'ins') i += ops[k][1]; else if ((d || i) && e.type !== 'typo') break; }
  d = d.replace(/\s+/g, ' ').trim(); i = i.replace(/\s+/g, ' ').trim();
  if (e.type === 'typo' && (d + i).length <= 56) return '<del>' + esc(d || ' ') + '</del><ins>' + esc(i || ' ') + '</ins>';
  return esc(t.orig.replace(/\s+/g, ' ').trim().slice(0, 72));
}
function counts() { var c = { pending: 0, accepted: 0, rejected: 0, typo: 0, sentence: 0, passage: 0 }; st.edits.forEach(function (e) { c[e.status]++; c[e.type]++; }); return c; }
var cardGen = 0;
function renderReview() {
  var c = counts(), n = st.edits.length, h = '', e = curEdit(), k;
  $('tRevN').textContent = c.pending ? c.pending : '';
  $('tally').textContent = n ? c.accepted + ' approved, ' + c.rejected + ' denied, ' + c.pending + ' to go' : '';
  /* ribbon */
  for (k = 0; k < n; k++) { var x = st.edits[k]; if (!shown(x)) continue; h += '<button type="button" class="tk ' + x.type + ' ' + x.status + (x.status === 'pending' && x.pos < 0 ? ' lost' : '') + (k === st.cur ? ' cur' : '') + '" data-i="' + k + '" aria-label="Edit ' + (k + 1) + ', ' + x.type + ', ' + x.status + '"></button>'; }
  $('ribbon').innerHTML = h; $('ribbon').hidden = !n;
  /* list */
  h = '';
  for (k = 0; k < n; k++) {
    var y = st.edits[k]; if (!shown(y)) continue;
    var r = editRange(y);
    h += '<li><button type="button" class="row ' + y.status + (k === st.cur ? ' cur' : '') + '" data-i="' + k + '"' + (k === st.cur ? ' aria-current="true"' : '') + '><span class="mark" aria-hidden="true"></span><span class="rk">' + KIND[y.type] + '</span><span class="rs">' + snippet(y) + '</span><span class="rl">' + (r ? 'line ' + lineOf(r[0]) : 'not found') + '</span></button></li>';
  }
  $('elist').innerHTML = h;
  $('listwrap').hidden = !n;
  ['all', 'typo', 'sentence', 'passage'].forEach(function (f) {
    var b = $('f-' + f); b.setAttribute('aria-pressed', st.filter === f ? 'true' : 'false');
    b.textContent = (f === 'all' ? 'All' : KIND[f] + (f === 'typo' ? 's' : 's')) + ' ' + (f === 'all' ? n : c[f]);
  });
  $('hideDone').checked = st.hideDone;
  renderCard(c);
  var cu = $('elist').querySelector('.cur'), lw = $('listwrap');
  if (cu) { var top = cu.offsetTop - lw.offsetTop, bot = top + cu.offsetHeight; if (top < lw.scrollTop + 40) lw.scrollTop = Math.max(0, top - 40); else if (bot > lw.scrollTop + lw.clientHeight) lw.scrollTop = bot - lw.clientHeight + 8; }
}
function renderCard(c) {
  var e = curEdit(), n = st.edits.length, h = '', my = ++cardGen, hadFocus = card.contains(document.activeElement);
  mj(function (MJ) { MJ.typesetClear([card]); });
  if (!n) {
    card.innerHTML = '<div class="cbody"><div class="blank"><h3>No edits loaded</h3><p>Ask an AI to proofread your file, then load its edit list here. You approve or deny each change; nothing touches the source until you approve it.</p>' +
      '<div class="acts"><button type="button" class="btn pri" data-act="load">Load edits</button><button type="button" class="btn" data-act="prompt">Copy instructions for the AI</button></div></div></div>';
    return;
  }
  if (!e) {
    h = '<div class="cbody"><div class="blank">';
    if (c.pending === 0) h += '<h3>Every edit is reviewed</h3><p>' + c.accepted + ' approved and written into the source, ' + c.rejected + ' denied. Copy or download the result, or pick any edit below to change your mind.</p>';
    else h += '<h3>' + plural(c.pending, 'edit') + ' to go</h3><p>None of them match the current filter. Pick an edit from the list, or show all kinds.</p>';
    h += '<div class="acts"><button type="button" class="btn pri" data-act="copy">Copy LaTeX</button>' + (downloads ? '<button type="button" class="btn" data-act="save">Download as .txt</button>' : '') + '<button type="button" class="btn" data-act="load">Load more edits</button></div></div></div>';
    card.innerHTML = h; return;
  }
  var t = texts(e), ops = G.diff(t.orig, t.rep), view = st.view[e.type], src = ed.value;
  var ctx = t.range ? around(src, t.range[0], t.range[1]) : ['', ''];
  h += '<div class="cbody"><div class="ctop"><span class="kind ' + e.type + '">' + KIND[e.type] + '</span><span class="where">' + (t.range ? 'line ' + lineOf(t.range[0]) : 'not in source') + '</span>' +
    '<span class="nav"><button type="button" class="ib" data-act="prev" aria-label="Previous edit" title="Previous edit (←)">‹</button><span class="idx">' + (st.cur + 1) + ' of ' + n + '</span><button type="button" class="ib" data-act="next" aria-label="Next edit" title="Next edit (→)">›</button></span></div>';
  if (e.reason) h += '<p class="reason">' + esc(e.reason) + '</p>';
  if (e.status === 'pending' && e.pos < 0) h += '<p class="note bad">The original text of this edit can’t be found in the source. An edit you already approved may have changed it, or the AI misquoted it. Deny it, or fix the passage by hand.</p>';
  else if (e.status === 'pending' && e.count > 1) h += '<p class="note">This text appears ' + e.count + ' times in the file. Approving changes the one on line ' + lineOf(e.pos) + '.</p>';
  if (e.custom != null && e.status === 'pending') h += '<p class="note">You reworded this replacement.</p>';
  h += '<div class="tools"><div class="views" role="group" aria-label="How to show the change">' + [['marks', 'Marked up'], ['split', 'Before and after'], ['typeset', 'Typeset']].map(function (v) { return '<button type="button" data-view="' + v[0] + '" aria-pressed="' + (view === v[0]) + '">' + v[1] + '</button>'; }).join('') + '</div>' +
    (e.status === 'pending' && !st.editing && e.pos >= 0 ? '<button type="button" class="qb" data-act="rew" title="Change the replacement text before approving">Reword</button>' : '') +
    (t.range ? '<button type="button" class="qb" data-act="find">Show in source</button>' : '') + '</div>';
  if (st.editing) {
    h += '<label class="lbl" for="rew">Replacement text</label><textarea id="rew" class="rew" spellcheck="false">' + esc(t.rep) + '</textarea>' +
      '<div class="acts"><button type="button" class="btn pri" data-act="rew-ok">Use this wording</button>' + (e.custom != null ? '<button type="button" class="btn" data-act="rew-reset">Back to the AI’s wording</button>' : '') + '<button type="button" class="btn" data-act="rew-cancel">Cancel</button></div>';
  } else if (view === 'marks') {
    h += '<div class="diff"><span class="cx">' + esc(ctx[0]) + '</span>' + opsHtml(ops, 'marks') + '<span class="cx">' + esc(ctx[1]) + '</span></div>';
  } else if (view === 'split') {
    h += '<div class="lbl">Before</div><div class="diff">' + opsHtml(ops, 'before') + '</div><div class="lbl">After</div><div class="diff">' + opsHtml(ops, 'after') + '</div>';
  } else {
    var S = compiled && compiled.state, a = '', b = '';
    try { a = G.fragment(t.orig, S); b = G.fragment(t.rep, S); } catch (err) { a = b = '<p class="empty">This snippet can’t be typeset on its own.</p>'; }
    h += '<div class="lbl">Before</div><div class="paper mini">' + a + '</div><div class="lbl">After</div><div class="paper mini">' + b + '</div>';
  }
  h += '</div><div class="cfoot">';
  if (e.status === 'pending') {
    h += '<div class="go"><button type="button" class="gb no" data-act="deny">Deny <kbd>D</kbd></button><button type="button" class="gb ok" data-act="approve"' + (e.pos < 0 ? ' disabled' : '') + '>Approve <kbd>A</kbd></button></div>';
  } else {
    h += '<div class="done ' + e.status + '"><span>' + (e.status === 'accepted' ? 'Approved. The source now has the new text.' : 'Denied. The source is unchanged.') + '</span><button type="button" class="btn" data-act="undo">Undo <kbd>U</kbd></button></div>';
  }
  h += '</div>';
  card.innerHTML = h;
  if (view === 'typeset' && !st.editing) mj(function (MJ) { if (my === cardGen) return MJ.typesetPromise([card]); });
  if (st.editing) { var ta = $('rew'); if (ta) ta.focus(); }
  else if (hadFocus) { var f = card.querySelector('[data-act="approve"]:not([disabled]),[data-act="undo"],[data-act="deny"]'); if (f) f.focus(); }
}
var refreshT;
function scheduleReviewRefresh() { clearTimeout(refreshT); refreshT = setTimeout(function () { if (!st.edits.length || st.editing) return; relocate(); renderReview(); }, 700); }

card.addEventListener('click', function (ev) {
  var b = ev.target.closest('button'); if (!b || b.disabled) return;
  var e = curEdit(), v = b.getAttribute('data-view'), act = b.getAttribute('data-act');
  if (v && e) { st.view[e.type] = v; st.editing = false; renderReview(); return; }
  switch (act) {
    case 'approve': decide(true); break;
    case 'deny': decide(false); break;
    case 'undo': undoCur(); break;
    case 'prev': step(-1); break;
    case 'next': step(1); break;
    case 'find': var r = editRange(e); if (r) jumpTo(r[0], r[1]); break;
    case 'rew': st.editing = true; renderReview(); break;
    case 'rew-cancel': st.editing = false; renderReview(); break;
    case 'rew-reset': e.custom = null; st.editing = false; renderReview(); scheduleSave(); break;
    case 'rew-ok': var val = $('rew').value; e.custom = val === e.replace ? null : val; st.editing = false; renderReview(); scheduleSave(); break;
    case 'load': openLoad(); break;
    case 'prompt': copyPrompt(); break;
    case 'copy': copyLatex(); break;
    case 'save': saveFile(); break;
  }
});
function pick(ev) { var b = ev.target.closest('[data-i]'); if (b) select(+b.getAttribute('data-i')); }
$('ribbon').addEventListener('click', pick);
$('elist').addEventListener('click', pick);
['all', 'typo', 'sentence', 'passage'].forEach(function (f) {
  $('f-' + f).addEventListener('click', function () { st.filter = f; var e = curEdit(); if (!e || !shown(e)) firstPending(); renderReview(); markPreview(true); });
});
$('hideDone').addEventListener('change', function () { st.hideDone = this.checked; renderReview(); });
$('bClear').addEventListener('click', function () {
  confirmBox('Remove every edit from the list? Changes you already approved stay in the source.', 'Remove edits').then(function (ok) {
    if (!ok) return; st.edits = []; st.cur = -1; st.example = false; renderReview(); markPreview(false); scheduleSave();
  });
});
document.addEventListener('keydown', function (ev) {
  if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); compile(); }
    return;
  }
  var t = ev.target, tag = t && t.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || (t && t.isContentEditable) || document.querySelector('dialog[open]')) return;
  if (!st.edits.length) return;
  if (narrow.matches ? main.dataset.tab !== 'rev' : main.dataset.rev === '0') return;
  var k = ev.key.toLowerCase();
  if (k === 'a') { ev.preventDefault(); decide(true); }
  else if (k === 'd') { ev.preventDefault(); decide(false); }
  else if (k === 'u') { ev.preventDefault(); undoCur(); }
  else if (k === 'arrowright' || k === 'j') { ev.preventDefault(); step(1); }
  else if (k === 'arrowleft' || k === 'k') { ev.preventDefault(); step(-1); }
});

/* ---------- loading edits ---------- */
var PROMPT = [
  'Proofread the LaTeX document below and propose edits. There are three kinds:',
  '- typo: fix a spelling, grammar, punctuation or LaTeX slip',
  '- sentence: reword one sentence so it reads more naturally',
  '- passage: rewrite a few sentences, up to a few paragraphs',
  'Do not change the mathematics, the meaning, labels or macro names. Do not make stylistic changes that are a matter of taste.',
  '',
  'Reply with edit blocks only, in exactly this plain-text format (no JSON, no code fences, no commentary):',
  '',
  '=== EDIT typo',
  'REASON: one short line saying why',
  '<<<<<<< ORIGINAL',
  'text copied character for character from the source',
  '=======',
  'the replacement text',
  '>>>>>>> REVISED',
  '',
  'Rules:',
  '- The word after EDIT is typo, sentence or passage.',
  '- ORIGINAL must match the source exactly, including LaTeX commands, spacing and line breaks. Never paraphrase it or skip parts with "...".',
  '- Keep ORIGINAL as short as it can be while still being unique in the file: for a typo, the misspelled word plus a few neighbouring words; for a sentence, the whole sentence.',
  '- Edits must not overlap. If two fixes touch the same sentence, make them one edit.',
  '- List the edits in the order they appear in the document.'
].join('\n');
function copyPrompt() { copyText(PROMPT).then(function (ok) { toast(ok ? 'Instructions copied. Send them to the AI together with your .tex file.' : 'Copying was blocked. Select the text in the Load edits window instead.'); }); }
function openLoad() { $('dlgTa').value = ''; $('dlgMsg').textContent = ''; $('promptBox').value = PROMPT; $('dlgLoad').showModal(); $('dlgTa').focus(); }
function takeEdits(text) {
  var list = G.parseEdits(text);
  if (!list.length) return null;
  if (st.example) { st.edits = []; st.cur = -1; st.example = false; }
  var had = st.edits.length, r = addEdits(list);
  if (!had && r.added) reviewLayout();
  renderReview(); markPreview(true); scheduleSave();
  return r;
}
$('bLoad').addEventListener('click', openLoad);
$('dlgCancel').addEventListener('click', function () { $('dlgLoad').close(); });
$('dlgAdd').addEventListener('click', function () {
  var txt = $('dlgTa').value;
  if (!txt.trim()) { $('dlgMsg').textContent = 'Paste the edit list first, or choose a file.'; return; }
  var r = takeEdits(txt);
  if (!r) { $('dlgMsg').textContent = 'No edits found in that text. Each edit needs an ORIGINAL part, a ======= line and a REVISED part; the instructions below show the format.'; return; }
  $('dlgLoad').close();
  showPane('rev');
  toast(r.added ? 'Added ' + plural(r.added, 'edit') + (r.lost ? '; ' + r.lost + ' can’t be found in the source.' : '.') : 'Those edits are already in the list.');
});
$('dlgFile').addEventListener('click', function () { $('fEdits').click(); });
$('fEdits').addEventListener('change', function () {
  var f = this.files && this.files[0]; this.value = ''; if (!f) return;
  f.text().then(function (t) { $('dlgTa').value = t; $('dlgMsg').textContent = 'Loaded ' + f.name + '. Choose Add edits to continue.'; });
});
$('dlgCopy').addEventListener('click', copyPrompt);

/* ---------- ask Claude from the page ---------- */
var sample = null, askCtl = null;
function askClaude() {
  if (!sample || askCtl) return;
  var src = ed.value, seen = 0, total = 0;
  if (!src.trim()) { toast('There is no LaTeX to proofread yet.'); return; }
  $('dlgLoad').close();
  showPane('rev');
  askCtl = new AbortController();
  $('askBar').hidden = false; $('askTxt').textContent = 'Claude is reading the file…';
  function eat(text) {
    var list = G.parseEdits(text);
    if (list.length > seen) {
      if (st.example) { st.edits = []; st.cur = -1; st.example = false; }
      var had = st.edits.length; total += addEdits(list.slice(seen)).added; seen = list.length;
      if (!had && total) reviewLayout();
      if (!st.editing) renderReview(); scheduleSave();
      $('askTxt').textContent = 'Claude is proofreading… ' + plural(total, 'edit') + ' so far';
    }
  }
  function finish(msg) { askCtl = null; $('askBar').hidden = true; markPreview(false); toast(msg); }
  sample(PROMPT + '\n\nIf nothing needs changing, reply with the single line: NO EDITS\n\n<document>\n' + src + '\n</document>', { signal: askCtl.signal, cache: false, onText: function (u) { eat(u.text); } })
    .then(function (r) { eat(r.text); finish(total ? 'Claude suggested ' + plural(total, 'edit') + (r.truncated ? '. It ran out of room before the end of the file, so later sections may be unchecked.' : '.') : 'Claude found nothing to change.'); },
      function (err) {
        if (err && err.text) eat(err.text);
        var code = err && err.code, m = 'Claude couldn’t finish. Try again in a moment.';
        if (code === 'cancelled') m = total ? 'Stopped. Kept the ' + plural(total, 'edit') + ' received so far.' : 'Stopped.';
        else if (code === 'prompt_too_large') m = 'This file is too long to send in one request. Ask in the chat instead and load the reply here.';
        else if (code === 'rate_limited') m = 'Claude’s usage limit was reached. Try again later.';
        else if (code === 'session_expired') m = 'Sign in again, then retry.';
        else if (code === 'refused') m = 'Claude declined this request.';
        else if (code === 'not_granted' || code === 'sampling_disabled' || code === 'not_declared' || code === 'capability_disabled' || code === 'capability_removed') { m = 'Claude isn’t available on this page. Ask in the chat instead and load the reply here.'; $('askRow').hidden = true; }
        finish(m);
      });
}
$('dlgAsk').addEventListener('click', askClaude);
$('askStop').addEventListener('click', function () { if (askCtl) askCtl.abort(); });

/* ---------- files and export ---------- */
var downloads = null;
function loadSource(text, name) {
  st.name = name || 'untitled.tex'; st.edits = []; st.cur = -1; st.example = false; st.editing = false;
  $('fname').textContent = st.name;
  main.dataset.src = main.dataset.prev = main.dataset.rev = '1'; syncPaneButtons();
  blocks = []; setSrc(text.replace(/\r\n?/g, '\n'), 0); ed.scrollTop = 0; $('scroll').scrollTop = 0;
  renderReview(); showCaret();
}
$('bOpen').addEventListener('click', function () {
  var real = st.edits.length && !st.example;
  (real ? confirmBox('Opening another file clears the current edit list. Copy or download your reviewed text first if you still need it.', 'Open file') : Promise.resolve(true)).then(function (ok) { if (ok) $('fTex').click(); });
});
$('fTex').addEventListener('change', function () {
  var f = this.files && this.files[0]; this.value = ''; if (!f) return;
  f.text().then(function (t) { loadSource(t, f.name); toast('Opened ' + f.name + '.'); });
});
function copyLatex() { copyText(ed.value).then(function (ok) { toast(ok ? 'LaTeX copied.' : 'Copying was blocked. Select all in the source pane and copy it from there.'); }); }
function saveFile() {
  if (!downloads) return;
  var base = st.name.replace(/\.[^.]+$/, '') || 'document';
  downloads.save({ filename: base + '-reviewed.txt', data: ed.value }).then(function () { toast('Saved. Rename the file to .tex to compile it.'); }, function (err) {
    var c = err && err.code; if (c === 'declined') return;
    toast(c === 'rate_limited' ? 'A save prompt is already open.' : 'Saving isn’t available here. Use Copy LaTeX instead.');
  });
}
$('bCopy').addEventListener('click', copyLatex);
$('bSave').addEventListener('click', saveFile);

/* ---------- panes ---------- */
var PANES = ['src', 'prev', 'rev'];
function setTab(t) { main.dataset.tab = t; syncPaneButtons(); if (t === 'prev') markPreview(false); }
function syncPaneButtons() {
  var n = narrow.matches;
  $('tSrc').setAttribute('aria-pressed', n ? main.dataset.tab === 'src' : main.dataset.src !== '0');
  $('tPrev').setAttribute('aria-pressed', n ? main.dataset.tab === 'prev' : main.dataset.prev !== '0');
  $('tRev').setAttribute('aria-pressed', n ? main.dataset.tab === 'rev' : main.dataset.rev !== '0');
}
function showPane(k) {
  if (narrow.matches) { setTab(k); return; }
  if (main.dataset[k] === '0') { main.dataset[k] = '1'; syncPaneButtons(); scheduleSave(); }
}
function togglePane(k) {
  if (narrow.matches) { setTab(k); return; }
  var on = main.dataset[k] !== '0';
  if (on && PANES.filter(function (p) { return main.dataset[p] !== '0'; }).length === 1) { toast('One pane always stays open.'); return; }
  main.dataset[k] = on ? '0' : '1'; syncPaneButtons(); scheduleSave();
  if (!on && k === 'prev') markPreview(false);
}
/* reviewing needs the edit and its place in the document; the source steps aside until asked for */
function reviewLayout() { main.dataset.src = '0'; main.dataset.prev = '1'; main.dataset.rev = '1'; main.dataset.tab = 'rev'; syncPaneButtons(); }
$('tSrc').addEventListener('click', function () { togglePane('src'); });
$('tPrev').addEventListener('click', function () { togglePane('prev'); });
$('tRev').addEventListener('click', function () { togglePane('rev'); });
if (narrow.addEventListener) narrow.addEventListener('change', syncPaneButtons);

/* ---------- source pane events ---------- */
ed.addEventListener('input', onTyped);
['keyup', 'click', 'focus'].forEach(function (n) { ed.addEventListener(n, showCaret); });
ed.addEventListener('keydown', function (ev) {
  if (ev.key === 'Tab' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    ev.preventDefault();
    var a = ed.selectionStart, b = ed.selectionEnd;
    if (ed.setRangeText) { ed.setRangeText('  ', a, b, 'end'); onTyped(); }
  }
});
$('bCompile').addEventListener('click', compile);
$('auto').addEventListener('change', function () { if (this.checked) compile(); });
$('logL').addEventListener('click', function (ev) { var b = ev.target.closest('[data-pos]'); if (!b) return; var p = Math.min(+b.getAttribute('data-pos'), ed.value.length), ln = lineOf(p), a = posOfLine(ln), z = ed.value.indexOf('\n', a); jumpTo(a, z < 0 ? ed.value.length : z); });

/* ---------- persistence ---------- */
var saveT;
function scheduleSave() { clearTimeout(saveT); saveT = setTimeout(save, 700); }
function save() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ v: 1, name: st.name, src: ed.value, cur: st.cur, nextId: st.nextId, example: st.example, view: st.view, auto: $('auto').checked, panes: [main.dataset.src, main.dataset.prev, main.dataset.rev],
      edits: st.edits.map(function (e) { return { id: e.id, type: e.type, find: e.find, replace: e.replace, reason: e.reason, line: e.line, status: e.status, pos: e.pos, len: e.len, count: e.count, custom: e.custom, applied: e.applied }; }) }));
  } catch (e) {}
}
function restore() {
  var d = null;
  try { d = JSON.parse(window.localStorage.getItem(KEY) || 'null'); } catch (e) {}
  if (!d || d.v !== 1 || typeof d.src !== 'string' || !Array.isArray(d.edits)) return false;
  st.name = d.name || 'untitled.tex'; st.nextId = d.nextId || 1; st.example = !!d.example;
  if (d.view) ['typo', 'sentence', 'passage'].forEach(function (k) { if (/^(marks|split|typeset)$/.test(d.view[k])) st.view[k] = d.view[k]; });
  if (d.auto === false) $('auto').checked = false;
  if (Array.isArray(d.panes) && d.panes.length === 3 && d.panes.some(function (x) { return x !== '0'; })) { savedPanes = true; PANES.forEach(function (k, i) { main.dataset[k] = d.panes[i] === '0' ? '0' : '1'; }); }
  ed.value = d.src; prevVal = d.src;
  st.edits = d.edits.filter(function (e) { return e && typeof e.find === 'string' && typeof e.replace === 'string' && KIND[e.type]; }).map(function (e) {
    var x = { id: e.id || st.nextId++, type: e.type, find: e.find, replace: e.replace, reason: e.reason || '', line: e.line || null, status: /^(pending|accepted|rejected)$/.test(e.status) ? e.status : 'pending', pos: -1, len: 0, count: e.count || 0, custom: typeof e.custom === 'string' ? e.custom : null, applied: null, hint: typeof e.pos === 'number' ? e.pos : null };
    if (x.status === 'accepted') {
      var ap = e.applied;
      if (ap && typeof ap.pos === 'number' && typeof ap.rep === 'string' && typeof ap.orig === 'string') x.applied = { pos: ap.pos, len: ap.rep.length, orig: ap.orig, rep: ap.rep, stale: d.src.slice(ap.pos, ap.pos + ap.rep.length) !== ap.rep };
      else x.applied = { pos: 0, len: 0, orig: x.find, rep: x.replace, stale: true };
    }
    return x;
  });
  relocate();
  st.cur = typeof d.cur === 'number' && d.cur >= 0 && d.cur < st.edits.length ? d.cur : -1;
  if (st.cur < 0) firstPending();
  return true;
}

/* ---------- start ---------- */
var savedPanes = false;
if (!restore()) {
  ed.value = window.__EX_TEX; prevVal = ed.value;
  addEdits(G.parseEdits(window.__EX_EDITS));
  st.example = true;
}
$('fname').textContent = st.name;
main.dataset.tab = st.edits.length ? 'rev' : 'src';
if (!savedPanes && st.edits.length) reviewLayout();
ed.setSelectionRange(0, 0); syncPaneButtons(); renderReview(); compile(); showCaret();
window.addEventListener('pagehide', save);
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') save(); });
setTimeout(function () { markPreview(true); }, 60);
window.__mj.then(function (ok) { if (!ok) { mathOK = false; renderLog(1); } });
if (window.claude && window.claude.use) {
  window.claude.use('downloads').then(function (d) { if (d) { downloads = d; $('bSave').hidden = false; if (!curEdit()) renderReview(); } }, function () {});
  window.claude.use('sample').then(function (s) { if (s) { sample = s; $('askRow').hidden = false; } }, function () {});
}
})();
