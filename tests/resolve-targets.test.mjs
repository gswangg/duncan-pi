/**
 * Test: target resolution and pagination.
 *
 * Tests resolveTargets() — the pure function that maps
 * (mode, limit, offset, sessionFile) → paginated DuncanTargets.
 *
 * Run: tsx tests/resolve-targets.test.mjs
 */

import { resolveTargets } from "../extensions/duncan.ts";

const { SessionManager } = await import("@mariozechner/pi-coding-agent");

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

// ============================================================================
// Helpers
// ============================================================================

const TEST_ROOT = join("/tmp", "duncan-resolve-test");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) { console.error(`  ✗ ${msg}`); failed++; }
  else { console.log(`  ✓ ${msg}`); passed++; }
}

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(TEST_ROOT, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

function makeUser(t) {
  return { role: "user", content: [{ type: "text", text: t }], timestamp: Date.now() };
}

function makeAssistant(t) {
  return {
    role: "assistant", content: [{ type: "text", text: t }],
    provider: "test", model: "test-model", stopReason: "endTurn",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
    timestamp: Date.now(),
  };
}

function createSession(sessionDir, messages, parentSessionFile) {
  mkdirSync(sessionDir, { recursive: true });
  const sm = new SessionManager("/workspace", sessionDir, undefined, true);
  if (parentSessionFile) {
    for (const msg of messages) sm.appendMessage(msg);
    const file = sm.getSessionFile();
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    const header = JSON.parse(lines[0]);
    header.parentSession = parentSessionFile;
    lines[0] = JSON.stringify(header);
    writeFileSync(file, lines.join("\n"));
    return file;
  }
  for (const msg of messages) sm.appendMessage(msg);
  return sm.getSessionFile();
}

function findEntryByText(sm, targetText) {
  return sm.getEntries().find(e =>
    e.type === "message" && e.message?.content?.[0]?.text === targetText
  );
}

function createCompactedSession(sessionDir) {
  mkdirSync(sessionDir, { recursive: true });
  const sm = new SessionManager("/workspace", sessionDir, undefined, true);
  sm.appendMessage(makeUser("w0-a"));
  sm.appendMessage(makeAssistant("w0-a-r"));
  sm.appendMessage(makeUser("w0-b"));
  sm.appendMessage(makeAssistant("w0-b-r"));
  const kept = findEntryByText(sm, "w0-b");
  sm.appendCompaction("summary of w0", kept.id, 30000);
  sm.appendMessage(makeUser("w1-a"));
  sm.appendMessage(makeAssistant("w1-a-r"));
  return sm.getSessionFile(); // 2 windows
}

// ============================================================================
// Tests
// ============================================================================

function testDefaultLimits() {
  console.log("\n--- Default limits per mode ---");
  const dir = join(TEST_ROOT, "limits");

  // Create enough sessions for limits to matter
  const sessions = [];
  for (let i = 0; i < 5; i++) {
    sessions.push(createSession(dir, [makeUser(`msg-${i}`), makeAssistant(`resp-${i}`)]));
  }

  const sessionFile = sessions[sessions.length - 1];

  // ancestors — limited mode, default 50
  const r1 = resolveTargets({ sessions: "project" }, sessionFile, dir);
  assert(r1.limit === 50, `project default limit is 50 (got ${r1.limit})`);

  // parent — unlimited
  // Need a parent for this
  const parent = createSession(dir, [makeUser("parent"), makeAssistant("parent-r")]);
  const child = createSession(dir, [makeUser("child"), makeAssistant("child-r")], parent);
  const r2 = resolveTargets({ sessions: "parent" }, child, dir);
  assert(r2.limit === Infinity, `parent default limit is Infinity`);

  // explicit filename — unlimited
  const r3 = resolveTargets({ sessions: basename(parent) }, child, dir);
  assert(r3.limit === Infinity, `explicit filename default limit is Infinity`);

  // ancestors — limited
  const r4 = resolveTargets({ sessions: "ancestors" }, child, dir);
  assert(r4.limit === 50, `ancestors default limit is 50 (got ${r4.limit})`);

  // descendants — limited
  const r5 = resolveTargets({ sessions: "descendants" }, parent, dir);
  assert(r5.limit === 50, `descendants default limit is 50 (got ${r5.limit})`);

  // user override
  const r6 = resolveTargets({ sessions: "project", limit: 3 }, sessionFile, dir);
  assert(r6.limit === 3, `user override limit is 3 (got ${r6.limit})`);
}

function testPaginationBasic() {
  console.log("\n--- Pagination: basic offset/limit ---");
  const dir = join(TEST_ROOT, "pagination");

  // Create 5 sessions = 5 windows
  for (let i = 0; i < 5; i++) {
    createSession(dir, [makeUser(`s${i}`), makeAssistant(`r${i}`)]);
  }
  const sessionFile = createSession(dir, [makeUser("current"), makeAssistant("current-r")]);

  // Get all (should be 6 sessions, but current's window gets dropped = 5 windows from others + 0 from self)
  const all = resolveTargets({ sessions: "project", limit: 100 }, sessionFile, dir);
  const total = all.totalWindows;
  assert(total === 5, `total windows is 5 (got ${total})`);

  // First page of 2
  const p1 = resolveTargets({ sessions: "project", limit: 2, offset: 0 }, sessionFile, dir);
  assert(p1.targets.length === 2, `page 1: 2 targets (got ${p1.targets.length})`);
  assert(p1.hasMore === true, `page 1: hasMore`);
  assert(p1.totalWindows === total, `page 1: totalWindows matches`);

  // Second page
  const p2 = resolveTargets({ sessions: "project", limit: 2, offset: 2 }, sessionFile, dir);
  assert(p2.targets.length === 2, `page 2: 2 targets (got ${p2.targets.length})`);
  assert(p2.hasMore === true, `page 2: hasMore`);

  // Third page (last)
  const p3 = resolveTargets({ sessions: "project", limit: 2, offset: 4 }, sessionFile, dir);
  assert(p3.targets.length === 1, `page 3: 1 target (got ${p3.targets.length})`);
  assert(p3.hasMore === false, `page 3: no more`);

  // All pages cover all windows, no overlap
  const allIds = [...p1.targets, ...p2.targets, ...p3.targets].map(t => `${basename(t.sessionFile)}:${t.windowIndex}`);
  const unique = new Set(allIds);
  assert(unique.size === total, `pages cover all ${total} windows with no overlap`);
}

function testPaginationWithCompaction() {
  console.log("\n--- Pagination: compacted sessions expand to multiple windows ---");
  const dir = join(TEST_ROOT, "pagination-compact");

  // 1 compacted session (2 windows) + 2 normal sessions (1 window each) = 4 windows
  createCompactedSession(dir);
  createSession(dir, [makeUser("normal1"), makeAssistant("normal1-r")]);
  const sessionFile = createSession(dir, [makeUser("current"), makeAssistant("current-r")]);

  const all = resolveTargets({ sessions: "project", limit: 100 }, sessionFile, dir);
  assert(all.totalWindows === 3, `3 windows total (2 from compacted + 1 from normal, current dropped) (got ${all.totalWindows})`);

  // Page size 2: should split across compaction windows
  const p1 = resolveTargets({ sessions: "project", limit: 2, offset: 0 }, sessionFile, dir);
  assert(p1.targets.length === 2, `page 1: 2 targets`);
  assert(p1.hasMore === true, `page 1: hasMore`);

  const p2 = resolveTargets({ sessions: "project", limit: 2, offset: 2 }, sessionFile, dir);
  assert(p2.targets.length === 1, `page 2: 1 target`);
  assert(p2.hasMore === false, `page 2: no more`);
}

function testOffsetBeyondRange() {
  console.log("\n--- Pagination: offset beyond range ---");
  const dir = join(TEST_ROOT, "offset-beyond");

  createSession(dir, [makeUser("only"), makeAssistant("one")]);
  const sessionFile = createSession(dir, [makeUser("current"), makeAssistant("current-r")]);

  const r = resolveTargets({ sessions: "project", limit: 10, offset: 100 }, sessionFile, dir);
  assert(r.error !== undefined, `error when offset beyond range`);
  assert(r.targets.length === 0, `no targets`);
  assert(r.error.includes("No windows in range"), `error message mentions range: "${r.error}"`);
}

function testGlobalMode() {
  console.log("\n--- Global mode ---");
  const sessionsRoot = join(TEST_ROOT, "sessions");
  const projA = join(sessionsRoot, "--project-a--");
  const projB = join(sessionsRoot, "--project-b--");

  createSession(projA, [makeUser("a1"), makeAssistant("a1-r")]);
  createSession(projA, [makeUser("a2"), makeAssistant("a2-r")]);
  createSession(projB, [makeUser("b1"), makeAssistant("b1-r")]);
  const sessionFile = createSession(projA, [makeUser("current"), makeAssistant("current-r")]);

  const r = resolveTargets({ sessions: "global" }, sessionFile, projA);
  assert(!r.error, `no error`);
  // 4 sessions total, current's window dropped = 3 windows
  assert(r.totalWindows === 3, `3 windows (got ${r.totalWindows})`);
  assert(r.limit === 50, `global default limit is 50`);

  // Sessions from both projects present
  const files = new Set(r.targets.map(t => t.sessionFile));
  const dirs = new Set([...files].map(f => basename(join(f, ".."))));
  assert(dirs.size === 2, `targets from 2 project dirs (got ${dirs.size})`);
}

function testSelfFiltering() {
  console.log("\n--- Self-filtering: current session's last window dropped ---");
  const dir = join(TEST_ROOT, "self-filter");

  // Compacted current session: 2 windows, but last (active) should be dropped
  const sessionFile = createCompactedSession(dir);

  // ancestors includes self
  const r = resolveTargets({ sessions: "ancestors" }, sessionFile, dir);
  assert(!r.error, `no error`);
  // 2 windows in session, last dropped = 1 queryable window
  assert(r.totalWindows === 1, `1 queryable window from self (got ${r.totalWindows})`);
  assert(r.targets[0].windowIndex === 0, `window 0 (pre-compaction) kept`);
}

function testErrorCases() {
  console.log("\n--- Error cases ---");
  const dir = join(TEST_ROOT, "errors");
  mkdirSync(dir, { recursive: true });

  const sessionFile = createSession(dir, [makeUser("solo"), makeAssistant("solo-r")]);

  // No parent
  const r1 = resolveTargets({ sessions: "parent" }, sessionFile, dir);
  assert(r1.error === "No parent session found.", `parent error: "${r1.error}"`);

  // No descendants
  const r2 = resolveTargets({ sessions: "descendants" }, sessionFile, dir);
  assert(r2.error === "No descendant sessions found.", `descendants error: "${r2.error}"`);

  // Missing file
  const r3 = resolveTargets({ sessions: "nonexistent.jsonl" }, sessionFile, dir);
  assert(r3.error?.includes("Session not found"), `missing file error: "${r3.error}"`);

  // Empty global
  const emptyRoot = join(TEST_ROOT, "empty-sessions", "--empty--");
  mkdirSync(emptyRoot, { recursive: true });
  const emptyFile = createSession(emptyRoot, [makeUser("x"), makeAssistant("y")]);
  // Only self exists, self gets filtered, so 0 queryable windows
  const r4 = resolveTargets({ sessions: "project", limit: 100 }, emptyFile, emptyRoot);
  assert(r4.error?.includes("No queryable context"), `self-only project error: "${r4.error}"`);
}

// ============================================================================
// Run
// ============================================================================

setup();
try {
  testDefaultLimits();
  testPaginationBasic();
  testPaginationWithCompaction();
  testOffsetBeyondRange();
  testGlobalMode();
  testSelfFiltering();
  testErrorCases();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log("✅ All tests passed\n");
} finally {
  teardown();
}
