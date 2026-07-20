//! Frame-sequence pins for speculative open-tail LINK rendering — label phase,
//! `]`-at-EOF hold, ref phase, and the `data-brook-pending` marker.
//!
//! Streams each document char-by-char and asserts what a consumer SEES frame
//! by frame:
//!   - a completing link never flashes its raw `[label` bracket text — the
//!     label is visible inside an inert pending anchor from its first char,
//!   - `data-brook-pending=""` is present exactly while the link is pending and
//!     gone the moment `href` lands (and never in finalized output),
//!   - the deliberate downgrades (literal brackets, unknown shortcut ref,
//!     footnote/checkbox/alert-marker candidates, newline/cap bounds) are
//!     pinned as decisions, not accidents,
//!   - finalize collapses every speculation to the one-shot literal render.

use brook_md_core::StreamParser;

const PENDING: &str =
    "<a data-brook-pending=\"\" target=\"_blank\" rel=\"noopener noreferrer nofollow\">";

fn collect(p: &StreamParser) -> String {
    let mut out = String::new();
    for b in p.all_blocks() {
        out.push_str(&b.html);
    }
    out
}

fn fresh() -> StreamParser {
    StreamParser::new().with_gfm_alerts(true)
}

/// Stream `md` char-by-char; `frames[i]` is the consumer view after the first
/// `i+1` chars (no finalize).
fn frames_with(make: fn() -> StreamParser, md: &str) -> Vec<String> {
    let mut p = make();
    let mut buf = [0u8; 4];
    let mut frames = Vec::new();
    for ch in md.chars() {
        p.append(ch.encode_utf8(&mut buf));
        frames.push(collect(&p));
    }
    frames
}

fn frames(md: &str) -> Vec<String> {
    frames_with(fresh, md)
}

/// Stream char-by-char + finalize must equal one-shot append + finalize, and
/// the finalized output must carry no pending marker.
fn assert_finalize_collapse(make: fn() -> StreamParser, md: &str) {
    let mut streamed = make();
    let mut buf = [0u8; 4];
    for ch in md.chars() {
        streamed.append(ch.encode_utf8(&mut buf));
    }
    streamed.finalize();
    let mut one = make();
    one.append(md);
    one.finalize();
    let s = collect(&streamed);
    assert_eq!(s, collect(&one), "finalize parity broke for {md:?}");
    assert!(
        !s.contains("data-brook-pending"),
        "pending marker leaked into finalized output for {md:?}: {s}"
    );
}

/// Generic pin for a document containing ONE completing link:
///   - no frame ever contains `flash` (the raw `[label`-prefix signature),
///   - at least one frame carries the pending anchor,
///   - pending and the real `href` are mutually exclusive per frame,
///   - the last frame has the href and no pending,
///   - finalize collapses to the one-shot render.
fn assert_link_frames(make: fn() -> StreamParser, md: &str, flash: &str, href_frag: &str) {
    let fr = frames_with(make, md);
    let mut saw_pending = false;
    for (i, f) in fr.iter().enumerate() {
        assert!(
            !f.contains(flash),
            "raw bracket flash {flash:?} at frame {i} of {md:?}: {f}"
        );
        let pending = f.contains("data-brook-pending");
        saw_pending |= pending;
        assert!(
            !(pending && f.contains(href_frag)),
            "pending marker coexists with href at frame {i} of {md:?}: {f}"
        );
    }
    assert!(saw_pending, "no pending-anchor frame for {md:?}");
    let last = fr.last().unwrap();
    assert!(
        last.contains(href_frag) && !last.contains("data-brook-pending"),
        "completed link missing href / still pending for {md:?}: {last}"
    );
    assert_finalize_collapse(make, md);
}

// ---------------------------------------------------------------------------
// Canonical paragraph sequence
// ---------------------------------------------------------------------------

