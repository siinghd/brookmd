// Hand-written dart:ffi bindings for the flux-md C ABI (crates/flux-md-cabi,
// header crates/flux-md-cabi/include/flux_md.h). Kept deliberately tiny — the C
// surface is 11 functions — so there is no ffigen build-time dependency to carry.
//
// The symbol names below MUST match include/flux_md.h exactly (the Rust crate's
// `symbol_drift` test tripwires the header against the compiled library; this file
// is the third leg — keep it in lockstep). This module is pure Dart + dart:ffi so
// it can be exercised off-device once a host build of the library is available.

import 'dart:ffi' as ffi;

/// Opaque native `FluxSession` handle (see include/flux_md.h,
/// `typedef struct FluxSession FluxSession;`). Never constructed in Dart; only
/// held as a `Pointer<FluxSessionHandle>`. The public wrapper is `FluxSession` in
/// `../flux_md.dart`.
final class FluxSessionHandle extends ffi.Opaque {}

// ── Native (C) / Dart signature pairs, one per exported function ──────────────
typedef _NewNative = ffi.Pointer<FluxSessionHandle> Function();
typedef _NewDart = ffi.Pointer<FluxSessionHandle> Function();

typedef _NewWithConfigNative = ffi.Pointer<FluxSessionHandle> Function(
  ffi.Pointer<ffi.Char> configJson,
);
typedef _NewWithConfigDart = ffi.Pointer<FluxSessionHandle> Function(
  ffi.Pointer<ffi.Char> configJson,
);

typedef _AppendNative = ffi.Pointer<ffi.Char> Function(
  ffi.Pointer<FluxSessionHandle> s,
  ffi.Pointer<ffi.Uint8> chunk,
  ffi.Size len,
);
typedef _AppendDart = ffi.Pointer<ffi.Char> Function(
  ffi.Pointer<FluxSessionHandle> s,
  ffi.Pointer<ffi.Uint8> chunk,
  int len,
);

typedef _StrRetNative = ffi.Pointer<ffi.Char> Function(ffi.Pointer<FluxSessionHandle> s);
typedef _StrRetDart = ffi.Pointer<ffi.Char> Function(ffi.Pointer<FluxSessionHandle> s);

typedef _ResetNative = ffi.Void Function(ffi.Pointer<FluxSessionHandle> s);
typedef _ResetDart = void Function(ffi.Pointer<FluxSessionHandle> s);

typedef _U64Native = ffi.Uint64 Function(ffi.Pointer<FluxSessionHandle> s);
typedef _U64Dart = int Function(ffi.Pointer<FluxSessionHandle> s);

typedef _FreeNative = ffi.Void Function(ffi.Pointer<FluxSessionHandle> s);
typedef _FreeDart = void Function(ffi.Pointer<FluxSessionHandle> s);

typedef _StringFreeNative = ffi.Void Function(ffi.Pointer<ffi.Char> ptr);
typedef _StringFreeDart = void Function(ffi.Pointer<ffi.Char> ptr);

typedef _VersionNative = ffi.Pointer<ffi.Char> Function();
typedef _VersionDart = ffi.Pointer<ffi.Char> Function();

/// Resolved function pointers for the flux-md C ABI, looked up from a loaded
/// [ffi.DynamicLibrary]. One instance is shared across all sessions.
class FluxBindings {
  FluxBindings(ffi.DynamicLibrary lib)
      : sessionNew = lib.lookupFunction<_NewNative, _NewDart>('flux_session_new'),
        sessionNewWithConfig = lib.lookupFunction<_NewWithConfigNative, _NewWithConfigDart>(
          'flux_session_new_with_config',
        ),
        sessionAppend = lib.lookupFunction<_AppendNative, _AppendDart>('flux_session_append'),
        sessionFinalize =
            lib.lookupFunction<_StrRetNative, _StrRetDart>('flux_session_finalize'),
        sessionAllBlocks =
            lib.lookupFunction<_StrRetNative, _StrRetDart>('flux_session_all_blocks'),
        sessionReset = lib.lookupFunction<_ResetNative, _ResetDart>('flux_session_reset'),
        sessionRetainedBytes =
            lib.lookupFunction<_U64Native, _U64Dart>('flux_session_retained_bytes'),
        sessionBufferLen = lib.lookupFunction<_U64Native, _U64Dart>('flux_session_buffer_len'),
        sessionFree = lib.lookupFunction<_FreeNative, _FreeDart>('flux_session_free'),
        stringFree = lib.lookupFunction<_StringFreeNative, _StringFreeDart>('flux_string_free'),
        wireVersion = lib.lookupFunction<_VersionNative, _VersionDart>('flux_wire_version');

  final ffi.Pointer<FluxSessionHandle> Function() sessionNew;
  final ffi.Pointer<FluxSessionHandle> Function(ffi.Pointer<ffi.Char> configJson)
      sessionNewWithConfig;
  final ffi.Pointer<ffi.Char> Function(
    ffi.Pointer<FluxSessionHandle> s,
    ffi.Pointer<ffi.Uint8> chunk,
    int len,
  ) sessionAppend;
  final ffi.Pointer<ffi.Char> Function(ffi.Pointer<FluxSessionHandle> s) sessionFinalize;
  final ffi.Pointer<ffi.Char> Function(ffi.Pointer<FluxSessionHandle> s) sessionAllBlocks;
  final void Function(ffi.Pointer<FluxSessionHandle> s) sessionReset;
  final int Function(ffi.Pointer<FluxSessionHandle> s) sessionRetainedBytes;
  final int Function(ffi.Pointer<FluxSessionHandle> s) sessionBufferLen;
  final void Function(ffi.Pointer<FluxSessionHandle> s) sessionFree;
  final void Function(ffi.Pointer<ffi.Char> ptr) stringFree;
  final ffi.Pointer<ffi.Char> Function() wireVersion;
}
