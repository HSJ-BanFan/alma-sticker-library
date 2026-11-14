/**
 * AstrBot 插件页桥接层的 Alma 实现。
 *
 * 原版页面通过 window.AstrBotPluginPage 与宿主通信。这里把同样的接口
 * 映射到本地图库服务：GET/POST 直接走 /api/<endpoint>，上传走 multipart，
 * 下载走 blob，SSE 走 EventSource。页面代码无需知道自己不在 AstrBot 里。
 */
(function initBridge() {
  const API_BASE = "/api/";
  const subscriptions = new Map();
  let counter = 0;

  function buildUrl(endpoint, params) {
    const url = new URL(API_BASE + String(endpoint || "").replace(/^\/+/, ""), location.origin);
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
      else url.searchParams.set(key, String(value));
    }
    return url;
  }

  async function readResponse(response) {
    const type = response.headers.get("content-type") || "";
    let data = null;
    if (type.includes("application/json")) data = await response.json();
    else {
      const text = await response.text();
      try { data = JSON.parse(text); } catch { data = { message: text }; }
    }
    if (!response.ok) {
      const error = new Error(data?.message || data?.error || `请求失败 (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function apiGet(endpoint, params = {}) {
    const response = await fetch(buildUrl(endpoint, params), {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    return readResponse(response);
  }

  async function apiPost(endpoint, body = {}) {
    const response = await fetch(buildUrl(endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return readResponse(response);
  }

  async function upload(endpoint, file, extra = {}) {
    const form = new FormData();
    form.append("file", file, file?.name || "upload.bin");
    for (const [key, value] of Object.entries(extra || {})) {
      if (value !== undefined && value !== null) form.append(key, String(value));
    }
    const response = await fetch(buildUrl(endpoint), {
      method: "POST",
      body: form,
      headers: { accept: "application/json" },
    });
    return readResponse(response);
  }

  async function download(endpoint, params = {}) {
    const response = await fetch(buildUrl(endpoint, params));
    if (!response.ok) {
      let message = `下载失败 (${response.status})`;
      try {
        const data = await response.json();
        message = data?.message || message;
      } catch { /* 忽略 */ }
      throw new Error(message);
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const match = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(disposition);
    const filename = match ? decodeURIComponent(match[1].replace(/"/g, "")) : "download.zip";
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return filename;
  }

  async function subscribeSSE(endpoint, handlers = {}, params = {}) {
    const id = `sse-${++counter}`;
    const url = buildUrl(endpoint, params);
    const source = new EventSource(url);
    subscriptions.set(id, source);
    source.onopen = () => handlers.onOpen?.();
    source.onerror = (event) => handlers.onError?.(event);
    source.onmessage = (event) => {
      let parsed = event.data;
      try { parsed = JSON.parse(event.data); } catch { /* 保留原文 */ }
      handlers.onMessage?.({ data: event.data, parsed });
    };
    return id;
  }

  async function unsubscribeSSE(id) {
    const source = subscriptions.get(id);
    if (source) {
      source.close();
      subscriptions.delete(id);
    }
    return true;
  }

  window.AstrBotPluginPage = {
    ready: async () => true,
    getContext: () => ({ pluginId: "alma-sticker-library", page: location.pathname }),
    apiGet,
    apiPost,
    upload,
    download,
    subscribeSSE,
    unsubscribeSSE,
    onThemeChange: () => ({ dispose() {} }),
  };
  window.AlmaStickerBridge = window.AstrBotPluginPage;
})();
