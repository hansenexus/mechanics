/**
 * How a spec links to a mechanic: an annotation comment. It works in every
 * harness — plain scripts, vitest, Playwright — because it is just a comment.
 *
 *   // @mechanic <id> [<id> …]
 *
 * Playwright users can instead lead the describe title with the id, which
 * additionally makes `--grep` scope a run to a single mechanic. That form is
 * shown in the reference docs rather than here on purpose: a spec file is
 * scanned for BOTH forms, so writing an example describe call in a comment
 * would register a second, identical link.
 *
 * Either way the link is DISCOVERED. Nothing is declared in frontmatter, so a
 * spec and its mechanic cannot drift apart in one direction only.
 */

// @mechanic example.backups.create-snapshot example.backups.inspect-status

export {};
