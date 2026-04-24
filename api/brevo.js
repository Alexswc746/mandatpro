export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { destinataires, sujet, message, expediteur_nom } = req.body
  if (!destinataires || !sujet || !message) {
    return res.status(400).json({ error: 'Destinataires, sujet et message obligatoires' })
  }

  const BREVO_KEY = process.env.BREVO_API_KEY
  if (!BREVO_KEY) return res.status(500).json({ error: 'Clé Brevo manquante' })

  // Convertir le texte en HTML simple
  const htmlContent = `
    <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a; line-height: 1.7;">
      ${message.split('\n').map(line => line.trim() ? `<p style="margin: 0 0 12px">${line}</p>` : '<br>').join('')}
      <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">
      <p style="font-size: 12px; color: #888;">${expediteur_nom || 'Votre conseiller immobilier'} — Mandataire IAD France</p>
    </div>
  `

  // Envoyer un email par destinataire (pour personnalisation)
  const resultats = []
  for (const dest of destinataires) {
    try {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': BREVO_KEY
        },
        body: JSON.stringify({
          sender: {
            name: expediteur_nom || 'Alex Escudier',
            email: 'contact@alexescudieriadimmobilier.fr'
          },
          to: [{ email: dest.email, name: dest.nom || dest.email }],
          subject: sujet,
          htmlContent: htmlContent.replace(/\$\{NOM\}/g, dest.prenom || dest.nom || 'vous'),
          textContent: message
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

  return res.status(200).json({
    succes: envoyes,
    erreurs,
    resultats
  })
}
