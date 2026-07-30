//! HTML / URL escaping + URL normalization helpers.
//!
//! For URLs in `<a href>` / `<img src>` we:
//! 1. Decode HTML entities (`&amp;` → `&`, `&#x41;` → `A`).
//! 2. Decode backslash escapes (`\(` → `(`).
//! 3. Percent-encode chars that aren't URL-safe (spaces → `%20`, etc.).
//! 4. HTML-escape the result for safe insertion as an attribute value.
//! 5. Reject URLs whose scheme isn't in our allowlist (`javascript:` → `#`).

use crate::entities::decode_entity;

pub fn escape_html(s: &str, out: &mut String) {
    escape_into(s, out, false);
}

pub fn escape_attr(s: &str, out: &mut String) {
    escape_into(s, out, true);
}

/// Byte-scanning HTML escape: copy plain runs in one `push_str` (a memcpy)
/// instead of decoding + re-encoding every char. Only the ASCII bytes
/// `< > & "` (and `'` when `quote_apos`) are rewritten — all of them < 0x80, so
/// run boundaries always land on UTF-8 char boundaries and multibyte sequences
/// are copied verbatim. Output is byte-identical to the per-char version; this
/// is the hot path for code/math/HTML-block rendering and the stream caches.
#[inline]
fn escape_into(s: &str, out: &mut String, quote_apos: bool) {
    let bytes = s.as_bytes();
    out.reserve(bytes.len());
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        let ent: &str = match bytes[i] {
            b'<' => "&lt;",
            b'>' => "&gt;",
            b'&' => "&amp;",
            b'"' => "&quot;",
            b'\'' if quote_apos => "&#39;",
            _ => {
                i += 1;
                continue;
            }
        };
        if start < i {
            out.push_str(&s[start..i]);
        }
        out.push_str(ent);
        i += 1;
        start = i;
    }
    if start < bytes.len() {
        out.push_str(&s[start..]);
    }
}

const ESCAPABLE: &[u8] = b"!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

/// Decode backslash escapes and entity references in the input. Used for
/// link URLs and link titles. Does NOT percent-encode.
pub fn decode_text(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' && i + 1 < bytes.len() && ESCAPABLE.contains(&bytes[i + 1]) {
            out.push(bytes[i + 1] as char);
            i += 2;
            continue;
        }
        if b == b'&' {
            if let Some((decoded, consumed)) = decode_entity(&bytes[i..]) {
                out.push_str(&decoded);
                i += consumed;
                continue;
            }
        }
        // Walk by char so multi-byte UTF-8 is preserved correctly.
        if b < 0x80 {
            out.push(b as char);
            i += 1;
        } else {
            let n = utf8_char_len(b);
            let end = (i + n).min(bytes.len());
            if let Ok(s) = std::str::from_utf8(&bytes[i..end]) {
                if let Some(c) = s.chars().next() {
                    out.push(c);
                    i += c.len_utf8();
                    continue;
                }
            }
            // Invalid UTF-8: skip.
            i += 1;
        }
    }
    out
}

fn utf8_char_len(b: u8) -> usize {
    if b < 0x80 { 1 }
    else if b < 0xC0 { 1 } // continuation byte, treat as 1 for safety
    else if b < 0xE0 { 2 }
    else if b < 0xF0 { 3 }
    else { 4 }
}

/// Decode escapes + entities AND percent-encode unsafe characters.
/// Output is HTML-attribute-escape ready (so call escape_attr after).
pub fn normalize_url(input: &str) -> String {
    let decoded = decode_text(input);
    let mut out = String::with_capacity(decoded.len());
    // Walk by UTF-8 chars so we percent-encode non-ASCII correctly.
    for c in decoded.chars() {
        if is_url_safe(c) {
            out.push(c);
        } else if c == '%' {
            // Preserve existing percent-encoded triplets if they look valid.
            // (We're walking chars one at a time so this is approximate.)
            out.push('%');
        } else {
            // Encode this char's UTF-8 bytes as %XX.
            let mut buf = [0u8; 4];
            let s = c.encode_utf8(&mut buf);
            for &b in s.as_bytes() {
                out.push('%');
                out.push(hex(b >> 4));
                out.push(hex(b & 0xF));
            }
        }
    }
    // Fix up existing %XX sequences: if the decoded input already had %XX,
    // re-encoding above would have lowercased nothing but the actual hex
    // digits got passed through as URL-safe. So this works.
    out
}

