/** Incident lifecycle, from detection through resolution. */

// @mechanic perch.incidents.list-incidents
export async function sortsOpenIncidentsFirst() {}

// @mechanic perch.incidents.inspect-incident
export async function rendersTheTimelineInOrder() {}

// @mechanic perch.incidents.acknowledge-incident
export async function acknowledgingStopsEscalation() {}

// @mechanic perch.incidents.acknowledge-incident perch.incidents.notify-on-incident
export async function acknowledgingFromANotificationLink() {}

// @mechanic perch.incidents.post-incident-update
export async function internalUpdatesStayOffThePublicPage() {}
