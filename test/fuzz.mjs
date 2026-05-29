import assert from 'node:assert';
import { createTriggerRuntime } from '../dist/index.js';

const args = parseArgs(process.argv.slice(2));
const cases = readPositiveInt(args.cases, 300);
let seed = readPositiveInt(args.seed, 0x7a199);

for (let i = 0; i < cases; i++) {
  const scheduled = [];
  const dispatched = [];
  const capabilities = makeCapabilities();
  const runtime = createTriggerRuntime({
    capabilities,
    now: () => 100000 + i,
    actions: {
      has(id) {
        return id.startsWith('action.');
      },
      schedule(id, input, options) {
        scheduled.push({ id, input, options });
        return { id: options.taskId ?? id + ':' + scheduled.length };
      },
      dispatch(id, input, options) {
        dispatched.push({ id, input, options });
        return { id, ok: true };
      }
    }
  });

  const triggerCount = randInt(1, 48);
  const definitions = [];
  for (let t = 0; t < triggerCount; t++) {
    const definition = makeTrigger(t);
    definitions.push(definition);
    runtime.register(definition);
  }

  const eventCount = randInt(1, 32);
  for (let e = 0; e < eventCount; e++) {
    const event = makeEvent(e);
    const result = chance(0.4) ? runtime.require(event) : runtime.emit(event);
    assert.strictEqual(result.event.type, event.type);
    assert.strictEqual(result.record.event.id, result.event.id);
    assert.strictEqual(result.outcomes.length, result.record.outcomes.length);
    for (const outcome of result.outcomes) {
      assert.ok(definitions.some((definition) => definition.id === outcome.triggerId));
      if (outcome.rejection?.code === 'missing-capability') {
        assert.ok(!capabilities.includes(outcome.rejection.capability));
      }
      if (outcome.status === 'scheduled') {
        assert.ok(outcome.scheduled);
        assert.strictEqual(outcome.scheduled.actionId, outcome.actionId);
      }
    }
    if (!result.accepted) {
      assert.ok(result.rejection || result.failed.length > 0 || result.rejected.length > 0);
    }
  }

  const snapshot = runtime.snapshot({ includeHistory: true });
  const restored = createTriggerRuntime();
  restored.restore(snapshot);
  assert.deepStrictEqual(restored.list().map((trigger) => trigger.id).sort(), runtime.list().map((trigger) => trigger.id).sort());
  assert.strictEqual(restored.history().length, runtime.history().length);
  assert.ok(runtime.inspect().nodes.length >= runtime.list().length);
  assert.ok(runtime.registryGraph().entries.length >= runtime.list().length);
}

console.log(`frontier triggers fuzz passed: cases=${cases}`);

function makeTrigger(index) {
  const event = pick(['game.room.enter', 'game.room.exit', 'physics.collision.start', 'physics.collision.end', 'player.jump', 'dom.click', 'custom.' + randInt(0, 5)]);
  const requires = [];
  if (chance(0.5)) requires.push(pick(['cap.jump', 'cap.inventory', 'cap.physics', 'cap.dom']));
  const action = {
    id: 'action.' + randInt(0, 12),
    mode: pick(['schedule', 'dispatch']),
    lane: pick(['gameplay', 'render', 'audio', 'dom']),
    input: { index, value: randInt(0, 1000) }
  };
  const when = [];
  if (chance(0.5)) when.push({ path: 'payload.enabled', equals: true });
  if (chance(0.25)) when.push({ path: 'payload.value', gte: 10 });
  return {
    id: 'trigger.' + index,
    event: chance(0.2) ? [event, 'custom.' + randInt(0, 5)] : event,
    scope: chance(0.5) ? { kind: pick(['world', 'dom', 'room']), id: 'scope.' + randInt(0, 4) } : undefined,
    subjects: chance(0.5) ? [{ kind: 'entity', role: pick(['player', 'hazard', 'npc']) }] : undefined,
    requires,
    when,
    oncePer: chance(0.1) ? 'fixed' : undefined,
    cooldownMs: chance(0.1) ? randInt(1, 20) : undefined,
    exclusive: chance(0.1) ? 'group.' + randInt(0, 3) : undefined,
    consume: chance(0.05),
    action,
    priority: randInt(-5, 5),
    tags: ['fuzz']
  };
}

function makeEvent(index) {
  const type = pick(['game.room.enter', 'game.room.exit', 'physics.collision.start', 'physics.collision.end', 'player.jump', 'dom.click', 'custom.' + randInt(0, 5)]);
  const role = pick(['player', 'hazard', 'npc']);
  return {
    id: 'event.' + index + '.' + randInt(0, 100000),
    type,
    source: pick(['inkwell.runtime', 'frontier.dom', 'test']),
    subject: 'entity:' + randInt(0, 8),
    scope: { kind: pick(['world', 'dom', 'room']), id: 'scope.' + randInt(0, 4) },
    subjects: [{ kind: 'entity', id: 'entity.' + randInt(0, 8), role }],
    payload: {
      enabled: chance(0.7),
      value: randInt(0, 20),
      roomId: pick(['crypt', 'hall', 'menu'])
    }
  };
}

function makeCapabilities() {
  const out = [];
  for (const capability of ['cap.jump', 'cap.inventory', 'cap.physics', 'cap.dom']) {
    if (chance(0.5)) out.push(capability);
  }
  return out;
}

function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}

function randInt(min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}

function chance(probability) {
  return rand() < probability;
}

function pick(values) {
  return values[randInt(0, values.length - 1)];
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cases') out.cases = argv[++i];
    else if (arg === '--seed') out.seed = argv[++i];
  }
  return out;
}

function readPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
