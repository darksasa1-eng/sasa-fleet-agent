"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");

const PORT = Number(process.env.PORT || 5000);
const TOKEN = (process.env.FLEET_TOKEN || "").trim();
const SERVER_NAME = process.env.FLEET_SERVER_NAME || os.hostname();
const APPS_ROOT = process.env.FLEET_APPS_ROOT || path.join(os.tmpdir(), "fleet-apps");
const MAX_APPS = Number(process.env.FLEET_MAX_APPS || 3);
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const LOG_LIMIT = 300;
const PORT_BASE = 6100;

const apps = new Map();
const startedAt = Date.now();
let lastSample = null;

function log(message) {
  console.log(`[${SERVER_NAME}] ${message}`);
}

async function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}), NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      options.onLine("Command timed out");
      try {
        child.kill("SIGKILL");
      } catch {
        void 0;
      }
    }, options.timeoutMs || 480000);
    const forward = (chunk) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) options.onLine(trimmed.slice(0, 300));
      }
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", (error) => {
      done = true;
      clearTimeout(timer);
      options.onLine(`Command failed: ${error.message}`);
      resolve(1);
    });
    child.on("close", (code) => {
      done = true;
      clearTimeout(timer);
      resolve(code === null ? 1 : code);
    });
  });
}

function entry(slug) {
  return apps.get(String(slug || "").toLowerCase()) || null;
}

function newEntry(slug) {
  return {
    slug,
    dir: path.join(APPS_ROOT, slug),
    child: null,
    port: null,
    state: "stopped",
    startedAt: null,
    restarts: 0,
    lastError: null,
    logs: [],
    projectType: "node",
  };
}

function pushLog(item, message, level) {
  item.logs.push({ at: new Date().toISOString(), level: level || "info", message: String(message).slice(0, 400) });
  while (item.logs.length > LOG_LIMIT) item.logs.shift();
}

function freePort() {
  const used = new Set();
  for (const item of apps.values()) if (item.port) used.add(item.port);
  for (let i = 0; i < 90; i += 1) {
    const candidate = PORT_BASE + i;
    if (!used.has(candidate)) return candidate;
  }
  return PORT_BASE;
}

async function extractArchive(buffer, dir) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(os.tmpdir(), `fleet-upload-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`);
  await fsp.writeFile(file, buffer);
  const code = await run("tar", ["-xzf", file, "-C", dir, "--no-same-owner"], {
    cwd: dir,
    timeoutMs: 60000,
    onLine: () => undefined,
  });
  await fsp.rm(file, { force: true });
  return code === 0;
}

async function detectCommand(dir, projectType, commandOverride) {
  const override = (commandOverride || "").trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { command: parts[0] === "node" ? process.execPath : parts[0], args: parts.slice(1) };
  }
  let pkg = null;
  try {
    pkg = JSON.parse(await fsp.readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    pkg = null;
  }
  const scripts = (pkg && pkg.scripts) || {};
  if (projectType === "python") {
    for (const candidate of ["main.py", "bot.py", "app.py", "bot/main.py"]) {
      if (fs.existsSync(path.join(dir, candidate))) return { command: "python3", args: ["-u", candidate] };
    }
  }
  if (scripts.start) return { command: "npm", args: ["start", "--silent"] };
  if (projectType === "worker" && scripts.bot) return { command: "npm", args: ["run", "bot", "--silent"] };
  if (pkg && typeof pkg.main === "string") return { command: process.execPath, args: [pkg.main] };
  for (const candidate of ["index.js", "server.js", "app.js", "main.js", "bot.js", "index.mjs"]) {
    if (fs.existsSync(path.join(dir, candidate))) return { command: process.execPath, args: [candidate] };
  }
  return null;
}