#[test]
fn paragraph_label_visible_from_first_char_no_bracket_flash() {
    let md = "Check the [Earnings Call](https://example.com/q3-earnings) today.";
    let label = "Earnings Call";
    let fr = frames(md);
    let open = md.find('[').unwrap(); // frame index `open` = view after `[`

    // The lone `[` frame is the one deliberate wait-one-frame exception.
    assert_eq!(fr[open], "<p>Check the [</p>");

    // From the FIRST label char on: the growing label is inside the pending
    // anchor, and no frame up to completion ever shows a `[`.
    for k in 1..=label.len() {
        let f = &fr[open + k];
        assert!(
            f.contains(&format!("{PENDING}{}", &label[..k])),
            "label prefix {:?} not pending-visible at frame {}: {f}",
            &label[..k],
            open + k
        );
    }
    let close = md.find(')').unwrap();
    for (i, f) in fr.iter().enumerate().take(close).skip(open + 1) {
        assert!(!f.contains('['), "bracket flash at frame {i}: {f}");
        assert!(
            !f.contains("https"),
            "partial URL leaked as text at frame {i}: {f}"
        );
        assert!(f.contains("data-brook-pending"), "not pending at frame {i}: {f}");
    }
    // `)` lands: href appears, marker gone — and only attributes changed.
    let done = &fr[close];
    assert!(done.contains(
        "<a href=\"https://example.com/q3-earnings\" target=\"_blank\" rel=\"noopener noreferrer nofollow\">Earnings Call</a>"
    ));
    assert!(!done.contains("data-brook-pending"));
    assert_finalize_collapse(fresh, md);
}

// ---------------------------------------------------------------------------
// Contexts: heading, blockquote, alert, list item, nested list, table cell
// ---------------------------------------------------------------------------

#[test]
fn heading_link_frames() {
    assert_link_frames(
        fresh,
        "# See [Docs Portal](https://docs.example/start) now\n",
        "[Doc",
        "href=\"https://docs.example/start\"",
    );
}

#[test]
fn blockquote_link_frames() {
    assert_link_frames(
        fresh,
        "> see [Docs Portal](https://docs.example/start) ok\n",
        "[Doc",
        "href=\"https://docs.example/start\"",
    );
}

#[test]
fn alert_body_link_frames() {
    // The `[!NOTE]` marker itself is excluded from speculation (alert-marker
    // candidate); the body link still speculates.
    let md = "> [!NOTE]\n> read [Docs Portal](https://docs.example/start) now\n";
    assert_link_frames(fresh, md, "[Doc", "href=\"https://docs.example/start\"");
    // And the marker line never got pending-anchor styling while it streamed.
    for (i, f) in frames("> [!NOTE]\n").iter().enumerate() {
        assert!(
            !f.contains("data-brook-pending"),
            "alert marker speculated as link at frame {i}: {f}"
        );
    }
}

#[test]
fn list_item_link_frames() {
    assert_link_frames(
        fresh,
        "- read [Docs Portal](https://docs.example/start) now\n",
        "[Doc",
        "href=\"https://docs.example/start\"",
    );
}

#[test]
fn nested_list_item_link_frames() {
    assert_link_frames(
        fresh,
        "- outer item\n  - see [Docs Portal](https://docs.example/start) x\n",
        "[Doc",
        "href=\"https://docs.example/start\"",
    );
}

#[test]
fn table_cell_link_frames() {
    assert_link_frames(
        fresh,
        "| col |\n| --- |\n| [Docs Portal](https://docs.example/start) |\n",
        "[Doc",
        "href=\"https://docs.example/start\"",
    );
}

// ---------------------------------------------------------------------------
// Reference-style links
// ---------------------------------------------------------------------------

#[test]
fn ref_style_known_def_resolves_after_pending() {
    // Def streamed first, then a full reference: the label AND the streaming
    // ref name ride the pending anchor; the close resolves to the def's href.
    assert_link_frames(
        fresh,
        "[docs]: https://docs.example/start\n\nsee [Docs Portal][docs] end",
        "[Doc",
        "href=\"https://docs.example/start\"",
    );
}

