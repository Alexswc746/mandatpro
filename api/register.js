import crypto from 'crypto'

const OVH_APP_KEY = process.env.OVH_APP_KEY
const OVH_APP_SECRET = process.env.OVH_APP_SECRET
const OVH_CONSUMER_KEY = process.env.OVH_CONSUMER_KEY
const BREVO_KEY = process.env.BREVO_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xzkzzxgkoxipmkbxynfq.supabase.co'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

// Signature OVH
function ovhSign(method, url, body, timestamp) {
  const toSign = [OVH_APP_SECRET, OVH_CONSUMER_KEY, method, url, body || '', timestamp].join('+')
  return '$1$' + crypto.createHash('sha1').update(toSign).digest('hex')
}

async function ovhRequest(method, path, body = null) {
  const url = `https://eu.api.ovh.com/1.0${path}`
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const bodyStr = body ? JSON.stringify(body) : ''
  const signature = ovhSign(method, url, bodyStr, timestamp)

  const res = await fetch(url, {
    method,
    headers: {
      'X-Ovh-Application': OVH_APP_KEY,
      'X-Ovh-Consumer': OVH_CONSUMER_KEY,
      'X-Ovh-Signature': signature,
      'X-Ovh-Timestamp': timestamp,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: bodyStr || undefined
  })
  const data = await res.json()
  return { ok: res.ok, status: res.status, data }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { prenom, nom, email, secteur, password } = req.body
  if (!prenom || !nom || !email || !password) {
    return res.status(400).json({ error: 'Tous les champs sont obligatoires' })
  }

  // Générer l'adresse email personnalisée
  const normalize = (str) => str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/, '')
  const emailLocal = `${normalize(prenom)}.${normalize(nom)}`
  const emailSuivi = `${emailLocal}@suiviimmo.fr`

  const results = { compte: false, emailOVH: false, emailBrevo: false, bienvenue: false }
  const errors = []

  try {
    // ── ÉTAPE 1 : Créer le compte Supabase Auth
    const supaRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { prenom, nom, secteur }
      })
    })
    const supaData = await supaRes.json()

    if (!supaRes.ok) {
      return res.status(400).json({ error: supaData.message || supaData.msg || JSON.stringify(supaData) })
    }

    const userId = supaData.id
    results.compte = true

    // ── ÉTAPE 2 : Créer le profil dans la table utilisateurs
    await fetch(`${SUPABASE_URL}/rest/v1/utilisateurs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        auth_id: userId,
        prenom, nom, email,
        secteur: secteur || '',
        reseau: 'IAD France',
        email_suivi: emailSuivi
      })
    })

    // ── ÉTAPE 3 : Créer la boîte email OVH
    const ovhRes = await ovhRequest('POST', '/email/domain/suiviimmo.fr/account', {
      accountName: emailLocal,
      password: Math.random().toString(36).slice(-12) + 'A1!',
      size: 5242880 // 5 Go en octets
    })

    if (ovhRes.ok) {
      results.emailOVH = true
    } else {
      errors.push('Email OVH: ' + JSON.stringify(ovhRes.data))
    }

    // ── ÉTAPE 4 : Ajouter expéditeur dans Brevo
    const brevoRes = await fetch('https://api.brevo.com/v3/senders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': BREVO_KEY
      },
      body: JSON.stringify({
        name: `${prenom} ${nom}`,
        email: emailSuivi
      })
    })
    if (brevoRes.ok) results.emailBrevo = true

    // ── ÉTAPE 5 : Email de bienvenue
    const msgBienvenue = `Bonjour ${prenom},

Bienvenue sur SuiviImmo !

Votre compte est maintenant actif. Voici vos informations :

Accès : https://suiviimmo.fr
Email de connexion : ${email}

Votre adresse email professionnelle pour vos campagnes :
${emailSuivi}

Vous pouvez dès maintenant ajouter vos premiers clients et prospects.

Bonne prospection,
Alex Escudier — SuiviImmo`

    const welcomeRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
      body: JSON.stringify({
        sender: { name: 'Alex Escudier — SuiviImmo', email: 'alex.escudier@suiviimmo.fr' },
        to: [{ email, name: `${prenom} ${nom}` }],
        subject: 'Bienvenue sur SuiviImmo !',
        textContent: msgBienvenue
      })
    })
    if (welcomeRes.ok) results.bienvenue = true

    return res.status(200).json({
      success: true,
      emailSuivi,
      results,
      errors: errors.length ? errors : undefined
    })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
