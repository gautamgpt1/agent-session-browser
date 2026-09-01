import { expect, test } from "@playwright/test";

test("indexes fixture sessions and supports the main viewer workflows", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:4174" });
  await page.goto("/");

  const statusResponse = await page.request.get("/api/index/status");
  expect(statusResponse.headers()["x-content-type-options"]).toBe("nosniff");
  expect(statusResponse.headers()["cache-control"]).toBe("no-store");
  const remoteHost = await page.request.get("/api/index/status", { headers: { Host: "example.com:4174" } });
  expect(remoteHost.status()).toBe(403);
  const crossOrigin = await page.request.post("/api/index/refresh", { headers: { Origin: "https://example.com" } });
  expect(crossOrigin.status()).toBe(403);

  await expect(page.getByPlaceholder("Search sessions")).toBeVisible();
  await page.getByRole("button", { name: "Use dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.getByRole("button", { name: "Use light mode" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Use light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".session-card", { hasText: "Implement JSONL viewer fixture prompt" }).last()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.locator(".session-card", { hasText: "Implement JSONL viewer fixture prompt" }).last()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("5");
  await expect(page.getByText("Working directories", { exact: true })).toBeVisible();
  await expect(page.getByText("Recent sessions", { exact: true })).toBeVisible();

  await page.getByPlaceholder("Search sessions").fill("55555555-5555-4555-8555-555555555555");
  await page.getByPlaceholder("Search sessions").press("Enter");
  await expect(page.locator(".detail-pane")).toContainText("The Pi fixture inspection is complete.");
  await expect(page).toHaveURL(/#session=pi%3A55555555/);
  await page.getByRole("button", { name: "Copy resume" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("pi --session 55555555-5555-4555-8555-555555555555");
  await expect(page.getByRole("status")).toHaveText("Resume command copied");

  await page.getByRole("button", { name: "Session filters" }).click();
  await page.getByLabel("Agent").selectOption("claude");
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("1");
  await expect(page.locator(".session-card", { hasText: "Inspect the Claude fixture project" }).last()).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".session-card", { hasText: "Inspect the Claude fixture project" }).last().click();
  await expect(page.locator(".detail-pane")).toContainText("The Claude fixture inspection is complete.");
  await page.getByRole("button", { name: "Copy resume" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    "claude --resume 33333333-3333-4333-8333-333333333333"
  );

  await page.getByRole("button", { name: "Session filters" }).click();
  await page.getByLabel("Agent").selectOption("gemini");
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("1");
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".session-card", { hasText: "Inspect the Gemini fixture project" }).last().click();
  await expect(page.locator(".detail-pane")).toContainText("The Gemini fixture inspection is complete.");
  await page.getByRole("button", { name: "Copy resume" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    "gemini --resume 44444444-4444-4444-8444-444444444444"
  );

  await page.getByRole("button", { name: "Session filters" }).click();
  await page.getByLabel("Agent").selectOption("");
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("5");
  const directoryFilter = page.getByRole("combobox", { name: "Working directory" });
  await expect(directoryFilter).toBeVisible();
  await directoryFilter.fill("fixture");
  await expect(page.getByRole("option", { name: /fixture.*C:\\Projects\\fixture/i })).toBeVisible();
  await directoryFilter.press("ArrowDown");
  await directoryFilter.press("Enter");
  await expect(page).toHaveURL(/cwd=C%3A%5CProjects%5Cfixture/);
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("1");
  await page.getByRole("button", { name: "Clear working directory" }).click();
  await expect(page).not.toHaveURL(/cwd=/);
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("5");
  await directoryFilter.fill("fixture");
  await directoryFilter.press("ArrowDown");
  await directoryFilter.press("Enter");
  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByLabel("Model provider")).toHaveCount(0);
  await expect(page.getByLabel("Originator")).toHaveCount(0);
  await expect(page.getByLabel("Sort")).toHaveCount(0);
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("1");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".session-card", { hasText: "C:\\Projects\\fixture" }).last()).toBeVisible();

  await page.locator(".session-card", { hasText: "C:\\Projects\\fixture" }).last().click();
  await expect(page.getByText("Fixture assistant response").first()).toBeVisible();
  await expect(page.locator(".detail-pane .transcript-item", { hasText: "Fixture assistant response" })).toHaveCount(2);
  await expect(page.locator(".detail-pane .transcript-item", { hasText: "Implement JSONL viewer fixture prompt" })).toHaveCount(2);
  await expect(page.locator(".detail-pane")).not.toContainText("npm test");
  await expect(page.locator(".detail-pane")).not.toContainText("Future file change summary");
  await expect(page.locator(".detail-pane")).not.toContainText("task_started");
  await expect(page.locator(".detail-pane")).not.toContainText("Directory listing output");

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.locator(".filter-popover")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".filter-popover")).toHaveCount(0);
  await page.getByRole("button", { name: "Filter", exact: true }).click();

  await page.getByRole("checkbox", { name: "assistant final" }).uncheck();
  await expect(page.locator(".detail-pane")).not.toContainText("Fixture assistant response");
  await page.getByRole("checkbox", { name: "assistant final" }).check();
  await expect(page.locator(".detail-pane .transcript-item", { hasText: "Fixture assistant response" })).toHaveCount(2);

  await page.getByText("Tool / Work Items", { exact: true }).click();
  await page.getByRole("checkbox", { name: "commandExecution", exact: true }).check();
  await expect(page.locator(".detail-pane")).toContainText("npm test");
  await page.getByRole("checkbox", { name: "commandExecution", exact: true }).uncheck();
  await expect(page.locator(".detail-pane")).not.toContainText("npm test");

  await page.getByText("File Changes", { exact: true }).click();
  await page.getByRole("checkbox", { name: "fileChange", exact: true }).check();
  await expect(page.locator(".detail-pane")).toContainText("Future file change summary");

  await page.getByRole("checkbox", { name: "shell_command" }).check();
  await expect(page).toHaveURL(/tool=shell_command/);
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("5");
  await expect(page.locator(".session-card", { hasText: "C:\\Projects\\fixture" }).last()).toBeVisible();
  await expect(page.locator(".detail-pane")).toContainText("Directory listing output");

  await page.getByRole("group", { name: "Tools" }).getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "shell_command" })).toBeChecked();

  await page.getByRole("group", { name: "Tools" }).getByRole("button", { name: "None", exact: true }).click();
  await expect(page).not.toHaveURL(/tool=/);
  await expect(page.getByRole("checkbox", { name: "shell_command" })).not.toBeChecked();
  await expect(page.locator(".detail-pane")).not.toContainText("Directory listing output");

  await page.getByRole("button", { name: "Close filters" }).click();
  await expect(page.locator(".filter-popover")).toHaveCount(0);

  await page.getByRole("button", { name: "Copy session id" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    "11111111-1111-4111-8111-111111111111"
  );
  await expect(page.getByRole("status")).toHaveText("Session ID copied");
  await expect(page.locator('a[href^="codex://"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Copy resume" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(
    "codex resume 11111111-1111-4111-8111-111111111111"
  );

  await page.getByText("Export", { exact: true }).click();
  await expect(page.getByRole("link", { name: /Offline HTML/ })).toBeVisible();
  await expect(page.locator(".export-options a")).toHaveCount(3);
  const exported = await page.request.get("/api/sessions/11111111-1111-4111-8111-111111111111/export?format=html&mode=readable");
  expect(exported.ok()).toBe(true);
  expect(await exported.text()).toContain("Fixture assistant response");
  const printable = await page.request.get("/api/sessions/11111111-1111-4111-8111-111111111111/export?format=html&mode=readable&inline=true");
  expect(printable.headers()["content-disposition"]).toContain("inline");
  await page.getByText("Export", { exact: true }).click();

  await page.getByRole("button", { name: "View raw JSON" }).first().click();
  await expect(page.getByText("Raw JSON #")).toBeVisible();
  await expect(page.locator(".raw-drawer pre")).toContainText('"type": "user_message"');
  await page.keyboard.press("Escape");
  await expect(page.locator(".raw-drawer")).toHaveCount(0);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.locator(".detail-pane")).toContainText("Implement JSONL viewer fixture prompt");
  await expect(page.locator(".detail-pane")).toContainText("Fixture assistant response");
  await expect(page.locator(".detail-pane")).not.toContainText("Fixture progress update");
  await expect(page.getByRole("checkbox", { name: "assistant final" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "assistant progress" })).not.toBeChecked();

  const detailResponse = await page.request.get("/api/sessions/11111111-1111-4111-8111-111111111111");
  const mockedDetail = await detailResponse.json();
  const largeItem = {
    ...mockedDetail.turns[0].items[0],
    id: 999_999,
    role: "assistant",
    phase: "final_answer",
    envelopeType: "response_item",
    payloadType: "message",
    text: "Readable assistant preview…",
    summary: null,
    contentPreview: true
  };
  const allPagedItems = [largeItem, ...Array.from({ length: 249 }, (_, index) => ({
    ...mockedDetail.turns[0].items[0],
    id: 1_000_000 + index,
    role: "assistant",
    phase: "final_answer",
    text: `Long transcript message ${index + 1}`,
    summary: null
  }))];
  await page.route(/\/api\/sessions\/11111111-1111-4111-8111-111111111111(?:\?.*)?$/, (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset") || 0);
    const items = allPagedItems.slice(offset, offset + 100);
    return route.fulfill({
      json: {
        ...mockedDetail,
        turns: [{ ...mockedDetail.turns[0], items }],
        tools: offset === 0 ? mockedDetail.tools : [],
        loadedItemCount: items.length,
        pageOffset: offset,
        pageLimit: 100,
        totalMatchingItems: allPagedItems.length,
        totalMatchingTurns: 1,
        nextOffset: offset + items.length < allPagedItems.length ? offset + items.length : null,
        sourceVersion: "paged-fixture-v1",
        expandableRecordCount: 1
      }
    });
  });
  await page.route(/\/api\/sessions\/11111111-1111-4111-8111-111111111111\/raw\/999999$/, (route) => route.fulfill({
    json: { id: 999_999, rawJson: '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Readable full assistant response"}]}}' }
  }));
  await page.reload();

  await expect(page.getByText("1 matching record has a shortened preview to keep scrolling responsive.")).toBeVisible();
  await expect(page.locator(".detail-pane .transcript-item")).toHaveCount(100);
  await expect(page.getByText("Readable assistant preview…")).toBeVisible();
  await page.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(page.getByText("Readable original record")).toBeVisible();
  await expect(page.getByText("Readable full assistant response")).toBeVisible();
  await expect(page.locator(".raw-drawer")).toHaveCount(0);
  await page.locator(".inline-record-expansion").getByRole("button", { name: "View raw JSON", exact: true }).click();
  await expect(page.getByText("Raw JSON #999999")).toBeVisible();
  await page.getByRole("button", { name: "Close raw JSON" }).click();
  await page.getByRole("button", { name: "Collapse", exact: true }).click();
  await expect(page.getByText("Readable original record")).toHaveCount(0);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.locator(".detail-pane .transcript-item")).toHaveCount(100);
  await expect(page.getByText("Long transcript message 100")).toBeVisible();
  await expect(page.getByText("Readable assistant preview…")).toHaveCount(0);
  await page.getByLabel("Page").fill("3");
  await page.getByLabel("Page").press("Enter");
  await expect(page.locator(".detail-pane .transcript-item")).toHaveCount(50);
  await expect(page.getByText("Long transcript message 249")).toBeVisible();
});

