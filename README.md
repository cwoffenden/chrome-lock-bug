# Chrome Lock Bug Minimal Example

Result: this test is triggering intentional behaviour in how Chrome treats timeouts. Code left here for future reference (the pure JS Emscripten API may come in handy).

Pure JavaScript version [here](//wip.numfum.com/cw/2025-11-27/lock-bug-main.html). The results are shown in the browser's console.

This is a port of the C version to pure JS, following as closely the original version as possible.

To run locally:
```
clone https://github.com/cwoffenden/chrome-lock-bug
cd chrome-lock-bug
./cors-server.py
```
Open `localhost:8000` in Chrome.

Emscripten compiled version [here](//wip.numfum.com/cw/2025-11-27/lock-bug-c.html).

Having already cloned the repo:
```
emcc -sAUDIO_WORKLET -sWASM_WORKERS -sNO_EXIT_RUNTIME --shell-file=shell.html -pthread -O1 -g -o lock-bug-c.html lock-bug.c
emrun --browser chrome lock-bug-c.html
```
