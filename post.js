const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs');

// ================= CONFIG =================
let config = {
  text: "🔥 PROMOTE DISINI 🔥",
  delayGroup: 3000,
  delayLoop: 10 * 60 * 1000,
  active: false
};

const CONFIG_FILE = "config.json";

// load config
if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE));
  } catch {}
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ================= HELPER =================
const delay = ms => new Promise(r => setTimeout(r, ms));
let isLooping = false;

// ================= BROADCAST LOOP =================
async function startLoop(sock) {
  if (isLooping) return;
  isLooping = true;

  while (config.active) {
    try {
      // PATCH: stop jika socket mati
      if (!sock || !sock.ws || sock.ws.readyState !== 1) {
        console.log("⚠️ Socket belum siap, menunggu reconnect...");
        await delay(3000);
        continue;
      }

      console.log("\n🔁 Broadcast dimulai...");

      const groups = await sock.groupFetchAllParticipating();
      const ids = Object.keys(groups);

      let open = 0;
      let closed = 0;

      console.log(`📊 Total grup: ${ids.length}`);

      for (let id of ids) {
        if (!config.active) break;

        // PATCH: cek socket setiap iterasi
        if (!sock || !sock.ws || sock.ws.readyState !== 1) {
          console.log("⚠️ Socket terputus saat loop. Menunggu reconnect...");
          break;
        }

        const group = groups[id];

        if (group.announce) {
          closed++;
          console.log(`⛔ Skip (closed): ${group.subject}`);
          continue;
        }

        open++;

        try {
          await sock.sendMessage(id, { text: config.text });
          console.log(`✅ (open) ${group.subject}`);
        } catch (err) {
          console.log(`❌ ${group.subject}:`, err.message);
        }

        await delay(config.delayGroup);
      }

      console.log(`📊 Open: ${open} | Closed: ${closed}`);
      console.log(`⏳ Tunggu ${config.delayLoop / 60000} menit`);

      await delay(config.delayLoop);

    } catch (err) {
      console.log("❌ Error:", err.message);
      await delay(5000);
    }
  }

  isLooping = false;
}

// ================= START =================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./session');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  // ================= PAIRING =================
  if (!sock.authState.creds.registered) {
    const readline = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const nomor = await new Promise(resolve => {
      readline.question("📱 Masukkan nomor (62xxx): ", answer => {
        readline.close();
        resolve(answer);
      });
    });

    const code = await sock.requestPairingCode(nomor.replace(/[^0-9]/g, ""));
    console.log("🔑 Kode pairing:", code);
  }

  // ================= COMMAND =================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || !msg.key.fromMe) return;

    const jid = msg.key.remoteJid;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    if (!text.startsWith(".")) return;

    const args = text.trim().split(" ");
    const cmd = args[0].toLowerCase();

    const reply = (txt) => sock.sendMessage(jid, { text: txt });

    switch (cmd) {
      case ".on":
        if (config.active) return reply("⚠️ Sudah aktif");
        config.active = true;
        saveConfig();
        reply("✅ Broadcast ON");
        startLoop(sock);
        break;

      case ".off":
        config.active = false;
        saveConfig();
        reply("🛑 Broadcast OFF");
        break;

      case ".teks":
        const newText = text.slice(6).trim();
        if (!newText) return reply("❌ Isi teks kosong");
        config.text = newText;
        saveConfig();
        reply("✅ Teks diupdate");
        break;

      case ".delay":
        const menit = parseInt(args[1]);
        if (isNaN(menit)) return reply("❌ Contoh: .delay 10");
        config.delayLoop = menit * 60 * 1000;
        saveConfig();
        reply(`✅ Delay diubah ke ${menit} menit`);
        break;

      case ".status":
        reply(
          `📊 STATUS\n\n` +
          `Aktif: ${config.active ? "ON" : "OFF"}\n` +
          `Delay: ${config.delayLoop / 60000} menit\n` +
          `Pesan: ${config.text}`
        );
        break;
    }
  });

  // ================= CONNECTION =================
  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      console.log("✅ Connected");

      // PATCH: hanya jalankan loop jika ON dan tidak looping
      if (config.active && !isLooping) startLoop(sock);
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Disconnect:", reason);

      // PATCH: stop loop agar tidak spam
      config.active = config.active; // tidak diubah user
      isLooping = false;

      if (reason !== DisconnectReason.loggedOut) {
        setTimeout(startBot, 3000);
      }
    }
  });
}

// ================= RUN =================
startBot();
