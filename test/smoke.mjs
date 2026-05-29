import assert from 'node:assert';
import {
  createTriggerRegistryGraph,
  createTriggerRuntime,
  normalizeTriggerEvent,
  traceTriggerImpact
} from '../dist/index.js';

const scheduled = [];
const dispatched = [];
const eventLogRecords = [];
const schedulerTasks = [];
let now = 1000;

const actions = {
  has(id) {
    return id === 'inventory.add' || id === 'ui.toast' || id === 'sound.play';
  },
  schedule(id, input, options) {
    const task = {
      id: options.taskId ?? 'task:' + id + ':' + scheduled.length,
      type: 'frontier.mutation.action',
      input,
      lane: options.lane,
      key: options.key,
      causeId: options.causeId,
      metadata: options.metadata
    };
    scheduled.push({ id, input, options, task });
    return task;
  },
  dispatch(id, input, options) {
    dispatched.push({ id, input, options });
    return { ok: true, id, input };
  }
};

const scheduler = {
  schedule(task) {
    schedulerTasks.push(task);
    return { id: task.id ?? 'direct:' + schedulerTasks.length };
  },
  requestRun() {}
};

const eventLog = {
  append(input) {
    eventLogRecords.push(input);
    return { offset: eventLogRecords.length - 1, value: input.value ?? input };
  }
};

const runtime = createTriggerRuntime({
  actions,
  scheduler,
  eventLog,
  now: () => now,
  schedulerAutoRun: true,
  capabilities: ['inventory.write', 'ui.toast'],
  state: {
    flags: {},
    player: { grounded: true }
  }
});

runtime.register({
  id: 'room.enter.grant-key',
  event: ['game.room.enter', 'custom.runtime.event'],
  source: 'inkwell.runtime',
  scope: { kind: 'world', id: 'demo-world' },
  subjects: [{ kind: 'entity', role: 'player' }],
  requires: ['inventory.write'],
  when: [
    { path: 'payload.roomId', equals: 'crypt' },
    { path: 'state.flags.cryptKeyGranted', exists: false }
  ],
  oncePer: (event) => event.subject ?? event.id,
  cooldownMs: 25,
  action: {
    id: 'inventory.add',
    lane: 'gameplay',
    key: (event) => 'inventory:' + event.subject
  },
  input: (event) => ({ itemId: 'crypt-key', sourceEvent: event.id }),
  emits: ['inventory.changed'],
  reads: ['state.flags.cryptKeyGranted'],
  writes: ['state.inventory'],
  feature: 'rooms',
  tags: ['gameplay']
});

runtime.register({
  id: 'room.enter.toast',
  event: 'game.room.enter',
  priority: -1,
  requires: ['ui.toast'],
  actions: [
    { id: 'ui.toast', mode: 'dispatch', input: { text: 'Entered room' } },
    { id: 'sound.play', mode: 'schedule', input: { cue: 'door' }, lane: 'audio' }
  ]
});

const normalized = normalizeTriggerEvent({
  type: 'game.room.enter',
  source: 'inkwell.runtime',
  subject: 'player:local',
  payload: { roomId: 'crypt' }
}, { now: 10, sequence: 1 });
assert.ok(normalized.id.startsWith('evt-1:'));
assert.strictEqual(normalized.source, 'inkwell.runtime');

const accepted = runtime.require({
  id: 'evt-room-1',
  type: 'game.room.enter',
  source: 'inkwell.runtime',
  subject: 'player:local',
  scope: { kind: 'world', id: 'demo-world', tags: ['session'] },
  subjects: [{ kind: 'entity', id: 'player-local', role: 'player', tags: ['local'] }],
  payload: { roomId: 'crypt' },
  metadata: { phase: 'enter' }
});

assert.strictEqual(accepted.accepted, true);
assert.strictEqual(accepted.scheduled.length, 2);
assert.strictEqual(accepted.completed.length, 1);
assert.strictEqual(scheduled[0].id, 'inventory.add');
assert.deepStrictEqual(scheduled[0].input, { itemId: 'crypt-key', sourceEvent: 'evt-room-1' });
assert.strictEqual(scheduled[0].options.key, 'inventory:player:local');
assert.strictEqual(dispatched[0].id, 'ui.toast');
assert.strictEqual(scheduled[1].id, 'sound.play');
assert.strictEqual(eventLogRecords.length, 1);
assert.strictEqual(eventLogRecords[0].key, 'evt-room-1');
assert.strictEqual(eventLogRecords[0].value.type, 'frontier.triggers.emit');

const directRuntime = createTriggerRuntime({ scheduler });
directRuntime.register({
  id: 'direct.scheduler',
  event: 'timer.tick',
  action: { id: 'direct.work', mode: 'schedule', run: () => ({ ok: true }) }
});
directRuntime.emit({ type: 'timer.tick' });
assert.strictEqual(schedulerTasks[0].type, 'frontier.trigger.action');

