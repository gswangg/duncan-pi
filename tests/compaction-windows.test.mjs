/**
 * Test: compaction windowing for duncan fan-out.
 *
 * Creates synthetic sessions with compaction entries using pi's SessionManager,
 * then validates that getCompactionWindows() correctly splits sessions into
 * independently queryable windows. Cross-validates the last window against
 * buildSessionContext().
 *
 * Run: tsx tests/compaction-windows.test.mjs
 */

import { getCompactionWindows } from "../extensions/duncan.ts";

const { SessionManager, buildSessionContext, parseSessionEntries } = await import("@mariozechner/pi-coding-agent");

import { readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Test helpers
// ============================================================================

const TEST_DIR = join("/tmp", "duncan-compaction-test");
const TEST_CWD = "/workspace";

function setup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

function makeUser(t) {
  return {
    role: "user",
    content: [{ type: "text", text: t }],
    timestamp: Date.now(),
  };
}

function makeAssistant(t) {
  return {
    role: "assistant",
    content: [{ type: "text", text: t }],
    provider: "test",
    model: "test-model",
    stopReason: "endTurn",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
    timestamp: Date.now(),
  };
}

function text(msg) {
  if (msg.role === "compactionSummary") return `[SUMMARY] ${msg.summary}`;
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(c => c.type === "text").map(c => c.text).join("");
  }
  return JSON.stringify(msg);
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) {
    console.error(`  ✗ ${msg}`);
    failed++;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

function findEntryByText(sm, targetText) {
  return sm.getEntries().find(e =>
    e.type === "message" && text(e.message) === targetText
  );
}

// ============================================================================
// Tests
// ============================================================================

function test1() {
  console.log("\n--- Test 1: No compactions → single window ---");
  const sm = new SessionManager(TEST_CWD, TEST_DIR, undefined, true);
  sm.appendMessage(makeUser("hello"));
  sm.appendMessage(makeAssistant("world"));
  sm.appendMessage(makeUser("ping"));
  sm.appendMessage(makeAssistant("pong"));

  const entries = parseSessionEntries(readFileSync(sm.getSessionFile(), "utf-8"));
  const windows = getCompactionWindows(entries);

  assert(windows.length === 1, "1 window");
  assert(windows[0].messages.length === 4, `4 messages (got ${windows[0].messages.length})`);

  const ctx = buildSessionContext(entries.filter(e => e.type !== "session"));
  assert(ctx.messages.length === 4, `buildSessionContext also 4`);
}

function test2() {
  console.log("\n--- Test 2: One compaction → 2 windows ---");
  const sm = new SessionManager(TEST_CWD, TEST_DIR, undefined, true);
  sm.appendMessage(makeUser("W0-A"));
  sm.appendMessage(makeAssistant("W0-A resp"));
  sm.appendMessage(makeUser("W0-B"));
  sm.appendMessage(makeAssistant("W0-B resp"));
  sm.appendMessage(makeUser("W0-C (kept)"));
  sm.appendMessage(makeAssistant("W0-C resp (kept)"));

  const keptEntry = findEntryByText(sm, "W0-C (kept)");
  assert(!!keptEntry, "found kept entry");
  sm.appendCompaction("Summary: W0 discussed A, B, C", keptEntry.id, 50000, { readFiles: [], modifiedFiles: [] });

  sm.appendMessage(makeUser("W1-A"));
  sm.appendMessage(makeAssistant("W1-A resp"));

  const entries = parseSessionEntries(readFileSync(sm.getSessionFile(), "utf-8"));
  const windows = getCompactionWindows(entries);

  assert(windows.length === 2, `2 windows (got ${windows.length})`);
  assert(windows[0].messages.length === 6, `w0: 6 msgs (got ${windows[0].messages.length})`);
  assert(windows[1].messages.length === 5, `w1: 5 msgs (got ${windows[1].messages.length})`);
  assert(text(windows[1].messages[0]).includes("[SUMMARY]"), "w1 starts with summary");

  // Cross-validate last window against buildSessionContext
  const ctx = buildSessionContext(entries.filter(e => e.type !== "session"));
  assert(ctx.messages.length === windows[1].messages.length,
    `w1 matches buildSessionContext (${windows[1].messages.length} vs ${ctx.messages.length})`);
  for (let i = 0; i < ctx.messages.length; i++) {
    assert(text(ctx.messages[i]) === text(windows[1].messages[i]),
      `  msg[${i}] matches`);
  }
}

function test3() {
  console.log("\n--- Test 3: Two compactions → 3 windows ---");
  const sm = new SessionManager(TEST_CWD, TEST_DIR, undefined, true);
  sm.appendMessage(makeUser("W0-A"));
  sm.appendMessage(makeAssistant("W0-A resp"));
  sm.appendMessage(makeUser("W0-B"));
  sm.appendMessage(makeAssistant("W0-B resp"));

  const w0Kept = findEntryByText(sm, "W0-B");
  sm.appendCompaction("C1: covers W0", w0Kept.id, 40000, { readFiles: [], modifiedFiles: [] });

  sm.appendMessage(makeUser("W1-A"));
  sm.appendMessage(makeAssistant("W1-A resp"));
  sm.appendMessage(makeUser("W1-B"));
  sm.appendMessage(makeAssistant("W1-B resp"));

  const w1Kept = findEntryByText(sm, "W1-B");
  sm.appendCompaction("C2: covers C1+W1", w1Kept.id, 45000, { readFiles: [], modifiedFiles: [] });

  sm.appendMessage(makeUser("W2-A"));
  sm.appendMessage(makeAssistant("W2-A resp"));

  const entries = parseSessionEntries(readFileSync(sm.getSessionFile(), "utf-8"));
  const windows = getCompactionWindows(entries);

  assert(windows.length === 3, `3 windows (got ${windows.length})`);
  assert(windows[0].messages.length === 4, `w0: 4 msgs (got ${windows[0].messages.length})`);
  assert(windows[1].messages.length === 7, `w1: 7 msgs (got ${windows[1].messages.length})`);
  assert(windows[2].messages.length === 5, `w2: 5 msgs (got ${windows[2].messages.length})`);

  // Cross-validate last window
  const ctx = buildSessionContext(entries.filter(e => e.type !== "session"));
  assert(ctx.messages.length === windows[2].messages.length,
    `w2 matches buildSessionContext (${windows[2].messages.length} vs ${ctx.messages.length})`);
}

function test4() {
  console.log("\n--- Test 4: Content isolation ---");
  const sm = new SessionManager(TEST_CWD, TEST_DIR, undefined, true);

  sm.appendMessage(makeUser("ALPHA-unique"));
  sm.appendMessage(makeAssistant("ALPHA-resp"));
  const alphaKept = findEntryByText(sm, "ALPHA-unique");
  sm.appendCompaction("Summary: alpha", alphaKept.id, 30000);

  sm.appendMessage(makeUser("BETA-unique"));
  sm.appendMessage(makeAssistant("BETA-resp"));
  const betaKept = findEntryByText(sm, "BETA-unique");
  sm.appendCompaction("Summary: alpha+beta", betaKept.id, 35000);

  sm.appendMessage(makeUser("GAMMA-unique"));
  sm.appendMessage(makeAssistant("GAMMA-resp"));

  const entries = parseSessionEntries(readFileSync(sm.getSessionFile(), "utf-8"));
  const windows = getCompactionWindows(entries);

  const w0 = windows[0].messages.map(text).join(" ");
  const w1 = windows[1].messages.map(text).join(" ");
  const w2 = windows[2].messages.map(text).join(" ");

  assert(w0.includes("ALPHA") && !w0.includes("BETA") && !w0.includes("GAMMA"),
    "w0: only ALPHA");
  assert(w1.includes("BETA") && !w1.includes("GAMMA"),
    "w1: BETA (+ alpha summary), no GAMMA");
  assert(w2.includes("GAMMA") && w2.includes("BETA-unique"),
    "w2: GAMMA + kept BETA (via firstKeptEntryId) + summary");
}

function test5() {
  console.log("\n--- Test 5: JSONL structure dump ---");
  const sm = new SessionManager(TEST_CWD, TEST_DIR, undefined, true);
  sm.appendMessage(makeUser("A"));
  sm.appendMessage(makeAssistant("A-r"));
  const a = findEntryByText(sm, "A");
  sm.appendCompaction("C1", a.id, 10000);
  sm.appendMessage(makeUser("B"));
  sm.appendMessage(makeAssistant("B-r"));
  const b = findEntryByText(sm, "B");
  sm.appendCompaction("C2", b.id, 15000);
  sm.appendMessage(makeUser("C"));
  sm.appendMessage(makeAssistant("C-r"));

  const raw = readFileSync(sm.getSessionFile(), "utf-8").trim().split("\n");
  console.log("\n  Raw JSONL:");
  for (const line of raw) {
    const e = JSON.parse(line);
    if (e.type === "session") console.log(`    [session] id=${e.id.slice(0,8)}`);
    else if (e.type === "message") console.log(`    [msg] id=${e.id} "${text(e.message)}"`);
    else if (e.type === "compaction") console.log(`    [compact] id=${e.id} firstKept=${e.firstKeptEntryId} "${e.summary}"`);
  }

  const entries = parseSessionEntries(readFileSync(sm.getSessionFile(), "utf-8"));
  const windows = getCompactionWindows(entries);

  console.log(`\n  Windows: ${windows.length}`);
  for (const w of windows) {
    console.log(`    W${w.windowIndex}: ${w.messages.map(m => `${m.role}:"${text(m).slice(0,30)}"`).join(", ")}`);
  }
  assert(windows.length === 3, "3 windows");
}

function test6() {
  console.log("\n--- Test 6: getDuncanTargets ---");

  function getDuncanTargets(sessionFile) {
    const content = readFileSync(sessionFile, "utf-8");
    const entries = parseSessionEntries(content);
    const windows = getCompactionWindows(entries);
    return windows.map(w => ({ sessionFile, windowIndex: w.windowIndex, messages: w.messages }));
  }

  const sm1 = new SessionManager(TEST_CWD, TEST_DIR, undefined, true);
  sm1.appendMessage(makeUser("simple"));
  sm1.appendMessage(makeAssistant("reply"));
  const t1 = getDuncanTargets(sm1.getSessionFile());
  assert(t1.length === 1, "uncompacted: 1 target");

  const sm2 = new SessionManager(TEST_CWD, TEST_DIR, undefined, true);
  sm2.appendMessage(makeUser("X"));
  sm2.appendMessage(makeAssistant("X-r"));
  sm2.appendCompaction("C1", findEntryByText(sm2, "X").id, 20000);
  sm2.appendMessage(makeUser("Y"));
  sm2.appendMessage(makeAssistant("Y-r"));
  const t2 = getDuncanTargets(sm2.getSessionFile());
  assert(t2.length === 2, "compacted: 2 targets");
  assert(t2[0].windowIndex === 0 && t2[1].windowIndex === 1, "correct indices");
}

// ============================================================================
// Run
// ============================================================================

setup();
try {
  test1();
  test2();
  test3();
  test4();
  test5();
  test6();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log("✅ All tests passed\n");
} finally {
  teardown();
}
