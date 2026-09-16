/**
 * dsh-agent-billing — 智能配置引擎。
 *
 * Agent LLM loop：三种计费规则源（网页抓取 / 文字描述 / 截图读图）→ 组装 prompt →
 * 用户指定的 Agent 模型解析 → 严格 JSON 规则输出 → 校验 → 落 smart 规则层。
 * 每日自动更新由 host 的 timer 调度（跨天首轮触发，lastRun 持久化）；「立即执行」走同一入口。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { validateRule } from './rules.js';
const SYSTEM_PROMPT = `你是模型计费规则配置专家。给你若干"计费规则源"（网页文本/描述/截图）和目标模型清单，请从中提取每个目标模型的计费规则。
输出要求：只输出一个 JSON 数组，不要任何其它文字或 markdown 代码块。数组每项：
{
  "key": "provider/model",          // provider 短名/模型 id
  "match": { "provider": "provider短名或*", "model": "模型id或glob" },
  "label": "展示名",
  "currency": "CNY" | "USD" | "credit",
  "unit": "百万token",
  "base": { "input": 每百万token单价, "cacheRead": .., "cacheWrite5m": .., "cacheWrite1h": .., "output": .., "reasoning": .. },
  "tiers": [ { "label": "00:00-09:00", "from": "00:00", "to": "09:00", "dims": {同 base} } ],
  "free": false,
  "creditFactor": 每百万token折多少credit（仅 currency=credit 时）
}
数值缺失填 null。免费模型全部填 0 且 free=true。无法从源确认的字段填 null。只配置目标清单里能确认的模型。`;
function extractJsonArray(text) {
    // 优先取 ```json 代码块，否则取首个 [ ... ] 平衡段
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fence ? fence[1] : text;
    const start = body.indexOf('[');
    if (start < 0)
        throw new Error('Agent 输出中未找到 JSON 数组');
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = start; j < body.length; j++) {
        const ch = body[j];
        if (esc) {
            esc = false;
            continue;
        }
        if (ch === '\\') {
            esc = true;
            continue;
        }
        if (ch === '"')
            inStr = !inStr;
        if (inStr)
            continue;
        if (ch === '[' || ch === '{')
            depth++;
        if (ch === ']' || ch === '}') {
            depth--;
            if (depth === 0) {
                end = j;
                break;
            }
        }
    }
    if (end < 0)
        throw new Error('Agent 输出的 JSON 数组未闭合');
    return JSON.parse(body.slice(start, end + 1));
}
/** 按关键词提取相关窗口：源文本过长时只保留目标模型计费段（每个关键词独立窗口拼接） */
function windowAround(text, keywords, windowSize = 20000) {
    const lower = text.toLowerCase();
    const spans = [];
    for (const kw of keywords) {
        const k = kw.toLowerCase();
        if (!k)
            continue;
        let pos = lower.indexOf(k);
        while (pos >= 0) {
            spans.push([Math.max(0, pos - 2000), Math.min(text.length, pos + windowSize)]);
            pos = lower.indexOf(k, pos + Math.max(k.length, windowSize));
            if (spans.length > 12)
                break;
        }
    }
    if (spans.length === 0)
        return text.slice(0, 60000);
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const sp of spans) {
        const last = merged[merged.length - 1];
        if (last && sp[0] <= last[1])
            last[1] = Math.max(last[1], sp[1]);
        else
            merged.push([...sp]);
    }
    return merged.map(([a, b]) => text.slice(a, b)).join('\n……（截取段）……\n');
}
async function fetchWebText(url, keywords = []) {
    let host = url;
    try {
        host = new URL(url).host;
    }
    catch { /* 保留原样 */ }
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Mozilla/5.0 (dsh-agent-billing smart-config)' } });
    if (!res.ok)
        throw new Error(`网页源抓取失败 HTTP ${res.status}：${url}`);
    const html = await res.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    return `【网页源 ${host}】\n` + text.slice(0, 60_000);
}
export class SmartEngine {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    logPath() { return join(this.deps.logDir, 'smart-log.jsonl'); }
    appendLog(entry) {
        try {
            mkdirSync(this.deps.logDir, { recursive: true });
            appendFileSync(this.logPath(), JSON.stringify(entry) + '\n');
        }
        catch { /* 日志失败不影响主流程 */ }
    }
    readLog(limit = 50) {
        const p = this.logPath();
        if (!existsSync(p))
            return [];
        try {
            const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
            return lines.slice(-limit).map((l) => { try {
                return JSON.parse(l);
            }
            catch {
                return { at: '?', ok: false, error: '日志行损坏' };
            } });
        }
        catch {
            return [];
        }
    }
    /** 执行一次智能配置。sources 为空时使用 settings 里启用的全部源。 */
    async run(settings, store, trigger, sourceIds) {
        const started = Date.now();
        const all = settings.sources ?? [];
        const picked = sourceIds && sourceIds.length > 0 ? all.filter((s) => sourceIds.includes(s.id)) : all.filter((s) => s.enabled !== false);
        const entry = { at: new Date().toISOString(), trigger, sources: picked.map((s) => s.id), ok: false, ruleCount: 0, durationMs: 0 };
        if (!settings.enabled) {
            entry.error = '智能配置未开启';
            entry.durationMs = Date.now() - started;
            this.appendLog(entry);
            return entry;
        }
        if (!this.deps.llm()) {
            entry.error = 'llm 服务不可用';
            entry.durationMs = Date.now() - started;
            this.appendLog(entry);
            return entry;
        }
        if (picked.length === 0) {
            entry.error = '没有可执行的规则源';
            entry.durationMs = Date.now() - started;
            this.appendLog(entry);
            return entry;
        }
        try {
            // 1. 组装源内容
            const parts = [];
            const sourceSummaries = [];
            for (const src of picked) {
                if (src.type === 'web' && src.url) {
                    sourceSummaries.push(`网页源: ${src.url}`);
                    const kws = (settings.targetModels ?? []).flatMap((t) => t.split('/')).filter((x) => x.length > 2);
                    parts.push({ type: 'text', text: await fetchWebText(src.url, kws) });
                }
                else if (src.type === 'text' && src.text) {
                    sourceSummaries.push('文字描述源');
                    parts.push({ type: 'text', text: `【文字描述的计费规则】\n${src.text}` });
                }
                else if (src.type === 'image' && (src.imageRefs ?? []).length > 0) {
                    sourceSummaries.push(`截图源×${src.imageRefs.length}`);
                    if (!settings.supportsVision)
                        throw new Error('Agent 模型不支持读图（supportsVision=false），截图源不可用');
                    for (const ref of src.imageRefs) {
                        const stored = await this.deps.attachments().readImage({ attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: 0, width: 0, height: 0 });
                        parts.push({ type: 'text', text: `【截图 ${ref.name ?? ref.attachmentId.slice(0, 10)}】` });
                        parts.push({ type: 'image', attachment: stored.ref });
                    }
                }
            }
            if (parts.length === 0)
                throw new Error('所有规则源均为空');
            // 2. 目标模型清单与官方库提示
            const targets = (settings.targetModels ?? []).length > 0
                ? settings.targetModels.join('\n- ')
                : '（未指定目标清单：请从源内容中发现所有可确认计费的模型）';
            const covered = this.deps.officialKeys();
            const targetBlock = `【目标模型清单】\n- ${targets}\n\n【官方库已覆盖（无需重复配置，除非用户明确要求覆盖）】\n${covered.slice(0, 40).join(', ')}${covered.length > 40 ? ` …共 ${covered.length} 个` : ''}`;
            parts.unshift({ type: 'text', text: targetBlock });
            parts.unshift({ type: 'text', text: `【本次来源】${sourceSummaries.join('；')}` });
            // 3. Agent LLM 调用
            let out = '';
            const stream = this.deps.llm().stream({
                provider: settings.agentProvider,
                model: settings.agentModel,
                system: SYSTEM_PROMPT,
                messages: [createUserMessage({ source: { kind: 'user' }, content: parts })],
                temperature: 0,
                maxTokens: 8000,
            });
            for await (const chunk of stream) {
                if (chunk.type === 'text-delta')
                    out += chunk.text;
            }
            if (!out.trim())
                throw new Error('Agent 无输出');
            const sample = out.slice(0, 500).replace(/\s+/g, ' '); // 诊断采样：进 smart-log
            // 4. 解析 + 校验 + 落库
            this.deps.logger.info?.('[dsh-agent-billing] Agent 原始输出采样：' + out.slice(0, 400).replace(/\s+/g, ' '));
            let arr;
            try {
                arr = extractJsonArray(out);
            }
            catch (e) {
                throw new Error(String(e).slice(0, 120) + '；输出采样：' + sample);
            }
            const parsed = arr.map((r, i) => validateRule({ ...r, source: 'smart', sourceRef: `smart:${trigger}:${entry.at}` }, i));
            if (parsed.length === 0)
                throw new Error('Agent 未产出任何有效规则；输出采样：' + sample);
            const merged = new Map(store.user().map((r) => [r.key, r]));
            for (const r of parsed)
                merged.set(r.key, r);
            store.saveUser([...merged.values()]);
            entry.ok = true;
            entry.ruleCount = parsed.length;
        }
        catch (e) {
            entry.error = String(e).slice(0, 400);
            this.deps.logger.warn?.(`[dsh-agent-billing] 智能配置执行失败：${entry.error}`);
        }
        entry.durationMs = Date.now() - started;
        this.appendLog(entry);
        return entry;
    }
}
//# sourceMappingURL=smart.js.map