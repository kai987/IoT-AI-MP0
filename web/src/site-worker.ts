export interface StaticAssetBinding {
  fetch(request: Request): Promise<Response>;
}

export interface SiteEnvironment {
  readonly ASSETS: StaticAssetBinding;
}

function isDocumentRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") || new URL(request.url).pathname === "/";
}

function indexRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = "/index.html";
  url.search = "";
  return new Request(url, request);
}

export function withSocialPreview(
  response: Response,
  request: Request,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (
    request.method === "HEAD" ||
    !contentType.toLowerCase().includes("text/html")
  ) {
    return Promise.resolve(response);
  }

  return response.text().then((html) => {
    const previewUrl = new URL("/og.png", request.url).href;
    const socialMetadata = [
      '<meta property="og:title" content="Emotion Runner" />',
      '<meta property="og:description" content="表情で駆ける、ローカルAIランナー" />',
      '<meta property="og:type" content="website" />',
      `<meta property="og:image" content="${previewUrl}" />`,
      '<meta name="twitter:card" content="summary_large_image" />',
      '<meta name="twitter:title" content="Emotion Runner" />',
      '<meta name="twitter:description" content="表情で駆ける、ローカルAIランナー" />',
      `<meta name="twitter:image" content="${previewUrl}" />`,
    ].join("\n    ");
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("etag");
    return new Response(
      html.replace("</head>", `    ${socialMetadata}\n  </head>`),
      {
        status: response.status,
        statusText: response.statusText,
        headers,
      },
    );
  });
}

export async function fetchSite(
  request: Request,
  environment: SiteEnvironment,
): Promise<Response> {
  const documentRequest = isDocumentRequest(request);
  const pathname = new URL(request.url).pathname;
  let response = await environment.ASSETS.fetch(
    documentRequest && pathname === "/" ? indexRequest(request) : request,
  );

  if (response.status === 404 && documentRequest && pathname !== "/") {
    response = await environment.ASSETS.fetch(indexRequest(request));
  }

  return withSocialPreview(response, request);
}

export default {
  fetch(request: Request, environment: SiteEnvironment): Promise<Response> {
    return fetchSite(request, environment);
  },
};
