// The first script of every page the HTML preview server hands out (B29,
// html_preview.rs puts it in front of the page's own). It runs before any
// script of the model's page.
//
// Why: WebView2 (Windows) puts Tauri's init scripts into every frame, the
// preview's too (wry: "scripts are always added to subframes regardless of
// the `for_main_frame_only` option"). Tauri defines `__TAURI_INTERNALS__` and
// its functions non-configurable there, so no script can take them away.
// What a page could do with them: replace `Headers` or `Headers.prototype.set`
// and call `invoke`. Tauri's IPC then hands the app's invoke key to
// `headers.set('Tauri-Invoke-Key', key)`, that is to the page.
//
// So this script:
//  * deletes the Tauri globals wherever they can be deleted;
//  * puts a `Headers` on the window that no page can replace or hook, whose
//    `set` and `append` refuse the invoke key's header before the value goes
//    anywhere. Tauri's IPC throws there, so the key never leaves its closure,
//    and the fallback path (`window.ipc.postMessage`) is never reached.
// Everything it calls later is taken now, before the page can change it.
// The app's own window is never touched: the script does nothing in a top
// frame, and the preview page is only ever shown in a frame.
;(function () {
  if (window === window.top) return
  var names = ['__TAURI_INTERNALS__', '__TAURI__', '__TAURI_EVENT_PLUGIN_INTERNALS__', '__TAURI_IPC__', '__TAURI_METADATA__', 'isTauri']
  for (var i = 0; i < names.length; i++) {
    try { delete window[names[i]] } catch (e) { /* not configurable */ }
  }
  var Real = window.Headers
  if (typeof Real !== 'function') return
  var apply = Reflect.apply
  var define = Object.defineProperty
  var lower = String.prototype.toLowerCase
  var Str = String
  var Err = TypeError
  var realSet = Real.prototype.set
  var realAppend = Real.prototype.append
  var KEY = 'tauri-invoke-key'
  function refused(name) {
    return apply(lower, Str(name), []) === KEY
  }
  function SafeHeaders(init) {
    var h = new Real(init)
    define(h, 'set', {
      value: function (name, value) {
        if (refused(name)) throw new Err('No app access from the preview')
        return apply(realSet, h, [name, value])
      },
    })
    define(h, 'append', {
      value: function (name, value) {
        if (refused(name)) throw new Err('No app access from the preview')
        return apply(realAppend, h, [name, value])
      },
    })
    return h
  }
  SafeHeaders.prototype = Real.prototype
  define(window, 'Headers', { value: SafeHeaders, writable: false, configurable: false, enumerable: false })
})()
