process.env.BAILEYS_NO_LOG = 'true'

const fs = require('fs')
const pino = require('pino')
const qrcode = require('qrcode-terminal')
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys')

const OWNER_NUMBER = '628975539822@s.whatsapp.net' // ganti nomor owner kamu
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

  // Filter grup yang tidak terkunci (announce !== true)
  const allGroups = Object.entries(groupCache)
    .filter(([_, info]) => !info.announce)
    .map(([jid, _]) => jid)

  if (allGroups.length === 0) {
    await sock.sendMessage(OWNER_NUMBER, { text: '⚠️ Tidak ada grup yang ditemukan untuk broadcast.' })
    return
  }

  // Bagi ke batch
  const batches = []
  for (let i = 0; i < allGroups.length; i += BATCH_SIZE) {
    batches.push(allGroups.slice(i, i + BATCH_SIZE))
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    await sock.sendMessage(OWNER_NUMBER, { text: `📢 Mulai kirim batch ${i + 1} dari ${batches.length}, ukuran batch: ${batch.length}` })
    await sendBatch(sock, batch, currentText)
    await sock.sendMessage(OWNER_NUMBER, { text: `✅ Batch ${i + 1} selesai dikirim.` })
    if (i < batches.length - 1) await delay(2000) // delay 2 detik antar batch
  }
}

// Loop broadcast dengan interval
async function startBroadcastLoop(sock) {
  if (broadcastTimeout) clearTimeout(broadcastTimeout)

  if (!broadcastActive) return

  await broadcastAll(sock)
  broadcastTimeout = setTimeout(() => startBroadcastLoop(sock), currentIntervalMs)
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
      await sock.sendMessage(OWNER_NUMBER, { text: '✅ Bot siap menerima perintah.' })

      if (broadcastActive) {
        await sock.sendMessage(OWNER_NUMBER, { text: `♻️ Melanjutkan broadcast...\nInterval: ${humanInterval(currentIntervalMs)}` })
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

  sock.ev.on('groups.update', debounceRefreshGroups)
  sock.ev.on('group-participants.update', debounceRefreshGroups)

  // Handle messages dari owner
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const jid = msg.key.remoteJid || ''
    const fromOwner = jid === OWNER_NUMBER
    const isGroup = jid.endsWith('.g.us')

    if (isGroup && !fromOwner) return
    if (!fromOwner) return

    try {
      const teks = msg.message.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || ''

      const reply = (text) => sock.sendMessage(OWNER_NUMBER, { text })

      if (teks.startsWith('.teks ')) {
        currentText = teks.slice(9).trim()
        saveConfig()
        return reply('✅ Pesan disimpan.')
      }

      if (teks.startsWith('.interval ')) {
        const val = parseInterval(teks.slice(13).trim())
        if (!val) return reply('❌ Format salah. Contoh: `.setinterval 5m`')
        currentIntervalMs = val
        saveConfig()
        return reply(`✅ Interval diset: ${humanInterval(val)}`)
      }
      if (teks === '.variasi on') {
        variatetextActive = true
        saveConfig()
        return reply('✅ Variasi teks diaktifkan.')
        }

      if (teks === '.variasi off') {
        variatetextActive = false
        saveConfig()
        return reply('✅ Variasi teks dinonaktifkan.')
        }

      if (teks === '.start') {
        if (!currentText) return reply('❌ Set pesan dulu dengan `.settext`')
        if (broadcastActive) return reply('❌ Broadcast sudah aktif.')
        broadcastActive = true
        saveConfig()
        reply(`🚀 Broadcast dimulai. Interval: ${humanInterval(currentIntervalMs)}`)
        startBroadcastLoop(sock)
        return
      }

      if (teks === '.stop') {
        if (!broadcastActive) return reply('❌ Broadcast belum aktif.')
        broadcastActive = false
        if (broadcastTimeout) clearTimeout(broadcastTimeout)
        saveConfig()
        return reply('🛑 Broadcast dihentikan.')
      }

      if (teks === '.status') {
        return reply(`📊 Status:\n\nAktif: ${broadcastActive ? '✅ Ya' : '❌ Tidak'}\nInterval: ${humanInterval(currentIntervalMs)}\nVariasi : ${variatetextActive ? '✅ Aktif' : '❌ Mati'}\nPesan: ${currentText || '⚠️ Belum diset!'}`)
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
    } catch (e) {
      if (e.message && e.message.includes('Failed decrypt')) {
        console.warn('⚠️ Gagal decrypt pesan.')
        await sock.sendMessage(OWNER_NUMBER, { text: '⚠️ Pesan gagal didekripsi, mohon kirim ulang.' }).catch(() => {})
      } else {
        console.error('Error di messages.upsert:', e)
      }
    }
  })
}

startBot()