const onceRejected = runtime.require({
  id: 'evt-room-2',
  type: 'game.room.enter',
  source: 'inkwell.runtime',
  subject: 'player:local',
  scope: { kind: 'world', id: 'demo-world' },
  subjects: [{ kind: 'entity', id: 'player-local', role: 'player' }],
  payload: { roomId: 'crypt' }
});
assert.strictEqual(onceRejected.accepted, true);
assert.strictEqual(onceRejected.rejection, undefined);
assert.ok(onceRejected.outcomes.some((outcome) => outcome.rejection?.code === 'once-per'));

const missingCapabilityRuntime = createTriggerRuntime({ now: () => 2000 });
missingCapabilityRuntime.register({
  id: 'jump-needs-stamina',
  event: 'player.jump',
  requires: ['player.stamina.spend'],
  action: 'sound.play'
});
const rejected = missingCapabilityRuntime.require({
  type: 'player.jump',
  source: 'inkwell.runtime',
  subject: 'player:local'
});
assert.strictEqual(rejected.accepted, false);
assert.strictEqual(rejected.rejection?.code, 'no-matching-trigger');
assert.ok(rejected.outcomes.some((outcome) => outcome.rejection?.code === 'missing-capability'));

const custom = runtime.emit({
  id: 'evt-custom',
  type: 'custom.runtime.event',
  source: 'inkwell.runtime',
  subject: 'player:remote',
  scope: { kind: 'world', id: 'demo-world' },
  subjects: [{ kind: 'entity', id: 'player-remote', role: 'player' }],
  payload: { roomId: 'crypt' }
}, { capabilities: ['inventory.write'] });
assert.strictEqual(custom.accepted, true);

now += 50;
runtime.register({
  id: 'collision-exclusive-high',
  event: 'physics.collision.start',
  priority: 10,
  exclusive: 'collision:player',
  consume: true,
  action: { id: 'sound.play', mode: 'dispatch', input: { cue: 'hit' } }
});
runtime.register({
  id: 'collision-exclusive-low',
  event: 'physics.collision.start',
  exclusive: 'collision:player',
  action: 'ui.toast'
});
const collision = runtime.emit({
  id: 'evt-collision',
  type: 'physics.collision.start',
  subjects: [
    { kind: 'entity', id: 'player-local', role: 'player' },
    { kind: 'entity', id: 'spike-1', role: 'hazard' }
  ],
  payload: { normal: [0, -1] }
});
assert.strictEqual(collision.consumed, true);
assert.ok(collision.outcomes.some((outcome) => outcome.triggerId === 'collision-exclusive-high' && outcome.status === 'completed'));
assert.ok(!collision.outcomes.some((outcome) => outcome.triggerId === 'collision-exclusive-low'));

const snapshot = runtime.snapshot({ includeHistory: true });
assert.strictEqual(snapshot.kind, 'frontier.triggers.snapshot');
assert.ok(snapshot.onceKeys.length >= 2);
const restored = createTriggerRuntime({ actions, scheduler, capabilities: ['inventory.write', 'ui.toast'] });
restored.restore(snapshot);
assert.ok(restored.has('room.enter.grant-key'));
assert.ok(restored.history().length >= 1);

const graph = runtime.inspect();
assert.ok(graph.nodes.some((node) => node.id === 'trigger:room.enter.grant-key'));
assert.ok(graph.edges.some((edge) => edge.kind === 'requires' && edge.to === 'capability:inventory.write'));

const registry = createTriggerRegistryGraph(runtime);
assert.ok(registry.entries.some((entry) => entry.id === 'trigger:room.enter.grant-key'));
assert.ok(registry.edges.some((edge) => edge.kind === 'handles' && edge.to === 'event:game.room.enter'));
const impact = traceTriggerImpact(runtime, { tags: ['gameplay'] });
assert.ok(impact.entries.some((entry) => entry.id === 'trigger:room.enter.grant-key'));

const replayRuntime = createTriggerRuntime({ actions, capabilities: ['inventory.write'], now: () => 3000 });
replayRuntime.register({
  id: 'jump',
  event: 'player.jump',
  when: [{ path: 'payload.grounded', equals: true }],
  action: { id: 'sound.play', mode: 'dispatch', input: { cue: 'jump' } }
});
const replayed = replayRuntime.replay([
  { type: 'player.jump', payload: { grounded: true } },
  { type: 'player.jump', payload: { grounded: false } }
], { require: true });
assert.strictEqual(replayed.accepted, 1);
assert.strictEqual(replayed.rejected, 1);

console.log('frontier triggers smoke passed');