function stopEntry(item) {
  return new Promise((resolve) => {
    if (!item.child) {
      item.state = "stopped";
      item.port = null;
      return resolve();
    }
    const child = item.child;
    item.state = "stopping";
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        void 0;
      }
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        void 0;
      }
    }, 2500);
    child.on("exit", () => {
      clearTimeout(timer);
      item.child = null;
      item.port = null;
      item.state = "stopped";
      resolve();
    });
    setTimeout(resolve, 3200);
  });
}

function waitForPort(port, item, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const attempt = async () => {
      if (!item.child) return resolve(false);
      if (Date.now() - started > (timeoutMs || 60000)) return resolve(false);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(4000) });
        if (res.status < 500) return resolve(true);
      } catch {
        void 0;
      }
      setTimeout(attempt, 1000);
    };
    void attempt();
  });
}

async function startEntry(item, input) {
  if (item.child) {
    return { state: "running", port: item.port };
  }
  if (!fs.existsSync(item.dir)) {
    item.state = "crashed";
    item.lastError = "Project files are not on this server. Deploy the project again.";
    return { state: "crashed", port: null, error: item.lastError };
  }
  item.projectType = input.projectType || "node";
  const projectRoot = input.rootDirectory ? path.join(item.dir, ...String(input.rootDirectory).split("/").filter(Boolean)) : item.dir;
  const port = item.projectType === "node" ? input.port || freePort() : null;

  if (input.install !== false && fs.existsSync(path.join(projectRoot, "package.json"))) {
    pushLog(item, "Installing dependencies", "system");
    const installCode = await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: projectRoot,
      timeoutMs: 420000,
      onLine: (line) => pushLog(item, line, "info"),
    });
    pushLog(item, `Dependency install finished with exit code ${installCode}`, installCode === 0 ? "system" : "error");
    if (installCode !== 0) {
      item.state = "crashed";
      item.lastError = "Dependency install failed.";
      return { state: "crashed", port: null, error: item.lastError };
    }
    const buildScript = await (async () => {
      try {
        const pkg = JSON.parse(await fsp.readFile(path.join(projectRoot, "package.json"), "utf8"));
        return Boolean(pkg && pkg.scripts && pkg.scripts.build);
      } catch {
        return false;
      }
    })();
    if (buildScript) {
      pushLog(item, "Running npm run build", "system");
      const buildCode = await run("npm", ["run", "build", "--silent"], {
        cwd: projectRoot,
        timeoutMs: 540000,
        onLine: (line) => pushLog(item, line, "info"),
      });
      pushLog(item, `Build finished with exit code ${buildCode}`, buildCode === 0 ? "system" : "error");
      if (buildCode !== 0) {
        item.state = "crashed";
        item.lastError = "The build failed.";
        return { state: "crashed", port: null, error: item.lastError };
      }
    }
  }

  const detected = await detectCommand(projectRoot, item.projectType, input.runCommand);
  if (!detected) {
    item.state = "crashed";
    item.lastError = "No run command was detected for this project.";
    return { state: "crashed", port: null, error: item.lastError };
  }

  const env = { ...process.env, NODE_ENV: "production", ...(input.env || {}) };
  delete env.FLEET_TOKEN;
  if (port !== null) env.PORT = String(port);
  else delete env.PORT;

  const child = spawn(detected.command, detected.args, {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  item.child = child;
  item.port = port;
  item.state = "starting";
  item.startedAt = Date.now();
  item.restarts += 1;
  item.lastError = null;
  pushLog(item, `Started ${detected.command} ${detected.args.join(" ")}`, "system");

  const forward = (level) => (chunk) => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) pushLog(item, trimmed, level);
    }
  };
  child.stdout.on("data", forward("info"));
  child.stderr.on("data", forward("warn"));
  child.on("error", (error) => {
    item.lastError = error.message;
    item.state = "crashed";
    pushLog(item, `Could not start the process: ${error.message}`, "error");
  });
  child.on("exit", (code, signal) => {
    pushLog(item, `Process exited (${signal || `code ${code}`})`, "error");
    if (item.child === child) {
      item.child = null;
      item.port = null;
      item.state = "crashed";
    }
  });

  if (port !== null) {
    const ready = await waitForPort(port, item, 60000);
    if (!item.child) {
      return { state: "crashed", port: null, error: item.lastError || "The app exited during startup." };
    }
    item.state = ready ? "running" : "starting";
    pushLog(item, ready ? `Listening on port ${port}` : `No HTTP response on port ${port} yet`, ready ? "system" : "warn");
    return { state: item.state, port };
  }
  item.state = "running";
  pushLog(item, "Worker process is running", "system");
  return { state: "running", port: null };
}

