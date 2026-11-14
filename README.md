# Cloverleaf

Latex compiler and editor that makes it easier to use AI to edit latex files.
Provides a convenient environment to step through AI-suggested edits and
approve or deny them.

A single-page LaTeX proof desk. Open a `.tex` file, load a list of edits an AI
suggested, and step through them one at a time: each edit shows what would
change, and nothing is written into your source until you approve it.

Edits come in three kinds:

- **typo**: a spelling, grammar, punctuation or LaTeX slip
- **sentence**: one sentence reworded
- **passage**: a few sentences up to a few paragraphs rewritten

## Quick start

```sh
node scripts/build.js     # writes dist/galley.html
```

Open `dist/galley.html` in a browser. The build has no dependencies; it needs
Node 18 or newer. The page loads MathJax and its fonts from a CDN, so math is
typeset only when you are online.

## Using it

1. **Open .tex** loads your file. The page starts with a small example.
2. **Load edits**, then paste the AI's edit list or choose the file it came in.
   The same window has a prompt you can copy and send to any AI along with
   your `.tex`; its reply will be in the format below.
3. For each edit, **Approve** (`A`) writes it into the source and **Deny** (`D`)
   leaves the source alone. `U` undoes a decision, `←` `→` move between edits.
   You can reword a replacement before approving it.
4. **Copy LaTeX** gives you the reviewed source.

The source, the edit list and your decisions are kept in the browser's local
storage, so a reload does not lose them.

## Edit list format

```text
=== EDIT typo
REASON: Spelling.
<<<<<<< ORIGINAL
You will recieve full credit
=======
You will receive full credit
>>>>>>> REVISED
```

The word after `EDIT` is `typo`, `sentence` or `passage`. `ORIGINAL` must match
the source exactly; an edit whose original text cannot be found is flagged and
cannot be applied. A JSON array of `{ "type", "find", "replace", "reason" }`
objects is also accepted. See `examples/example-edits.txt`.

## What the preview is, and is not

The preview is a LaTeX-to-HTML compiler written for this page, not a TeX
engine. It exists so you can read the document and see each edit in context.

It handles sections, theorem environments (`\newtheorem`, and thmtools
`\declaretheorem` with mdframed box styles), lists, tables, footnotes,
cross-references, `\newcommand` and `\def` macros, xcolor names and mixes, and
all math through MathJax.

It does not draw TikZ or Asymptote pictures or load images (they appear as
placeholders), read `\input` files, or reproduce page layout. Build the final
PDF with your usual toolchain.

## Layout

```text
src/
  index.html        page shell; the build fills in its placeholders
  styles.css
  core/             no DOM, runs in Node and the browser
    latex.js        LaTeX -> HTML compiler
    edits.js        edit-list parsing, locating an edit in the source
    diff.js         word-level diff
    util.js
    index.js        public surface, exposed to the page as window.Galley
  app/
    ui.js           panes, review queue, loading edits, persistence
examples/           the document and edit list the page starts with
scripts/build.js    bundles everything into dist/galley.html
test/
  core.test.js      unit tests for src/core (node:test, no dependencies)
  e2e.js            drives the built page in headless Chromium
  fixtures/
```

## Development

```sh
npm test            # unit tests
npm install         # only needed for the browser test
npx playwright install chromium
npm run test:e2e    # builds, then runs the browser test
```

`dist/` is build output and is not committed.

## Running inside Claude

The page was built as a Claude artifact. When it is hosted there it also offers
a download button and an "Ask Claude to proofread this file now" button, both
provided by the host. Anywhere else those two buttons stay hidden and
everything else works the same.
