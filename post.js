process.env.BAILEYS_NO_LOG = 'true'

const fs = require('fs')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const readline = require('readline')
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys')

const CONFIG_PATH = './config.json'
const BATCH_SIZE = 20

// ====== LOAD CONFIG ======
let config = { currentText: '', currentIntervalMs: 5 * 60 * 1000, broadcastActive: false, variatetextActive: true }
if (fs.existsSync(CONFIG_PATH)) {
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH)) } catch {}
}
let { currentText, currentIntervalMs, broadcastActive, variatetextActive } = config
let broadcastTimeout, groupCache = {}
const saveConfig = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify({ currentText, currentIntervalMs, broadcastActive, variatetextActive }, null, 2))

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
  if (!variatetextActive) return text
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
async function sendBatch(sock, batch, text) {
  for (const jid of batch) {
    try {
      await sock.sendMessage(jid, { text: variateText(text) })
      console.log(`✅ Broadcast terkirim ke ${jid}`)
      await delay(300)
    } catch (err) {
      console.error(`❌ Gagal broadcast ke ${jid}:`, err.message)
    }
  }
}

async function broadcastAll(sock) {
  if (!currentText) return

  // Kirim hanya ke grup yang announce = true (announcement only)
  const allGroups = Object.entries(groupCache)
    .filter(([_, info]) => info.announce)
    .map(([jid, _]) => jid)

  if (allGroups.length === 0) {
    console.log('⚠️ Tidak ada grup yang ditemukan untuk broadcast.')
    return
  }

  const batches = []
  for (let i = 0; i < allGroups.length; i += BATCH_SIZE) {
    batches.push(allGroups.slice(i, i + BATCH_SIZE))
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    console.log(`📢 Mulai kirim batch ${i + 1} dari ${batches.length}, ukuran batch: ${batch.length}`)
    await sendBatch(sock, batch, currentText)
    console.log(`✅ Batch ${i + 1} selesai dikirim.`)
    if (i < batches.length - 1) await delay(2000)
  }
}

async function startBroadcastLoop(sock) {
  if (broadcastTimeout) clearTimeout(broadcastTimeout)

  if (!broadcastActive) return

  await broadcastAll(sock)
  broadcastTimeout = setTimeout(() => startBroadcastLoop(sock), currentIntervalMs)
}

// ====== READLINE INTERFACE ======
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> '
})

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

  // Refresh group cache
  let isRefreshing = false
  const refreshGroups = async () => {
    if (isRefreshing) return
    isRefreshing = true
    try {
      groupCache = await sock.groupFetchAllParticipating()
      console.log(`🔄 Cache grup diperbarui: ${Object.keys(groupCache).length} grup`)
    } catch (err) {
      console.error('Gagal refresh group cache:', err.message)
    }
    isRefreshing = false
  }

  const debounceRefreshGroups = (() => {
    let timeout = null
    return () => {
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(refreshGroups, 60000)
    }
  })()

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.clear()
      console.log(`📅 ${new Date().toLocaleString()} | 📌 Scan QR:\n`)
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      console.log('✅ Bot aktif')
      await refreshGroups()
      if (broadcastActive) {
        console.log(`♻️ Melanjutkan broadcast...\nInterval: ${humanInterval(currentIntervalMs)}`)
        startBroadcastLoop(sock)
      }
      rl.prompt()
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

  sock.ev.on('groups.update', updates => {
    debounceRefreshGroups()
    for (const update of updates) {
      const jid = update.id
      if ('announce' in update) {
        if (update.announce) {
          console.log(`🔒 Grup ${jid} sekarang di mode "close" (announcement only)`)
        } else {
          console.log(`🔓 Grup ${jid} sekarang di mode "open" (bisa chat)`)
        }
      }
    }
  })

  sock.ev.on('group-participants.update', debounceRefreshGroups)

  // ====== READLINE COMMANDS ======
  rl.on('line', async (line) => {
    const input = line.trim()

    if (input.startsWith('settext ')) {
      currentText = input.slice(8).trim()
      saveConfig()
      console.log('✅ Pesan disimpan.')
    } else if (input.startsWith('setinterval ')) {
      const val = parseInterval(input.slice(12).trim())
      if (!val) return console.log('❌ Format interval salah. Contoh: setinterval 5m')
      currentIntervalMs = val
      saveConfig()
      console.log(`✅ Interval diset: ${humanInterval(val)}`)
    } else if (input === 'start') {
      if (!currentText) return console.log('❌ Set pesan dulu dengan settext')
      if (broadcastActive) return console.log('❌ Broadcast sudah aktif.')
      broadcastActive = true
      saveConfig()
      startBroadcastLoop(sock)
      console.log('🚀 Broadcast dimulai.')
    } else if (input === 'stop') {
      if (!broadcastActive) return console.log('❌ Broadcast belum aktif.')
      broadcastActive = false
      if (broadcastTimeout) clearTimeout(broadcastTimeout)
      saveConfig()
      console.log('🛑 Broadcast dihentikan.')
    } else if (input === 'status') {
      console.log(`📊 Status:\nAktif: ${broadcastActive ? '✅ Ya' : '❌ Tidak'}\nInterval: ${humanInterval(currentIntervalMs)}\nVariasi teks: ${variatetextActive ? '✅ Aktif' : '❌ Mati'}\nPesan: ${currentText || '⚠️ Belum diset!'}`)
    } else if (input === 'variasi on') {
      variatetextActive = true
      saveConfig()
      console.log('✅ Variasi teks diaktifkan.')
    } else if (input === 'variasi off') {
      variatetextActive = false
      saveConfig()
      console.log('✅ Variasi teks dinonaktifkan.')
    } else if (input === 'totalgrup') {
      console.log(`📦 Total grup: ${Object.keys(groupCache).length}`)
    } else if (input === 'help') {
      console.log('Perintah tersedia:\n settext [pesan]\n setinterval [5s|5m|1h]\n start\n stop\n status\n variasi on/off\n totalgrup\n help')
    } else {
      console.log('❌ Perintah tidak dikenal, ketik help untuk daftar perintah.')
    }
    rl.prompt()
  })
}

startBot()