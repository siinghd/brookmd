/*
 * flux_md.h — C ABI for flux-md-cabi (a wrapper over flux-md-core).
 *
 * Streaming, incremental markdown parser. Feed chunks with flux_session_append;
 * each call returns a JSON "Patch" string (WIRE.md v1.0.0). This header is
 * hand-written and is the source of truth for the exported surface — the Rust
 * crate's `symbol_drift` test tripwires header vs. exports so the two can't drift.
 *
 * Ownership / lifetime rules (see also the doc-comments in src/lib.rs):
 *   - A FluxSession* comes from flux_session_new / flux_session_new_with_config
 *     and MUST be released with flux_session_free exactly once. Freeing twice is
 *     undefined behavior, like C free().
 *   - Every char* returned below is a caller-owned, NUL-terminated, UTF-8 JSON
 *     string; release it with flux_string_free exactly once. Do NOT use libc
 *     free() on it.
 *   - flux_wire_version() returns a pointer to a STATIC string — do NOT free it.
 *   - A FluxSession is NOT internally synchronized: do not use one session from
 *     multiple threads at once. Distinct sessions on distinct threads are fine.
 *   - Every function tolerates a NULL session/string argument (returns NULL/0,
 *     never crashes) and never lets a panic cross this boundary. A caught panic
 *     leaves the session memory-safe but in an unspecified parse state: after a
 *     NULL return not explained by a NULL argument, flux_session_reset (or free)
 *     the session before feeding more input.
 */
#ifndef FLUX_MD_H
#define FLUX_MD_H

#include <stddef.h> /* size_t */
#include <stdint.h> /* uint64_t */

#ifdef __cplusplus
extern "C" {
#endif

/* Opaque streaming-parse session. */
typedef struct FluxSession FluxSession;

/*
 * Create a session with library defaults (GFM autolinks/alerts OFF, raw HTML
 * escaped, block data off). Free with flux_session_free. Returns NULL on failure.
 */
FluxSession *flux_session_new(void);

/*
 * Create a session from a NUL-terminated UTF-8 JSON object whose keys are
 * FluxConfig's snake_case names (e.g. {"gfm_math":true,"block_data":true}).
 * Unknown keys are ignored; missing keys take defaults (autolinks/alerts ON, the
 * rest off). Returns NULL if config_json is NULL, is not valid UTF-8, or is not a
 * valid JSON object. Free with flux_session_free.
 */
FluxSession *flux_session_new_with_config(const char *config_json);

/*
 * Feed the next markdown chunk (length-based; `chunk` need NOT be NUL-terminated).
 * Invalid UTF-8 is repaired lossily (U+FFFD), not rejected. `chunk` may be NULL
 * only when len == 0. Returns a caller-owned JSON Patch string (free with
 * flux_string_free), or NULL if s is NULL, chunk is NULL with len != 0, or a panic
 * was caught.
 */
char *flux_session_append(FluxSession *s, const uint8_t *chunk, size_t len);

/*
 * End the stream: emit still-open blocks as committed. Returns a caller-owned JSON
 * Patch string (free with flux_string_free), or NULL on NULL session.
 */
char *flux_session_finalize(FluxSession *s);

/*
 * The whole parsed document (committed + active), as a caller-owned JSON Block[]
 * string (free with flux_string_free). Returns NULL on NULL session.
 */
char *flux_session_all_blocks(FluxSession *s);

/*
 * Discard parse state and start a fresh stream, preserving the session's config
 * (block ids restart from 0). No-op if s is NULL.
 */
void flux_session_reset(FluxSession *s);

/* Total bytes retained (source buffer + rendered HTML). 0 on NULL session. */
uint64_t flux_session_retained_bytes(FluxSession *s);

/* Length in bytes of the retained source buffer. 0 on NULL session. */
uint64_t flux_session_buffer_len(FluxSession *s);

/* Release a session. No-op if s is NULL. Freeing twice is undefined behavior. */
void flux_session_free(FluxSession *s);

/*
 * Free a string returned by flux_session_append / flux_session_finalize /
 * flux_session_all_blocks. No-op if ptr is NULL. Do not free twice.
 */
void flux_string_free(char *ptr);

/*
 * Wire contract version ("1.0.0"). Returns a pointer to a STATIC string — do NOT
 * free it.
 */
const char *flux_wire_version(void);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* FLUX_MD_H */
