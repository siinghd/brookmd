//! Opt-in URL-scheme un-blocklist (`set_allow_schemes`). The scheme policy has
//! two tiers: a NEVER-ALLOWED core (`javascript:`, `vbscript:`, `data:text/html`,
//! `data:text/javascript`, scriptable `data:` media types) that executes script
//! when navigated to and can never be re-enabled, and an OVERRIDABLE-blocked
//! tier (`file:`) an embedder can opt back in. The subtle class of bug here:
//! the opt-in reaching the hard core (directly or via an encoded scheme), or the
//! default path drifting because the check grew a parameter.

use brook_md_core::StreamParser;

fn render_with(md: &str, allow: &[&str]) -> String {
    let mut p = StreamParser::new()
        .with_allow_schemes(allow.iter().map(|s| s.to_string()).collect());
    p.append(md);
    p.finalize();
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

fn render(md: &str) -> String {
    render_with(md, &[])
}

/// Default config: `file:` stays blocked on every URL path (this is today's
/// behavior — the option must not change it).
#[test]
fn file_scheme_blocked_by_default() {
    // Note an autolink's visible TEXT is always the raw URL (escaped, inert) —
    // only the href is scrubbed, so assert on the attribute, not the whole doc.
    for md in ["[x](file:///etc/passwd)\n", "![a](file:///x.png)\n", "<file:///x>\n"] {
        let out = render(md);
        assert!(
            !out.contains("href=\"file:") && !out.contains("src=\"file:"),
            "live file: URL leaked with default config for {md:?}: {out}"
        );
        assert!(
            out.contains("href=\"#\"") || out.contains("src=\"#\""),
            "expected blocked # for {md:?}: {out}"
        );
    }
}

/// `allowSchemes: ["file"]` un-blocks the link path.
#[test]
fn file_scheme_allowed_when_opted_in() {
    let out = render_with("[x](file:///etc/passwd)\n", &["file"]);
    assert!(
        out.contains("href=\"file:///etc/passwd\""),
        "opted-in file: link should keep its href: {out}"
    );
}

/// Scheme matching is case-insensitive on BOTH sides: the URL's scheme and the
/// configured name.
#[test]
fn matching_is_case_insensitive() {
    for url in ["FILE:///etc/passwd", "File:///etc/passwd"] {
        let out = render_with(&format!("[x]({url})\n"), &["file"]);
        assert!(out.contains(&format!("href=\"{url}\"")), "{url} should be allowed: {out}");
    }
    // …and an upper-case config value works too.
    let out = render_with("[x](file:///etc/passwd)\n", &["FILE"]);
    assert!(
        out.contains("href=\"file:///etc/passwd\""),
        "config value \"FILE\" should allow file:: {out}"
    );
    // Still blocked when the opt-in names something else.
    let out = render_with("[x](file:///etc/passwd)\n", &["vscode"]);
    assert!(!out.contains("file:///"), "unrelated opt-in must not un-block file:: {out}");
}

/// The NEVER-ALLOWED tier is non-overridable: naming one of these in
/// `allow_schemes` is a silent no-op, exactly as allowlisting `<script>` cannot
/// re-enable it in the raw-HTML sanitizer.
#[test]
fn never_allowed_schemes_cannot_be_opted_in() {
    // Every never-allowed scheme, each named in the opt-in list.
    let allow = [
        "javascript",
        "vbscript",
        "data:text/html",
        "data:text/javascript",
        // Scriptable `data:` media types (SCRIPTABLE_DATA_PREFIXES).
        "data:image/svg",
        "data:application/xhtml",
        "data:text/xml",
        "data:application/xml",
        "data:application/javascript",
        "data:application/ecmascript",
        "data:text/ecmascript",
        // …plus the same names in the bare/colon-suffixed spellings a caller
        // might reach for.
        "javascript:",
        "JavaScript",
        "data",
    ];
    let attacks = [
        "javascript:alert(1)",
        "JaVaScRiPt:alert(1)",
        "vbscript:msgbox(1)",
        "data:text/html,<script>alert(1)</script>",
        "data:text/javascript,alert(1)",
        "data:image/svg+xml;base64,PHN2Zz4=",
        "data:application/xhtml+xml;base64,PGh0bWw+",
        "data:text/xml;base64,PHgvPg==",
        "data:application/xml;base64,PHgvPg==",
        "data:application/javascript;base64,YWxlcnQoMSk=",
        "data:application/ecmascript,alert(1)",
        "data:text/ecmascript,alert(1)",
    ];
    for a in attacks {
        // Both the regular-link and the URI-autolink path. A destination
        // carrying `<` or a space is not a valid autolink (it renders as inert
        // escaped text), so only the space/`<`-free ones get the autolink form —
        // which is the real vector anyway, since attackers base64-encode.
        let mut forms = vec![format!("[x]({a})\n")];
        if !a.contains('<') && !a.contains(' ') {
            forms.push(format!("<{a}>\n"));
        }
        for md in forms {
            let out = render_with(&md, &allow);
            assert!(
                out.contains("href=\"#\""),
                "never-allowed scheme leaked for {a:?} in {md:?}: {out}"
            );
            assert!(
                !out.contains("href=\"javascript:")
                    && !out.contains("href=\"vbscript:")
                    && !out.contains("href=\"data:"),
                "live dangerous href for {a:?} in {md:?}: {out}"
            );
        }
    }
    // Image path: the script-execution schemes stay blocked there too.
    for a in ["javascript:alert(1)", "vbscript:x", "data:text/html,<script>"] {
        let out = render_with(&format!("![x]({a})\n"), &allow);
        assert!(out.contains("src=\"#\""), "img never-allowed leaked for {a:?}: {out}");
    }
}

/// The multi-encoding defence still holds with an opt-in active: the allowlist
/// is only ever consulted against the fully DECODED, control-stripped probe, so
/// an obfuscated `javascript:` can never ride in on `allowSchemes: ["file"]`.
#[test]
fn opting_in_file_does_not_enable_encoded_javascript() {
    let attacks = [
        "javascript&#58;alert(1)",         // numeric entity colon
        "javascript&#x3a;alert(1)",        // hex entity colon
        "java&#9;script:alert(1)",         // embedded tab
        "java&#10;script:alert(1)",        // embedded newline
        "javascript\\:alert(1)",           // backslash-escaped colon
        "javascript&amp;#58;alert(1)",     // double-encoded
        "javascript&amp;amp;#58;alert(1)", // triple-encoded
        "&#106;avascript:alert(1)",        // entity-encoded 'j'
        "  javascript:alert(1)",           // leading whitespace
        "vbscript&#58;msgbox(1)",
        "data:text/&#104;tml,<script>",
    ];
    for a in attacks {
        let out = render_with(&format!("[x]({a})\n"), &["file"]);
        assert!(
            !out.contains("\"javascript:") && !out.contains("\"vbscript:"),
            "encoded dangerous scheme leaked for {a:?}: {out}"
        );
        assert!(!out.contains("data:text/html"), "data:text/html leaked for {a:?}: {out}");
        assert!(out.contains("href=\"#\""), "expected blocked href=# for {a:?}: {out}");
    }
    // The inverse obfuscation is a non-issue but pinned anyway: an ENCODED
    // `file:` decodes to the allowed scheme and is let through, proving the
    // allowlist runs on the same decoded probe as the blocklist.
    let out = render_with("[x](file&#58;///x)\n", &["file"]);
    assert!(out.contains("href=\"file:///x\""), "encoded file: should decode + pass: {out}");
}

/// The image path follows the same rule as links — `sanitize_image_url`'s own
/// allowlist must not silently re-block what `allow_schemes` let through.
#[test]
fn image_path_follows_the_same_rule() {
    assert!(
        render("![a](file:///x.png)\n").contains("src=\"#\""),
        "file: image blocked by default"
    );
    let out = render_with("![a](file:///x.png)\n", &["file"]);
    assert!(out.contains("src=\"file:///x.png\""), "opted-in file: image should render: {out}");
    // The `data:image/` carve-out is untouched.
    assert!(
        render_with("![x](data:image/png;base64,iVBOR)\n", &["file"])
            .contains("src=\"data:image/png;base64,iVBOR\""),
        "data:image/ images must still work",
    );
}

/// CommonMark URI autolinks (`<scheme:…>`) route through the same policy.
#[test]
fn autolink_path_follows_the_same_rule() {
    assert!(
        render("<file:///x>\n").contains("href=\"#\""),
        "file: autolink blocked by default"
    );
    let out = render_with("<file:///x>\n", &["file"]);
    assert!(out.contains("href=\"file:///x\""), "opted-in file: autolink should link: {out}");
    // A safe autolink is unaffected either way.
    assert!(render_with("<https://example.com>\n", &["file"]).contains("href=\"https://example.com\""));
}

/// Raw-HTML attribute path (the sanitizer's `sanitize_attrs`): an `href`/`src`
/// carrying `file:` follows the same rule.
#[test]
fn html_attribute_path_follows_the_same_rule() {
    fn sanitized(md: &str, allow: &[&str]) -> String {
        let mut p = StreamParser::new()
            .with_html_sanitize(true, Vec::new(), Vec::new())
            .with_allow_schemes(allow.iter().map(|s| s.to_string()).collect());
        p.append(md);
        p.finalize();
        let mut out = String::new();
        for b in p.all_blocks() {
            out.push_str(&b.html);
        }
        out
    }
    let md = "text <a href=\"file:///etc/passwd\">l</a> and <img src=\"file:///x.png\"> end\n";
    let blocked = sanitized(md, &[]);
    assert!(!blocked.contains("file:///"), "attr file: must be blocked by default: {blocked}");
    assert!(blocked.contains("href=\"#\""), "expected href=# : {blocked}");
    assert!(blocked.contains("src=\"#\""), "expected src=# : {blocked}");

    let allowed = sanitized(md, &["file"]);
    assert!(allowed.contains("href=\"file:///etc/passwd\""), "attr href not allowed: {allowed}");
    assert!(allowed.contains("src=\"file:///x.png\""), "attr src not allowed: {allowed}");

    // Never-allowed stays blocked in an attribute even when named.
    let js = sanitized("<a href=\"javascript:alert(1)\">l</a>\n", &["javascript", "file"]);
    assert!(js.contains("href=\"#\""), "attr javascript: must stay blocked: {js}");
}

/// Nested containers render through a nested `StreamParser` / recursive
/// sub-block scan — the config must propagate to both.
#[test]
fn config_propagates_into_nested_containers() {
    for md in [
        "> see [x](file:///etc/passwd)\n",
        "- see [x](file:///etc/passwd)\n",
        "> - see [x](file:///etc/passwd)\n",
        "1. see [x](file:///etc/passwd)\n",
    ] {
        assert!(
            render(md).contains("href=\"#\""),
            "nested file: must be blocked by default for {md:?}: {}",
            render(md)
        );
        let out = render_with(md, &["file"]);
        assert!(
            out.contains("href=\"file:///etc/passwd\""),
            "nested file: should be allowed for {md:?}: {out}"
        );
    }
}

/// Byte-for-byte parity between a one-shot render and the same input fed one
/// byte at a time, with the opt-in active.
#[test]
fn streaming_matches_one_shot_for_an_allowed_file_link() {
    let md = "Open [the log](file:///var/log/app.log) for details.\n\n> and [again](file:///etc/hosts)\n";
    let one_shot = render_with(md, &["file"]);

    let mut p = StreamParser::new().with_allow_schemes(vec!["file".to_string()]);
    let mut buf = [0u8; 4];
    for c in md.chars() {
        p.append(c.encode_utf8(&mut buf));
    }
    p.finalize();
    let mut streamed = String::new();
    for b in p.all_blocks() {
        streamed.push_str(&b.html);
    }
    assert_eq!(streamed, one_shot, "streamed output must equal one-shot");
    assert!(one_shot.contains("href=\"file:///var/log/app.log\""), "sanity: {one_shot}");
    assert!(one_shot.contains("href=\"file:///etc/hosts\""), "sanity: {one_shot}");
}