fn hex(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        10..=15 => (b'A' + (n - 10)) as char,
        _ => '0',
    }
}

fn is_url_safe(c: char) -> bool {
    // RFC 3986 unreserved + reserved gen-delims / sub-delims that are safe
    // in href values. Also keep '%' as-is (covered separately above).
    matches!(
        c,
        'a'..='z' | 'A'..='Z' | '0'..='9'
        | '-' | '_' | '.' | '~'
        | '!' | '*' | '\'' | '(' | ')' | ';' | ':' | '@' | '&'
        | '=' | '+' | '$' | ',' | '/' | '?' | '#' | '[' | ']'
    )
}

// The scheme policy has two tiers.
//
// NEVER_ALLOWED_SCHEMES is the hard core: navigating to one of these EXECUTES
// SCRIPT in the page's origin, so it is XSS by construction. It is blocked
// unconditionally and `allow_schemes` can never resurrect an entry — naming one
// there is a silent no-op. (Same precedent as the raw-HTML sanitizer, where
// allowlisting a tag still cannot bring back a `DANGEROUS_HTML_TAGS` entry.)
const NEVER_ALLOWED_SCHEMES: &[&str] =
    &["javascript:", "vbscript:", "data:text/html", "data:text/javascript"];

// OVERRIDABLE_BLOCKED_SCHEMES is blocked by DEFAULT but can be un-blocked by
// naming the bare scheme in `allow_schemes` (see [`scheme_opted_in`]).
//
// `file:` sits here rather than in the hard core: it cannot run script, but it
// has no legitimate use in rendered untrusted/LLM markdown, and in privileged
// contexts (Electron, browser extensions, `file://` origins) a live `file:` href
// is a local-resource-disclosure / phishing vector. Plain web origins already
// refuse to navigate to it, so blocking it costs nothing there — and an embedder
// that intercepts link clicks instead of navigating (an agent UI opening the path
// in an editor) can opt back in.
const OVERRIDABLE_BLOCKED_SCHEMES: &[&str] = &["file:"];

// `data:` media types a browser parses as an ACTIVE (script-capable) document
// when navigated to. These are blocked on the LINK/href path only — `sanitize_url`,
// URI autolinks, and component URL attributes — via `is_dangerous_href_scheme`.
// The dedicated IMAGE path (`sanitize_image_url`) keeps its own `data:image/`
// allowlist instead: `data:image/svg+xml` loaded through `<img src>` cannot run
// script, so blanket-blocking it there would needlessly break inline SVG images.
// (`data:text/html` / `data:text/javascript` are already in
// `NEVER_ALLOWED_SCHEMES`.) Every entry here is NEVER_ALLOWED-tier:
// `allow_schemes` cannot re-enable one.
const SCRIPTABLE_DATA_PREFIXES: &[&str] = &[
    "data:application/xhtml",   // application/xhtml+xml
    "data:image/svg",           // image/svg+xml (navigated to ⇒ scripts run)
    "data:text/xml",
    "data:application/xml",     // XML + XSLT
    "data:application/javascript",
    "data:application/ecmascript",
    "data:text/ecmascript",
];

/// Lowercased, control-character-stripped view of a URL for scheme detection.
/// Browsers ignore tab/newline/CR (and other C0 controls) when parsing a
/// scheme, so we must too — otherwise `java&#9;script:` slips through.
fn scheme_probe(s: &str) -> String {
    // Single pass: drop C0 controls, trim the leading whitespace run, lowercase
    // the rest. Equivalent to the old filter→lowercase→collect→trim_start chain
    // but with one allocation instead of two. `to_lowercase` (not ASCII) is
    // deliberate — it preserves the Unicode case fold the matcher relies on.
    let mut out = String::new();
    let mut seen_nonspace = false;
    for c in s.chars() {
        if c.is_control() {
            continue;
        }
        if !seen_nonspace && c.is_whitespace() {
            continue;
        }
        seen_nonspace = true;
        for lc in c.to_lowercase() {
            out.push(lc);
        }
    }
    out
}

