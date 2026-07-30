//! Always-on code-fence `meta` — the info string past the language word.
//!
//! CommonMark §4.5 makes a fence's info string one opaque run; the language is
//! by convention its first whitespace-delimited word, and everything after it
//! (` ```ts title="src/main.ts" `) was previously dropped on the floor. It now
//! rides the structured channel as `BlockKind::CodeBlock.meta`, ALWAYS-ON like
//! `lang` (not gated behind `with_block_data`) — same class of information, and
//! a consumer rendering a filename header shouldn't have to opt into the
//! duplicate source copy `block_data` ships.
//!
//! Pinned invariants:
//!   - a fence with NO meta is byte-identical on the wire (no `meta` key), and
//!     never allocates one (`None`, never `Some("")`)
//!   - the rendered HTML is UNCHANGED — `lang` appears there
//!     (`class="language-…" data-lang="…"`), `meta` deliberately does NOT
//!   - both halves of the info string are the RAW source text: backslash
//!     escapes / entity references stay undecoded on the data channel exactly
//!     as `lang` already leaves them (only the HTML decodes them)
//!   - `meta` becomes visible once it can no longer change: the opening fence
//!     line is terminated by a `\n`, OR the stream is finalized (a document that
//!     ends mid-opener-line still gets its meta — nothing is lost at EOF).
//!     Applied identically by the full path and by every streaming cache, so
//!     streaming == one-shot at every prefix and `meta` never changes once set
//!     (see also `midstream_parity.rs`)

use brook_md_core::blocks::BlockKind;
use brook_md_core::StreamParser;

fn parse(md: &str) -> StreamParser {
    let mut p = StreamParser::new();
    p.append(md);
    p.finalize();
    p
}

/// `(lang, meta)` of the first CodeBlock among a parser's blocks.
fn first_code(p: &StreamParser) -> Option<(Option<String>, Option<String>)> {
    for b in p.all_blocks() {
        if let BlockKind::CodeBlock { lang, meta, .. } = &b.kind {
            return Some((lang.clone(), meta.clone()));
        }
    }
    None
}

/// `(lang, meta)` of the first CodeBlock produced by a one-shot parse.
fn code_of(md: &str) -> (Option<String>, Option<String>) {
    first_code(&parse(md)).expect("expected a CodeBlock")
}

/// Serialized `kind` of the first CodeBlock — the wire a consumer sees.
fn wire(md: &str) -> String {
    let p = parse(md);
    for b in p.all_blocks() {
        if let BlockKind::CodeBlock { .. } = &b.kind {
            return serde_json::to_string(&b.kind).unwrap();
        }
    }
    panic!("expected a CodeBlock");
}

/// HTML of the first CodeBlock.
fn html(md: &str) -> String {
    let p = parse(md);
    for b in p.all_blocks() {
        if let BlockKind::CodeBlock { .. } = &b.kind {
            return b.html.clone();
        }
    }
    panic!("expected a CodeBlock");
}

// ---------------------------------------------------------------------------
// Parsing rule
// ---------------------------------------------------------------------------

#[test]
fn no_meta_is_none_and_absent_from_the_wire() {
    assert_eq!(code_of("```ts\nlet x = 1;\n```\n"), (Some("ts".into()), None));
    // The key is omitted entirely — byte-identical to before this feature.
    assert_eq!(
        wire("```ts\nlet x = 1;\n```\n"),
        r#"{"type":"CodeBlock","data":{"lang":"ts"}}"#
    );
    // Trailing whitespace after the language is NOT meta (never `Some("")`).
    assert_eq!(code_of("```ts   \nlet x = 1;\n```\n"), (Some("ts".into()), None));
    assert_eq!(
        wire("```ts   \nlet x = 1;\n```\n"),
        r#"{"type":"CodeBlock","data":{"lang":"ts"}}"#
    );
}

#[test]
fn attribute_style_meta() {
    assert_eq!(
        code_of("```ts title=\"src/main.ts\"\nlet x = 1;\n```\n"),
        (Some("ts".into()), Some("title=\"src/main.ts\"".into()))
    );
    assert_eq!(
        wire("```ts title=\"src/main.ts\"\nlet x = 1;\n```\n"),
        r#"{"type":"CodeBlock","data":{"lang":"ts","meta":"title=\"src/main.ts\""}}"#
    );
}

#[test]
fn bare_filename_meta() {
    // The other form the t3code chat UI supports: ```ts src/main.ts
    assert_eq!(
        code_of("```ts src/main.ts\nlet x = 1;\n```\n"),
        (Some("ts".into()), Some("src/main.ts".into()))
    );
}

