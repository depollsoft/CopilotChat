import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { MessageAttachment } from "@copilotchat/shared";

test("core app flows work end to end", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers full management flow.");
  const workspace = testInfo.outputPath("workspace"); fs.mkdirSync(workspace, { recursive: true }); fs.writeFileSync(path.join(workspace, "note.txt"), "hello\n");
  await page.goto("/"); await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.locator(".sidebar-row").filter({ hasText: "New project" }).click();
  await page.getByRole("dialog", { name: "New project" }).getByLabel("Project name").fill(`Project ${testInfo.project.name}`);
  await page.getByRole("button", { name: "Create project" }).click();
  for (const label of ["Project", "Skills", "Workspace", "Tool permissions"]) {
    await page.getByRole("button", { name: "Open composer options" }).click();
    await page.getByRole("dialog", { name: "Composer options" }).getByRole("button", { name: new RegExp(label) }).click();
    const popover = page.locator(".composer-popover").last();
    await expect(popover).toBeVisible();
    const bounds = await popover.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: window.innerWidth, height: window.innerHeight };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.width);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
    await page.keyboard.press("Escape");
  }
  await page.locator(".project-summary-card.editable").filter({ hasText: "Custom instructions" }).click();
  await page.getByRole("dialog", { name: "Edit custom instructions" }).getByLabel("Project context editor").fill("Use e2e project rules.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("button", { name: "Open composer options" }).click();
  await page.getByRole("dialog", { name: "Composer options" }).getByRole("button", { name: /Skills/ }).click();
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await page.getByRole("button", { name: "New skill" }).click();
  await page.getByLabel("Skill name").fill(`Skill ${testInfo.project.name}`);
  await page.getByLabel("Short description").fill("E2E skill");
  await page.getByLabel("Instructions").fill("Mention the selected skill.");
  await page.getByLabel("Activation rules").fill("User says hello from e2e");
  await page.getByLabel("Network").check();
  await page.getByRole("button", { name: "Install skill" }).click();
  await page.getByRole("button", { name: new RegExp(`Skill ${testInfo.project.name}`) }).click();
  await page.getByRole("tab", { name: /^Tools$/ }).click();
  await page.getByPlaceholder("github").fill(`mcp-${testInfo.project.name}`);
  await page.locator(".drawer select").selectOption("http");
  await page.getByPlaceholder("https://api.example.com/mcp").fill("https://example.com/mcp");
  await page.getByPlaceholder("tool-a, tool-b, or *").fill("search");
  await page.getByRole("button", { name: "Add MCP server" }).click();
  await expect(page.getByText(`mcp-${testInfo.project.name}`)).toBeVisible();
  await page.getByRole("tab", { name: /^Code$/ }).click();
  await page.getByPlaceholder("My repo").fill(`Workspace ${testInfo.project.name}`);
  await page.getByPlaceholder("/Users/you/Code/project").fill(workspace);
  await page.getByRole("button", { name: "Register workspace" }).click();
  await page.getByRole("button", { name: "Use in chat" }).click();
  await page.getByPlaceholder("Command").fill("ls -1"); await page.getByRole("button", { name: "Run" }).click(); await expect(page.getByText("note.txt")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: /Model picker:/ }).click();
  const modelPicker = page.getByRole("dialog", { name: "Model picker" });
  const selectedModel = modelPicker.locator('[data-model-id][aria-selected="true"]');
  const modelValue = (await selectedModel.getAttribute("data-model-id")) ?? "";
  await modelPicker.locator('[data-model-id="gpt-5-mini"]').click();
  await expect(modelPicker.getByLabel("Context size")).toHaveCount(0);
  await modelPicker.locator(`[data-model-id="${modelValue}"]`).click();
  const effortSelect = modelPicker.getByLabel("Reasoning effort");
  const effortValues = await effortSelect.evaluate((select) => Array.from((select as HTMLSelectElement).options).map((option) => option.value));
  const effortValue = effortValues.includes("high") ? "high" : effortValues[effortValues.length - 1] ?? "default";
  await effortSelect.selectOption(effortValue);
  await modelPicker.getByLabel("Context size").selectOption("long_context");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /Context:/ })).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Hello from e2e.");
  await expect(page.getByRole("button", { name: /Context: .*Estimated [1-9][0-9]* of/ })).toContainText(/<1%|[1-9][0-9]*%/);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  const assistantMessages = page.locator(".msg.assistant .msg-body");
  await expect(assistantMessages.filter({ hasText: modelValue }).last()).toBeVisible();
  const userMessage = page.locator(".msg.user").filter({ hasText: "Hello from e2e." });
  const assistantMessage = page.locator(".msg.assistant").filter({ hasText: modelValue }).last();
  await expect(userMessage.locator(".msg-time")).toBeVisible();
  await expect(assistantMessage.locator(".msg-time")).toBeVisible();
  for (const message of [userMessage, assistantMessage]) {
    await expect(message.locator(".msg-meta .msg-time")).toBeVisible();
    await expect(message.locator(".msg-meta .msg-action-button").first()).toBeVisible();
    const metaBox = await message.locator(".msg-meta").boundingBox();
    expect(metaBox).not.toBeNull();
    expect(metaBox!.height).toBeLessThanOrEqual(34);
  }
  const messageTimes = await page.locator(".msg-time").evaluateAll((times) => times.map((time) => ({ text: time.textContent ?? "", dateTime: time.getAttribute("datetime") ?? "" })));
  expect(messageTimes.every((time) => time.text.trim().length > 0 && !Number.isNaN(Date.parse(time.dateTime)))).toBe(true);
  const firstMessageTime = userMessage.locator(".msg-time").first();
  const shortTime = (await firstMessageTime.textContent()) ?? "";
  await firstMessageTime.click();
  const timePopover = page.locator(".msg-time-popover").first();
  await expect(timePopover).toBeVisible();
  await expect(timePopover).not.toHaveText(shortTime);
  const dateBarriers = await page.locator(".date-barrier").evaluateAll((barriers) => barriers.map((barrier) => ({ text: barrier.textContent ?? "", dateTime: barrier.getAttribute("datetime") ?? "" })));
  expect(dateBarriers.length).toBeGreaterThanOrEqual(1);
  expect(dateBarriers.every((barrier) => barrier.text.trim().length > 0 && !Number.isNaN(Date.parse(barrier.dateTime)))).toBe(true);
  await expect(assistantMessages.filter({ hasText: `Reasoning effort: ${effortValue}` }).last()).toBeVisible();
  await expect(assistantMessages.filter({ hasText: "Context size: long_context." }).last()).toBeVisible();
  await expect(assistantMessages.filter({ hasText: "Project context: Project instructions: Use e2e project rules." }).last()).toBeVisible();
  await expect(assistantMessages.filter({ hasText: `Enabled skills: Skill ${testInfo.project.name}.` }).last()).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Use the previous answer as context.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(assistantMessages.filter({ hasText: "Messages in context: 3." }).last()).toBeVisible();
  await expect(assistantMessages.filter({ hasText: "Previous context: user: Hello from e2e." }).last()).toBeVisible();
  await page.locator(".msg.user").filter({ hasText: "Hello from e2e." }).getByRole("button", { name: "Edit message" }).click();
  await page.getByRole("textbox", { name: "Edit message" }).fill("Edited hello from e2e.");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(assistantMessages.filter({ hasText: "You said: Edited hello from e2e." }).last()).toBeVisible();
  await expect(assistantMessages.filter({ hasText: "Messages in context: 1." }).last()).toBeVisible();
  await expect(page.locator(".msg.user").filter({ hasText: "Edited hello from e2e." }).getByRole("button", { name: "Copy message" })).toBeVisible();
  await page.locator(".msg.assistant").filter({ hasText: "You said: Edited hello from e2e." }).getByRole("button", { name: "Retry response" }).click();
  await expect(assistantMessages.filter({ hasText: "You said: Edited hello from e2e." }).last()).toBeVisible();
  await expect(assistantMessages.filter({ hasText: "Messages in context: 1." }).last()).toBeVisible();
  await page.locator(".sidebar-row.active[data-chat-id] .sidebar-row-menu").click({ force: true }); await page.getByRole("button", { name: "Rename", exact: true }).click(); await page.getByRole("dialog", { name: "Rename chat" }).getByLabel("Chat title").fill(`Renamed ${testInfo.project.name}`); await page.getByRole("button", { name: "Save title" }).click(); await expect(page.locator(".sidebar-row-title").filter({ hasText: `Renamed ${testInfo.project.name}` }).first()).toBeVisible();
});

test("project model defaults apply to the first turn", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers project model defaults.");
  await page.goto("/");
  await page.locator(".sidebar-row").filter({ hasText: "New project" }).click();
  await page.getByRole("dialog", { name: "New project" }).getByLabel("Project name").fill("Project model default");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByLabel("Project default model").selectOption("gpt-5-mini");
  await expect(page.getByText("Project default model saved")).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat/).fill("Use the project model.");
  await page.getByRole("button", { name: "Send" }).click();
  const response = page.locator(".msg.assistant .msg-body").last();
  await expect(response).toContainText("gpt-5-mini");
  await expect(response).toContainText("Context size: default.");
});

test("mobile shell has no horizontal overflow and navigates drawers", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile shell coverage only runs in mobile project.");
  await page.goto("/"); await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/); await expect(page.locator("body")).toBeVisible(); const modelButton = page.getByRole("button", { name: /Model picker:/ }); await expect(modelButton).toBeVisible(); await modelButton.click(); await expect(page.getByRole("dialog", { name: "Model picker" }).getByLabel("Reasoning effort")).toBeVisible(); await expect(page.getByRole("dialog", { name: "Model picker" }).getByLabel("Context size")).toBeVisible(); await page.keyboard.press("Escape"); const contextRing = page.getByRole("button", { name: /Context:/ }); await expect(contextRing).toBeVisible(); await contextRing.click(); await expect(page.locator("#context-details")).toContainText(/Estimated/); await page.getByPlaceholder(/Ask CopilotChat/).fill("Mobile actions check."); await page.getByRole("button", { name: "Send" }).click(); await expect(page.locator(".msg.user").filter({ hasText: "Mobile actions check." }).getByRole("button", { name: "Edit message" })).toBeVisible(); await expect(page.locator(".msg.assistant").getByRole("button", { name: "Retry response" }).last()).toBeVisible(); await page.getByRole("button", { name: "Toggle sidebar" }).click(); await expect(page.locator(".sidebar.open")).toBeVisible(); await page.evaluate(() => history.back()); await expect(page.locator(".sidebar.open")).toHaveCount(0); await page.getByRole("button", { name: "Toggle sidebar" }).click(); await expect(page.getByText("Projects")).toBeVisible(); await page.getByText("Preferences").click(); await expect(page.getByRole("dialog", { name: "Preferences" })).toBeVisible(); const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2); expect(overflow).toBe(false);
});

