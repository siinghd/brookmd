//! Per-item SOURCE OFFSETS on the opt-in structured list channel
//! (`with_block_data`). Each `ListItemData` carries `start` — the item's
//! DOCUMENT-ABSOLUTE byte offset, i.e. the index into the markdown fed so far at
//! which that item's marker (`-`, `*`, `1.`, …) begins. Same origin as
//! `Block::start`, and stable as the document grows because the parser's buffer
//! is append-only (never drained), so `&source[item.start..]` always begins at
//! the item's marker no matter how much came before it.
//!
//! That is the offset a consumer needs to write BACK into the markdown source —
//! e.g. an interactive GFM task list that flips `[ ]` ⇄ `[x]` in the original
//! string — which is otherwise unavailable, brookmd having no hast/mdast tree by
//! design. Deliberately the ITEM's offset and not a task-marker offset: "what is
//! a task item" stays out of the parser, and the offset is equally usable for
//! jump-to-source, edit, and diff.
//!
//! Pinned here:
//!   - off (`blockData` false) ⇒ no `start` key anywhere; wire byte-identical
//!   - full-reparse path AND the incremental list cache agree (streamed
//!     byte-by-byte == one-shot), including the tight→loose `rebuild_loose`
//!     replay and lazy continuation lines
//!   - offsets are document-absolute, not window/block-relative
//!   - offsets survive the footnote-id rebuild (`resolve_block_data_footnotes`)
//!   - KNOWN LIMITATION: nested list items never reach this channel, so they
//!     carry no offset rather than a wrong one

use brook_md_core::blocks::BlockKind;
use brook_md_core::StreamParser;

