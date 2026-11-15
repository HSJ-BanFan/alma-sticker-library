/**
 * 选图之后的投递策略。
 *
 * 本地轮次直接调本机路由，返回结果里不再带路径，避免模型重复发送。
 * 外部渠道和没有轮次的情况只给路径和一条可执行命令。
 */

import { isLocalTurn, sendPhotoToThread } from './alma-api.js?v=0.3.1-codex-20261114';

function commandText(text) {
    return String(text || '').replace(/\r?\n/g, ' ').replace(/"/g, '\\"').trim();
}

function withNext(picked, text, reason = '') {
    const caption = commandText(text);
    return {
        found: true,
        delivered: false,
        ...picked,
        next: caption
            ? `alma send photo "${picked.file}" "${caption}"`
            : `alma send photo "${picked.file}"`,
        ...(reason ? { reason } : {}),
    };
}

export async function deliverPickedSticker({ picked, turn, text = '' }) {
    if (!picked || !picked.file) return { found: false, reason: '没有可发送的图片' };
    const caption = String(text || '').trim();
    if (!isLocalTurn(turn)) return withNext(picked, caption);
    try {
        const sent = await sendPhotoToThread({
            threadId: turn.threadId,
            messageId: turn.messageId,
            filePath: picked.file,
            caption,
        });
        const { file, ...rest } = picked;
        return {
            found: true,
            delivered: true,
            injected: sent.injected,
            ...rest,
        };
    } catch (err) {
        return withNext(picked, caption, `自动发送失败：${err.message}`);
    }
}
