/**
 * Alma 本机 API 的发送入口。
 *
 * 本地聊天没有「工具结果里的路径自动变成图片」这层，只能显式调用
 * /api/threads/:threadId/send-photo。路由只监听 loopback，也没有 token。
 */

const LOCAL_SOURCES = new Set(['', 'chat', 'local', 'desktop']);

export function isLocalTurn(turn) {
    if (!turn || !turn.threadId) return false;
    return LOCAL_SOURCES.has(String(turn.source || ''));
}

export function apiBase() {
    const explicit = String(process.env.ALMA_API_URL || '').trim();
    if (explicit) return explicit.replace(/\/+$/, '');
    const port = String(process.env.API_SERVER_PORT || '').trim() || '23001';
    return `http://127.0.0.1:${port}`;
}

export async function sendPhotoToThread({
    threadId, messageId = '', filePath, caption = '',
}, { timeoutMs = 3000 } = {}) {
    const thread = String(threadId || '').trim();
    const file = String(filePath || '').trim();
    if (!thread) throw new Error('缺少 threadId');
    if (!file) throw new Error('缺少 filePath');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(
            `${apiBase()}/api/threads/${encodeURIComponent(thread)}/send-photo`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    filePath: file,
                    ...(caption ? { caption } : {}),
                    ...(messageId ? { messageId } : {}),
                }),
                signal: controller.signal,
            },
        );
        const raw = await response.text();
        let data = {};
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch {
            data = {};
        }
        if (!response.ok) {
            throw new Error(data?.error || `发送失败 HTTP ${response.status}`);
        }
        return {
            injected: Boolean(data?.injected),
            messageId: String(data?.messageId || ''),
        };
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error('发送超时');
        throw err;
    } finally {
        clearTimeout(timer);
    }
}
