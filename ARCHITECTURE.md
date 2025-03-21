`cli.ts` starts a Node HTTP server, which serves the (compiled) client code
It also starts a WebSocketServer, which responds to commands from the client
`esbuild` in `build.mjs` also serves the static components.

The UI is built in React, which stores state for some components.

The Node HTTP server has 3 POST routes:
- `/plot`
- `/cancel`
- `/pause`
- `/resume`
These are routed to one of two different places.
If `IS_WEB` is set, the WebSerial API is used.
If `IS_WEB` is not set, the Node HTTP and WebSocketServer servers is used
