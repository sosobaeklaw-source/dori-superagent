import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { Herdr, HerdrError, omoScreenIdle, shq, spawnExec, type AgentStatus, type Exec } from "./herdr.ts";
import { KEY_RE, Store, type HostLoad, type Lane, type ReviewStage, type Role } from "./store.ts";
import { Telemetry, type MergeOutcome, type Usage } from "./telemetry.ts";

export { KEY_RE };

export const NUDGE_MINUTES = [10, 20, 40] as const;
const PROMPTS = join(import.meta.dir, "..", "prompts");
const CLI = resolve(import.meta.dir, "cli.ts");

export type Deps = {
  readonly store: Store;
  readonly herdr: Herdr;
  readonly exec: Exec;
  readonly now: () => number;
  readonly agentCmd: string;
  readonly doriCmd: string;
  readonly host: () => HostLoad;
  readonly usage: Usage;
};

export const defaultDeps = (): Deps => {
  const store = new Store();
  return {
    store,
    herdr: new Herdr(),
    exec: spawnExec,
    now: Date.now,
    agentCmd: process.env["DORI_AGENT_CMD"] ?? "omo",
    doriCmd: process.env["DORI_CMD"] ?? `DORI_HOME=${shq(store.root)} bun ${shq(CLI)}`,
    host: () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length, memFreePct: memFreePct() }),
    usage: new Telemetry(store.root),
  };
};

export class Refusal extends Error {}

const sysctlMemoryLevel = (): string => execFileSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: 2000 });

/**
 * Percent of memory available to start new work. On Linux, os.freemem() is MemAvailable. On macOS it is only the
 * truly free pages (inactive and cached pages excluded), which sits near 0-5% on a healthy Mac, so the kernel's own
 * available-memory level (the figure behind Activity Monitor's memory pressure) is used there instead.
 */
export function memFreePct(
  platform: string = process.platform,
  readLevel: () => string = sysctlMemoryLevel,
  freePct: () => number = () => Math.round((freemem() / totalmem()) * 100),
): number {
  if (platform === "darwin") {
    try {
      const level = Number(readLevel().trim());
      if (Number.isFinite(level) && level >= 0 && level <= 100) return Math.round(level);
    } catch {
      // fall through to freemem(): a missing sysctl must not stop the loop from reading memory at all
    }
  }
  return freePct();
}

