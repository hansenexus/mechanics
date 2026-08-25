/** Scheduled work. Names here are the surface: they are what mechanics claim. */
import { cronJobs } from "convex/server";

const crons = cronJobs();

crons.interval("run due checks", { seconds: 30 }, "internal.probe.runDue" as never);
crons.daily(
  "prune old check results",
  { hourUTC: 3, minuteUTC: 0 },
  "internal.checks.prune" as never
);
crons.daily(
  "send daily digest",
  { hourUTC: 7, minuteUTC: 0 },
  "internal.digest.send" as never
);

export default crons;
