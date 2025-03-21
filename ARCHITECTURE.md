`cli.ts` starts a Node HTTP server, which serves the (compiled) client code
This Node server includes a WebSocketServer, which responds to commands from the client
It also includes a `serve-static` server, which serves static components.

If `npm run dev` is used, `esbuild` in `build.mjs` serves the static components instead.

The UI is built in React, which stores state for some components.

The Node HTTP server has 4 POST routes:
- `/plot`
- `/cancel`
- `/pause`
- `/resume`
These are routed to one of two different places.
If `IS_WEB` is set, the WebSerial API is used.
If `IS_WEB` is not set, the Node HTTP and WebSocketServer servers are used
