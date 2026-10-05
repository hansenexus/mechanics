// Fixture Convex module — public functions come from wrapper builders, the
// way an app that authorizes every handler in one place writes them.
declare function spaceQuery(def: unknown): unknown;
declare function internalQuery(def: unknown): unknown;

export const get = spaceQuery({});
export const sweep = internalQuery({});
