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
      // Code blocks stay on the dark ground in BOTH site themes. Every code
      // sample here is a terminal session or a file you would read in an
      // editor, and the screenshots in `docs/images/` are dark whatever the
      // reader's system says — a light block beside a dark screenshot reads as
      // two different products. Set through Expressive Code's own options
      // rather than by overriding its markup, which would break on a minor.
      expressiveCode: {
        themes: ["github-dark"],
        styleOverrides: {
          borderRadius: "10px",
          borderColor: "#2a2d32",
          codeBackground: "#191b1e",
          codeFontFamily: 'var(--font-mono)',
          frames: {
            editorActiveTabBackground: "#191b1e",
            editorActiveTabIndicatorBottomColor: "#37b99f",
            editorTabBarBackground: "#101014",
            editorTabBarBorderBottomColor: "#2a2d32",
            terminalBackground: "#191b1e",
            terminalTitlebarBackground: "#101014",
            terminalTitlebarBorderBottomColor: "#2a2d32",
          },
        },
      },
      // Starlight has no font option, so the Slate faces are injected as head
      // tags. Both stacks in tokens.css end in the system fonts, so a blocked
      // request costs the docs their typography and nothing else.
      head: [
        { tag: "link", attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" } },
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: true },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap",
          },
        },
      ],
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