#[test]
fn ref_style_unknown_downgrades_to_literal() {
    // DELIBERATE downgrade: an unknown ref shows the pending label while the
    // brackets stream; when the ref closes, the OUTER `[thing][nope]` settles
    // to literal (documented forward-ref behavior) — but at the `]`-at-EOF
    // frame the INNER `[nope]` correctly re-speculates (a following `(url)`
    // really would make it a link: `[thing][nope](url)` parses as literal
    // `[thing]` + inline link `[nope](url)`). The next byte settles it all.
    let md = "see [thing][nope] end";
    let fr = frames(md);
    let second_open = md.rfind('[').unwrap();
    let second_close = md.rfind(']').unwrap();
    for (i, f) in fr.iter().enumerate().take(second_close).skip(second_open) {
        assert!(
            f.contains(&format!("{PENDING}thing</a>")),
            "ref-name streaming not pending at frame {i}: {f}"
        );
    }
    let close_frame = &fr[second_close];
    assert!(
        close_frame.contains(&format!("see [thing]{PENDING}nope</a>")),
        "unexpected `]`-at-EOF frame after ref close: {close_frame}"
    );
    let settled = &fr[second_close + 1]; // the space after `]`
    assert!(
        settled.contains("[thing][nope]") && !settled.contains("data-brook-pending"),
        "unknown ref did not downgrade after close: {settled}"
    );
    assert_finalize_collapse(fresh, md);
}

// ---------------------------------------------------------------------------
// Deliberate downgrades & exclusions
// ---------------------------------------------------------------------------

#[test]
fn literal_brackets_downgrade_pinned() {
    // "[just brackets] end." — pending while the label streams and at the `]`
    // frame; the byte AFTER `]` (not `(`/`[`) settles it to literal. That
    // pending→literal snap is the accepted cost of never flashing `[label`
    // on real links.
    let md = "start [just brackets] end.";
    let fr = frames(md);
    let close = md.find(']').unwrap();
    assert!(fr[close].contains(&format!("{PENDING}just brackets</a>")));
    let settled = &fr[close + 1]; // the space after `]`
    assert_eq!(settled, "<p>start [just brackets]</p>");
    for f in &fr[close + 1..] {
        assert!(!f.contains("data-brook-pending"));
    }
    assert_finalize_collapse(fresh, md);
}

#[test]
fn shortcut_numeric_ref_stays_literal() {
    // All-digit labels are citation candidates (`[1]`, `[12]` — pervasive in
    // LLM/RAG output) and never speculate: styling every citation as a pending
    // link that snaps back to literal would flash constantly. A genuine
    // numeric link `[1](url)` still upgrades at `](`.
    let md = "[1] and [12] more";
    for (i, f) in frames(md).iter().enumerate() {
        assert!(
            !f.contains("data-brook-pending"),
            "all-digit citation speculated at frame {i}: {f}"
        );
    }
    assert_finalize_collapse(fresh, md);
    // …but a label that STARTS with digits speculates from its first
    // non-digit byte, and a numeric inline link still becomes a real link.
    let fr = frames("[1 more](https://example.com/x) t");
    assert!(fr[1].starts_with("<p>[1")); // all-digit so far: literal
    assert!(fr[2].contains(&format!("{PENDING}1 </a>"))); // space arrived: speculate
    assert!(fr.last().unwrap().contains("href=\"https://example.com/x\""));
    let fr = frames("[1](https://example.com/x) t");
    assert!(fr[2].starts_with("<p>[1]")); // literal through the label phase
    assert!(fr.last().unwrap().contains("href=\"https://example.com/x\""));
    assert_finalize_collapse(fresh, "[1](https://example.com/x) t");
}

#[test]
fn footnote_candidates_never_speculate() {
    let make = || StreamParser::new().with_gfm_footnotes(true);
    // Forward ref (unknown while streaming) and a def opener: both stay
    // literal the whole way — `[^` is a footnote candidate.
    for md in ["note [^1] here", "[^1]: the note\n", "def [^long-name] x"] {
        for (i, f) in frames_with(make, md).iter().enumerate() {
            assert!(
                !f.contains("data-brook-pending"),
                "footnote candidate speculated at frame {i} of {md:?}: {f}"
            );
        }
        assert_finalize_collapse(make, md);
    }
    // With footnotes OFF, `[^1](…` is an ordinary link and may speculate.
    let fr = frames("see [^caret label](https://x.example/y) end");
    assert!(fr.iter().any(|f| f.contains("data-brook-pending")));
}