test("mobile foreground reconnects to an in-progress response", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile lifecycle coverage only runs in mobile project.");
  let returnCleanEof = false;
  let activeResponseRequests = 0;
  await page.route(/\/api\/chats\/[^/]+\/active-response$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    activeResponseRequests += 1;
    if (returnCleanEof) {
      returnCleanEof = false;
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": connected\n\n" });
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  const prompt = `Start a long response for mobile resume. ${"Keep streaming this response. ".repeat(750)}`;
  await page.getByPlaceholder(/Ask CopilotChat/).fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  const streamingResponse = page.locator(".msg.assistant").filter({ has: page.locator(".cursor") }).last();
  await expect(streamingResponse).toContainText("I am running with the local development provider");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await context.setOffline(true);
  await expect(page.locator(".error-banner")).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const requestsBeforeResume = activeResponseRequests;
  returnCleanEof = true;
  await context.setOffline(false);
  await expect.poll(() => activeResponseRequests).toBeGreaterThan(requestsBeforeResume + 1);
  await expect(page.locator(".msg.assistant .msg-body").filter({ hasText: "Configure Copilot auth/provider settings" }).last()).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await expect(page.locator(".msg.user").filter({ hasText: "Start a long response for mobile resume." })).toBeVisible();
});

test("mobile shell keeps controls inside emulated safe areas", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile safe-area coverage only runs in mobile project.");
  const insets = { top: 47, right: 31, bottom: 34, left: 59 };
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setSafeAreaInsetsOverride", { insets });
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();

  async function safeAreaBounds(selector: string): Promise<{ top: number; right: number; bottom: number; left: number; width: number; height: number }> {
    const bounds = await page.locator(selector).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: window.innerWidth, height: window.innerHeight };
    });
    expect(bounds.right).toBeLessThanOrEqual(bounds.width - insets.right);
    expect(bounds.left).toBeGreaterThanOrEqual(insets.left);
    return bounds;
  }

  async function expectInsideSafeArea(selector: string): Promise<void> {
    const bounds = await safeAreaBounds(selector);
    expect(bounds.top).toBeGreaterThanOrEqual(insets.top);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height - insets.bottom);
  }

  await expectInsideSafeArea(".header-left");
  await expectInsideSafeArea(".header-actions");
  await safeAreaBounds(".welcome-inner");
  await expectInsideSafeArea(".composer");

  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await expectInsideSafeArea(".app-dialog");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await page.getByText("Preferences").click();
  await expect(page.getByRole("dialog", { name: "Preferences" })).toBeVisible();
  await expectInsideSafeArea(".drawer-head .icon-button");
  await safeAreaBounds(".drawer-head > div");
  await safeAreaBounds(".drawer-body > *");
  const drawerPadding = await page.locator(".drawer-body").evaluate((element) => {
    const style = getComputedStyle(element);
    return { right: Number.parseFloat(style.paddingRight), bottom: Number.parseFloat(style.paddingBottom), left: Number.parseFloat(style.paddingLeft) };
  });
  expect(drawerPadding.right).toBeGreaterThanOrEqual(insets.right);
  expect(drawerPadding.bottom).toBeGreaterThanOrEqual(insets.bottom);
  expect(drawerPadding.left).toBeGreaterThanOrEqual(insets.left);
});

test("composer pickers stay within the mobile viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile viewport coverage only runs in mobile project.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open composer options" })).toBeVisible();
  await expect(page.locator(".composer-toolbar")).toHaveCount(0);
  await expect(page.locator(".composer-active-chip")).toHaveCount(0);
  await page.getByRole("button", { name: "Open composer options" }).click();
  const menuGap = await page.getByRole("dialog", { name: "Composer options" }).evaluate((menu) => {
    const composer = document.querySelector(".composer");
    if (!(composer instanceof HTMLElement)) return null;
    return composer.getBoundingClientRect().top - menu.getBoundingClientRect().bottom;
  });
  expect(menuGap).not.toBeNull();
  expect(menuGap!).toBeGreaterThanOrEqual(0);
  expect(menuGap!).toBeLessThanOrEqual(48);
  await page.keyboard.press("Escape");
  for (const label of ["Project", "Skills", "Workspace", "Tool permissions"]) {
    await page.getByRole("button", { name: "Open composer options" }).click();
    await page.getByRole("dialog", { name: "Composer options" }).getByRole("button", { name: new RegExp(label) }).click();
    const popover = page.locator(".composer-popover").last();
    await expect(popover).toBeVisible();
    const bounds = await popover.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: window.innerWidth, height: window.innerHeight };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.width);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
    await page.keyboard.press("Escape");
  }
});

test("mobile Return inserts a composer newline", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile keyboard behavior only runs in mobile project.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  const composer = page.getByPlaceholder(/Ask CopilotChat/);
  await composer.fill("First line");
  await composer.press("Enter");
  await expect(composer).toHaveValue("First line\n");
  await expect(page.locator(".msg.user").filter({ hasText: "First line" })).toHaveCount(0);
});

