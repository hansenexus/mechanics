---
title: MCP server
description: Serve the corpus to an agent over stdio — five read tools, and no write tools by construction.
---

```bash
mechanics mcp
```

Serves the behaviour corpus to any MCP client over stdio. `mechanics init`
writes the `.mcp.json` registration for you unless you pass `--no-mcp`.

## The tools

| Tool | Returns |
|---|---|
| `mechanics_list` | the behaviours in an app, filterable |
| `mechanics_get` | one behaviour in full — frontmatter, ACs, body |
| `mechanics_coverage` | the coverage table and every named gap |
| `mechanics_wave_status` | a wave's verdicts and rollup |
| `mechanics_impact` | changed files → the behaviours that claim them |

## Read-only, and that is enforced

There are no write tools, and a test asserts that no write-shaped tool name is
advertised. This is not a configuration setting or a default — it is a property
of the server that the suite fails on if it changes.

An agent reading the corpus can answer *what is this app supposed to do?* and
*what does this diff touch?* It cannot record a verdict, close a gap, or edit a
wave. Verdicts go through `mechanics verify`, which runs the specs, or
`verify --set`, which is a deliberate human action.

Agents that should be able to *change* the tree get there through
[agent providers](/agents/) instead, which have file access but are refused the
same four moves.

## Registering it by hand

```json
{
  "mcpServers": {
    "mechanics": {
      "command": "npx",
      "args": ["mechanics", "mcp"]
    }
  }
}
```

Under Bun, `"command": "bunx"` with the same arguments.
