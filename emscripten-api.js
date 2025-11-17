/*
 * Pure JS implementation of of Emscripten's lock API.
 */

const wasmMem = new SharedArrayBuffer(1024);
const HEAPU32 = new Uint32Array(wasmMem);

function emscripten_atomic_cas_u32(addr, cmpVal, newVal) {
	return Atomics.compareExchange(HEAPU32, addr >> 2, cmpVal, newVal);
}

function emscripten_get_now() {
	if (globalThis.performance) {
		return performance.timeOrigin + performance.now();
	} else {
		return Date.now();
	}
}

function emscripten_lock_init(addr) {
	Atomics.store(HEAPU32, addr >> 2, /*EMSCRIPTEN_LOCK_T_STATIC_INITIALIZER*/ 0);
}

function emscripten_lock_busyspin_wait_acquire(addr, maxWaitMilliseconds) {
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

function emscripten_lock_try_acquire(addr) {
	var val = emscripten_atomic_cas_u32(addr, 0, 1);
	return !val;
}