test("project navigation shows editable context and project chats", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers project landing page.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.locator(".sidebar-row").filter({ hasText: "New project" }).click();
  await page.getByRole("dialog", { name: "New project" }).getByLabel("Project name").fill("Landing project");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  const projectUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(projectUrl);
  await expect(page.locator(".project-title-block").filter({ hasText: "Landing project" })).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menu", { name: "Header actions menu" }).getByRole("button", { name: "Star project" }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menu", { name: "Header actions menu" }).getByRole("button", { name: "Unstar project" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Project default model").selectOption("gpt-5-mini");
  await expect(page.locator(".project-model-card")).toContainText("Project");
  await page.locator(".project-summary-card.editable").filter({ hasText: "Custom instructions" }).click();
  await page.getByRole("dialog", { name: "Edit custom instructions" }).getByLabel("Project context editor").fill("Landing instructions.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.locator(".project-summary-card.editable").filter({ hasText: "Memories" }).click();
  const contextDrawer = page.getByRole("dialog", { name: "Personal context" });
  await expect(contextDrawer.getByLabel("Memory scope")).toHaveValue(/.+/);
  await contextDrawer.getByLabel("Shared project note").fill("Landing memory.");
  await contextDrawer.getByLabel("Title").fill("Landing decision");
  await contextDrawer.getByLabel("What should CopilotChat remember?").fill("Prefer the landing deployment plan.");
  await contextDrawer.getByRole("button", { name: "Save project note" }).click();
  await expect(contextDrawer.getByLabel("Title")).toHaveValue("Landing decision");
  await expect(contextDrawer.getByLabel("What should CopilotChat remember?")).toHaveValue("Prefer the landing deployment plan.");
  await contextDrawer.getByRole("button", { name: "Add memory" }).click();
  await expect(contextDrawer.getByText("Landing decision")).toBeVisible();
  await contextDrawer.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Add reference" }).click();
  await page.getByRole("dialog", { name: "Add reference material" }).getByLabel("Reference title").fill("Landing reference");
  await page.getByRole("dialog", { name: "Add reference material" }).getByLabel("Project context editor").fill("Landing reference material.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".project-reference-list").filter({ hasText: "Landing reference" })).toBeVisible();
  await page.getByRole("button", { name: "Start a new chat" }).click();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Use landing context.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant .msg-body").filter({ hasText: "gpt-5-mini" }).last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".msg.assistant .msg-body").filter({ hasText: "Project context: Project instructions: Landing instructions." }).last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".msg.assistant .msg-body").filter({ hasText: "Shared project memory: Landing memory." }).last()).toBeVisible();
  await expect(page.locator(".msg.assistant .msg-body").filter({ hasText: "Landing decision" }).last()).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menu", { name: "Header actions menu" }).getByRole("button", { name: "Star chat" }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menu", { name: "Header actions menu" }).getByRole("button", { name: "Unstar chat" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".sidebar-row").filter({ hasText: "Landing project" }).click();
  await expect(page).toHaveURL(projectUrl);
  await expect.poll(() => page.locator(".scroll").evaluate((element) => element.scrollTop)).toBeLessThan(20);
  await expect(page.locator(".recent-chats").filter({ hasText: "Use landing context." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a new chat" })).toBeVisible();
  await page.locator(".sidebar-row").filter({ hasText: "General" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(/Back at it/i)).toBeVisible();
});

test("personal context and coarse location are included in chats", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers personal context management.");
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 47.60621, longitude: -122.33207 });
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.locator(".sidebar-footer-user").click();
  const drawer = page.getByRole("dialog", { name: "Personal context" });
  const profile = "I am a staff engineer who prefers concise TypeScript examples.";
  await drawer.getByLabel("About you").fill(profile);
  const coarseLocation = drawer.getByRole("radio", { name: /^Coarse/ });
  await coarseLocation.click();
  await expect(coarseLocation).toHaveAttribute("aria-checked", "true");
  await drawer.getByRole("button", { name: "Save current location" }).click();
  await expect(drawer.getByLabel("About you")).toHaveValue(profile);
  const fineLocation = drawer.getByRole("radio", { name: /^Fine/ });
  await fineLocation.click();
  await drawer.getByRole("button", { name: "Save profile" }).click();
  await expect(fineLocation).toHaveAttribute("aria-checked", "true");
  await coarseLocation.click();
  await expect(drawer.locator(".location-summary")).toContainText("47.6, -122.3");
  await drawer.getByLabel("Title").fill("Response style");
  await drawer.getByLabel("What should CopilotChat remember?").fill("Lead with the recommendation.");
  await drawer.getByRole("button", { name: "Add memory" }).click();
  let memoryCard = drawer.locator(".memory-card").filter({ hasText: "Response style" });
  await expect(memoryCard).toBeVisible();
  const serializedState = await page.evaluate(async () => JSON.stringify(await (await fetch("/api/state")).json()));
  expect(serializedState).not.toContain("Lead with the recommendation.");
  await memoryCard.getByRole("button", { name: "Edit" }).click();
  const memoryEditor = drawer.locator(".memory-card.memory-editor");
  await memoryEditor.getByLabel("Title").fill("Updated response style");
  await memoryEditor.getByLabel("Memory").fill("Lead with the edited recommendation.");
  await memoryEditor.getByRole("button", { name: "Save changes" }).click();
  memoryCard = drawer.locator(".memory-card").filter({ hasText: "Updated response style" });
  await expect(memoryCard).toContainText("Lead with the edited recommendation.");
  await memoryCard.getByRole("button", { name: "Pause" }).click();
  await expect(memoryCard.getByText("Paused", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Close" }).click();
  await page.getByPlaceholder(/Ask CopilotChat/).fill("Check paused personal context.");
  await page.getByRole("button", { name: "Send" }).click();
  let response = page.locator(".msg.assistant .msg-body").last();
  await expect(response).toContainText("Personal context: Profile supplied by the user: I am a staff engineer", { timeout: 15000 });
  await expect(response).toContainText("Location shared by the user (coarse): 47.6, -122.3");
  await expect(response).not.toContainText("Updated response style");

  await page.locator(".sidebar-footer-user").click();
  memoryCard = page.getByRole("dialog", { name: "Personal context" }).locator(".memory-card").filter({ hasText: "Updated response style" });
  await memoryCard.getByRole("button", { name: "Include" }).click();
  await expect(memoryCard.getByText("Included", { exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "Personal context" }).getByRole("button", { name: "Close" }).click();
  await page.locator(".sidebar-new").click();
  await page.getByPlaceholder(/Ask CopilotChat/).fill("Check included personal context.");
  await page.getByRole("button", { name: "Send" }).click();
  response = page.locator(".msg.assistant .msg-body").last();
  await expect(response).toContainText("Updated response style", { timeout: 15000 });

  await page.locator(".sidebar-footer-user").click();
  memoryCard = page.getByRole("dialog", { name: "Personal context" }).locator(".memory-card").filter({ hasText: "Updated response style" });
  await memoryCard.getByRole("button", { name: "Delete", exact: true }).click();
  await memoryCard.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.getByRole("dialog", { name: "Personal context" }).getByText("Updated response style")).toHaveCount(0);
  await page.getByRole("dialog", { name: "Personal context" }).getByRole("button", { name: "Close" }).click();
  await page.locator(".sidebar-new").click();
  await page.getByPlaceholder(/Ask CopilotChat/).fill("Check deleted personal context.");
  await page.getByRole("button", { name: "Send" }).click();
  response = page.locator(".msg.assistant .msg-body").filter({ hasText: "You said: Check deleted personal context." }).last();
  await expect(response).toBeVisible({ timeout: 15000 });
  await expect(response).not.toContainText("Updated response style");

  await page.locator(".sidebar-footer-user").click();
  const locationDrawer = page.getByRole("dialog", { name: "Personal context" });
  const offLocation = locationDrawer.getByRole("radio", { name: /^Off/ });
  await offLocation.click();
  await locationDrawer.getByRole("button", { name: "Turn off location" }).click();
  await expect(locationDrawer.locator(".location-summary")).toContainText("No location saved.");
  await expect(offLocation).toHaveAttribute("aria-checked", "true");
  await expect(locationDrawer.getByRole("button", { name: "Turn off location" })).toBeDisabled();
  await locationDrawer.getByRole("button", { name: "Close" }).click();
  await page.locator(".sidebar-new").click();
  await page.getByPlaceholder(/Ask CopilotChat/).fill("Check disabled location context.");
  await page.getByRole("button", { name: "Send" }).click();
  response = page.locator(".msg.assistant .msg-body").filter({ hasText: "You said: Check disabled location context." }).last();
  await expect(response).toBeVisible({ timeout: 15000 });
  await expect(response).not.toContainText("Location shared by the user");
  await expect(response).not.toContainText("47.6, -122.3");
});

test("no-op user context updates preserve active responses", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers active response context mutations.");
  const headers = { "X-CopilotChat-CSRF": "1" };
  const baseline = { profile: "No-op context baseline", locationLevel: "off", location: null };
  await request.patch("/api/user-context", { headers, data: baseline });
  await page.goto("/");
  await page.getByPlaceholder(/Ask CopilotChat/).fill(`No-op context response ${"keep streaming ".repeat(1200)}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  const chatId = page.url().split("/").pop() ?? "";
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  const noOpResponse = await request.patch("/api/user-context", { headers, data: baseline });
  expect(noOpResponse.ok()).toBe(true);
  await expect.poll(async () => {
    const state = await (await request.get("/api/state")).json() as { activeChatIds: string[] };
    return state.activeChatIds.includes(chatId);
  }).toBe(true);

  const changedResponse = await request.patch("/api/user-context", { headers, data: { ...baseline, profile: "Changed context baseline" } });
  expect(changedResponse.ok()).toBe(true);
  await expect.poll(async () => {
    const state = await (await request.get("/api/state")).json() as { activeChatIds: string[] };
    return state.activeChatIds.includes(chatId);
  }).toBe(false);
});

test("stale memory pages cannot cross scopes", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers paginated memory management.");
  const headers = { "X-CopilotChat-CSRF": "1" };
  const projectAResponse = await request.post("/api/projects", { headers, data: { name: "Memory scope A", description: "", instructions: "", memory: "" } });
  const projectBResponse = await request.post("/api/projects", { headers, data: { name: "Memory scope B", description: "", instructions: "", memory: "" } });
  const projectA = await projectAResponse.json() as { id: string };
  const projectB = await projectBResponse.json() as { id: string };
  await request.post("/api/memories", { headers, data: { projectId: projectA.id, title: "Delayed A memory", content: "Must never appear in scope B.", enabled: true } });
  for (let index = 1; index <= 20; index += 1) await request.post("/api/memories", { headers, data: { projectId: projectA.id, title: `Recent A memory ${index}`, content: `A ${index}`, enabled: true } });
  await request.post("/api/memories", { headers, data: { projectId: projectB.id, title: "Only B memory", content: "Belongs to scope B.", enabled: true } });
  let releasePage!: () => void;
  let markRequested!: () => void;
  const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
  const pageRequested = new Promise<void>((resolve) => { markRequested = resolve; });
  await page.route("**/api/memories?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("projectId") === projectA.id && url.searchParams.get("offset") === "20") {
      markRequested();
      await pageGate;
      await route.continue();
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  await page.locator(".sidebar-footer-user").click();
  const drawer = page.getByRole("dialog", { name: "Personal context" });
  await drawer.getByLabel("Memory scope").selectOption(projectA.id);
  await expect(drawer.getByText("Recent A memory 20")).toBeVisible();
  const delayedResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/memories" && url.searchParams.get("projectId") === projectA.id && url.searchParams.get("offset") === "20";
  });
  await drawer.getByRole("button", { name: /Load more/ }).click();
  await pageRequested;
  await drawer.getByLabel("Memory scope").selectOption(projectB.id);
  await expect(drawer.getByText("Only B memory")).toBeVisible();
  releasePage();
  const delayedResponse = await delayedResponsePromise;
  await delayedResponse.finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(drawer.getByText("Delayed A memory")).toHaveCount(0);
  await expect(drawer.getByText("Only B memory")).toBeVisible();
});

test("stale memory pages cannot overwrite same-scope reloads", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers paginated memory management.");
  const headers = { "X-CopilotChat-CSRF": "1" };
  const projectResponse = await request.post("/api/projects", { headers, data: { name: "Memory reload scope", description: "", instructions: "", memory: "" } });
  const project = await projectResponse.json() as { id: string };
  await request.post("/api/memories", { headers, data: { projectId: project.id, title: "Delayed reload memory", content: "Must not return after reload.", enabled: true } });
  for (let index = 1; index <= 20; index += 1) await request.post("/api/memories", { headers, data: { projectId: project.id, title: `Reload memory ${index}`, content: `Reload ${index}`, enabled: true } });
  let releasePage!: () => void;
  let markRequested!: () => void;
  const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
  const pageRequested = new Promise<void>((resolve) => { markRequested = resolve; });
  await page.route("**/api/memories?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("projectId") === project.id && url.searchParams.get("offset") === "20") {
      markRequested();
      await pageGate;
    }
    await route.continue();
  });

  await page.goto("/");
  await page.locator(".sidebar-footer-user").click();
  const drawer = page.getByRole("dialog", { name: "Personal context" });
  await drawer.getByLabel("Memory scope").selectOption(project.id);
  const visibleMemory = drawer.locator(".memory-card").filter({ hasText: "Reload memory 20" });
  await expect(visibleMemory).toBeVisible();
  const delayedResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/memories" && url.searchParams.get("projectId") === project.id && url.searchParams.get("offset") === "20";
  });
  await drawer.getByRole("button", { name: /Load more/ }).click();
  await pageRequested;
  await visibleMemory.getByRole("button", { name: "Pause" }).click();
  await expect(visibleMemory.getByText("Paused", { exact: true })).toBeVisible();
  releasePage();
  const delayedResponse = await delayedResponsePromise;
  await delayedResponse.finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(drawer.getByText("Delayed reload memory")).toHaveCount(0);
  await expect(visibleMemory.getByText("Paused", { exact: true })).toBeVisible();
});

test("stale memory mutations cannot invalidate a new scope load", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers memory mutation races.");
  const headers = { "X-CopilotChat-CSRF": "1" };
  const projectA = await (await request.post("/api/projects", { headers, data: { name: "Mutation scope A", description: "", instructions: "", memory: "" } })).json() as { id: string };
  const projectB = await (await request.post("/api/projects", { headers, data: { name: "Mutation scope B", description: "", instructions: "", memory: "" } })).json() as { id: string };
  const memoryA = await (await request.post("/api/memories", { headers, data: { projectId: projectA.id, title: "Mutation A memory", content: "A", enabled: true } })).json() as { id: string };
  await request.post("/api/memories", { headers, data: { projectId: projectB.id, title: "Mutation B memory", content: "B", enabled: true } });
  let releaseMutation!: () => void;
  let markRequested!: () => void;
  const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
  const mutationRequested = new Promise<void>((resolve) => { markRequested = resolve; });
  await page.route(`**/api/memories/${memoryA.id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      markRequested();
      await mutationGate;
    }
    await route.continue();
  });

  await page.goto("/");
  await page.locator(".sidebar-footer-user").click();
  const drawer = page.getByRole("dialog", { name: "Personal context" });
  const scopeSelect = drawer.getByLabel("Memory scope");
  await scopeSelect.selectOption(projectA.id);
  const memoryCardA = drawer.locator(".memory-card").filter({ hasText: "Mutation A memory" });
  await expect(memoryCardA).toBeVisible();
  const mutationResponsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/memories/${memoryA.id}`) && response.request().method() === "PATCH");
  await memoryCardA.getByRole("button", { name: "Pause" }).click();
  await mutationRequested;
  await scopeSelect.selectOption(projectB.id);
  await expect(drawer.getByText("Mutation B memory")).toBeVisible();
  releaseMutation();
  const mutationResponse = await mutationResponsePromise;
  await mutationResponse.finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(scopeSelect).toHaveValue(projectB.id);
  await expect(drawer.getByText("Mutation B memory")).toBeVisible();
  await expect(drawer.getByText("Loading memories…")).toHaveCount(0);
  await expect(drawer.getByText("Mutation A memory")).toHaveCount(0);
});

test("superseded memory reload errors stay hidden", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers overlapping memory mutations.");
  const headers = { "X-CopilotChat-CSRF": "1" };
  const project = await (await request.post("/api/projects", { headers, data: { name: "Overlapping mutation scope", description: "", instructions: "", memory: "" } })).json() as { id: string };
  await request.post("/api/memories", { headers, data: { projectId: project.id, title: "Overlap memory A", content: "A", enabled: true } });
  await request.post("/api/memories", { headers, data: { projectId: project.id, title: "Overlap memory B", content: "B", enabled: true } });
  let memoryPageRequests = 0;
  let releaseStaleReload!: () => void;
  let markStaleReload!: () => void;
  const staleReloadGate = new Promise<void>((resolve) => { releaseStaleReload = resolve; });
  const staleReloadRequested = new Promise<void>((resolve) => { markStaleReload = resolve; });
  await page.route("**/api/memories?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("projectId") !== project.id || url.searchParams.get("offset") !== "0") {
      await route.continue();
      return;
    }
    memoryPageRequests += 1;
    if (memoryPageRequests === 2) {
      markStaleReload();
      await staleReloadGate;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "stale reload failure" }) });
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  await page.locator(".sidebar-footer-user").click();
  const drawer = page.getByRole("dialog", { name: "Personal context" });
  await drawer.getByLabel("Memory scope").selectOption(project.id);
  const memoryA = drawer.locator(".memory-card").filter({ hasText: "Overlap memory A" });
  const memoryB = drawer.locator(".memory-card").filter({ hasText: "Overlap memory B" });
  await expect(memoryA).toBeVisible();
  await expect(memoryB).toBeVisible();
  await memoryA.getByRole("button", { name: "Pause" }).click();
  await staleReloadRequested;
  await memoryB.getByRole("button", { name: "Pause" }).click();
  await expect(memoryA.getByText("Paused", { exact: true })).toBeVisible();
  await expect(memoryB.getByText("Paused", { exact: true })).toBeVisible();
  const staleResponsePromise = page.waitForResponse((response) => response.status() === 500 && response.url().includes("/api/memories?"));
  releaseStaleReload();
  await staleResponsePromise;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(drawer.locator(".field-error")).toHaveCount(0);
  await expect(drawer.getByText("Loading memories…")).toHaveCount(0);
});

test("abandoned empty chats are removed from the sidebar", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers sidebar cleanup.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.locator(".sidebar-new").click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  const firstChatId = page.url().split("/").pop() ?? "";
  await expect(page.locator(`.sidebar-row[data-chat-id="${firstChatId}"]`)).toBeVisible();
  await page.locator(".sidebar-new").click();
  await expect.poll(() => page.url()).not.toContain(firstChatId);
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  const secondChatId = page.url().split("/").pop() ?? "";
  expect(secondChatId).not.toBe(firstChatId);
  await expect(page.locator(`.sidebar-row[data-chat-id="${firstChatId}"]`)).toHaveCount(0);
  await expect(page.locator(`.sidebar-row[data-chat-id="${secondChatId}"]`)).toBeVisible();
});

test("setup banner waits until provider state has loaded", async ({ page }) => {
  let releaseState: () => void = () => {};
  let held = true;
  const stateRequested = new Promise<void>((resolve) => {
    void page.route("**/api/state", async (route) => {
      resolve();
      if (held) await new Promise<void>((release) => { releaseState = () => { held = false; release(); }; });
      await route.continue();
    });
  });
  await page.goto("/");
  await stateRequested;
  await page.waitForTimeout(150);
  await expect(page.getByRole("button", { name: "Fix setup" })).toHaveCount(0);
  await expect(page.getByText("Copilot needs authentication in this terminal.")).toHaveCount(0);
  releaseState();
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Fix setup" })).toHaveCount(0);
});

test("preferences text size slider scales the app and persists", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers preferences appearance controls.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  const defaultBodySize = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
  expect(defaultBodySize).toBeLessThan(15);
  await page.locator(".sidebar-preferences-row").click();
  const preferences = page.getByRole("dialog", { name: "Preferences" });
  await expect(preferences.getByText("Account & provider")).toBeVisible();
  await expect(preferences.locator(".settings-section-title").filter({ hasText: "Preferences" })).toBeVisible();
  await expect(preferences.getByText("Import data")).toBeVisible();
  await expect(preferences.getByText("Local app data")).toBeVisible();
  await expect(preferences.getByText("Tool permissions")).toHaveCount(0);
  await expect(preferences.getByRole("button", { name: "System" })).toBeVisible();
  await preferences.getByRole("button", { name: "System" }).click();
  await expect(preferences.getByRole("button", { name: "System" })).toHaveClass(/on/);
  const slider = page.getByLabel("Text size");
  await expect(slider).toHaveValue("95");
  await slider.fill("115");
  await expect(slider).toHaveValue("115");
  const largerBodySize = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
  expect(largerBodySize).toBeGreaterThan(defaultBodySize + 2);
  await page.reload();
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.locator(".sidebar-preferences-row").click();
  await expect(page.getByLabel("Text size")).toHaveValue("115");
  const persistedBodySize = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
  expect(persistedBodySize).toBeCloseTo(largerBodySize, 1);
});

test("preferences import starts a guided import chat", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers guided imports from Preferences.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.locator(".sidebar-preferences-row").click();
  const preferences = page.getByRole("dialog", { name: "Preferences" });
  await expect(preferences.getByText("Import data")).toBeVisible();
  await preferences.locator('input[type="file"]').setInputFiles({
    name: "chatgpt.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify([{ id: "guided-import-1", title: "Guided import conversation", current_node: "m1", mapping: { m1: { id: "m1", parent: null, children: [], message: { author: { role: "user" }, content: { content_type: "text", parts: ["Import me"] }, create_time: 1, metadata: {} } } } }])),
  });
  await expect(page.getByRole("dialog", { name: "Preferences" })).toHaveCount(0);
  await expect(page.locator(".msg.user").filter({ hasText: "Import draft ID:" })).toBeVisible();
  await expect(page.locator(".msg.user").filter({ hasText: "preview_import_draft" })).toBeVisible();
  const response = page.locator(".msg.assistant").filter({ hasText: "Import draft preview:" }).last();
  await expect(response).toBeVisible({ timeout: 15000 });
  await expect(response).toContainText("screenshots or pasted title lists");
});

test("failed guided imports discard their staged upload", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers guided import cleanup.");
  let deleteCount = 0;
  await page.route("**/api/imports/drafts", async (route) => route.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ error: "Import exceeds limit" }) }));
  await page.route("**/api/uploads/*", async (route) => { deleteCount += 1; await route.continue(); });
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.locator(".sidebar-preferences-row").click();
  await page.getByRole("dialog", { name: "Preferences" }).locator('input[type="file"]').setInputFiles({ name: "too-large.json", mimeType: "application/json", buffer: Buffer.from("{}") });

  await expect(page.getByRole("alert")).toBeVisible();
  await expect.poll(() => deleteCount).toBe(1);
});

test("composer sends attached files and pasted images", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers composer attachments.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  const composer = page.getByPlaceholder(/Ask CopilotChat|Reply in/);
  await page.locator('.composer input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("attachment notes") });
  await expect(page.locator(".attachment-tray").filter({ hasText: "notes.txt" })).toBeVisible();
  await composer.evaluate((textarea) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], "pasted.png", { type: "image/png" }));
    textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect(page.locator(".attachment-tray").filter({ hasText: "pasted.png" })).toBeVisible();
  await composer.fill("Please inspect these attachments.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.user").filter({ hasText: "notes.txt" })).toBeVisible();
  await expect(page.locator(".msg.user").filter({ hasText: "pasted.png" })).toBeVisible();
  const response = page.locator(".msg.assistant").filter({ hasText: "Attachments:" }).last();
  await expect(response).toBeVisible({ timeout: 15000 });
  await expect(response).toContainText("notes.txt");
  await expect(response).toContainText("pasted.png");
});

test("upload endpoint reports invalid metadata and limits as client errors", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers upload API errors.");
  const headers = { "Content-Type": "application/x-copilotchat-upload", "X-CopilotChat-CSRF": "1" };

  const tooLarge = await page.request.post("/api/uploads?fileName=large.bin&mimeType=application%2Foctet-stream&size=1073741825", { headers, data: Buffer.alloc(0) });
  const invalid = await page.request.post("/api/uploads?fileName=bad.bin&mimeType=application%2Foctet-stream&size=invalid", { headers, data: Buffer.alloc(0) });
  const invalidName = await page.request.post("/api/uploads?fileName=%2F&mimeType=application%2Foctet-stream&size=1", { headers, data: Buffer.from("x") });
  const sizeMismatch = await page.request.post("/api/uploads?fileName=short.bin&mimeType=application%2Foctet-stream&size=2", { headers, data: Buffer.from("x") });

  expect(tooLarge.status()).toBe(413);
  expect(invalid.status()).toBe(400);
  expect(invalidName.status()).toBe(400);
  expect(sizeMismatch.status()).toBe(400);
});

test("failed turn preparation does not persist messages or consume uploads", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers turn rollback.");
  const workspaceRoot = testInfo.outputPath("failed-turn-workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "artifacts"), "block artifact scanning");
  const csrfHeaders = { "X-CopilotChat-CSRF": "1" };
  const workspaceResponse = await page.request.post("/api/workspaces", { headers: csrfHeaders, data: { name: "Failed turn", rootPath: workspaceRoot } });
  const workspace = await workspaceResponse.json() as { id: string };
  const chatResponse = await page.request.post("/api/chats", { headers: csrfHeaders, data: { title: "Failed turn", workspaceId: workspace.id } });
  const chat = await chatResponse.json() as { id: string };
  const uploadResponse = await page.request.post("/api/uploads?fileName=retry.txt&mimeType=text%2Fplain&size=5", { headers: { ...csrfHeaders, "Content-Type": "application/x-copilotchat-upload" }, data: Buffer.from("retry") });
  const attachment = await uploadResponse.json() as MessageAttachment;

  const messageResponse = await page.request.post(`/api/chats/${chat.id}/messages`, { headers: csrfHeaders, data: { content: "This preparation should fail.", attachments: [attachment], workspaceId: workspace.id } });

  expect(messageResponse.status()).toBe(500);
  expect(await (await page.request.get(`/api/chats/${chat.id}/messages`)).json()).toEqual([]);
  const discard = await page.request.delete(`/api/uploads/${attachment.uploadId}`, { headers: csrfHeaders });
  expect(discard.ok()).toBe(true);
});

test("failed retry preparation preserves conversation history", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers retry rollback.");
  const csrfHeaders = { "X-CopilotChat-CSRF": "1" };
  const chatResponse = await page.request.post("/api/chats", { headers: csrfHeaders, data: { title: "Retry rollback" } });
  const chat = await chatResponse.json() as { id: string };
  const firstTurn = await page.request.post(`/api/chats/${chat.id}/messages`, { headers: csrfHeaders, data: { content: "Keep this history." }, timeout: 30_000 });
  expect(firstTurn.ok()).toBe(true);
  const before = await (await page.request.get(`/api/chats/${chat.id}/messages`)).json() as Array<{ id: string; role: string }>;
  const assistant = before.find((message) => message.role === "assistant")!;
  const workspaceRoot = testInfo.outputPath("failed-retry-workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "artifacts"), "block artifact scanning");
  const workspaceResponse = await page.request.post("/api/workspaces", { headers: csrfHeaders, data: { name: "Failed retry", rootPath: workspaceRoot } });
  const workspace = await workspaceResponse.json() as { id: string };
  await page.request.patch(`/api/chats/${chat.id}`, { headers: csrfHeaders, data: { workspaceId: workspace.id } });

  const retry = await page.request.post(`/api/chats/${chat.id}/messages/${assistant.id}/retry`, { headers: csrfHeaders, data: {} });

  expect(retry.status()).toBe(500);
  const after = await (await page.request.get(`/api/chats/${chat.id}/messages`)).json() as Array<{ id: string }>;
  expect(after.map((message) => message.id)).toEqual(before.map((message) => message.id));
});

test("failed edit preparation preserves conversation history", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers edit rollback.");
  const csrfHeaders = { "X-CopilotChat-CSRF": "1" };
  const chatResponse = await page.request.post("/api/chats", { headers: csrfHeaders, data: { title: "Edit rollback" } });
  const chat = await chatResponse.json() as { id: string };
  const firstTurn = await page.request.post(`/api/chats/${chat.id}/messages`, { headers: csrfHeaders, data: { content: "Keep original edit history." }, timeout: 30_000 });
  expect(firstTurn.ok()).toBe(true);
  const before = await (await page.request.get(`/api/chats/${chat.id}/messages`)).json() as Array<{ id: string; role: string; content: string }>;
  const user = before.find((message) => message.role === "user")!;
  const workspaceRoot = testInfo.outputPath("failed-edit-workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "artifacts"), "block artifact scanning");
  const workspaceResponse = await page.request.post("/api/workspaces", { headers: csrfHeaders, data: { name: "Failed edit", rootPath: workspaceRoot } });
  const workspace = await workspaceResponse.json() as { id: string };
  await page.request.patch(`/api/chats/${chat.id}`, { headers: csrfHeaders, data: { workspaceId: workspace.id } });

  const edit = await page.request.post(`/api/chats/${chat.id}/messages/${user.id}/edit`, { headers: csrfHeaders, data: { content: "This edit must roll back." } });

  expect(edit.status()).toBe(500);
  const after = await (await page.request.get(`/api/chats/${chat.id}/messages`)).json() as Array<{ id: string; content: string }>;
  expect(after.map(({ id, content }) => ({ id, content }))).toEqual(before.map(({ id, content }) => ({ id, content })));
});

test("composer retains successful files and discards each upload once", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers composer upload errors.");
  await page.route("**/api/uploads?*", async (route) => {
    const fileName = new URL(route.request().url()).searchParams.get("fileName");
    if (fileName === "bad.txt") { await route.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ error: "Upload rejected" }) }); return; }
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.locator('.composer input[type="file"]').setInputFiles([
    { name: "good.txt", mimeType: "text/plain", buffer: Buffer.from("keep me") },
    { name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from("reject me") },
  ]);

  await expect(page.locator(".attachment-tray").filter({ hasText: "good.txt" })).toBeVisible();
  await expect(page.locator(".attachment-error")).toContainText("Upload rejected");
  await expect(page.locator(".attachment-tray").filter({ hasText: "bad.txt" })).toHaveCount(0);
  let deleteCount = 0;
  await page.route("**/api/uploads/*", async (route) => { deleteCount += 1; await route.continue(); });
  await page.getByRole("button", { name: "Remove good.txt" }).click();
  await expect.poll(() => deleteCount).toBe(1);
  await expect(page.locator(".attachment-tray")).toHaveCount(0);
});

test("uploads large files in chunks when a proxy caps request bodies", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers chunked uploads.");
  const proxyLimit = 200_000;
  const rejected: number[] = [];
  await page.route("**/api/uploads**", async (route) => {
    const body = route.request().postDataBuffer();
    if (body && body.byteLength > proxyLimit) {
      rejected.push(body.byteLength);
      await route.fulfill({ status: 413, contentType: "text/html", body: "<html><head><title>413 Request Entity Too Large</title></head><body></body></html>" });
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();

  await page.locator('.composer input[type="file"]').setInputFiles({ name: "camera-photo.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(3 * 1024 * 1024, 9) });

  await expect(page.locator(".attachment-tray").filter({ hasText: "camera-photo.jpg" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".attachment-error")).toHaveCount(0);
  expect(rejected.length).toBeGreaterThan(0);
  expect(Math.max(...rejected)).toBeGreaterThan(proxyLimit);

  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Read the attached photo from its path.");
  await page.getByRole("button", { name: "Send" }).click();
  // The echo provider repeats the attachment summary, so this proves the agent received a readable path, not inline bytes.
  await expect(page.locator(".msg.assistant").last()).toContainText(".copilotchat/uploads", { timeout: 30_000 });
  await expect(page.locator(".msg.assistant").last()).toContainText("camera-photo.jpg");
});

test("explains proxy upload rejections instead of blaming chat context", async ({ page }, testInfo) => {  test.skip(testInfo.project.name !== "desktop", "Desktop covers composer upload errors.");
  await page.route("**/api/uploads?*", async (route) => {
    await route.fulfill({ status: 413, contentType: "text/html", body: "<html><head><title>413 Request Entity Too Large</title></head><body></body></html>" });
  });
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();

  await page.locator('.composer input[type="file"]').setInputFiles({ name: "IMG_9876.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(2048, 7) });

  const error = page.locator(".attachment-error");
  await expect(error).toContainText("IMG_9876.jpg");
  await expect(error).toContainText("client_max_body_size");
  await expect(error).not.toContainText("<html>");
});

test("composer retains staged uploads when message acceptance fails", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers composer submission failures.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  const composer = page.getByPlaceholder(/Ask CopilotChat|Reply in/);
  await page.locator('.composer input[type="file"]').setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("retry me") });
  await composer.fill("Please retry this.");
  await page.route("**/api/chats/*/messages", async (route) => {
    if (route.request().method() === "POST") { await route.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ error: "Message rejected" }) }); return; }
    await route.continue();
  });

  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator(".attachment-tray").filter({ hasText: "retry.txt" })).toBeVisible();
  await expect(composer).toHaveValue("Please retry this.");
  await expect(page.getByRole("alert")).toBeVisible();
});

test("composer disables attachment removal while message submission is pending", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers attachment submission races.");
  let releaseSubmission!: () => void;
  let markSubmissionStarted!: () => void;
  const submissionBlocked = new Promise<void>((resolve) => { releaseSubmission = resolve; });
  const submissionStarted = new Promise<void>((resolve) => { markSubmissionStarted = resolve; });
  await page.route("**/api/chats/*/messages", async (route) => {
    if (route.request().method() === "POST") {
      markSubmissionStarted();
      await submissionBlocked;
      await route.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ error: "Message rejected" }) });
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.locator('.composer input[type="file"]').setInputFiles({ name: "pending-submit.txt", mimeType: "text/plain", buffer: Buffer.from("keep staged") });
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Hold this submission.");
  await page.getByRole("button", { name: "Send" }).click();
  await submissionStarted;

  const remove = page.getByRole("button", { name: "Remove pending-submit.txt" });
  await expect(remove).toBeDisabled();
  releaseSubmission();
  await expect(remove).toBeEnabled();
  await remove.click();
});

test("composer disables submission while selected files are uploading", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers pending uploads.");
  let releaseUpload!: () => void;
  let markUploadStarted!: () => void;
  const uploadBlocked = new Promise<void>((resolve) => { releaseUpload = resolve; });
  const uploadStarted = new Promise<void>((resolve) => { markUploadStarted = resolve; });
  await page.route("**/api/uploads?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("fileName") === "pending.txt") { markUploadStarted(); await uploadBlocked; }
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  const selecting = page.locator('.composer input[type="file"]').setInputFiles({ name: "pending.txt", mimeType: "text/plain", buffer: Buffer.from("pending") });
  await uploadStarted;
  const composer = page.getByPlaceholder(/Ask CopilotChat|Reply in/);
  await composer.fill("Wait for the file.");

  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  releaseUpload();
  await selecting;
  await expect(page.locator(".attachment-tray").filter({ hasText: "pending.txt" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await page.getByRole("button", { name: "Remove pending.txt" }).click();
});

test("Escape discards staged composer uploads", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers slash-menu resets.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.locator('.composer input[type="file"]').setInputFiles({ name: "escape.txt", mimeType: "text/plain", buffer: Buffer.from("discard me") });
  let deleteCount = 0;
  await page.route("**/api/uploads/*", async (route) => { deleteCount += 1; await route.continue(); });
  const composer = page.getByPlaceholder(/Ask CopilotChat|Reply in/);
  await composer.fill("/");
  await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();

  await composer.press("Escape");

  await expect(page.locator(".attachment-tray")).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect.poll(() => deleteCount).toBe(1);
});

test("composer shows slash command autocomplete with descriptions", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers slash command suggestions.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  const composer = page.getByPlaceholder(/Ask CopilotChat|Reply in/);
  await composer.fill("/");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option", { name: /\/research/i })).toContainText("Research current technical information");
  await composer.pressSequentially("res");
  await expect(menu.getByRole("option", { name: /\/research/i })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("Use Research: ");
});

test("installed skills auto-trigger by rules and explicit name", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers skill management.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.getByRole("button", { name: "Open composer options" }).click();
  await page.getByRole("dialog", { name: "Composer options" }).getByRole("button", { name: /Skills/ }).click();
  await page.getByRole("button", { name: "Manage" }).click();
  await page.getByRole("button", { name: "New skill" }).click();
  await page.getByLabel("Skill name").fill("Haiku helper");
  await page.getByLabel("Short description").fill("Writes tiny poems.");
  await page.getByLabel("Instructions").fill("When active, mention haiku helper.");
  await page.getByLabel("Activation rules").fill("User asks for a poem");
  await page.getByRole("button", { name: "Install skill" }).click();
  await expect(page.locator(".toggle-card").filter({ hasText: "Haiku helper" })).toContainText("installed");
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Please write a poem.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant .msg-body").filter({ hasText: "Enabled skills: Haiku helper." }).last()).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Use Haiku helper for this.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant .msg-body").filter({ hasText: "Enabled skills: Haiku helper." }).last()).toBeVisible({ timeout: 15000 });
});

test("assistant can auto-title chats until the user renames them", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers chat title updates.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Durable chat naming patterns across products need short summaries.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant").filter({ hasText: "Configure Copilot auth/provider settings" }).last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".sidebar-row-title").filter({ hasText: "Durable chat naming patterns across products" }).first()).toBeVisible();
  await expect(page.getByText("set_conversation_title")).toHaveCount(0);
  await page.locator(".sidebar-row.active .sidebar-row-menu").click({ force: true });
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("dialog", { name: "Rename chat" }).getByLabel("Chat title").fill("Manual title stays");
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(page.locator(".sidebar-row-title").filter({ hasText: "Manual title stays" }).first()).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("A completely different topic should not overwrite this manual title.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant").filter({ hasText: "Configure Copilot auth/provider settings" }).last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".sidebar-row-title").filter({ hasText: "Manual title stays" }).first()).toBeVisible();
  await expect(page.locator(".sidebar-row-title").filter({ hasText: "completely different topic" })).toHaveCount(0);
});

test("chat header reports AI credit usage as it accumulates", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers the header usage readout.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  const usagePill = page.locator(".usage-pill");
  await expect(usagePill).toHaveCount(0);
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("First note about credits.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant").filter({ hasText: "Configure Copilot auth/provider settings" }).last()).toBeVisible({ timeout: 15000 });
  await expect(usagePill).toHaveText("0.43 AIC");
  await expect(page.locator(".msg.assistant .msg-usage").last()).toHaveText("0.43 AIC");
  await usagePill.click();
  const details = page.getByRole("dialog", { name: "AI credit usage" });
  await expect(details).toContainText("0.43 AIC used in this chat.");
  await expect(details).toContainText("0.43 AIC in the latest response.");
  await page.keyboard.press("Escape");
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Second note about credits.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(usagePill).toHaveText("0.86 AIC", { timeout: 15000 });
  await page.reload();
  await expect(usagePill).toHaveText("0.86 AIC");
  await usagePill.click();
  await expect(details).toContainText("0.86 AIC used in this chat.");
  await expect(details).toContainText("0.43 AIC in the latest response.");
});

test("long code blocks scroll horizontally without page overflow", async ({ page }, testInfo) => {  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  if (testInfo.project.name === "desktop") {
    await page.locator(".sidebar-new").click();
    await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  }
  const longCode = `const value = "${"x".repeat(700)}";`;
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill(`Please keep this code readable:\n\n\`\`\`js\n${longCode}\n\`\`\``);
  await page.getByRole("button", { name: "Send" }).click();
  const pre = page.locator(".msg.user .code-block pre").last();
  await expect(pre).toBeVisible();
  const metrics = await pre.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth + 100);
  const pageOverflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  expect(pageOverflows).toBe(false);
  const bottomClearance = await pre.evaluate((element) => {
    const scroll = document.querySelector(".scroll");
    if (scroll instanceof HTMLElement) scroll.scrollTop = scroll.scrollHeight;
    const message = element.closest(".msg");
    const composer = document.querySelector(".composer");
    if (!(message instanceof HTMLElement) || !(composer instanceof HTMLElement)) return null;
    return composer.getBoundingClientRect().top - message.getBoundingClientRect().bottom;
  });
  expect(bottomClearance).not.toBeNull();
  expect(bottomClearance!).toBeGreaterThanOrEqual(8);
  await page.getByRole("button", { name: "Stop" }).first().click({ force: true, timeout: 500 }).catch((error: unknown) => {
    if (!String(error).includes("locator.click")) throw error;
  });
});

test("mobile assistant markdown stays within the viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile viewport regression.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  const longToken = `urlcheck_${"segment_".repeat(22)}done`;
  await page.getByPlaceholder(/Ask CopilotChat/).fill(`Recommended sequence:

1. Pick one real use case: e.g. notes add, todo list, ${longToken}
2. Define the command contract before coding: command names, flags, output, and error codes.

| Need | Use |
| --- | --- |
| Declarative app structure ${longToken} | urfave/cli |
| Releases/build artifacts | GoReleaser |`);
  await page.getByRole("button", { name: "Send" }).click();
  const response = page.locator(".msg.assistant").filter({ hasText: "Recommended sequence" }).last();
  await expect(response).toBeVisible({ timeout: 15000 });
  const overflowing = await page.evaluate(() => [...document.querySelectorAll(".thread, .msg, .msg-body")].some((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left < -2 || rect.right > window.innerWidth + 2;
  }));
  expect(overflowing).toBe(false);
});

