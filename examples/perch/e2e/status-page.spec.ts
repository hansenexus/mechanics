/** The public page and its subscribers. */

// @mechanic perch.status-page.view-public-status
export async function rendersWithoutSignIn() {}

// @mechanic perch.status-page.view-public-status
export async function servesStaleRatherThanErroring() {}

// @mechanic perch.status-page.subscribe-to-updates
export async function doesNotRevealExistingSubscribers() {}

// @mechanic perch.status-page.confirm-subscription
export async function replayingAConfirmationIsIdempotent() {}

// @mechanic perch.status-page.unsubscribe
export async function oneClickUnsubscribeNeedsNoSignIn() {}

// @mechanic perch.status-page.customise-branding
export async function warnsOnFailingContrast() {}
