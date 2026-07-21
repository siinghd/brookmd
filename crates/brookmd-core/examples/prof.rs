//! Scratch profiling target: stream one scenario repeatedly for `perf record`.
//! Usage: cargo run --release --example prof -- <list|alert|table|quote|mixed>

use brook_md_core::StreamParser;

fn big_list(target: usize) -> String {
    let mut s = String::with_capacity(target + 32);
    let mut i = 0usize;
    while s.len() < target {
        s.push_str(&format!("- item {i} with some **bold** and a `bit of code` for flavor\n"));
        i += 1;
    }
    s
}

fn big_alert(target: usize) -> String {
    let mut s = String::from("> [!NOTE]\n");
    while s.len() < target {
        s.push_str("> a continuation line of the note body with **bold** and a [link](https://example.com) thrown in.\n");
    }
    s
}

fn big_table(target: usize) -> String {
    let mut s = String::with_capacity(target + 32);
    s.push_str("| Name | Age | City | Score |\n| --- | --- | --- | --- |\n");
    let mut i = 0;
    while s.len() < target {
        s.push_str(&format!("| Person {i} | {} | Town {i} | {} |\n", 20 + (i % 60), i * 7 % 1000));
        i += 1;
    }
    s
}

fn big_quote(target: usize) -> String {
    let mut s = String::with_capacity(target + 32);
    let unit = "> a continuation line with some **emphasis** and `code` here, plus more prose to bulk it up.\n";
    while s.len() < target {
        s.push_str(unit);
    }
    s
}

fn main() {
    let which = std::env::args().nth(1).unwrap_or_else(|| "list".into());
    let doc = match which.as_str() {
        "alert" => big_alert(200_000),
        "table" => big_table(200_000),
        "quote" => big_quote(200_000),
        _ => big_list(200_000),
    };
    let bytes = doc.as_bytes();
    let mut sink = 0usize;
    for _ in 0..8 {
        let mut p = StreamParser::new().with_gfm_autolinks(true).with_gfm_alerts(true);
        let mut i = 0;
        while i < bytes.len() {
            let mut e = (i + 256).min(bytes.len());
            while e < bytes.len() && (bytes[e] & 0xC0) == 0x80 {
                e += 1;
            }
            std::hint::black_box(p.append(&doc[i..e]));
            i = e;
        }
        std::hint::black_box(p.finalize());
        sink += p.all_blocks().map(|b| b.html.len()).sum::<usize>();
    }
    println!("{sink}");
}
