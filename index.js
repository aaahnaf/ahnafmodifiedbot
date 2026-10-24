"use strict";

const { addLog, getLogs } = require("./logger");
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");

// ============================================================
// EXPRESS SERVER - Keep Render/Aternos alive
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

// Bot state tracking
let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false,
};

// Health check endpoint for monitoring
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} Dashboard</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }

          body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 24px;
          }

          main { width: 100%; max-width: 400px; }

          header { margin-bottom: 28px; }
          header h1 {
            font-size: 26px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
            line-height: 1.2;
          }
          header p {
            font-size: 14px;
            color: #8b949e;
            margin: 6px 0 0;
            line-height: 1.5;
          }

          .status-section {
            border-radius: 12px;
            padding: 20px 24px;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 16px;
            transition: background 0.3s, border-color 0.3s;
          }
          .status-section.online  { background: #0d2218; border: 2px solid #238636; }
          .status-section.offline { background: #200d0d; border: 2px solid #da3633; }

          .status-icon {
            width: 44px; height: 44px;
            border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 20px; flex-shrink: 0;
            transition: background 0.3s;
          }
          .status-icon.online  { background: #238636; }
          .status-icon.offline { background: #da3633; }

          .status-label { font-size: 18px; font-weight: 700; line-height: 1.2; transition: color 0.3s; }
          .status-label.online  { color: #3fb950; }
          .status-label.offline { color: #f85149; }
          .status-detail { font-size: 13px; color: #8b949e; margin-top: 3px; }

          dl { margin: 0; }
          .stat-card {
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 10px;
            padding: 16px 20px;
            margin-bottom: 10px;
          }
          dt { font-size: 12px; color: #8b949e; font-weight: 600; margin-bottom: 4px; }
          dd { margin: 0; font-size: 17px; font-weight: 600; color: #e6edf3; line-height: 1.3; }
          .stat-detail { margin: 4px 0 0; font-size: 11px; color: #6e7681; }

          .controls { margin-top: 8px; }
          .btn-grid { display: grid; gap: 10px; margin-bottom: 10px; }
          .btn-grid-2 { grid-template-columns: 1fr 1fr; }

          .btn-primary {
            min-height: 52px; border-radius: 10px;
            font-size: 15px; font-weight: 700;
            cursor: pointer; letter-spacing: 0.3px;
            transition: opacity 0.2s, filter 0.2s;
            font-family: inherit;
          }
          .btn-primary:hover  { filter: brightness(1.1); }
          .btn-primary:active { opacity: 0.85; }
          .btn-start { border: 2px solid #238636; background: #0d2218; color: #3fb950; }
          .btn-stop  { border: 2px solid #da3633; background: #200d0d; color: #f85149; }

          .btn-secondary {
            min-height: 44px; border-radius: 10px;
            border: 1px solid #21262d; background: #161b22; color: #8b949e;
            font-size: 13px; font-weight: 500;
            text-decoration: none;
            display: flex; align-items: center; justify-content: center;
            font-family: inherit; cursor: pointer;
            transition: background 0.2s, color 0.2s;
          }
          .btn-secondary:hover { background: #21262d; color: #c9d1d9; }

          footer { margin-top: 20px; text-align: center; }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main role="main" aria-label="AFK Bot Dashboard">

          <header>
            <h1>AFK Bot Dashboard</h1>
            <p>Minecraft server bot &middot; Live status</p>
          </header>

          <section
            id="status-section"
            role="status"
            aria-live="polite"
            aria-label="Bot connection status"
            class="status-section offline"
          >
            <div id="status-icon" aria-hidden="true" class="status-icon offline">&#x2717;</div>
            <div>
              <div id="status-label" class="status-label offline">Connecting…</div>
              <div id="status-detail" class="status-detail">Establishing connection</div>
            </div>
          </section>

          <section aria-label="Bot statistics">
            <dl>
              <div class="stat-card">
                <dt>Uptime</dt>
                <dd id="uptime-text">—</dd>
                <p class="stat-detail">Time since last connection</p>
              </div>
              <div class="stat-card">
                <dt>Coordinates</dt>
                <dd id="coords-text">Searching…</dd>
                <p class="stat-detail">Bot's current in-game position</p>
              </div>
              <div class="stat-card">
                <dt>Server address</dt>
                <dd>${config.server.ip}</dd>
                <p class="stat-detail">Minecraft server hostname</p>
              </div>
            </dl>
          </section>

          <section class="controls" aria-label="Bot controls">
            <div class="btn-grid btn-grid-2">
              <button class="btn-primary btn-start" onclick="startBot()" aria-label="Start bot">Start bot</button>
              <button class="btn-primary btn-stop" onclick="stopBot()" aria-label="Stop bot">Stop bot</button>
            </div>
            <div class="btn-grid btn-grid-2">
              <a href="/tutorial" class="btn-secondary" aria-label="View setup guide">Setup guide</a>
              <a href="/logs" class="btn-secondary" aria-label="View bot logs">View logs</a>
            </div>
          </section>

          <footer>
            <p>Status updates every 5 seconds</p>
          </footer>

        </main>

        <script>
          function formatUptime(s) {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = s % 60;
            if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
            if (m > 0) return m + 'm ' + sec + 's';
            return sec + ' seconds';
          }

          async function update() {
            try {
              const r = await fetch('/health');
              const data = await r.json();
              const online = data.status === 'connected';

              const section = document.getElementById('status-section');
              const icon    = document.getElementById('status-icon');
              const label   = document.getElementById('status-label');
              const detail  = document.getElementById('status-detail');

              section.className = 'status-section ' + (online ? 'online' : 'offline');
              icon.className    = 'status-icon '    + (online ? 'online' : 'offline');
              icon.textContent  = online ? '✓' : '✗';
              label.className   = 'status-label '   + (online ? 'online' : 'offline');
              label.textContent = online ? 'Connected' : 'Disconnected';
              detail.textContent = online ? 'Bot is active on the server' : 'Attempting to reconnect';

              document.getElementById('uptime-text').textContent = formatUptime(data.uptime);

              if (data.coords) {
                const x = Math.floor(data.coords.x);
                const y = Math.floor(data.coords.y);
                const z = Math.floor(data.coords.z);
                document.getElementById('coords-text').textContent = 'X ' + x + ', Y ' + y + ', Z ' + z;
              } else {
                document.getElementById('coords-text').textContent = 'Searching…';
              }
            } catch (e) {
              const label = document.getElementById('status-label');
              label.className = 'status-label offline';
              label.textContent = 'Unreachable';
            }
          }

          async function startBot() {
            const r = await fetch('/start', { method: 'POST' });
            const data = await r.json();
            alert(data.success ? 'Bot started!' : data.msg);
            update();
          }

          async function stopBot() {
            const r = await fetch('/stop', { method: 'POST' });
            const data = await r.json();
            alert(data.success ? 'Bot stopped!' : data.msg);
            update();
          }

          setInterval(update, 5000);
          update();
        </script>
      </body>
    </html>
  `);
});
app.get("/tutorial", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} - Setup Guide</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }

          body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            margin: 0;
            padding: 40px 24px;
          }

          main {
            width: 100%;
            max-width: 560px;
            margin: 0 auto;
          }

          .back-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            font-weight: 500;
            color: #8b949e;
            text-decoration: none;
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 8px;
            padding: 7px 14px;
            margin-bottom: 32px;
            transition: color 0.2s, background 0.2s;
          }
          .back-btn:hover { background: #21262d; color: #c9d1d9; }

          header { margin-bottom: 32px; }
          header h1 {
            font-size: 26px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
            line-height: 1.2;
          }
          header p {
            font-size: 14px;
            color: #8b949e;
            margin: 6px 0 0;
            line-height: 1.5;
          }

          .step-card {
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 16px;
          }

          .step-header {
            display: flex;
            align-items: center;
            gap: 14px;
            margin-bottom: 18px;
          }

          .step-number {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: #0d2218;
            border: 2px solid #238636;
            color: #3fb950;
            font-size: 14px;
            font-weight: 700;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
          }

          .step-title {
            font-size: 16px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
          }

          ol {
            margin: 0;
            padding: 0;
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 10px;
          }

          li {
            font-size: 14px;
            color: #8b949e;
            line-height: 1.6;
            padding-left: 20px;
            position: relative;
          }

          li::before {
            content: "·";
            position: absolute;
            left: 6px;
            color: #3fb950;
            font-weight: 700;
          }

          li strong { color: #e6edf3; font-weight: 600; }

          code {
            background: #21262d;
            border: 1px solid #30363d;
            padding: 2px 7px;
            border-radius: 5px;
            font-family: 'SF Mono', 'Fira Code', monospace;
            font-size: 12px;
            color: #e6edf3;
          }

          a { color: #58a6ff; text-decoration: none; }
          a:hover { text-decoration: underline; }

          footer {
            margin-top: 32px;
            text-align: center;
          }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main>
          <a href="/" class="back-btn">&#8592; Back to Dashboard</a>

          <header>
            <h1>Setup Guide</h1>
            <p>Get your AFK bot running in under 15 minutes</p>
          </header>

          <div class="step-card">
            <div class="step-header">
              <div class="step-number">1</div>
              <h2 class="step-title">Configure Aternos</h2>
            </div>
            <ol>
              <li>Go to <strong>Aternos</strong> and open your server.</li>
              <li>Install <strong>Paper/Bukkit</strong> as your server software.</li>
              <li>Enable <strong>Cracked</strong> mode using the green switch.</li>
              <li>Install these plugins: <code>ViaVersion</code>, <code>ViaBackwards</code>, <code>ViaRewind</code></li>
            </ol>
          </div>

          <div class="step-card">
            <div class="step-header">
              <div class="step-number">2</div>
              <h2 class="step-title">GitHub Setup</h2>
            </div>
            <ol>
              <li>Download this project as a ZIP and extract it.</li>
              <li>Edit <code>settings.json</code> with your server IP and port.</li>
              <li>Upload all files to a new <strong>GitHub Repository</strong>.</li>
            </ol>
          </div>

          <div class="step-card">
            <div class="step-header">
              <div class="step-number">3</div>
              <h2 class="step-title">Deploy on Replit (Free 24/7)</h2>
            </div>
            <ol>
              <li>Import your GitHub repo into <strong>Replit</strong>.</li>
              <li>Set the run command to <code>npm start</code>.</li>
              <li>Hit <strong>Run</strong> — the bot connects automatically.</li>
              <li>The bot pings itself every 10 minutes to stay alive.</li>
            </ol>
          </div>

          <footer>
            <p>AFK Bot Dashboard &middot; ${config.name}</p>
          </footer>
        </main>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    status: botState.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot && bot.entity ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
  });
});

app.get("/ping", (req, res) => res.send("pong"));

app.get("/logs", (req, res) => {
  const logs = getLogs();

  const escapeHTML = (str) =>
    str.replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[m],
    );

  const logCount = logs.length;

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} - Logs</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }

          body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            margin: 0;
            padding: 40px 24px;
          }

          main {
            width: 100%;
            max-width: 760px;
            margin: 0 auto;
          }

          .back-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            font-weight: 500;
            color: #8b949e;
            text-decoration: none;
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 8px;
            padding: 7px 14px;
            margin-bottom: 32px;
            transition: color 0.2s, background 0.2s;
          }
          .back-btn:hover { background: #21262d; color: #c9d1d9; }

          .page-header {
            display: flex;
            align-items: flex-end;
            justify-content: space-between;
            margin-bottom: 20px;
            gap: 12px;
            flex-wrap: wrap;
          }

          .page-header-left h1 {
            font-size: 26px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
            line-height: 1.2;
          }
          .page-header-left p {
            font-size: 14px;
            color: #8b949e;
            margin: 6px 0 0;
          }

          .badge {
            font-size: 12px;
            font-weight: 600;
            color: #8b949e;
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 20px;
            padding: 4px 12px;
            white-space: nowrap;
          }

          .log-card {
            background: #0d1117;
            border: 1px solid #21262d;
            border-radius: 12px;
            overflow: hidden;
          }

          .log-card-header {
            background: #161b22;
            border-bottom: 1px solid #21262d;
            padding: 12px 18px;
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .dot { width: 10px; height: 10px; border-radius: 50%; }
          .dot-red   { background: #ff5f57; }
          .dot-yellow{ background: #ffbd2e; }
          .dot-green { background: #28c840; }

          .log-card-title {
            font-size: 12px;
            font-weight: 500;
            color: #484f58;
            margin-left: 4px;
          }

          .log-body {
            padding: 16px 18px;
            max-height: 560px;
            overflow-y: auto;
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 12.5px;
            line-height: 1.7;
          }

          .log-entry { display: block; padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
          .log-entry.error   { color: #ff7b72; }
          .log-entry.warn    { color: #e3b341; }
          .log-entry.success { color: #3fb950; }
          .log-entry.control { color: #58a6ff; }
          .log-entry.default { color: #8b949e; }

          .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: #484f58;
            font-size: 13px;
          }

          .refresh-bar {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 6px;
            margin-top: 12px;
            font-size: 12px;
            color: #484f58;
          }
          .refresh-dot {
            width: 7px; height: 7px;
            border-radius: 50%;
            background: #3fb950;
            animation: pulse 2s infinite;
          }
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
          }

          .console-row {
            display: flex;
            align-items: center;
            border-top: 1px solid #21262d;
            background: #0d1117;
            padding: 10px 18px;
            gap: 10px;
          }

          .console-prompt {
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 13px;
            color: #3fb950;
            font-weight: 700;
            flex-shrink: 0;
            user-select: none;
          }

          .console-input {
            flex: 1;
            background: transparent;
            border: none;
            outline: none;
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 12.5px;
            color: #e6edf3;
            caret-color: #3fb950;
          }

          .console-input::placeholder { color: #484f58; }

          .console-send {
            background: #0d2218;
            border: 1px solid #238636;
            color: #3fb950;
            font-size: 12px;
            font-weight: 600;
            padding: 5px 14px;
            border-radius: 6px;
            cursor: pointer;
            font-family: inherit;
            transition: background 0.2s;
            flex-shrink: 0;
          }
          .console-send:hover { background: #122d1a; }
          .console-send:disabled { opacity: 0.5; cursor: default; }

          .console-wrap {
            position: relative;
          }

          .cmd-suggestions {
            display: none;
            position: absolute;
            bottom: calc(100% + 6px);
            left: 0; right: 0;
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            z-index: 10;
          }

          .cmd-suggestions.visible { display: block; }

          .cmd-item {
            display: flex;
            align-items: baseline;
            gap: 12px;
            padding: 9px 16px;
            cursor: pointer;
            transition: background 0.12s;
            border-bottom: 1px solid #21262d;
          }
          .cmd-item:last-child { border-bottom: none; }
          .cmd-item:hover, .cmd-item.active {
            background: #21262d;
          }

          .cmd-name {
            font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
            font-size: 12.5px;
            font-weight: 700;
            color: #3fb950;
            flex-shrink: 0;
            min-width: 90px;
          }

          .cmd-desc {
            font-size: 12px;
            color: #6e7681;
          }

          footer { margin-top: 32px; text-align: center; }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main>
          <a href="/" class="back-btn">&#8592; Back to Dashboard</a>

          <div class="page-header">
            <div class="page-header-left">
              <h1>Bot Logs</h1>
              <p>Live output from the AFK bot</p>
            </div>
            <span class="badge">${logCount} ${logCount === 1 ? "entry" : "entries"}</span>
          </div>

          <div class="log-card">
            <div class="log-card-header">
              <span class="dot dot-red"></span>
              <span class="dot dot-yellow"></span>
              <span class="dot dot-green"></span>
              <span class="log-card-title">bot.log</span>
            </div>
            <div class="log-body" id="log-body">
              ${logCount === 0
                ? `<div class="empty-state">No log entries yet. Start the bot to see output.</div>`
                : logs.map((l) => {
                    const escaped = escapeHTML(l);
                    const lower = l.toLowerCase();
                    let cls = "default";
                    if (lower.includes("error") || lower.includes("fail")) cls = "error";
                    else if (lower.includes("warn")) cls = "warn";
                    else if (lower.includes("[control]")) cls = "control";
                    else if (lower.includes("connect") || lower.includes("join") || lower.includes("spawn")) cls = "success";
                    return `<span class="log-entry ${cls}">${escaped}</span>`;
                  }).join("")
              }
            </div>
            <div class="console-wrap">
              <div class="cmd-suggestions" id="cmd-suggestions"></div>
              <div class="console-row">
                <span class="console-prompt">&gt;</span>
                <input
                  id="console-input"
                  class="console-input"
                  type="text"
                  placeholder="Type / for commands, or any message…"
                  autocomplete="off"
                  spellcheck="false"
                >
                <button id="console-send" class="console-send">Send</button>
              </div>
            </div>
          </div>

          <div class="refresh-bar">
            <span class="refresh-dot"></span>
            <span id="refresh-label">Auto-refreshing every 5 seconds</span>
          </div>

          <footer>
            <p>AFK Bot Dashboard &middot; ${config.name}</p>
          </footer>
        </main>

        <script>
          (function() {
            var logBody  = document.getElementById('log-body');
            var input    = document.getElementById('console-input');
            var sendBtn  = document.getElementById('console-send');
            var label    = document.getElementById('refresh-label');
            var sugBox   = document.getElementById('cmd-suggestions');
            var refreshTimer = null;
            var typing = false;
            var activeIdx = -1;

            var COMMANDS = [
              { name: '/help',   desc: 'Show all available commands' },
              { name: '/pos',    desc: "Show bot's current coordinates" },
              { name: '/status', desc: 'Show connection status & uptime' },
              { name: '/list',   desc: 'List players on the server' },
              { name: '/say',    desc: 'Send a chat message in-game' },
            ];

            function scrollBottom() {
              if (logBody) logBody.scrollTop = logBody.scrollHeight;
            }

            function scheduleRefresh() {
              clearTimeout(refreshTimer);
              if (!typing) {
                refreshTimer = setTimeout(function() { location.reload(); }, 5000);
              }
            }

            function appendLocalEntry(text, cls) {
              var span = document.createElement('span');
              span.className = 'log-entry ' + (cls || 'control');
              span.textContent = text;
              logBody.appendChild(span);
              scrollBottom();
            }

            function hideSuggestions() {
              sugBox.classList.remove('visible');
              sugBox.innerHTML = '';
              activeIdx = -1;
            }

            function setActive(idx) {
              var items = sugBox.querySelectorAll('.cmd-item');
              items.forEach(function(el, i) {
                el.classList.toggle('active', i === idx);
              });
              activeIdx = idx;
            }

            function showSuggestions(val) {
              var query = val.toLowerCase();
              var matches = COMMANDS.filter(function(c) {
                return c.name.startsWith(query);
              });

              if (!matches.length) { hideSuggestions(); return; }

              sugBox.innerHTML = matches.map(function(c, i) {
                return '<div class="cmd-item" data-cmd="' + c.name + '">' +
                  '<span class="cmd-name">' + c.name + '</span>' +
                  '<span class="cmd-desc">' + c.desc + '</span>' +
                '</div>';
              }).join('');

              sugBox.querySelectorAll('.cmd-item').forEach(function(el) {
                el.addEventListener('mousedown', function(e) {
                  e.preventDefault();
                  input.value = el.dataset.cmd + ' ';
                  hideSuggestions();
                  input.focus();
                });
              });

              activeIdx = -1;
              sugBox.classList.add('visible');
            }

            input.addEventListener('input', function() {
              var val = input.value;
              if (val.startsWith('/')) {
                showSuggestions(val);
              } else {
                hideSuggestions();
              }
            });

            input.addEventListener('keydown', function(e) {
              var items = sugBox.querySelectorAll('.cmd-item');
              if (sugBox.classList.contains('visible') && items.length) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive(Math.min(activeIdx + 1, items.length - 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive(Math.max(activeIdx - 1, 0));
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && activeIdx >= 0)) {
                  e.preventDefault();
                  var chosen = items[activeIdx >= 0 ? activeIdx : 0];
                  input.value = chosen.dataset.cmd + ' ';
                  hideSuggestions();
                  return;
                }
                if (e.key === 'Escape') {
                  hideSuggestions();
                  return;
                }
              }
              if (e.key === 'Enter') sendCommand();
            });

            function sendCommand() {
              var cmd = input.value.trim();
              if (!cmd) return;
              hideSuggestions();
              input.value = '';
              sendBtn.disabled = true;
              appendLocalEntry('> ' + cmd, 'control');

              fetch('/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: cmd })
              })
              .then(function(r) { return r.json(); })
              .then(function(data) {
                if (data.msg) {
                  data.msg.split('\\n').forEach(function(line) {
                    appendLocalEntry(line, data.success ? 'default' : 'error');
                  });
                }
              })
              .catch(function() {
                appendLocalEntry('Failed to send command.', 'error');
              })
              .finally(function() {
                sendBtn.disabled = false;
                input.focus();
                scheduleRefresh();
              });
            }

            sendBtn.addEventListener('click', sendCommand);

            input.addEventListener('focus', function() {
              typing = true;
              clearTimeout(refreshTimer);
              label.textContent = 'Auto-refresh paused while typing';
            });
            input.addEventListener('blur', function() {
              setTimeout(function() {
                hideSuggestions();
                typing = false;
                label.textContent = 'Auto-refreshing every 5 seconds';
                scheduleRefresh();
              }, 150);
            });

            scrollBottom();
            scheduleRefresh();
          })();
        </script>
      </body>
    </html>
  `);
});

let botRunning = true;

app.post("/start", (req, res) => {
  if (botRunning) return res.json({ success: false, msg: "Already running" });

  botRunning = true;
  createBot();
  addLog("[Control] Bot started");

  res.json({ success: true });
});

app.post("/stop", (req, res) => {
  if (!botRunning) return res.json({ success: false, msg: "Already stopped" });

  botRunning = false;

  if (bot) {
    bot.end();
    bot = null;
  }

  clearAllIntervals();
  addLog("[Control] Bot stopped");

  res.json({ success: true });
});

app.post("/command", express.json(), (req, res) => {
  const cmd = (req.body.command || "").trim();
  if (!cmd) return res.json({ success: false, msg: "Empty command." });

  addLog(`[Console] > ${cmd}`);

  if (cmd === "/help") {
    const lines = [
      "Available commands:",
      "  /help          - Show this help message",
      "  /pos           - Show bot's current coordinates",
      "  /status        - Show bot connection status",
      "  /list          - Ask server for player list",
      "  /say <message> - Send a chat message in-game",
      "  /<anything>    - Send any Minecraft command directly",
      "  <text>         - Send plain chat (no slash needed)",
    ];
    lines.forEach((l) => addLog(`[Console] ${l}`));
    return res.json({ success: true, msg: lines.join("\n") });
  }

  if (cmd === "/pos" || cmd === "/coords") {
    const pos = bot && bot.entity ? bot.entity.position : null;
    const msg = pos
      ? `Position: X=${Math.floor(pos.x)}  Y=${Math.floor(pos.y)}  Z=${Math.floor(pos.z)}`
      : "Position unavailable (bot not spawned).";
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (cmd === "/status") {
    const status = botState.connected ? "Connected" : "Disconnected";
    const uptime = Math.floor((Date.now() - botState.startTime) / 1000);
    const msg = `Status: ${status} | Uptime: ${uptime}s | Reconnects: ${botState.reconnectAttempts}`;
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (!bot || typeof bot.chat !== "function") {
    const msg = bot
      ? "Bot is still connecting — try again in a moment."
      : "Bot is not running.";
    addLog(`[Console] ${msg}`);
    return res.json({ success: false, msg });
  }

  try {
    bot.chat(cmd);
    addLog(`[Console] Sent to server: ${cmd}`);
    return res.json({ success: true, msg: `Sent: ${cmd}` });
  } catch (err) {
    addLog(`[Console] Error: ${err.message}`);
    return res.json({ success: false, msg: err.message });
  }
});

// ============================================================
//                    END OF WEB TOOLS
//============================================================

// FIX: handle port conflict gracefully - try next port if taken
const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] HTTP server started on port ${server.address().port} `);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const fallbackPort = PORT + 1;
    addLog(`[Server] Port ${PORT} in use - trying port ${fallbackPort} `);
    server.listen(fallbackPort, "0.0.0.0");
  } else {
    addLog(`[Server] HTTP server error: ${err.message} `);
  }
});

// FIX: only one definition of formatUptime
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s} s`;
}

// ============================================================
// SELF-PING - Prevent Render from sleeping
// FIX: only ping if RENDER_EXTERNAL_URL is set (skip useless localhost ping)
// ============================================================
const SELF_PING_INTERVAL = 10 * 60 * 1000;

function startSelfPing() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (!renderUrl) {
    addLog(
      "[KeepAlive] No RENDER_EXTERNAL_URL set - self-ping disabled (running locally)",
    );
    return;
  }
  setInterval(() => {
    const protocol = renderUrl.startsWith("https") ? https : http;
    protocol
      .get(`${renderUrl}/ping`, (res) => {
        // Silent success
      })
      .on("error", (err) => {
        addLog(`[KeepAlive] Self-ping failed: ${err.message}`);
      });
  }, SELF_PING_INTERVAL);
  addLog("[KeepAlive] Self-ping system started (every 10 min)");
}

startSelfPing();

// ============================================================
// MEMORY MONITORING
// ============================================================
setInterval(
  () => {
    const mem = process.memoryUsage();
    const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
    addLog(`[Memory] Heap: ${heapMB} MB`);
  },
  5 * 60 * 1000,
);

// ============================================================
// BOT CREATION VIA THE AUTHORITATIVE CONNECTION MANAGER
// ============================================================
// All connection lifecycle logic (create / retry / backoff / watchdogs /
// stale-event protection) lives in connectionManager.js. index.js only:
//   1. builds each fresh bot instance (buildBot), and
//   2. wires manager events into the dashboard, modules and Discord alerts.
// ============================================================
let bot = null; // always === manager.bot for the CURRENT generation
let activeIntervals = [];

// FIX: Discord rate limiting - track last send time
let lastDiscordSend = 0;
const DISCORD_RATE_LIMIT_MS = 5000; // min 5s between webhook calls

function clearAllIntervals() {
  if (activeIntervals.length) {
    addLog(`[Cleanup] Clearing ${activeIntervals.length} intervals`);
  }
  activeIntervals.forEach((id) => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(() => {
    // Guard: never run module callbacks against a stale/disconnected bot.
    if (!bot || !botState.connected) return;
    try {
      callback();
    } catch (e) {
      addLog(`[Interval] Error: ${e.message}`);
    }
  }, delay);
  activeIntervals.push(id);
  return id;
}

// ---- build ONE fresh bot instance per connection attempt (called by manager) ----
function buildBot() {
  addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  // Version: respect explicit user configuration; empty string => auto-detect.
  const botVersion =
    config.server.version && String(config.server.version).trim() !== ""
      ? String(config.server.version).trim()
      : false;

  const newBot = mineflayer.createBot({
    username: config["bot-account"].username,
    // Never log the password. It is only forwarded for 'microsoft'/'mojang' auth.
    password: config["bot-account"].password || undefined,
    auth: config["bot-account"].type || "offline",
    host: config.server.ip,
    port: Number(config.server.port) || 25565,
    version: botVersion,
    hideErrors: true, // we handle every error ourselves through the manager
    checkTimeoutInterval: 60000, // keepalive watchdog (protocol level)
    keepAlive: true,
  });

  newBot.loadPlugin(pathfinder);
  return newBot;
}

// ---- per-generation setup done when the manager confirms a stable session ----
function onStableConnection(b) {
  addLog(
    `[Bot] [+] Connection stable! (Version: ${b.version}, gen ${manager.generation})`,
  );
}

// ---- the single authoritative connection manager ----
const { ConnectionManager, STATES } = require("./connectionManager");
const manager = new ConnectionManager({
  createFn: buildBot,
  log: (level, msg) => addLog(msg, level === "error" ? "error" : undefined),
  retry: {
    baseDelayMs: config.utils["auto-reconnect-delay"] || 3000,
    maxDelayMs: config.utils["max-reconnect-delay"] || 60000,
    minDelayMs: config.utils["min-reconnect-delay"] || 2000,
    jitterRatio: config.utils["reconnect-jitter-ratio"],
    throttlePenaltyMs: config.utils["throttle-penalty-delay"] || 60000,
    connectTimeoutMs: config.utils["connection-timeout"] || 150000,
    stableAfterMs: config.utils["stable-after"] || 30000,
  },
  hooks: {
    onStateChange: (state) => {
      botState.state = state;
      botState.connected = state === STATES.ONLINE;
      if (state === STATES.ONLINE) {
        botState.lastActivity = Date.now();
      }
    },
    onConnected: (b) => {
      // Called on spawn of the CURRENT generation only. Safe place to init modules.
      bot = b;
      botState.startTime = Date.now(); // session uptime starts at spawn
      addLog(
        `[Bot] [+] Successfully spawned on server! (Version: ${b.version})`,
      );

      const mcData = require("minecraft-data")(b.version);
      const defaultMove = new Movements(b, mcData);
      defaultMove.allowFreeMotion = false;
      defaultMove.canDig = false;
      defaultMove.liquidCost = 1000;
      defaultMove.fallDamageCost = 1000;

      initializeModules(b, mcData, defaultMove);

      // Attempt creative mode (only works if bot has OP and enabled in settings)
      setTimeout(() => {
        if (manager.bot === b && botState.connected && config.server["try-creative"]) {
          try {
            b.chat("/gamemode creative");
            addLog("[INFO] Attempted to set creative mode (requires OP)");
          } catch (e) {
            addLog(`[INFO] Creative attempt failed: ${e.message}`);
          }
        }
      }, 3000);

      b.on("messagestr", (message) => {
        if (
          message.includes("commands.gamemode.success.self") ||
          message.includes("Set own game mode to Creative Mode")
        ) {
          addLog("[INFO] Bot is now in Creative Mode.");
        }
      });

      if (
        config.discord &&
        config.discord.enabled &&
        config.discord.events &&
        config.discord.events.connect
      ) {
        sendDiscordWebhook(`[+] **Connected** to \`${config.server.ip}\``, 0x4ade80);
      }
    },
    onStable: (b) => onStableConnection(b),
    onDisconnected: (info) => {
      botState.lastDisconnectReason =
        manager.lastDisconnectReason || info.message || "Unknown reason";
      botState.reconnectAttempts = manager.attempt;
      botState.lastDisconnectTime = manager.lastDisconnectTime;
      botState.startTime = 0; // session uptime restarts on next connect
      clearAllIntervals();
      bot = null;

      if (
        config.discord &&
        config.discord.enabled &&
        config.discord.events &&
        config.discord.events.disconnect
      ) {
        const label =
          info.type === "kicked"
            ? `[!] **Kicked**: ${info.message}`
            : `[-] **Disconnected**: ${info.message || "Unknown"} (${info.category || "unknown"})`;
        sendDiscordWebhook(label, 0xf87171);
      }
    },
    onGiveUp: (info) => {
      addLog(
        `[Bot] Giving up fast retries after repeated "${info.category}" failures - check settings/server. Still retrying slowly.`,
        "error",
      );
    },
  },
});

// ============================================================
// ERROR HISTORY (bounded) + safe async helper
// ============================================================
const MAX_ERRORS = 100;
botState.errors = []; // bounded: trimmed on push below

function recordError(entry) {
  botState.errors.push({ ...entry, time: entry.time || Date.now() });
  if (botState.errors.length > MAX_ERRORS) {
    botState.errors = botState.errors.slice(-50);
  }
}

// Run an async operation without ever producing an unhandled rejection.
function safeAsync(label, fn) {
  return Promise.resolve()
    .then(fn)
    .catch((e) => {
      const msg = (e && e.message) || String(e);
      addLog(`[${label}] Async error: ${msg}`, "error");
      recordError({ type: label, message: msg });
    });
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================
function initializeModules(currentBot, mcData, defaultMove) {
  addLog("[Modules] Initializing all modules...");
  const gen = manager.generation;
  const isCurrent = () =>
    gen === manager.generation && manager.bot === currentBot && botState.connected;

  // ---------- AUTO AUTH (REACTIVE) ----------
  if (config.utils["auto-auth"] && config.utils["auto-auth"].enabled) {
    const password = config.utils["auto-auth"].password;
    let authHandled = false;

    const tryAuth = (type) => {
      if (authHandled || !isCurrent()) return;
      authHandled = true;
      safeAsync("Auth", () => {
        if (type === "register") {
          currentBot.chat(`/register ${password} ${password}`);
          addLog("[Auth] Detected register prompt - sent /register");
        } else {
          currentBot.chat(`/login ${password}`);
          addLog("[Auth] Detected login prompt - sent /login");
        }
      });
    };

    currentBot.on("messagestr", (message) => {
      if (authHandled || !isCurrent()) return;
      const msg = message.toLowerCase();
      if (
        msg.includes("/register") ||
        msg.includes("register ") ||
        msg.includes("지정된 비밀번호")
      ) {
        tryAuth("register");
      } else if (
        msg.includes("/login") ||
        msg.includes("login ") ||
        msg.includes("로그인")
      ) {
        tryAuth("login");
      }
    });

    // Failsafe: if no prompt after 10s, try login anyway
    setTimeout(() => {
      if (!authHandled && isCurrent()) {
        addLog(
          "[Auth] No prompt detected after 10s, sending /login as failsafe",
        );
        tryAuth("login");
      }
    }, 10000);
  }

  // ---------- CHAT MESSAGES ----------
  if (config.utils["chat-messages"] && config.utils["chat-messages"].enabled) {
    const messages = config.utils["chat-messages"].messages || [];
    if (messages.length === 0) {
      addLog("[ChatMessages] Enabled but no messages configured - skipping", "warn");
    } else if (config.utils["chat-messages"].repeat) {
      let i = 0;
      addInterval(() => {
        safeAsync("ChatMessages", () => {
          currentBot.chat(messages[i]);
          botState.lastActivity = Date.now();
          i = (i + 1) % messages.length;
        });
      }, (config.utils["chat-messages"]["repeat-delay"] || 60) * 1000);
    } else {
      messages.forEach((msg, idx) => {
        setTimeout(() => {
          if (isCurrent()) safeAsync("ChatMessages", () => currentBot.chat(msg));
        }, idx * 1000);
      });
    }
  }

  // ---------- MOVE TO POSITION ----------
  // Only use position goal if circle-walk is NOT enabled (they fight over pathfinder)
  if (
    config.position &&
    config.position.enabled &&
    !(
      config.movement &&
      config.movement["circle-walk"] &&
      config.movement["circle-walk"].enabled
    )
  ) {
    safeAsync("Position", () => {
      currentBot.pathfinder.setMovements(defaultMove);
      currentBot.pathfinder.setGoal(
        new GoalBlock(config.position.x, config.position.y, config.position.z),
      );
      addLog("[Position] Navigating to configured position...");
    });
  }

  // ---------- ANTI-AFK ----------
  // NOTE: these are client-side activity pings only. They cannot bypass a
  // server-side AFK kick policy that ignores such input; if the server still
  // kicks for AFK, that must be fixed server-side (or with real play).
  if (config.utils["anti-afk"] && config.utils["anti-afk"].enabled) {
    // Arm swinging
    addInterval(
      () => {
        try {
          currentBot.swingArm();
        } catch (e) {}
      },
      10000 + Math.floor(Math.random() * 50000),
    );

    // Hotbar cycling
    addInterval(
      () => {
        try {
          const slot = Math.floor(Math.random() * 9);
          currentBot.setQuickBarSlot(slot);
        } catch (e) {}
      },
      30000 + Math.floor(Math.random() * 90000),
    );

    // Teabagging (occasional sneak pulses)
    addInterval(
      () => {
        if (typeof currentBot.setControlState !== "function") return;
        if (Math.random() > 0.9) {
          let count = 2 + Math.floor(Math.random() * 4);
          const doTeabag = () => {
            if (!isCurrent() || count <= 0) return;
            try {
              currentBot.setControlState("sneak", true);
              setTimeout(() => {
                if (isCurrent()) currentBot.setControlState("sneak", false);
                count--;
                setTimeout(doTeabag, 150);
              }, 150);
            } catch (e) {}
          };
          doTeabag();
        }
      },
      120000 + Math.floor(Math.random() * 180000),
    );

    // Micro-walk only when circle-walk is NOT running, to avoid interrupting pathfinder
    if (
      !(
        config.movement &&
        config.movement["circle-walk"] &&
        config.movement["circle-walk"].enabled
      )
    ) {
      addInterval(
        () => {
          if (typeof currentBot.setControlState !== "function") return;
          try {
            const yaw = Math.random() * Math.PI * 2;
            currentBot.look(yaw, 0, true);
            currentBot.setControlState("forward", true);
            setTimeout(
              () => {
                if (isCurrent())
                  currentBot.setControlState("forward", false);
              },
              500 + Math.floor(Math.random() * 1500),
            );
            botState.lastActivity = Date.now();
          } catch (e) {
            addLog(`[AntiAFK] Walk error: ${e.message}`, "warn");
          }
        },
        120000 + Math.floor(Math.random() * 360000),
      );
    }

    if (config.utils["anti-afk"].sneak) {
      try {
        if (typeof currentBot.setControlState === "function")
          currentBot.setControlState("sneak", true);
      } catch (e) {}
    }
  }

  // ---------- MOVEMENT MODULES ----------
  // Top-level movement.enabled flag respected; sub-modules independent.
  if (config.movement && config.movement.enabled !== false) {
    if (
      config.movement["circle-walk"] &&
      config.movement["circle-walk"].enabled
    ) {
      startCircleWalk(currentBot, defaultMove);
    }
    // random-jump skipped while circle-walk runs (both move the bot; avoid fighting)
    if (
      config.movement["random-jump"] &&
      config.movement["random-jump"].enabled &&
      !(
        config.movement["circle-walk"] && config.movement["circle-walk"].enabled
      )
    ) {
      startRandomJump(currentBot);
    }
    if (
      config.movement["look-around"] &&
      config.movement["look-around"].enabled
    ) {
      startLookAround(currentBot);
    }
  }

  // ---------- CUSTOM MODULES ----------
  // avoidMobs and combat both steer/attack - never run them simultaneously
  if (config.modules.avoidMobs && !config.modules.combat) {
    avoidMobs(currentBot);
  }
  if (config.modules.combat) {
    combatModule(currentBot, mcData);
  }
  if (config.modules.beds) {
    bedModule(currentBot, mcData);
  }
  if (config.modules.chat) {
    chatModule(currentBot);
  }

  addLog("[Modules] All modules initialized!");
}

// ============================================================
// MOVEMENT HELPERS
// ============================================================
// All helpers receive the bot instance they belong to and verify it is still
// the CURRENT generation before touching it (stale-callback protection).
// Their intervals are registered through addInterval() so they are cleaned up
// automatically on every disconnect.
function isBotCurrent(b) {
  return b && manager.bot === b && botState.connected;
}

function startCircleWalk(currentBot, defaultMove) {
  const radius = config.movement["circle-walk"].radius;
  let angle = 0;
  let lastPathTime = 0;

  addInterval(() => {
    if (!isBotCurrent(currentBot)) return;
    const now = Date.now();
    if (now - lastPathTime < 2000) return;
    lastPathTime = now;
    try {
      const x = currentBot.entity.position.x + Math.cos(angle) * radius;
      const z = currentBot.entity.position.z + Math.sin(angle) * radius;
      currentBot.pathfinder.setMovements(defaultMove);
      currentBot.pathfinder.setGoal(
        new GoalBlock(
          Math.floor(x),
          Math.floor(currentBot.entity.position.y),
          Math.floor(z),
        ),
      );
      angle += Math.PI / 4;
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog(`[CircleWalk] Error: ${e.message}`, "warn");
    }
  }, config.movement["circle-walk"].speed);
}

function startRandomJump(currentBot) {
  addInterval(() => {
    if (!isBotCurrent(currentBot)) return;
    if (typeof currentBot.setControlState !== "function") return;
    try {
      currentBot.setControlState("jump", true);
      setTimeout(() => {
        if (isBotCurrent(currentBot))
          currentBot.setControlState("jump", false);
      }, 300);
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog(`[RandomJump] Error: ${e.message}`, "warn");
    }
  }, config.movement["random-jump"].interval);
}

function startLookAround(currentBot) {
  addInterval(() => {
    if (!isBotCurrent(currentBot)) return;
    try {
      const yaw = Math.random() * Math.PI * 2 - Math.PI;
      const pitch = (Math.random() * Math.PI) / 2 - Math.PI / 4;
      currentBot.look(yaw, pitch, false);
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog(`[LookAround] Error: ${e.message}`, "warn");
    }
  }, config.movement["look-around"].interval);
}

// ============================================================
// CUSTOM MODULES
// ============================================================

// Avoid mobs/players
// e.username only exists on players; e.name is used for mobs.
function avoidMobs(currentBot) {
  const safeDistance = 5;
  addInterval(() => {
    if (!isBotCurrent(currentBot)) return;
    if (typeof currentBot.setControlState !== "function") return;
    try {
      const entities = Object.values(currentBot.entities).filter(
        (e) =>
          e.type === "mob" ||
          (e.type === "player" && e.username !== currentBot.username),
      );
      for (const e of entities) {
        if (!e.position) continue;
        const distance = currentBot.entity.position.distanceTo(e.position);
        if (distance < safeDistance) {
          currentBot.setControlState("back", true);
          setTimeout(() => {
            if (isBotCurrent(currentBot))
              currentBot.setControlState("back", false);
          }, 500);
          break;
        }
      }
    } catch (e) {
      addLog(`[AvoidMobs] Error: ${e.message}`, "warn");
    }
  }, 2000);
}

// Combat module
// Attack cooldown for 1.9+ (600ms minimum between attacks); target locking;
// autoEat uses item.foodPoints directly.
function combatModule(currentBot, mcData) {
  let lastAttackTime = 0;
  let lockedTarget = null;
  let lockedTargetExpiry = 0;

  currentBot.on("physicsTick", () => {
    if (!isBotCurrent(currentBot)) return;
    if (!config.combat["attack-mobs"]) return;

    const now = Date.now();
    // 1.9+ attack cooldown - respect at least 600ms between swings
    if (now - lastAttackTime < 620) return;

    try {
      // Only pick a new target if current one is gone or lock expired
      if (
        lockedTarget &&
        now < lockedTargetExpiry &&
        currentBot.entities[lockedTarget.id] &&
        lockedTarget.position
      ) {
        const dist = currentBot.entity.position.distanceTo(lockedTarget.position);
        if (dist < 4) {
          currentBot.attack(lockedTarget);
          lastAttackTime = now;
          return;
        } else {
          lockedTarget = null;
        }
      }

      // Pick a new target
      const mobs = Object.values(currentBot.entities).filter(
        (e) =>
          e.type === "mob" &&
          e.position &&
          currentBot.entity.position.distanceTo(e.position) < 4,
      );
      if (mobs.length > 0) {
        lockedTarget = mobs[0];
        lockedTargetExpiry = now + 3000; // stick to same mob for 3 seconds
        currentBot.attack(lockedTarget);
        lastAttackTime = now;
      }
    } catch (e) {
      addLog(`[Combat] Error: ${e.message}`, "warn");
    }
  });

  // autoEat - check foodPoints property on the item directly (works reliably)
  currentBot.on("health", () => {
    if (!isBotCurrent(currentBot)) return;
    if (!config.combat["auto-eat"]) return;
    safeAsync("AutoEat", () => {
      if (currentBot.food < 14) {
        const food = currentBot.inventory
          .items()
          .find((i) => i.foodPoints && i.foodPoints > 0);
        if (food) {
          return currentBot
            .equip(food, "hand")
            .then(() => currentBot.consume());
        }
      }
      return undefined;
    });
  });
}

// Bed module
// bot.isSleeping can be stale; use a local isTryingToSleep guard to prevent double-sleep errors.
// place-night must be enabled in settings for this to do anything.
function bedModule(currentBot, mcData) {
  let isTryingToSleep = false;

  addInterval(async () => {
    if (!isBotCurrent(currentBot)) return;
    if (!config.beds["place-night"]) return;

    try {
      const isNight =
        currentBot.time.timeOfDay >= 12500 &&
        currentBot.time.timeOfDay <= 23500;

      // Use local guard instead of stale bot.isSleeping
      if (isNight && !isTryingToSleep) {
        const bedBlock = currentBot.findBlock({
          matching: (block) => block.name.includes("bed"),
          maxDistance: 8,
        });

        if (bedBlock) {
          isTryingToSleep = true;
          try {
            await currentBot.sleep(bedBlock);
            addLog("[Bed] Sleeping...");
          } catch (e) {
            // Can't sleep - maybe not night enough or monsters nearby
          } finally {
            isTryingToSleep = false;
          }
        }
      }
    } catch (e) {
      isTryingToSleep = false;
      addLog(`[Bed] Error: ${e.message}`, "warn");
    }
  }, 10000);
}

// Chat module
// Forwards chat to Discord when discord.events.chat is enabled.
function chatModule(currentBot) {
  currentBot.on("chat", (username, message) => {
    if (!isBotCurrent(currentBot) || username === currentBot.username) return;

    try {
      // Send chat events to Discord if enabled
      if (
        config.discord &&
        config.discord.enabled &&
        config.discord.events &&
        config.discord.events.chat
      ) {
        sendDiscordWebhook(`💬 **${username}**: ${message}`, 0x7289da);
      }

      if (config.chat && config.chat.respond) {
        const lowerMsg = message.toLowerCase();
        if (lowerMsg.includes("hello") || lowerMsg.includes("hi")) {
          currentBot.chat(`Hello, ${username}!`);
        }
        if (message.startsWith("!tp ")) {
          const target = message.split(" ")[1];
          if (target) currentBot.chat(`/tp ${target}`);
        }
      }
    } catch (e) {
      addLog(`[Chat] Error: ${e.message}`, "warn");
    }
  });
}

// ============================================================
// CONSOLE COMMANDS
// ============================================================
const readline = require("readline");
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  if (!bot || !botState.connected) {
    addLog("[Console] Bot not connected");
    return;
  }

  const trimmed = line.trim();
  if (trimmed.startsWith("say ")) {
    bot.chat(trimmed.slice(4));
  } else if (trimmed.startsWith("cmd ")) {
    bot.chat("/" + trimmed.slice(4));
  } else if (trimmed === "status") {
    addLog(
      `Connected: ${botState.connected}, Uptime: ${formatUptime(Math.floor((Date.now() - botState.startTime) / 1000))}`,
    );
  } else {
    bot.chat(trimmed);
  }
});

// ============================================================
// DISCORD WEBHOOK INTEGRATION
// Uses Buffer.byteLength for Content-Length (handles non-ASCII correctly)
// and rate limiting to avoid spam when the bot is flapping.
// ============================================================
function sendDiscordWebhook(content, color = 0x0099ff) {
  if (
    !config.discord ||
    !config.discord.enabled ||
    !config.discord.webhookUrl ||
    config.discord.webhookUrl.includes("YOUR_DISCORD")
  )
    return;

  // Discord rate limiting - skip if sent too recently
  const now = Date.now();
  if (now - lastDiscordSend < DISCORD_RATE_LIMIT_MS) {
    addLog("[Discord] Rate limited - skipping webhook");
    return;
  }
  lastDiscordSend = now;

  safeAsync("Discord", () => {
    const protocol = config.discord.webhookUrl.startsWith("https") ? https : http;
    const urlParts = new URL(config.discord.webhookUrl);

    const payload = JSON.stringify({
      username: config.name,
      embeds: [
        {
          description: content,
          color: color,
          timestamp: new Date().toISOString(),
          footer: { text: "Slobos AFK Bot" },
        },
      ],
    });

    const options = {
      hostname: urlParts.hostname,
      port: urlParts.protocol === "https:" ? 443 : 80,
      path: urlParts.pathname + urlParts.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Buffer.byteLength instead of payload.length - handles non-ASCII
        "Content-Length": Buffer.byteLength(payload, "utf8"),
      },
    };

    return new Promise((resolve) => {
      const req = protocol.request(options, (res) => {
        res.resume(); // drain response so the socket closes cleanly
        resolve();
      });
      req.on("error", (e) => {
        addLog(`[Discord] Error sending webhook: ${e.message}`, "warn");
        resolve();
      });
      req.setTimeout(10000, () => {
        req.destroy(new Error("webhook timeout"));
      });
      req.write(payload);
      req.end();
    });
  });
}

// ============================================================
// PROCESS STABILITY
// ============================================================
// uncaughtException / unhandledRejection: log, record (bounded), recover only
// from KNOWN transient network errors by nudging the connection manager. The
// manager itself guarantees exactly one retry, so an error storm can never
// create multiple reconnect loops. Unknown/fatal errors are logged loudly;
// repeated fatal errors trigger a clean supervised restart (the hosting
// platform's process restarter relaunches us).
let recentFatalCount = 0;
let recentFatalWindow = Date.now();

function isTransientNetworkError(msg) {
  return (
    msg.includes("PartialReadError") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("timed out") ||
    msg.includes("write after end") ||
    msg.includes("This socket has been ended")
  );
}

process.on("uncaughtException", (err) => {
  const msg = (err && err.message) || "Unknown";
  addLog(`[FATAL] Uncaught Exception: ${msg}`, "error");
  recordError({ type: "uncaught", message: msg });

  if (isTransientNetworkError(msg)) {
    addLog("[FATAL] Known network/protocol error - recovering via manager...");
    // If the current generation is wedged, end it; its 'end' event flows through
    // the manager which schedules exactly ONE retry. Safe no-op otherwise.
    try {
      if (manager.bot) manager.bot.end("uncaughtNetworkError");
    } catch (_) {}
    return;
  }

  // Non-network exceptions may mean corrupted state. One occurrence: keep going.
  // Repeated occurrences within 60s: exit cleanly so the supervisor restarts us.
  const nowT = Date.now();
  if (nowT - recentFatalWindow > 60000) {
    recentFatalWindow = nowT;
    recentFatalCount = 0;
  }
  recentFatalCount++;
  if (recentFatalCount >= 5) {
    addLog("[FATAL] Repeated uncaught exceptions - exiting for supervised restart", "error");
    gracefulExit(1);
  }
});

process.on("unhandledRejection", (reason) => {
  const msg = String((reason && reason.message) || reason);
  addLog(`[FATAL] Unhandled Rejection: ${msg}`, "error");
  recordError({ type: "rejection", message: msg });
  if (isTransientNetworkError(msg)) {
    addLog("[FATAL] Network rejection - verifying connection via manager...");
    try {
      if (manager.bot) manager.bot.end("unhandledRejection");
    } catch (_) {}
  }
});

let shuttingDown = false;
function gracefulExit(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  addLog("[System] Graceful shutdown starting...");
  manager.shutdown(); // stops timers, cancels retries, disconnects current bot
  clearAllIntervals();
  try { rl.close(); } catch (_) {}
  try { server.close(() => process.exit(code)); } catch (_) { process.exit(code); }
  // Hard deadline in case the HTTP server refuses to close
  setTimeout(() => process.exit(code), 5000).unref();
}

// Hosting platforms send SIGTERM/SIGINT to stop or restart the process.
// Ignoring them prevents clean restarts, so we shut down properly.
process.on("SIGTERM", () => {
  addLog("[System] SIGTERM received - shutting down gracefully");
  gracefulExit(0);
});
process.on("SIGINT", () => {
  addLog("[System] SIGINT received - shutting down gracefully");
  gracefulExit(0);
});

// =============================
//===============================
// START THE BOT
// ============================================================
addLog("=" .repeat(50));
addLog("  Minecraft AFK Bot v2.6 - Reliable Connection Manager Edition");
addLog("=" .repeat(50));
addLog(`Server: ${config.server.ip}:${config.server.port}`);
addLog(`Version: ${config.server.version || "(auto-detect)"}`);
addLog(
  `Auto-Reconnect: ${config.utils["auto-reconnect"] ? "Enabled" : "Disabled (manual start only)"}`,
);
addLog("=" .repeat(50));

if (config.utils["auto-reconnect"]) {
  manager.start();
} else {
  // Auto-reconnect disabled: don't connect on boot; dashboard/!start can begin later.
  addLog("[Bot] auto-reconnect disabled - use the dashboard Start button to connect");
}
