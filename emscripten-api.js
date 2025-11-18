/*
 * Pure JS implementation of the required bits of Emscripten's API.
 *
 * Functions expect a HEAPU32 in scope.
 */

export function assert(val) {
	console.assert(val);
	if (!val) {
		console.trace();
	}
}

export function emscripten_get_now() {
	if (globalThis.performance) {
		return performance.timeOrigin + performance.now();
	} else {
		return Date.now();
	}
}

export function emscripten_atomic_cas_u32(addr, cmpVal, newVal) {
	return Atomics.compareExchange(HEAPU32, addr >> 2, cmpVal, newVal);
}

export function emscripten_lock_init(addr) {
	Atomics.store(HEAPU32, addr >> 2, /*EMSCRIPTEN_LOCK_T_STATIC_INITIALIZER*/ 0);
}

export function emscripten_lock_busyspin_wait_acquire(addr, maxWaitMilliseconds) {
	var val = emscripten_atomic_cas_u32(addr, 0, 1);
	if (!val) return true;

	var t = emscripten_get_now();
	var waitEnd = t + maxWaitMilliseconds;
	while (t < waitEnd) {
		val = emscripten_atomic_cas_u32(addr, 0, 1);
		if (!val) return true;
		t = emscripten_get_now();
	}
	return false;
}

export function emscripten_lock_try_acquire(addr) {
	var val = emscripten_atomic_cas_u32(addr, 0, 1);
	return !val;
}

export function emscripten_lock_release(addr) {
	Atomics.store(HEAPU32, addr >> 2, 0);
	Atomics.notify(HEAPU32, addr >> 2, 1); //<-- left as-is, even though we're spinning not waiting
}