#[test]
fn checkbox_candidates_never_speculate() {
    for md in ["- [x] done\n- [ ] later\n", "- [X] caps\n"] {
        for (i, f) in frames(md).iter().enumerate() {
            assert!(
                !f.contains("data-brook-pending"),
                "checkbox candidate speculated at frame {i} of {md:?}: {f}"
            );
        }
        assert_finalize_collapse(fresh, md);
    }
    let fin = {
        let mut p = fresh();
        p.append("- [x] done\n- [ ] later\n");
        p.finalize();
        collect(&p)
    };
    assert!(fin.contains("<input type=\"checkbox\" checked disabled>"));
    assert!(fin.contains("<input type=\"checkbox\" disabled>"));
}

#[test]
fn checkbox_lookalike_link_upgrades_at_paren() {
    // `- [x](url)` is a LINK, not a checkbox: literal through `- [x]` (still a
    // checkbox candidate), pending once `(` rules the checkbox out.
    let md = "- [x](https://x.example/y) go\n";
    let fr = frames(md);
    let paren = md.find('(').unwrap();
    for (i, f) in fr.iter().enumerate().take(paren - 1) {
        assert!(
            !f.contains("data-brook-pending"),
            "speculated while still checkbox-ambiguous at frame {i}: {f}"
        );
    }
    assert!(fr[paren].contains(&format!("{PENDING}x</a>")));
    let done = &fr[md.find(')').unwrap()];
    assert!(done.contains("href=\"https://x.example/y\"") && !done.contains("data-brook-pending"));
    assert_finalize_collapse(fresh, md);
}

#[test]
fn lone_bracket_waits_one_frame() {
    let fr = frames("wait [");
    assert_eq!(fr.last().unwrap(), "<p>wait [</p>");
    assert!(!fr.iter().any(|f| f.contains("data-brook-pending")));
}

#[test]
fn multiline_label_downgrades_at_newline() {
    // DELIBERATE UX bound: a stray unclosed `[` speculates only until a
    // newline lands in the still-open label — then the whole run downgrades to
    // literal so prose after it isn't restyled as a pending link. (A genuine
    // multi-line-label link still upgrades once `](` streams.)
    let md = "prose a[5 is indexed\nand more words";
    let fr = frames(md);
    let nl = md.find('\n').unwrap();
    assert!(fr[nl - 1].contains("data-brook-pending")); // before the newline
    // The trailing `\n` itself is trimmed from the open-paragraph slice, so
    // the downgrade lands with the next line's first char.
    for (i, f) in fr.iter().enumerate().skip(nl + 1) {
        assert!(
            !f.contains("data-brook-pending"),
            "still pending after newline at frame {i}: {f}"
        );
    }
    assert!(fr.last().unwrap().contains("a[5 is indexed"));
    assert_finalize_collapse(fresh, md);
}

#[test]
fn oversized_label_downgrades_at_cap() {
    // DELIBERATE UX bound: past any realistic label length the pending anchor
    // downgrades to literal instead of swallowing the block.
    let md = format!("[{}", "a".repeat(600));
    let fr = frames(&md);
    assert!(fr[400].contains("data-brook-pending"));
    let last = fr.last().unwrap();
    assert!(
        !last.contains("data-brook-pending") && last.contains("[aaa"),
        "oversized label still pending: {last}"
    );
}

#[test]
fn ref_def_line_downgrades_at_colon() {
    // Typing a definition `[docs]: url` — pending while `[docs` streams, one
    // literal frame at `:`, then the def line is consumed (renders nothing).
    let md = "[docs]: https://docs.example\n";
    let fr = frames(md);
    let colon = md.find(':').unwrap();
    assert!(fr[colon - 2].contains(&format!("{PENDING}docs</a>")));
    assert_eq!(fr[colon], "<p>[docs]:</p>");
    assert_eq!(fr.last().unwrap(), "");
    assert_finalize_collapse(fresh, md);
}

// ---------------------------------------------------------------------------
// URL/title phase (existing speculation, now with the marker + title fix)
// ---------------------------------------------------------------------------

