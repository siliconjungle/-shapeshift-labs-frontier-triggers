import { type FrontierRegistryGraph, type FrontierRegistryImpact, type FrontierRegistryImpactInput } from '@shapeshift-labs/frontier/registry';
import type { JsonObject, JsonValue } from '@shapeshift-labs/frontier/types';
export type TriggerEventPattern = string | readonly string[];
export type TriggerPath = string | readonly (string | number)[];
export type TriggerDispatchMode = 'auto' | 'schedule' | 'dispatch';
export type TriggerEventLogMode = 'frontier-event-log' | 'raw';
export interface TriggerScope {
    kind: string;
    id?: string;
    tags?: readonly string[];
    metadata?: JsonObject;
}
export interface TriggerSubject {
    kind: string;
    id: string;
    role?: string;
    tags?: readonly string[];
    fields?: JsonObject;
}
export interface TriggerEventInput {
    id?: string;
    type: string;
    source?: string;
    subject?: string;
    scope?: TriggerScope;
    subjects?: readonly TriggerSubject[];
    actor?: string;
    causeId?: string;
    tick?: number;
    timestamp?: number;
    payload?: JsonValue;
    data?: JsonValue;
    metadata?: JsonObject;
    cancelable?: boolean;
}
export interface TriggerEvent {
    id: string;
    type: string;
    source: string;
    subject?: string;
    scope?: TriggerScope;
    subjects: TriggerSubject[];
    actor?: string;
    causeId?: string;
    tick?: number;
    timestamp: number;
    payload?: JsonValue;
    metadata?: JsonObject;
    cancelable: boolean;
}
export interface TriggerScopeMatcher {
    kind?: string;
    id?: string;
    tag?: string;
    tags?: readonly string[];
}
export interface TriggerSubjectMatcher {
    kind?: string;
    id?: string;
    role?: string;
    subject?: string;
    tag?: string;
    tags?: readonly string[];
}
export interface TriggerPathCondition {
    path: TriggerPath;
    exists?: boolean;
    equals?: JsonValue;
    notEquals?: JsonValue;
    oneOf?: readonly JsonValue[];
    truthy?: boolean;
    gt?: number;
    gte?: number;
    lt?: number;
    lte?: number;
}
export interface TriggerCapabilityCondition {
    capability: string;
}
export interface TriggerScopeCondition {
    scope: TriggerScopeMatcher;
}
export interface TriggerSubjectCondition {
    subject: TriggerSubjectMatcher;
}
export interface TriggerLogicalCondition {
    all?: readonly TriggerCondition[];
    any?: readonly TriggerCondition[];
    not?: TriggerCondition;
}
export interface TriggerPredicateCondition {
    test(event: TriggerEvent, context: TriggerEvaluationContext): boolean | TriggerRejection | TriggerConditionResult;
}
export type TriggerCondition = TriggerPathCondition | TriggerCapabilityCondition | TriggerScopeCondition | TriggerSubjectCondition | TriggerLogicalCondition | TriggerPredicateCondition;
export interface TriggerConditionResult {
    accepted: boolean;
    rejection?: TriggerRejection;
}
export type TriggerCapabilitySource = readonly string[] | Set<string> | {
    has(capability: string, event: TriggerEvent, context: TriggerCapabilityContext): boolean;
};
export interface TriggerCapabilityContext {
    trigger?: TriggerDefinition;
    state?: unknown;
    runtime?: TriggerRuntime;
    now: number;
}
export interface TriggerActionBinding {
    id: string;
    input?: JsonValue | TriggerActionInputFactory;
    mode?: TriggerDispatchMode;
    lane?: string;
    area?: string;
    priority?: unknown;
    units?: number;
    key?: string | TriggerKeyFactory;
    taskId?: string | TriggerKeyFactory;
    parentId?: string;
    dependsOn?: readonly string[];
    metadata?: JsonObject;
    run?: TriggerScheduledRun;
}
export type TriggerActionInputFactory = (event: TriggerEvent, context: TriggerEvaluationContext) => JsonValue | undefined;
export type TriggerActionFactory = (event: TriggerEvent, context: TriggerEvaluationContext) => TriggerActionBinding | readonly TriggerActionBinding[] | string | false | null | undefined;
export type TriggerKeyFactory = (event: TriggerEvent, context: TriggerEvaluationContext) => string;
export type TriggerScheduledRun = (event: TriggerEvent, context: TriggerEvaluationContext) => unknown;
export interface TriggerSourceLocation {
    file: string;
    line?: number;
    column?: number;
    symbol?: string;
    package?: string;
}
export interface TriggerDefinition {
    id: string;
    event?: TriggerEventPattern;
    events?: TriggerEventPattern;
    source?: string;
    subject?: string | TriggerSubjectMatcher;
    scope?: TriggerScopeMatcher;
    subjects?: readonly TriggerSubjectMatcher[];
    requires?: readonly string[];
    when?: readonly TriggerCondition[];
    priority?: number;
    enabled?: boolean;
    once?: boolean;
    oncePer?: string | TriggerKeyFactory;
    cooldownMs?: number;
    cooldownKey?: string | TriggerKeyFactory;
    exclusive?: boolean | string;
    consume?: boolean;
    action?: string | TriggerActionBinding | TriggerActionFactory;
    actions?: readonly (string | TriggerActionBinding)[];
    input?: JsonValue | TriggerActionInputFactory;
    mode?: TriggerDispatchMode;
    lane?: string;
    area?: string;
    key?: string | TriggerKeyFactory;
    metadata?: JsonObject;
    description?: string;
    package?: string;
    feature?: string;
    owner?: string;
    version?: string;
    contentHash?: string;
    sourceLocation?: TriggerSourceLocation | readonly TriggerSourceLocation[];
    reads?: readonly TriggerPath[];
    writes?: readonly TriggerPath[];
    emits?: readonly string[];
    tags?: readonly string[];
}
export interface TriggerInfo extends Omit<TriggerDefinition, 'action' | 'actions' | 'input' | 'when'> {
    event: TriggerEventPattern;
    requires: string[];
    when: TriggerCondition[];
    subjects: TriggerSubjectMatcher[];
    reads: TriggerPath[];
    writes: TriggerPath[];
    emits: string[];
    tags: string[];
    hasRuntimeCallbacks: boolean;
}
export type TriggerRejectCode = 'invalid-event' | 'no-matching-trigger' | 'scope-mismatch' | 'subject-mismatch' | 'source-mismatch' | 'missing-capability' | 'condition-failed' | 'cooldown' | 'once-per' | 'exclusive-conflict' | 'event-consumed' | 'action-unavailable' | 'action-failed';
export interface TriggerRejection {
    code: TriggerRejectCode;
    message: string;
    triggerId?: string;
    eventId?: string;
    eventType?: string;
    capability?: string;
    condition?: JsonValue;
    retryAt?: number;
    metadata?: JsonObject;
}
export type TriggerOutcomeStatus = 'skipped' | 'rejected' | 'matched' | 'scheduled' | 'completed' | 'failed';
export interface TriggerScheduledAction {
    triggerId: string;
    actionId: string;
    taskId?: string;
    lane?: string;
    key?: string;
    handle?: unknown;
}
export interface TriggerOutcome {
    id: string;
    triggerId: string;
    eventId: string;
    eventType: string;
    status: TriggerOutcomeStatus;
    timestamp: number;
    actionId?: string;
    scheduled?: TriggerScheduledAction;
    rejection?: TriggerRejection;
    value?: unknown;
    metadata?: JsonObject;
}
export interface TriggerRecord {
    id: string;
    event: TriggerEvent;
    accepted: boolean;
    consumed: boolean;
    timestamp: number;
    outcomes: TriggerOutcome[];
    rejection?: TriggerRejection;
}
export interface TriggerEmitResult {
    accepted: boolean;
    consumed: boolean;
    event: TriggerEvent;
    record: TriggerRecord;
    outcomes: TriggerOutcome[];
    matched: TriggerOutcome[];
    scheduled: TriggerScheduledAction[];
    completed: TriggerOutcome[];
    rejected: TriggerOutcome[];
    failed: TriggerOutcome[];
    rejection?: TriggerRejection;
}
export interface TriggerReplayResult {
    accepted: number;
    rejected: number;
    records: TriggerRecord[];
}
export interface TriggerSnapshot {
    kind: 'frontier.triggers.snapshot';
    version: 1;
    generatedAt: number;
    definitions: TriggerInfo[];
    onceKeys: string[];
    cooldowns: TriggerCooldownSnapshot[];
    records?: TriggerRecord[];
    nextEventSequence: number;
    nextOutcomeSequence: number;
}
export interface TriggerCooldownSnapshot {
    key: string;
    triggerId: string;
    lastAt: number;
    retryAt: number;
}
export interface TriggerInspectGraphNode {
    id: string;
    kind: 'trigger' | 'event' | 'action' | 'capability' | 'scope' | 'subject' | 'record';
    label?: string;
    status?: string;
    metadata?: JsonObject;
}
export interface TriggerInspectGraphEdge {
    from: string;
    to: string;
    kind: 'observes' | 'requires' | 'matches-scope' | 'matches-subject' | 'schedules' | 'emits' | 'recorded' | 'consumed';
    metadata?: JsonObject;
}
export interface TriggerInspectGraph {
    kind: 'frontier.triggers.graph';
    version: 1;
    nodes: TriggerInspectGraphNode[];
    edges: TriggerInspectGraphEdge[];
}
export interface TriggerActionScheduleOptions {
    causeId?: string;
    actor?: string;
    metadata?: Record<string, unknown>;
    lane?: string;
    area?: string;
    priority?: unknown;
    units?: number;
    key?: string;
    taskId?: string;
    parentId?: string;
    dependsOn?: readonly string[];
    scheduler?: TriggerSchedulerLike;
    autoRun?: boolean;
    runOptions?: unknown;
}
export interface TriggerActionRegistryLike {
    has?(id: string): boolean;
    dispatch?(id: string, input?: JsonValue, options?: TriggerActionScheduleOptions): unknown;
    schedule?(id: string, input?: JsonValue, options?: TriggerActionScheduleOptions): unknown;
}
export interface TriggerSchedulerTask {
    id?: string;
    type?: string;
    input?: unknown;
    lane?: string;
    area?: string;
    priority?: unknown;
    units?: number;
    key?: string;
    causeId?: string;
    parentId?: string;
    dependsOn?: readonly string[];
    metadata?: Record<string, unknown>;
    run?(context?: unknown): unknown;
}
export interface TriggerSchedulerLike {
    schedule(task: TriggerSchedulerTask): unknown;
    run?(options?: unknown): unknown;
    requestRun?(options?: unknown): unknown;
}
export interface TriggerEventLogLike {
    append(input: unknown): unknown;
    tryAppend?(input: unknown): unknown;
}
export interface TriggerLoggerLike {
    debug?(message: string, attributes?: Record<string, unknown>): void;
    info?(message: string, attributes?: Record<string, unknown>): void;
    error?(message: string, attributes?: Record<string, unknown>): void;
}
export interface TriggerRuntimeOptions {
    actions?: TriggerActionRegistryLike;
    scheduler?: TriggerSchedulerLike;
    eventLog?: TriggerEventLogLike;
    eventLogMode?: TriggerEventLogMode;
    logger?: TriggerLoggerLike;
    capabilities?: TriggerCapabilitySource;
    state?: unknown;
    actor?: string;
    source?: string;
    now?: () => number;
    maxHistory?: number;
    schedulerAutoRun?: boolean;
    schedulerLane?: string;
    schedulerPriority?: unknown;
    onRecord?: (record: TriggerRecord) => void;
    onOutcome?: (outcome: TriggerOutcome) => void;
}
export interface TriggerEmitOptions {
    actions?: TriggerActionRegistryLike;
    scheduler?: TriggerSchedulerLike;
    eventLog?: TriggerEventLogLike;
    eventLogMode?: TriggerEventLogMode;
    capabilities?: TriggerCapabilitySource;
    state?: unknown;
    actor?: string;
    source?: string;
    metadata?: JsonObject;
    require?: boolean;
    mode?: TriggerDispatchMode;
    autoRun?: boolean;
    runOptions?: unknown;
    now?: number;
}
export interface TriggerEvaluationContext {
    runtime: TriggerRuntime;
    trigger: TriggerDefinition;
    event: TriggerEvent;
    state?: unknown;
    capabilities?: TriggerCapabilitySource;
    now: number;
    read(path: TriggerPath): unknown;
    hasCapability(capability: string): boolean;
}
export interface TriggerRegistration {
    id: string;
    unregister(): boolean;
}
export interface TriggerRuntime {
    register(definition: TriggerDefinition): TriggerRegistration;
    unregister(id: string): boolean;
    has(id: string): boolean;
    get(id: string): TriggerInfo;
    list(): TriggerInfo[];
    emit(event: TriggerEventInput, options?: TriggerEmitOptions): TriggerEmitResult;
    require(event: TriggerEventInput, options?: TriggerEmitOptions): TriggerEmitResult;
    replay(events: readonly TriggerEventInput[], options?: TriggerEmitOptions & {
        reset?: boolean;
    }): TriggerReplayResult;
    history(): TriggerRecord[];
    clearHistory(): void;
    snapshot(options?: {
        includeHistory?: boolean;
    }): TriggerSnapshot;
    restore(snapshot: TriggerSnapshot, options?: {
        definitions?: boolean;
        gates?: boolean;
        history?: boolean;
    }): void;
    inspect(): TriggerInspectGraph;
    registryGraph(): FrontierRegistryGraph;
    impact(input: FrontierRegistryImpactInput): FrontierRegistryImpact;
    reset(): void;
}
export declare function createTriggerRuntime(options?: TriggerRuntimeOptions): TriggerRuntime;
export declare function defineTrigger(definition: TriggerDefinition): TriggerDefinition;
export declare function createTriggerRegistryGraph(runtime: TriggerRuntime): FrontierRegistryGraph;
export declare function traceTriggerImpact(runtime: TriggerRuntime, input: FrontierRegistryImpactInput): FrontierRegistryImpact;
export declare function normalizeTriggerEvent(input: TriggerEventInput, options?: {
    now?: number;
    source?: string;
    sequence?: number;
}): TriggerEvent;
//# sourceMappingURL=index.d.ts.map