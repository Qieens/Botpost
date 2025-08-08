process.env.BAILEYS_NO_LOG = 'true'

const fs = require('fs')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys')

// ====== KONFIGURASI ======
const OWNER_NUMBER = '628975539822@s.whatsapp.net'
const CONFIG_PATH = './config.json'

// ====== LOAD CONFIG ======
let config = { currentText: '', currentIntervalMs: 5 * 60 * 1000, broadcastActive: false }
if (fs.existsSync(CONFIG_PATH)) {
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH)) } catch {}
}
let { currentText, currentIntervalMs, broadcastActive } = config
let broadcastInterval, groupCache = {}
const saveConfig = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify({ currentText, currentIntervalMs, broadcastActive }, null, 2))

// ====== UTIL ======
const parseInterval = (text) => {
  const match = text.match(/^(\d+)(s|m|h)$/i)
  if (!match) return null
  const num = parseInt(match[1])
  return match[2].toLowerCase() === 's' ? num * 1000 : match[2].toLowerCase() === 'm' ? num * 60000 : num * 3600000
}

const humanInterval = (ms) => {
  if (ms < 60000) return `${ms / 1000}s`
  if (ms < 3600000) return `${ms / 60000}m`
  return `${ms / 3600000}h`
}

const variateText = (text) => {
  const emojis = ['✨', '✅', '🔥', '🚀', '📌', '🧠']
  const zwsp = '\u200B'
  const emoji = emojis[Math.floor(Math.random() * emojis.length)]
  const rand = Math.floor(Math.random() * 3)
  return rand === 0 ? text + ' ' + emoji
    : rand === 1 ? text.replace(/\s/g, m => m + (Math.random() > 0.8 ? zwsp : ''))
    : text
}

const delay = ms => new Promise(res => setTimeout(res, ms))

// ====== BROADCAST ======
const kirimBroadcast = async (sock) => {
  if (!currentText || !currentIntervalMs) return

  const ids = Object.keys(groupCache)
  let success = 0, failed = 0, locked = []

  for (const id of ids) {
    const info = groupCache[id]
    if (info?.announce) {
      locked.push(`🔒 ${info.subject || id}`)
      continue
    }
    try {
      await sock.sendMessage(id, { text: variateText(currentText) })
      success++
    } catch (err) {
      failed++
      console.error(`Gagal kirim ke grup ${id}:`, err.message)
    }
    await delay(Math.random() * 1200 + 800) // delay 800-2000ms
  }

  let laporan = `📢 Laporan Broadcast:\n\n✅ Terkirim: ${success}\n❌ Gagal: ${failed}\n🔒 Grup Terkunci: ${locked.length}`
  if (locked.length) laporan += '\n\n' + locked.join('\n')

  try {
    await sock.sendMessage(OWNER_NUMBER, { text: laporan })
  } catch (err) {
    console.log('❌ Gagal kirim laporan:', err.message)
  }
}

const startBroadcastLoop = (sock) => {
  if (broadcastInterval) clearInterval(broadcastInterval)
  broadcastInterval = setInterval(() => kirimBroadcast(sock), currentIntervalMs)
}

// ====== START BOT ======
const startBot = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' })
  })

  sock.ev.on('creds.update', saveCreds)

  // Update cache grup
  const refreshGroups = async () => {
    try {
      groupCache = await sock.groupFetchAllParticipating()
    } catch (err) {
      console.error('Gagal refresh group cache:', err.message)
    }
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.clear()
      console.log(`📅 ${new Date().toLocaleString()} | 📌 Scan QR:\n`)
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      console.log('✅ Bot aktif')
      await refreshGroups()
      await sock.sendMessage(OWNER_NUMBER, { text: '✅ Bot siap menerima perintah.' })

      if (broadcastActive) {
        await sock.sendMessage(OWNER_NUMBER, { text: `♻️ Melanjutkan broadcast...\nInterval: ${humanInterval(currentIntervalMs)}` })
        await kirimBroadcast(sock)
        startBroadcastLoop(sock)
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔁 Reconnecting in 5 seconds...')
        setTimeout(() => startBot(), 5000)
      } else {
        process.exit(1)
      }
    }
  })

  // Update cache jika ada perubahan grup
  sock.ev.on('groups.update', refreshGroups)
  sock.ev.on('group-participants.update', refreshGroups)

  // ====== HANDLE PESAN OWNER ======
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return
    if (msg.key.remoteJid !== OWNER_NUMBER) return

    // Ambil teks pesan dari berbagai tipe pesan teks
    const teks = msg.message.conversation
      || msg.message?.extendedTextMessage?.text
      || msg.message?.imageMessage?.caption
      || ''

    const reply = (text) => sock.sendMessage(OWNER_NUMBER, { text })

    if (teks.startsWith('.settext ')) {
      currentText = teks.slice(9).trim()
      saveConfig()
      return reply('✅ Pesan disimpan.')
    }

    if (teks.startsWith('.setinterval ')) {
      const val = parseInterval(teks.slice(13).trim())
      if (!val) return reply('❌ Format salah. Contoh: `.setinterval 5m`')
      currentIntervalMs = val
      saveConfig()
      return reply(`✅ Interval diset: ${humanInterval(val)}`)
    }

    if (teks === '.start') {
      if (!currentText) return reply('❌ Set pesan dulu dengan `.settext`')
      if (broadcastActive) return reply('❌ Broadcast sudah aktif.')
      broadcastActive = true
      saveConfig()
      reply(`🚀 Broadcast dimulai. Interval: ${humanInterval(currentIntervalMs)}`)
      await kirimBroadcast(sock)
      startBroadcastLoop(sock)
      return
    }

    if (teks === '.stop') {
      if (!broadcastActive) return reply('❌ Broadcast belum aktif.')
      clearInterval(broadcastInterval)
      broadcastActive = false
      saveConfig()
      return reply('🛑 Broadcast dihentikan.')
    }

    if (teks === '.status') {
      return reply(`📊 Status:\n\nAktif: ${broadcastActive ? '✅ Ya' : '❌ Tidak'}\nInterval: ${humanInterval(currentIntervalMs)}\nPesan: ${currentText || '⚠️ Belum diset!'}`)
    }

    if (teks === '.totalgrup') {
      return reply(`📦 Total grup: ${Object.keys(groupCache).length}`)
    }

    if (teks.startsWith('.join ')) {
      const links = teks.match(/https:\/\/chat\.whatsapp\.com\/[0-9A-Za-z]+/g)
      if (!links) return reply('❌ Tidak ada link grup yang valid.')

      for (const link of links) {
        const code = link.split('/').pop()
        try {
          await sock.groupAcceptInvite(code)
          await refreshGroups()
          await reply(`✅ Berhasil join grup:\n${link}`)
        } catch (err) {
          await reply(`❌ Gagal join grup:\n${link}\nAlasan: ${err.message}`)
        }
        await delay(3000)
      }
      return
    }
  })

}

startBot()