/*
 * brook_md.h — C ABI for brookmd-cabi (a wrapper over brookmd-core).
 *
 * Streaming, incremental markdown parser. Feed chunks with brook_session_append;
 * each call returns a JSON "Patch" string (WIRE.md v1.1.0). This header is
 * hand-written and is the source of truth for the exported surface — the Rust
 * crate's `symbol_drift` test tripwires header vs. exports so the two can't drift.
 *
 * Ownership / lifetime rules (see also the doc-comments in src/lib.rs):
 *   - A BrookSession* comes from brook_session_new / brook_session_new_with_config
 *     and MUST be released with brook_session_free exactly once. Freeing twice is
 *     undefined behavior, like C free().
 *   - Every char* returned below is a caller-owned, NUL-terminated, UTF-8 JSON
 *     string; release it with brook_string_free exactly once. Do NOT use libc
 *     free() on it.
 *   - brook_wire_version() returns a pointer to a STATIC string — do NOT free it.
 *   - A BrookSession is NOT internally synchronized: do not use one session from
 *     multiple threads at once. Distinct sessions on distinct threads are fine.
 *   - Every function tolerates a NULL session/string argument (returns NULL/0,
 *     never crashes) and never lets a panic cross this boundary. A caught panic
 *     leaves the session memory-safe but in an unspecified parse state: after a
 *     NULL return not explained by a NULL argument, brook_session_reset (or free)
 *     the session before feeding more input.
 */
#ifndef BROOK_MD_H
#define BROOK_MD_H

#include <stddef.h> /* size_t */
#include <stdint.h> /* uint64_t */

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque streaming-parse session. */
typedef struct BrookSession BrookSession;

/*
 * Create a session with library defaults (GFM autolinks/alerts OFF, raw HTML
 * escaped, block data off). Free with brook_session_free. Returns NULL on failure.
 */
BrookSession *brook_session_new(void);

/*
 * Create a session from a NUL-terminated UTF-8 JSON object whose keys are
 * BrookConfig's snake_case names (e.g. {"gfm_math":true,"block_data":true}).
 * Unknown keys are ignored; missing keys take defaults (autolinks/alerts ON, the
 * rest off). Returns NULL if config_json is NULL, is not valid UTF-8, or is not a
 * valid JSON object. Free with brook_session_free.
 */
BrookSession *brook_session_new_with_config(const char *config_json);

/*
 * Feed the next markdown chunk (length-based; `chunk` need NOT be NUL-terminated).
 * Invalid UTF-8 is repaired lossily (U+FFFD), not rejected. `chunk` may be NULL
 * only when len == 0. Returns a caller-owned JSON Patch string (free with
 * brook_string_free), or NULL if s is NULL, chunk is NULL with len != 0, or a panic
 * was caught.
 */
char *brook_session_append(BrookSession *s, const uint8_t *chunk, size_t len);

/*
 * End the stream: emit still-open blocks as committed. Returns a caller-owned JSON
 * Patch string (free with brook_string_free), or NULL on NULL session.
 */
char *brook_session_finalize(BrookSession *s);

/*
 * The whole parsed document (committed + active), as a caller-owned JSON Block[]
 * string (free with brook_string_free). Returns NULL on NULL session.
 */
char *brook_session_all_blocks(BrookSession *s);

/*
 * Discard parse state and start a fresh stream, preserving the session's config
 * (block ids restart from 0). No-op if s is NULL.
 */
void brook_session_reset(BrookSession *s);

/* Total bytes retained (source buffer + rendered HTML). 0 on NULL session. */
uint64_t brook_session_retained_bytes(BrookSession *s);

/* Length in bytes of the retained source buffer. 0 on NULL session. */
uint64_t brook_session_buffer_len(BrookSession *s);

/* Release a session. No-op if s is NULL. Freeing twice is undefined behavior. */
void brook_session_free(BrookSession *s);

/*
 * Free a string returned by brook_session_append / brook_session_finalize /
 * brook_session_all_blocks. No-op if ptr is NULL. Do not free twice.
 */
void brook_string_free(char *ptr);

/*
 * Wire contract version ("1.1.0"). Returns a pointer to a STATIC string — do NOT
 * free it.
 */
const char *brook_wire_version(void);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* BROOK_MD_H */
