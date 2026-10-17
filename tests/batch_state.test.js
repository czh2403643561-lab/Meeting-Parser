const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { webcrypto } = require('node:crypto');

const backgroundSource = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
const titleSource = fs.readFileSync(path.join(__dirname, '..', 'extension', 'title_utils.js'), 'utf8');
const panelSource = fs.readFileSync(path.join(__dirname, '..', 'extension', 'sidepanel.js'), 'utf8');
const panelCss = fs.readFileSync(path.join(__dirname, '..', 'extension', 'sidepanel.css'), 'utf8');

function createStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (typeof keys === 'string') return { [keys]: data[keys] };
      return Object.fromEntries(keys.map((key) => [key, data[key]]));
    },
    async set(values) { Object.assign(data, values); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
  };
}

function setupBackground(localInitial = {}, sessionInitial = {}) {
  const local = createStore(localInitial);
  const session = createStore(sessionInitial);
  const listeners = {};
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const tabs = new Map();
  let nextTabId = 100;
  const alarms = new Set();
  const chrome = {
    storage: { local, session },
    runtime: {
      onMessage: event('message'), onStartup: event('startup'), onInstalled: event('installed'),
      sendMessage: async () => undefined
    },
    tabs: {
      onUpdated: event('updated'), onRemoved: event('removed'),
      create: async ({ url }) => { const tab = { id: nextTabId++, url }; tabs.set(tab.id, tab); return tab; },
      get: async (id) => { if (!tabs.has(id)) throw new Error('missing tab'); return tabs.get(id); },
      update: async (id, changes) => { const tab = { ...tabs.get(id), ...changes }; tabs.set(id, tab); return tab; },
      remove: async (id) => { tabs.delete(id); },
      sendMessage: async () => ({})
    },
    alarms: {
      onAlarm: event('alarm'),
      create: async (name) => { alarms.add(name); },
      clear: async (name) => { alarms.delete(name); }
    },
    power: { requestKeepAwake() {}, releaseKeepAwake() {} },
    webRequest: {
      onBeforeRequest: event('beforeRequest'), onHeadersReceived: event('headersReceived'),
      onBeforeSendHeaders: event('beforeSendHeaders'), onSendHeaders: event('sendHeaders')
    }
  };
  let context;
  context = vm.createContext({
    chrome, crypto: webcrypto, importScripts() { vm.runInContext(titleSource, context); }, setTimeout, clearTimeout,
    URL, Blob, console, TextEncoder, TextDecoder
  });
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });
  vm.runInContext('checkLocalDownloader = async () => ({ok: true}); advanceBatchQueue = async () => {};', context);
  return { context, local, session, tabs, alarms, listeners };
}

const meeting = (n) => `https://meeting.tencent.com/crm/${n}`;

test('new video queue replaces paused transcript queue only after explicit confirmation', async () => {
  const previous = {
    runId: 'old-run', status: 'paused', taskType: 'transcript', startedAt: '2026-01-01T00:00:00.000Z',
    currentIndex: 0, workerTabId: null, tasks: [{ pageUrl: meeting('old'), status: 'pending' }]
  };
  const { context, local } = setupBackground({ batchState: previous });
  await new Promise((resolve) => setImmediate(resolve));
  const items = Array.from({ length: 31 }, (_, index) => ({ url: meeting(index + 1) }));
  await context.saveBatchDraft({ items });
  await assert.rejects(context.startBatch({ items, taskType: 'video' }), /确认/);
  const state = await context.startBatch({ items, taskType: 'video', replacePaused: true });
  assert.equal(state.taskType, 'video');
  assert.equal(state.tasks.length, 31);
  assert.equal(state.tasks[0].pageUrl, items[0].url);
  assert.equal(local.data.batchDraft.items.length, 31);
  assert.notEqual(state.runId, 'old-run');
});

test('clear removes batch storage and stale state cannot return', async () => {
  const previous = {
    runId: 'old-run', status: 'paused', taskType: 'video', currentIndex: 0,
    workerTabId: 45, tasks: [{ pageUrl: meeting('old'), status: 'pending' }]
  };
  const { context, local, session, alarms, tabs } = setupBackground(
    { batchState: previous, batchDraft: { items: [{ url: meeting('old') }] } },
    { batchState: previous, batchDraft: { items: [{ url: meeting('old') }] }, batchEventLog: [{ event: 'old' }], batchBrowserSessionActive: true }
  );
  tabs.set(45, { id: 45 });
  await new Promise((resolve) => setImmediate(resolve));
  const stale = await context.getBatchState();
  await context.clearBatchHistory();
  await context.saveBatchState(stale);
  assert.equal((await context.getBatchState()).tasks.length, 0);
  assert.equal((await context.getBatchDraft()).items.length, 0);
  for (const key of ['batchState', 'batchDraft']) assert.equal(local.data[key], undefined);
  for (const key of ['batchState', 'batchDraft', 'batchEventLog', 'batchBrowserSessionActive']) {
    assert.equal(session.data[key], undefined);
  }
  assert.equal(tabs.has(45), false);
  assert.equal(alarms.size, 0);
  const reopened = setupBackground(local.data, session.data);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await reopened.context.getBatchState()).tasks.length, 0);
  assert.equal((await reopened.context.getBatchDraft()).items.length, 0);
});

