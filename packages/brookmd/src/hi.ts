/**
 * In-house syntax highlighter. Native RegExp only — no Shiki, no Prism, no
 * Highlight.js. Covers the languages an LLM typically emits:
 * js/ts/tsx/jsx, rust, python, go, bash, json, html, css, sql. Unknown
 * languages fall through to plain escaped text. ~6KB minified.
 *
 * Highlighting is per-block, runs once when the block closes. We never
 * highlight an open (streaming) block, which avoids re-highlighting the same
 * code on every chunk — the main perf win for streaming code.
 */

const KEYWORDS_JS = new Set(
  "async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield".split(
    " ",
  ),
);
const KEYWORDS_TS = new Set([
  ...KEYWORDS_JS,
  ...["any", "as", "boolean", "declare", "enum", "interface", "is", "keyof", "module", "namespace", "never", "number", "private", "protected", "public", "readonly", "string", "type", "unknown", "satisfies"],
]);
const KEYWORDS_RUST = new Set(
  "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return Self self static struct super trait true type unsafe use where while".split(
    " ",
  ),
);
const KEYWORDS_PY = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
    " ",
  ),
);
const KEYWORDS_GO = new Set(
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false".split(
    " ",
  ),
);
const KEYWORDS_BASH = new Set(
  "if then elif else fi case esac for select while until do done function in time coproc return break continue".split(
    " ",
  ),
);
const KEYWORDS_SQL = new Set(
  "SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER INDEX VIEW IF EXISTS NOT NULL DEFAULT PRIMARY KEY FOREIGN REFERENCES UNIQUE AS WITH UNION ALL DISTINCT IS BETWEEN LIKE IN AND OR".split(
    " ",
  ),
);

// Each language is described by an ordered list of (token-class, regex) pairs.
// The regex must be sticky (y flag) so it only matches at the current cursor.
// First match wins.
type Pat = [string, RegExp];

const jsPats: Pat[] = [
  ["com", /\/\/[^\n]*/y],
  ["com", /\/\*[\s\S]*?\*\//y],
  ["str", /"(?:\\.|[^"\\\n])*"/y],
  ["str", /'(?:\\.|[^'\\\n])*'/y],
  ["str", /`(?:\\.|[^`\\])*`/y],
  ["rx", /\/(?![*/])(?:\\.|[^/\\\n])+\/[gimsuy]*/y],
  ["num", /\b(?:0x[\da-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b/y],
  ["ident", /[A-Za-z_$][\w$]*/y],
  ["pun", /[+\-*/=<>!&|^~?:;,.[\](){}]/y],
  ["ws", /\s+/y],
];

const rustPats: Pat[] = [
  ["com", /\/\/[^\n]*/y],
  ["com", /\/\*[\s\S]*?\*\//y],
  ["str", /b?"(?:\\.|[^"\\])*"/y],
  ["str", /b?'(?:\\.|[^'\\])'/y],
  ["lt", /'[a-zA-Z_][\w]*/y],
  ["num", /\b\d[\d_]*(?:\.\d[\d_]*)?(?:[ui](?:8|16|32|64|128|size)|f(?:32|64))?\b/y],
  ["mac", /[A-Za-z_]\w*!/y],
  ["attr", /#!?\[[^\]]*\]/y],
  ["ident", /[A-Za-z_]\w*/y],
  ["pun", /[+\-*/=<>!&|^~?:;,.\[\](){}@]/y],
  ["ws", /\s+/y],
];

const pyPats: Pat[] = [
  ["com", /#[^\n]*/y],
  ["str", /[fFrRbB]{0,2}"""[\s\S]*?"""/y],
  ["str", /[fFrRbB]{0,2}'''[\s\S]*?'''/y],
  ["str", /[fFrRbB]{0,2}"(?:\\.|[^"\\\n])*"/y],
  ["str", /[fFrRbB]{0,2}'(?:\\.|[^'\\\n])*'/y],
  ["num", /\b(?:0x[\da-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[jJ]?)\b/y],
  ["dec", /@[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/y],
  ["ident", /[A-Za-z_]\w*/y],
  ["pun", /[+\-*/=<>!&|^~?:;,.[\](){}@%]/y],
  ["ws", /\s+/y],
];

const goPats: Pat[] = [
  ["com", /\/\/[^\n]*/y],
  ["com", /\/\*[\s\S]*?\*\//y],
  ["str", /"(?:\\.|[^"\\\n])*"/y],
  ["str", /`[^`]*`/y],
  ["str", /'(?:\\.|[^'\\\n])'/y],
  ["num", /\b\d[\d_]*(?:\.\d[\d_]*)?\b/y],
  ["ident", /[A-Za-z_]\w*/y],
  ["pun", /[+\-*/=<>!&|^~?:;,.[\](){}]/y],
  ["ws", /\s+/y],
];

