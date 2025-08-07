// ENV setup
process.env.BAILEYS_NO_LOG = 'true'

// Dependencies
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys')
const pino = require('pino')

// Constants
const OWNER_NUMBER = '628XXXXXX@s.whatsapp.net' // Ganti dengan nomor kamu

// State Variables
let currentText = ''
let currentIntervalMs = 5 * 60 * 1000
let broadcastActive = false
let broadcastInterval

// Utilities
const parseInterval = (text) => {
  const match = text.match(/^([0-9]+)(s|m|h)$/i)
  if (!match) return null
  const [, value, unit] = match
  const num = parseInt(value)
  return unit === 's' ? num * 1000 : unit === 'm' ? num * 60000 : num * 3600000
}

const humanInterval = (ms) => {
  if (ms < 60000) return `${ms / 1000}s`
  if (ms < 3600000) return `${ms / 60000}m`
  return `${ms / 3600000}h`
}

const variateText = (base) => {
  const emojis = ['✨', '🔥', '✅', '📌', '🧠', '🚀', '🎯']
  const zwsp = '\u200B'
  const randEmoji = emojis[Math.floor(Math.random() * emojis.length)]
  const rand = Math.floor(Math.random() * 4)
  switch (rand) {
    case 0: return base + ' ' + randEmoji
    case 1: return base.replace(/,/g, ',' + randEmoji)
    case 2: return base.replace(/\s/g, m => m + (Math.random() > 0.7 ? zwsp : ''))
    case 3: return base.slice(0, 5) + randEmoji + base.slice(5)
    default: return base
  }
}

const delay = (ms) => new Promise(res => setTimeout(res, ms))

const kirimBroadcast = async (sock) => {
  if (!currentText || !currentIntervalMs) return

  const groups = await sock.groupFetchAllParticipating()
  const ids = Object.keys(groups)

  let success = 0, failed = 0, locked = []

  for (const id of ids) {
    const info = groups[id]
    if (info.announce) {
      locked.push(`🔒 ${info.subject}`)
      continue
    }
    try {
      await sock.sendMessage(id, { text: variateText(currentText) })
      success++
    } catch {
      failed++
    }
    await delay(Math.random() * 3000 + 1500)
  }

  let report = `📢 Laporan Broadcast:\n\n✅ Terkirim: ${success}\n❌ Gagal: ${failed}\n🔒 Grup Terkunci: ${locked.length}`
  if (locked.length) report += `\n\n${locked.join('\n')}`

  try {
    await sock.sendMessage(OWNER_NUMBER, { text: report })
  } catch (err) {
    console.log('❌ Gagal kirim laporan ke owner:', err.message)
  }
}

const startBot = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' })
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('✅ Bot aktif')
      await sock.sendMessage(OWNER_NUMBER, { text: '✅ Bot siap menerima perintah.' })
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔁 Reconnecting...')
        startBot()
      } else {
        process.exit(1)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe || msg.key.remoteJid !== OWNER_NUMBER) return

    const teks = msg.message.conversation || msg.message?.extendedTextMessage?.text || ''

    if (teks.startsWith('.settext ')) {
      currentText = teks.slice(9).trim()
      return sock.sendMessage(OWNER_NUMBER, { text: '✅ Pesan disimpan.' })
    }

    if (teks.startsWith('.setinterval ')) {
      const val = parseInterval(teks.slice(13).trim())
      return val
        ? (currentIntervalMs = val,
           sock.sendMessage(OWNER_NUMBER, { text: `✅ Interval: ${humanInterval(val)}` }))
        : sock.sendMessage(OWNER_NUMBER, { text: '❌ Format salah. Contoh: .setinterval 5m' })
    }

    if (teks === '.start') {
      if (!currentText) return sock.sendMessage(OWNER_NUMBER, { text: '❌ Set pesan dahulu.' })
      if (broadcastActive) return sock.sendMessage(OWNER_NUMBER, { text: '❌ Broadcast sudah aktif.' })
      broadcastActive = true
      sock.sendMessage(OWNER_NUMBER, { text: `🚀 Mulai broadcast. Interval: ${humanInterval(currentIntervalMs)}` })
      await kirimBroadcast(sock)
      broadcastInterval = setInterval(() => kirimBroadcast(sock), currentIntervalMs)
    }

    if (teks === '.stop') {
      if (!broadcastActive) return sock.sendMessage(OWNER_NUMBER, { text: '❌ Belum aktif.' })
      clearInterval(broadcastInterval)
      broadcastActive = false
      sock.sendMessage(OWNER_NUMBER, { text: '🛑 Broadcast dihentikan.' })
    }

    if (teks === '.status') {
      let msg = `📊 Status:\n\nAktif: ${broadcastActive ? '✅ Ya' : '❌ Tidak'}\nInterval: ${humanInterval(currentIntervalMs)}\nPesan: ${currentText || '⚠️ Belum diset!'}`
      sock.sendMessage(OWNER_NUMBER, { text: msg })
    }
  })
}

startBot()