/// Whether the URL resolves to a dangerous scheme. **Checked on the fully
/// DECODED form**: entities (`&#58;`) and backslash escapes (`\:`) are decoded
/// before a browser ever parses the URL, so checking the raw text lets
/// `javascript&#58;alert(1)` and `javascript\:alert(1)` past the filter. The
/// decode is **stable** — we peel entity/backslash layers until the string stops
/// changing — because a value can be decoded more than once on its way to the
/// DOM (a downstream HTML layer re-decodes, then the browser decodes again), so a
/// multiply-encoded scheme like `javascript&amp;#58;` (or `&amp;amp;#58;`) must
/// collapse to its live form before the match. Then strip the chars browsers
/// ignore and match.
fn dangerous_probe(decoded: &str) -> String {
    let mut s = decoded.to_string();
    // Bound the decode-to-fixpoint walk: a real value collapses in ≤3 passes
    // (e.g. triple-encoded `javascript&amp;amp;#58;`); the cap keeps a crafted
    // `javascript` + `&amp;`×N input from being O(n²).
    for _ in 0..8 {
        let next = decode_text(&s);
        if next == s {
            break;
        }
        s = next;
    }
    scheme_probe(&s)
}

/// Whether `probe` (always a [`scheme_probe`]/[`dangerous_probe`] output — i.e.
/// fully DECODED, control-stripped and lowercased) starts with an
/// overridable-blocked scheme the caller explicitly opted back in.
///
/// `allow_schemes` holds BARE scheme names without the colon (`["file"]`),
/// matched case-insensitively. Only [`OVERRIDABLE_BLOCKED_SCHEMES`] is
/// consulted, so an entry naming a [`NEVER_ALLOWED_SCHEMES`] /
/// [`SCRIPTABLE_DATA_PREFIXES`] scheme is a no-op. The empty (default) list
/// short-circuits, so the default path costs one `is_empty` check and allocates
/// nothing; a non-empty one is a linear scan over two tiny slices of short
/// strings — no `String` is built per URL.
fn scheme_opted_in(probe: &str, allow_schemes: &[Box<str>]) -> bool {
    if allow_schemes.is_empty() {
        return false;
    }
    OVERRIDABLE_BLOCKED_SCHEMES.iter().any(|b| {
        probe.starts_with(b) && {
            let bare = b.strip_suffix(':').unwrap_or(b);
            allow_schemes.iter().any(|a| a.eq_ignore_ascii_case(bare))
        }
    })
}

pub(crate) fn is_dangerous_scheme(decoded: &str, allow_schemes: &[Box<str>]) -> bool {
    let probe = dangerous_probe(decoded);
    NEVER_ALLOWED_SCHEMES.iter().any(|b| probe.starts_with(b))
        || (OVERRIDABLE_BLOCKED_SCHEMES.iter().any(|b| probe.starts_with(b))
            && !scheme_opted_in(&probe, allow_schemes))
}

/// Dangerous-scheme check for the link/href path (regular links, URI autolinks,
/// component URL attributes): everything `is_dangerous_scheme` blocks **plus**
/// the `data:` media types a browser executes as an active document. The image
/// path deliberately uses `is_dangerous_scheme` (+ its own `data:image/`
/// allowlist) instead, so inline SVG/raster images keep working.
pub(crate) fn is_dangerous_href_scheme(decoded: &str, allow_schemes: &[Box<str>]) -> bool {
    let probe = dangerous_probe(decoded);
    NEVER_ALLOWED_SCHEMES
        .iter()
        .chain(SCRIPTABLE_DATA_PREFIXES.iter())
        .any(|b| probe.starts_with(b))
        || (OVERRIDABLE_BLOCKED_SCHEMES.iter().any(|b| probe.starts_with(b))
            && !scheme_opted_in(&probe, allow_schemes))
}

pub fn sanitize_url(url: &str, out: &mut String, is_email: bool, allow_schemes: &[Box<str>]) {
    let trimmed = url.trim();
    let decoded = decode_text(trimmed);
    // Block dangerous schemes on the decoded form. Anything else is allowed —
    // CommonMark only specifies URL normalization, not a scheme allowlist.
    // Real apps rendering untrusted content should still sanitize downstream.
    if is_dangerous_href_scheme(&decoded, allow_schemes) {
        out.push('#');
        return;
    }
    let prefix = if is_email && !decoded.to_ascii_lowercase().starts_with("mailto:") {
        "mailto:"
    } else {
        ""
    };
    let normalized = normalize_url(trimmed);
    out.push_str(prefix);
    escape_attr(&normalized, out);
}

