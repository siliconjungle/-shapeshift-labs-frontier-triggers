import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createTriggerRuntime } from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const repoRoot = path.basename(path.dirname(packageDir)) === 'packages'
  ? path.resolve(packageDir, '..', '..')
  : packageDir;
const args = parseArgs(process.argv.slice(2));
const triggerCount = readPositiveInt(args.triggers, 512);
const eventCount = readPositiveInt(args.events, 512);
const rounds = readPositiveInt(args.rounds, 15);
const outPath = args.out ? path.resolve(repoRoot, args.out) : null;

const actions = {
  has(id) {
    return id.startsWith('action.');
  },
  schedule(id, input, options) {
    return { id: options.taskId ?? 'scheduled:' + id, input, key: options.key };
  },
  dispatch(id, input) {
    return { id, input };
  }
};

const input = makeDefinitions(triggerCount);
const events = makeEvents(eventCount);
let runtime = createRuntime(input);
let cascadeRuntime = createCascadeRuntime();
let cursor = 0;

const rows = [
  measure('register-' + triggerCount, 1, () => {
    runtime = createRuntime(input);
    return runtime.list().length;
  }),
  measure('emit-scoped-match-' + triggerCount, 64, () => {
    const event = events[cursor++ % events.length];
    return runtime.emit(event).matched.length;
  }),
  measure('require-capability-reject-' + triggerCount, 64, () => {
    const event = { ...events[cursor++ % events.length], type: 'admin.secret' };
    return runtime.require(event, { capabilities: [] }).rejected.length;
  }),
  measure('emit-dispatch-' + triggerCount, 64, () => {
    const event = { ...events[cursor++ % events.length], type: 'player.jump', payload: { enabled: true, value: 99 } };
    return runtime.emit(event, { mode: 'dispatch' }).completed.length;
  }),
  measure('cascade-chain-8', 64, () => {
    const result = cascadeRuntime.emit({ type: 'cascade.0', payload: { enabled: true } });
    if (cascadeRuntime.history().length > 128) cascadeRuntime = createCascadeRuntime();
    return result.records.length;
  }),
  measure('snapshot-' + triggerCount, 8, () => {
    return runtime.snapshot({ includeHistory: true }).definitions.length;
  }),
  measure('replay-' + eventCount, 8, () => {
    const replayRuntime = createRuntime(input);
    return replayRuntime.replay(events.slice(0, 64)).accepted;
  }, 64),
  measure('registry-graph-' + triggerCount, 1, () => {
    const graph = runtime.registryGraph();
    return graph.entries.length + graph.records.length + graph.edges.length;
  })
];

const report = {
  package: '@shapeshift-labs/frontier-triggers',
  version: readPackageVersion(),
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform + ' ' + process.arch,
  triggerCount,
  eventCount,
  rounds,
  rows
};

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
}

console.log(report.package + ' package benchmark');
console.log('Node ' + report.node + ' on ' + report.platform + ', triggers=' + triggerCount + ', events=' + eventCount + ', rounds=' + rounds);
console.log('These are Frontier-only package measurements, not competitor comparisons.');
console.log('');
console.log(padRight('Fixture', 34) + padLeft('Median', 12) + padLeft('p95', 12));
for (const row of rows) {
  console.log(padRight(row.fixture, 34) + padLeft(formatUs(row.medianUs), 12) + padLeft(formatUs(row.p95Us), 12));
}
if (outPath) console.log('\nwrote ' + path.relative(repoRoot, outPath));

function createRuntime(definitions) {
  const next = createTriggerRuntime({
    actions,
    capabilities: ['cap.inventory', 'cap.physics', 'cap.dom', 'cap.jump'],
    now: () => 42
  });
  for (const definition of definitions) next.register(definition);
  return next;
}

function createCascadeRuntime() {
  const next = createTriggerRuntime({
    actions,
    capabilities: ['cap.inventory'],
    maxCascadeDepth: 16,
    now: () => 43
  });
  for (let i = 0; i < 8; i++) {
    next.register({
      id: 'cascade.' + i,
      event: 'cascade.' + i,
      action: {
        id: 'action.' + i,
        mode: 'dispatch',
        emit: i === 7 ? undefined : { type: 'cascade.' + (i + 1), payload: { depth: i + 1 } }
      }
    });
  }
  return next;
}

function makeDefinitions(count) {
  const definitions = [];
  const types = ['game.room.enter', 'game.room.exit', 'physics.collision.start', 'physics.collision.end', 'player.jump', 'dom.click'];
  for (let i = 0; i < count; i++) {
    const type = types[i % types.length];
    definitions[definitions.length] = {
      id: 'trigger.' + i,
      event: i % 17 === 0 ? [type, 'custom.' + (i % 9)] : type,
      scope: i % 3 === 0 ? { kind: 'world', id: 'world.' + (i % 11) } : undefined,
      subjects: i % 4 === 0 ? [{ kind: 'entity', role: i % 8 === 0 ? 'player' : 'npc' }] : undefined,
      requires: i % 5 === 0 ? ['cap.inventory'] : i % 7 === 0 ? ['cap.physics'] : [],
      when: i % 6 === 0 ? [{ path: 'payload.enabled', equals: true }] : [],
      cooldownMs: i % 31 === 0 ? 5 : undefined,
      oncePer: i % 43 === 0 ? 'world' : undefined,
      action: {
        id: 'action.' + (i % 32),
        mode: i % 2 === 0 ? 'schedule' : 'dispatch',
        lane: i % 2 === 0 ? 'gameplay' : 'dom',
        key: 'trigger.' + i
      },
      input: { trigger: i },
      reads: ['state.' + (i % 19)],
      writes: ['effects.' + (i % 13)],
      tags: ['bench']
    };
  }
  return definitions;
}

function makeEvents(count) {
  const events = [];
  const types = ['game.room.enter', 'game.room.exit', 'physics.collision.start', 'physics.collision.end', 'player.jump', 'dom.click', 'custom.1'];
  for (let i = 0; i < count; i++) {
    events[events.length] = {
      id: 'event.' + i,
      type: types[i % types.length],
      source: 'bench',
      subject: 'entity:' + (i % 128),
      scope: { kind: 'world', id: 'world.' + (i % 11) },
      subjects: [{ kind: 'entity', id: 'entity.' + (i % 128), role: i % 2 === 0 ? 'player' : 'npc' }],
      payload: { enabled: i % 3 !== 0, value: i }
    };
  }
  return events;
}

function measure(fixture, batchSize, fn, innerOps = 1) {
  const values = [];
  let sink = 0;
  for (let round = 0; round < rounds; round++) {
    const started = performance.now();
    for (let i = 0; i < batchSize; i++) sink += fn();
    values[values.length] = ((performance.now() - started) * 1000) / (batchSize * innerOps);
  }
  if (sink === -1) console.log('sink=' + sink);
  values.sort((left, right) => left - right);
  return {
    fixture,
    medianUs: percentile(values, 0.5),
    p95Us: percentile(values, 0.95)
  };
}

function percentile(values, p) {
  return values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))] ?? 0;
}

function formatUs(value) {
  if (value >= 1000) return (value / 1000).toFixed(2) + ' ms';
  return value.toFixed(2) + ' us';
}

function padRight(value, width) {
  return String(value).padEnd(width, ' ');
}

function padLeft(value, width) {
  return String(value).padStart(width, ' ');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--triggers') out.triggers = argv[++i];
    else if (arg === '--events') out.events = argv[++i];
    else if (arg === '--rounds') out.rounds = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
  }
  return out;
}

function readPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  return packageJson.version;
}
