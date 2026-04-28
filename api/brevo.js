export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { destinataires, sujet, message, expediteur_nom, expediteur_email } = req.body
  if (!destinataires || !sujet || !message) {
    return res.status(400).json({ error: 'Destinataires, sujet et message obligatoires' })
  }

  const BREVO_KEY = process.env.BREVO_API_KEY
  if (!BREVO_KEY) return res.status(500).json({ error: 'Clé Brevo manquante' })

  const resultats = []

  for (const dest of destinataires) {
    try {
      // Personnaliser le message avec le prénom
      const msgPersonnalise = message.replace(/\[Prenom\]/gi, dest.prenom || dest.nom || '')

      // Envoi en TEXTE BRUT uniquement — passe les filtres anti-spam
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': BREVO_KEY
        },
        body: JSON.stringify({
          sender: {
            name: expediteur_nom || 'Alex Escudier',
            email: expediteur_email || 'alex.escudier@suiviimmo.fr'
          },
          to: [{ 
            email: dest.email, 
            name: (dest.prenom || '') + ' ' + (dest.nom || '')
          }],
          subject: sujet,
          // Texte brut uniquement — pas de HTML = pas de filtre promotions
          textContent: msgPersonnalise,
          // HTML minimal pour compatibilité — mais sans mise en forme
          htmlContent: '<pre style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">' + msgPersonnalise.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>',
          // Headers importants pour éviter le spam
          headers: {
            'X-Mailer': 'SuiviImmo',
            'Precedence': 'bulk'
          }
        })
      })

      const data = await response.json()
      if (response.ok) {
        resultats.push({ email: dest.email, statut: 'envoye', messageId: data.messageId })
      } else {
        resultats.push({ email: dest.email, statut: 'erreur', detail: data.message })
      }
    } catch (err) {
      resultats.push({ email: dest.email, statut: 'erreur', detail: err.message })
    }
  }

  const envoyes = resultats.filter(r => r.statut === 'envoye').length
  const erreurs = resultats.filter(r => r.statut === 'erreur').length

  return res.status(200).json({ succes: envoyes, erreurs, resultats })
}
