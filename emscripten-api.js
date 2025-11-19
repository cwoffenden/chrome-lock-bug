/*
 * Pure JS implementation of the required bits of Emscripten's API (a copy and
 * paste where possible).
 *
 * Functions expect a HEAPU32 and HEAP32 in scope.
 */

// assert.h

export function assert(val) {
	console.assert(val);
	if (!val) {
		console.trace();
	}
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
