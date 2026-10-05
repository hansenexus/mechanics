// Helpers are not a public surface even when they use a wrapper builder.
declare function spaceQuery(def: unknown): unknown;

export const helper = spaceQuery({});