pub fn sanitize_image_url(url: &str, out: &mut String, allow_schemes: &[Box<str>]) {
    let trimmed = url.trim();
    let decoded = decode_text(trimmed);
    if is_dangerous_scheme(&decoded, allow_schemes) {
        out.push('#');
        return;
    }
    // Allowlist on the decoded, control-stripped form (same reason as above).
    let probe = scheme_probe(&decoded);
    let allowed = probe.starts_with("http://")
        || probe.starts_with("https://")
        || probe.starts_with("data:image/")
        // An opted-in overridable-blocked scheme (`file:`) behaves the same on
        // the image path as on the link path — otherwise this allowlist would
        // silently re-block what `allow_schemes` just let through.
        || scheme_opted_in(&probe, allow_schemes)
        || probe.starts_with('/')
        || probe.starts_with("./")
        || probe.starts_with("../")
        || probe.is_empty()
        || (!probe.contains(':') && !probe.starts_with("//"));
    if allowed {
        let normalized = normalize_url(trimmed);
        escape_attr(&normalized, out);
    } else {
        out.push('#');
    }
}

/// Attribute names whose value is a URL and must pass the dangerous-scheme
/// filter before it reaches the DOM. Covers every HTML5 URL carrier a sanitized
/// tag can plausibly reach: the link/media pair (`href`/`src`/`srcset`/`poster`),
/// the form pair (`action`/`formaction`), the quotation/source attributes
/// (`cite`, `data`, `longdesc`), the SVG escape hatch (`xlink:href`), the legacy
/// body/table `background`, and the `<a ping>` beacon. On the RAW-HTML path most
/// of these are dropped outright (see [`RAW_HTML_DROPPED_ATTRS`]); this list is
/// what still gets scheme-checked rather than removed.
const URL_ATTRS: &[&str] = &[
    "href", "src", "xlink:href", "action", "formaction", "poster", "data", "cite",
    "background", "longdesc", "ping", "srcset",
];

/// Attributes dropped from **raw HTML** only (the `html_sanitize` path). Unlike
/// [`REACT_UNSAFE_ATTRS`], which is about not handing a component override a
/// React-meaningful name, this table is about the DOM: every entry is a
/// behavioural attribute that lets attacker-authored markup reach past the text
/// it is supposed to be. Matched case-insensitively on the lowercased name.
///
/// This is deliberately **not** applied to component tags. A component tag's
/// attributes become framework PROPS — we never set them as DOM attributes, the
/// consumer's component decides what (if anything) to do with them — so a
/// `<Tab id="x">` is consumer-mediated and stays permissive. Raw HTML has no
/// such mediator: what the sanitizer emits IS the DOM. See `sanitize_attrs`
/// (permissive, components) vs `sanitize_raw_html_attrs` (this table).
///
/// Several entries are inert *today* only because the tag that gives them
/// meaning is in `DANGEROUS_HTML_TAGS` (`srcdoc` needs `iframe`, `xmlns` needs
/// `svg`/`math`, the `form*` family needs `button`/`input`). They are listed
/// anyway: an embedder that later allowlists such a tag — or a tag that gains
/// the semantics — must not silently inherit an XSS.
const RAW_HTML_DROPPED_ATTRS: &[&str] = &[
    // Inline-document injection: the value IS an HTML document, so it re-opens
    // every hole the sanitizer just closed. Inert only while `iframe` is dropped.
    "srcdoc",
    // Customized-built-in upgrade: binds attacker markup to whatever class the
    // page registered under that name, running its constructor/callbacks.
    "is",
    // Steals focus on insert — scroll-jacks the page and can redirect typing
    // into an element the reader never chose. Pure interaction hijack.
    "autofocus",
    // Makes rendered output editable in place: a UI-spoof primitive (the reader
    // cannot tell authored content from content they appear to have typed).
    "contenteditable",
    // DOM clobbering: a named element shadows `document.<name>` / a global, so
    // `document.getElementById`, `window.top`, a library's `config` lookup, … can
    // be replaced by an element. `id` is safe to drop unconditionally here — our
    // OWN ids (footnote `fn-N`/`fnref-N`, heading slugs) are written by the
    // renderers directly and never pass through this function, which only ever
    // sees raw source tokens.
    "id",
    "name",
    // Shadow-DOM injection surface: `slot` re-parents content into a host's
    // shadow tree; `part`/`exportparts` expose it to `::part()` styling the page
    // author never opted into.
    "slot",
    "part",
    "exportparts",
    // Form hijack: these re-point a submit (or the owning form itself) at an
    // attacker endpoint from a button/input that looks legitimate. `formaction`
    // is also a URL carrier — dropping it is strictly stronger than the scheme
    // check `URL_ATTRS` would apply.
    "form",
    "formaction",
    "formenctype",
    "formmethod",
    "formnovalidate",
    "formtarget",
    // Namespace escape hatches: `xmlns` re-roots a subtree into the SVG/MathML
    // namespace where different parsing rules (and `xlink:href` navigation)
    // apply. The `xmlns:`/`xlink:` PREFIXES go too — dropping `xlink:href` while
    // keeping `xlink:show`/`xlink:actuate` would be exactly the kind of
    // inert-by-luck gap this table exists to close.
    "xmlns",
    "xlink:href",
    // Tracking beacon: fires a background POST to every listed URL on click.
    // Sanitizing the scheme misses the point — there is no benign use in
    // untrusted content, so it is dropped rather than rewritten.
    "ping",
];

