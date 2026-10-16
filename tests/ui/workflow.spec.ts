import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const signin = async (page: any) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Continue as Alice", exact: false })
    .click();
  await expect(page.getByText("Source collection")).toBeVisible();
};
test("desktop compare, inspect evidence, download, reconnect and user isolation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("/");
  expect(await page.title()).toContain("Document Intelligence");
  await page.screenshot({ path: "/tmp/docintel-welcome.png", fullPage: true });
  await page
    .getByRole("button", { name: "Continue as Alice", exact: false })
    .click();
  await page
    .getByRole("button", { name: "Compare the 2024 annual reports" })
    .click();
  await expect(page.getByRole("status")).toContainText("completed", {
    timeout: 15000,
  });
  await expect(page.getByText("BETA revenue exceeds ACME")).toBeVisible();
  await page.locator("summary").filter({ hasText: "acme-2024" }).click();
  await expect(page.locator("blockquote").first()).toContainText(
    "ACME revenue was USD 94.2",
  );
  await page.locator("summary").filter({ hasText: "Analysis details" }).click();
  await expect(page.getByText("Unavailable in local mock mode")).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "KPI CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("kpis.csv");
  expect(await readFile((await download.path())!, "utf8")).toContain(
    "ACME,2024,94.2",
  );
  await page.screenshot({
    path: "/tmp/docintel-completed-desktop.png",
    fullPage: true,
  });
  await page.reload();
  await expect(page.getByRole("status")).toContainText("completed");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Continue as Bob" }).click();
  await expect(page.locator("aside .doc")).toHaveCount(1);
  await expect(page.getByText("BETA · Annual report")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("mobile entry and comparison have no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signin(page);
  await page
    .getByRole("button", { name: "Compare the 2024 annual reports" })
    .click();
  await expect(page.getByRole("status")).toContainText("completed", {
    timeout: 15000,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/docintel-completed-mobile.png",
    fullPage: true,
  });
});
test("cancellation is requested then confirmed", async ({ page }) => {
  await signin(page);
  await page
    .getByRole("button", { name: "Compare the 2024 annual reports" })
    .click();
  await page.getByRole("button", { name: "Request cancellation" }).click();
  await expect(page.getByRole("status")).toContainText("cancelled", {
    timeout: 15000,
  });
  await expect(page.getByRole("button", { name: "KPI CSV" })).toHaveCount(0);
});
test("lost POST response retries with the same durable request ID", async ({
  page,
}) => {
  await signin(page);
  const ids: string[] = [];
  let first = true;
  await page.route("**/api/analyses", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    ids.push(route.request().postDataJSON().requestId);
    if (first) {
      first = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Compare the 2024 annual reports" })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry saved analysis safely" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry saved analysis safely" })
    .click();
  await expect(page.getByRole("status")).toContainText("completed", {
    timeout: 15000,
  });
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
});
test("a rejected short question can be corrected without a stuck pending request", async ({
  page,
}) => {
  await signin(page);
  await page.getByRole("textbox", { name: "Analysis question" }).fill("hi");
  await page.getByRole("button", { name: "Analyze", exact: false }).click();
  await expect(page.getByRole("alert")).toContainText("invalid request");
  await expect(
    page.getByRole("button", { name: "Retry saved analysis safely" }),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Analysis question" })
    .fill("Compare annual reports");
  await page.getByRole("button", { name: "Analyze", exact: false }).click();
  await expect(page.getByRole("status")).toContainText("completed", {
    timeout: 15000,
  });
});
test("a delayed private source cannot reappear after switching users", async ({
  page,
}) => {
  await signin(page);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/documents/beta-2024", async (route) => {
    const r = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response: r });
  });
  await page.getByRole("button", { name: "Read BETA" }).click();
  await begun;
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Continue as Bob" }).click();
  release();
  await expect(page.locator("aside .doc")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
