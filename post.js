const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    delay
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const fs = require("fs");

// =============================
// KONFIGURASI
// =============================
const PROMO_FILE = "promo.txt";
const DELAY_ANTAR_GRUP = 2000;
const DELAY_LOOP = 10 * 60 * 1000;
// =============================

// =============================
// FUNGSI LOGIN PAIRING CODE
// =============================
async function loginWithCode(sock) {
    console.log("\n🔑 MEMBUAT KODE LOGIN...");

    const code = await sock.requestPairingCode(process.env.LOGIN_NUMBER);

    console.log("\n📌 MASUKKAN KODE INI DI WHATSAPP:");
    console.log("=======================================");
    console.log(`       🔐  ${code}  🔐`);
    console.log("=======================================\n");
}

// =============================
// AUTO BROADCAST LOOP
// =============================
async function autoLoop(sock) {
    while (true) {
        console.log("\n🔁 MEMULAI BROADCAST BARU...");

        const message = fs.readFileSync(PROMO_FILE, "utf8").trim();
        const groups = await sock.groupFetchAllParticipating();
        const groupIds = Object.keys(groups);

        console.log(`📌 Total grup: ${groupIds.length}`);

        for (let gid of groupIds) {
            try {
                await sock.sendMessage(gid, { text: message });
                console.log(`✔ Terkirim ke: ${groups[gid].subject}`);
                await delay(DELAY_ANTAR_GRUP);
            } catch (err) {
                console.log(`❌ Gagal kirim ke ${gid}:`, err.message);
            }
        }

        console.log(`\n⏳ Menunggu ${DELAY_LOOP / 60000} menit...`);
        await delay(DELAY_LOOP);
    }
}

// =============================
// START BOT
// =============================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./session");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: state,
        version,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "110.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection } = update;

        // TRIGGER PAIRING SAAT "connecting"
        if (!state.creds.registered && connection === "connecting") {
            if (!process.env.LOGIN_NUMBER) {
                console.log("\n❌ Set dulu nomor login:");
                console.log("LOGIN_NUMBER='628xxxxxx' node post.js\n");
                process.exit(0);
            }
            await loginWithCode(sock);
        }

        if (connection === "open") {
            console.log("✅ BOT TERHUBUNG\n");
            setTimeout(() => autoLoop(sock), 2000);
        }

        if (connection === "close") {
            console.log("❌ Koneksi terputus. Restarting...");
            setTimeout(startBot, 3000);
        }
    });
}

startBot();