test("mobile tool call details scroll inside the activity card", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile viewport regression.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat/).fill("Please show a long tool payload to test tool overflow.");
  await page.getByRole("button", { name: "Send" }).click();
  const response = page.locator(".msg.assistant").filter({ hasText: "Configure Copilot auth/provider settings" }).last();
  await expect(response).toBeVisible({ timeout: 15000 });
  const tool = response.locator(".activity-card.tool").filter({ hasText: "bash" }).last();
  await tool.locator(":scope > summary").click();
  await expect(tool.locator(".structured-field dt").filter({ hasText: /^Command$/ })).toBeVisible();
  const commandFieldMetrics = await tool.locator(".structured-field").evaluateAll((fields) => {
    const field = fields.find((item) => item.querySelector("dt")?.textContent?.trim() === "Command");
    const value = field?.querySelector("dd");
    return value ? { scrollHeight: value.scrollHeight, clientHeight: value.clientHeight } : null;
  });
  expect(commandFieldMetrics).not.toBeNull();
  expect(commandFieldMetrics!.scrollHeight).toBeGreaterThan(commandFieldMetrics!.clientHeight + 20);
  expect(commandFieldMetrics!.clientHeight).toBeLessThanOrEqual(160);
  const raw = tool.locator(".activity-raw").first();
  await expect(raw).not.toHaveAttribute("open", "");
  await raw.locator("summary").click();
  const pre = raw.locator(".code-block pre");
  await expect(pre).toBeVisible();
  const metrics = await pre.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    cardRight: element.closest(".activity-card")?.getBoundingClientRect().right ?? 0,
    viewportWidth: window.innerWidth,
    pageScrollWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth + 100);
  expect(metrics.cardRight).toBeLessThanOrEqual(metrics.viewportWidth + 2);
  expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 2);
});

