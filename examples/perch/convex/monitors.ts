/** Monitors: the checks a workspace runs against its own endpoints. */
import { mutation, query } from "./_generated/server";

export const list = query(async () => []);
export const get = query(async () => null);
export const create = mutation(async () => null);
export const update = mutation(async () => null);
export const pause = mutation(async () => null);
export const remove = mutation(async () => null);

/** Not claimed by any mechanic yet — the corpus has a gap here on purpose. */
export const exportCsv = query(async () => "");
