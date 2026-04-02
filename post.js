const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    delay
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const fs = require("fs");
const readline = require("readline");

// =============================
// INPUT NOMOR
// =============================
function inputNomor() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question("📱 Masukkan nomor (format 628xxxx): ", (num) => {
            rl.close();
            resolve(num.trim());
        });
    });
}

const PROMO_FILE = "promo.txt";
const DELAY_ANTAR_GRUP = 2000;
const DELAY_LOOP = 10 * 60 * 1000;

// =============================
// AUTOBROADCAST LOOP
// =============================
async function autoLoop(sock) {
    while (true) {
        console.log("\n🔁 MEMULAI BROADCAST BARU...");
        const msg = fs.readFileSync(PROMO_FILE, "utf8").trim();

        const groups = await sock.groupFetchAllParticipating();
        const groupIds = Object.keys(groups);

        console.log(`📌 Total grup: ${groupIds.length}`);

        for (let gid of groupIds) {
            try {
                await sock.sendMessage(gid, { text: msg });
                console.log(`✔ Terkirim ke: ${groups[gid].subject}`);
            } catch (e) {
                console.log(`❌ Gagal kirim ke ${gid}: ${e.message}`);
            }
            await delay(DELAY_ANTAR_GRUP);
        }

        console.log(`⏳ Menunggu ${DELAY_LOOP / 60000} menit...`);
        await delay(DELAY_LOOP);
    }
}

// =============================
// START BOT
// =============================
async function startBot() {
    const nomor = await inputNomor();
    const { state, saveCreds } = await useMultiFileAuthState("./session");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: state,
        version,
        printQRInTerminal: false,
        browser: ["Chrome (Linux)", "", ""],
        syncFullHistory: false,
        markOnlineOnConnect: false
    });

    sock.ev.on("creds.update", saveCreds);

    // =============================
    // FIX WAJIB: Pairing code HANYA setelah OPEN
    // =============================
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
            if (!state.creds.registered) {
                console.log("\n🔑 MEMBUAT KODE LOGIN...");
                const code = await sock.requestPairingCode(nomor);

                console.log("\n📌 MASUKKAN KODE INI DI WHATSAPP:");
                console.log("=====================================");
                console.log("          🔐  " + code + "  🔐");
                console.log("=====================================\n");
                return;
            }

            console.log("✅ BOT TERHUBUNG!");
            setTimeout(() => autoLoop(sock), 1500);
        }

        if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Koneksi terputus: ${code}`);
            console.log("🔄 Restarting...");
            setTimeout(startBot, 3000);
        }
    });
}

startBot();