test("browser back closes app surfaces before leaving", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers browser back guard.");
  await page.goto("/");
  const appUrl = page.url();
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.locator(".sidebar-preferences-row").click();
  await expect(page.getByRole("dialog", { name: "Preferences" })).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("dialog", { name: "Preferences" })).toHaveCount(0);
  expect(page.url()).toBe(appUrl);
  await page.evaluate(() => history.back());
  await expect(page.getByText("Press Back again to leave CopilotChat")).toBeVisible();
  expect(page.url()).toBe(appUrl);
});

test("context menus and popups dismiss when touching elsewhere", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers pointer dismissal behavior.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  const contextRing = page.getByRole("button", { name: /Context:/ });
  await contextRing.click();
  await expect(page.locator("#context-details")).toBeVisible();
  await page.locator(".scroll").click({ position: { x: 12, y: 12 } });
  await expect(page.locator("#context-details")).toHaveCount(0);
  await contextRing.click();
  await expect(page.locator("#context-details")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#context-details")).toHaveCount(0);

  await page.locator(".sidebar-new").click();
  const chatActions = page.locator(".sidebar-row.active .sidebar-row-menu").last();
  await chatActions.click({ force: true });
  await expect(page.getByRole("menu", { name: "Chat actions menu" })).toBeVisible();
  await page.locator(".scroll").click({ position: { x: 12, y: 12 } });
  await expect(page.getByRole("menu", { name: "Chat actions menu" })).toHaveCount(0);
  await chatActions.click({ force: true });
  await expect(page.getByRole("menu", { name: "Chat actions menu" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Chat actions menu" })).toHaveCount(0);
});

test("refresh reconnects to an in-progress response", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers refresh-safe streaming.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  const prompt = `Refresh persistence ${"long context ".repeat(900)}`;
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.user").filter({ hasText: "Refresh persistence" })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  await expect(page.locator(".msg.assistant .msg-body").filter({ hasText: "Refresh persistence" }).last()).toBeVisible({ timeout: 15000 });
});

test("chat list indicates running and unread background chats", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers sidebar chat indicators.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill(`Background indicator ${"keep streaming ".repeat(1200)}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  const backgroundChatId = page.url().split("/").pop() ?? "";
  const backgroundRow = page.locator(`.sidebar-row[data-chat-id="${backgroundChatId}"]`);
  await expect(backgroundRow.locator(".chat-indicator.running")).toBeVisible();
  await page.locator(".sidebar-new").click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  await expect(backgroundRow.locator(".chat-indicator.running")).toBeVisible();
  await expect(backgroundRow.locator(".chat-indicator.unread")).toBeVisible({ timeout: 15000 });
  await backgroundRow.click();
  await expect(backgroundRow.locator(".chat-indicator.unread")).toHaveCount(0);
});

test("assistant responses stream incrementally before the final message is saved", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers streaming behavior.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill(`Streaming regression ${"keep streaming ".repeat(1200)}`);
  await page.getByRole("button", { name: "Send" }).click();
  const streamingResponse = page.locator(".msg.assistant").filter({ has: page.locator(".cursor") }).last();
  await expect(streamingResponse).toContainText("I am running with the local development provider");
  await expect(streamingResponse).not.toContainText("Configure Copilot auth/provider settings");
  await expect(page.locator(".msg.assistant").filter({ hasText: "Configure Copilot auth/provider settings" }).last()).toBeVisible({ timeout: 15000 });
});

test("editing works after stopping an in-progress response", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers stop/edit behavior.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill(`Stop then edit ${"keep streaming ".repeat(1200)}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.user").filter({ hasText: "Stop then edit" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  const userMessage = page.locator(".msg.user").filter({ hasText: "Stop then edit" }).last();
  await expect(userMessage.getByRole("button", { name: "Edit message" })).toBeEnabled();
  await userMessage.getByRole("button", { name: "Edit message" }).click();
  await page.getByRole("textbox", { name: "Edit message" }).fill("Edited after stopping.");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.locator(".msg.assistant").filter({ hasText: "You said: Edited after stopping." }).last()).toBeVisible({ timeout: 15000 });
});

test("assistant thinking and tool use render as expandable activity", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers assistant activity rendering.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill(`Please show thinking and tool use. ${"keep it observable ".repeat(500)}`);
  await page.getByRole("button", { name: "Send" }).click();
  const streamingResponse = page.locator(".msg.assistant").filter({ has: page.locator(".cursor") }).last();
  await expect(streamingResponse.locator(".cursor-intent")).toContainText("Inspecting context");
  await expect(streamingResponse.locator(".activity-card.tool > summary")).not.toContainText("report_intent");
  await expect(streamingResponse.locator(".activity-card.reasoning > summary")).toContainText("Thinking");
  await expect(streamingResponse.locator(".activity-card.tool > summary")).toContainText("context.inspect");
  await expect(streamingResponse.locator(".activity-card.tool")).not.toHaveAttribute("open", "");
  const finalResponse = page.locator(".msg.assistant").filter({ hasText: "Configure Copilot auth/provider settings" }).last();
  await expect(finalResponse).toBeVisible({ timeout: 15000 });
  await expect(finalResponse.locator(".cursor-intent")).toHaveCount(0);
  await expect(finalResponse.locator(".activity-card.tool > summary")).not.toContainText("report_intent");
  await expect(finalResponse.locator(".activity-card.reasoning > summary")).toContainText("Thinking");
  await expect(finalResponse.locator(".activity-card.tool")).not.toHaveAttribute("open", "");
  const statusAlignment = await finalResponse.locator(".activity-card.tool > summary").first().evaluate((summary) => {
    const status = summary.querySelector(".activity-status")?.getBoundingClientRect();
    const bounds = summary.getBoundingClientRect();
    return status ? { statusLeftOffset: status.left - bounds.left, statusRightGap: bounds.right - status.right, width: bounds.width } : null;
  });
  expect(statusAlignment).not.toBeNull();
  expect(statusAlignment!.statusLeftOffset).toBeGreaterThan(statusAlignment!.width * 0.65);
  expect(statusAlignment!.statusRightGap).toBeLessThan(56);
  await finalResponse.locator(".activity-card.reasoning > summary").click();
  await expect(finalResponse.locator(".activity-card.reasoning")).toContainText("Checking the active chat context");
  await finalResponse.locator(".activity-card.tool > summary").click();
  await expect(finalResponse.locator(".activity-card.tool")).toContainText("context.inspect");
  await expect(finalResponse.locator(".activity-card.tool .structured-field").filter({ hasText: "Provider" })).toContainText("echo");
  await expect(finalResponse.locator(".activity-card.tool .activity-raw")).toHaveCount(2);
  await expect(finalResponse.locator(".activity-card.tool .activity-raw").first()).not.toHaveAttribute("open", "");
});

