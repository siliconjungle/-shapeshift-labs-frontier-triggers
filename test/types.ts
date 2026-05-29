import {
  createTriggerRegistryGraph,
  createTriggerRuntime,
  defineTrigger,
  normalizeTriggerEvent,
  traceTriggerImpact,
  type TriggerDefinition,
  type TriggerEmitResult,
  type TriggerEventEmission,
  type TriggerEvent,
  type TriggerInfo,
  type TriggerOutcome,
  type TriggerRecord,
  type TriggerRejection,
  type TriggerRuntime,
  type TriggerSnapshot
} from '../dist/index.js';

const definition: TriggerDefinition = defineTrigger({
  id: 'collision-start',
  event: 'physics.collision.start',
  scope: { kind: 'world', id: 'demo' },
  subjects: [{ kind: 'entity', role: 'player' }],
  requires: ['physics.read'],
  when: [{ path: 'payload.normal.1', lt: 0 }],
  action: {
    id: 'player.damage',
    mode: 'schedule',
    lane: 'gameplay',
    emit: {
      type: 'player.damaged',
      inheritScope: true,
      payload: { amount: 1 }
    }
  },
  input: { amount: 1 },
  emits: ['player.damaged']
});

const runtime: TriggerRuntime = createTriggerRuntime({ capabilities: ['physics.read'] });
runtime.register(definition);

const event: TriggerEvent = normalizeTriggerEvent({
  type: 'physics.collision.start',
  payload: { normal: [0, -1] }
});
const result: TriggerEmitResult = runtime.require(event);
const info: TriggerInfo = runtime.get('collision-start');
const outcome: TriggerOutcome | undefined = result.outcomes[0];
const rejection: TriggerRejection | undefined = result.rejection;
const record: TriggerRecord = result.record;
const records: TriggerRecord[] = result.records;
const cascaded: TriggerRecord[] = result.cascaded;
const snapshot: TriggerSnapshot = runtime.snapshot({ includeHistory: true });
const graph = createTriggerRegistryGraph(runtime);
const impact = traceTriggerImpact(runtime, { ids: ['trigger:collision-start'] });
const emission: TriggerEventEmission = { type: 'custom.runtime.event', inheritSubjects: true };

void info;
void outcome;
void rejection;
void record;
void records;
void cascaded;
void snapshot;
void graph;
void impact;
void emission;
