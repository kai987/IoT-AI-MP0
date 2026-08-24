// @vitest-environment node

import { describe, expect, it } from "vitest";

import { fetchSite, withSocialPreview } from "./site-worker";

describe("Sites worker social metadata", () => {
  it("injects an absolute social preview URL from the trusted request origin", async () => {
    const response = new Response("<html><head></head><body></body></html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    const request = new Request("https://emotion-runner.example/game");

    const result = await withSocialPreview(response, request);
    const html = await result.text();

    expect(html).toContain(
      '<meta property="og:image" content="https://emotion-runner.example/og.png" />',
    );
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image" />',
    );
  });

  it("passes non-HTML assets through without modification", async () => {
    const response = new Response("body{}", {
      headers: { "content-type": "text/css" },
    });
    const request = new Request("https://emotion-runner.example/app.css");

    await expect(withSocialPreview(response, request)).resolves.toBe(response);
  });
});

describe("Sites worker document routing", () => {
  it("serves index.html for the root route", async () => {
    const requestedPaths: string[] = [];
    const result = await fetchSite(
      new Request("https://emotion-runner.example/"),
      {
        ASSETS: {
          fetch(request) {
            requestedPaths.push(new URL(request.url).pathname);
            return Promise.resolve(
              new Response("<html><head></head><body>game</body></html>", {
                headers: { "content-type": "text/html" },
              }),
            );
          },
        },
      },
    );

    expect(requestedPaths).toEqual(["/index.html"]);
    expect(result.status).toBe(200);
    await expect(result.text()).resolves.toContain("<body>game</body>");
  });

  it("falls back to index.html for an unknown document route", async () => {
    const requestedPaths: string[] = [];
    const result = await fetchSite(
      new Request("https://emotion-runner.example/game", {
        headers: { accept: "text/html" },
      }),
      {
        ASSETS: {
          fetch(request) {
            const pathname = new URL(request.url).pathname;
            requestedPaths.push(pathname);
            return Promise.resolve(
              pathname === "/index.html"
                ? new Response("<html><head></head><body>game</body></html>", {
                    headers: { "content-type": "text/html" },
                  })
                : new Response("missing", { status: 404 }),
            );
          },
        },
      },
    );

    expect(requestedPaths).toEqual(["/game", "/index.html"]);
    expect(result.status).toBe(200);
  });

  it("preserves a missing asset response without an HTML fallback", async () => {
    const requestedPaths: string[] = [];
    const result = await fetchSite(
      new Request("https://emotion-runner.example/missing.js"),
      {
        ASSETS: {
          fetch(request) {
            requestedPaths.push(new URL(request.url).pathname);
            return Promise.resolve(new Response("missing", { status: 404 }));
          },
        },
      },
    );

    expect(requestedPaths).toEqual(["/missing.js"]);
    expect(result.status).toBe(404);
  });
});
