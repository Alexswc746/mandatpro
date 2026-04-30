export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { adresse, surface, type_local = 'Appartement' } = req.body
  if (!adresse) return res.status(400).json({ error: 'Adresse manquante' })

  const DVF_SERVER = process.env.NEXT_PUBLIC_DVF_SERVER_URL || 'https://dvf-server.onrender.com'
  const surfNum = surface ? parseFloat(surface) : null

  try {
    // Étape 1 — Géocoder l'adresse
    const geoRes = await fetch(
      `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(adresse)}&limit=1`
    )
    if (!geoRes.ok) throw new Error('Geocodage impossible')
    const geoData = await geoRes.json()

    if (!geoData.features || geoData.features.length === 0) {
      return res.status(200).json({ error: 'Adresse introuvable', dvf: null })
    }

    const feature = geoData.features[0]
    const [lng, lat] = feature.geometry.coordinates
    const codeInsee = feature.properties.citycode
    const ville = feature.properties.city
    const codePostal = feature.properties.postcode

    // Étape 2 — Stats prix m² via notre serveur DVF (API officielle data.gouv.fr)
    const statsUrl = `${DVF_SERVER}/dvf/stats?code_insee=${codeInsee}&type_local=${encodeURIComponent(type_local)}`
    console.log('DVF stats URL:', statsUrl)

    const statsRes = await fetch(statsUrl)
    console.log('DVF stats status:', statsRes.status)

    if (statsRes.ok) {
      const stats = await statsRes.json()
      console.log('DVF stats:', JSON.stringify(stats))

      if (!stats.prix_m2?.median || stats.nb_mutations < 3) {
        // Pas assez de données → essai par point GPS
        const pointUrl = `${DVF_SERVER}/dvf/point?lat=${lat}&lon=${lng}&dist=1000`
        const pointRes = await fetch(pointUrl)

        if (pointRes.ok) {
          const pointData = await pointRes.json()
          const features = (pointData.features || []).filter(f => {
            const tl = f.properties?.type_local?.toLowerCase()
            return tl === type_local.toLowerCase()
          })

          if (features.length >= 3) {
            const prixM2List = features
              .map(f => {
                const val = f.properties?.valeur_fonciere
                const surf = f.properties?.surface_reelle_bati
                return surf && val ? val / surf : null
              })
              .filter(Boolean)
              .sort((a, b) => a - b)

            const median = prixM2List[Math.floor(prixM2List.length / 2)]
            const avgM2 = Math.round(median)

            return res.status(200).json({
              dvf: {
                avgM2,
                medianM2: avgM2,
                est: surfNum ? Math.round(avgM2 * surfNum) : null,
                comp: features.length,
                conf: 'indicative',
                date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
                samples: []
              },
              geo: { lat, lng, ville, codePostal, codeInsee }
            })
          }
        }

        return res.status(200).json({
          error: 'Données insuffisantes pour ce secteur',
          dvf: null,
          geo: { lat, lng, ville, codePostal, codeInsee }
        })
      }

      const avgM2 = stats.prix_m2.median
      const estValeur = (avgM2 && surfNum) ? Math.round(avgM2 * surfNum) : null

      return res.status(200).json({
        dvf: {
          avgM2,
          medianM2: stats.prix_m2.median,
          est: estValeur,
          comp: stats.nb_mutations,
          conf: stats.nb_mutations >= 10 ? 'bonne' : 'indicative',
          date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
          samples: []
        },
        geo: { lat, lng, ville, codePostal, codeInsee }
      })
    }

    throw new Error(`DVF server error: ${statsRes.status}`)

  } catch (err) {
    console.log('DVF catch error:', err.message)
    return res.status(200).json({ error: err.message, dvf: null })
  }
}
