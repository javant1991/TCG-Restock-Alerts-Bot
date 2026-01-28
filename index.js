require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const fs = require("fs");
const pLimit = require("p-limit").default;
const express = require("express");

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.ALERT_CHANNEL_ID;

const POLL_INTERVAL_MS = 60 * 1000; // 1 minute (adjust)
const CONCURRENCY = 2;              // keep low to be polite
const TIMEOUT_MS = 15000;

function readJson(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); }
  catch { return fallback; }
}
function writeJson(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2));
}

const targets = readJson("./stores.json", []);
let state = readJson("./state.json", { lastStatus: {} });

async function fetchText(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; RestockBot/1.0; +https://discord.com)"
      }
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(t);
  }
}

function detectStock({ text }, target) {
  const inRx = new RegExp(target.inStockRegex, "i");
  const outRx = new RegExp(target.outOfStockRegex, "i");
  const hasIn = inRx.test(text);
  const hasOut = outRx.test(text);

  // Conservative logic:
  // - If out-of-stock phrase is present, treat as OOS.
  // - If in-stock phrase is present and no out-of-stock, treat as IN.
  // - Otherwise unknown.
  if (hasOut) return "OOS";
  if (hasIn && !hasOut) return "IN";
  return "UNKNOWN";
}

async function sendAlert(channel, target, newStatus) {
  const embed = new EmbedBuilder()
    .setTitle(`🟢 Restock detected: ${target.name}`)
    .setDescription(`[Open product page](${target.url})`)
    .addFields(
      { name: "Status", value: newStatus, inline: true },
      { name: "Time", value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: true }
    )
    .setTimestamp(new Date());

  await channel.send({ embeds: [embed] });
}

async function checkTarget(channel, target) {
  const key = target.url;
  const prev = state.lastStatus[key] || "UNKNOWN";

  const res = await fetchText(target.url);
  if (!res.ok) {
    // Don’t spam alerts on errors; just log
    console.log(`[${target.name}] HTTP ${res.status}`);
    return;
  }

  const now = detectStock(res, target);
  if (now === "IN" && prev !== "IN") {
    await sendAlert(channel, target, now);
  }

  state.lastStatus[key] = now;
}

async function runLoop(client) {
  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel) throw new Error("Could not fetch channel. Check ALERT_CHANNEL_ID.");

  const limit = pLimit(CONCURRENCY);

  console.log(`Monitoring ${targets.length} targets...`);

  const tick = async () => {
    try {
      await Promise.all(
        targets.map(t => limit(() => checkTarget(channel, t)))
      );
      writeJson("./state.json", state);
    } catch (e) {
      console.error("Loop error:", e.message);
    }
  };

  await tick(); // RUNS IMMEDIATELY
  setInterval(tick, POLL_INTERVAL_MS);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", () => { // ✅ removes warning (optional)
  console.log(`Logged in as ${client.user.tag}`);
  runLoop(client).catch(err => console.error(err));
});
// ===============================
// Pokemon Center inbound alerts
// ===============================
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post("/pokemoncenter/etb", async (req, res) => {
  try {
    const { title } = req.body || {};

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return res.status(500).json({ ok: false });

    const embed = new EmbedBuilder()
      .setTitle(title || "🟢 Pokémon Center ETB Alert")
      .setDescription(
        "[Elite Trainer Box Category](https://www.pokemoncenter.com/category/elite-trainer-box)"
      )
      .setTimestamp(new Date());

    await channel.send({ embeds: [embed] });

    res.json({ ok: true });
  } catch (err) {
    console.error("Pokemon Center webhook error:", err);
    res.status(500).json({ ok: false });
  }
});
console.log("Starting webhook server...");

app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
});

client.login(TOKEN);