test("long tool-call runs collapse into an expandable group", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers assistant activity rendering.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Please show many tool calls for a tool call group.");
  await page.getByRole("button", { name: "Send" }).click();
  const finalResponse = page.locator(".msg.assistant").filter({ hasText: "Configure Copilot auth/provider settings" }).last();
  await expect(finalResponse).toBeVisible({ timeout: 15000 });
  const group = finalResponse.locator(".activity-list:not(.nested) > .activity-card.tool-group").first();
  const groupSummary = group.locator(":scope > summary");
  await expect(groupSummary).toContainText("6 tool calls");
  await expect(groupSummary).toContainText("context.inspect ×1");
  await expect(groupSummary).toContainText("context.step_1 ×1");
  await expect(groupSummary).toContainText("5 succeeded");
  await expect(groupSummary).toContainText("1 failed");
  const headingMetrics = await groupSummary.evaluate((summary) => {
    const title = summary.querySelector(".activity-title")?.getBoundingClientRect();
    const subtitle = summary.querySelector(".tool-kind-summary")?.getBoundingClientRect();
    return title && subtitle ? { titleBottom: title.bottom, subtitleTop: subtitle.top } : null;
  });
  expect(headingMetrics).not.toBeNull();
  expect(headingMetrics!.subtitleTop).toBeGreaterThanOrEqual(headingMetrics!.titleBottom - 1);
  await expect(group).not.toHaveAttribute("open", "");
  await expect(finalResponse.locator(".activity-list:not(.nested) > .activity-card.tool")).toHaveCount(0);
  await groupSummary.click();
  const nestedTools = group.locator(".activity-list.tool-group-list > .activity-card.tool");
  await expect(nestedTools).toHaveCount(6);
  await expect(nestedTools.first().locator(":scope > summary")).toContainText("context.inspect");
  await expect(nestedTools.nth(5).locator(":scope > summary")).toContainText("context.step_5");
});

