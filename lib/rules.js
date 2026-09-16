/**
 * dsh-agent-billing — 模型计费规则库与计价引擎 v2。
 *
 * 三层规则：用户/智能层（model-rules.json，可写）> 官方库（Catalog 全量，内置种子 + stateDir 刷新版）> 旧 provider 档案（index.ts 兜底）。
 * 官方库来源：Catalog 模型网关（catalog-source.invalid）全量 332 条计费规则，内置种子开箱即得，每日 ≥2 次刷新。
 * 计价维度：input / cacheRead / cacheWrite5m / cacheWrite1h / output（reasoning 已含在 output，单独记录展示）。
 * 分档：时段错峰（deepseek 闲忙时精确支持，按样本时间选档）；上下文分档 v1 展示不精确计量。
 * 币种：CNY / USD / credit（credit = 任务级封装的估算系数，全链路显示"积分"不折人民币）。
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
// ────────────────────────────── mini-glob ──────────────────────────────
export function globMatch(pattern, value) {
    const p = pattern.trim().toLowerCase();
    const v = value.toLowerCase();
    if (p === '*' || p === '')
        return true;
    const i = p.indexOf('*');
    if (i < 0)
        return p === v;
    const head = p.slice(0, i);
    const tail = p.slice(i + 1);
    if (tail.includes('*'))
        return false;
    return v.startsWith(head) && (tail === '' || v.endsWith(tail));
}
// ────────────────────────────── 规则库存储 ──────────────────────────────
export class ModelRuleStore {
    stateDir;
    cache = null;
    constructor(stateDir) {
        this.stateDir = stateDir;
    }
    userFile() { return join(this.stateDir, 'model-rules.json'); }
    officialFile() { return join(this.stateDir, 'official-rules.json'); }
    /** 官方库：stateDir 刷新版（若存在）> 内置种子（lib/official-rules.json） */
    official() {
        this.ensure();
        return this.cache.official;
    }
    user() {
        this.ensure();
        return this.cache.user;
    }
    ensure() {
        if (this.cache)
            return;
        let official;
        try {
            if (existsSync(this.officialFile())) {
                const raw = JSON.parse(readFileSync(this.officialFile(), 'utf8'));
                if (Array.isArray(raw?.rules))
                    official = { generatedAt: raw.generatedAt, source: raw.source, rules: raw.rules };
            }
        }
        catch { /* 刷新版损坏 → 回退内置种子 */ }
        if (!official) {
            try {
                const bundled = join(dirname(fileURLToPath(import.meta.url)), 'official-rules.json');
                const raw = JSON.parse(readFileSync(bundled, 'utf8'));
                official = { generatedAt: raw.generatedAt, source: raw.source, rules: raw.rules };
            }
            catch (e) {
                throw new Error(`dsh-agent-billing 内置官方规则库缺失或损坏：${String(e).slice(0, 160)}`);
            }
        }
        let user = [];
        const uf = this.userFile();
        if (existsSync(uf)) {
            try {
                const raw = JSON.parse(readFileSync(uf, 'utf8'));
                user = Array.isArray(raw) ? raw : (raw.rules ?? []);
            }
            catch (e) {
                throw new Error(`dsh-agent-billing 模型规则文件损坏（${uf}）：${String(e).slice(0, 160)}`);
            }
        }
        this.cache = { official, user };
    }
    invalidate() { this.cache = null; }
    saveUser(rules) {
        const tmp = this.userFile() + '.tmp';
        writeFileSync(tmp, JSON.stringify(rules, null, 1));
        renameSync(tmp, this.userFile());
        this.invalidate();
    }
    saveOfficial(data) {
        const tmp = this.officialFile() + '.tmp';
        writeFileSync(tmp, JSON.stringify(data, null, 1));
        renameSync(tmp, this.officialFile());
        this.invalidate();
    }
    /** 挂载后官方规则总数（用于刷新对比） */
    officialCount() { return this.official().rules.length; }
}
// ────────────────────────────── 规则匹配 ──────────────────────────────
export function matchModelRule(user, official, provider, model) {
    if (model === null)
        return null;
    const layers = [[user, 'user'], [official, 'official']];
    for (const [list, layer] of layers) {
        // 1. 精确 key（model 或 provider/model）
        const exact = list.find((r) => r.key.toLowerCase() === model.toLowerCase() || r.key.toLowerCase() === `${provider}/${model}`.toLowerCase());
        if (exact)
            return { rule: exact, layer };
        // 2. match.model glob（+ provider glob，若规则声明）
        const glob = list.find((r) => {
            const modelOk = globMatch(r.match.model, model);
            const provOk = r.match.provider === '*' || provider === null || globMatch(r.match.provider, provider);
            return modelOk && provOk;
        });
        if (glob)
            return { rule: glob, layer };
    }
    return null;
}
/** 样本时间落入哪个时段档（本地时间；from>to 表示跨午夜） */
function pickTimeTier(rule, ts) {
    const tiers = rule.tiers ?? [];
    if (tiers.length === 0)
        return rule.base;
    const d = new Date(ts);
    const mins = d.getHours() * 60 + d.getMinutes();
    const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
    for (const t of tiers) {
        const from = toMin(t.from);
        const to = toMin(t.to);
        if (from <= to ? (mins >= from && mins < to) : (mins >= from || mins < to))
            return t.dims;
    }
    return rule.base;
}
/** 用一条模型规则给一行用量计价 */
export function priceWithRule(rule, row, ctx, layer) {
    if (rule.free)
        return { cost: 0, costCny: rule.currency === 'credit' ? null : 0, costCredit: rule.currency === 'credit' ? 0 : null, currency: rule.currency, ruleKey: rule.key, layer, free: true };
    if (rule.currency === 'credit') {
        const factor = rule.creditFactor ?? 0;
        const totalTokens = row.uncachedInputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
        const credit = (totalTokens / 1e6) * factor;
        return { cost: credit, costCny: null, costCredit: credit, currency: 'credit', ruleKey: rule.key, layer, free: false };
    }
    const dims = pickTimeTier(rule, row.ts);
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const writeDim = rule.writeMap === '1h' ? num(dims.cacheWrite1h) : num(dims.cacheWrite5m ?? dims.cacheWrite1h);
    const raw = (row.uncachedInputTokens * num(dims.input)
        + row.cacheReadTokens * num(dims.cacheRead)
        + row.cacheWriteTokens * writeDim
        + row.outputTokens * num(dims.output)) / 1e6;
    const costCny = rule.currency === 'USD' ? raw * ctx.fx : raw;
    return { cost: raw, costCny, costCredit: null, currency: rule.currency, ruleKey: rule.key, layer, free: false };
}
// ────────────────────────────── 规则校验 ──────────────────────────────
export function validateRule(raw, index) {
    const where = `rules[${index}]`;
    const x = raw;
    if (typeof x?.key !== 'string' || !/^[A-Za-z0-9._/-]{1,128}$/.test(x.key))
        throw new Error(`${where}.key 必须是 1-128 位 [A-Za-z0-9._/-]，实际 ${JSON.stringify(x?.key)}`);
    const currency = x.currency;
    if (currency !== 'CNY' && currency !== 'USD' && currency !== 'credit')
        throw new Error(`${where}.currency 必须是 CNY|USD|credit，实际 ${JSON.stringify(currency)}`);
    const src = x.source;
    if (src !== 'manual' && src !== 'smart')
        throw new Error(`${where}.source 只允许 manual|smart（official 层由刷新器管理）`);
    const match = (x.match ?? {});
    if (typeof match.model !== 'string' || match.model.trim() === '')
        throw new Error(`${where}.match.model 不能为空`);
    const dimsOf = (d) => {
        const t = (d ?? {});
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
        return { input: num(t.input), cacheRead: num(t.cacheRead), cacheWrite5m: num(t.cacheWrite5m), cacheWrite1h: num(t.cacheWrite1h), output: num(t.output), reasoning: num(t.reasoning) };
    };
    const rule = {
        key: x.key.trim(),
        match: { provider: typeof match.provider === 'string' ? match.provider : '*', model: match.model.trim() },
        label: typeof x.label === 'string' ? x.label : undefined,
        currency,
        unit: typeof x.unit === 'string' ? x.unit : '百万token',
        base: dimsOf(x.base),
        tiers: Array.isArray(x.tiers) ? x.tiers.map((t, i) => {
            const where2 = `${where}.tiers[${i}]`;
            if (!/^\d{1,2}:\d{2}$/.test(String(t?.from ?? '')) || !/^\d{1,2}:\d{2}$/.test(String(t?.to ?? '')))
                throw new Error(`${where2}.from/to 必须是 HH:mm`);
            return { label: String(t.label ?? ''), from: t.from, to: t.to, dims: dimsOf(t.dims) };
        }) : [],
        contextTiers: Array.isArray(x.contextTiers) ? x.contextTiers.map((t) => ({ label: String(t?.label ?? ''), dims: dimsOf(t?.dims) })) : [],
        free: !!x.free,
        creditFactor: currency === 'credit' ? (typeof x.creditFactor === 'number' && Number.isFinite(x.creditFactor) && x.creditFactor > 0 ? x.creditFactor : 1) : undefined,
        writeMap: x.writeMap === '1h' ? '1h' : '5m',
        source: src,
        sourceRef: typeof x.sourceRef === 'string' ? x.sourceRef : undefined,
        updatedAt: typeof x.updatedAt === 'string' ? x.updatedAt : new Date().toISOString(),
    };
    return rule;
}
// ────────────────────────────── Catalog 官方库刷新 ──────────────────────────────
/** 从 Catalog 页面 HTML 提取当前数据 bundle URL */
export function extractDataBundleUrl(html) {
    const m = html.match(/assets\/data-[\w-]+\.js/);
    return m ? 'https://catalog-cdn.invalid/catalog-models/' + m[0] : null;
}
/** 从 data bundle 源码提取内嵌 JSON（var e=JSON.parse(`...`)） */
export function extractProvidersJson(bundleSrc) {
    const start = bundleSrc.indexOf('[');
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = start; j < bundleSrc.length; j++) {
        const ch = bundleSrc[j];
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
        throw new Error('Catalog data bundle 中未找到顶层 JSON 数组');
    return JSON.parse(bundleSrc.slice(start, end + 1));
}
/** Catalog provider 数组 → 插件规则（与内置生成脚本同一转换逻辑） */
export function convertCatalogProviders(provs) {
    const DIM_MAP = {
        input_token: 'input', cache_token: 'cacheRead',
        input_write_cache_5m_token: 'cacheWrite5m', input_write_cache_1h_token: 'cacheWrite1h',
        output_token: 'output', output_reasoning_token: 'reasoning',
    };
    const rules = [];
    const now = new Date().toISOString();
    for (const p of provs) {
        const prov = (p.provider || '').split('/').pop();
        if (!prov)
            continue;
        for (const m of (p.models || [])) {
            const pr = m.pricing;
            if (!pr || !pr.metrics)
                continue;
            const id = String(m.model).replace(/_mi_sys$/, '');
            const key = prov + '/' + id;
            const unit = pr.meta?.unitName || '百万token';
            if (unit !== '百万token')
                continue; // 按天/按次类：v1 不进 token 计费库
            const alias = pr.meta?.aliasMap || {};
            const dimsList = pr.dims || [];
            const rows = pr.data || [];
            if (rows.length === 0)
                continue;
            const mapRow = (row) => {
                const dims = { input: null, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null, output: null, reasoning: null };
                const extras = [];
                pr.metrics.forEach((metric, i) => {
                    const raw = String(row[i] ?? '').trim();
                    const val = parseFloat(raw);
                    if (DIM_MAP[metric]) {
                        dims[DIM_MAP[metric]] = Number.isFinite(val) ? val : null;
                        return;
                    }
                    if (raw)
                        extras.push({ name: metric, label: alias[metric] || metric, raw });
                });
                return { dims, extras };
            };
            const first = mapRow(rows[0]);
            const allZero = rows.every((r) => { const d = mapRow(r).dims; return Object.values(d).every((v) => v === null || v === 0); });
            const rule = {
                key,
                match: { provider: prov, model: id },
                label: m.label?.zh_Hans || id,
                currency: 'CNY',
                unit,
                base: first.dims,
                tiers: [],
                contextTiers: [],
                extras: first.extras,
                free: allZero,
                source: 'official',
                sourceRef: 'catalog:' + p.provider,
                updatedAt: now,
            };
            for (let r = 1; r < rows.length && r <= dimsList.length; r++) {
                const aliasVal = alias[dimsList[r - 1]] || dimsList[r - 1];
                const t = aliasVal.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
                const mapped = mapRow(rows[r]);
                if (t)
                    rule.tiers.push({ label: aliasVal, from: t[1].padStart(5, '0'), to: t[2].padStart(5, '0'), dims: mapped.dims });
                else
                    rule.contextTiers.push({ label: String(aliasVal), dims: mapped.dims });
            }
            rules.push(rule);
        }
    }
    return rules;
}
/** 抓取并转换 Catalog 全量官方规则；返回 { rules, changed }（与旧库按 key+updatedAt 对比） */
export async function refreshOfficialFromCatalog(oldRules) {
    const pageRes = await fetch('https://catalog-endpoint.invalid/catalog-models/index.html?view=list', { signal: AbortSignal.timeout(15_000) });
    if (!pageRes.ok)
        throw new Error(`Catalog 页面抓取失败：HTTP ${pageRes.status}`);
    const html = await pageRes.text();
    const bundleUrl = extractDataBundleUrl(html);
    if (!bundleUrl)
        throw new Error('Catalog 页面中未找到数据 bundle URL（页面结构可能已变化）');
    const bundleRes = await fetch(bundleUrl, { signal: AbortSignal.timeout(20_000) });
    if (!bundleRes.ok)
        throw new Error(`Catalog 数据 bundle 抓取失败：HTTP ${bundleRes.status}（${bundleUrl}）`);
    const bundleSrc = await bundleRes.text();
    const provs = extractProvidersJson(bundleSrc);
    const rules = convertCatalogProviders(provs);
    const oldByKey = new Map(oldRules.map((r) => [r.key, JSON.stringify({ base: r.base, tiers: r.tiers, free: r.free })]));
    let changed = 0;
    for (const r of rules) {
        const sig = JSON.stringify({ base: r.base, tiers: r.tiers, free: r.free });
        if (oldByKey.get(r.key) !== sig)
            changed++;
    }
    return { rules, changed, source: bundleUrl };
}
//# sourceMappingURL=rules.js.map