#[test]
fn meta_is_trimmed_at_the_ends_only() {
    // Interior whitespace is preserved VERBATIM (the info string is opaque —
    // only the language/meta split and the outer trim are ours).
    assert_eq!(
        code_of("```ts   a=1   b=2   \nlet x = 1;\n```\n"),
        (Some("ts".into()), Some("a=1   b=2".into()))
    );
    // A tab between language and meta is a separator like any other whitespace.
    assert_eq!(
        code_of("```ts\ta=1\nlet x = 1;\n```\n"),
        (Some("ts".into()), Some("a=1".into()))
    );
}

#[test]
fn meta_without_a_language_is_the_language() {
    // PINNED: CommonMark's first word IS the language — there is no
    // "looks like an attribute so it must be meta" special case. ```` ``` title=x ````
    // therefore yields lang `title=x` and NO meta, exactly as the pre-existing
    // `lang` extraction already behaved.
    assert_eq!(code_of("``` title=x\nlet x = 1;\n```\n"), (Some("title=x".into()), None));
    // …and with a second word, the rest becomes meta.
    assert_eq!(
        code_of("``` title=x extra\nlet x = 1;\n```\n"),
        (Some("title=x".into()), Some("extra".into()))
    );
}

#[test]
fn tilde_fences_behave_identically() {
    assert_eq!(
        code_of("~~~ts title=\"src/main.ts\"\nlet x = 1;\n~~~\n"),
        (Some("ts".into()), Some("title=\"src/main.ts\"".into()))
    );
    assert_eq!(code_of("~~~ts\nlet x = 1;\n~~~\n"), (Some("ts".into()), None));
    // A tilde fence's info string may contain backticks (§4.5) — still just meta.
    assert_eq!(
        code_of("~~~ts a`b\nlet x = 1;\n~~~\n"),
        (Some("ts".into()), Some("a`b".into()))
    );
}