const prompt = (name: string, vars: Record<string, string>): string =>
  readFileSync(join(PROMPTS, name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

// ---------- pane messaging ----------

export function resolveTarget(d: Deps, target: string): string {
  if (/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/.test(target)) return target;
  const roles = d.store.roles();
  if (target === "lead" || target === "duty") {
    const pane = roles[target];
    if (!pane) throw new Refusal(`no ${target} pane registered (dori role ${target} <pane>)`);
    return pane;
  }
  const lane = d.store.lane(target);
  if (lane && lane.status !== "done") return lane.paneId;
  throw new Refusal(`unknown target ${target}: not a pane id, role or open lane`);
}

const READY_TO_READ: readonly AgentStatus[] = ["idle", "done", "shell"];

/** Delivers now when the pane can read; otherwise queues it for the duty loop (busy agents are never interrupted). */
export async function send(d: Deps, target: string, text: string, from: string): Promise<"DELIVERED" | "QUEUED"> {
  const paneId = resolveTarget(d, target);
  d.store.enqueue(paneId, { at: d.now(), from, text });
  return (await flushInbox(d, paneId)) ? "DELIVERED" : "QUEUED";
}

export async function flushInbox(d: Deps, paneId: string): Promise<boolean> {
  const queued = d.store.queued(paneId);
  if (queued.length === 0) return true;
  let status = await d.herdr.status(paneId);
  if (status === "gone") throw new Refusal(`pane ${paneId} is gone; ${queued.length} message(s) kept in its inbox`);
  if (status === "working" && (await screenShowsIdle(d, paneId))) status = "idle";
  if (!READY_TO_READ.includes(status)) return false;
  const body =
    queued.length === 1
      ? queued[0]!.text
      : `${queued.length} messages arrived while you were busy:\n\n` +
        queued.map((m, i) => `(${i + 1}) from ${m.from}:\n${m.text}`).join("\n\n");
  await d.herdr.deliver(paneId, body, status);
  d.store.clearInbox(paneId);
  return true;
}

/**
 * herdr reports an omo with live monitors as `working` between turns (#62). Believe the screen only when it
 * positively shows the idle input; a failed read is doubt, so the message stays queued for the next duty pass.
 */
async function screenShowsIdle(d: Deps, paneId: string): Promise<boolean> {
  try {
    return omoScreenIdle(await d.herdr.read(paneId, 30));
  } catch {
    return false;
  }
}

export async function tellLead(d: Deps, text: string, from: string): Promise<void> {
  if (!d.store.roles().lead) {
    process.stderr.write(`dori: no lead pane registered; message kept only in the lane log\n`);
    return;
  }
  await send(d, "lead", text, from);
}

// ---------- lanes ----------

export async function startLane(
  d: Deps,
  key: string,
  briefFile: string,
  opts: { cwd?: string; workspace?: string } = {},
): Promise<Lane> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const existing = d.store.lane(key);
  if (existing && existing.status !== "done" && existing.status !== "lost") throw new Refusal(`lane ${key} is already open in ${existing.paneId}`);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const briefPath = d.store.briefPath(key);
  const footer = prompt("lane-footer.md", { key, dori: d.doriCmd });
  await Bun.write(briefPath, `${readFileSync(briefFile, "utf8").trimEnd()}\n\n${footer}`);

  const workspace = opts.workspace ?? process.env["HERDR_WORKSPACE_ID"];
  const env = { DORI_LANE: key, DORI_HOME: d.store.root };
  const pane = workspace
    ? await d.herdr.createTab(key, cwd, workspace, env)
    : await d.herdr.createTab(key, cwd, (await d.herdr.createWorkspace("dori", cwd)).workspaceId, env);
  const kickoff = `Read your brief at ${briefPath} and execute it. Your lane key is ${key}.`;
  await d.herdr.run(pane.paneId, `${d.agentCmd} ${shq(kickoff)}`);

  const now = d.now();
  const lane: Lane = {
    key, paneId: pane.paneId, tabId: pane.tabId, brief: briefPath, cwd,
    status: "working", createdAt: now, lastActivityAt: now, nudges: 0,
    log: [{ at: now, kind: "start", text: briefFile }],
  };
  d.store.saveLane(lane);
  await tellLead(d, `[START ${key}] lane opened in ${pane.paneId}`, key);
  const open = d.store.lanes().filter((l) => l.status === "working" || l.status === "waiting").length;
  d.usage.record({ name: "dori.lane_started", open_lanes: Math.min(open, 1000) });
  return lane;
}

function openLane(d: Deps, key: string): Lane {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status === "done" || lane.status === "lost") throw new Refusal(`lane ${key} is ${lane.status}`);
  return lane;
}

export async function report(d: Deps, key: string, text: string, status?: "working" | "waiting"): Promise<void> {
  const lane = openLane(d, key);
  const now = d.now();
  lane.log.push({ at: now, kind: "report", text });
  lane.lastActivityAt = now;
  lane.nudges = 0;
  if (status) lane.status = status;
  d.store.saveLane(lane);
  await tellLead(d, `[REPORT ${key}${status === "waiting" ? " WAITING" : ""}] ${text}`, key);
}

export async function ready(d: Deps, key: string, text: string, evidence: readonly string[]): Promise<void> {
  if (evidence.length === 0) throw new Refusal("READY needs at least one --evidence link (a PR, a receipt, a file)");
  if (!text.trim()) throw new Refusal("READY needs the final answer text");
  const lane = openLane(d, key);
  const now = d.now();
  lane.status = "ready";
  lane.final = { text, evidence: [...evidence], at: now };
  lane.lastActivityAt = now;
  lane.log.push({ at: now, kind: "ready", text });
  d.store.saveLane(lane);
  await tellLead(d, `[READY ${key}] ${text}\nevidence: ${evidence.join(" ")}`, key);
  d.usage.record({
    name: "dori.lane_ready",
    evidence_count: Math.min(evidence.length, 100),
    lane_minutes: Math.min(Math.floor((now - lane.createdAt) / 60_000), 10_080),
  });
}

