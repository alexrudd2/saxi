`cli.ts` starts an Express HTTP server, which serves the (compiled) client code
The UI is built in React, which stores state for some components.

Besides `/`, the Express server has 3 POST routes:
- `/plot`
- `/cancel`
- `/resume`
These are routed to one of two different places.
If `IS_WEB` is set, the WebSerial API is used.
If `IS_WEB` is not set, a second server is created. It communicates with the server using websockets.
