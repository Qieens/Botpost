import makeWASocket, {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    delay
} from "@whiskeysockets/baileys";

import pino from "pino";
import fs from "fs";
import readline from "readline";

// =============================
// KONFIGURASI
// =============================
const PROMO_FILE = "promo.txt";
const DELAY_ANTAR_GRUP = 2000;
const DELAY_LOOP = 10 * 60 * 1000;
// =============================

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

// =============================
// LOGIN PAIRING CODE
// =============================
async function loginWithCode(sock, nomor) {
    console.log("\n🔑 MEMBUAT KODE LOGIN...");
    const code = await sock.requestPairingCode(nomor);
    console.log("\n📌 MASUKKAN KODE BERIKUT DI WHATSAPP:");
    console.log("=====================================");
    console.log("          🔐  " + code + "  🔐");
    console.log("=====================================\n");
}

// =============================
// LOOP BROADCAST
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
            } catch (err) {
                console.log(`❌ Gagal kirim ke ${gid}:`, err.message);
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
        auth: state,
        version,
        printQRInTerminal: false,

        // ============================
        // USERAGENT ANTI 405 FIXED
        // ============================
        browser: ["Chrome", "Linux", "10.15.7"],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        logger: pino({ level: "silent" }),
    });

    sock.ev.on("creds.update", saveCreds);

    // Pairing Code jika belum terdaftar
    if (!state.creds.registered) {
        await loginWithCode(sock, nomor);
    }

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, error } = update;

        if (connection === "open") {
            console.log("✅ BOT TERHUBUNG\n");
            setTimeout(() => autoLoop(sock), 2000);
        }

        if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;

            console.log(`❌ Koneksi terputus: ${code || error}`);
            console.log("🔄 Restarting...\n");

            setTimeout(startBot, 3000);
        }
    });
}

startBot();