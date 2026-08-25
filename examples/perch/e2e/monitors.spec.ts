/**
 * Monitor lifecycle. The `@mechanic` annotations are the only link between a
 * spec and the behaviour it covers — nothing is declared in frontmatter, so a
 * renamed mechanic surfaces as a lost link rather than as a stale one.
 */

// @mechanic perch.monitors.create-monitor
export async function createsAMonitor() {}

// @mechanic perch.monitors.create-monitor
export async function rejectsADuplicateUrl() {}

// @mechanic perch.monitors.edit-monitor
export async function keepsHistoryAcrossAUrlChange() {}

// @mechanic perch.monitors.pause-monitor
export async function excludesPausedSpansFromUptime() {}

// @mechanic perch.monitors.delete-monitor
export async function requiresTypedConfirmation() {}

// @mechanic perch.monitors.list-monitors
export async function sortsFailingMonitorsFirst() {}

// @mechanic perch.monitors.inspect-monitor
export async function showsUptimeOverThreeWindows() {}
