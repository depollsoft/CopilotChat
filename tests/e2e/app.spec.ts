import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

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
  await page.getByRole("button", { name: "Manage" }).click();
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
  await page.locator(".project-summary-card.editable").filter({ hasText: "Memory" }).click();
  await page.getByRole("dialog", { name: "Edit memory" }).getByLabel("Project context editor").fill("Landing memory.");
  await page.getByRole("button", { name: "Save changes" }).click();
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

test("long code blocks scroll horizontally without page overflow", async ({ page }, testInfo) => {
  await page.goto("/");
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
