/** Codegen stand-in so the example reads like a real Convex app. */
type Handler = (...args: never[]) => unknown;
export const query = (h: Handler) => h;
export const mutation = (h: Handler) => h;
export const action = (h: Handler) => h;
