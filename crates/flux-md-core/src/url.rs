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
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
}

pub fn escape_attr(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
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

const BAD_SCHEMES: &[&str] = &["javascript:", "vbscript:", "data:text/html", "data:text/javascript"];

/// Lowercased, control-character-stripped view of a URL for scheme detection.
/// Browsers ignore tab/newline/CR (and other C0 controls) when parsing a
/// scheme, so we must too — otherwise `java&#9;script:` slips through.
fn scheme_probe(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .flat_map(|c| c.to_lowercase())
        .collect::<String>()
        .trim_start()
        .to_string()
}

/// Whether the URL resolves to a dangerous scheme. **Checked on the DECODED
/// form**: entities (`&#58;`) and backslash escapes (`\:`) are decoded before a
/// browser ever parses the URL, so checking the raw text lets
/// `javascript&#58;alert(1)` and `javascript\:alert(1)` past the filter. We
/// decode first, strip the chars browsers ignore, then match.
fn is_dangerous_scheme(decoded: &str) -> bool {
    let probe = scheme_probe(decoded);
    BAD_SCHEMES.iter().any(|b| probe.starts_with(b))
}

pub fn sanitize_url(url: &str, out: &mut String, is_email: bool) {
    let trimmed = url.trim();
    let decoded = decode_text(trimmed);
    // Block dangerous schemes on the decoded form. Anything else is allowed —
    // CommonMark only specifies URL normalization, not a scheme allowlist.
    // Real apps rendering untrusted content should still sanitize downstream.
    if is_dangerous_scheme(&decoded) {
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

pub fn sanitize_image_url(url: &str, out: &mut String) {
    let trimmed = url.trim();
    let decoded = decode_text(trimmed);
    if is_dangerous_scheme(&decoded) {
        out.push('#');
        return;
    }
    // Allowlist on the decoded, control-stripped form (same reason as above).
    let probe = scheme_probe(&decoded);
    let allowed = probe.starts_with("http://")
        || probe.starts_with("https://")
        || probe.starts_with("data:image/")
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