test("task lists show progress and can collapse", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers task-list rendering.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Please create a task list with progress.");
  await page.getByRole("button", { name: "Send" }).click();
  const finalResponse = page.locator(".msg.assistant").filter({ hasText: "Configure Copilot auth/provider settings" }).last();
  await expect(finalResponse).toBeVisible({ timeout: 15000 });
  const taskList = finalResponse.locator(".task-list-card").last();
  await expect(taskList).toContainText("2/3 complete");
  await expect(taskList.getByRole("progressbar", { name: "67% complete" })).toHaveAttribute("aria-valuenow", "67");
  await expect(taskList.locator(".task-list-row")).toHaveCount(3);
  await expect(taskList).toHaveAttribute("open", "");
  await taskList.locator("summary").evaluate((element) => element.scrollIntoView({ block: "center" }));
  await taskList.locator("summary").click();
  await expect(taskList).not.toHaveAttribute("open", "");
  await expect(taskList.locator(".task-list-items")).toBeHidden();
});

test("agent questions and tool permissions are interactive, with auto-approval", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers agent interaction prompts.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Please ask me a question and request permission.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Agent question")).toBeVisible();
  await expect(page.getByText("ask_user").first()).toBeVisible();
  await page.getByRole("button", { name: "alpha" }).click();
  await expect(page.getByText(/Allow shell permission/)).toBeVisible();
  await expect(page.locator(".interaction-detail")).toContainText("echo hello");
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.locator(".msg.assistant").filter({ hasText: "User answered: alpha." }).last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".msg.assistant").filter({ hasText: "Permission decision: approved." }).last()).toBeVisible();

  await page.locator(".sidebar-new").click();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Please request a URL permission.");
  await page.getByRole("button", { name: "Send" }).click();
  const urlPermission = page.locator(".thread .interaction-card.permission").last();
  await expect(urlPermission).toContainText("Allow URL permission");
  await expect(urlPermission).toContainText("https://example.com/docs");
  await expect(urlPermission.locator(".interaction-detail")).toContainText("web.fetch");
  await expect(urlPermission.locator(".interaction-detail")).toContainText("GET");
  await page.getByRole("button", { name: "Open composer options" }).click();
  await page.getByRole("dialog", { name: "Composer options" }).getByRole("button", { name: /Tool permissions/ }).click();
  await page.getByRole("button", { name: "Auto-approve tool requests" }).click();
  await expect(page.locator(".thread .interaction-card.permission")).toHaveCount(0);
  await expect(page.locator(".msg.assistant").filter({ hasText: "Permission decision: approved." }).last()).toBeVisible({ timeout: 15000 });

  await page.getByRole("button", { name: "Open composer options" }).click();
  await page.getByRole("dialog", { name: "Composer options" }).getByRole("button", { name: /Tool permissions/ }).click();
  await page.getByRole("button", { name: "Auto-approve tool requests" }).click();
  await expect(page.getByRole("button", { name: "Tool auto-approval is on" })).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Please request permission.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Allow shell permission/)).toHaveCount(0);
  await expect(page.locator(".msg.assistant").filter({ hasText: "Permission decision: approved (yolo)." }).last()).toBeVisible({ timeout: 15000 });
});