test('clear waits for current native download before removing history', async () => {
  const previous = {
    runId: 'old-run', status: 'running', taskType: 'video', currentIndex: 0,
    workerTabId: null, tasks: [{ pageUrl: meeting('one'), status: 'downloading', taskId: 'native-1' }]
  };
  const { context, local } = setupBackground({ batchState: previous }, { batchBrowserSessionActive: true });
  await new Promise((resolve) => setImmediate(resolve));
  let finish;
  const status = new Promise((resolve) => { finish = resolve; });
  context.getLocalDownloadStatus = async () => status;
  const clearing = context.clearBatchHistory();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(local.data.batchState.status, 'clearing');
  await assert.rejects(context.startBatch({ items: [{ url: meeting('two') }], taskType: 'video' }), /切换/);
  finish({ status: 'complete' });
  await clearing;
  assert.equal((await context.getBatchState()).tasks.length, 0);
});

test('clear records an in-flight native submission before waiting', async () => {
  const { context, local } = setupBackground({
    batchState: { runId: 'old-run', status: 'running', taskType: 'video', currentIndex: 0,
      workerTabId: null, tasks: [{ pageUrl: meeting('one'), status: 'preparing' }] }
  }, { batchBrowserSessionActive: true });
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("batchClearingTaskId = 'native-2'", context);
  let finish;
  context.getLocalDownloadStatus = async () => new Promise((resolve) => { finish = resolve; });
  const clearing = context.clearBatchHistory();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(local.data.batchState.status, 'clearing');
  assert.equal(local.data.batchState.tasks[0].taskId, 'native-2');
  finish({ status: 'complete' });
  await clearing;
});

test('after clearing, a fresh three-link video queue starts at its first link', async () => {
  const { context, local } = setupBackground({
    batchState: { runId: 'old-run', status: 'paused', taskType: 'transcript', currentIndex: 0,
      tasks: [{ pageUrl: meeting('old'), status: 'pending' }] }
  });
  await new Promise((resolve) => setImmediate(resolve));
  await context.clearBatchHistory();
  const items = [1, 2, 3].map((n) => ({ url: meeting(`fresh-${n}`) }));
  await context.saveBatchDraft({ items });
  const state = await context.startBatch({ items, taskType: 'video' });
  assert.equal(state.tasks.length, 3);
  assert.equal(state.tasks[0].pageUrl, meeting('fresh-1'));
  assert.equal(local.data.batchState.currentIndex, 0);
});

test('a delayed transcript callback cannot restore a cleared queue', async () => {
  const { context, local, tabs } = setupBackground({
    batchState: { runId: 'old-run', status: 'running', taskType: 'transcript', currentIndex: 0,
      workerTabId: 45, tasks: [{ pageUrl: meeting('old'), status: 'extracting' }] }
  }, { batchBrowserSessionActive: true });
  tabs.set(45, { id: 45 });
  await new Promise((resolve) => setImmediate(resolve));
  let finish;
  const extraction = new Promise((resolve) => { finish = resolve; });
  context.chrome.tabs.sendMessage = async () => extraction;
  const state = await context.getBatchState();
  const pending = context.extractBatchTranscript(state, state.tasks[0], 45);
  await new Promise((resolve) => setImmediate(resolve));
  await context.clearBatchHistory();
  finish({ transcriptFound: true, fullText: 'old transcript' });
  await pending;
  assert.equal(local.data.batchState, undefined);
  assert.equal((await context.getBatchState()).tasks.length, 0);
});