test("loads every catalog page without silently truncating sessions", async ({ page }) => {
  const templateResponse = await page.request.get("/api/sessions?limit=1");
  const template = (await templateResponse.json()).sessions[0];
  const sessions = Array.from({ length: 250 }, (_, index) => ({
    ...template,
    id: `catalog-${index}`,
    nativeId: `catalog-${index}`,
    cwd: `C:\\Catalog\\project-${Math.floor(index / 10)}`,
    firstUserMessage: `Catalog session ${index}`
  }));
  await page.route(/\/api\/sessions\?.*/, (route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get("offset") || 0);
    const limit = Number(url.searchParams.get("limit") || 100);
    return route.fulfill({ json: { sessions: sessions.slice(offset, offset + limit), total: sessions.length, status: { running: false, lastRunAt: null, filesSeen: 250, filesIndexed: 0, filesSkipped: 250, sessions: 250, parseErrors: 0, error: null } } });
  });
  await page.goto("/");
  await expect(page.locator(".projects-section .session-card")).toHaveCount(100);
  await page.getByRole("button", { name: "Load 100 more" }).click();
  await expect(page.locator(".projects-section .session-card")).toHaveCount(200);
  await page.getByRole("button", { name: "Load 50 more" }).click();
  await expect(page.locator(".projects-section .session-card")).toHaveCount(250);
  await expect(page.locator(".session-list-pagination")).toHaveCount(0);
});

test("uses a reachable single-pane layout on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".list-pane")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator(".session-card").first().click();
  await expect(page.locator(".detail-pane")).toBeVisible();
  await expect(page.locator(".list-pane")).toHaveCount(0);
  await page.getByRole("button", { name: "Open sessions" }).click();
  await expect(page.locator(".list-pane")).toBeVisible();
});
