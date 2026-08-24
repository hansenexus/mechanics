/**
 * Forge adapters — the one place that knows how a given host spells "draft".
 *
 * Forgejo and Gitea have no draft flag on the create-PR API; a pull request is
 * a draft when its title carries a WIP prefix. GitHub has a real boolean. That
 * difference is exactly the kind of thing that leaks into call sites and rots,
 * so it lives behind `openDraftPr` and nowhere else.
 *
 * Tokens are read from the environment at call time and never written to
 * `order.yaml`, the event log, or any error message. A run directory is
 * committed to the repository; a token that reached it would be published.
 */

export type ForgeKind = "forgejo" | "github";

export type Remote = { host: string; owner: string; repo: string };

export type PullRequest = { number: number; url: string };

export type ForgeAdapter = {
  kind: ForgeKind;
  remote: Remote;
  openDraftPr(input: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<PullRequest>;
};

/**
 * Parse the shapes git actually produces: scp-like (`git@host:owner/repo.git`),
 * ssh:// with an optional port, and https with an optional userinfo part.
 */
export function parseRemote(url: string): Remote | null {
  const trimmed = url.trim().replace(/\.git$/, "");

  const scp = trimmed.match(/^(?:[^@]+@)?([^:/]+):([^/]+)\/(.+)$/);
  if (scp && !trimmed.includes("://")) {
    const [, host, owner, repo] = scp;
    return host && owner && repo ? { host, owner, repo } : null;
  }

  try {
    const parsed = new URL(trimmed);
    const parts = parsed.pathname.replace(/^\//, "").split("/");
    if (parts.length < 2) return null;
    const repo = parts.pop();
    const owner = parts.pop();
    return repo && owner && parsed.hostname ? { host: parsed.hostname, owner, repo } : null;
  } catch {
    return null;
  }
}

/** Everything but github.com is assumed to be a Forgejo/Gitea instance — the
 * self-hosted case is the common one here, so it is the default rather than
 * the exception. */
export function forgeKindFor(remote: Remote): ForgeKind {
  return remote.host === "github.com" ? "github" : "forgejo";
}

/**
 * Render the PR body: the goal, then the exit criteria as a checklist.
 *
 * The checklist is the point. A reviewer who has never heard of this tool
 * still sees what "done" means for the change in front of them, and the list
 * is the same one the board is scoring — so the PR cannot quietly disagree
 * with the run.
 */
export function renderPrBody(input: {
  runId: string;
  title: string;
  criteria: string[];
  met?: Set<string>;
  /**
   * Issue this run exists to close (#424 PR3). `Closes #N` sits at the top of
   * the body so the forge auto-closes the issue on merge — Forgejo does NOT
   * close issues from squash-commit messages, only from PR bodies, which is
   * why it lives here and not in the commit.
   */
  closesIssue?: number;
}): string {
  const lines = [input.title, ""];
  if (input.closesIssue !== undefined) lines.push(`Closes #${input.closesIssue}`, "");
  lines.push("## Exit criteria", "");
  if (input.criteria.length === 0) {
    lines.push("_None declared yet._");
  } else {
    for (const c of input.criteria) {
      lines.push(`- [${input.met?.has(c) ? "x" : " "}] ${c}`);
    }
  }
  lines.push(
    "",
    "---",
    "",
    `Tracked as docket run \`${input.runId}\` — \`bun mechanics run show --run=${input.runId}\`.`
  );
  return lines.join("\n");
}

const WIP_PREFIX = "WIP: ";

function tokenFor(kind: ForgeKind): string {
  const name = kind === "github" ? "GITHUB_TOKEN" : "FORGEJO_TOKEN";
  const token = process.env[name];
  if (!token) {
    throw new Error(
      `docket: ${name} is not set. Export it for this command only, e.g.\n` +
        `  ${name}=$(op item get <item> --fields credential) bun mechanics run dispatch …`
    );
  }
  return token;
}

export function createForgeAdapter(remote: Remote, kind = forgeKindFor(remote)): ForgeAdapter {
  const base = `https://${remote.host}`;
  return {
    kind,
    remote,
    async openDraftPr({ title, body, head, base: target }) {
      const token = tokenFor(kind);
      // Forgejo/Gitea: draft is the WIP title prefix. GitHub: a real field.
      const payload =
        kind === "github"
          ? { title, body, head, base: target, draft: true }
          : {
              title: title.startsWith(WIP_PREFIX) ? title : WIP_PREFIX + title,
              body,
              head,
              base: target,
            };
      const api =
        kind === "github"
          ? `https://api.github.com/repos/${remote.owner}/${remote.repo}/pulls`
          : `${base}/api/v1/repos/${remote.owner}/${remote.repo}/pulls`;

      const res = await fetch(api, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: kind === "github" ? `Bearer ${token}` : `token ${token}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        // The response body can echo the request; never let it near a log
        // that might carry the Authorization header's value.
        throw new Error(`docket: ${kind} refused the pull request (HTTP ${res.status})`);
      }
      const json = (await res.json()) as { number?: number; html_url?: string };
      if (typeof json.number !== "number") {
        throw new Error(`docket: ${kind} returned no pull-request number`);
      }
      return {
        number: json.number,
        url: json.html_url ?? `${base}/${remote.owner}/${remote.repo}`,
      };
    },
  };
}
