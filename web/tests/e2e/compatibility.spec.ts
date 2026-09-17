import { expect, test } from "@playwright/test";

test("cancelling camera initialization cannot overwrite a new keyboard session", async ({ page }) => {
  await page.goto("./");
  await page.getByTestId("camera-mode").click();
  await page.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect(page.getByTestId("keyboard-mode")).toBeVisible();
  await page.getByTestId("keyboard-mode").click();
  await expect(page.getByTestId("game-canvas")).toHaveAttribute("data-game-state", "playing");
  await expect(page.locator("video")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("camera mode works when WebGPU is absent in the actual Worker", async ({ page }) => {
  await page.route("**/assets/emotion.worker-*.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `Object.defineProperty(navigator, 'gpu', { value: undefined });\n${await response.text()}` });
  });
  await page.goto("./");
  await page.getByTestId("camera-mode").click();
  await expect(page.getByTestId("game-canvas")).toHaveAttribute("data-game-state", "playing", { timeout: 45_000 });
  await expect(page.locator(".vision-stats")).toContainText("WASM", { timeout: 15_000 });
  await page.getByRole("button", { name: "カメラを停止", exact: true }).click();
  await expect(page.locator("video")).toHaveCount(0);
});

for (const failure of ["404", "network", "corrupt"] as const) {
test(`WebGPU binary ${failure} falls back to the independent WASM runtime`, async ({ page }) => {
  await page.route("**/ort-wasm-simd-threaded.asyncify.wasm", (route) => failure === "network" ? route.abort("failed") : route.fulfill({ status: failure === "404" ? 404 : 200, contentType: "application/wasm", body: "invalid binary" }));
  await page.goto("./");
  await page.getByTestId("camera-mode").click();
  await expect(page.getByTestId("game-canvas")).toHaveAttribute("data-game-state", "playing", { timeout: 45_000 });
  await expect(page.locator(".vision-stats")).toContainText("WASM", { timeout: 15_000 });
});
}

test("profile and per-emotion settings persist; practice stays out of gameplay", async ({ page }) => {
  await page.goto("./");
  await page.getByLabel("動作モード").selectOption("economy");
  await page.reload();
  await expect(page.getByLabel("動作モード")).toHaveValue("economy");
  await page.getByRole("button", { name: "カメラを許可して一覧更新" }).click();
  await expect(page.getByLabel("使用するカメラ").locator("option")).not.toHaveCount(1);
  await page.getByRole("button", { name: "表情を練習・調整" }).click();
  await expect(page.getByRole("heading", { name: "表情の練習・感度調整" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("game-canvas")).toHaveAttribute("data-game-state", "menu");
  await page.locator("#threshold-happiness").fill("55");
  await page.getByRole("button", { name: "喜びを測定", exact: true }).click();
  await expect(page.locator(".practice-report")).toContainText("測定完了", { timeout: 5_000 });
  await page.getByRole("button", { name: "この設定でゲーム開始" }).click();
  await expect(page.getByTestId("game-canvas")).toHaveAttribute("data-game-state", "playing");
  await page.getByRole("button", { name: "メニュー", exact: true }).click();
  const stored = await page.evaluate(() => localStorage.getItem("emotion-runner.web.settings"));
  expect(JSON.parse(stored ?? "{}") as unknown).toMatchObject({ emotionThresholds: { happiness: 0.55 } });
});
