const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    delay
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const fs = require("fs");

const PROMO_FILE = "promo.txt";
const DELAY_ANTAR_GRUP = 2000;
const DELAY_LOOP = 10 * 60 * 1000;

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

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./session");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: state,
        version,
        printQRInTerminal: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, pairingCode } = update;

        // 🔐 Auto pairing code resmi dan stabil
        if (!state.creds.registered && pairingCode) {
            console.log("\n📌 MASUKKAN KODE LOGIN DI WHATSAPP");
            console.log("=======================================");
            console.log(`       🔐  ${pairingCode}  🔐`);
            console.log("=======================================\n");
        }

        if (connection === "open") {
            console.log("✅ BOT TERHUBUNG");
            setTimeout(() => autoLoop(sock), 2000);
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log("❌ Koneksi terputus:", reason);
            console.log("🔄 Restarting...");
            setTimeout(startBot, 3000);
        }
    });
}

startBot();