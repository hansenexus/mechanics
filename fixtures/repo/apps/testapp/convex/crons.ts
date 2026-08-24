// Fixture crons module — the scanner only reads `crons.<method>("name", …)` names.
const crons = {
  interval(_name: string, _schedule: unknown, _fn: unknown) {},
};
crons.interval("nightly-sync", { hours: 24 }, null);
export default crons;
