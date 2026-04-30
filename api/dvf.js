export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { adresse, surface } = req.body
  if (!adresse) return res.status(400).json({ error: 'Adresse manquante' })

  const IMMO_API_KEY = process.env.IMMO_API_KEY
  if (!IMMO_API_KEY) return res.status(500).json({ error: 'Clé Immo API manquante' })

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
    const codeDept = codeInsee.substring(0, 2)
    const surfNum = surface ? parseFloat(surface) : null

    // Étape 2 — Stats par commune via Immo API (endpoint le plus simple)
    const headers = {
      'Authorization': `Bearer ${IMMO_API_KEY}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }

    // Essai 1 — stats par commune
    let statsUrl = `https://immoapi.app/v1/stats?code_commune=${codeInsee}&type_local=Appartement`
    let statsRes = await fetch(statsUrl, { headers })
    console.log('Stats commune status:', statsRes.status, 'url:', statsUrl)

    // Essai 2 — stats par département si commune échoue
    if (!statsRes.ok) {
      statsUrl = `https://immoapi.app/v1/stats?code_departement=${codeDept}&type_local=Appartement`
      statsRes = await fetch(statsUrl, { headers })
      console.log('Stats dept status:', statsRes.status, 'url:', statsUrl)
    }

    if (statsRes.ok) {
      const statsData = await statsRes.json()
      console.log('Stats data:', JSON.stringify(statsData).substring(0, 200))

      const avgM2 = statsData.prix_moyen_m2 || statsData.prix_median_m2 || 0
      const estValeur = (avgM2 && surfNum) ? Math.round(avgM2 * surfNum) : null

      if (avgM2 === 0) {
        return res.status(200).json({
          error: 'Données insuffisantes pour ce secteur',
          dvf: null,
          geo: { lat, lng, ville, codePostal, codeInsee }
        })
      }

      return res.status(200).json({
        dvf: {
          avgM2: Math.round(avgM2),
          medianM2: statsData.prix_median_m2 || null,
          est: estValeur,
          comp: statsData.nombre_transactions || 0,
          conf: 'bonne',
          evolution: statsData.evolution_annuelle || null,
          date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
          samples: []
        },
        geo: { lat, lng, ville, codePostal, codeInsee }
      })
    }

    // Si stats échoue — essai mutations nearby
    const nearbyUrl = `https://immoapi.app/v1/mutations/nearby?lat=${lat}&lng=${lng}&radius=2000&type_local=Appartement&per_page=30`
    const nearbyRes = await fetch(nearbyUrl, { headers })
    console.log('Nearby status:', nearbyRes.status)

    if (nearbyRes.ok) {
      const nearbyData = await nearbyRes.json()
      const mutations = nearbyData.mutations || []
      console.log('Nearby mutations count:', mutations.length)

      if (mutations.length === 0) {
        return res.status(200).json({ error: 'Aucune vente trouvée', dvf: null, geo: { lat, lng, ville, codePostal, codeInsee } })
      }

      const normalized = mutations
        .map(r => ({ prix: parseFloat(r.valeur_fonciere || 0), surface: parseFloat(r.surface_reelle_bati || 0), prixM2: parseFloat(r.prix_m2 || 0) }))
        .filter(r => r.prix > 50000 && r.surface > 10)

      const filtered = surfNum ? normalized.filter(r => r.surface >= surfNum * 0.7 && r.surface <= surfNum * 1.3) : normalized
      const ventes = (filtered.length >= 3 ? filtered : normalized).slice(0, 15)
      const prixM2List = ventes.map(v => v.prixM2 || (v.prix / v.surface))
      const avgM2 = Math.round(prixM2List.reduce((a, b) => a + b, 0) / prixM2List.length)

      return res.status(200).json({
        dvf: { avgM2, est: surfNum ? Math.round(avgM2 * surfNum) : null, comp: ventes.length, conf: 'indicative', date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }), samples: [] },
        geo: { lat, lng, ville, codePostal, codeInsee }
      })
    }

    const errText = await statsRes.text()
    console.log('All endpoints failed. Last error:', errText.substring(0, 200))
    return res.status(200).json({ error: 'API DVF indisponible', dvf: null, geo: { lat, lng, ville, codePostal, codeInsee } })

  } catch (err) {
    console.log('DVF catch error:', err.message)
    return res.status(200).json({ error: err.message, dvf: null })
  }
}
