/**
 * @dsh-external/dsh-agent-billing — host entry（hybrid 插件的 Host 行）。
 *
 * 数据流（接口均经当版源码实测，Phase 2 事实清单）：
 *  1. 注册 `billingUsage` 投影单元到 ctx.sessionProjections —— replay-aware 四档分桶
 *     （uncachedInput/output/cacheRead/cacheWrite）+ provider/model 归属；折叠逻辑镜像
 *     官方 @deepseek-ai/dsh-token-meter 的 tokenUsage 单元（同 turn/step 替换去重）。
 *  2. 经 sessionProjections.onChanged 变更流增量落账本（node:sqlite，水位表防重放/重启双计）。
 *  3. webServer 挂 /dsh-agent-billing/* 路由（loopback + same-origin 守卫，先例 dsh-session-manager）。
 *  4. 冷启动经 agents.list() + sessionProjectionCache.coldSnapshot 补账（插件晚装/重载不丢当日用量）。
 *
 * 生命周期红线：每个注册持 disposer；无 module 级副作用；卸载即净（账本文件保留并在 README 声明）。
 */
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
export const name = '@dsh-external/dsh-agent-billing';
export const version = '0.2.3';
/** 账本投影单元 key（sessionProjections registry 命名空间）。 */
export const UNIT_KEY = 'billingUsage';
// ────────────────────────────── 小工具 ──────────────────────────────
const ZERO = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
function asTotals(v) {
    const t = v;
    return {
        uncachedInputTokens: typeof t?.uncachedInputTokens === 'number' && Number.isFinite(t.uncachedInputTokens) ? t.uncachedInputTokens : 0,
        outputTokens: typeof t?.outputTokens === 'number' && Number.isFinite(t.outputTokens) ? t.outputTokens : 0,
        cacheReadTokens: typeof t?.cacheReadTokens === 'number' && Number.isFinite(t.cacheReadTokens) ? t.cacheReadTokens : 0,
        cacheWriteTokens: typeof t?.cacheWriteTokens === 'number' && Number.isFinite(t.cacheWriteTokens) ? t.cacheWriteTokens : 0,
    };
}
function addTotals(a, b) {
    return {
        uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    };
}
function subTotals(a, b) {
    return {
        uncachedInputTokens: a.uncachedInputTokens - b.uncachedInputTokens,
        outputTokens: a.outputTokens - b.outputTokens,
        cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens - b.cacheWriteTokens,
    };
}
function totalsEqual(a, b) {
    return a.uncachedInputTokens === b.uncachedInputTokens && a.outputTokens === b.outputTokens
        && a.cacheReadTokens === b.cacheReadTokens && a.cacheWriteTokens === b.cacheWriteTokens;
}
/** mini-glob：精确 / `*` / `pfx*` / `*sfx` / `*sub*`，大小写不敏感。 */
const globPatternLowerCache = new Map();
const globValueLowerCache = new Map();
function globMatch(pattern, value) {
    let p = globPatternLowerCache.get(pattern);
    if (p === undefined) {
        p = pattern.trim().toLowerCase();
        if (globPatternLowerCache.size > 512)
            globPatternLowerCache.clear();
        globPatternLowerCache.set(pattern, p);
    }
    let v = globValueLowerCache.get(value);
    if (v === undefined) {
        v = value.toLowerCase();
        if (globValueLowerCache.size > 512)
            globValueLowerCache.clear();
        globValueLowerCache.set(value, v);
    }
    if (p === '*')
        return true;
    const i = p.indexOf('*');
    if (i < 0)
        return p === v;
    const head = p.slice(0, i);
    const tail = p.slice(i + 1);
    if (tail.includes('*'))
        return false; // 只支持单个星号，多余星号按字面处理失败
    return v.startsWith(head) && (tail === '' || v.endsWith(tail));
}
function validateRate(r, where) {
    const x = r;
    const num = (v, field) => {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
            throw new Error(`${where}.${field} 必须是非负有限数字，实际 ${JSON.stringify(v)}`);
        return v;
    };
    return {
        input: num(x?.input, 'input'),
        output: num(x?.output, 'output'),
        cacheRead: num(x?.cacheRead, 'cacheRead'),
        cacheWrite: num(x?.cacheWrite, 'cacheWrite'),
    };
}
function validateProfile(p, index) {
    const where = `profiles[${index}]`;
    const x = p;
    if (typeof x?.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(x.id))
        throw new Error(`${where}.id 必须是 1-64 位 [A-Za-z0-9._-]，实际 ${JSON.stringify(x?.id)}`);
    if (typeof x?.label !== 'string' || x.label.trim() === '')
        throw new Error(`${where}.label 不能为空`);
    if (typeof x?.providerMatch !== 'string' || x.providerMatch.trim() === '')
        throw new Error(`${where}.providerMatch 不能为空`);
    if (typeof x?.currency !== 'string' || x.currency.trim() === '')
        throw new Error(`${where}.currency 不能为空`);
    if (x.discount !== undefined && (typeof x.discount !== 'number' || !Number.isFinite(x.discount) || x.discount <= 0))
        throw new Error(`${where}.discount 必须是正数`);
    const out = { id: x.id, label: x.label.trim(), providerMatch: x.providerMatch.trim(), currency: x.currency.trim().toUpperCase(), rates: validateRate(x.rates, `${where}.rates`) };
    if (x.discount !== undefined)
        out.discount = x.discount;
    if (x.byModel !== undefined) {
        if (typeof x.byModel !== 'object' || x.byModel === null)
            throw new Error(`${where}.byModel 必须是对象`);
        const byModel = {};
        for (const [k, v] of Object.entries(x.byModel))
            byModel[k] = validateRate(v, `${where}.byModel.${k}`);
        out.byModel = byModel;
    }
    if (x.balance !== undefined && x.balance !== null) {
        const b = x.balance;
        if (b.adapter !== 'deepseek' && b.adapter !== 'openai-billing')
            throw new Error(`${where}.balance.adapter 只支持 'deepseek' | 'openai-billing'，实际 ${JSON.stringify(b.adapter)}`);
        let base;
        try {
            base = new URL(String(b.baseUrl));
        }
        catch {
            throw new Error(`${where}.balance.baseUrl 不是合法 URL：${JSON.stringify(b.baseUrl)}`);
        }
        if (base.protocol !== 'http:' && base.protocol !== 'https:')
            throw new Error(`${where}.balance.baseUrl 协议必须是 http(s)`);
        if (typeof b.apiKey !== 'string' || b.apiKey.trim() === '')
            throw new Error(`${where}.balance.apiKey 不能为空`);
        out.balance = { adapter: b.adapter, baseUrl: base.toString().replace(/\/$/, ''), apiKey: b.apiKey.trim() };
    }
    return out;
}
function bucketsFromUsage(usage) {
    const u = usage;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    return {
        uncachedInputTokens: num(u?.inputTokens),
        outputTokens: num(u?.outputTokens),
        cacheReadTokens: num(u?.cacheReadTokens),
        cacheWriteTokens: num(u?.cacheWriteTokens),
    };
}
function parseBillingView(v) {
    const x = v;
    if (x === null || typeof x !== 'object')
        throw new Error(`${UNIT_KEY} view 必须是对象`);
    const totals = asTotals(x.totals);
    if (x.provider !== null && x.provider !== undefined && typeof x.provider !== 'string')
        throw new Error(`${UNIT_KEY}.provider 必须是 string | null`);
    if (x.model !== null && x.model !== undefined && typeof x.model !== 'string')
        throw new Error(`${UNIT_KEY}.model 必须是 string | null`);
    return { totals, provider: x.provider ?? null, model: x.model ?? null };
}
const billingProjectionDefinition = {
    key: UNIT_KEY,
    stateVersion: 2, // bump：apply 语义升级（attempt/retry），失效投影缓存旧态
    /** registry 只调用 schema.parse(view)；手写校验器替代 zod，避免新增 peer 依赖。 */
    schema: { parse: parseBillingView },
    // v0.1.5 契约：只有带 wire 的单元才是 client-visible，drive() 才会发 onChanged——缺 wire 即账本断流
    wire: {
        viewSchema: { parse: parseBillingView },
        view: (state) => ({ totals: state.totals, provider: state.last?.provider ?? null, model: state.last?.model ?? null }),
    },
    init() {
        return { totals: { ...ZERO }, last: null };
    },
    apply(state, event) {
        if (event.type === 'llm/retry-started') {
            // 重试开启：同 turn/step 的旧样本槽位作废，重试尝试按替换计（镜像官方 tokenUsage）
            return state.last !== null && state.last.turn === event.data?.turn && state.last.step === event.data?.step
                ? { ...state, last: null }
                : state;
        }
        let turn;
        let step;
        let usage;
        let provider = null;
        let model = null;
        if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
            ;
            ({ turn, step } = event.data);
            usage = event.data.chunk.usage;
        }
        else if (event.type === 'assistant/attempt') {
            // v0.1.5 契约：无 surface 消息的尝试（失败/重试/中断）——usage 嵌在 stream 最后一个 usage chunk
            ;
            ({ turn, step } = event.data);
            const stream = Array.isArray(event.data?.stream) ? event.data.stream : [];
            for (let i = stream.length - 1; i >= 0; i -= 1) {
                const rec = stream[i];
                if (rec?.type === 'chunk' && rec.chunk?.type === 'usage') {
                    usage = rec.chunk.usage;
                    break;
                }
            }
        }
        else if (event.type === 'assistant/message' && event.data?.usage !== undefined) {
            ;
            ({ turn, step, usage } = event.data);
            const source = event.data.message?.source;
            if (source?.kind === 'model') {
                provider = typeof source.provider === 'string' ? source.provider : null;
                model = typeof source.model === 'string' ? source.model : null;
            }
        }
        else {
            return state;
        }
        if (typeof turn !== 'number' || typeof step !== 'number')
            return state;
        const buckets = bucketsFromUsage(usage);
        const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : undefined;
        if (previous !== undefined && totalsEqual(previous.buckets, buckets) && provider === null)
            return state;
        // 同 turn/step 重复上报 → 替换而非累计（与官方 tokenUsage 单元一致，杜绝双计）。
        const next = {
            totals: previous !== undefined
                ? addTotals(subTotals(state.totals, previous.buckets), buckets)
                : addTotals(state.totals, buckets),
            last: {
                turn,
                step,
                buckets,
                provider: provider ?? previous?.provider ?? state.last?.provider ?? null,
                model: model ?? previous?.model ?? state.last?.model ?? null,
            },
        };
        return next;
    },
};
function openLedger(file) {
    const db = new DatabaseSync(file);
    db.exec(`
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      session TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      in_tok INTEGER NOT NULL,
      out_tok INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);
    CREATE TABLE IF NOT EXISTS watermarks (
      session TEXT PRIMARY KEY,
      in_tok INTEGER NOT NULL, out_tok INTEGER NOT NULL,
      cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
      updated INTEGER NOT NULL
    );
  `);
    const ins = db.prepare('INSERT INTO samples (ts, session, provider, model, in_tok, out_tok, cache_read, cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const getWm = db.prepare('SELECT in_tok, out_tok, cache_read, cache_write FROM watermarks WHERE session = ?');
    const putWm = db.prepare(`INSERT INTO watermarks (session, in_tok, out_tok, cache_read, cache_write, updated) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session) DO UPDATE SET in_tok = excluded.in_tok, out_tok = excluded.out_tok, cache_read = excluded.cache_read, cache_write = excluded.cache_write, updated = excluded.updated`);
    const selSince = db.prepare('SELECT ts, session, provider, model, in_tok, out_tok, cache_read, cache_write FROM samples WHERE ts >= ? ORDER BY ts');
    const selAll = db.prepare('SELECT ts, session, provider, model, in_tok, out_tok, cache_read, cache_write FROM samples ORDER BY ts');
    const selProviders = db.prepare('SELECT DISTINCT provider FROM samples WHERE provider IS NOT NULL');
    const rowMap = (r) => ({ ts: Number(r.ts), session: String(r.session), provider: r.provider === null ? null : String(r.provider), model: r.model === null ? null : String(r.model), uncachedInputTokens: Number(r.in_tok), outputTokens: Number(r.out_tok), cacheReadTokens: Number(r.cache_read), cacheWriteTokens: Number(r.cache_write) });
    return {
        db,
        insert: (ts, session, provider, model, d) => { ins.run(ts, session, provider, model, d.uncachedInputTokens, d.outputTokens, d.cacheReadTokens, d.cacheWriteTokens); },
        watermark: (session) => {
            const r = getWm.get(session);
            return r ? { uncachedInputTokens: Number(r.in_tok), outputTokens: Number(r.out_tok), cacheReadTokens: Number(r.cache_read), cacheWriteTokens: Number(r.cache_write) } : null;
        },
        setWatermark: (session, t) => { putWm.run(session, t.uncachedInputTokens, t.outputTokens, t.cacheReadTokens, t.cacheWriteTokens, Date.now()); },
        rowsSince: (ts) => selSince.all(ts).map(rowMap),
        rowsAll: () => selAll.all().map(rowMap),
        replaceSamples: (rows) => {
            db.exec('DELETE FROM samples; DELETE FROM watermarks;');
            for (const r of rows)
                ins.run(r.ts, r.session, r.provider, r.model, r.uncachedInputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens);
            const bySession = new Map();
            for (const r of rows)
                bySession.set(r.session, addTotals(bySession.get(r.session) ?? { ...ZERO }, r));
            for (const [s, t] of bySession)
                putWm.run(s, t.uncachedInputTokens, t.outputTokens, t.cacheReadTokens, t.cacheWriteTokens, Date.now());
        },
        providersSeen: () => selProviders.all().map((r) => String(r.provider)),
    };
}
// ────────────────────────────── 档案存储（JSON，原子写）──────────────────────────────
class ProfileStore {
    file;
    constructor(file) {
        this.file = file;
    }
    load() {
        if (!existsSync(this.file))
            return [];
        let raw;
        try {
            raw = JSON.parse(readFileSync(this.file, 'utf8'));
        }
        catch (e) {
            throw new Error(`dsh-agent-billing 档案文件损坏（${this.file}）：${String(e).slice(0, 200)} —— 修复或删除该文件后重试`);
        }
        const arr = Array.isArray(raw) ? raw : raw?.profiles;
        if (!Array.isArray(arr))
            throw new Error(`dsh-agent-billing 档案文件结构非法（${this.file}）：顶层必须是数组或 {profiles:[...]}`);
        return arr.map((p, i) => validateProfile(p, i));
    }
    save(profiles) {
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(profiles, null, 2));
        renameSync(tmp, this.file);
    }
}
class SettingsStore {
    file;
    constructor(file) {
        this.file = file;
    }
    load() {
        if (!existsSync(this.file))
            return {};
        try {
            const raw = JSON.parse(readFileSync(this.file, 'utf8'));
            const out = {};
            if (raw.budgets !== undefined) {
                const b = {};
                if (raw.budgets.daily !== undefined)
                    b.daily = raw.budgets.daily;
                if (raw.budgets.monthly !== undefined)
                    b.monthly = raw.budgets.monthly;
                out.budgets = b;
            }
            if (raw.refreshMs !== undefined)
                out.refreshMs = raw.refreshMs;
            if (raw.fx?.usdToCny !== undefined)
                out.fx = { usdToCny: raw.fx.usdToCny };
            if (raw.smart !== undefined)
                out.smart = raw.smart;
            return out;
        }
        catch (e) {
            throw new Error(`dsh-agent-billing 设置文件损坏（${this.file}）：${String(e).slice(0, 200)} —— 修复或删除该文件后重试`);
        }
    }
    save(settings) {
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(settings, null, 2));
        renameSync(tmp, this.file);
    }
}
// ────────────────────────────── 聚合与计费 ──────────────────────────────
function rateFor(profile, model) {
    if (model !== null && profile.byModel) {
        for (const [pattern, rate] of Object.entries(profile.byModel)) {
            if (globMatch(pattern, model))
                return rate;
        }
    }
    return profile.rates;
}
function matchProfile(profiles, provider) {
    if (provider === null)
        return null;
    return profiles.find((p) => globMatch(p.providerMatch, provider)) ?? null;
}
function costOf(t, rate, discount) {
    const raw = (t.uncachedInputTokens * rate.input + t.outputTokens * rate.output + t.cacheReadTokens * rate.cacheRead + t.cacheWriteTokens * rate.cacheWrite) / 1e6;
    return raw * (discount ?? 1);
}
function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
function startOfMonth(d = new Date()) { const x = new Date(d); x.setDate(1); x.setHours(0, 0, 0, 0); return x.getTime(); }
function newBucket() { return { cost: 0, costCny: 0, costCredit: 0, tokens: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }; }
function addSample(b, row, cost, costCny, costCredit = 0) {
    b.cost += cost;
    b.costCny += costCny;
    b.costCredit += costCredit;
    b.inTok += row.uncachedInputTokens;
    b.outTok += row.outputTokens;
    b.cacheRead += row.cacheReadTokens;
    b.cacheWrite += row.cacheWriteTokens;
    b.tokens += row.uncachedInputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    b.calls += 1;
}
// ────────────────────────────── 余额实查 ──────────────────────────────
async function queryBalance(p) {
    const b = p.balance;
    if (!b)
        throw new Error(`档案 ${p.id} 未配置余额查询（balance）`);
    const signal = AbortSignal.timeout(10_000);
    const headers = { Authorization: `Bearer ${b.apiKey}` };
    if (b.adapter === 'deepseek') {
        const res = await fetch(`${b.baseUrl}/user/balance`, { headers, signal });
        if (!res.ok)
            throw new Error(`DeepSeek 余额查询失败：HTTP ${res.status}（${b.baseUrl}/user/balance）`);
        const json = await res.json();
        const info = json?.balance_infos?.[0];
        if (!info)
            throw new Error(`DeepSeek 余额响应缺少 balance_infos[0]：${JSON.stringify(json).slice(0, 200)}`);
        return { balance: Number(info.total_balance), currency: String(info.currency ?? 'CNY'), raw: json };
    }
    // openai-billing（one-api / new-api 系中转站兼容）
    const subRes = await fetch(`${b.baseUrl}/v1/dashboard/billing/subscription`, { headers, signal });
    if (!subRes.ok)
        throw new Error(`中转站额度查询失败：HTTP ${subRes.status}（${b.baseUrl}/v1/dashboard/billing/subscription）`);
    const sub = await subRes.json();
    const limit = Number(sub?.system_hard_limit_usd ?? sub?.hard_limit_usd);
    if (!Number.isFinite(limit))
        throw new Error(`中转站额度响应缺少 hard_limit_usd：${JSON.stringify(sub).slice(0, 200)}`);
    const now = new Date();
    const fmt = (t) => new Date(t).toISOString().slice(0, 10);
    const usageRes = await fetch(`${b.baseUrl}/v1/dashboard/billing/usage?start_date=${fmt(startOfMonth(now))}&end_date=${fmt(Date.now() + 86_400_000)}`, { headers, signal });
    if (!usageRes.ok)
        throw new Error(`中转站用量查询失败：HTTP ${usageRes.status}（.../billing/usage）`);
    const usage = await usageRes.json();
    const used = Number(usage?.total_usage);
    if (!Number.isFinite(used))
        throw new Error(`中转站用量响应缺少 total_usage：${JSON.stringify(usage).slice(0, 200)}`);
    return { balance: limit - used / 100, currency: 'USD', raw: { limit, used } };
}
function sendJson(response, status, body, extra) {
    const payload = JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), ...extra });
    response.end(payload);
}
function isLoopbackPeer(remote) {
    if (typeof remote !== 'string' || remote === '')
        return false;
    if (remote === '::1')
        return true;
    if (remote.startsWith('::ffff:127.'))
        return true;
    return remote.startsWith('127.');
}
function sameOriginHost(request) {
    const origin = request.headers?.origin;
    if (origin === undefined)
        return true;
    const host = request.headers?.host;
    if (typeof origin !== 'string' || typeof host !== 'string' || host.trim() === '')
        return false;
    try {
        return new URL(origin).host.trim().toLowerCase() === host.trim().toLowerCase();
    }
    catch {
        return false;
    }
}
function readJsonBody(request) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        let done = false;
        const finish = (r) => { if (!done) {
            done = true;
            resolve(r);
        } };
        request.on('data', (c) => {
            size += c.length;
            if (size > 4 * 1024 * 1024) {
                finish({ ok: false, error: 'too-large' });
                request.destroy();
            }
            else
                chunks.push(c);
        });
        request.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw.trim() === '') {
                finish({ ok: false, error: 'empty' });
                return;
            }
            try {
                const v = JSON.parse(raw);
                if (v === null || typeof v !== 'object' || Array.isArray(v)) {
                    finish({ ok: false, error: 'invalid' });
                    return;
                }
                finish({ ok: true, value: v });
            }
            catch {
                finish({ ok: false, error: 'invalid' });
            }
        });
        request.on('error', () => finish({ ok: false, error: 'invalid' }));
    });
}
function jsonRoute(run, opts) {
    return async (request, response) => {
        const remote = request.socket?.remoteAddress;
        if (!isLoopbackPeer(remote)) {
            sendJson(response, 403, { error: 'forbidden', message: 'dsh-agent-billing 路由只服务 loopback 对端', remote: remote ?? 'unknown' });
            return;
        }
        const method = typeof request.method === 'string' ? request.method : '';
        if (!opts.methods.includes(method)) {
            sendJson(response, 405, { error: 'method-not-allowed', message: `方法 ${method || '(unknown)'} 不被允许`, allowed: opts.methods.join(', ') }, { allow: opts.methods.join(', ') });
            return;
        }
        let body = {};
        if (opts.mutation && method !== 'GET' && method !== 'HEAD') {
            if (!sameOriginHost(request)) {
                sendJson(response, 403, { error: 'forbidden', message: '跨域变更请求被拒绝' });
                return;
            }
            const read = await readJsonBody(request);
            if (!read.ok) {
                sendJson(response, read.error === 'too-large' ? 413 : 400, { error: read.error === 'too-large' ? 'body-too-large' : 'invalid-body', message: `请求体非法：${read.error}` });
                return;
            }
            body = read.value;
        }
        try {
            const out = await run(body, request);
            sendJson(response, out.status, out.body);
        }
        catch (error) {
            sendJson(response, 500, { error: 'internal', message: `dsh-agent-billing 路由处理失败：${String(error).slice(0, 300)}` });
        }
    };
}
function mountRoutes(webServer, service) {
    const disposers = [];
    const register = (path, run, methods, mutation = false) => {
        try {
            disposers.push(webServer.register({ kind: 'exact', path, handler: jsonRoute(run, { methods, mutation }) }));
        }
        catch (error) {
            for (const d of disposers.splice(0).reverse()) {
                try {
                    d();
                }
                catch { /* 回滚尽力而为 */ }
            }
            throw new Error(`dsh-agent-billing 路由挂载失败（${path}）：${String(error).slice(0, 200)}`);
        }
    };
    // webserver 路由表按 path 唯一索引（kind,path 重复即抛）→ 同 path 多方法必须在单路由内分发
    register('/dsh-agent-billing/status', async (body, request) => {
        const url = new URL(request?.url ?? '/dsh-agent-billing/status', 'http://localhost');
        const sid = url.searchParams.get('session') ?? undefined;
        const compact = url.searchParams.get('compact') === '1';
        const data = service.status(sid);
        if (compact)
            return { status: 200, body: { ok: true, version: data.version, session: data.session } };
        return { status: 200, body: data };
    }, ['GET', 'HEAD']);
    register('/dsh-agent-billing/profiles', async (body, request) => {
        const method = String(request?.method ?? 'GET').toUpperCase();
        if (method === 'PUT')
            return service.putProfiles(body);
        return { status: 200, body: { profiles: service.profiles() } };
    }, ['GET', 'PUT'], true);
    register('/dsh-agent-billing/settings', async (body, request) => {
        const method = String(request?.method ?? 'GET').toUpperCase();
        if (method === 'PUT')
            return service.putSettings(body);
        return { status: 200, body: service.mergedSettings() };
    }, ['GET', 'PUT'], true);
    register('/dsh-agent-billing/balance', async (body) => service.postBalance(body), ['POST'], true);
    register('/dsh-agent-billing/catalog', async () => ({ status: 200, body: await service.catalog() }), ['GET', 'HEAD']);
    register('/dsh-agent-billing/model-rules', async (body, request) => {
        const method = String(request?.method ?? 'GET').toUpperCase();
        if (method === 'PUT')
            return service.putModelRules(body);
        return { status: 200, body: { rules: service.ruleStore.user() } };
    }, ['GET', 'PUT'], true);
    register('/dsh-agent-billing/official', async (body, request) => {
        const method = String(request?.method ?? 'GET').toUpperCase();
        if (method === 'POST') {
            try {
                const r = await service.refreshOfficial();
                return { status: 200, body: { ok: true, ...r } };
            }
            catch (e) {
                return { status: 502, body: { error: 'refresh-failed', message: String(e).slice(0, 300) } };
            }
        }
        const o = service.ruleStore.official();
        return { status: 200, body: { generatedAt: o.generatedAt, source: o.source, count: o.rules.length, timeTiered: o.rules.filter((r) => r.tiers?.length).length } };
    }, ['GET', 'POST'], true);
    register('/dsh-agent-billing/smart/run', async (body) => {
        const settings = service.mergedSettings();
        const sm = { ...(settings.smart ?? { enabled: false, agentProvider: '', agentModel: '', sources: [] }) };
        if (Array.isArray(body?.targetModels) && body.targetModels.length > 0)
            sm.targetModels = body.targetModels.map(String);
        const entry = await service.smart.run(sm, service.ruleStore, 'manual', body?.sourceIds, typeof body?.modelKey === 'string' ? body.modelKey : undefined);
        return { status: entry.ok ? 200 : 502, body: entry };
    }, ['POST'], true);
    register('/dsh-agent-billing/smart/log', async () => ({ status: 200, body: { log: service.smart.readLog(50) } }), ['GET', 'HEAD']);
    register('/dsh-agent-billing/smart/upload', async (body) => service.saveSmartImage(body), ['POST'], true);
    register('/dsh-agent-billing/export', async () => ({ status: 200, body: service.exportAll() }), ['GET', 'HEAD']);
    register('/dsh-agent-billing/import', async (body) => service.postImport(body), ['POST'], true);
    return () => { for (const d of disposers.reverse()) {
        try {
            d();
        }
        catch { /* 卸载尽力而为 */ }
    } };
}
// ────────────────────────────── 服务 ──────────────────────────────
class BillingService {
    ledger;
    store;
    settingsStore;
    config;
    getDep;
    stateDir;
    logger;
    live = new Map();
    degraded = [];
    coldDone = false;
    scanSeen = new Map();
    lastScanAt = 0;
    scanBusy = false;
    sessionTitles = new Map();
    aggCache = null;
    priceMemo = new Map();
    invalidateAgg() {
        this.aggCache = null;
        this.priceMemo = new Map();
    }
    catalogCache = null;
    lastOfficialRefresh = 0;
    lastSmartDailyDay = '';
    ruleStore;
    smart;
    constructor(ledger, store, settingsStore, config, getDep, stateDir, logger) {
        this.ledger = ledger;
        this.store = store;
        this.settingsStore = settingsStore;
        this.config = config;
        this.getDep = getDep;
        this.stateDir = stateDir;
        this.logger = logger;
        this.ruleStore = new ModelRuleStore(stateDir);
        this.smart = new SmartEngine({
            logger,
            llm: () => this.getDep('llm'),
            attachments: () => this.getDep('attachments'),
            logDir: stateDir,
            officialKeys: () => this.ruleStore.official().rules.map((r) => r.key),
        });
    }
    mergedSettings() {
        const stored = this.settingsStore.load();
        const budgets = {
            daily: stored.budgets?.daily ?? this.config.budgets?.daily,
            monthly: stored.budgets?.monthly ?? this.config.budgets?.monthly,
        };
        const smart = stored.smart ?? { enabled: false, agentProvider: '', agentModel: '', sources: [], supportsVision: false };
        return { budgets, refreshMs: stored.refreshMs ?? 1000, fx: { usdToCny: stored.fx?.usdToCny ?? 7.2 }, smart };
    }
    putSettings(body) {
        const next = this.settingsStore.load();
        if (body?.budgets !== undefined) {
            const b = body.budgets;
            const clean = {};
            for (const key of ['daily', 'monthly']) {
                const v = b?.[key];
                if (v === undefined || v === null)
                    continue;
                if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)
                    return { status: 400, body: { error: 'invalid-body', message: `budgets.${key} 必须是正数，实际 ${JSON.stringify(v)}` } };
                clean[key] = v;
            }
            next.budgets = clean;
        }
        if (body?.refreshMs !== undefined) {
            const v = body.refreshMs;
            if (typeof v !== 'number' || !Number.isInteger(v) || v < 500 || v > 60_000)
                return { status: 400, body: { error: 'invalid-body', message: `refreshMs 必须是 500-60000 的整数，实际 ${JSON.stringify(v)}` } };
            next.refreshMs = v;
        }
        if (body?.smart !== undefined) {
            const sm = body.smart;
            if (typeof sm.enabled !== 'boolean')
                return { status: 400, body: { error: 'invalid-body', message: 'smart.enabled 必须是布尔' } };
            if (sm.enabled && (typeof sm.agentProvider !== 'string' || !sm.agentProvider || typeof sm.agentModel !== 'string' || !sm.agentModel))
                return { status: 400, body: { error: 'invalid-body', message: '开启智能配置必须指定 agentProvider 与 agentModel' } };
            if (sm.sources !== undefined && !Array.isArray(sm.sources))
                return { status: 400, body: { error: 'invalid-body', message: 'smart.sources 必须是数组' } };
            next.smart = sm;
            this.invalidateAgg();
        }
        if (body?.fx !== undefined) {
            const v = body.fx?.usdToCny;
            if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1000)
                return { status: 400, body: { error: 'invalid-body', message: `fx.usdToCny 必须是 (0, 1000] 内的数字，实际 ${JSON.stringify(v)}` } };
            next.fx = { usdToCny: v };
            this.invalidateAgg();
        }
        this.settingsStore.save(next);
        return { status: 200, body: { ok: true, settings: next } };
    }
    profiles() {
        return this.store.load();
    }
    putProfiles(body) {
        if (!Array.isArray(body?.profiles))
            return { status: 400, body: { error: 'invalid-body', message: 'body.profiles 必须是数组' } };
        if (body.profiles.length > 256)
            return { status: 400, body: { error: 'invalid-body', message: 'profiles 超过 256 个上限' } };
        let profiles;
        try {
            profiles = body.profiles.map((p, i) => validateProfile(p, i));
        }
        catch (e) {
            return { status: 400, body: { error: 'invalid-profile', message: String(e).slice(0, 400) } };
        }
        const ids = new Set(profiles.map((p) => p.id));
        if (ids.size !== profiles.length)
            return { status: 400, body: { error: 'duplicate-id', message: 'profiles 存在重复 id' } };
        this.store.save(profiles);
        this.invalidateAgg();
        return { status: 200, body: { ok: true, count: profiles.length } };
    }
    async postBalance(body) {
        const id = body?.profileId;
        if (typeof id !== 'string')
            return { status: 400, body: { error: 'invalid-body', message: 'body.profileId 必须是字符串' } };
        const profile = this.profiles().find((p) => p.id === id);
        if (!profile)
            return { status: 404, body: { error: 'unknown-profile', message: `档案不存在：${id}` } };
        try {
            const result = await queryBalance(profile);
            return { status: 200, body: { ok: true, profileId: id, ...result } };
        }
        catch (e) {
            return { status: 502, body: { error: 'balance-failed', message: String(e).slice(0, 400) } };
        }
    }
    exportAll() {
        return { version, exportedAt: new Date().toISOString(), profiles: this.store.load(), samples: this.ledger.rowsAll() };
    }
    postImport(body) {
        let profiles;
        if (body?.profiles !== undefined) {
            if (!Array.isArray(body.profiles))
                return { status: 400, body: { error: 'invalid-body', message: 'body.profiles 必须是数组' } };
            try {
                profiles = body.profiles.map((p, i) => validateProfile(p, i));
            }
            catch (e) {
                return { status: 400, body: { error: 'invalid-profile', message: String(e).slice(0, 400) } };
            }
        }
        if (body?.replaceSamples !== undefined) {
            const rows = body.replaceSamples?.samples ?? body.replaceSamples;
            if (!Array.isArray(rows))
                return { status: 400, body: { error: 'invalid-body', message: 'body.replaceSamples.samples 必须是数组' } };
            const clean = [];
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                if (typeof r?.ts !== 'number' || typeof r?.session !== 'string')
                    return { status: 400, body: { error: 'invalid-body', message: `replaceSamples.samples[${i}] 缺少 ts/session` } };
                clean.push({ ts: r.ts, session: r.session, provider: r.provider ?? null, model: r.model ?? null, ...asTotals(r) });
            }
            this.ledger.replaceSamples(clean);
        }
        if (profiles !== undefined) {
            const merged = new Map(this.store.load().map((p) => [p.id, p]));
            for (const p of profiles)
                merged.set(p.id, p);
            this.store.save([...merged.values()]);
        }
        return { status: 200, body: { ok: true } };
    }
    putModelRules(body) {
        if (!Array.isArray(body?.rules))
            return { status: 400, body: { error: 'invalid-body', message: 'body.rules 必须是数组' } };
        if (body.rules.length > 512)
            return { status: 400, body: { error: 'invalid-body', message: 'rules 超过 512 条上限' } };
        let rules;
        try {
            rules = body.rules.map((r, i) => validateRule(r, i));
        }
        catch (e) {
            return { status: 400, body: { error: 'invalid-rule', message: String(e).slice(0, 400) } };
        }
        this.ruleStore.saveUser(rules);
        this.invalidateAgg();
        this.catalogCache = null;
        return { status: 200, body: { ok: true, count: rules.length } };
    }
    /** 截图上传：base64 → attachment ref（智能配置读图源） */
    async saveSmartImage(body) {
        const data = body?.dataBase64;
        const mediaType = body?.mediaType ?? 'image/png';
        if (typeof data !== 'string' || data.length === 0)
            return { status: 400, body: { error: 'invalid-body', message: 'body.dataBase64 必须是 base64 字符串' } };
        if (!/^image\/(png|jpeg|webp|gif)$/.test(mediaType))
            return { status: 400, body: { error: 'invalid-body', message: 'mediaType 不支持: ' + mediaType } };
        const attachments = this.getDep('attachments');
        if (typeof attachments?.saveImage !== 'function')
            return { status: 503, body: { error: 'attachments-unavailable', message: 'attachments 服务不可用' } };
        try {
            const buf = Uint8Array.from(Buffer.from(data, 'base64'));
            const ref = await attachments.saveImage({ data: buf, mediaType, name: typeof body?.name === 'string' ? body.name : 'smart-config.png' });
            return { status: 200, body: { ok: true, ref: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, name: body?.name ?? 'smart-config.png' } } };
        }
        catch (e) {
            return { status: 502, body: { error: 'save-failed', message: String(e).slice(0, 300) } };
        }
    }
    /** 模型目录：DSH 已配置（inUse）+ 目录源官方库全量，60s 缓存 */
    async catalog() {
        if (this.catalogCache && Date.now() - this.catalogCache.at < 60_000)
            return this.catalogCache.data;
        const officialData = this.ruleStore.official();
        const official = officialData.rules;
        const userRules = this.ruleStore.user();
        const byKey = new Map();
        for (const r of userRules)
            byKey.set(r.key, r);
        const catalogGroups = new Map();
        for (const r of official) {
            const prov = r.match.provider;
            const arr = catalogGroups.get(prov) ?? [];
            arr.push({ id: r.match.model, label: r.label ?? r.match.model, currency: r.currency, source: r.source, free: !!r.free, inUse: false, ruleKey: r.key });
            catalogGroups.set(prov, arr);
        }
        const dshGroups = [];
        const llm = this.getDep('llm');
        const providers = typeof llm?.listProviders === 'function' ? await llm.listProviders() : [];
        for (const prov of providers) {
            let models = [];
            try {
                models = await llm.listModels(prov.id);
            }
            catch {
                models = [];
            }
            dshGroups.push({
                id: prov.id,
                name: prov.name,
                models: models.map((m) => {
                    const mr = matchModelRule(userRules, official, prov.id, m.id);
                    return {
                        id: m.id, label: m.name,
                        currency: mr?.rule.currency ?? '—', source: mr?.rule.source ?? 'none', free: !!mr?.rule.free, inUse: true, ruleKey: mr?.rule.key ?? null,
                        inputModalities: m.inputModalities ? [...m.inputModalities] : undefined,
                    };
                }),
            });
            const mg = catalogGroups.get(prov.id);
            if (mg)
                for (const entry of mg)
                    for (const dm of models)
                        if (dm.id === entry.id || entry.id.includes(dm.id) || dm.id.includes(entry.id)) {
                            entry.inUse = true;
                            break;
                        }
        }
        const data = {
            dsh: dshGroups,
            catalog: [...catalogGroups.entries()].map(([prov, models]) => ({ id: prov, name: prov, models })).sort((a, b) => a.id.localeCompare(b.id)),
            officialGeneratedAt: officialData.generatedAt,
            officialSource: officialData.source,
            userRuleCount: userRules.length,
        };
        this.catalogCache = { at: Date.now(), data };
        return data;
    }
    /** 官方库刷新（目录源全量）；返回变更数 */
    async refreshOfficial() {
        const page = this.config.catalogSource?.page ?? process.env.AGENT_BILLING_CATALOG_PAGE ?? '';
        const bundleBase = this.config.catalogSource?.bundleBase ?? process.env.AGENT_BILLING_CATALOG_BUNDLE_BASE ?? '';
        if (page === '' || bundleBase === '') {
            throw new Error('未配置官方目录源（config.catalogSource.page/bundleBase 或环境变量 AGENT_BILLING_CATALOG_PAGE / AGENT_BILLING_CATALOG_BUNDLE_BASE）——跳过刷新；本地已存规则继续生效');
        }
        const prev = this.ruleStore.official();
        const { rules, changed, source } = await refreshOfficialCatalog(prev.rules, page, bundleBase);
        this.ruleStore.saveOfficial({ generatedAt: new Date().toISOString(), source, rules });
        this.invalidateAgg();
        this.catalogCache = null;
        return { changed, count: rules.length };
    }
    /** timer 调度 tick：官方库 12h 刷新 + 智能配置每日源 */
    async scheduledTick() {
        // 官方库：每 12h
        if (Date.now() - this.lastOfficialRefresh > 12 * 3600_000) {
            this.lastOfficialRefresh = Date.now();
            try {
                const r = await this.refreshOfficial();
                this.logger.info?.('[dsh-agent-billing] 官方计费库自动刷新：' + r.count + ' 条规则，变更 ' + r.changed);
            }
            catch (e) {
                this.logger.warn?.('[dsh-agent-billing] 官方计费库自动刷新失败：' + String(e).slice(0, 200));
            }
        }
        // 智能配置每日源：per-model——每个带 autoDaily 源的模型规则，每天 03:00 后各跑一次
        const settings = this.mergedSettings();
        const sm = settings.smart;
        if (!sm?.enabled || !sm.agentModel)
            return;
        const today = new Date().toISOString().slice(0, 10);
        if (this.lastSmartDailyDay === today)
            return;
        this.lastSmartDailyDay = today;
        for (const rule of this.ruleStore.user()) {
            if (!(rule.smartSources ?? []).some((x) => x.type === 'web' && x.autoDaily && x.enabled !== false))
                continue;
            try {
                const entry = await this.smart.run(sm, this.ruleStore, 'daily', undefined, rule.key);
                this.logger.info?.(`[dsh-agent-billing] 智能配置每日更新（${rule.key}）：ok=${entry.ok} rules=${entry.ruleCount}${entry.error ? ' err=' + entry.error : ''}`);
            }
            catch (e) {
                this.logger.warn?.(`[dsh-agent-billing] 智能配置每日更新失败（${rule.key}）：${String(e).slice(0, 160)}`);
            }
        }
    }
    /** 会话日志直扫 v2：按事件时间戳逐事件入账（today/month 窗口正确），seq 增量防重扫双计，scan-state.json 持久化。绕开投影契约。 */
    scanSessionLogs(force = false) {
        const now = Date.now();
        if (!force && this.scanBusy)
            return;
        if (!force && now - this.lastScanAt < 4000)
            return;
        this.scanBusy = true;
        this.lastScanAt = now;
        try {
            const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
            const root = join(dshHome, 'sessions');
            if (!existsSync(root))
                return;
            const state = this.loadScanState();
            for (const ws of readdirSync(root)) {
                const wsDir = join(root, ws);
                let entries;
                try {
                    entries = readdirSync(wsDir);
                }
                catch {
                    continue;
                }
                for (const sid of entries) {
                    if (!sid.startsWith('session-'))
                        continue;
                    const file = join(wsDir, sid, 'session.v3.jsonl.zstd');
                    let mtime = 0;
                    try {
                        mtime = statSync(file).mtimeMs;
                    }
                    catch {
                        continue;
                    }
                    const st = state.files[file];
                    if (!force && st && mtime <= st.mtime)
                        continue;
                    if (!st && mtime < now - 48 * 3600_000) {
                        state.files[file] = { mtime, lastSeq: -1 };
                        continue;
                    }
                    let text;
                    try {
                        const z = spawnSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 });
                        if (z.status !== 0 || !z.stdout)
                            throw new Error('zstd exit=' + z.status);
                        text = z.stdout.toString('utf-8');
                    }
                    catch (e) {
                        this.noteDegraded('会话日志解压失败 ' + sid + ': ' + String(e).slice(0, 120));
                        continue;
                    }
                    const slots = new Map();
                    let provider = null;
                    let model = null;
                    let maxSeq = -1;
                    for (const line of text.split(String.fromCharCode(10))) {
                        if (!line)
                            continue;
                        let e;
                        try {
                            e = JSON.parse(line);
                        }
                        catch {
                            continue;
                        }
                        const seq = typeof e?.seq === 'number' ? e.seq : -1;
                        if (seq > maxSeq)
                            maxSeq = seq;
                        const type = e?.type;
                        if (type === 'session/title' && typeof e?.data?.title === 'string')
                            this.sessionTitles.set(sid, e.data.title);
                        if (type !== 'assistant/message' && type !== 'assistant/attempt')
                            continue;
                        const d = e?.data;
                        if (typeof d?.turn !== 'number' || typeof d?.step !== 'number')
                            continue;
                        if (st && st.lastSeq >= 0 && seq <= st.lastSeq)
                            continue;
                        let usage = d.usage;
                        if (usage === undefined && Array.isArray(d.stream)) {
                            for (let i = d.stream.length - 1; i >= 0; i -= 1) {
                                const rec = d.stream[i];
                                if (rec?.type === 'chunk' && rec.chunk?.type === 'usage') {
                                    usage = rec.chunk.usage;
                                    break;
                                }
                            }
                        }
                        if (usage === undefined)
                            continue;
                        const tms = typeof e.time === 'number' ? e.time : (typeof e.time === 'string' ? Date.parse(e.time) : NaN);
                        const src = d.message?.source;
                        if (src?.kind === 'model' && typeof src.provider === 'string' && typeof src.model === 'string') {
                            provider = src.provider;
                            model = src.model;
                        }
                        slots.set(d.turn + ':' + d.step, { usage, provider, model, ts: Number.isFinite(tms) ? tms : Date.now(), seq });
                    }
                    let inserted = 0;
                    for (const s2 of slots.values()) {
                        const evTotals = {
                            uncachedInputTokens: Number(s2.usage?.inputTokens) || 0,
                            outputTokens: Number(s2.usage?.outputTokens) || 0,
                            cacheReadTokens: Number(s2.usage?.cacheReadTokens) || 0,
                            cacheWriteTokens: Number(s2.usage?.cacheWriteTokens) || 0,
                        };
                        const sum = evTotals.uncachedInputTokens + evTotals.outputTokens + evTotals.cacheReadTokens + evTotals.cacheWriteTokens;
                        if (sum === 0)
                            continue;
                        this.ledger.insert(s2.ts, sid, s2.provider, s2.model, evTotals);
                        inserted += 1;
                    }
                    if (inserted > 0 || (st && maxSeq > st.lastSeq)) {
                        this.invalidateAgg();
                        const cur = this.ledger.watermark(sid);
                        const liveTotals = cur ?? { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
                        this.live.set(sid, { value: { totals: liveTotals, provider, model }, updatedAt: Date.now() });
                    }
                    state.files[file] = { mtime, lastSeq: Math.max(maxSeq, st ? st.lastSeq : -1) };
                }
            }
            state.titles = Object.fromEntries(this.sessionTitles);
            this.saveScanState(state);
        }
        catch (e) {
            this.noteDegraded('会话日志直扫失败：' + String(e).slice(0, 160));
        }
        finally {
            this.scanBusy = false;
        }
    }
    loadScanState() {
        try {
            const raw = readFileSync(join(this.stateDir, 'scan-state.json'), 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.files === 'object') {
                this.sessionTitles = new Map(Object.entries(parsed.titles ?? {}));
                return { files: parsed.files, titles: parsed.titles ?? {} };
            }
        }
        catch { /* 首次无状态文件 */ }
        return { files: {}, titles: {} };
    }
    saveScanState(state) {
        try {
            writeFileSync(join(this.stateDir, 'scan-state.json'), JSON.stringify(state));
        }
        catch { /* 尽力而为 */ }
    }
    /** 变更流回调：增量落账本（水位表防双计）。错误显式记录，不静默。 */
    onBillingChange(session, value) {
        this.invalidateAgg();
        const sid = typeof session?.id === 'string' ? session.id : 'unknown';
        const wm = this.ledger.watermark(sid) ?? { ...ZERO };
        const delta = subTotals(value.totals, wm);
        const neg = delta.uncachedInputTokens < 0 || delta.outputTokens < 0 || delta.cacheReadTokens < 0 || delta.cacheWriteTokens < 0;
        if (neg)
            this.noteDegraded(`会话 ${sid} 出现负增量（日志收缩或水位回退），负值按 0 记账`);
        const clamped = {
            uncachedInputTokens: Math.max(0, delta.uncachedInputTokens),
            outputTokens: Math.max(0, delta.outputTokens),
            cacheReadTokens: Math.max(0, delta.cacheReadTokens),
            cacheWriteTokens: Math.max(0, delta.cacheWriteTokens),
        };
        if (!totalsEqual(clamped, ZERO)) {
            this.ledger.insert(Date.now(), sid, value.provider, value.model, clamped);
        }
        this.ledger.setWatermark(sid, value.totals);
        this.live.set(sid, { value, updatedAt: Date.now() });
    }
    noteDegraded(message) {
        this.degraded.push(`[${new Date().toISOString()}] ${message}`);
        if (this.degraded.length > 50)
            this.degraded.splice(0, this.degraded.length - 50);
    }
    /** 冷启动补账：插件晚装/重载后，把既有会话的存量用量补进账本（每次进程生命周期一次）。 */
    async coldReconcile() {
        if (this.coldDone)
            return;
        this.coldDone = true;
        const agents = this.getDep('agents');
        const projectionCache = this.getDep('sessionProjectionCache');
        if (typeof agents?.list !== 'function' || typeof projectionCache?.coldSnapshot !== 'function')
            return;
        let items;
        try {
            items = agents.list();
        }
        catch (e) {
            this.noteDegraded(`agents.list() 失败，跳过冷启动补账：${String(e).slice(0, 120)}`);
            return;
        }
        for (const item of items) {
            const id = typeof item === 'string' ? item : (item?.id !== undefined ? String(item.id) : null);
            if (id === null)
                continue;
            try {
                const res = await projectionCache.coldSnapshot(id);
                const value = res?.snapshot?.values?.[UNIT_KEY] ?? res?.values?.[UNIT_KEY];
                if (value)
                    this.onBillingChange({ id }, this.normalizeValue(value));
            }
            catch (e) {
                this.noteDegraded(`冷启动补账失败（会话 ${id.slice(0, 8)}）：${String(e).slice(0, 160)}`);
            }
        }
    }
    normalizeValue(v) {
        return billingProjectionDefinition.schema.parse(v);
    }
    status(sessionId) {
        // 冷补账惰性触发（apply 时可选服务未必就绪；首次面板轮询时补）
        if (!this.coldDone)
            void this.coldReconcile().catch((e) => this.noteDegraded(`冷启动补账失败：${String(e).slice(0, 160)}`));
        // 会话日志直扫（4s 节流）：不依赖投影事件契约的保底记账通道
        this.scanSessionLogs();
        // 聚合缓存：账本变更即置脏；未变更 800ms 内复用 —— 支撑客户端 1s 级高频轮询零压力
        const nowMs = Date.now();
        if (!sessionId && this.aggCache !== null && nowMs - this.aggCache.at < 800)
            return this.aggCache.data;
        const profiles = this.store.load();
        const settings = this.mergedSettings();
        const fx = settings.fx.usdToCny;
        const now = new Date();
        const dayStart = startOfDay(now);
        const monthStart = startOfMonth(now);
        const fortnightStart = dayStart - 13 * 86_400_000;
        const monthRows = this.ledger.rowsSince(monthStart);
        const dayRows = monthRows.filter((r) => r.ts >= dayStart);
        const allRows = this.ledger.rowsAll();
        const fortnightRows = allRows.filter((r) => r.ts >= fortnightStart);
        // 计价 v2：模型规则（用户/智能层 > 官方层）优先，回退旧 provider 档案
        const officialRules = this.ruleStore.official().rules;
        const userRules = this.ruleStore.user();
        const priceCtx = { fx };
        const priceRow = (row) => {
            const memoKey = `${row.ts}|${row.session}|${row.provider ?? ''}|${row.model ?? ''}|${row.uncachedInputTokens}|${row.outputTokens}|${row.cacheReadTokens}|${row.cacheWriteTokens}`;
            const cached = this.priceMemo.get(memoKey);
            if (cached !== undefined)
                return cached;
            let result;
            const hit = matchModelRule(userRules, officialRules, row.provider, row.model);
            if (hit) {
                const r = priceWithRule(hit.rule, row, priceCtx, hit.layer);
                result = { cost: r.cost, costCny: r.costCny ?? 0, costCredit: r.costCredit, currency: r.currency, profile: null, ruleKey: r.ruleKey, layer: hit.layer, free: r.free };
            }
            else {
                const profile = matchProfile(profiles, row.provider);
                if (profile === null)
                    result = { cost: 0, costCny: 0, costCredit: null, currency: '—', profile: null, ruleKey: null, layer: null, free: false };
                else {
                    const rate = rateFor(profile, row.model);
                    const cost = costOf(row, rate, profile.discount);
                    result = { cost, costCny: cost * (profile.currency === 'USD' ? fx : 1), costCredit: null, currency: profile.currency, profile, ruleKey: null, layer: 'profile', free: false };
                }
            }
            this.priceMemo.set(memoKey, result);
            return result;
        };
        const windowAgg = (rows) => {
            const byProfile = new Map();
            const byModel = new Map();
            const byRule = new Map();
            const total = newBucket();
            let cost = 0;
            let costCredit = 0;
            const byCurrency = {};
            for (const row of rows) {
                const { cost: c, costCny: cny, costCredit: credit, currency, profile, ruleKey, layer } = priceRow(row);
                const cr = credit ?? 0;
                cost += c;
                costCredit += cr;
                byCurrency[currency] = Number(((byCurrency[currency] ?? 0) + c).toFixed(6));
                const b = newBucket();
                addSample(b, row, c, cny, cr);
                addSample(total, row, c, cny, cr);
                const pKey = profile ? profile.id : (ruleKey ?? '(未匹配)');
                const pb = byProfile.get(pKey) ?? { ...newBucket(), profileId: pKey, label: profile ? profile.label : (ruleKey ?? '(未计费)'), currency };
                addSample(pb, row, c, cny, cr);
                byProfile.set(pKey, pb);
                const mKey = `${pKey}::${row.model ?? '(未知模型)'}`;
                const mb = byModel.get(mKey) ?? { ...newBucket(), profileId: pKey, provider: row.provider ?? '(未知)', model: row.model ?? '(未知模型)' };
                addSample(mb, row, c, cny, cr);
                byModel.set(mKey, mb);
                if (ruleKey) {
                    const rb = byRule.get(ruleKey) ?? { ...newBucket(), ruleKey, currency, layer: layer ?? 'official' };
                    addSample(rb, row, c, cny, cr);
                    byRule.set(ruleKey, rb);
                }
            }
            const fmtB = (x) => ({ cost: Number(x.cost.toFixed(6)), costCny: Number(x.costCny.toFixed(4)), costCredit: Number(x.costCredit.toFixed(4)), tokens: x.tokens, inTok: x.inTok, outTok: x.outTok, cacheRead: x.cacheRead, cacheWrite: x.cacheWrite, calls: x.calls });
            return {
                cost: Number(cost.toFixed(6)),
                costCny: Number(total.costCny.toFixed(4)),
                costCredit: Number(costCredit.toFixed(4)),
                byCurrency,
                tokens: total.tokens,
                inTok: total.inTok,
                outTok: total.outTok,
                cacheRead: total.cacheRead,
                cacheWrite: total.cacheWrite,
                calls: total.calls,
                cacheHitRatio: total.cacheRead + total.cacheWrite > 0 ? Number((total.cacheRead / (total.cacheRead + total.inTok + total.cacheWrite)).toFixed(4)) : null,
                byProfile: [...byProfile.values()].sort((a, b) => b.cost - a.cost).map((x) => ({ ...fmtB(x), profileId: x.profileId, label: x.label, currency: x.currency })),
                byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost).slice(0, 50).map((x) => ({ ...fmtB(x), profileId: x.profileId, provider: x.provider, model: x.model })),
                byRule: [...byRule.values()].sort((a, b) => b.cost - a.cost).slice(0, 80).map((x) => ({ ...fmtB(x), ruleKey: x.ruleKey, currency: x.currency, layer: x.layer })),
            };
        };
        const byDay = new Map();
        for (const row of fortnightRows) {
            const date = new Date(row.ts);
            const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            const b = byDay.get(key) ?? newBucket();
            const pr = priceRow(row);
            addSample(b, row, pr.cost, pr.costCny, pr.costCredit ?? 0);
            byDay.set(key, b);
        }
        const days = [...byDay.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([date, b]) => ({ date, cost: Number(b.cost.toFixed(6)), costCny: Number(b.costCny.toFixed(4)), costCredit: Number(b.costCredit.toFixed(4)), tokens: b.tokens }));
        const bySession = new Map();
        for (const row of dayRows) {
            const b = bySession.get(row.session) ?? newBucket();
            const pr = priceRow(row);
            addSample(b, row, pr.cost, pr.costCny, pr.costCredit ?? 0);
            bySession.set(row.session, b);
        }
        // 今日会话全量（供客户端精确定位"本会话今日花费"）
        const sessions = [...bySession.entries()].sort((a, b) => b[1].costCny - a[1].costCny).map(([id, b]) => ({ id, title: this.sessionTitles.get(id) ?? null, cost: Number(b.cost.toFixed(6)), costCny: Number(b.costCny.toFixed(4)), costCredit: Number(b.costCredit.toFixed(4)), tokens: b.tokens, calls: b.calls }));
        // 本窗口会话账单（?session= 精确匹配：全量 + 今日）
        let sessionWindow = null;
        if (sessionId) {
            const sessRowsAll = allRows.filter((r) => r.session === sessionId);
            const aggAll = windowAgg(sessRowsAll);
            const aggToday = windowAgg(sessRowsAll.filter((r) => r.ts >= dayStart));
            sessionWindow = { id: sessionId, title: this.sessionTitles.get(sessionId) ?? null, costCny: aggAll.costCny, tokens: aggAll.tokens, calls: aggAll.calls, todayCostCny: aggToday.costCny, todayCalls: aggToday.calls };
        }
        const live = [...this.live.entries()].slice(0, 50).map(([id, { value, updatedAt }]) => {
            const hit = matchModelRule(userRules, officialRules, value.provider, value.model);
            let costEstimate = null;
            let costCreditEstimate = null;
            let currency = null;
            if (hit) {
                const r = priceWithRule(hit.rule, { ...value.totals, ts: updatedAt }, priceCtx, hit.layer);
                costEstimate = Number(r.cost.toFixed(6));
                costCreditEstimate = r.costCredit !== null ? Number(r.costCredit.toFixed(4)) : null;
                currency = r.currency;
            }
            else {
                const profile = matchProfile(profiles, value.provider);
                const rate = profile ? rateFor(profile, value.model) : null;
                if (profile && rate) {
                    costEstimate = Number(costOf(value.totals, rate, profile.discount).toFixed(6));
                    currency = profile.currency;
                }
            }
            return {
                id,
                totals: value.totals,
                provider: value.provider,
                model: value.model,
                costEstimate,
                costCnyEstimate: currency === 'USD' && costEstimate !== null ? Number((costEstimate * fx).toFixed(4)) : costEstimate,
                costCreditEstimate,
                currency,
                updatedAt,
            };
        });
        // 「本会话」= 最近活跃会话（单窗口场景即当前会话；多窗口退化为最近活跃，README 声明）
        const recentSession = live.length > 0 ? [...live].sort((a, b) => b.updatedAt - a.updatedAt)[0] : null;
        const todayAgg = windowAgg(dayRows);
        const monthAgg = windowAgg(monthRows);
        const totalAgg = windowAgg(allRows);
        const budgetOf = (limit, spent) => ({
            limit: limit ?? null,
            spent,
            state: limit === undefined || limit === null ? 'unset' : spent >= limit ? 'over' : spent >= limit * 0.8 ? 'warn' : 'ok',
        });
        const data = {
            ok: true,
            version,
            at: new Date().toISOString(),
            windows: { today: todayAgg, month: monthAgg, total: totalAgg },
            days,
            session: sessionWindow,
            sessions,
            live,
            recentSession,
            budgets: {
                daily: budgetOf(settings.budgets.daily, todayAgg.costCny),
                monthly: budgetOf(settings.budgets.monthly, monthAgg.costCny),
                fx,
            },
            settings: { refreshMs: settings.refreshMs, fxUsdToCny: fx, smart: settings.smart },
            providersSeen: this.ledger.providersSeen(),
            coldReconciled: this.coldDone,
            degraded: this.degraded.slice(-10),
        };
        if (!sessionId)
            this.aggCache = { at: nowMs, data };
        return data;
    }
}
// ────────────────────────────── mini-glob / 规则库存储 ──────────────────────────────
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
const ruleKeyLowerCache = new WeakMap();
const ruleKeyLower = (r) => {
    let v = ruleKeyLowerCache.get(r);
    if (v === undefined) {
        v = r.key.toLowerCase();
        ruleKeyLowerCache.set(r, v);
    }
    return v;
};
export function matchModelRule(user, official, provider, model) {
    if (model === null)
        return null;
    const modelLower = model.toLowerCase();
    const providerModelLower = `${provider}/${model}`.toLowerCase();
    const layers = [[user, 'user'], [official, 'official']];
    for (const [list, layer] of layers) {
        // 1. 精确 key（model 或 provider/model）
        const exact = list.find((r) => ruleKeyLower(r) === modelLower || ruleKeyLower(r) === providerModelLower);
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
        smartSources: Array.isArray(x.smartSources)
            ? x.smartSources.map((src, si) => ({
                id: String(src?.id ?? 's' + si),
                type: src?.type === 'web' || src?.type === 'text' || src?.type === 'image' ? src.type : 'web',
                url: typeof src?.url === 'string' ? src.url : undefined,
                text: typeof src?.text === 'string' ? src.text : undefined,
                imageRefs: Array.isArray(src?.imageRefs) ? src.imageRefs : undefined,
                autoDaily: !!src?.autoDaily,
                enabled: src?.enabled !== false,
            }))
            : undefined,
        smartLastRunAt: typeof x.smartLastRunAt === 'string' ? x.smartLastRunAt : undefined,
        smartLastRunOk: typeof x.smartLastRunOk === 'boolean' ? x.smartLastRunOk : undefined,
        smartLastError: typeof x.smartLastError === 'string' ? x.smartLastError : undefined,
    };
    return rule;
}
// ────────────────────────────── 官方目录刷新 ──────────────────────────────
/** 从目录页 HTML 提取当前数据 bundle URL */
export function extractDataBundleUrl(html, bundleBase) {
    const m = html.match(/assets\/data-[\w-]+\.js/);
    return m ? bundleBase + m[0] : null;
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
        throw new Error('目录数据 bundle 中未找到顶层 JSON 数组');
    return JSON.parse(bundleSrc.slice(start, end + 1));
}
/** 目录 provider 数组 → 插件规则（与内置生成脚本同一转换逻辑） */
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
/** 抓取并转换目录源全量官方规则；返回 { rules, changed }（与旧库按 key+updatedAt 对比） */
export async function refreshOfficialCatalog(oldRules, pageUrl, bundleBase) {
    const pageRes = await fetch(pageUrl, { signal: AbortSignal.timeout(15_000) });
    if (!pageRes.ok)
        throw new Error(`目录页抓取失败：HTTP ${pageRes.status}`);
    const html = await pageRes.text();
    const bundleUrl = extractDataBundleUrl(html, bundleBase);
    if (!bundleUrl)
        throw new Error('目录页中未找到数据 bundle URL（页面结构可能已变化）');
    const bundleRes = await fetch(bundleUrl, { signal: AbortSignal.timeout(20_000) });
    if (!bundleRes.ok)
        throw new Error(`目录数据 bundle 抓取失败：HTTP ${bundleRes.status}（${bundleUrl}）`);
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
数值缺失填 null。免费模型全部填 0 且 free=true。无法从源确认的字段填 null。注意：源里的模型 id 可能带 _mi_sys、路径前缀等修饰（如 glm-5.3-flash_mi_sys 即代表 glm-5.3-flash），按基础名匹配后产出时使用目标清单里的 id。免费模型（价格全 0）也要产出且 free=true。找不到任何目标模型时才输出空数组，否则不要输出空数组。`;
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
            let end = Math.min(text.length, pos + windowSize);
            // 对齐完整 JSON 对象：从命中处向后找 "pricing" 的平衡 {}，保证片段自包含可解析
            const pr = text.indexOf('"pricing"', pos);
            if (pr >= 0 && pr < pos + windowSize * 2) {
                const objStart = text.indexOf('{', pr);
                if (objStart >= 0) {
                    let depth = 0, inStr = false, esc = false;
                    for (let j = objStart; j < text.length; j++) {
                        const ch = text[j];
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
                        if (ch === '{')
                            depth++;
                        if (ch === '}') {
                            depth--;
                            if (depth === 0) {
                                end = Math.min(text.length, j + 3);
                                break;
                            }
                        }
                    }
                }
            }
            spans.push([Math.max(0, pos - 600), end]);
            pos = lower.indexOf(k, pos + Math.max(k.length, 4000));
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
        if (last && sp[0] <= last[1] + 200)
            last[1] = Math.max(last[1], sp[1]);
        else
            merged.push([...sp]);
    }
    return merged.map(([a, b]) => text.slice(a, b)).join('\n……（下一段）……\n');
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
    /** 执行一次智能配置。modelKey 存在时 = per-model 模式（用该模型自己的源，只产出该模型规则）。 */
    async run(settings, store, trigger, sourceIds, modelKey) {
        const started = Date.now();
        const perModel = modelKey ? store.user().find((r) => r.key === modelKey) : undefined;
        const all = modelKey ? (perModel?.smartSources ?? []) : (settings.sources ?? []);
        const picked = modelKey ? all.filter((s) => s.enabled !== false) : (sourceIds && sourceIds.length > 0 ? all.filter((s) => sourceIds.includes(s.id)) : all.filter((s) => s.enabled !== false));
        const effectiveTargets = modelKey ? [modelKey] : (settings.targetModels ?? []);
        const entry = { at: new Date().toISOString(), trigger, sources: picked.map((s) => s.id), ok: false, ruleCount: 0, durationMs: 0 };
        if (!settings.enabled && !modelKey) {
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
            // 2. 目标模型清单：剥离 DSH provider 前缀（源里的模型 id 通常不带本机 provider 名）
            const rawTargets = (effectiveTargets.length > 0 ? effectiveTargets : (settings.targetModels ?? []));
            const targets = rawTargets.length > 0
                ? rawTargets.map((t) => (t.includes('/') ? t.split('/').pop() : t)).join('\n- ')
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
            if (modelKey && perModel) {
                // per-model 模式：产出合并进该模型规则并记录运行状态
                const produced = parsed[0];
                merged.set(modelKey, { ...perModel, ...produced, key: modelKey, match: perModel.match, smartSources: perModel.smartSources, smartLastRunAt: entry.at, smartLastRunOk: true, smartLastError: undefined, updatedAt: new Date().toISOString() });
            }
            store.saveUser([...merged.values()]);
            entry.ok = true;
            entry.ruleCount = parsed.length;
        }
        catch (e) {
            entry.error = String(e).slice(0, 400);
            this.deps.logger.warn?.(`[dsh-agent-billing] 智能配置执行失败：${entry.error}`);
        }
        if (modelKey) {
            const merged = new Map(store.user().map((r) => [r.key, r]));
            const rule = merged.get(modelKey);
            if (rule) {
                merged.set(modelKey, { ...rule, smartLastRunAt: entry.at, smartLastRunOk: entry.ok, smartLastError: entry.error });
                store.saveUser([...merged.values()]);
            }
        }
        entry.durationMs = Date.now() - started;
        this.appendLog(entry);
        return entry;
    }
}
// ────────────────────────────── 插件入口 ──────────────────────────────
export function apply(ctx, config = {}) {
    if (config.budgets !== undefined) {
        for (const key of ['daily', 'monthly']) {
            const v = config.budgets[key];
            if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
                throw new Error(`dsh-agent-billing 配置 budgets.${key} 必须是正数，实际 ${JSON.stringify(v)}`);
            }
        }
    }
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    const stateDir = config.stateDir ?? join(dshHome, 'dsh-agent-billing');
    mkdirSync(stateDir, { recursive: true });
    const ledgerFile = join(stateDir, 'ledger.sqlite');
    const ledger = openLedger(ledgerFile);
    const store = new ProfileStore(join(stateDir, 'profiles.json'));
    const settingsStore = new SettingsStore(join(stateDir, 'settings.json'));
    const logger = { info: (m) => ctx.logger?.info?.(m), warn: (m) => ctx.logger?.warn?.(m) };
    const service = new BillingService(ledger, store, settingsStore, config, (depName) => (typeof ctx.get === 'function' ? ctx.get(depName) : undefined), stateDir, logger);
    ctx.inject(['webServer'], (host) => {
        const disposers = [];
        // 记账唯一通道 = 会话日志直扫（scanSessionLogs，status 轮询 + 5min tick 触发）
        // 0.1.5 投影事件对部分挂载方式不可达，且与直扫并存会双计——故不再注册投影单元
        disposers.push(mountRoutes(host.webServer, service));
        if (typeof host.setInterval === 'function') {
            disposers.push(host.setInterval(() => { try {
                service.scanSessionLogs(true);
            }
            catch { /* 直扫尽力而为 */ } void service.scheduledTick().catch((e) => logger.warn?.('[dsh-agent-billing] 定时调度失败：' + String(e).slice(0, 160))); }, 5 * 60_000));
        }
        else {
            logger.warn?.('[dsh-agent-billing] timer 服务缺席：官方库自动刷新与智能配置每日调度未启动');
        }
        ctx.logger?.info?.(`[${name}] v${version} 已挂载：账本 ${ledgerFile}，路由 /dsh-agent-billing/*（记账=直扫通道）`);
        return () => {
            for (const d of disposers.reverse()) {
                try {
                    d();
                }
                catch { /* 卸载尽力而为 */ }
            }
            try {
                ledger.db.close();
            }
            catch { /* 关闭尽力而为 */ }
        };
    });
}
//# sourceMappingURL=index.js.map