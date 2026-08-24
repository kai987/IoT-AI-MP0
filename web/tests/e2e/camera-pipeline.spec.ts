import { expect, test } from "@playwright/test";

test("fake camera initializes the local Worker, MediaPipe, and ONNX pipeline", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.getByTestId("camera-mode").click();

  const canvas = page.getByTestId("game-canvas");
  await expect(canvas).toHaveAttribute("data-game-state", "playing", {
    timeout: 45_000,
  });

  const stats = page.locator(".vision-stats");
  await expect(stats).toContainText(/WebGPU|WASM/, { timeout: 30_000 });
  await expect(stats.locator("dd").nth(3)).toHaveText(/[1-9]\d*\.\d・顔 \d+/, {
    timeout: 30_000,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
