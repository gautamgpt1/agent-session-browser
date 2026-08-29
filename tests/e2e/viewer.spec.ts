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
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".session-card", { hasText: "C:\\Projects\\fixture" }).last()).toBeVisible();

  await page.locator(".session-card", { hasText: "C:\\Projects\\fixture" }).last().click();
  await expect(page.getByText("Fixture assistant response")).toBeVisible();
  await expect(page.locator(".detail-pane .transcript-item", { hasText: "Fixture assistant response" })).toHaveCount(1);
  await expect(page.locator(".detail-pane .transcript-item", { hasText: "Implement JSONL viewer fixture prompt" })).toHaveCount(1);
  await expect(page.locator(".detail-pane")).not.toContainText("npm test");
  await expect(page.locator(".detail-pane")).not.toContainText("Future file change summary");
  await expect(page.locator(".detail-pane")).not.toContainText("task_started");
  await expect(page.locator(".detail-pane")).not.toContainText("Directory listing output");

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.locator(".filter-popover")).toBeVisible();

  await page.getByRole("checkbox", { name: "assistant final" }).uncheck();
  await expect(page.locator(".detail-pane")).not.toContainText("Fixture assistant response");
  await page.getByRole("checkbox", { name: "assistant final" }).check();
  await expect(page.locator(".detail-pane .transcript-item", { hasText: "Fixture assistant response" })).toHaveCount(1);

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
  await expect(page.locator('.export-options a[href*="format=html"][href*="mode=readable"]')).toBeVisible();
  await expect(page.locator(".export-options a")).toHaveCount(2);
  const exported = await page.request.get("/api/sessions/11111111-1111-4111-8111-111111111111/export?format=html&mode=readable");
  expect(exported.ok()).toBe(true);
  expect(await exported.text()).toContain("Fixture assistant response");
  await page.getByText("Export", { exact: true }).click();

  await page.getByRole("button", { name: "View raw JSON" }).first().click();
  await expect(page.getByText("Raw item #")).toBeVisible();
  await expect(page.locator(".raw-drawer pre")).toContainText('"role": "user"');

  await page.getByRole("button", { name: "Close raw JSON" }).click();
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.locator(".detail-pane")).toContainText("Implement JSONL viewer fixture prompt");
  await expect(page.locator(".detail-pane")).toContainText("Fixture assistant response");
  await expect(page.locator(".detail-pane")).not.toContainText("Fixture progress update");
  await expect(page.getByRole("checkbox", { name: "assistant final" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "assistant progress" })).not.toBeChecked();
});