/// Whether `lname` (already lowercased) is dropped on the raw-HTML path.
fn is_raw_html_dropped_attr(lname: &str) -> bool {
    RAW_HTML_DROPPED_ATTRS.contains(&lname)
        || lname.starts_with("xmlns:")
        || lname.starts_with("xlink:")
}

/// Attribute names that are React-meaningful or otherwise unsafe to surface to a
/// component override (matched case-insensitively). `dangerouslySetInnerHTML`
/// would let untrusted markup inject raw HTML; `ref`/`key` perturb React's
/// reconciliation; `defaultValue`/`defaultChecked` seed form state from
/// untrusted content; the `suppress*` flags silence hydration-mismatch warnings
/// that would otherwise flag tampering. `data-*`/`aria-*`/`xlink:href` are NOT
/// here and stay allowed. (On the raw-HTML path `xlink:href` *is* dropped — by
/// [`RAW_HTML_DROPPED_ATTRS`], for DOM reasons, not React ones.)
const REACT_UNSAFE_ATTRS: &[&str] = &[
    "dangerouslysetinnerhtml",
    "ref",
    "key",
    "defaultvalue",
    "defaultchecked",
    "suppresshydrationwarning",
    "suppresscontenteditablewarning",
];

/// Parse and sanitize the attributes of a **component**'s opening tag, returning
/// safe `(name, value)` pairs with **decoded** values — the HTML renderer escapes
/// them once and a React layer can use them as-is (so this is the canonical,
/// escape-free storage form). `open_tag` is the whole opening tag, e.g.
/// `<Thinking type="info" onerror="x()">` (a trailing `/>` is fine).
///
/// Security policy (attributes are the real boundary for component tags, since
/// the tag itself is allowlisted and the body is markdown):
///   - the tag name is skipped; only attributes are returned;
///   - an attribute name must be an ASCII letter then `[A-Za-z0-9_:.-]`, else it
///     is dropped;
///   - `on*` event-handler attributes are dropped (case-insensitive);
///   - a URL-bearing attribute (`href`, `src`, …) whose **decoded** value has a
///     dangerous scheme (`javascript:`, `data:text/html`, entity/backslash
///     obfuscations, …) becomes `#` — unless it is an overridable-blocked scheme
///     the caller opted back in via `allow_schemes` (bare names, no colon);
///   - every other value is entity/backslash-decoded and kept verbatim.
///
/// This entry point stays **permissive** for non-URL names: what it returns is a
/// PROP bag handed to `components[tag]`, never markup we set on the DOM, so the
/// DOM-level hazards in [`RAW_HTML_DROPPED_ATTRS`] (`id` clobbering, `slot`, …)
/// are the consumer's to interpret. Raw HTML gets no such mediator — it uses
/// [`sanitize_raw_html_attrs`], which drops that table too.
pub fn sanitize_attrs(open_tag: &str, allow_schemes: &[Box<str>]) -> Vec<(String, String)> {
    sanitize_attrs_inner(open_tag, allow_schemes, false)
}

/// [`sanitize_attrs`] for the RAW-HTML sanitizer (`html_sanitize`): identical
/// parsing and URL policy, plus every name in [`RAW_HTML_DROPPED_ATTRS`] is
/// removed. Use this wherever the sanitized attributes are emitted as real DOM
/// attributes on an attacker-influenced tag; use [`sanitize_attrs`] where they
/// become component props.
pub fn sanitize_raw_html_attrs(open_tag: &str, allow_schemes: &[Box<str>]) -> Vec<(String, String)> {
    sanitize_attrs_inner(open_tag, allow_schemes, true)
}