const bashPats: Pat[] = [
  ["com", /#[^\n]*/y],
  ["str", /"(?:\\.|[^"\\])*"/y],
  ["str", /'[^']*'/y],
  ["var", /\$\{[^}]+\}|\$\w+|\$[*@#?!$0-9]/y],
  ["num", /\b\d+\b/y],
  ["ident", /[A-Za-z_][\w-]*/y],
  ["pun", /[|&;<>(){}[\]=]/y],
  ["ws", /\s+/y],
];

const jsonPats: Pat[] = [
  ["str", /"(?:\\.|[^"\\\n])*"/y],
  ["num", /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y],
  ["kw", /\b(?:true|false|null)\b/y],
  ["pun", /[{}[\]:,]/y],
  ["ws", /\s+/y],
];

const sqlPats: Pat[] = [
  ["com", /--[^\n]*/y],
  ["com", /\/\*[\s\S]*?\*\//y],
  ["str", /'(?:''|[^'])*'/y],
  ["str", /"(?:""|[^"])*"/y],
  ["num", /\b\d+(?:\.\d+)?\b/y],
  ["ident", /[A-Za-z_][\w]*/y],
  ["pun", /[+\-*/=<>!,;.(){}]/y],
  ["ws", /\s+/y],
];

const htmlPats: Pat[] = [
  ["com", /<!--[\s\S]*?-->/y],
  ["tag", /<\/?[A-Za-z][\w-]*/y],
  ["str", /"[^"]*"/y],
  ["str", /'[^']*'/y],
  ["attr", /[A-Za-z][\w-]*(?==)/y],
  ["pun", /[=/>]/y],
  ["txt", /[^<>"'=]+/y],
];

const cssPats: Pat[] = [
  ["com", /\/\*[\s\S]*?\*\//y],
  ["str", /"[^"]*"/y],
  ["str", /'[^']*'/y],
  ["num", /-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?/y],
  ["sel", /[#.]?[A-Za-z][\w-]*/y],
  ["pun", /[:;,{}()]/y],
  ["ws", /\s+/y],
];

const LANGS: Record<string, { pats: Pat[]; kw?: Set<string> }> = {
  js: { pats: jsPats, kw: KEYWORDS_JS },
  javascript: { pats: jsPats, kw: KEYWORDS_JS },
  ts: { pats: jsPats, kw: KEYWORDS_TS },
  tsx: { pats: jsPats, kw: KEYWORDS_TS },
  jsx: { pats: jsPats, kw: KEYWORDS_JS },
  typescript: { pats: jsPats, kw: KEYWORDS_TS },
  rust: { pats: rustPats, kw: KEYWORDS_RUST },
  rs: { pats: rustPats, kw: KEYWORDS_RUST },
  py: { pats: pyPats, kw: KEYWORDS_PY },
  python: { pats: pyPats, kw: KEYWORDS_PY },
  go: { pats: goPats, kw: KEYWORDS_GO },
  bash: { pats: bashPats, kw: KEYWORDS_BASH },
  sh: { pats: bashPats, kw: KEYWORDS_BASH },
  shell: { pats: bashPats, kw: KEYWORDS_BASH },
  json: { pats: jsonPats },
  sql: { pats: sqlPats, kw: KEYWORDS_SQL },
  html: { pats: htmlPats },
  xml: { pats: htmlPats },
  css: { pats: cssPats },
};

// `<`, `>`, `&`, `"` — the only characters escapeHtml rewrites. Context-free by
// construction (one character in, one fixed entity out), which is what lets the
// incremental path escape a growing tail one appended slice at a time. It used to
// build its result one character at a time (`out += c`), which costs a string
// append per character of every token and of every byte of an escape-fallback
// block. Now it scans for the next special character and copies the run before
// it in one slice: the overwhelmingly common "nothing to escape" case returns
// the input untouched, and the rest costs one append per SPECIAL character
// instead of one per character. Same bytes out.
export function escapeHtml(s: string): string {
  const n = s.length;
  let i = 0;
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 60 || c === 62 || c === 38 || c === 34) break;
  }
  if (i === n) return s; // nothing to escape: zero copies, zero allocations
  let out = s.slice(0, i);
  let last = i;
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    let esc: string;
    if (c === 60) esc = "&lt;";
    else if (c === 62) esc = "&gt;";
    else if (c === 38) esc = "&amp;";
    else if (c === 34) esc = "&quot;";
    else continue;
    out += s.slice(last, i) + esc;
    last = i + 1;
  }
  return out + s.slice(last);
}

/**
 * The resumable tokenizer's cursor: `pos` is the next source index to consume,
 * `out` the markup emitted so far. Start a run at `{ pos: 0, out: "" }`.
 */
export interface HighlightState {
  pos: number;
  out: string;
}

/**
 * Called once per token the tokenizer emits, AFTER its markup is appended:
 * `(cls, start, end, outLen)` where `cls` is the PATTERN class (`ws`, `str`,
 * `com`, `pun`, `ident`… — not the `kw`/`fn`/`ty` refinement), `[start, end)` is
 * the source span, and `outLen` is `state.out.length` once the token has been
 * written. The catch-all one-character fallback reports `cls === ""`.
 *
 * Passing no sink is the default and costs one `undefined` test per token; the
 * escape-fallback path (unknown language / over the size guard) emits no tokens
 * and so reports nothing.
 *
 * @internal The incremental streaming path (hi-inc.ts) is the only consumer —
 * it needs token boundaries to pick a checkpoint that survives an append.
 */
export type TokenSink = (cls: string, start: number, end: number, outLen: number) => void;

/**
 * One resumable slice of {@link highlight}. Consumes WHOLE tokens from
 * `state.pos` until at least `chars` source characters have been taken (or the
 * input ends), appending to `state.out`; returns true once the input is fully
 * consumed.
 *
 * The pass carries NO state between tokens beyond `pos` — every pattern is
 * sticky and matched against the immutable `code` — so stopping and resuming is
 * invisible: for ANY sequence of chunk sizes the final `state.out` is
 * byte-identical to `highlight(code, lang)` (test/hi-chunked.test.ts proves it
 * over the language corpus, down to one token per slice). That is what lets a
 * renderer spread a big block's highlight across several tasks without changing
 * a byte of markup.
 *
 * @internal Not part of the semver surface — use {@link highlight}.
 */
export function stepHighlight(
  code: string,
  lang: string,
  state: HighlightState,
  chars: number,
  sink?: TokenSink,
): boolean {
  // Defense-in-depth: never tokenize a pathologically huge block — fall back to
  // plain escaped text. An unknown language is the same fallback. Both are
  // sliced through the same cursor, so even a 2 MB block escapes incrementally.
  const conf = code.length > 50_000 ? undefined : LANGS[lang.toLowerCase()];
  // `chars` is a floor, not a cap: the token straddling the boundary is emitted
  // whole. A non-positive budget would make no progress, so it counts as one.
  const stop = state.pos + (chars > 0 ? chars : 1);
  if (!conf) {
    const end = stop < code.length ? stop : code.length;
    state.out += escapeHtml(code.slice(state.pos, end));
    state.pos = end;
    return state.pos >= code.length;
  }

  let out = state.out;
  let pos = state.pos;
  const pats = conf.pats;
  const kw = conf.kw;
  // Linear pass with sticky regex tracking lastIndex.
  while (pos < code.length && pos < stop) {
    let matched = false;
    for (let i = 0; i < pats.length; i++) {
      const [cls, re] = pats[i];
      re.lastIndex = pos;
      const m = re.exec(code);
      if (!m || m.index !== pos) continue;
      const text = m[0];
      const after = pos + text.length;
      let finalCls = cls;
      if (cls === "ident") {
        if (kw && kw.has(text)) {
          finalCls = "kw";
        } else if (after < code.length && code[after] === "(") {
          finalCls = "fn";
        } else if (text.length > 1 && text[0] >= "A" && text[0] <= "Z") {
          finalCls = "ty";
        } else {
          // Plain identifier — no span needed.
          out += escapeHtml(text);
          if (sink) sink(cls, pos, after, out.length);
          pos = after;
          matched = true;
          break;
        }
      }
      if (cls === "ws") {
        out += text;
      } else {
        out += `<span class="t-${finalCls}">${escapeHtml(text)}</span>`;
      }
      if (sink) sink(cls, pos, after, out.length);
      pos = after;
      matched = true;
      break;
    }
    if (!matched) {
      // No pattern matched (shouldn't happen with a catch-all ws/other) — emit
      // one char as plain text to make progress.
      out += escapeHtml(code[pos]);
      if (sink) sink("", pos, pos + 1, out.length);
      pos += 1;
    }
  }
  state.out = out;
  state.pos = pos;
  return pos >= code.length;
}

export function highlight(code: string, lang: string): string {
  // One unbounded slice: `chars = code.length` reaches the end of the input on
  // the first call, so this is the same single linear pass it always was.
  const state: HighlightState = { pos: 0, out: "" };
  while (!stepHighlight(code, lang, state, code.length)) {
    /* a slice that big always finishes; the loop is belt-and-braces */
  }
  return state.out;
}

export function supportedLangs(): string[] {
  return Object.keys(LANGS);
}