#[test]
fn title_phase_stays_pending() {
    // `[l](url "ti` used to flash literal during the title — now the pending
    // anchor holds until `)` completes the link.
    let md = "see [Sales Report](https://x.example/r \"Q3 sales report\") done";
    assert_link_frames(fresh, md, "[Sal", "href=\"https://x.example/r\"");
    let fr = frames(md);
    let quote = md.find('"').unwrap();
    assert!(
        fr[quote + 3].contains(&format!("{PENDING}Sales Report</a>")),
        "mid-title frame not pending: {}",
        fr[quote + 3]
    );
}

#[test]
fn angle_url_stays_pending() {
    assert_link_frames(
        fresh,
        "see [Docs Portal](<https://docs.example/a b>) end",
        "[Doc",
        "href=\"https://docs.example/a%20b\"",
    );
}

#[test]
fn parens_in_url_stay_pending() {
    assert_link_frames(
        fresh,
        "see [Wiki Page](https://x.example/y_(z)) end",
        "[Wik",
        "href=\"https://x.example/y_(z)\"",
    );
}

#[test]
fn nested_brackets_in_label_ride_pending() {
    // Mirrors the URL phase's label semantics: inner brackets are literal
    // inside the pending anchor; a COMPLETE nested link disqualifies (§6.6).
    let md = "see [see [nested] thing](https://x.example/n) end";
    assert_link_frames(fresh, md, "[see [nes", "href=\"https://x.example/n\"");
    let fr = frames("no [outer [inner](https://x.example/i) end");
    // Complete nested link inside the open label → outer stays literal, the
    // inner link speculates/completes on its own.
    let last = fr.last().unwrap();
    assert!(last.contains("no [outer <a href=\"https://x.example/i\""));
}

#[test]
fn images_stay_literal_in_both_phases() {
    // Symmetric with the URL phase's image treatment: incomplete images render
    // literally, never as a pending anchor.
    let md = "shot ![alt text](https://x.example/i.png) end";
    for (i, f) in frames(md).iter().enumerate() {
        assert!(
            !f.contains("data-brook-pending"),
            "image speculated at frame {i}: {f}"
        );
    }
    assert_finalize_collapse(fresh, md);
}

// ---------------------------------------------------------------------------
// Cache-cut position independence
// ---------------------------------------------------------------------------

#[test]
fn long_prefix_label_phase_cut_parity() {
    // A long settled prefix engages the paragraph cache, whose active slice
    // starts at the committed CUT — the `[` that is mid-slice in the full
    // rescan is slice-initial there. The speculation guards must be position-
    // independent so both views agree (this exact class broke with a
    // slice-position-keyed checkbox guard).
    let lead = "word ".repeat(200);
    for tail in ["[Earnings Ca", "[x", "[ ", "[x]", "[!NOTE", "[Docs][re"] {
        let md = format!("{lead}{tail}");
        let streamed = {
            let mut p = fresh();
            let mut buf = [0u8; 4];
            for ch in md.chars() {
                p.append(ch.encode_utf8(&mut buf));
            }
            p.append("");
            collect(&p)
        };
        let one = {
            let mut p = fresh();
            p.append(&md);
            collect(&p)
        };
        assert_eq!(streamed, one, "cut-slice parity broke for tail {tail:?}");
    }
}

// ---------------------------------------------------------------------------
// Finalize collapse for unclosed speculation
// ---------------------------------------------------------------------------

#[test]
fn unclosed_at_finalize_collapses_to_literal() {
    for md in [
        "trailing [Earnings Call](https://x",
        "trailing [Earnings Call](https://x \"half title",
        "trailing [Earnings Ca",
        "trailing [Earnings Call]",
        "trailing [label][re",
        "trailing [label][",
        "- item [Earnings Ca",
        "> quote [Earnings Ca",
        "# head [Earnings Ca",
    ] {
        assert_finalize_collapse(fresh, md);
        let mut p = fresh();
        let mut buf = [0u8; 4];
        for ch in md.chars() {
            p.append(ch.encode_utf8(&mut buf));
        }
        p.finalize();
        let fin = collect(&p);
        assert!(
            fin.contains("[Earnings Ca") || fin.contains("[label]["),
            "finalize did not collapse {md:?} to literal: {fin}"
        );
    }
}