fn sanitize_attrs_inner(
    open_tag: &str,
    allow_schemes: &[Box<str>],
    raw_html: bool,
) -> Vec<(String, String)> {
    let bytes = open_tag.as_bytes();
    let mut i = 0;
    if bytes.first() == Some(&b'<') {
        i += 1;
    }
    // Skip the tag name (letters/digits/-/:).
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'-' | b':')) {
        i += 1;
    }
    let mut out: Vec<(String, String)> = Vec::new();
    loop {
        while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r') {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] == b'>' {
            break;
        }
        if bytes[i] == b'/' {
            i += 1; // self-closing slash
            continue;
        }
        // Attribute name.
        if !bytes[i].is_ascii_alphabetic() {
            i += 1; // malformed: make progress, never loop forever
            continue;
        }
        let name_start = i;
        while i < bytes.len()
            && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'_' | b':' | b'.' | b'-'))
        {
            i += 1;
        }
        let name = &open_tag[name_start..i];
        // Optional ` = value`.
        while i < bytes.len() && matches!(bytes[i], b' ' | b'\t') {
            i += 1;
        }
        let mut raw_value = "";
        if bytes.get(i) == Some(&b'=') {
            i += 1;
            while i < bytes.len() && matches!(bytes[i], b' ' | b'\t') {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let quote = bytes[i];
                i += 1;
                let vstart = i;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
                raw_value = &open_tag[vstart..i];
                if i < bytes.len() {
                    i += 1; // closing quote
                }
            } else {
                let vstart = i;
                while i < bytes.len() && !matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r' | b'>' | b'/') {
                    i += 1;
                }
                raw_value = &open_tag[vstart..i];
            }
        }
        let lname = name.to_ascii_lowercase();
        if lname.starts_with("on") {
            continue; // event handler — drop
        }
        // `style` is dropped like an event handler: an inline style is a CSS
        // injection vector with no script needed — `background:url(…)` fires an
        // automatic GET (a beacon / CSS-selector exfiltration channel) and
        // `position:fixed;inset:0` paints a full-viewport click-stealing overlay.
        // Untrusted (LLM) markup must not carry one through the sanitizer.
        if lname == "style" {
            continue;
        }
        // React-meaningful / unsafe-to-surface names are dropped (defense in
        // depth for component overrides). `data-*`/`aria-*`/`xlink:href` are
        // intentionally not in this list and pass through.
        if REACT_UNSAFE_ATTRS.contains(&lname.as_str()) {
            continue;
        }
        // Raw-HTML-only DOM hazards (`srcdoc`, `id`/`name` clobbering, `slot`,
        // the `form*` family, …). Component tags skip this — their attributes
        // are props, not DOM attributes; see the two entry points above.
        if raw_html && is_raw_html_dropped_attr(&lname) {
            continue;
        }
        let decoded = decode_text(raw_value);
        let value = if URL_ATTRS.contains(&lname.as_str())
            && is_dangerous_href_scheme(&decoded, allow_schemes)
        {
            "#".to_string()
        } else {
            decoded
        };
        out.push((name.to_string(), value));
    }
    out
}

#[cfg(test)]
mod attr_tests {
    /// Default-config view of the sanitizer (no `allow_schemes` opt-ins) — the
    /// shape every test below exercises. The opt-in tier is covered end-to-end
    /// in `tests/allow_schemes.rs`.
    fn sanitize_attrs(open_tag: &str) -> Vec<(String, String)> {
        super::sanitize_attrs(open_tag, &[])
    }

    /// Raw-HTML tier (the `html_sanitize` path): same parsing, plus
    /// `RAW_HTML_DROPPED_ATTRS`.
    fn sanitize_raw(open_tag: &str) -> Vec<(String, String)> {
        super::sanitize_raw_html_attrs(open_tag, &[])
    }