async function readText(file) {
  try {
    return (await fsp.readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

function ownProcessPids() {
  const groupLeaders = new Set();
  for (const item of apps.values()) if (item.child && item.child.pid) groupLeaders.add(item.child.pid);
  const pids = [];
  let entries = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return { pids, groupLeaders };
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) {
      pids.push(pid);
      continue;
    }
    try {
      const raw = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = raw.lastIndexOf(")");
      const fields = raw.slice(close + 2).split(/\s+/);
      const pgrp = Number(fields[2]);
      if (groupLeaders.has(pgrp) || groupLeaders.has(pid)) pids.push(pid);
    } catch {
      void 0;
    }
  }
  return { pids, groupLeaders };
}

function processTreeUsage() {
  const { pids } = ownProcessPids();
  let rssBytes = 0;
  let ticks = 0;
  for (const pid of pids) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const line = status.split("\n").find((row) => row.startsWith("VmRSS:"));
      if (line) rssBytes += Number(line.split(/\s+/)[1]) * 1024;
    } catch {
      void 0;
    }
    try {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = raw.lastIndexOf(")");
      const fields = raw.slice(close + 2).split(/\s+/);
      ticks += Number(fields[11] || 0) + Number(fields[12] || 0);
    } catch {
      void 0;
    }
  }
  return { rssBytes, cpuUsec: Math.round((ticks / 100) * 1e6), processes: pids.length };
}

async function cgroupLimitMb() {
  const envLimit = Number(process.env.FLEET_RAM_LIMIT_MB || 0);
  if (Number.isFinite(envLimit) && envLimit > 64) return envLimit;
  const maxV2 = await readText("/sys/fs/cgroup/memory.max");
  if (maxV2 && maxV2 !== "max") {
    const value = Number(maxV2);
    if (Number.isFinite(value) && value > 0 && value < 4 * 1024 * 1024 * 1024) return Math.round(value / 1048576);
  }
  const maxV1 = await readText("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  if (maxV1) {
    const value = Number(maxV1);
    if (Number.isFinite(value) && value > 0 && value < 4 * 1024 * 1024 * 1024) return Math.round(value / 1048576);
  }
  return 512;
}

