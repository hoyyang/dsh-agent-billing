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
}
export interface RuleStoreData {
    official?: {
        generatedAt: string;
        source: string;
        rules: ModelRule[];
    };
    user: ModelRule[];
}
export declare function globMatch(pattern: string, value: string): boolean;
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
/** 从 Catalog 页面 HTML 提取当前数据 bundle URL */
export declare function extractDataBundleUrl(html: string): string | null;
/** 从 data bundle 源码提取内嵌 JSON（var e=JSON.parse(`...`)） */
export declare function extractProvidersJson(bundleSrc: string): unknown;
/** Catalog provider 数组 → 插件规则（与内置生成脚本同一转换逻辑） */
export declare function convertCatalogProviders(provs: any[]): ModelRule[];
/** 抓取并转换 Catalog 全量官方规则；返回 { rules, changed }（与旧库按 key+updatedAt 对比） */
export declare function refreshOfficialFromCatalog(oldRules: ModelRule[]): Promise<{
    rules: ModelRule[];
    changed: number;
    source: string;
}>;
