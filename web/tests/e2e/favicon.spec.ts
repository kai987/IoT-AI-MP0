import { expect, test } from "@playwright/test";

test("favicon loads under the deployment base and the game remains usable", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("./");
  await expect(page).toHaveTitle("Emotion Runner");
  await expect(page.getByRole("heading", { name: "Emotion Runner" })).toBeVisible();
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute("type", "image/svg+xml");
  const iconUrl = await icon.evaluate((element: HTMLLinkElement) => element.href);
  expect(iconUrl).toBe(new URL("favicon.svg", page.url()).href);
  const response = await request.get(iconUrl);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/svg+xml");
  const dimensions = await page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  }, iconUrl);
  expect(dimensions).toEqual([64, 64]);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);

  await page.getByTestId("keyboard-mode").click();
  await expect(page.getByTestId("game-canvas")).toHaveAttribute("data-game-state", "playing");
  expect(errors).toEqual([]);
});
