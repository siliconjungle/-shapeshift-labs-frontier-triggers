import { cloneJson } from '@shapeshift-labs/frontier/clone';
import { createFrontierRegistryGraph, frontierRegistryImpact } from '@shapeshift-labs/frontier/registry';
const DEFAULT_SOURCE = 'frontier.triggers';
const DEFAULT_MAX_HISTORY = 256;
export function createTriggerRuntime(options = {}) {
    return new FrontierTriggerRuntime(options);
}
export function defineTrigger(definition) {
    return cloneDefinition(definition);
}
export function createTriggerRegistryGraph(runtime) {
    return runtime.registryGraph();
}
export function traceTriggerImpact(runtime, input) {
    return runtime.impact(input);
}
export function normalizeTriggerEvent(input, options = {}) {
    if (!isNonEmptyString(input.type)) {
        throw new TypeError('trigger event type must be a non-empty string');
    }
    const timestamp = normalizeTimestamp(input.timestamp ?? options.now ?? Date.now());
    const id = isNonEmptyString(input.id)
        ? input.id
        : 'evt-' + (options.sequence ?? timestamp) + ':' + stableEventSuffix(input.type, input.subject);
    const source = isNonEmptyString(input.source) ? input.source : options.source ?? DEFAULT_SOURCE;
    return {
        id,
        type: input.type,
        source,
        subject: normalizeOptionalString(input.subject),
        scope: input.scope === undefined ? undefined : cloneScope(input.scope),
        subjects: (input.subjects ?? []).map(cloneSubject),
        actor: normalizeOptionalString(input.actor),
        causeId: normalizeOptionalString(input.causeId),
        tick: input.tick,
        timestamp,
        payload: input.payload === undefined ? cloneOptionalJson(input.data) : cloneOptionalJson(input.payload),
        metadata: input.metadata === undefined ? undefined : cloneJson(input.metadata),
        cancelable: input.cancelable ?? true
    };
}
class FrontierTriggerRuntime {
    options;
    definitions = new Map();
    records = [];
    onceKeys = new Set();
    cooldowns = new Map();
    maxHistory;
    nextEventSequence = 1;
    nextOutcomeSequence = 1;
    nextOrder = 1;
    constructor(options = {}) {
        this.options = options;
        this.maxHistory = normalizeHistoryLimit(options.maxHistory);
    }
    register(definition) {
        const normalized = this.normalizeDefinition(definition);
        this.definitions.set(normalized.id, normalized);
        return {
            id: normalized.id,
            unregister: () => this.unregister(normalized.id)
        };
    }
    unregister(id) {
        return this.definitions.delete(normalizeId(id, 'trigger id'));
    }
    has(id) {
        return this.definitions.has(normalizeId(id, 'trigger id'));
    }
    get(id) {
        const trigger = this.definitions.get(normalizeId(id, 'trigger id'));
        if (!trigger)
            throw new TypeError('unknown trigger: ' + id);
        return triggerInfo(trigger);
    }
    list() {
        return Array.from(this.definitions.values(), triggerInfo);
    }
    emit(input, options = {}) {
        return this.emitInternal(input, { ...options, require: options.require ?? false });
    }
    require(input, options = {}) {
        return this.emitInternal(input, { ...options, require: true });
    }
    replay(events, options = {}) {
        if (options.reset)
            this.reset();
        const records = [];
        let accepted = 0;
        let rejected = 0;
        for (let i = 0; i < events.length; i++) {
            const result = this.emitInternal(events[i], options);
            records[records.length] = cloneRecord(result.record);
            if (result.accepted)
                accepted++;
            else
                rejected++;
        }
        return { accepted, rejected, records };
    }
    history() {
        return this.records.map(cloneRecord);
    }
    clearHistory() {
        this.records.length = 0;
    }
    snapshot(options = {}) {
        const cooldowns = [];
        for (const entry of this.cooldowns.values())
            cooldowns[cooldowns.length] = { ...entry };
        return {
            kind: 'frontier.triggers.snapshot',
            version: 1,
            generatedAt: this.now(),
            definitions: this.list(),
            onceKeys: Array.from(this.onceKeys.values()).sort(),
            cooldowns: cooldowns.sort((left, right) => left.key.localeCompare(right.key)),
            records: options.includeHistory ? this.history() : undefined,
            nextEventSequence: this.nextEventSequence,
            nextOutcomeSequence: this.nextOutcomeSequence
        };
    }
    restore(snapshot, options = {}) {
        if (snapshot.kind !== 'frontier.triggers.snapshot' || snapshot.version !== 1) {
            throw new TypeError('invalid frontier trigger snapshot');
        }
        if (options.definitions ?? true) {
            this.definitions.clear();
            for (const info of snapshot.definitions) {
                this.definitions.set(info.id, this.normalizeDefinition(info));
            }
        }
        if (options.gates ?? true) {
            this.onceKeys.clear();
            for (const key of snapshot.onceKeys)
                this.onceKeys.add(key);
            this.cooldowns.clear();
            for (const entry of snapshot.cooldowns) {
                this.cooldowns.set(entry.triggerId + '\0' + entry.key, { ...entry });
            }
            this.nextEventSequence = Math.max(1, Math.floor(snapshot.nextEventSequence));
            this.nextOutcomeSequence = Math.max(1, Math.floor(snapshot.nextOutcomeSequence));
        }
        if (options.history ?? snapshot.records !== undefined) {
            this.records.length = 0;
            for (const record of snapshot.records ?? [])
                this.pushRecord(record);
        }
    }
    inspect() {
        const nodes = [];
        const edges = [];
        for (const trigger of this.definitions.values()) {
            const triggerNode = 'trigger:' + trigger.id;
            nodes[nodes.length] = {
                id: triggerNode,
                kind: 'trigger',
                label: trigger.id,
                metadata: trigger.metadata === undefined ? undefined : cloneJson(trigger.metadata)
            };
            for (const event of patternList(trigger.event)) {
                const eventNode = 'event:' + event;
                nodes[nodes.length] = { id: eventNode, kind: 'event', label: event };
                edges[edges.length] = { from: triggerNode, to: eventNode, kind: 'observes' };
            }
            for (const capability of trigger.requires) {
                const capabilityNode = 'capability:' + capability;
                nodes[nodes.length] = { id: capabilityNode, kind: 'capability', label: capability };
                edges[edges.length] = { from: triggerNode, to: capabilityNode, kind: 'requires' };
            }
            if (trigger.scope) {
                const scopeNode = 'scope:' + scopeMatcherKey(trigger.scope);
                nodes[nodes.length] = { id: scopeNode, kind: 'scope', label: scopeMatcherKey(trigger.scope) };
                edges[edges.length] = { from: triggerNode, to: scopeNode, kind: 'matches-scope' };
            }
            for (const subject of trigger.subjects) {
                const subjectNode = 'subject:' + subjectMatcherKey(subject);
                nodes[nodes.length] = { id: subjectNode, kind: 'subject', label: subjectMatcherKey(subject) };
                edges[edges.length] = { from: triggerNode, to: subjectNode, kind: 'matches-subject' };
            }
            for (const action of staticActionIds(trigger)) {
                const actionNode = 'action:' + action;
                nodes[nodes.length] = { id: actionNode, kind: 'action', label: action };
                edges[edges.length] = { from: triggerNode, to: actionNode, kind: 'schedules' };
            }
            for (const emitted of trigger.emits) {
                const eventNode = 'event:' + emitted;
                nodes[nodes.length] = { id: eventNode, kind: 'event', label: emitted };
                edges[edges.length] = { from: triggerNode, to: eventNode, kind: 'emits' };
            }
        }
        for (const record of this.records) {
            const recordNode = 'record:' + record.id;
            nodes[nodes.length] = {
                id: recordNode,
                kind: 'record',
                label: record.id,
                status: record.accepted ? 'ok' : 'rejected'
            };
            nodes[nodes.length] = { id: 'event:' + record.event.type, kind: 'event', label: record.event.type };
            edges[edges.length] = { from: 'event:' + record.event.type, to: recordNode, kind: 'recorded' };
            for (const outcome of record.outcomes) {
                edges[edges.length] = {
                    from: 'trigger:' + outcome.triggerId,
                    to: recordNode,
                    kind: outcome.status === 'scheduled' || outcome.status === 'completed' ? 'recorded' : 'consumed'
                };
            }
        }
        return {
            kind: 'frontier.triggers.graph',
            version: 1,
            nodes: dedupeNodes(nodes),
            edges: dedupeInspectEdges(edges)
        };
    }
    registryGraph() {
        const entries = Array.from(this.definitions.values(), triggerToRegistryEntry);
        const records = [];
        for (const record of this.records) {
            for (const outcome of record.outcomes) {
                records[records.length] = outcomeToRegistryRecord(record, outcome);
            }
        }
        return createFrontierRegistryGraph({
            entries,
            records,
            generatedAt: this.now(),
            metadata: { package: '@shapeshift-labs/frontier-triggers' }
        });
    }
    impact(input) {
        return frontierRegistryImpact(this.registryGraph(), input);
    }
    reset() {
        this.records.length = 0;
        this.onceKeys.clear();
        this.cooldowns.clear();
        this.nextEventSequence = 1;
        this.nextOutcomeSequence = 1;
    }
    emitInternal(input, options) {
        const now = normalizeTimestamp(options.now ?? this.now());
        let event;
        try {
            event = normalizeTriggerEvent({
                ...input,
                actor: input.actor ?? options.actor ?? this.options.actor,
                source: input.source ?? options.source ?? this.options.source,
                metadata: mergeJson(input.metadata, options.metadata)
            }, { now, source: options.source ?? this.options.source, sequence: this.nextEventSequence++ });
        }
        catch (error) {
            const rejection = makeRejection('invalid-event', errorMessage(error), undefined, input.id, input.type);
            event = {
                id: input.id ?? 'evt-invalid:' + this.nextEventSequence++,
                type: input.type ?? 'invalid',
                source: input.source ?? options.source ?? this.options.source ?? DEFAULT_SOURCE,
                subjects: [],
                timestamp: now,
                cancelable: true
            };
            return this.finalizeEmit(event, [], false, false, rejection, options);
        }
        const capabilities = mergeCapabilities(this.options.capabilities, options.capabilities);
        const state = options.state ?? this.options.state;
        const matches = [];
        const outcomes = [];
        const exclusiveGroups = new Set();
        const ordered = Array.from(this.definitions.values())
            .filter((trigger) => trigger.enabled !== false)
            .sort(compareTriggers);
        let consumed = false;
        for (const trigger of ordered) {
            const context = this.createEvaluationContext(trigger, event, capabilities, state, now);
            const staticRejection = evaluateStaticMatch(trigger, event);
            if (staticRejection) {
                outcomes[outcomes.length] = this.outcome(trigger, event, 'skipped', staticRejection, now);
                continue;
            }
            const capabilityRejection = evaluateCapabilities(trigger, event, context);
            if (capabilityRejection) {
                outcomes[outcomes.length] = this.outcome(trigger, event, 'rejected', capabilityRejection, now);
                continue;
            }
            const conditionRejection = evaluateConditions(trigger, event, context);
            if (conditionRejection) {
                outcomes[outcomes.length] = this.outcome(trigger, event, 'rejected', conditionRejection, now);
                continue;
            }
            const onceRejection = this.evaluateOnce(trigger, event, context);
            if (onceRejection) {
                outcomes[outcomes.length] = this.outcome(trigger, event, 'rejected', onceRejection, now);
                continue;
            }
            const cooldownRejection = this.evaluateCooldown(trigger, event, context, now);
            if (cooldownRejection) {
                outcomes[outcomes.length] = this.outcome(trigger, event, 'rejected', cooldownRejection, now);
                continue;
            }
            const exclusiveKey = trigger.exclusive === true ? event.type : typeof trigger.exclusive === 'string' ? trigger.exclusive : undefined;
            if (exclusiveKey && exclusiveGroups.has(exclusiveKey)) {
                outcomes[outcomes.length] = this.outcome(trigger, event, 'rejected', makeRejection('exclusive-conflict', 'trigger exclusive group already handled this event', trigger.id, event.id, event.type), now);
                continue;
            }
            matches[matches.length] = { trigger, context };
            if (exclusiveKey)
                exclusiveGroups.add(exclusiveKey);
            this.markOnce(trigger, event, context);
            this.markCooldown(trigger, event, context, now);
            const actionOutcomes = this.runActions(trigger, event, context, options, now);
            if (actionOutcomes.length === 0) {
                outcomes[outcomes.length] = this.outcome(trigger, event, 'matched', undefined, now);
            }
            else {
                for (const outcome of actionOutcomes)
                    outcomes[outcomes.length] = outcome;
            }
            if (trigger.consume) {
                consumed = true;
                if (event.cancelable)
                    break;
            }
        }
        const onlyActionable = outcomes.filter((outcome) => outcome.status !== 'skipped');
        const success = onlyActionable.some((outcome) => outcome.status === 'matched' || outcome.status === 'scheduled' || outcome.status === 'completed');
        const rejection = !success && options.require
            ? makeRejection('no-matching-trigger', matches.length === 0 ? 'no trigger matched event' : 'no trigger accepted event', undefined, event.id, event.type)
            : undefined;
        return this.finalizeEmit(event, outcomes, rejection === undefined, consumed, rejection, options);
    }
    finalizeEmit(event, outcomes, accepted, consumed, rejection, options) {
        const record = {
            id: 'trg-' + event.id + ':' + this.records.length,
            event: cloneEvent(event),
            accepted,
            consumed,
            timestamp: event.timestamp,
            outcomes: outcomes.map(cloneOutcome),
            rejection: rejection === undefined ? undefined : cloneRejection(rejection)
        };
        this.pushRecord(record);
        this.emitRecord(record, options);
        const matched = outcomes.filter((outcome) => outcome.status === 'matched' || outcome.status === 'scheduled' || outcome.status === 'completed');
        const rejected = outcomes.filter((outcome) => outcome.status === 'rejected' || outcome.status === 'skipped');
        const failed = outcomes.filter((outcome) => outcome.status === 'failed');
        const completed = outcomes.filter((outcome) => outcome.status === 'completed');
        const scheduled = outcomes.flatMap((outcome) => outcome.scheduled ? [cloneScheduled(outcome.scheduled)] : []);
        return {
            accepted,
            consumed,
            event: cloneEvent(event),
            record: cloneRecord(record),
            outcomes: outcomes.map(cloneOutcome),
            matched: matched.map(cloneOutcome),
            scheduled,
            completed: completed.map(cloneOutcome),
            rejected: rejected.map(cloneOutcome),
            failed: failed.map(cloneOutcome),
            rejection: rejection === undefined ? undefined : cloneRejection(rejection)
        };
    }
    runActions(trigger, event, context, options, now) {
        const actions = resolveActions(trigger, event, context);
        const outcomes = [];
        for (const action of actions) {
            const actionInput = resolveActionInput(action, trigger, event, context);
            const actionId = normalizeId(action.id, 'trigger action id');
            const actionOptions = this.actionOptions(trigger, action, event, context, options, actionId);
            const backend = options.actions ?? this.options.actions;
            const scheduler = actionOptions.scheduler;
            const mode = action.mode ?? options.mode ?? trigger.mode ?? 'auto';
            try {
                if (backend?.has && !backend.has(actionId)) {
                    outcomes[outcomes.length] = this.outcome(trigger, event, 'rejected', makeRejection('action-unavailable', 'trigger action is not registered: ' + actionId, trigger.id, event.id, event.type), now, actionId);
                    continue;
                }
                if (mode !== 'dispatch' && typeof backend?.schedule === 'function') {
                    const handle = backend.schedule(actionId, actionInput, actionOptions);
                    outcomes[outcomes.length] = this.scheduledOutcome(trigger, event, actionId, actionOptions, handle, now);
                    continue;
                }
                if (mode === 'schedule' && scheduler) {
                    const taskId = actionOptions.taskId ?? 'trigger-action:' + trigger.id + ':' + actionId + ':' + this.nextOutcomeSequence;
                    const handle = scheduler.schedule({
                        id: taskId,
                        type: 'frontier.trigger.action',
                        input: actionInput,
                        lane: actionOptions.lane,
                        area: actionOptions.area,
                        priority: actionOptions.priority,
                        units: actionOptions.units,
                        key: actionOptions.key,
                        causeId: actionOptions.causeId,
                        parentId: actionOptions.parentId,
                        dependsOn: actionOptions.dependsOn,
                        metadata: actionOptions.metadata,
                        run: action.run
                            ? () => action.run?.(event, context)
                            : typeof backend?.dispatch === 'function'
                                ? () => backend.dispatch?.(actionId, actionInput, actionOptions)
                                : undefined
                    });
                    if (actionOptions.autoRun)
                        requestSchedulerRun(scheduler, actionOptions.runOptions);
                    outcomes[outcomes.length] = this.scheduledOutcome(trigger, event, actionId, { ...actionOptions, taskId }, handle, now);
                    continue;
                }
                if (typeof backend?.dispatch === 'function') {
                    const value = backend.dispatch(actionId, actionInput, actionOptions);
                    outcomes[outcomes.length] = this.outcome(trigger, event, 'completed', undefined, now, actionId, value);
                    continue;
                }
                if (action.run) {
                    const value = action.run(event, context);
                    outcomes[outcomes.length] = this.outcome(trigger, event, 'completed', undefined, now, actionId, value);
                    continue;
                }
                outcomes[outcomes.length] = this.outcome(trigger, event, 'rejected', makeRejection('action-unavailable', 'trigger has no action backend for: ' + actionId, trigger.id, event.id, event.type), now, actionId);
            }
            catch (error) {
                outcomes[outcomes.length] = this.outcome(trigger, event, 'failed', makeRejection('action-failed', errorMessage(error), trigger.id, event.id, event.type), now, actionId);
            }
        }
        return outcomes;
    }
    actionOptions(trigger, action, event, context, options, actionId) {
        const metadata = mergeRecordMetadata({
            triggerId: trigger.id,
            eventId: event.id,
            eventType: event.type,
            actionId
        }, trigger.metadata, action.metadata, options.metadata);
        return {
            causeId: event.id,
            actor: event.actor ?? options.actor ?? this.options.actor,
            metadata,
            lane: action.lane ?? trigger.lane ?? this.options.schedulerLane ?? 'trigger',
            area: action.area ?? trigger.area ?? 'triggers',
            priority: action.priority ?? this.options.schedulerPriority ?? trigger.priority ?? 'normal',
            units: action.units ?? 1,
            key: resolveKey(action.key ?? trigger.key, event, context) ?? 'trigger:' + trigger.id + ':action:' + actionId,
            taskId: resolveKey(action.taskId, event, context),
            parentId: action.parentId ?? event.causeId,
            dependsOn: action.dependsOn,
            scheduler: options.scheduler ?? this.options.scheduler,
            autoRun: options.autoRun ?? this.options.schedulerAutoRun,
            runOptions: options.runOptions
        };
    }
    scheduledOutcome(trigger, event, actionId, options, handle, now) {
        return this.outcome(trigger, event, 'scheduled', undefined, now, actionId, undefined, {
            triggerId: trigger.id,
            actionId,
            taskId: options.taskId,
            lane: options.lane,
            key: options.key,
            handle
        });
    }
    outcome(trigger, event, status, rejection, now, actionId, value, scheduled) {
        const outcome = {
            id: 'out-' + this.nextOutcomeSequence++,
            triggerId: trigger.id,
            eventId: event.id,
            eventType: event.type,
            status,
            timestamp: now,
            actionId,
            scheduled: scheduled === undefined ? undefined : cloneScheduled(scheduled),
            rejection: rejection === undefined ? undefined : cloneRejection(rejection),
            value,
            metadata: trigger.metadata === undefined ? undefined : cloneJson(trigger.metadata)
        };
        this.emitOutcome(outcome);
        return outcome;
    }
    createEvaluationContext(trigger, event, capabilities, state, now) {
        return {
            runtime: this,
            trigger,
            event,
            state,
            capabilities,
            now,
            read(path) {
                return readContextPath({ event, payload: event.payload, data: event.payload, scope: event.scope, subjects: event.subjects, state }, path);
            },
            hasCapability(capability) {
                return hasCapability(capabilities, capability, event, { trigger, state, runtime: this.runtime, now });
            }
        };
    }
    evaluateOnce(trigger, event, context) {
        const onceKey = trigger.once ? event.type + ':' + (event.subject ?? event.id) : resolveKey(trigger.oncePer, event, context);
        if (!onceKey)
            return undefined;
        const key = trigger.id + '\0' + onceKey;
        return this.onceKeys.has(key)
            ? makeRejection('once-per', 'trigger once-per key has already fired', trigger.id, event.id, event.type, { onceKey })
            : undefined;
    }
    markOnce(trigger, event, context) {
        const onceKey = trigger.once ? event.type + ':' + (event.subject ?? event.id) : resolveKey(trigger.oncePer, event, context);
        if (onceKey)
            this.onceKeys.add(trigger.id + '\0' + onceKey);
    }
    evaluateCooldown(trigger, event, context, now) {
        if (!trigger.cooldownMs || trigger.cooldownMs <= 0)
            return undefined;
        const cooldownKey = resolveKey(trigger.cooldownKey, event, context) ?? event.type + ':' + (event.subject ?? event.id);
        const key = trigger.id + '\0' + cooldownKey;
        const current = this.cooldowns.get(key);
        if (current && current.retryAt > now) {
            return makeRejection('cooldown', 'trigger cooldown is active', trigger.id, event.id, event.type, { cooldownKey }, current.retryAt);
        }
        return undefined;
    }
    markCooldown(trigger, event, context, now) {
        if (!trigger.cooldownMs || trigger.cooldownMs <= 0)
            return;
        const cooldownKey = resolveKey(trigger.cooldownKey, event, context) ?? event.type + ':' + (event.subject ?? event.id);
        this.cooldowns.set(trigger.id + '\0' + cooldownKey, {
            triggerId: trigger.id,
            key: cooldownKey,
            lastAt: now,
            retryAt: now + trigger.cooldownMs
        });
    }
    emitRecord(record, options) {
        const cloned = cloneRecord(record);
        try {
            this.options.onRecord?.(cloned);
        }
        catch { }
        const logger = this.options.logger;
        try {
            if (record.accepted)
                logger?.info?.('frontier.triggers.emit', cloned);
            else
                logger?.error?.('frontier.triggers.emit', cloned);
        }
        catch { }
        const eventLog = options.eventLog ?? this.options.eventLog;
        if (eventLog) {
            appendEventLog(eventLog, { type: 'frontier.triggers.emit', record: recordToJson(cloned) }, record.event.id, { eventType: record.event.type, accepted: record.accepted }, options.eventLogMode ?? this.options.eventLogMode ?? 'frontier-event-log');
        }
    }
    emitOutcome(outcome) {
        try {
            this.options.onOutcome?.(cloneOutcome(outcome));
        }
        catch { }
    }
    pushRecord(record) {
        this.records[this.records.length] = cloneRecord(record);
        while (this.records.length > this.maxHistory)
            this.records.shift();
    }
    normalizeDefinition(definition) {
        const id = normalizeId(definition.id, 'trigger id');
        const event = definition.event ?? definition.events ?? '*';
        const subjects = normalizeSubjects(definition.subject, definition.subjects);
        return {
            ...cloneDefinition(definition),
            id,
            event: normalizeEventPattern(event),
            requires: normalizeStringList(definition.requires),
            when: definition.when ? definition.when.slice() : [],
            subjects,
            reads: (definition.reads ?? []).slice(),
            writes: (definition.writes ?? []).slice(),
            emits: normalizeStringList(definition.emits),
            tags: normalizeStringList(definition.tags),
            normalizedPriority: normalizePriority(definition.priority),
            normalizedOrder: this.nextOrder++
        };
    }
    now() {
        return normalizeTimestamp(this.options.now?.() ?? Date.now());
    }
}
function evaluateStaticMatch(trigger, event) {
    if (!matchesEventPattern(trigger.event, event.type)) {
        return makeRejection('no-matching-trigger', 'trigger does not observe event type', trigger.id, event.id, event.type);
    }
    if (trigger.source && trigger.source !== event.source) {
        return makeRejection('source-mismatch', 'trigger source does not match event source', trigger.id, event.id, event.type);
    }
    if (trigger.scope && !matchesScope(event.scope, trigger.scope)) {
        return makeRejection('scope-mismatch', 'trigger scope does not match event scope', trigger.id, event.id, event.type);
    }
    for (const subject of trigger.subjects) {
        if (!matchesSubject(event, subject)) {
            return makeRejection('subject-mismatch', 'trigger subject matcher did not match event subjects', trigger.id, event.id, event.type);
        }
    }
    return undefined;
}
function evaluateCapabilities(trigger, event, context) {
    for (const capability of trigger.requires) {
        if (!context.hasCapability(capability)) {
            return makeRejection('missing-capability', 'missing trigger capability: ' + capability, trigger.id, event.id, event.type, undefined, undefined, capability);
        }
    }
    return undefined;
}
function evaluateConditions(trigger, event, context) {
    for (const condition of trigger.when) {
        const result = evaluateCondition(condition, event, context);
        if (!result.accepted) {
            if (result.rejection)
                return result.rejection;
            const rejection = makeRejection('condition-failed', 'trigger condition failed', trigger.id, event.id, event.type);
            rejection.condition = conditionToJson(condition);
            return rejection;
        }
    }
    return undefined;
}
function evaluateCondition(condition, event, context) {
    if ('test' in condition && typeof condition.test === 'function') {
        const result = condition.test(event, context);
        if (typeof result === 'boolean')
            return { accepted: result };
        if (isRejection(result))
            return { accepted: false, rejection: result };
        return result;
    }
    if ('capability' in condition) {
        const accepted = context.hasCapability(condition.capability);
        return {
            accepted,
            rejection: accepted
                ? undefined
                : makeRejection('missing-capability', 'missing trigger capability: ' + condition.capability, context.trigger.id, event.id, event.type, undefined, undefined, condition.capability)
        };
    }
    if ('scope' in condition)
        return { accepted: matchesScope(event.scope, condition.scope) };
    if ('subject' in condition)
        return { accepted: matchesSubject(event, condition.subject) };
    if ('all' in condition || 'any' in condition || 'not' in condition) {
        if (condition.all) {
            for (const item of condition.all) {
                const result = evaluateCondition(item, event, context);
                if (!result.accepted)
                    return result;
            }
        }
        if (condition.any) {
            let any = false;
            let firstRejection;
            for (const item of condition.any) {
                const result = evaluateCondition(item, event, context);
                any = any || result.accepted;
                firstRejection ??= result.rejection;
            }
            if (!any)
                return { accepted: false, rejection: firstRejection };
        }
        if (condition.not) {
            const result = evaluateCondition(condition.not, event, context);
            if (result.accepted)
                return { accepted: false };
        }
        return { accepted: true };
    }
    const pathCondition = condition;
    const value = context.read(pathCondition.path);
    if (pathCondition.exists !== undefined && (value !== undefined) !== pathCondition.exists)
        return { accepted: false };
    if (pathCondition.truthy !== undefined && Boolean(value) !== pathCondition.truthy)
        return { accepted: false };
    if (pathCondition.equals !== undefined && !jsonEqual(value, pathCondition.equals))
        return { accepted: false };
    if (pathCondition.notEquals !== undefined && jsonEqual(value, pathCondition.notEquals))
        return { accepted: false };
    if (pathCondition.oneOf !== undefined && !pathCondition.oneOf.some((item) => jsonEqual(value, item)))
        return { accepted: false };
    if (pathCondition.gt !== undefined && !(typeof value === 'number' && value > pathCondition.gt))
        return { accepted: false };
    if (pathCondition.gte !== undefined && !(typeof value === 'number' && value >= pathCondition.gte))
        return { accepted: false };
    if (pathCondition.lt !== undefined && !(typeof value === 'number' && value < pathCondition.lt))
        return { accepted: false };
    if (pathCondition.lte !== undefined && !(typeof value === 'number' && value <= pathCondition.lte))
        return { accepted: false };
    return { accepted: true };
}
function resolveActions(trigger, event, context) {
    const actions = [];
    for (const action of trigger.actions ?? [])
        actions[actions.length] = normalizeActionBinding(action);
    const action = trigger.action;
    if (typeof action === 'string') {
        actions[actions.length] = { id: action };
    }
    else if (typeof action === 'function') {
        const result = action(event, context);
        if (typeof result === 'string')
            actions[actions.length] = { id: result };
        else if (isActionBindingArray(result)) {
            for (const item of result)
                actions[actions.length] = typeof item === 'string' ? { id: item } : cloneActionBinding(item);
        }
        else if (result && typeof result === 'object') {
            actions[actions.length] = cloneActionBinding(result);
        }
    }
    else if (action && typeof action === 'object') {
        actions[actions.length] = cloneActionBinding(action);
    }
    return actions;
}
function resolveActionInput(action, trigger, event, context) {
    const value = action.input ?? trigger.input;
    if (typeof value === 'function')
        return cloneOptionalJson(value(event, context));
    if (value !== undefined)
        return cloneOptionalJson(value);
    return cloneOptionalJson(event.payload);
}
function normalizeActionBinding(input) {
    return typeof input === 'string' ? { id: input } : cloneActionBinding(input);
}
function isActionBindingArray(value) {
    return Array.isArray(value);
}
function cloneActionBinding(input) {
    return {
        ...input,
        id: normalizeId(input.id, 'trigger action id'),
        metadata: input.metadata === undefined ? undefined : cloneJson(input.metadata),
        dependsOn: input.dependsOn === undefined ? undefined : input.dependsOn.slice()
    };
}
function hasCapability(source, capability, event, context) {
    if (!capability)
        return true;
    if (!source)
        return false;
    if (Array.isArray(source))
        return source.includes(capability);
    if (source instanceof Set)
        return source.has(capability);
    return source.has(capability, event, context);
}
function mergeCapabilities(left, right) {
    if (!left)
        return right;
    if (!right)
        return left;
    return {
        has(capability, event, context) {
            return hasCapability(left, capability, event, context) || hasCapability(right, capability, event, context);
        }
    };
}
function matchesEventPattern(pattern, type) {
    const patterns = patternList(pattern);
    for (const item of patterns) {
        if (item === '*' || item === type)
            return true;
        if (item.endsWith('*') && type.startsWith(item.slice(0, -1)))
            return true;
    }
    return false;
}
function matchesScope(scope, matcher) {
    if (!scope)
        return false;
    if (matcher.kind !== undefined && scope.kind !== matcher.kind)
        return false;
    if (matcher.id !== undefined && scope.id !== matcher.id)
        return false;
    if (matcher.tag !== undefined && !(scope.tags ?? []).includes(matcher.tag))
        return false;
    for (const tag of matcher.tags ?? []) {
        if (!(scope.tags ?? []).includes(tag))
            return false;
    }
    return true;
}
function matchesSubject(event, matcher) {
    if (matcher.subject !== undefined && event.subject !== matcher.subject)
        return false;
    if (matcher.subject !== undefined && Object.keys(matcher).length === 1)
        return true;
    for (const subject of event.subjects) {
        if (matcher.kind !== undefined && subject.kind !== matcher.kind)
            continue;
        if (matcher.id !== undefined && subject.id !== matcher.id)
            continue;
        if (matcher.role !== undefined && subject.role !== matcher.role)
            continue;
        if (matcher.tag !== undefined && !(subject.tags ?? []).includes(matcher.tag))
            continue;
        let tagsMatch = true;
        for (const tag of matcher.tags ?? []) {
            if (!(subject.tags ?? []).includes(tag)) {
                tagsMatch = false;
                break;
            }
        }
        if (tagsMatch)
            return true;
    }
    return false;
}
function readContextPath(root, path) {
    const segments = normalizePath(path);
    let current = root;
    for (const segment of segments) {
        if (current === null || current === undefined)
            return undefined;
        if (typeof current !== 'object')
            return undefined;
        current = current[segment];
    }
    return current;
}
function normalizePath(path) {
    if (typeof path !== 'string')
        return path.slice();
    if (path.startsWith('/')) {
        if (path === '/')
            return [''];
        return path.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    }
    return path.split('.').filter(Boolean).map((part) => {
        const number = Number(part);
        return Number.isInteger(number) && String(number) === part ? number : part;
    });
}
function triggerInfo(trigger) {
    return {
        id: trigger.id,
        event: Array.isArray(trigger.event) ? trigger.event.slice() : trigger.event,
        source: trigger.source,
        subject: cloneSubjectMatcherInput(trigger.subject),
        scope: trigger.scope === undefined ? undefined : { ...trigger.scope, tags: trigger.scope.tags?.slice() },
        subjects: trigger.subjects.map(cloneSubjectMatcher),
        requires: trigger.requires.slice(),
        when: trigger.when.slice(),
        priority: trigger.priority,
        enabled: trigger.enabled,
        once: trigger.once,
        oncePer: typeof trigger.oncePer === 'function' ? undefined : trigger.oncePer,
        cooldownMs: trigger.cooldownMs,
        cooldownKey: typeof trigger.cooldownKey === 'function' ? undefined : trigger.cooldownKey,
        exclusive: trigger.exclusive,
        consume: trigger.consume,
        mode: trigger.mode,
        lane: trigger.lane,
        area: trigger.area,
        key: typeof trigger.key === 'function' ? undefined : trigger.key,
        metadata: trigger.metadata === undefined ? undefined : cloneJson(trigger.metadata),
        description: trigger.description,
        package: trigger.package,
        feature: trigger.feature,
        owner: trigger.owner,
        version: trigger.version,
        contentHash: trigger.contentHash,
        sourceLocation: cloneSourceLocation(trigger.sourceLocation),
        reads: trigger.reads.slice(),
        writes: trigger.writes.slice(),
        emits: trigger.emits.slice(),
        tags: trigger.tags.slice(),
        hasRuntimeCallbacks: hasRuntimeCallbacks(trigger)
    };
}
function triggerToRegistryEntry(trigger) {
    const actionIds = staticActionIds(trigger);
    return {
        id: 'trigger:' + trigger.id,
        kind: 'event',
        description: trigger.description,
        package: trigger.package ?? '@shapeshift-labs/frontier-triggers',
        feature: trigger.feature,
        owner: trigger.owner,
        version: trigger.version,
        contentHash: trigger.contentHash,
        source: cloneSourceLocation(trigger.sourceLocation),
        reads: trigger.reads.map(pathToRegistryPath),
        writes: trigger.writes.map(pathToRegistryPath),
        calls: actionIds.map((id) => 'action:' + id),
        consumes: trigger.requires.map((capability) => 'capability:' + capability),
        handles: patternList(trigger.event).map((event) => 'event:' + event),
        observes: patternList(trigger.event).map((event) => 'event:' + event),
        produces: actionIds.map((id) => 'action:' + id),
        emits: trigger.emits.map((event) => 'event:' + event),
        tags: trigger.tags,
        metadata: mergeRecordMetadata({
            triggerId: trigger.id,
            exclusive: trigger.exclusive === undefined ? undefined : String(trigger.exclusive),
            consume: trigger.consume ?? false
        }, trigger.metadata)
    };
}
function outcomeToRegistryRecord(record, outcome) {
    return {
        id: 'trigger-record:' + record.id + ':' + outcome.id,
        entryId: 'trigger:' + outcome.triggerId,
        kind: 'event',
        causeId: record.event.causeId ?? record.event.id,
        parentId: record.event.causeId,
        status: outcome.status === 'failed' || outcome.status === 'rejected' ? 'error' : outcome.status === 'scheduled' ? 'pending' : 'ok',
        startedAt: outcome.timestamp,
        endedAt: outcome.timestamp,
        durationMs: 0,
        input: eventToJson(record.event),
        output: outcomeToJson(outcome),
        calls: outcome.actionId ? ['action:' + outcome.actionId] : undefined,
        affected: record.event.subjects.map((subject) => 'subject:' + subject.kind + ':' + subject.id),
        metadata: mergeRecordMetadata({
            eventId: record.event.id,
            eventType: record.event.type,
            outcomeStatus: outcome.status,
            rejectionCode: outcome.rejection?.code
        }, outcome.metadata),
        error: outcome.rejection?.message
    };
}
function recordToJson(record) {
    const out = {
        id: record.id,
        event: eventToJson(record.event),
        accepted: record.accepted,
        consumed: record.consumed,
        timestamp: record.timestamp,
        outcomes: record.outcomes.map(outcomeToJson)
    };
    if (record.rejection !== undefined)
        out.rejection = rejectionToJson(record.rejection);
    return out;
}
function eventToJson(event) {
    const out = {
        id: event.id,
        type: event.type,
        source: event.source,
        timestamp: event.timestamp,
        cancelable: event.cancelable,
        subjects: event.subjects.map(subjectToJson)
    };
    if (event.subject !== undefined)
        out.subject = event.subject;
    if (event.scope !== undefined)
        out.scope = scopeToJson(event.scope);
    if (event.actor !== undefined)
        out.actor = event.actor;
    if (event.causeId !== undefined)
        out.causeId = event.causeId;
    if (event.tick !== undefined)
        out.tick = event.tick;
    if (event.payload !== undefined)
        out.payload = cloneJson(event.payload);
    if (event.metadata !== undefined)
        out.metadata = cloneJson(event.metadata);
    return out;
}
function outcomeToJson(outcome) {
    const out = {
        id: outcome.id,
        triggerId: outcome.triggerId,
        eventId: outcome.eventId,
        eventType: outcome.eventType,
        status: outcome.status,
        timestamp: outcome.timestamp
    };
    if (outcome.actionId !== undefined)
        out.actionId = outcome.actionId;
    if (outcome.rejection !== undefined)
        out.rejection = rejectionToJson(outcome.rejection);
    if (outcome.scheduled !== undefined) {
        out.scheduled = {
            triggerId: outcome.scheduled.triggerId,
            actionId: outcome.scheduled.actionId,
            ...(outcome.scheduled.taskId === undefined ? {} : { taskId: outcome.scheduled.taskId }),
            ...(outcome.scheduled.lane === undefined ? {} : { lane: outcome.scheduled.lane }),
            ...(outcome.scheduled.key === undefined ? {} : { key: outcome.scheduled.key })
        };
    }
    if (outcome.metadata !== undefined)
        out.metadata = cloneJson(outcome.metadata);
    return out;
}
function rejectionToJson(rejection) {
    const out = {
        code: rejection.code,
        message: rejection.message
    };
    if (rejection.triggerId !== undefined)
        out.triggerId = rejection.triggerId;
    if (rejection.eventId !== undefined)
        out.eventId = rejection.eventId;
    if (rejection.eventType !== undefined)
        out.eventType = rejection.eventType;
    if (rejection.capability !== undefined)
        out.capability = rejection.capability;
    if (rejection.condition !== undefined)
        out.condition = cloneJson(rejection.condition);
    if (rejection.retryAt !== undefined)
        out.retryAt = rejection.retryAt;
    if (rejection.metadata !== undefined)
        out.metadata = cloneJson(rejection.metadata);
    return out;
}
function appendEventLog(eventLog, value, key, headers, mode) {
    try {
        if (mode === 'raw')
            eventLog.append(value);
        else
            eventLog.append({ value, key, headers });
    }
    catch { }
}
function requestSchedulerRun(scheduler, options) {
    if (typeof scheduler.requestRun === 'function')
        scheduler.requestRun(options);
    else if (typeof scheduler.run === 'function')
        scheduler.run(options);
}
function resolveKey(key, event, context) {
    if (key === undefined)
        return undefined;
    return typeof key === 'function' ? key(event, context) : key;
}
function normalizeSubjects(subject, subjects) {
    const out = [];
    if (typeof subject === 'string')
        out[out.length] = { subject };
    else if (subject)
        out[out.length] = cloneSubjectMatcher(subject);
    for (const item of subjects ?? [])
        out[out.length] = cloneSubjectMatcher(item);
    return out;
}
function normalizeEventPattern(pattern) {
    if (typeof pattern !== 'string')
        return normalizeStringList(pattern);
    return normalizePattern(pattern);
}
function patternList(pattern) {
    return typeof pattern !== 'string' ? pattern.map(normalizePattern) : [normalizePattern(pattern)];
}
function normalizePattern(pattern) {
    if (!isNonEmptyString(pattern))
        throw new TypeError('trigger event pattern must be a non-empty string');
    return pattern;
}
function normalizeStringList(values) {
    const out = [];
    for (const value of values ?? []) {
        if (isNonEmptyString(value) && !out.includes(value))
            out[out.length] = value;
    }
    return out;
}
function normalizeId(id, label) {
    if (!isNonEmptyString(id))
        throw new TypeError(label + ' must be a non-empty string');
    return id;
}
function normalizeOptionalString(value) {
    return isNonEmptyString(value) ? value : undefined;
}
function normalizeTimestamp(value) {
    return Number.isFinite(value) ? value : Date.now();
}
function normalizePriority(priority) {
    return Number.isFinite(priority) ? priority : 0;
}
function normalizeHistoryLimit(value) {
    if (value === 0)
        return 0;
    if (!Number.isFinite(value ?? NaN))
        return DEFAULT_MAX_HISTORY;
    return Math.max(0, Math.floor(value));
}
function compareTriggers(left, right) {
    return right.normalizedPriority - left.normalizedPriority || left.normalizedOrder - right.normalizedOrder;
}
function makeRejection(code, message, triggerId, eventId, eventType, metadata, retryAt, capability) {
    return {
        code,
        message,
        triggerId,
        eventId,
        eventType,
        capability,
        retryAt,
        metadata: metadata === undefined ? undefined : cloneJson(metadata)
    };
}
function isRejection(value) {
    return value !== null && typeof value === 'object' && typeof value.code === 'string' && typeof value.message === 'string';
}
function cloneDefinition(definition) {
    return {
        ...definition,
        metadata: definition.metadata === undefined ? undefined : cloneJson(definition.metadata),
        sourceLocation: cloneSourceLocation(definition.sourceLocation),
        requires: definition.requires?.slice(),
        when: definition.when?.slice(),
        subjects: definition.subjects?.map(cloneSubjectMatcher),
        reads: definition.reads?.slice(),
        writes: definition.writes?.slice(),
        emits: definition.emits?.slice(),
        tags: definition.tags?.slice(),
        actions: definition.actions?.map((action) => typeof action === 'string' ? action : cloneActionBinding(action))
    };
}
function cloneEvent(event) {
    return {
        id: event.id,
        type: event.type,
        source: event.source,
        subject: event.subject,
        scope: event.scope === undefined ? undefined : cloneScope(event.scope),
        subjects: event.subjects.map(cloneSubject),
        actor: event.actor,
        causeId: event.causeId,
        tick: event.tick,
        timestamp: event.timestamp,
        payload: cloneOptionalJson(event.payload),
        metadata: event.metadata === undefined ? undefined : cloneJson(event.metadata),
        cancelable: event.cancelable
    };
}
function cloneScope(scope) {
    return {
        kind: normalizeId(scope.kind, 'trigger scope kind'),
        id: normalizeOptionalString(scope.id),
        tags: scope.tags?.slice(),
        metadata: scope.metadata === undefined ? undefined : cloneJson(scope.metadata)
    };
}
function cloneSubject(subject) {
    return {
        kind: normalizeId(subject.kind, 'trigger subject kind'),
        id: normalizeId(subject.id, 'trigger subject id'),
        role: normalizeOptionalString(subject.role),
        tags: subject.tags?.slice(),
        fields: subject.fields === undefined ? undefined : cloneJson(subject.fields)
    };
}
function subjectToJson(subject) {
    const out = { kind: subject.kind, id: subject.id };
    if (subject.role !== undefined)
        out.role = subject.role;
    if (subject.tags !== undefined)
        out.tags = subject.tags.slice();
    if (subject.fields !== undefined)
        out.fields = cloneJson(subject.fields);
    return out;
}
function scopeToJson(scope) {
    const out = { kind: scope.kind };
    if (scope.id !== undefined)
        out.id = scope.id;
    if (scope.tags !== undefined)
        out.tags = scope.tags.slice();
    if (scope.metadata !== undefined)
        out.metadata = cloneJson(scope.metadata);
    return out;
}
function cloneSubjectMatcher(matcher) {
    return {
        ...matcher,
        tags: matcher.tags?.slice()
    };
}
function cloneSubjectMatcherInput(subject) {
    if (typeof subject === 'string' || subject === undefined)
        return subject;
    return cloneSubjectMatcher(subject);
}
function cloneSourceLocation(source) {
    if (source === undefined)
        return undefined;
    if (Array.isArray(source))
        return source.map((item) => ({ ...item }));
    return { ...source };
}
function cloneOptionalJson(value) {
    return (value === undefined ? undefined : cloneJson(value));
}
function cloneRecord(record) {
    return {
        id: record.id,
        event: cloneEvent(record.event),
        accepted: record.accepted,
        consumed: record.consumed,
        timestamp: record.timestamp,
        outcomes: record.outcomes.map(cloneOutcome),
        rejection: record.rejection === undefined ? undefined : cloneRejection(record.rejection)
    };
}
function cloneOutcome(outcome) {
    return {
        ...outcome,
        scheduled: outcome.scheduled === undefined ? undefined : cloneScheduled(outcome.scheduled),
        rejection: outcome.rejection === undefined ? undefined : cloneRejection(outcome.rejection),
        metadata: outcome.metadata === undefined ? undefined : cloneJson(outcome.metadata)
    };
}
function cloneScheduled(scheduled) {
    return { ...scheduled };
}
function cloneRejection(rejection) {
    return {
        ...rejection,
        condition: rejection.condition === undefined ? undefined : cloneJson(rejection.condition),
        metadata: rejection.metadata === undefined ? undefined : cloneJson(rejection.metadata)
    };
}
function mergeJson(left, right) {
    if (left === undefined)
        return right === undefined ? undefined : cloneJson(right);
    if (right === undefined)
        return cloneJson(left);
    return { ...cloneJson(left), ...cloneJson(right) };
}
function mergeRecordMetadata(...items) {
    const out = {};
    for (const item of items) {
        if (!item)
            continue;
        for (const [key, value] of Object.entries(item)) {
            if (value !== undefined && isJsonValue(value))
                out[key] = cloneJson(value);
        }
    }
    return Object.keys(out).length === 0 ? undefined : out;
}
function conditionToJson(condition) {
    if ('path' in condition) {
        const out = { path: typeof condition.path === 'string' ? condition.path : condition.path.map(String).join('.') };
        if (condition.exists !== undefined)
            out.exists = condition.exists;
        if (condition.equals !== undefined)
            out.equals = cloneJson(condition.equals);
        if (condition.notEquals !== undefined)
            out.notEquals = cloneJson(condition.notEquals);
        if (condition.oneOf !== undefined)
            out.oneOf = condition.oneOf.map((value) => cloneJson(value));
        if (condition.truthy !== undefined)
            out.truthy = condition.truthy;
        if (condition.gt !== undefined)
            out.gt = condition.gt;
        if (condition.gte !== undefined)
            out.gte = condition.gte;
        if (condition.lt !== undefined)
            out.lt = condition.lt;
        if (condition.lte !== undefined)
            out.lte = condition.lte;
        return out;
    }
    if ('capability' in condition)
        return { capability: condition.capability };
    if ('scope' in condition)
        return { scope: matcherToJson(condition.scope) };
    if ('subject' in condition)
        return { subject: matcherToJson(condition.subject) };
    if ('test' in condition)
        return { predicate: true };
    const out = {};
    if (condition.all)
        out.all = condition.all.map(conditionToJson);
    if (condition.any)
        out.any = condition.any.map(conditionToJson);
    if (condition.not)
        out.not = conditionToJson(condition.not);
    return out;
}
function matcherToJson(matcher) {
    const out = {};
    for (const [key, value] of Object.entries(matcher)) {
        if (value !== undefined && isJsonValue(value))
            out[key] = cloneJson(value);
    }
    return out;
}
function staticActionIds(trigger) {
    const ids = [];
    for (const action of trigger.actions ?? []) {
        const id = typeof action === 'string' ? action : action.id;
        if (isNonEmptyString(id) && !ids.includes(id))
            ids[ids.length] = id;
    }
    if (typeof trigger.action === 'string' && !ids.includes(trigger.action))
        ids[ids.length] = trigger.action;
    if (trigger.action && typeof trigger.action === 'object' && 'id' in trigger.action && !ids.includes(trigger.action.id)) {
        ids[ids.length] = trigger.action.id;
    }
    return ids;
}
function hasRuntimeCallbacks(trigger) {
    return typeof trigger.action === 'function' ||
        typeof trigger.input === 'function' ||
        typeof trigger.key === 'function' ||
        typeof trigger.oncePer === 'function' ||
        typeof trigger.cooldownKey === 'function' ||
        (trigger.when ?? []).some(conditionHasCallback) ||
        (trigger.actions ?? []).some((action) => typeof action !== 'string' && (typeof action.input === 'function' || typeof action.key === 'function' || typeof action.taskId === 'function' || typeof action.run === 'function'));
}
function conditionHasCallback(condition) {
    if ('test' in condition)
        return true;
    if ('all' in condition && condition.all?.some(conditionHasCallback))
        return true;
    if ('any' in condition && condition.any?.some(conditionHasCallback))
        return true;
    if ('not' in condition && condition.not && conditionHasCallback(condition.not))
        return true;
    return false;
}
function pathToRegistryPath(path) {
    return Array.isArray(path) ? path.slice() : path;
}
function scopeMatcherKey(scope) {
    return [scope.kind ?? '*', scope.id ?? '*', ...(scope.tags ?? []), scope.tag ?? ''].filter(Boolean).join(':');
}
function subjectMatcherKey(subject) {
    return [subject.subject ?? '', subject.kind ?? '*', subject.role ?? '*', subject.id ?? '*', ...(subject.tags ?? []), subject.tag ?? ''].filter(Boolean).join(':');
}
function dedupeNodes(nodes) {
    const seen = new Set();
    const out = [];
    for (const node of nodes) {
        if (seen.has(node.id))
            continue;
        seen.add(node.id);
        out[out.length] = node;
    }
    return out;
}
function dedupeInspectEdges(edges) {
    const seen = new Set();
    const out = [];
    for (const edge of edges) {
        const key = edge.from + '\0' + edge.to + '\0' + edge.kind;
        if (seen.has(key))
            continue;
        seen.add(key);
        out[out.length] = edge;
    }
    return out;
}
function jsonEqual(left, right) {
    if (left === right)
        return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
            return false;
        for (let i = 0; i < left.length; i++) {
            if (!jsonEqual(left[i], right[i]))
                return false;
        }
        return true;
    }
    if (isPlainObject(left) || isPlainObject(right)) {
        if (!isPlainObject(left) || !isPlainObject(right))
            return false;
        const leftKeys = Object.keys(left).sort();
        const rightKeys = Object.keys(right).sort();
        if (leftKeys.length !== rightKeys.length)
            return false;
        for (let i = 0; i < leftKeys.length; i++) {
            const key = leftKeys[i];
            if (key !== rightKeys[i] || !jsonEqual(left[key], right[key]))
                return false;
        }
        return true;
    }
    return false;
}
function isJsonValue(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return true;
    if (typeof value === 'number')
        return Number.isFinite(value);
    if (Array.isArray(value))
        return value.every(isJsonValue);
    if (isPlainObject(value))
        return Object.values(value).every(isJsonValue);
    return false;
}
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function stableEventSuffix(type, subject) {
    let hash = 2166136261;
    const text = type + '\0' + (subject ?? '');
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=index.js.map