async function metrics() {
  const tree = processTreeUsage();
  const usageUsec = tree.cpuUsec;
  const quota = 1;
  const ramLimitMb = await cgroupLimitMb();
  const now = Date.now();

  let cpuPercent = 0;
  let netRxPerSec = 0;
  let netTxPerSec = 0;
  let rx = 0;
  let tx = 0;
  const netRaw = await readText("/proc/net/dev");
  if (netRaw) {
    for (const line of netRaw.split("\n").slice(2)) {
      const [iface, rest] = line.split(":");
      if (!iface || !rest) continue;
      if (iface.trim() === "lo") continue;
      const cols = rest.trim().split(/\s+/);
      rx += Number(cols[0] || 0);
      tx += Number(cols[8] || 0);
    }
  }

  if (lastSample && usageUsec !== null && lastSample.usageUsec !== null) {
    const elapsedMs = Math.max(400, now - lastSample.at);
    const deltaUsec = Math.max(0, usageUsec - lastSample.usageUsec);
    cpuPercent = Math.min(100, Number(((deltaUsec / 1000 / elapsedMs / quota) * 100).toFixed(1)));
    netRxPerSec = Math.max(0, Math.round(((rx - lastSample.rx) / elapsedMs) * 1000));
    netTxPerSec = Math.max(0, Math.round(((tx - lastSample.tx) / elapsedMs) * 1000));
  }
  lastSample = { at: now, usageUsec, rx, tx };

  const ramUsedMb = Math.round(tree.rssBytes / 1048576);
  const running = Array.from(apps.values()).filter((item) => item.state === "running" || item.state === "starting").length;

  return {
    server: SERVER_NAME,
    at: new Date(now).toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    hostUptimeSeconds: Math.round(os.uptime()),
    cpuPercent,
    cpuCores: os.cpus().length,
    cpuQuotaCores: Number(quota.toFixed(2)),
    loadAverage: os.loadavg().map((value) => Number(value.toFixed(2))),
    ramUsedMb,
    ramLimitMb,
    ramTotalMb: ramLimitMb,
    ramPercent: ramLimitMb ? Number(((ramUsedMb / ramLimitMb) * 100).toFixed(1)) : 0,
    memorySource: "process-tree",
    disk: await diskUsage(),
    network: { rxBytes: rx, txBytes: tx, rxPerSec: netRxPerSec, txPerSec: netTxPerSec },
    processes: tree.processes,
    runtime: "node " + process.version,
    appsRunning: running,
    apps: Array.from(apps.values()).map((item) => ({
      slug: item.slug,
      state: item.state,
      port: item.port,
      projectType: item.projectType,
      restarts: item.restarts,
      startedAt: item.startedAt ? new Date(item.startedAt).toISOString() : null,
      lastError: item.lastError,
    })),
    maxApps: MAX_APPS,
  };
}

