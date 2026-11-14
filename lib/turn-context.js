/**
 * 记录本次工具调用属于哪个会话。
 *
 * Alma 传给插件 execute 的第二个参数是空上下文（threadId 恒为空），
 * 真正的轮次信息只在宿主触发 tool.willExecute 时出现。好在宿主之后会
 * 把同一个 args 对象交给 execute，所以可以用对象身份做键。
 */

const turns = new WeakMap();

export function installTurnContext(events) {
    if (!events?.on) return null;
    return events.on('tool.willExecute', (payload) => {
        const tool = String(payload?.tool || '');
        if (!tool.endsWith('sticker_pick')) return;
        const context = payload?.context || {};
        const threadId = String(context.threadId || '');
        const args = payload?.args;
        if (!threadId || !args || typeof args !== 'object') return;
        turns.set(args, {
            threadId,
            messageId: String(context.messageId || ''),
            source: String(context.source || ''),
        });
    });
}

export function turnFor(args) {
    if (!args || typeof args !== 'object') return null;
    return turns.get(args) || null;
}