fn collect(p: &StreamParser) -> String {
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

fn one_shot(md: &str, block_data: bool) -> StreamParser {
    let mut p = StreamParser::new().with_block_data(block_data);
    p.append(md);
    p.finalize();
    p
}

/// Feed `md` one char at a time, then finalize.
fn streamed(md: &str, block_data: bool) -> StreamParser {
    let mut p = StreamParser::new().with_block_data(block_data);
    let mut buf = [0u8; 4];
    for ch in md.chars() {
        p.append(ch.encode_utf8(&mut buf));
    }
    p.finalize();
    p
}

/// Feed `md` one char at a time, then ONE empty append so a freshly-armed cache
/// fires — no finalize, so this is the *open* list as a streaming consumer sees
/// it (the incremental list cache's own view, not the full reparse).
fn streamed_open(md: &str, block_data: bool) -> StreamParser {
    let mut p = StreamParser::new().with_block_data(block_data);
    let mut buf = [0u8; 4];
    for ch in md.chars() {
        p.append(ch.encode_utf8(&mut buf));
    }
    p.append("");
    p
}

/// Every item offset of the FIRST `List` block that carries items. Every item on
/// the wire is a top-level item, so every one of them must have an offset.
fn list_starts(p: &StreamParser) -> Vec<usize> {
    for b in p.all_blocks() {
        if let BlockKind::List { items, .. } = &b.kind {
            if items.is_empty() {
                continue;
            }
            return items
                .iter()
                .map(|it| it.start.expect("a top-level list item must carry a source offset"))
                .collect();
        }
    }
    panic!("expected a List with items");
}

/// The offsets must index the ORIGINAL source at each item's marker.
fn assert_markers(md: &str, starts: &[usize], expect: &[&str]) {
    assert_eq!(starts.len(), expect.len(), "item count for {md:?}: got {starts:?}");
    for (i, (&s, want)) in starts.iter().zip(expect).enumerate() {
        assert!(s <= md.len(), "item {i}: offset {s} past end of {} bytes", md.len());
        assert!(
            md[s..].starts_with(want),
            "item {i}: offset {s} lands on {:?}, expected it to start with {want:?}",
            &md[s..md.len().min(s + want.len() + 8)]
        );
    }
}

// --------------------------------------------------------------------------
// 1. Off ⇒ byte-identical wire
// --------------------------------------------------------------------------

#[test]
fn off_path_never_emits_a_start_key() {
    // `items` is never populated when block_data is off, and an empty `items` is
    // skipped on the wire — so the per-item offset cannot leak into the off wire.
    for md in [
        "- one\n- two\n",
        "5. five\n6. six\n",
        "- [ ] a\n- [x] b\n",
        "- outer\n  - inner\n- last\n",
        "- a\n\n- b\n",
    ] {
        for p in [one_shot(md, false), streamed(md, false)] {
            let mut saw = false;
            for b in p.all_blocks() {
                if let BlockKind::List { ordered, start, items } = &b.kind {
                    saw = true;
                    assert!(start.is_none(), "off path must not populate start for {md:?}");
                    assert!(items.is_empty(), "off path must not populate items for {md:?}");
                    let json = serde_json::to_string(&b.kind).unwrap();
                    assert_eq!(
                        json,
                        format!(r#"{{"type":"List","data":{{"ordered":{ordered}}}}}"#),
                        "off-path List wire must stay byte-identical for {md:?}"
                    );
                    assert!(!json.contains("start"), "off wire leaked a start key for {md:?}");
                }
            }
            assert!(saw, "expected a List for {md:?}");
        }
    }
}

#[test]
fn on_path_html_is_unchanged() {
    // Turning block_data on must not perturb the rendered HTML at all — the
    // offsets ride the structured channel only.
    for md in ["- one\n- two\n", "1. a\n\n2. b\n", "- outer\n  - inner\n"] {
        assert_eq!(collect(&one_shot(md, true)), collect(&one_shot(md, false)), "{md:?}");
    }
}

// --------------------------------------------------------------------------
// 2. Offsets point at the marker — tight / loose / ordered-with-start
// --------------------------------------------------------------------------

#[test]
fn tight_list_offsets_index_each_marker() {
    let md = "- one\n- two\n- three\n";
    assert_markers(md, &list_starts(&one_shot(md, true)), &["- one", "- two", "- three"]);
    // Sanity on the raw numbers, so a uniform shift can't pass by accident.
    assert_eq!(list_starts(&one_shot(md, true)), vec![0, 6, 12]);
}

#[test]
fn loose_list_offsets_index_each_marker() {
    let md = "- one\n\n- two\n\n- three\n";
    assert_markers(md, &list_starts(&one_shot(md, true)), &["- one", "- two", "- three"]);
    assert_eq!(list_starts(&one_shot(md, true)), vec![0, 7, 14]);
}

#[test]
fn ordered_list_with_nondefault_start_offsets_index_each_marker() {
    let md = "5. five\n6. six\n7. seven\n";
    let starts = list_starts(&one_shot(md, true));
    assert_markers(md, &starts, &["5. five", "6. six", "7. seven"]);
    assert_eq!(starts, vec![0, 8, 15]);
    // The list's own `start` number is unaffected by the per-item offsets.
    let n = one_shot(md, true)
        .all_blocks()
        .find_map(|b| match &b.kind {
            BlockKind::List { start, .. } => *start,
            _ => None,
        })
        .unwrap();
    assert_eq!(n, 5);
}

#[test]
fn multi_line_items_offsets_index_each_marker() {
    // Items with their own indented continuation lines: the offset is the
    // MARKER's, not the body's, and the second item is not shifted by the first
    // item's extra lines.
    let md = "- first line\n  still first\n- second\n  still second\n";
    let starts = list_starts(&one_shot(md, true));
    assert_markers(md, &starts, &["- first line", "- second"]);
    assert_eq!(starts, vec![0, 27]);
}

// --------------------------------------------------------------------------
// 3. The task-list consumer's derivation
// --------------------------------------------------------------------------

#[test]
fn task_list_checkbox_is_derivable_from_the_item_offset() {
    // The consumer keeps its own `findTaskListMarkerOffset(source, itemStart)`:
    // from the item's offset, scan forward to the `[` of the checkbox and flip
    // the byte inside it. Nothing about task lists lives in the parser.
    let md = "- [ ] alpha\n- [x] beta\n- plain\n";
    let starts = list_starts(&one_shot(md, true));
    assert_markers(md, &starts, &["- [ ] alpha", "- [x] beta", "- plain"]);

    fn find_marker(src: &str, item_start: usize) -> Option<usize> {
        let rest = &src[item_start..];
        // Skip the bullet + its trailing space, then require `[ ]` / `[x]`.
        let after = rest.find(' ').map(|i| item_start + i + 1)?;
        let tail = &src[after..];
        if tail.starts_with("[ ] ") || tail.starts_with("[x] ") || tail.starts_with("[X] ") {
            Some(after)
        } else {
            None
        }
    }

    assert_eq!(find_marker(md, starts[0]), Some(2));
    assert_eq!(&md[2..5], "[ ]");
    assert_eq!(find_marker(md, starts[1]), Some(14));
    assert_eq!(&md[14..17], "[x]");
    assert_eq!(find_marker(md, starts[2]), None, "a plain item has no checkbox");

    // And the write-back actually round-trips: flip item 0 from unchecked to
    // checked by indexing the ORIGINAL source at the derived offset.
    let at = find_marker(md, starts[0]).unwrap();
    let mut edited = md.to_string();
    edited.replace_range(at..at + 3, "[x]");
    assert_eq!(edited, "- [x] alpha\n- [x] beta\n- plain\n");
}

// --------------------------------------------------------------------------
// 4. Streaming == one-shot
// --------------------------------------------------------------------------

#[test]
fn streamed_offsets_equal_one_shot_offsets() {
    let cases: &[&str] = &[
        "- one\n- two\n- three\n",
        "- one\n\n- two\n\n- three\n",
        "5. five\n6. six\n7. seven\n",
        "- [ ] a\n- [x] b\n",
        "* star one\n* star two\n",
        "1. a\n2. b\n3. c\n4. d\n5. e\n",
        "- item with **bold** and `code`\n- item with [link](http://x)\n",
        "- first line\n  still first\n- second\n",
        "para before\n\n- one\n- two\n",
    ];
    for md in cases {
        let one = list_starts(&one_shot(md, true));
        let str_ = list_starts(&streamed(md, true));
        assert_eq!(str_, one, "streamed offsets != one-shot for {md:?}");
        // Streaming must not perturb the HTML either.
        assert_eq!(collect(&streamed(md, true)), collect(&one_shot(md, true)), "{md:?}");
    }
}

#[test]
fn open_list_offsets_are_right_mid_stream() {
    // The incremental list cache's OWN view (no finalize): the committed items
    // plus the speculative open item all carry correct absolute offsets while
    // the list is still growing.
    let md = "- one\n- two\n- thr";
    let starts = list_starts(&streamed_open(md, true));
    assert_markers(md, &starts, &["- one", "- two", "- thr"]);
    assert_eq!(starts, vec![0, 6, 12]);
}

// --------------------------------------------------------------------------
// 5. Document-absolute, not window/block-relative
// --------------------------------------------------------------------------

#[test]
fn offsets_are_document_absolute_after_kilobytes_of_earlier_blocks() {
    // Several KB of unrelated blocks BEFORE the list. The parser's buffer is
    // append-only (never drained), so the item offsets must index the FULL
    // source, not the tail window the list happened to be parsed in.
    let mut md = String::new();
    for i in 0..120 {
        md.push_str(&format!("## Heading {i}\n\nParagraph {i} with some filler text to add bytes.\n\n"));
    }
    md.push_str("```\ncode block\nwith lines\n```\n\n");
    md.push_str("> a quote\n\n");
    md.push_str("| a | b |\n| - | - |\n| 1 | 2 |\n\n");
    let prefix_len = md.len();
    assert!(prefix_len > 5000, "prefix should be several KB, was {prefix_len}");
    md.push_str("- one\n- two\n- three\n");

    for p in [one_shot(&md, true), streamed(&md, true)] {
        let starts = list_starts(&p);
        assert_markers(&md, &starts, &["- one", "- two", "- three"]);
        assert_eq!(starts, vec![prefix_len, prefix_len + 6, prefix_len + 12]);
    }
}

#[test]
fn a_second_list_later_in_the_document_is_not_relative_to_itself() {
    let md = "- a\n- b\n\npara\n\n- c\n- d\n";
    let mut all: Vec<Vec<usize>> = Vec::new();
    let p = one_shot(md, true);
    for b in p.all_blocks() {
        if let BlockKind::List { items, .. } = &b.kind {
            all.push(items.iter().map(|it| it.start.unwrap()).collect());
        }
    }
    assert_eq!(all.len(), 2, "expected two lists");
    assert_eq!(all[0], vec![0, 4]);
    assert_eq!(all[1], vec![15, 19]);
    assert_markers(md, &all[1], &["- c", "- d"]);
}

// --------------------------------------------------------------------------
// 6. Offsets survive the footnote-id rebuild
// --------------------------------------------------------------------------

#[test]
fn offsets_survive_the_footnote_id_rebuild() {
    // With footnotes on, every committed block's structured payload is rebuilt
    // to resolve `fnref-…` ids in document order — including each ListItemData.
    // That rebuild must carry `start` through untouched.
    let md = "- alpha[^a]\n- beta[^b]\n- gamma\n\n[^a]: note a\n[^b]: note b\n";
    let run = |chunked: bool| {
        let mut p = StreamParser::new().with_block_data(true).with_gfm_footnotes(true);
        if chunked {
            let mut buf = [0u8; 4];
            for ch in md.chars() {
                p.append(ch.encode_utf8(&mut buf));
            }
        } else {
            p.append(md);
        }
        p.finalize();
        p
    };
    for chunked in [false, true] {
        let p = run(chunked);
        let starts = list_starts(&p);
        assert_markers(md, &starts, &["- alpha[^a]", "- beta[^b]", "- gamma"]);
        assert_eq!(starts, vec![0, 12, 23], "chunked={chunked}");
        // The rebuild really did run: the item html carries a resolved ref id.
        let html: Vec<String> = p
            .all_blocks()
            .find_map(|b| match &b.kind {
                BlockKind::List { items, .. } if !items.is_empty() => {
                    Some(items.iter().map(|it| it.html.clone()).collect())
                }
                _ => None,
            })
            .unwrap();
        assert!(html[0].contains("fnref"), "expected a resolved footnote ref, got {:?}", html[0]);
        assert!(!html[0].contains('\u{0}'), "placeholder token leaked: {:?}", html[0]);
    }
}

// --------------------------------------------------------------------------
// 7. The tight→loose `rebuild_loose` replay
// --------------------------------------------------------------------------

#[test]
fn rebuild_loose_replay_preserves_offsets() {
    // Streamed byte-by-byte the list is TIGHT through `- two`, then the blank
    // line before `- three` settles it loose and the cache replays every
    // committed item through `fold_item_body` again. The replayed items must
    // come back with the same offsets.
    let md = "- one\n- two\n\n- three\n- four\n";
    let starts = list_starts(&streamed(md, true));
    assert_markers(md, &starts, &["- one", "- two", "- three", "- four"]);
    assert_eq!(starts, vec![0, 6, 13, 21]);
    assert_eq!(starts, list_starts(&one_shot(md, true)), "loose rebuild != one-shot");
    // It really is loose (the replay ran), not tight.
    let html = collect(&streamed(md, true));
    assert!(html.contains("<li>\n<p>one</p>"), "expected a loose list, got {html}");
    assert_eq!(html, collect(&one_shot(md, true)));
}

// --------------------------------------------------------------------------
// 8. KNOWN LIMITATION — nested items carry no offset (pinned, not fixed)
// --------------------------------------------------------------------------

#[test]
fn nested_items_never_reach_the_items_channel() {
    // A nested list is not a separate Block: its items live inside the PARENT
    // item's `html` and never reach the `items` channel, and the nested render
    // runs against a synthesized de-indented string with no document offset. So
    // nested items produce NO offset rather than a wrong one. Documented in the
    // TS `ListItemData` TSDoc; pinned here so it stays a known contract.
    let md = "- outer one\n  - inner a\n  - inner b\n- outer two\n";
    for p in [one_shot(md, true), streamed(md, true)] {
        let items: Vec<(String, Option<usize>)> = p
            .all_blocks()
            .find_map(|b| match &b.kind {
                BlockKind::List { items, .. } if !items.is_empty() => {
                    Some(items.iter().map(|it| (it.html.clone(), it.start)).collect())
                }
                _ => None,
            })
            .expect("expected a List with items");
        // Exactly the TWO top-level items — the nested ones are not entries.
        assert_eq!(items.len(), 2, "nested items must not appear in the channel: {items:?}");
        assert_eq!(items[0].1, Some(0));
        assert_eq!(items[1].1, Some(36));
        assert_markers(md, &[items[0].1.unwrap(), items[1].1.unwrap()], &["- outer one", "- outer two"]);
        // The nested list rides inside the parent item's html, unlabelled.
        assert!(items[0].0.contains("<ul"), "nested list should be inside the parent item's html");
        assert!(items[0].0.contains("inner a"));
    }
    // Every item that DOES reach the wire carries an offset — there is no
    // `{"html":…}`-without-`start` entry to trip a consumer up.
    let json: Vec<String> = one_shot(md, true)
        .all_blocks()
        .filter(|b| matches!(&b.kind, BlockKind::List { items, .. } if !items.is_empty()))
        .map(|b| serde_json::to_string(&b.kind).unwrap())
        .collect();
    assert_eq!(json.len(), 1);
    assert_eq!(json[0].matches(r#""start":"#).count(), 3, "list start + 2 item starts: {}", json[0]);
}

// --------------------------------------------------------------------------
// 9. Lazy continuations don't shift the recorded offset
// --------------------------------------------------------------------------

#[test]
fn lazy_continuation_lines_do_not_shift_offsets() {
    // `continued lazily` is a lazy continuation of item one (no indent), so item
    // two's marker is still at its own byte position — the offset must be the
    // marker's, unaffected by however many lazy lines preceded it.
    let md = "- one\ncontinued lazily\nand again\n- two\nlazy too\n- three\n";
    for p in [one_shot(md, true), streamed(md, true)] {
        let starts = list_starts(&p);
        assert_markers(md, &starts, &["- one", "- two", "- three"]);
        assert_eq!(starts, vec![0, 33, 48]);
    }
}
