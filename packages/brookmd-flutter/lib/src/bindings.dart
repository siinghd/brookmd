// Hand-written dart:ffi bindings for the brookmd C ABI (crates/brookmd-cabi,
// header crates/brookmd-cabi/include/brook_md.h). Kept deliberately tiny — the C
// surface is 11 functions — so there is no ffigen build-time dependency to carry.
//
// The symbol names below MUST match include/brook_md.h exactly (the Rust crate's
// `symbol_drift` test tripwires the header against the compiled library; this file
// is the third leg — keep it in lockstep). This module is pure Dart + dart:ffi so
// it can be exercised off-device once a host build of the library is available.

import 'dart:ffi' as ffi;

/// Opaque native `BrookSession` handle (see include/brook_md.h,
/// `typedef struct BrookSession BrookSession;`). Never constructed in Dart; only
/// held as a `Pointer<BrookSessionHandle>`. The public wrapper is `BrookSession` in
/// `../brook_md.dart`.
final class BrookSessionHandle extends ffi.Opaque {}

// ── Native (C) / Dart signature pairs, one per exported function ──────────────
typedef _NewNative = ffi.Pointer<BrookSessionHandle> Function();
typedef _NewDart = ffi.Pointer<BrookSessionHandle> Function();

typedef _NewWithConfigNative = ffi.Pointer<BrookSessionHandle> Function(
  ffi.Pointer<ffi.Char> configJson,
);
typedef _NewWithConfigDart = ffi.Pointer<BrookSessionHandle> Function(
  ffi.Pointer<ffi.Char> configJson,
);

typedef _AppendNative = ffi.Pointer<ffi.Char> Function(
  ffi.Pointer<BrookSessionHandle> s,
  ffi.Pointer<ffi.Uint8> chunk,
  ffi.Size len,
);
typedef _AppendDart = ffi.Pointer<ffi.Char> Function(
  ffi.Pointer<BrookSessionHandle> s,
  ffi.Pointer<ffi.Uint8> chunk,
  int len,
);

typedef _StrRetNative = ffi.Pointer<ffi.Char> Function(ffi.Pointer<BrookSessionHandle> s);
typedef _StrRetDart = ffi.Pointer<ffi.Char> Function(ffi.Pointer<BrookSessionHandle> s);

typedef _ResetNative = ffi.Void Function(ffi.Pointer<BrookSessionHandle> s);
typedef _ResetDart = void Function(ffi.Pointer<BrookSessionHandle> s);

typedef _U64Native = ffi.Uint64 Function(ffi.Pointer<BrookSessionHandle> s);
typedef _U64Dart = int Function(ffi.Pointer<BrookSessionHandle> s);

typedef _FreeNative = ffi.Void Function(ffi.Pointer<BrookSessionHandle> s);
typedef _FreeDart = void Function(ffi.Pointer<BrookSessionHandle> s);

typedef _StringFreeNative = ffi.Void Function(ffi.Pointer<ffi.Char> ptr);
typedef _StringFreeDart = void Function(ffi.Pointer<ffi.Char> ptr);

typedef _VersionNative = ffi.Pointer<ffi.Char> Function();
typedef _VersionDart = ffi.Pointer<ffi.Char> Function();

/// Resolved function pointers for the brookmd C ABI, looked up from a loaded
/// [ffi.DynamicLibrary]. One instance is shared across all sessions.
class BrookBindings {
  BrookBindings(ffi.DynamicLibrary lib)
      : sessionNew = lib.lookupFunction<_NewNative, _NewDart>('brook_session_new'),
        sessionNewWithConfig = lib.lookupFunction<_NewWithConfigNative, _NewWithConfigDart>(
          'brook_session_new_with_config',
        ),
        sessionAppend = lib.lookupFunction<_AppendNative, _AppendDart>('brook_session_append'),
        sessionFinalize =
            lib.lookupFunction<_StrRetNative, _StrRetDart>('brook_session_finalize'),
        sessionAllBlocks =
            lib.lookupFunction<_StrRetNative, _StrRetDart>('brook_session_all_blocks'),
        sessionReset = lib.lookupFunction<_ResetNative, _ResetDart>('brook_session_reset'),
        sessionRetainedBytes =
            lib.lookupFunction<_U64Native, _U64Dart>('brook_session_retained_bytes'),
        sessionBufferLen = lib.lookupFunction<_U64Native, _U64Dart>('brook_session_buffer_len'),
        sessionFree = lib.lookupFunction<_FreeNative, _FreeDart>('brook_session_free'),
        stringFree = lib.lookupFunction<_StringFreeNative, _StringFreeDart>('brook_string_free'),
        wireVersion = lib.lookupFunction<_VersionNative, _VersionDart>('brook_wire_version');

  final ffi.Pointer<BrookSessionHandle> Function() sessionNew;
  final ffi.Pointer<BrookSessionHandle> Function(ffi.Pointer<ffi.Char> configJson)
      sessionNewWithConfig;
  final ffi.Pointer<ffi.Char> Function(
    ffi.Pointer<BrookSessionHandle> s,
    ffi.Pointer<ffi.Uint8> chunk,
    int len,
  ) sessionAppend;
  final ffi.Pointer<ffi.Char> Function(ffi.Pointer<BrookSessionHandle> s) sessionFinalize;
  final ffi.Pointer<ffi.Char> Function(ffi.Pointer<BrookSessionHandle> s) sessionAllBlocks;
  final void Function(ffi.Pointer<BrookSessionHandle> s) sessionReset;
  final int Function(ffi.Pointer<BrookSessionHandle> s) sessionRetainedBytes;
  final int Function(ffi.Pointer<BrookSessionHandle> s) sessionBufferLen;
  final void Function(ffi.Pointer<BrookSessionHandle> s) sessionFree;
  final void Function(ffi.Pointer<ffi.Char> ptr) stringFree;
  final ffi.Pointer<ffi.Char> Function() wireVersion;
}
