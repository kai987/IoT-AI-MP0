import { expect, test } from "@playwright/test";

test("model loading failure offers retry and keyboard fallback", async ({ page }) => {
  await page.route("**/generated/models/enet_b0_8_best_vgaf.onnx", (route) => route.abort("failed"));
  await page.goto("/");
  await page.getByTestId("camera-mode").click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(/AI|モデル|推論/);
  await expect(page.getByRole("button", { name: "カメラを再試行" })).toBeVisible();
  await page.getByRole("button", { name: "キーボードで続ける" }).click();
  await expect(page.getByTestId("game-canvas")).toHaveAttribute("data-game-state", "playing");
});
