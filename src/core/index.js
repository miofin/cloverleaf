'use strict';
/* Public surface of the core. The build exposes this object to the page as window.Galley. */
var latex = require('./latex');
var edits = require('./edits');
var util = require('./util');

module.exports = {
  compile: latex.compile,
  fragment: latex.fragment,
  parseEdits: edits.parseEdits,
  locate: edits.locate,
  diff: require('./diff').diff,
  esc: util.esc,
  escAttr: util.escAttr
};
