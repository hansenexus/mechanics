/** Endpoints reachable from outside Convex. */
import { httpRouter } from "convex/server";

const http = httpRouter();

http.route({ path: "/probe-callback", method: "POST", handler: null as never });
http.route({ path: "/unsubscribe", method: "GET", handler: null as never });

export default http;
