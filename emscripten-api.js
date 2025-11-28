/*
 * Pure JS implementation of the required bits of Emscripten's API (a copy and
 * paste where possible).
 *
 * Functions expect a HEAPU32 and HEAP32 in scope.
 */

// assert.h

export function assert(val) {
	console.assert(val);
}

// emscripten/emscripten.h

export function emscripten_get_now() {
	if (globalThis.performance) {
		return performance.timeOrigin + performance.now();
	} else {
		return Date.now();
	}
}

// emscripten/console.h

export function emscripten_out(str) {
	console.log("%s", str);
}

export var emscripten_outf = console.log;

// emscripten/atomic.h

export function emscripten_atomic_cas_u32(addr, cmpVal, newVal) {
	return Atomics.compareExchange(HEAPU32, addr >> 2, cmpVal, newVal);
}

export function emscripten_atomic_load_u32(addr) {
	return Atomics.load(HEAPU32, addr >> 2);
}

export function emscripten_atomic_store_u32(addr, val) {
	return Atomics.store(HEAPU32, addr >> 2, val);
}

// emscripten/wasm_worker.h

export function emscripten_lock_init(addr) {
	Atomics.store(HEAPU32, addr >> 2, /*EMSCRIPTEN_LOCK_T_STATIC_INITIALIZER*/ 0);
}

export function emscripten_lock_busyspin_wait_acquire(addr, maxWaitMilliseconds) {
	var val = emscripten_atomic_cas_u32(addr, 0, 1);
	if (!val) return 1;

	var t = emscripten_get_now();
	var waitEnd = t + maxWaitMilliseconds;
	while (t < waitEnd) {
		val = emscripten_atomic_cas_u32(addr, 0, 1);
		if (!val) return 1;
		t = emscripten_get_now();
	}
	return 0;
}

export function emscripten_lock_try_acquire(addr) {
	var val = emscripten_atomic_cas_u32(addr, 0, 1);
	return (!val) ? 1 : 0;
}

export function emscripten_lock_release(addr) {
	Atomics.store(HEAPU32, addr >> 2, 0);
	Atomics.notify(HEAP32, addr >> 2, 1); //<-- left as-is, even though we're spinning not waiting
}

// emscripten/eventloop.h

export function emscripten_set_timeout_loop(cb, msecs, userData) {
	function tick() {
		var t = emscripten_get_now();
		var n = t + msecs;
		if (cb(t, userData)) {
			var remaining = n - emscripten_get_now();
			setTimeout(tick, remaining);
		}
	}
	return setTimeout(tick, 0);
}

// emscripten/webaudio.h

export function emscripten_current_thread_is_audio_worklet() {
	try {
		return (globalThis instanceof AudioWorkletGlobalScope) ? 1 : 0;
	} catch(e) {
		return 0;
	}
}

// pthread/threading_internal.h

export function _emscripten_thread_supports_atomics_wait() {
	// Something like this should give the same result...
	const testIdx = HEAP32.length - 1;
	try {
		Atomics.wait(HEAP32, testIdx, HEAP32(testIdx) ^ 0xCACAFACE, 0);
	} catch(e) {
		return 0;
	}
	return 1;
}

// From Xplat glue, not Emscripten:

export const Browser = {
	"BROWSER_UNKNOWN": 0, // Unknown or unable to determine
	"BROWSER_FIREFOX": 1, // Firefox (plus Firefox-derived, such as Iceweasel)
	"BROWSER_CHROME" : 2, // Chrome (desktop, Chromebook and mobile, plus Chrome-derived, such as Opera)
	"BROWSER_SAFARI" : 3, // Safari (desktop and mobile)
	"BROWSER_IE"     : 4, // IE11 (and earlier if WebGL is not required)
	"BROWSER_EDGE"   : 5, // Edge (the original pre-2019 legacy Edge)
};

export function getBrowser() {
	// Copy and paste, we only want Chrome but this works on order
	if (globalThis.navigator || globalThis.userAgent) {
		var ua = String(globalThis.navigator ? navigator.userAgent : userAgent);
		if (/Firefox\/\d+\.\d+/.test(ua)) {
			return Browser.BROWSER_FIREFOX;
		} else {
			if (/Edge\/\d+\.\d+/.test(ua)) {
				return Browser.BROWSER_EDGE;
			} else {
				if (/^((?!Chrome).)*Safari\/\d+\.\d+/.test(ua)) {
					return Browser.BROWSER_SAFARI;
				} else {
					if (/Chrome\/\d+\.\d+/.test(ua)) {
						return Browser.BROWSER_CHROME;
					} else {
						if (/Trident\/\d+\.\d+/.test(ua)) {
							return Browser.BROWSER_IE;
						}
					}
				}
			}
		}
	}
	return Browser.BROWSER_UNKNOWN;
}
