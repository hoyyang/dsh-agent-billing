import { type ModelRule } from './rules.js';
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
    /** 执行一次智能配置。sources 为空时使用 settings 里启用的全部源。 */
    run(settings: SmartSettings, store: {
        user(): ModelRule[];
        saveUser(r: ModelRule[]): void;
    }, trigger: 'manual' | 'daily', sourceIds?: string[]): Promise<SmartLogEntry>;
}
