import fs from 'node:fs';

/**
 * Restore the line structure of `lifecycle.ts`.
 *
 * A PowerShell round-trip collapsed every newline in the file, leaving all the
 * content intact on a single line. Rather than rewrite 700 lines by hand, the
 * boundaries are recovered from the TypeScript grammar: a newline is required
 * after `;` that ends a statement, after `{` that opens a block, before `}`
 * that closes one, and around comment markers. Formatting is cosmetic; the token
 * stream is what the compiler cares about, so this only has to be faithful, not
 * pretty.
 */

const target = 'packages/loads/src/lifecycle.ts';
const text = fs.readFileSync(target, 'utf8');

// Anything already terminated is left alone; work on the collapsed single line.
const collapsed = text.replace(/\r/g, '');

let out = '';
let i = 0;
const n = collapsed.length;

/** True when the next non-space character is one of the given characters. */
function peekIs(...chars) {
  let j = i;
  while (j < n && (collapsed[j] === ' ' || collapsed[j] === '\t')) j += 1;
  return chars.includes(collapsed[j]);
}

/** How many newlines already precede position j (0, 1 or 2). */
function existingBreaks(j) {
  let count = 0;
  let k = j;
  while (k > 0) {
    if (collapsed[k - 1] === '\n') count += 1;
    else if (collapsed[k - 1] === ' ' || collapsed[k - 1] === '\t') k -= 1;
    else break;
    k -= 1;
  }
  return count;
}

function emit(text_) {
  out += text_;
  i += text_.length;
}

function newline() {
  const already = existingBreaks(i);
  if (already === 0) out += '\n';
  else if (already === 1) {
    // Already exactly one break: nothing to add.
  } else out += '\n';
}

let inLineComment = false;
let inBlockComment = false;
let inString = null;
let inTemplate = 0;
let depth = 0;

while (i < n) {
  const ch = collapsed[i];
  const next = collapsed[i + 1];

  if (inLineComment) {
    if (ch === '\n') {
      inLineComment = false;
      out += '\n';
    } else out += ch;
    i += 1;
    continue;
  }

  if (inBlockComment) {
    if (ch === '*' && next === '/') {
      out += '*/';
      inBlockComment = false;
      i += 2;
      newline();
      continue;
    }
    if (ch === '\n') out += '\n';
    else out += ch;
    i += 1;
    continue;
  }

  if (inString) {
    out += ch;
    i += 1;
    if (ch === '\\') {
      if (i < n) {
        out += collapsed[i];
        i += 1;
      }
      continue;
    }
    if (ch === inString) inString = null;
    continue;
  }

  if (inTemplate > 0) {
    if (ch === '\\') {
      out += ch + (collapsed[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === '$' && collapsed[i + 1] === '{') {
      // Template interpolation is real code: treat it as brace depth.
      inTemplate -= 1;
      out += '${';
      i += 2;
      continue;
    }
    if (ch === '`') {
      inTemplate -= 1;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '\n') out += '\n';
    else out += ch;
    i += 1;
    continue;
  }

  // Comments
  if (ch === '/' && next === '/') {
    inLineComment = true;
    out += '//';
    i += 2;
    continue;
  }
  if (ch === '/' && next === '*') {
    inBlockComment = true;
    out += '/*';
    i += 2;
    continue;
  }

  // Strings
  if (ch === '"' || ch === "'") {
    inString = ch;
    out += ch;
    i += 1;
    continue;
  }
  if (ch === '`') {
    inTemplate += 1;
    out += ch;
    i += 1;
    continue;
  }

  // Statement terminator.
  if (ch === ';') {
    out += ';';
    i += 1;
    newline();
    continue;
  }

  // Block boundaries.
  if (ch === '{') {
    out += '{';
    depth += 1;
    i += 1;
    // An object literal stays tight; a block gets a break.
    if (!peekIs('}', ',', ')', ':')) newline();
    continue;
  }

  if (ch === '}') {
    depth -= 1;
    out += '}';
    i += 1;
    if (!peekIs(',', ';', ')', ']', '}')) newline();
    continue;
  }

  if (ch === '\n') {
    out += '\n';
    i += 1;
    continue;
  }

  out += ch;
  i += 1;
}

fs.writeFileSync(target, out, 'utf8');

const lines = out.split('\n').length;
console.log(`restored ${lines} lines (${n} chars in)`);