#[test]
fn indented_code_has_no_info_string() {
    assert_eq!(code_of("    let x = 1;\n"), (None, None));
    assert_eq!(wire("    let x = 1;\n"), r#"{"type":"CodeBlock","data":{"lang":null}}"#);
}

// ---------------------------------------------------------------------------
// HTML is unchanged — `meta` is a DATA-only channel
// ---------------------------------------------------------------------------

#[test]
fn meta_never_reaches_the_html() {
    let with_meta = html("```ts title=\"src/main.ts\"\nlet x = 1;\n```\n");
    let without = html("```ts\nlet x = 1;\n```\n");
    // Byte-identical: the meta changes the data channel and nothing else.
    assert_eq!(with_meta, without);
    assert!(!with_meta.contains("data-meta"), "no data-meta attribute: {with_meta}");
    assert!(with_meta.contains("data-lang=\"ts\""), "lang still in the HTML: {with_meta}");
}

#[test]
fn escapes_and_entities_match_the_existing_lang_handling() {
    // The data channel carries the RAW info-string text for BOTH halves —
    // `lang` has always been the undecoded first word; `meta` is the undecoded
    // remainder. Only the HTML decodes (`push_code_fence_open` → `decode_text`).
    let md = "```te\\!xt title=&quot;x&quot;\nlet x = 1;\n```\n";
    assert_eq!(
        code_of(md),
        (Some("te\\!xt".into()), Some("title=&quot;x&quot;".into()))
    );
    let h = html(md);
    // Backslash escape decoded for the HTML class/attribute, not for the data.
    assert!(h.contains("data-lang=\"te!xt\""), "decoded lang in HTML: {h}");
    assert!(!h.contains("data-meta"), "no data-meta attribute: {h}");
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

#[test]
fn streaming_byte_by_byte_matches_one_shot_at_every_prefix() {
    let md = "```ts title=\"src/main.ts\"\nlet x = 1;\nlet y = 2;\n```\n";
    let mut p = StreamParser::new();
    let mut prefix = String::new();
    let mut buf = [0u8; 4];
    let mut after_opener: Vec<Option<String>> = Vec::new();
    for ch in md.chars() {
        let s: &str = ch.encode_utf8(&mut buf);
        p.append(s);
        prefix.push_str(s);
        // The one-shot view of the SAME prefix, neither side finalized.
        let mut one = StreamParser::new();
        one.append(&prefix);
        assert_eq!(
            first_code(&p),
            first_code(&one),
            "mid-stream != one-shot at prefix {prefix:?}"
        );
        // Once the opening fence line is complete, meta is settled forever.
        if prefix.contains('\n') {
            after_opener.push(first_code(&p).and_then(|(_, meta)| meta));
        }
    }
    p.finalize();
    assert!(!after_opener.is_empty());
    for meta in &after_opener {
        assert_eq!(
            meta.as_deref(),
            Some("title=\"src/main.ts\""),
            "meta changed mid-stream after the opening line completed"
        );
    }
    assert_eq!(
        first_code(&p).unwrap(),
        (Some("ts".into()), Some("title=\"src/main.ts\"".into()))
    );
    // …and identical to the one-shot parse of the whole document.
    assert_eq!(first_code(&p).unwrap(), code_of(md));
}

#[test]
fn chunked_appends_match_one_shot() {
    // Chunk boundaries INSIDE the info string (the fence-info cache's shape) —
    // the meta must land exactly as the one-shot parse has it.
    let md = "```ts title=\"src/main.ts\"\nlet x = 1;\n```\n";
    for cut in 1..md.len() {
        if !md.is_char_boundary(cut) {
            continue;
        }
        let mut p = StreamParser::new();
        p.append(&md[..cut]);
        p.append(&md[cut..]);
        p.finalize();
        assert_eq!(first_code(&p).unwrap(), code_of(md), "cut at {cut}");
    }
}

#[test]
fn meta_waits_for_the_opening_line_to_be_terminated() {
    // Opener line still arriving: the meta could still grow, so it is withheld
    // rather than published half-typed. (`lang` needs no such gate — it is the
    // first word, settled by the whitespace that follows it.)
    let mut p = StreamParser::new();
    p.append("```ts title=\"src/ma");
    assert_eq!(first_code(&p).unwrap(), (Some("ts".into()), None));
    // The terminating newline settles it — once, for the block's whole life.
    p.append("in.ts\"\n");
    assert_eq!(
        first_code(&p).unwrap(),
        (Some("ts".into()), Some("title=\"src/main.ts\"".into()))
    );
}

#[test]
fn finalize_settles_an_opener_line_that_never_got_a_newline() {
    // A document that simply ENDS mid-opener-line: `finalize()` makes that
    // partial line final by definition, so the meta is published, not lost.
    let mut p = StreamParser::new();
    p.append("```ts title=\"src/main.ts\"");
    assert_eq!(first_code(&p).unwrap(), (Some("ts".into()), None), "open: not settled yet");
    p.finalize();
    assert_eq!(
        first_code(&p).unwrap(),
        (Some("ts".into()), Some("title=\"src/main.ts\"".into())),
        "finalize settles the partial opener line"
    );
    assert_eq!(first_code(&p).unwrap(), code_of("```ts title=\"src/main.ts\""));
}

#[test]
fn unclosed_fence_exposes_meta_while_still_streaming() {
    // No closing fence, no finalize — the block is open, but its opening line is
    // complete, so the meta is already there.
    let mut p = StreamParser::new();
    p.append("```ts title=\"src/main.ts\"\nlet x = 1;\n");
    assert_eq!(
        first_code(&p).unwrap(),
        (Some("ts".into()), Some("title=\"src/main.ts\"".into()))
    );
    // Body growth doesn't disturb it (the streaming fence cache re-emits the
    // block every append; meta rides as a clone of the value parsed at arm time).
    p.append("let y = 2;\n");
    assert_eq!(
        first_code(&p).unwrap(),
        (Some("ts".into()), Some("title=\"src/main.ts\"".into()))
    );
    p.finalize();
    assert_eq!(
        first_code(&p).unwrap(),
        (Some("ts".into()), Some("title=\"src/main.ts\"".into()))
    );
}

#[test]
fn meta_rides_alongside_the_opt_in_block_data() {
    // `meta` is always-on; `code` is opt-in. Both keys, in wire order.
    let mut p = StreamParser::new().with_block_data(true);
    p.append("```ts title=\"src/main.ts\"\nlet x = 1;\n```\n");
    p.finalize();
    for b in p.all_blocks() {
        if let BlockKind::CodeBlock { .. } = &b.kind {
            assert_eq!(
                serde_json::to_string(&b.kind).unwrap(),
                r#"{"type":"CodeBlock","data":{"lang":"ts","meta":"title=\"src/main.ts\"","code":"let x = 1;\n"}}"#
            );
            return;
        }
    }
    panic!("expected a CodeBlock");
}

#[test]
fn math_and_mermaid_fences_are_untouched() {
    // A ```math / ```mermaid fence is a different block kind — it carries no
    // meta at all, with or without an info tail.
    let p = parse("```math title=x\nE = mc^2\n```\n");
    assert!(first_code(&p).is_none(), "math fence must not classify as CodeBlock");
    let p = parse("```mermaid title=x\ngraph TD;\n```\n");
    assert!(first_code(&p).is_none(), "mermaid fence must not classify as CodeBlock");
}
