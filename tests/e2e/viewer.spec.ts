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

  await expect(page.getByPlaceholder("Find by first prompt or session ID")).toBeVisible();
  await page.getByRole("button", { name: "Use dark mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ["--canvas", "--surface", "--surface-2", "--surface-hover", "--accent-soft", "--search-highlight"]
      .map((name) => style.getPropertyValue(name).trim());
  })).toEqual(["#0f0f0f", "#151515", "#1c1c1c", "#242424", "#262626", "#facc15"]);
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

  await page.getByPlaceholder("Find by first prompt or session ID").fill("Fixture assistant response");
  await expect(page.getByText("0 matching sessions", { exact: true })).toBeVisible();
  await expect(page.getByText("No sessions match the current filters", { exact: true })).toBeVisible();

  await page.getByPlaceholder("Find by first prompt or session ID").fill("JSONL VIEWER");
  await expect(page.getByText("Finding sessions...", { exact: true })).toBeVisible();
  await expect(page.getByText("Matching sessions", { exact: true })).toBeVisible();
  await expect(page.getByText("Working directories", { exact: true })).toHaveCount(0);
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("1");
  await expect(page.locator(".detail-pane")).toContainText("Fixture assistant response");
  await expect(page.getByText("1 matching session", { exact: true })).toBeVisible();
  await expect(page.locator(".recent-section .session-card mark")).toHaveText(["JSONL", "viewer"]);
  await expect(page.locator(".detail-prompt-preview mark")).toHaveText(["JSONL", "viewer"]);
  await expect(page.locator(".recent-section .session-card-title")).toContainText("fixture");
  await expect(page.locator(".detail-title h2")).toHaveText("fixture");
  await expect(page.locator(".detail-prompt-preview")).toHaveText("Implement JSONL viewer fixture prompt");

  await page.getByPlaceholder("Find by first prompt or session ID").fill("fixture");
  await expect(page.locator(".recent-section .session-card").first().locator(".session-card-title mark")).toHaveText("fixture");
  await expect(page.locator(".detail-title h2 mark")).toHaveText("fixture");

  await page.getByPlaceholder("Find by first prompt or session ID").fill("55555555-5555-4555-8555-555555555555");
  await expect(page.locator(".recent-section .session-card-preview-label")).toHaveText("Session ID");
  await expect(page.locator(".recent-section .session-card-preview mark")).toHaveText("55555555-5555-4555-8555-555555555555");
  await expect(page.locator(".copy-value", { hasText: "Session ID" }).locator("code mark")).toHaveText("55555555-5555-4555-8555-555555555555");
  await page.getByPlaceholder("Find by first prompt or session ID").press("Enter");
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
  await expect(page).toHaveURL(/cwd=fixture/);
  await expect(page.locator(".projects-section .project-group")).toHaveCount(1);
  await expect(page.locator(".projects-section .project-group summary")).toContainText("fixture");
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("1");
  await expect(page.locator(".detail-pane")).toContainText("Fixture assistant response");
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
  await expect(page.locator(".session-card", { hasText: "Implement JSONL viewer fixture prompt" }).last()).toBeVisible();

  await page.getByRole("button", { name: "Session filters" }).click();
  await page.getByLabel("From", { exact: true }).fill("2026-06-04");
  await page.getByLabel("To", { exact: true }).fill("2026-06-04");
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("1");
  await expect(page.locator(".session-card", { hasText: "Inspect the Gemini fixture project" }).last()).toBeVisible();
  await page.getByLabel("From", { exact: true }).fill("");
  await page.getByLabel("To", { exact: true }).fill("");
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByLabel("Archive").selectOption("true");
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("1");
  await expect(page.locator(".session-card", { hasText: "Archived Codex fixture prompt" }).last()).toBeVisible();
  await page.getByLabel("Archive").selectOption("false");
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("4");
  await page.getByLabel("Parse status").selectOption("true");
  await expect(page.getByText("No sessions match the current filters")).toBeVisible();
  await expect(page.locator(".detail-pane")).toContainText("No session selected");
  await page.getByLabel("Parse status").selectOption("false");
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("4");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator(".recent-section .sidebar-section-heading small")).toHaveText("5");
  await page.getByRole("button", { name: "Done" }).click();

  await page.locator(".session-card", { hasText: "Implement JSONL viewer fixture prompt" }).last().click();
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

  await expect(page.getByRole("group", { name: "Additional provider events" })).toHaveCount(0);

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
  await expect(page.locator(".session-card", { hasText: "Implement JSONL viewer fixture prompt" }).last()).toBeVisible();
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
  const stickyHeaderItem = {
    ...mockedDetail.turns[0].items[0],
    id: 999_998,
    role: "assistant",
    phase: "final_answer",
    text: `Sticky header message${Array.from({ length: 80 }, (_, index) => `\n\nTranscript paragraph ${index + 1}`).join("")}`,
    summary: null,
    contentPreview: false
  };
  const allPagedItems = [largeItem, stickyHeaderItem, ...Array.from({ length: 248 }, (_, index) => ({
    ...mockedDetail.turns[0].items[0],
    id: 1_000_000 + index,
    role: "assistant",
    phase: "final_answer",
    text: `Long transcript message ${index + 2}`,
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

  await expect(page.getByText(/shortened preview to keep scrolling responsive/)).toHaveCount(0);
  await expect(page.locator(".detail-pane .transcript-item")).toHaveCount(100);
  await expect(page.getByText("Readable assistant preview…")).toBeVisible();
  const stickyItem = page.locator(".transcript-item", { hasText: "Sticky header message" });
  await stickyItem.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.locator(".detail-pane").evaluate((element) => element.scrollBy(0, 180));
  const stickyPosition = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".detail-header")!;
    const meta = Array.from(document.querySelectorAll<HTMLElement>(".transcript-item"))
      .find((item) => item.textContent?.includes("Sticky header message"))!
      .querySelector<HTMLElement>(".item-meta")!;
    return {
      position: getComputedStyle(meta).position,
      headerBottom: header.getBoundingClientRect().bottom,
      metaTop: meta.getBoundingClientRect().top
    };
  });
  expect(stickyPosition.position).toBe("sticky");
  expect(Math.abs(stickyPosition.metaTop - stickyPosition.headerBottom)).toBeLessThanOrEqual(1);
  const expandableItem = page.locator(".detail-pane .transcript-item").first();
  await page.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(expandableItem.getByText("Readable assistant preview…")).toHaveCount(0);
  await expect(expandableItem.getByText("Readable full assistant response")).toBeVisible();
  await expect(page.getByText("Readable original record")).toHaveCount(0);
  await expect(page.locator(".inline-record-expansion")).toHaveCount(0);
  await expect(page.locator(".raw-drawer")).toHaveCount(0);
  await expandableItem.getByRole("button", { name: "View raw JSON", exact: true }).click();
  await expect(page.getByText("Raw JSON #999999")).toBeVisible();
  await page.getByRole("button", { name: "Close raw JSON" }).click();
  await page.getByRole("button", { name: "Collapse", exact: true }).click();
  await expect(expandableItem.getByText("Readable assistant preview…")).toBeVisible();
  await expect(expandableItem.getByText("Readable full assistant response")).toHaveCount(0);
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
  const templateDetailResponse = await page.request.get(`/api/sessions/${encodeURIComponent(template.id)}`);
  const templateDetail = await templateDetailResponse.json();
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
    const query = (url.searchParams.get("q") || "").toLocaleLowerCase();
    const matches = query
      ? sessions.filter((session) => session.id.toLocaleLowerCase().includes(query)
        || session.nativeId.toLocaleLowerCase().includes(query)
        || session.firstUserMessage.toLocaleLowerCase().includes(query))
      : sessions;
    return route.fulfill({ json: { sessions: matches.slice(offset, offset + limit), total: matches.length, status: { running: false, lastRunAt: null, filesSeen: 250, filesIndexed: 0, filesSkipped: 250, sessions: 250, parseErrors: 0, error: null } } });
  });
  await page.route(/\/api\/resolve\?.*/, (route) => {
    const value = new URL(route.request().url()).searchParams.get("value");
    const session = sessions.find((item) => item.id === value || item.nativeId === value) || null;
    return route.fulfill({ json: { session, matchedBy: session ? "id" : null } });
  });
  await page.route(/\/api\/sessions\/catalog-\d+(?:\?.*)?$/, (route) => {
    const id = route.request().url().match(/\/api\/sessions\/(catalog-\d+)/)?.[1];
    const session = sessions.find((item) => item.id === id);
    return route.fulfill({
      json: {
        ...templateDetail,
        session,
        sourceVersion: `${id}-v1`
      }
    });
  });
  await page.goto("/");
  await expect(page.locator(".projects-section .project-group")).toHaveCount(6);
  await expect(page.locator(".recent-section")).toBeVisible();
  await page.getByRole("button", { name: "Show 4 more" }).click();
  await expect(page.locator(".projects-section .project-group")).toHaveCount(10);
  await expect(page.locator(".projects-section .project-group").first().locator(".session-card")).toHaveCount(5);
  await page.locator(".projects-section .project-group").first().getByRole("button", { name: "Show 5 more sessions" }).click();
  await expect(page.locator(".projects-section .project-group").first().locator(".session-card")).toHaveCount(10);
  await page.getByRole("button", { name: "Load 100 more" }).click();
  await expect(page.locator(".projects-section .project-group")).toHaveCount(20);
  await page.getByRole("button", { name: "Load 50 more" }).click();
  await expect(page.locator(".projects-section .project-group")).toHaveCount(25);
  await expect(page.locator(".projects-section .project-group").last().locator("summary small")).toHaveText("10");
  await expect(page.locator(".session-list-pagination")).toHaveCount(0);

  const finder = page.getByPlaceholder("Find by first prompt or session ID");
  await finder.fill("catalog-249");
  await expect(page.locator(".recent-section .session-card")).toHaveCount(1);
  await finder.press("Enter");
  await expect(page).toHaveURL(/#session=catalog-249$/);
  await expect(page.locator(".detail-title h2")).toHaveText("project-24");
  await expect(finder).toHaveValue("");

  await page.goto("/#session=catalog-249");
  await expect(page).toHaveURL(/#session=catalog-249$/);
  await expect(page.locator(".detail-title h2")).toHaveText("project-24");
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
