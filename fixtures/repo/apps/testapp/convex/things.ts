// Fixture Convex module — the scanner only reads export shapes.
declare function query(def: unknown): unknown;
declare function mutation(def: unknown): unknown;
declare function internalMutation(def: unknown): unknown;

export const list = query({});
export const sync = mutation({});
export const seedThings = mutation({});
export const hidden = internalMutation({});
