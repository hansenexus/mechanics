import { describe, expect, test } from "vitest";
import { planDispatch } from "./docket-dispatch";
import { renderPrBody } from "./docket-forge";
import { orderYaml, parseOrder } from "./docket-order";

const BASE_INPUT = {
  title: "board follow-up",
  today: "2026-08-18",
  base: "forge/master",
  criteria: ["tests green"],
  withPush: false,
  withPr: false,
  withAgent: false,
  primaryRoot: "/tmp/primary",
};

describe("issue linking (#424 PR3)", () => {
  test("--issue lands in the order as links.issue", () => {
    const plan = planDispatch({ ...BASE_INPUT, issue: 424 });
    expect(plan.order.links).toEqual({ issue: 424 });
  });

  test("no issue means no links key at all", () => {
    const plan = planDispatch(BASE_INPUT);
    expect(plan.order.links).toBeUndefined();
    expect(orderYaml(plan.order)).not.toContain("links");
  });

  test("links survives the order.yaml round-trip through the strict schema", () => {
    const plan = planDispatch({ ...BASE_INPUT, issue: 424 });
    const yaml = orderYaml(plan.order);
    expect(yaml).toContain("issue: 424");
    const parsed = parseOrder(yaml);
    expect(parsed.links?.issue).toBe(424);
  });

  test("renderPrBody opens with Closes #N when an issue is linked", () => {
    const body = renderPrBody({
      runId: "2026-08-18-board-follow-up",
      title: "board follow-up",
      criteria: ["tests green"],
      closesIssue: 424,
    });
    const lines = body.split("\n");
    expect(lines[0]).toBe("board follow-up");
    expect(lines[2]).toBe("Closes #424");
    expect(body).toContain("- [ ] tests green");
  });

  test("renderPrBody without an issue has no Closes line", () => {
    const body = renderPrBody({
      runId: "2026-08-18-x",
      title: "x",
      criteria: [],
    });
    expect(body).not.toContain("Closes #");
  });
});