test("subagent work renders as collapsible activity", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers subagent activity rendering.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill("Please delegate this to a subagent.");
  await page.getByRole("button", { name: "Send" }).click();
  const finalResponse = page.locator(".msg.assistant").filter({ hasText: "Configure Copilot auth/provider settings" }).last();
  await expect(finalResponse).toBeVisible({ timeout: 15000 });
  const subagent = finalResponse.locator(".activity-list:not(.nested) > .activity-card.subagent").filter({ hasText: "Research helper" }).first();
  await expect(subagent.locator("summary").first()).toContainText("Research helper");
  await expect(subagent).not.toHaveAttribute("open", "");
  await subagent.locator("summary").first().click();
  await expect(subagent).toContainText("Inspect project context");
  await expect(subagent).toContainText("Found shared project context");
  await expect(subagent.locator(".subagent-usage")).toHaveText("0.08 AIC used by this subagent");
  await expect(subagent.locator(".subagent-detail")).not.toContainText("nanoAiu");
  await expect(subagent.locator(".activity-card.reasoning")).toContainText("Thinking");
  await expect(subagent.locator(".activity-card.tool > summary")).toContainText("context.search");
  await subagent.locator(".activity-card.tool > summary").click();
  await expect(subagent.locator(".activity-card.tool .structured-field").filter({ hasText: "Matches" })).toContainText("2");
});

test("users can steer and queue while a response is running", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers running composer controls.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill(`Start a long response ${"keep streaming ".repeat(1600)}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant").filter({ has: page.locator(".cursor") }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Open composer options" })).toBeEnabled();
  await page.getByRole("button", { name: "Open composer options" }).click();
  await page.getByRole("dialog", { name: "Composer options" }).getByRole("button", { name: /Attach files/ }).click();
  await page.locator('.composer input[type="file"]').setInputFiles({ name: "steer-note.txt", mimeType: "text/plain", buffer: Buffer.from("steer attachment") });
  await expect(page.locator(".attachment-tray").filter({ hasText: "steer-note.txt" })).toBeVisible();
  await page.getByRole("button", { name: "Open composer options" }).click();
  await page.getByRole("dialog", { name: "Composer options" }).getByRole("button", { name: /Tool permissions/ }).click();
  await page.getByRole("button", { name: "Auto-approve tool requests" }).click();
  await expect(page.getByRole("button", { name: "Tool auto-approval is on" })).toBeVisible();
  await page.getByPlaceholder(/Steer or queue/).fill("Please steer this response.");
  const steerButton = page.getByRole("button", { name: "Steer response" });
  await expect(steerButton).toBeEnabled();
  expect((await steerButton.boundingBox())?.width ?? 0).toBeLessThanOrEqual(44);
  await steerButton.focus();
  await expect(page.locator(".composer-action-tooltip").filter({ hasText: "currently running" })).toHaveCSS("opacity", "1");
  await steerButton.click({ force: true });
  await expect(page.locator(".pending-turn.steer").filter({ hasText: "Please steer this response." })).toContainText("Sent live");
  await expect(page.locator(".attachment-tray")).toHaveCount(0);
  await page.getByPlaceholder(/Steer or queue/).fill("Queued follow up.");
  await page.locator('.composer input[type="file"]').setInputFiles({ name: "queued-note.txt", mimeType: "text/plain", buffer: Buffer.from("queued attachment") });
  await expect(page.locator(".attachment-tray").filter({ hasText: "queued-note.txt" })).toBeVisible();
  const queueButton = page.getByRole("button", { name: "Queue message" });
  await expect(queueButton).toBeEnabled();
  expect((await queueButton.boundingBox())?.width ?? 0).toBeLessThanOrEqual(44);
  await queueButton.focus();
  await expect(page.locator(".composer-action-tooltip").filter({ hasText: "after the current response finishes" })).toHaveCSS("opacity", "1");
  await queueButton.dispatchEvent("pointerdown", { pointerType: "touch", bubbles: true });
  await page.waitForTimeout(500);
  await expect(page.locator(".composer-action-tooltip").filter({ hasText: "Queue message" })).toHaveCSS("opacity", "1");
  await queueButton.dispatchEvent("pointerup", { pointerType: "touch", bubbles: true });
  await page.keyboard.press("Enter");
  await expect(page.locator(".pending-turn.queue").filter({ hasText: "Queued follow up." })).toContainText(/queued|running|done/i);
  await expect(page.locator(".msg.assistant").filter({ hasText: "Steering received: Please steer this response." }).last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".msg.assistant").filter({ hasText: "Steering attachments: steer-note.txt" }).last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".msg.user").filter({ hasText: "Queued follow up." }).last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".msg.user").filter({ hasText: "queued-note.txt" }).last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".msg.assistant").filter({ hasText: "You said: Queued follow up." }).last()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".msg.assistant").filter({ hasText: "Attachments: queued-note.txt" }).last()).toBeVisible({ timeout: 15000 });
});

test("message POST rejects payloads while a response is active", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers active response message routing.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat/).fill(`Start a long response ${"keep streaming ".repeat(1600)}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant").filter({ has: page.locator(".cursor") }).last()).toBeVisible();
  const chatId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
  const upload = await page.request.post("/api/uploads?fileName=active.txt&mimeType=text%2Fplain&size=6", { headers: { "Content-Type": "application/x-copilotchat-upload", "X-CopilotChat-CSRF": "1" }, data: Buffer.from("active") });
  expect(upload.ok()).toBe(true);
  const attachment = await upload.json() as MessageAttachment;

  const response = await page.request.post(`/api/chats/${chatId}/messages`, { headers: { "X-CopilotChat-CSRF": "1" }, data: { content: "Do not ignore this.", attachments: [attachment] } });

  expect(response.status()).toBe(409);
  const discard = await page.request.delete(`/api/uploads/${attachment.uploadId}`, { headers: { "X-CopilotChat-CSRF": "1" } });
  expect(discard.ok()).toBe(true);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});

test("chat viewport follows live updates and can jump back to live", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers chat viewport scrolling.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  const scroll = page.locator(".scroll");
  const distanceFromBottom = () => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill(`Live scroll seed ${"long content ".repeat(900)}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant").filter({ hasText: "Configure Copilot auth/provider settings" }).last()).toBeVisible({ timeout: 15000 });
  await expect.poll(() => scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(200);
  await expect.poll(distanceFromBottom).toBeLessThan(120);
  await expect(page.getByRole("button", { name: "Jump to live" })).toHaveCount(0);
  await scroll.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await expect(page.getByRole("button", { name: "Jump to live" })).toBeVisible();
  const firstChatId = page.url().split("/").pop() ?? "";
  await page.locator(".sidebar-new").click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  await page.locator(`.sidebar-row[data-chat-id="${firstChatId}"]`).click();
  await expect(page.locator(".msg.user").filter({ hasText: "Live scroll seed" })).toBeVisible();
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeLessThan(80);
  await expect(page.getByRole("button", { name: "Jump to live" })).toBeVisible();
  await page.getByRole("button", { name: "Jump to live" }).click();
  await expect.poll(distanceFromBottom).toBeLessThan(120);
  await expect(page.getByRole("button", { name: "Jump to live" })).toHaveCount(0);
  await page.getByPlaceholder(/Ask CopilotChat|Reply in/).fill(`Live follow ${"streamed update ".repeat(900)}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant").filter({ has: page.locator(".cursor") }).last()).toContainText("I am running with the local development provider");
  await expect.poll(distanceFromBottom).toBeLessThan(120);
  await expect(page.getByRole("button", { name: "Jump to live" })).toHaveCount(0);
});

test("a backgrounded response never streams into the visible chat", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers concurrent chat streaming.");
  await page.goto("/");
  await page.locator(".sidebar-new").click();
  await page.getByPlaceholder(/Ask CopilotChat/).fill(`Start a long response ALPHAMARKER. ${"Keep streaming this response. ".repeat(750)}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant").filter({ has: page.locator(".cursor") }).last()).toContainText("I am running with the local development provider");
  const alphaChatId = page.url().split("/").pop() ?? "";

  await page.locator(".sidebar-new").click();
  await expect(page).toHaveURL(/\/chats\/[^/]+$/);
  await expect(page.locator(`.sidebar-row[data-chat-id="${alphaChatId}"] .chat-indicator.running`)).toBeVisible();
  await expect(page.locator(".thread .msg")).toHaveCount(0);
  await page.waitForTimeout(1500);
  await expect(page.locator(".thread .msg")).toHaveCount(0);

  await page.getByPlaceholder(/Ask CopilotChat/).fill("BETAMARKER stays alone in this chat.");
  await page.getByRole("button", { name: "Send" }).click();
  const betaResponse = page.locator(".msg.assistant .msg-body").last();
  await expect(betaResponse).toContainText("BETAMARKER stays alone in this chat.");
  await expect(betaResponse).not.toContainText("Keep streaming this response.");
  await expect(page.locator(".msg.user")).toHaveCount(1);

  await page.locator(`.sidebar-row[data-chat-id="${alphaChatId}"]`).click();
  await expect(page.locator(".msg.user").filter({ hasText: "ALPHAMARKER" })).toBeVisible();
  const alphaResponse = page.locator(".msg.assistant .msg-body").last();
  await expect(alphaResponse).toContainText("Keep streaming this response.", { timeout: 30000 });
  await expect(alphaResponse).not.toContainText("BETAMARKER");
  await expect(page.locator(".msg.user")).toHaveCount(1);
});

test("guided import starts its chat while another chat is generating", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Desktop covers guided imports from Preferences.");
  await page.goto("/");
  await expect(page.getByText(/Back at it/i)).toBeVisible();
  await page.getByPlaceholder(/Ask CopilotChat/).fill(`Start a long response ${"keep streaming ".repeat(900)}`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".msg.assistant").filter({ has: page.locator(".cursor") }).last()).toBeVisible();
  await page.locator(".sidebar-preferences-row").click();
  const preferences = page.getByRole("dialog", { name: "Preferences" });
  await expect(preferences.getByText("Import data")).toBeVisible();
  await preferences.locator('input[type="file"]').setInputFiles({
    name: "chatgpt.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify([{ id: "busy-import-1", title: "Busy import conversation", current_node: "m1", mapping: { m1: { id: "m1", parent: null, children: [], message: { author: { role: "user" }, content: { content_type: "text", parts: ["Import me"] }, create_time: 1, metadata: {} } } } }])),
  });
  await expect(page.getByRole("dialog", { name: "Preferences" })).toHaveCount(0);
  await expect(page.locator(".msg.user").filter({ hasText: "Import draft ID:" })).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".msg.user")).toHaveCount(1);
});
