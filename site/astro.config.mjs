// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// The landing page at `/` is hand-written (src/pages/index.astro) and sits
// outside Starlight's route tree; Starlight owns `/docs/*` only. Starlight's
// own splash layout is generic, and the front page is the one surface where
// the design has to carry weight.
export default defineConfig({
  site: "https://mechanics.hansenexus.dev",
  integrations: [
    starlight({
      title: "mechanics",
      description:
        "Behaviour specs with a coverage ratchet. Every surface the app ships is claimed by a documented behaviour, or it is a named gap the build fails on.",
      logo: { src: "./src/assets/mark.svg", replacesTitle: false },
      favicon: "/favicon.svg",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/hansenexus/mechanics" },
        { icon: "npm", label: "npm", href: "https://www.npmjs.com/package/@hansenexus/mechanics" },
      ],
      editLink: {
        baseUrl: "https://github.com/hansenexus/mechanics/edit/main/site/",
      },
      customCss: ["./src/styles/tokens.css", "./src/styles/docs.css"],
      sidebar: [
        {
          label: "Start",
          items: [
            { label: "Getting started", slug: "getting-started" },
            { label: "Concepts", slug: "concepts" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI", slug: "cli" },
            { label: "Configuration", slug: "configuration" },
            { label: "Adapters", slug: "adapters" },
          ],
        },
        {
          label: "Agents",
          items: [
            { label: "MCP server", slug: "mcp" },
            { label: "Claude Code plugin", slug: "plugin" },
            { label: "Agent providers", slug: "agents" },
            { label: "docket/1", slug: "docket" },
          ],
        },
        {
          label: "Practice",
          items: [
            { label: "CI setup", slug: "ci" },
            { label: "Example: perch", slug: "example-perch" },
          ],
        },
      ],
      components: {
        // Starlight's default footer carries "Built with Starlight"; the
        // repo's own footer line is more useful to a reader here.
        Footer: "./src/components/DocsFooter.astro",
      },
      pagefind: true,
    }),
  ],
});