export async function done(d: Deps, key: string): Promise<void> {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status !== "ready") throw new Refusal(`lane ${key} is ${lane.status}, not ready: no final answer recorded`);
  const st = await d.herdr.status(lane.paneId);
  if (st === "working" || st === "blocked") throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
  if (st !== "gone") await d.herdr.close(lane.paneId);
  lane.status = "done";
  lane.log.push({ at: d.now(), kind: "done", text: "closed by lead" });
  d.store.saveLane(lane);
}

// ---------- duty loop ----------

export type DutyEvent = { lane?: string; pane?: string; action: string; detail?: string };

/** A short one-line reason. A HerdrError message carries the whole argv (the queued text), so use herdr's own output. */
function failureDetail(e: unknown): string {
  const raw = e instanceof HerdrError ? e.result.stderr || e.result.stdout : e instanceof Error ? e.message : String(e);
  const first = raw.trim().split("\n")[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
}

/** One proactive pass: flush inboxes of panes that became idle, nudge silent lanes, escalate, detect lost panes. */
export async function dutyTick(d: Deps): Promise<DutyEvent[]> {
  // Kill switch: a stopped duty loop delivers, nudges and escalates nothing. Queued messages wait for the resume.
  const stop = d.store.stop("duty");
  if (stop) return [{ action: "stopped", detail: stop.reason }];
  const events: DutyEvent[] = [];
  for (const paneId of d.store.inboxPanes()) {
    try {
      if (await flushInbox(d, paneId)) events.push({ pane: paneId, action: "flushed" });
    } catch (e) {
      // One pane's failed delivery must never kill the loop for every other pane and lane.
      if (e instanceof Refusal) events.push({ pane: paneId, action: "inbox-target-gone" });
      else events.push({ pane: paneId, action: "flush-failed", detail: failureDetail(e) });
    }
  }
  for (const lane of d.store.lanes()) {
    if (lane.status !== "working" && lane.status !== "waiting") continue;
    try {
      const st = await d.herdr.status(lane.paneId);
      const now = d.now();
      if (st === "gone") {
        lane.status = "lost";
        lane.log.push({ at: now, kind: "lost", text: "pane disappeared without READY" });
        d.store.saveLane(lane);
        await tellLead(d, `[LOST ${lane.key}] pane ${lane.paneId} closed without a final answer`, "duty");
        events.push({ lane: lane.key, action: "lost" });
        continue;
      }
      if (st === "working") {
        lane.lastActivityAt = now;
        d.store.saveLane(lane);
        continue;
      }
      if (lane.status === "waiting" || st === "blocked") continue;
      const idleMin = (now - lane.lastActivityAt) / 60_000;
      const due = NUDGE_MINUTES[lane.nudges];
      if (due === undefined || idleMin < due) continue;
      lane.nudges += 1;
      lane.log.push({ at: now, kind: "nudge", text: `idle ${Math.floor(idleMin)} min` });
      d.store.saveLane(lane);
      if (lane.nudges < NUDGE_MINUTES.length) {
        await send(d, lane.key, prompt("nudge.md", { key: lane.key, minutes: String(Math.floor(idleMin)), dori: d.doriCmd }), "duty");
        events.push({ lane: lane.key, action: `nudge-${lane.nudges}` });
      } else {
        await tellLead(d, `[ESCALATE ${lane.key}] idle ${Math.floor(idleMin)} min with no READY after ${lane.nudges - 1} nudges`, "duty");
        events.push({ lane: lane.key, action: "escalated" });
      }
    } catch (e) {
      // One lane's failed status read or delivery must not end the loop for the other lanes.
      events.push({ lane: lane.key, action: "lane-failed", detail: failureDetail(e) });
    }
  }
  const count = (pred: (a: string) => boolean) => events.filter((e) => pred(e.action)).length;
  d.usage.touch();
  d.usage.duty({
    ticks: 1,
    flushed: count((a) => a === "flushed"),
    nudges: count((a) => a.startsWith("nudge-")),
    escalations: count((a) => a === "escalated"),
    lost: count((a) => a === "lost"),
  });
  return events;
}

// ---------- review + merge gate ----------

export type PrRef = { repo: string; number: number; id: string };

export function parsePr(s: string): PrRef {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (!m) throw new Refusal(`PR must look like owner/repo#123, got ${s}`);
  const number = Number(m[2]);
  return { repo: m[1]!, number, id: `${m[1]}#${number}` };
}

async function gh(d: Deps, argv: readonly string[]): Promise<string> {
  const r = await d.exec("gh", argv);
  if (r.code !== 0) throw new Error(`gh ${argv.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

type PrSnapshot = { head: string; base: string; changedFiles: number };

async function prSnapshot(d: Deps, pr: PrRef): Promise<PrSnapshot> {
  const out = JSON.parse(await gh(d, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "headRefOid,baseRefOid,changedFiles"])) as { headRefOid?: unknown; baseRefOid?: unknown; changedFiles?: unknown };
  if (typeof out.headRefOid !== "string" || !/^[\da-f]{40}$/i.test(out.headRefOid) || typeof out.baseRefOid !== "string" || !/^[\da-f]{40}$/i.test(out.baseRefOid) || typeof out.changedFiles !== "number" || !Number.isSafeInteger(out.changedFiles) || out.changedFiles < 1) throw new Refusal("GitHub returned an incomplete PR snapshot");
  return { head: out.headRefOid, base: out.baseRefOid, changedFiles: out.changedFiles };
}

export async function headSha(d: Deps, pr: PrRef): Promise<string> {
  return (await prSnapshot(d, pr)).head;
}

type ReviewModel = { id: string; cli: string };

async function resolveReviewModel(d: Deps, requested: string): Promise<ReviewModel> {
  const [name, thinking, extra] = requested.trim().split(":");
  if (!name || extra !== undefined || (thinking !== undefined && !/^[a-z]+$/.test(thinking))) {
    throw new Refusal("review model must be an exact provider/model identifier with an optional thinking level");
  }
  const listing = await d.exec(d.agentCmd, ["--list-models"]);
  if (listing.code !== 0) throw new Error("could not resolve reviewer model: " + listing.stderr.trim());
  const available = new Set(listing.stdout.split(/\r?\n/).flatMap((line) => {
    const columns = line.trim().split(/\s+/);
    return columns.length >= 3 && /^\d+(?:\.\d+)?[KMG]$/i.test(columns[2]!) ? [`${columns[0]}/${columns[1]}`] : [];
  }));
  const id = [...available].find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (!id) throw new Refusal("review model is not an exact model from omo --list-models: " + name);
  return { id, cli: id + (thinking === undefined ? "" : ":" + thinking) };
}

function isOpus(model: string): boolean {
  return /(?:^|[\/_-])opus(?:$|[\/_-])/i.test(model);
}

function isFinalApprover(model: string): boolean {
  return /opus|neon|antigravity/i.test(model);
}

async function diffForHead(d: Deps, pr: PrRef, base: string, head: string, changedFiles: number): Promise<string> {
  const response = JSON.parse(await gh(d, ["api", "repos/" + pr.repo + "/compare/" + base + "..." + head])) as { files?: { filename?: string; status?: string; patch?: string }[] };
  if (!Array.isArray(response.files) || response.files.length !== changedFiles) throw new Refusal("GitHub did not return every file in the exact PR diff");
  return response.files.map((file) => {
    if (!file.filename || typeof file.patch !== "string") throw new Refusal("the exact PR diff is incomplete; a changed file has no text patch");
    return "diff -- " + file.filename + " (" + (file.status ?? "changed") + ")\n" + file.patch;
  }).join("\n\n");
}

type Check = { name: string; bucket: string };

async function checksForSha(d: Deps, pr: PrRef, sha: string): Promise<Check[]> {
  const [runsText, statusText] = await Promise.all([
    gh(d, ["api", `repos/${pr.repo}/commits/${sha}/check-runs`, "-F", "per_page=100"]),
    gh(d, ["api", "repos/" + pr.repo + "/commits/" + sha + "/status"]),
  ]);
  const runResponse = JSON.parse(runsText) as { total_count?: number; check_runs?: { name?: string; status?: string; conclusion?: string | null }[] };
  const runs = runResponse.check_runs ?? [];
  const checks = runs.map((run) => ({
    name: run.name ?? "unnamed check",
    bucket: run.status !== "completed" ? "pending" : run.conclusion === "success" ? "pass" : run.conclusion === "skipped" || run.conclusion === "neutral" ? "skipping" : "fail",
  }));
  if (typeof runResponse.total_count === "number" && runResponse.total_count > runs.length) checks.push({ name: "check-run response incomplete", bucket: "pending" });
  const status = JSON.parse(statusText) as { state?: string; statuses?: unknown[] };
  if ((status.statuses?.length ?? 0) > 0) checks.push({ name: "combined status", bucket: status.state === "success" ? "pass" : status.state === "pending" ? "pending" : "fail" });
  return checks;
}

function checkRefusal(checks: Check[]): [MergeOutcome, string] | undefined {
  if (checks.length === 0) return ["no_checks", "no checks reported: an empty check list is never green"];
  const bad = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  if (bad.length > 0) return ["checks_red", "checks not green: " + bad.map((c) => c.name + "=" + c.bucket).join(", ")];
  if (!checks.some((c) => c.bucket === "pass")) return ["checks_all_skipped", "every check was skipped"];
  return undefined;
}

function assistantOutput(stdout: string): { model: string; text: string } {
  const records = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const messages = records.flatMap((record) => {
    if (record.type === "message_end" && typeof record.message === "object" && record.message !== null) return [record.message as Record<string, unknown>];
    if (record.type === "agent_end" && Array.isArray(record.messages)) return record.messages.filter((message): message is Record<string, unknown> => typeof message === "object" && message !== null);
    return [];
  }).filter((message) => message.role === "assistant");
  const message = messages.at(-1);
  if (!message || typeof message.provider !== "string" || typeof message.model !== "string") throw new Error("reviewer output did not report its actual provider and model");
  const content = message.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((part) => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
  return { model: message.provider + "/" + message.model, text };
}

/** Runs an exact diff review only after checks for that immutable head pass. */
export async function review(d: Deps, prId: string, authorModel: string, model: string, stage: ReviewStage): Promise<{ verdict: "CLEAR" | "BLOCK"; sha: string }> {
  const pr = parsePr(prId);
  return d.store.withReviewLock(pr.id, async () => {
    const { head: sha, base, changedFiles } = await prSnapshot(d, pr);
    const [checks, diff] = await Promise.all([checksForSha(d, pr, sha), diffForHead(d, pr, base, sha, changedFiles)]);
    const machineRefusal = checkRefusal(checks);
    if (machineRefusal) throw new Refusal("REVIEW_REFUSED " + machineRefusal[1]);
    const author = await resolveReviewModel(d, authorModel);
    const reviewer = await resolveReviewModel(d, model);
    if (reviewer.id.toLowerCase() === author.id.toLowerCase()) throw new Refusal("reviewer must differ from the recorded author model");
    if (stage === "cross" && isOpus(reviewer.id)) throw new Refusal("cross-review cannot use Opus");
    if (stage === "cross" && d.store.crossReviewCount(pr.id) >= 2) throw new Refusal("cross-review is limited to two rounds per PR");
    if (stage === "approval") {
      const cross = d.store.receipt(pr.id, sha, "cross");
      if (!cross || cross.verdict !== "CLEAR") throw new Refusal("independent approval requires a CLEAR cross-review at this head");
      if (reviewer.id.toLowerCase() === cross.model.toLowerCase()) throw new Refusal("approval model must differ from the cross-review model");
      if (!isFinalApprover(reviewer.id)) throw new Refusal("final approval requires Opus, Neon, or Antigravity");
      if (d.store.receipt(pr.id, sha, "approval")) throw new Refusal("approval review already has a receipt at this head");
    }
    d.store.setAuthorModel(pr.id, author.id);
    const stageInstructions: Record<ReviewStage, string> = {
      cross: "Independent cross-review of the exact inline patch, independent of the recorded author model.",
      approval: "Independent final approval of the exact inline patch.",
    };
    const text = prompt("review.md", { pr: pr.id, repo: pr.repo, number: String(pr.number), sha }) + "\n\nRecorded author model: " + author.id + "\n" + stageInstructions[stage] + "\n\nExact diff for base " + base + "...head " + sha + ":\n--- BEGIN EXACT DIFF ---\n" + diff + "\n--- END EXACT DIFF ---\n";
    const res = await d.exec(d.agentCmd, ["-p", "--no-session", "--no-tools", "--mode", "json", "--model", reviewer.cli, text]);
    if (res.code !== 0) throw new Error("reviewer exited " + res.code + ": " + res.stderr.trim());
    const output = assistantOutput(res.stdout);
    if (output.model.toLowerCase() !== reviewer.id.toLowerCase()) throw new Error("reviewer actually ran " + output.model + ", expected " + reviewer.id + "; no receipt written");
    const verdicts = [...output.text.matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)];
    const last = verdicts.at(-1);
    if (!last) throw new Error("reviewer printed no VERDICT line; no receipt written");
    if (await headSha(d, pr) !== sha) throw new Refusal("PR head changed during review; result discarded without a receipt");
    const verdict = last[1] as "CLEAR" | "BLOCK";
    d.store.saveReceipt({ pr: pr.id, sha, stage, verdict, model: output.model, at: d.now(), summary: output.text.trim().slice(-4000) });
    d.usage.record({ name: "dori.review_completed", verdict });
    return { verdict, sha };
  });
}

/** Merge only when the recorded author, independent cross-review, final approval and reported checks agree at the exact head. */
export async function mergeGate(d: Deps, prId: string, opts: { dryRun?: boolean } = {}): Promise<string> {
  const pr = parsePr(prId);
  return d.store.withReviewLock(pr.id, async () => {
    const sha = await headSha(d, pr);
    const refused = await gateRefusal(d, pr, sha);
    if (refused) {
      if (!opts.dryRun) d.usage.record({ name: "dori.merge_decided", outcome: refused[0] });
      throw new Refusal("MERGE_REFUSED " + refused[1]);
    }
    if (opts.dryRun) return "MERGE_OK " + pr.id + " head=" + sha + " (dry run)";
    await gh(d, ["pr", "merge", String(pr.number), "--repo", pr.repo, "--squash", "--match-head-commit", sha]);
    d.usage.record({ name: "dori.merge_decided", outcome: "merged" });
    return "MERGED " + pr.id + " head=" + sha;
  });
}

async function gateRefusal(d: Deps, pr: PrRef, sha: string): Promise<[MergeOutcome, string] | undefined> {
  const authorModel = d.store.authorModel(pr.id);
  if (!authorModel) return ["no_receipt", "author model is not recorded for " + pr.id];
  const crossReceipts = d.store.receipts(pr.id, sha, "cross");
  const approvalReceipts = d.store.receipts(pr.id, sha, "approval");
  const blocked = [...crossReceipts, ...approvalReceipts].find((receipt) => receipt.verdict !== "CLEAR");
  if (blocked) return ["review_block", blocked.stage + " review at " + sha.slice(0, 12) + " is " + blocked.verdict];
  const cross = crossReceipts.at(-1);
  const approval = approvalReceipts.at(-1);
  if (!cross || !approval) {
    const missing = [cross ? undefined : "cross", approval ? undefined : "approval"].filter((stage): stage is string => stage !== undefined);
    return ["no_receipt", "missing review stages at head " + sha.slice(0, 12) + ": " + missing.join(", ")];
  }
  if (cross.model.toLowerCase().includes("opus")) return ["review_block", "cross-review cannot use Opus"];
  if (!isFinalApprover(approval.model)) return ["review_block", "final approval must use Opus, Neon, or Antigravity"];
  if (cross.model.toLowerCase() === authorModel.toLowerCase() || approval.model.toLowerCase() === authorModel.toLowerCase() || approval.model.toLowerCase() === cross.model.toLowerCase()) {
    return ["review_block", "author, cross-review, and approval must use different models"];
  }
  return checkRefusal(await checksForSha(d, pr, sha));
}


export const ROLES: readonly Role[] = ["lead", "duty"];
