export declare const name = "@dsh-external/dsh-agent-billing";
export declare const version = "0.2.3";
/** 账本投影单元 key（sessionProjections registry 命名空间）。 */
export declare const UNIT_KEY = "billingUsage";
/** 四档费率，单位：每 1M token 的货币量（业界惯例 USD）。 */
export interface Rate {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}
export interface BalanceConfig {
    adapter: 'deepseek' | 'openai-billing';
    baseUrl: string;
    apiKey: string;
}
/** 计费档案：一个 provider 路由（账号）一套费率。 */
export interface Profile {
    id: string;
    label: string;
    /** provider 路由匹配：精确名 / `*` / `pfx*` / `*sfx` / `*sub*`（大小写不敏感）。 */
    providerMatch: string;
    currency: string;
    discount?: number;
    rates: Rate;
    /** 按模型覆盖费率：键支持同款 mini-glob。 */
    byModel?: Record<string, Rate>;
    balance?: BalanceConfig;
}
export interface Config {
    stateDir?: string;
    budgets?: {
        daily?: number;
        monthly?: number;
    };
    /** 官方目录源（数据源地址不入库；未配置 = 自动刷新关闭，本地已存规则继续生效） */
    catalogSource?: {
        page?: string;
        bundleBase?: string;
    };
}
export interface RuleDims {
    input: number | null;
    cacheRead: number | null;
    cacheWrite5m: number | null;
    cacheWrite1h: number | null;
    output: number | null;
    reasoning: number | null;
}
export interface TimeTier {
    label: string;
    from: string;
    to: string;
    dims: RuleDims;
}
export interface ContextTier {
    label: string;
    dims: RuleDims;
}
export interface RuleExtra {
    name: string;
    label: string;
    raw: string;
}
export type BillingCurrency = 'CNY' | 'USD' | 'credit';
export type RuleSource = 'official' | 'manual' | 'smart';
export interface ModelRule {
    key: string;
    match: {
        provider: string;
        model: string;
    };
    label?: string;
    currency: BillingCurrency;
    unit?: string;
    base: RuleDims;
    tiers?: TimeTier[];
    contextTiers?: ContextTier[];
    extras?: RuleExtra[];
    free?: boolean;
    /** credit 币种的估算系数：每 1M token（input+output+cache 全量）≈ x credit */
    creditFactor?: number;
    /** cacheWrite 计入哪一档：'5m'（默认）| '1h' */
    writeMap?: '5m' | '1h';
    source: RuleSource;
    sourceRef?: string;
    updatedAt: string;
    /** per-model 智能配置：本模型自己的规则源（三种方式）+ 运行记录 */
    smartSources?: Array<{
        id: string;
        type: 'web' | 'text' | 'image';
        url?: string;
        text?: string;
        imageRefs?: Array<{
            attachmentId: string;
            mediaType: string;
            name?: string;
        }>;
        autoDaily?: boolean;
        enabled?: boolean;
    }>;
    smartLastRunAt?: string;
    smartLastRunOk?: boolean;
    smartLastError?: string;
}
export interface RuleStoreData {
    official?: {
        generatedAt: string;
        source: string;
        rules: ModelRule[];
    };
    user: ModelRule[];
}
export declare class ModelRuleStore {
    private stateDir;
    private cache;
    constructor(stateDir: string);
    private userFile;
    private officialFile;
    /** 官方库：stateDir 刷新版（若存在）> 内置种子（lib/official-rules.json） */
    official(): {
        generatedAt: string;
        source: string;
        rules: ModelRule[];
    };
    user(): ModelRule[];
    private ensure;
    invalidate(): void;
    saveUser(rules: ModelRule[]): void;
    saveOfficial(data: {
        generatedAt: string;
        source: string;
        rules: ModelRule[];
    }): void;
    /** 挂载后官方规则总数（用于刷新对比） */
    officialCount(): number;
}
export declare function matchModelRule(user: ModelRule[], official: ModelRule[], provider: string | null, model: string | null): {
    rule: ModelRule;
    layer: 'user' | 'official';
} | null;
export interface UsageRow {
    ts: number;
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens?: number;
}
export interface PricedResult {
    cost: number;
    costCny: number | null;
    costCredit: number | null;
    currency: string;
    ruleKey: string | null;
    layer: 'user' | 'official' | 'profile' | null;
    free: boolean;
}
export interface PriceContext {
    fx: number;
}
/** 用一条模型规则给一行用量计价 */
export declare function priceWithRule(rule: ModelRule, row: UsageRow, ctx: PriceContext, layer: 'user' | 'official'): PricedResult;
export declare function validateRule(raw: unknown, index: number): ModelRule;
/** 从目录页 HTML 提取当前数据 bundle URL */
export declare function extractDataBundleUrl(html: string, bundleBase: string): string | null;
/** 从 data bundle 源码提取内嵌 JSON（var e=JSON.parse(`...`)） */
export declare function extractProvidersJson(bundleSrc: string): unknown;
/** 目录 provider 数组 → 插件规则（与内置生成脚本同一转换逻辑） */
export declare function convertCatalogProviders(provs: any[]): ModelRule[];
/** 抓取并转换目录源全量官方规则；返回 { rules, changed }（与旧库按 key+updatedAt 对比） */
export declare function refreshOfficialCatalog(oldRules: ModelRule[], pageUrl: string, bundleBase: string): Promise<{
    rules: ModelRule[];
    changed: number;
    source: string;
}>;
export interface SmartSource {
    id: string;
    type: 'web' | 'text' | 'image';
    url?: string;
    text?: string;
    imageRefs?: Array<{
        attachmentId: string;
        mediaType: string;
        name?: string;
    }>;
    autoDaily?: boolean;
    enabled?: boolean;
}
export interface SmartSettings {
    enabled: boolean;
    agentProvider: string;
    agentModel: string;
    supportsVision?: boolean;
    sources: SmartSource[];
    targetModels?: string[];
    lastRunAt?: string;
    lastRunOk?: boolean;
}
export interface SmartLogEntry {
    at: string;
    trigger: 'manual' | 'daily';
    sources: string[];
    ok: boolean;
    ruleCount: number;
    error?: string;
    durationMs: number;
}
export interface SmartDeps {
    logger: {
        info?: (m: string) => void;
        warn?: (m: string) => void;
    };
    llm: () => any;
    attachments: () => any;
    logDir: string;
    officialKeys: () => string[];
}
export declare class SmartEngine {
    private deps;
    constructor(deps: SmartDeps);
    private logPath;
    private appendLog;
    readLog(limit?: number): SmartLogEntry[];
    /** 执行一次智能配置。modelKey 存在时 = per-model 模式（用该模型自己的源，只产出该模型规则）。 */
    run(settings: SmartSettings, store: {
        user(): ModelRule[];
        saveUser(r: ModelRule[]): void;
    }, trigger: 'manual' | 'daily', sourceIds?: string[], modelKey?: string): Promise<SmartLogEntry>;
}
export declare function apply(ctx: any, config?: Config): void;