    fn names(attrs: &[(String, String)]) -> Vec<&str> {
        attrs.iter().map(|(n, _)| n.as_str()).collect()
    }
    fn get<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
        attrs.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }

    #[test]
    fn keeps_plain_attrs_decoded() {
        let a = sanitize_attrs("<Thinking type=\"info\" data-id='42' open>");
        assert_eq!(get(&a, "type"), Some("info"));
        assert_eq!(get(&a, "data-id"), Some("42"));
        assert_eq!(get(&a, "open"), Some("")); // boolean attr
        let a = sanitize_attrs("<Callout title=\"A &amp; B &lt;x&gt;\">");
        assert_eq!(get(&a, "title"), Some("A & B <x>")); // entities decoded
    }

    #[test]
    fn drops_event_handlers() {
        let a = sanitize_attrs("<Thinking onclick=\"steal()\" ONerror='x' onmouseover=y style=\"position:fixed;inset:0\" type=ok>");
        assert!(!names(&a).iter().any(|n| n.to_ascii_lowercase().starts_with("on")), "got {:?}", names(&a));
        // `style` is dropped too (CSS-injection vector: beacon / clickjack overlay).
        assert!(!names(&a).iter().any(|n| n.eq_ignore_ascii_case("style")), "style dropped: {:?}", names(&a));
        assert_eq!(get(&a, "type"), Some("ok"));
    }

    #[test]
    fn neutralizes_dangerous_url_attrs() {
        assert_eq!(get(&sanitize_attrs("<X href=\"javascript:alert(1)\">"), "href"), Some("#"));
        assert_eq!(get(&sanitize_attrs("<X src='data:text/html,<script>'>"), "src"), Some("#"));
        // Entity (`&#58;` = `:`), backslash-before-colon, and control-char
        // (browser-ignored tab) obfuscations are all caught — decoded / stripped
        // before the scheme check, matching how a browser would read the URL.
        assert_eq!(get(&sanitize_attrs("<X href=\"javascript&#58;alert(1)\">"), "href"), Some("#"));
        assert_eq!(get(&sanitize_attrs("<X href=\"javascript\\:alert(1)\">"), "href"), Some("#"));
        assert_eq!(get(&sanitize_attrs("<X href=\"java\tscript:alert(1)\">"), "href"), Some("#"));
        // DOUBLE / TRIPLE entity-encoding must also be caught: the scheme check
        // is decode-STABLE (peels layers to a fixpoint), since a downstream HTML
        // layer and the browser each decode again. (Regression: `&amp;#58;`
        // previously survived single-decode and reached the DOM as `javascript:`.)
        assert_eq!(get(&sanitize_attrs("<X href=\"javascript&amp;#58;alert(1)\">"), "href"), Some("#"));
        assert_eq!(get(&sanitize_attrs("<X href=\"javascript&amp;amp;#58;alert(1)\">"), "href"), Some("#"));
        // Safe URLs pass through (decoded).
        assert_eq!(get(&sanitize_attrs("<X href=\"https://e.com/p?a=1&amp;b=2\">"), "href"), Some("https://e.com/p?a=1&b=2"));
        assert_eq!(get(&sanitize_attrs("<X href=\"/local/path\">"), "href"), Some("/local/path"));
    }

    #[test]
    fn drops_react_meaningful_attrs() {
        // React-meaningful / unsafe-to-surface names are dropped (case-insensitive).
        let a = sanitize_attrs(
            "<Card dangerouslySetInnerHTML=\"{x}\" REF='r' Key=k defaultValue=v \
             DEFAULTCHECKED=c suppressHydrationWarning suppressContentEditableWarning type=ok>",
        );
        for dropped in [
            "dangerouslySetInnerHTML",
            "ref",
            "key",
            "defaultValue",
            "defaultChecked",
            "suppressHydrationWarning",
            "suppressContentEditableWarning",
        ] {
            assert!(
                !names(&a).iter().any(|n| n.eq_ignore_ascii_case(dropped)),
                "{dropped} should be dropped: {:?}",
                names(&a)
            );
        }
        assert_eq!(get(&a, "type"), Some("ok"));
    }

    #[test]
    fn keeps_data_aria_xlink_attrs() {
        // data-*/aria-*/xlink:href must be KEPT (they are not React-unsafe).
        let a = sanitize_attrs(
            "<Card data-id=\"7\" aria-label='hi' xlink:href=\"https://e.com\" type=ok>",
        );
        assert_eq!(get(&a, "data-id"), Some("7"));
        assert_eq!(get(&a, "aria-label"), Some("hi"));
        assert_eq!(get(&a, "xlink:href"), Some("https://e.com"));
        assert_eq!(get(&a, "type"), Some("ok"));
        // A dangerous xlink:href is still neutralized (it's a URL attr).
        let b = sanitize_attrs("<Card xlink:href=\"javascript:alert(1)\">");
        assert_eq!(get(&b, "xlink:href"), Some("#"));
    }

    #[test]
    fn quoted_value_with_special_chars() {
        // A `>` inside a quoted value must not terminate attribute parsing early,
        // and entities in the value are decoded.
        let a = sanitize_attrs("<X title=\"a > b &amp; c\" type=ok>");
        assert_eq!(get(&a, "title"), Some("a > b & c"));
        assert_eq!(get(&a, "type"), Some("ok"), "attr after a quoted `>` still parses");
    }

    #[test]
    fn raw_html_tier_drops_dom_hazard_attrs() {
        // Every RAW_HTML_DROPPED_ATTRS entry dies on the raw-HTML tier while a
        // neighbouring safe attribute still renders.
        for dropped in super::RAW_HTML_DROPPED_ATTRS {
            let a = sanitize_raw(&format!("<x {dropped}=\"v\" title=ok>"));
            assert!(
                !names(&a).iter().any(|n| n.eq_ignore_ascii_case(dropped)),
                "{dropped} should be dropped: {:?}",
                names(&a)
            );
            assert_eq!(get(&a, "title"), Some("ok"), "neighbour survives for {dropped}");
        }
        // The `xmlns:`/`xlink:` PREFIXES go too, not just the two exact names.
        let a = sanitize_raw("<x xmlns:xlink=\"http://www.w3.org/1999/xlink\" xlink:show=new title=ok>");
        assert_eq!(names(&a), vec!["title"], "namespaced names dropped: {:?}", names(&a));
    }

    #[test]
    fn raw_html_tier_matching_is_case_insensitive() {
        let a = sanitize_raw(
            "<x SRCDOC='<script>' FormAction=steal oNcLiCk=evil() ID=q Name=n CONTENTEDITABLE=true title=ok>",
        );
        assert_eq!(names(&a), vec!["title"], "case variants all dropped: {:?}", names(&a));
    }

    #[test]
    fn component_tier_keeps_dom_hazard_attrs_as_props() {
        // The asymmetry, pinned: component attributes are PROPS (consumer
        // mediates them), so the DOM denylist does not apply — but `on*`,
        // `style`, React-unsafe names and dangerous URL schemes still do.
        let a = sanitize_attrs("<Tab id=\"x\" name=n slot=s part=p onClick=\"evil()\" href=\"javascript:alert(1)\">");
        assert_eq!(get(&a, "id"), Some("x"), "component id survives: {:?}", names(&a));
        assert_eq!(get(&a, "name"), Some("n"));
        assert_eq!(get(&a, "slot"), Some("s"));
        assert_eq!(get(&a, "part"), Some("p"));
        assert!(!names(&a).iter().any(|n| n.eq_ignore_ascii_case("onClick")), "on* still dropped");
        assert_eq!(get(&a, "href"), Some("#"), "URL attrs still sanitized");
    }

    #[test]
    fn raw_html_tier_keeps_ordinary_attrs() {
        // Hardening must not turn into an allowlist: presentation/a11y names and
        // `target` (a documented no-change — our own links carry a hardened
        // `rel`, a raw `<a target>` is left to the embedder) still pass.
        let a = sanitize_raw("<a href=\"/p\" title=t class=c data-x=1 aria-label=l target=_blank rel=noopener>");
        assert_eq!(get(&a, "href"), Some("/p"));
        assert_eq!(get(&a, "title"), Some("t"));
        assert_eq!(get(&a, "class"), Some("c"));
        assert_eq!(get(&a, "data-x"), Some("1"));
        assert_eq!(get(&a, "aria-label"), Some("l"));
        assert_eq!(get(&a, "target"), Some("_blank"), "raw target is left as-is by decision");
        assert_eq!(get(&a, "rel"), Some("noopener"));
    }

    #[test]
    fn raw_html_tier_still_sanitizes_urls() {
        // The URL tier is unchanged underneath the drops: `cite` (blockquote/q/
        // ins/del) is scheme-checked, not dropped.
        assert_eq!(get(&sanitize_raw("<q cite=\"javascript:alert(1)\">"), "cite"), Some("#"));
        assert_eq!(get(&sanitize_raw("<q cite=\"https://e.com\">"), "cite"), Some("https://e.com"));
    }

    #[test]
    fn malformed_input_never_panics() {
        for s in [
            "<X", "<X ", "<X =", "<X = =", "<X a=", "<X a=\"unclosed",
            "<X 123=bad . : =>", "<X/>", "<X a=b/>", "<>", "<X\u{0}=\u{0}>", "",
            "<X href=javascript:alert(1)>", "<X a='it''s'>",
        ] {
            let _ = sanitize_attrs(s); // must not panic
        }
    }
}