async function diskUsage() {
  return new Promise((resolve) => {
    execFile("df", ["-k", APPS_ROOT], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve({ totalMb: 0, usedMb: 0, freeMb: 0, percent: 0 });
      const lines = String(stdout).trim().split("\n");
      const cols = (lines[1] || "").trim().split(/\s+/);
      const totalKb = Number(cols[1] || 0);
      const usedKb = Number(cols[2] || 0);
      const freeKb = Number(cols[3] || 0);
      resolve({
        totalMb: Math.round(totalKb / 1024),
        usedMb: Math.round(usedKb / 1024),
        freeMb: Math.round(freeKb / 1024),
        percent: totalKb > 0 ? Number(((usedKb / totalKb) * 100).toFixed(1)) : 0,
      });
    });
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function proxyToApp(req, res, item, subPath) {
  if (!item || !item.port) {
    json(res, 503, { error: "This app is not running on the server.", state: item ? item.state : "missing" });
    return;
  }
  const target = `http://127.0.0.1:${item.port}${subPath}`;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req, 25 * 1024 * 1024).catch(() => null);
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: body && body.length > 0 ? body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
    });
    const outHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (["content-encoding", "transfer-encoding", "connection", "content-length"].includes(key)) return;
      outHeaders[key] = value;
    });
    const cookies = typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
    if (cookies.length > 0) outHeaders["set-cookie"] = cookies;
    res.writeHead(upstream.status, outHeaders);
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.end(buffer);
  } catch (error) {
    json(res, 502, { error: "The app did not answer.", detail: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/health") {
    return json(res, 200, { ok: true, server: SERVER_NAME, at: new Date().toISOString() });
  }

  const token = req.headers["x-fleet-token"];
  const provided = Array.isArray(token) ? token[0] : token;
  if (TOKEN && provided !== TOKEN) {
    return json(res, 401, { error: "Unauthorized." });
  }

  if (pathname === "/metrics") {
    return json(res, 200, await metrics());
  }

  if (pathname === "/apps" && req.method === "GET") {
    return json(res, 200, {
      server: SERVER_NAME,
      apps: Array.from(apps.values()).map((item) => ({
        slug: item.slug,
        state: item.state,
        port: item.port,
        projectType: item.projectType,
        restarts: item.restarts,
        lastError: item.lastError,
        logs: item.logs.slice(-60),
      })),
      maxApps: MAX_APPS,
      startedAt: new Date(startedAt).toISOString(),
    });
  }

  const deployMatch = pathname.match(/^\/apps\/([a-z0-9-]{1,60})$/);
  if (deployMatch && req.method === "POST") {
    const slug = deployMatch[1].toLowerCase();
    if (!apps.has(slug) && apps.size >= MAX_APPS) {
      return json(res, 409, { error: "This server is full.", maxApps: MAX_APPS });
    }
    const config = JSON.parse(req.headers["x-fleet-config"] ? Buffer.from(String(req.headers["x-fleet-config"]), "base64").toString("utf8") : "{}");
    let buffer;
    try {
      buffer = await readBody(req, MAX_UPLOAD_BYTES);
    } catch {
      return json(res, 413, { error: "The project is larger than the upload limit." });
    }
    const existing = entry(slug);
    if (existing) {
      await stopEntry(existing);
      apps.delete(slug);
    }
    const item = newEntry(slug);
    apps.set(slug, item);
    await stopEntry(item);
    const okExtract = await extractArchive(buffer, item.dir);
    if (!okExtract) {
      item.state = "crashed";
      item.lastError = "The uploaded archive could not be extracted.";
      return json(res, 500, { error: item.lastError });
    }
    pushLog(item, `Project uploaded (${Math.round(buffer.length / 1024)} KB)`, "system");
    const result = await startEntry(item, config);
    return json(res, 200, { server: SERVER_NAME, slug, ...result, logs: item.logs.slice(-80) });
  }

  const actionMatch = pathname.match(/^\/apps\/([a-z0-9-]{1,60})\/(start|stop|restart|delete|logs)$/);
  if (actionMatch) {
    const slug = actionMatch[1].toLowerCase();
    const action = actionMatch[2];
    const item = entry(slug);
    if (action === "logs") {
      if (!item) return json(res, 404, { error: "This app is not on this server." });
      return json(res, 200, { slug, state: item.state, port: item.port, logs: item.logs.slice(-LOG_LIMIT) });
    }
    if (!item) return json(res, 404, { error: "This app is not on this server." });
    if (action === "delete") {
      await stopEntry(item);
      apps.delete(slug);
      await fsp.rm(item.dir, { recursive: true, force: true }).catch(() => undefined);
      return json(res, 200, { slug, deleted: true });
    }
    if (action === "stop") {
      await stopEntry(item);
      return json(res, 200, { slug, state: item.state });
    }
    if (action === "restart") {
      await stopEntry(item);
      const result = await startEntry(item, {});
      return json(res, 200, { slug, ...result });
    }
    const config = JSON.parse(req.headers["x-fleet-config"] ? Buffer.from(String(req.headers["x-fleet-config"]), "base64").toString("utf8") : "{}");
    const result = await startEntry(item, config);
    return json(res, 200, { slug, ...result });
  }

  const proxyMatch = pathname.match(/^\/s\/([a-z0-9-]{1,60})(\/.*)?$/);
  if (proxyMatch) {
    const item = entry(proxyMatch[1]);
    return proxyToApp(req, res, item, `${proxyMatch[2] || "/"}${url.search}`);
  }

  json(res, 404, { error: "Not found.", server: SERVER_NAME });
});

fsp.mkdir(APPS_ROOT, { recursive: true }).catch(() => undefined);
server.listen(PORT, "0.0.0.0", () => {
  log(`fleet agent ready on port ${PORT} (max apps ${MAX_APPS})`);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const item of apps.values()) {
    if (item.child) {
      try {
        process.kill(-item.child.pid, "SIGTERM");
      } catch {
        void 0;
      }
    }
  }
  setTimeout(() => process.exit(0), 1500);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