function setupPanel() {
  const ids = [
    'batchTaskType', 'batchLinks', 'batchFile', 'parseBatchButton', 'mediaPreference',
    'transcriptExportMode', 'mediaPreferenceControl', 'transcriptExportControl', 'startBatchButton',
    'pauseBatchButton', 'resumeBatchButton', 'clearBatchHistoryButton', 'copyInvalidBatchLinksButton',
    'copyFailedBatchLinksButton', 'batchOutputPath', 'batchTotalCount', 'batchCompleteCount',
    'batchFailedCount', 'batchPendingCount', 'batchListCount', 'batchSummary', 'batchList',
    'batchTotalProgress', 'batchProgress', 'batchTotalBar', 'batchTotalLabel', 'batchCurrent',
    'batchStatus', 'batchFileProgress', 'batchSize', 'batchFeedback'
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, {
    hidden: false, disabled: false, textContent: '', value: '', dataset: {},
    children: [], replaceChildren() { this.children = []; }, append(child) { this.children.push(child); }
  }]));
  elements.batchTaskType.value = 'video';
  const copied = [];
  const document = { createElement: () => ({ append() {}, addEventListener() {}, className: '', textContent: '' }) };
  const context = vm.createContext({
    document, URL, navigator: { clipboard: { async writeText(value) { copied.push(value); } } },
    chrome: { runtime: { sendMessage: async () => ({}) } },
    ...elements
  });
  const start = panelSource.indexOf('function truncateUrl(');
  const end = panelSource.indexOf('function formatBytes(', start);
  const copyStart = panelSource.indexOf('async function copyBatchUrls(');
  const copyEnd = panelSource.indexOf('copyInvalidBatchLinksButton.addEventListener(', copyStart);
  vm.runInContext(`let batchState = null; let batchDraft = {items: [], invalidLinks: []}; let batchClearInProgress = false;
    let localComponentState = 'ready';
    function showBatchFeedback(message) { batchFeedback.textContent = message; }
    ${panelSource.slice(start, end)}
    ${panelSource.slice(copyStart, copyEnd)}`, context);
  return { context, elements, copied };
}

test('video and transcript controls stay exclusive and draft choice survives history render', () => {
  const { context, elements } = setupPanel();
  const old = {
    status: 'paused', taskType: 'transcript', startedAt: '2026-01-01T00:00:00.000Z',
    currentIndex: 0, tasks: [{ index: 0, pageUrl: meeting('old'), status: 'pending' }]
  };
  context.renderBatchState(old);
  assert.equal(elements.startBatchButton.hidden, true);
  assert.equal(elements.resumeBatchButton.hidden, false);
  assert.equal(elements.mediaPreferenceControl.hidden, true);
  assert.equal(elements.batchTaskType.disabled, true);
  context.newDraft = { items: [{ url: meeting('new') }], invalidLinks: [], updatedAt: '2026-01-02T00:00:00.000Z' };
  vm.runInContext('batchDraft = newDraft', context);
  elements.batchTaskType.value = 'video';
  context.renderBatchState(old);
  assert.equal(elements.batchTaskType.value, 'video');
  assert.equal(elements.startBatchButton.hidden, false);
  assert.equal(elements.resumeBatchButton.hidden, true);
  assert.equal(elements.batchTaskType.disabled, false);
  assert.equal(elements.transcriptExportControl.hidden, true);
  assert.equal(elements.mediaPreferenceControl.hidden, false);
  elements.batchTaskType.value = 'transcript';
  context.updateBatchModeControls();
  assert.equal(elements.mediaPreferenceControl.hidden, true);
  assert.equal(elements.transcriptExportControl.hidden, false);
  assert.match(panelCss, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('empty state resets counters and invalid/failed copies contain only requested links', async () => {
  const { context, elements, copied } = setupPanel();
  context.renderBatchState({ status: 'idle', tasks: [], currentIndex: 0 });
  assert.equal(elements.batchTotalCount.textContent, 0);
  assert.equal(elements.batchPendingCount.textContent, 0);
  assert.equal(elements.batchTotalBar.value, 0);
  assert.equal(elements.batchSummary.textContent, '尚未解析链接');
  assert.equal(elements.startBatchButton.disabled, true);
  const parsed = context.parseBatchLinks(`${meeting('good')}\nhttps://meeting.tencent.com/invalid/one\nhttps://cdn.example/x.mp4?token=secret`);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.invalidCount, 2);
  assert.deepEqual(Array.from(parsed.invalidLinks), ['https://meeting.tencent.com/invalid/one']);
  await context.copyBatchUrls(parsed.invalidLinks, 'none');
  assert.equal(copied[0], 'https://meeting.tencent.com/invalid/one');
  const tasks = [
    { pageUrl: meeting('fail-1'), status: 'failed' },
    { pageUrl: meeting('ok'), status: 'complete' },
    { pageUrl: meeting('fail-2'), status: 'failed' }
  ];
  await context.copyBatchUrls(tasks.filter((task) => task.status === 'failed').map((task) => task.pageUrl), 'none');
  assert.equal(copied[1], `${meeting('fail-1')}\n${meeting('fail-2')}`);
});
