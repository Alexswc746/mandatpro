export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { adresse, surface, type_local = 'Appartement' } = req.body
  if (!adresse) return res.status(400).json({ error: 'Adresse manquante' })

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

    console.log('Geocodé:', ville, codeInsee)

    // Étape 2 — DVF direct depuis data.gouv.fr (Vercel côté serveur, pas de CORS)
    const dvfUrl = `https://api.data.gouv.fr/dvf/v1/geojson/?code_insee=${codeInsee}`
    console.log('DVF URL:', dvfUrl)

    let features = []

    const dvfRes = await fetch(dvfUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(25000)
    })

    if (dvfRes.ok) {
      const dvfData = await dvfRes.json()
      features = dvfData.features || []
    } else {
      // Fallback par GPS
      const pointRes = await fetch(
        `https://api.data.gouv.fr/dvf/v1/geojson/?lat=${lat}&lon=${lng}&dist=1000`,
        { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(25000) }
      )
      if (pointRes.ok) {
        const pointData = await pointRes.json()
        features = pointData.features || []
      }
    }

    // Filtrer par type
    const filtered = features.filter(f =>
      f.properties?.type_local?.toLowerCase() === type_local.toLowerCase()
    )
    const source = filtered.length >= 3 ? filtered : features

    if (source.length === 0) {
      return res.status(200).json({
        error: 'Aucune vente trouvée',
        dvf: null,
        geo: { lat, lng, ville, codePostal, codeInsee }
      })
    }

    // Calculer prix/m²
    const prixM2List = source
      .map(f => {
        const val = parseFloat(f.properties?.valeur_fonciere || 0)
        const surf = parseFloat(f.properties?.surface_reelle_bati || 0)
        return surf > 10 && val > 10000 ? val / surf : null
      })
      .filter(Boolean)
      .sort((a, b) => a - b)

    if (prixM2List.length === 0) {
      return res.status(200).json({ error: 'Données insuffisantes', dvf: null, geo: { lat, lng, ville, codePostal, codeInsee } })
    }

    const avgM2 = Math.round(prixM2List[Math.floor(prixM2List.length / 2)])
    const est = surfNum ? Math.round(avgM2 * surfNum) : null

    console.log('DVF:', avgM2, '€/m² —', prixM2List.length, 'ventes')

    return res.status(200).json({
      dvf: {
        avgM2, medianM2: avgM2, est,
        comp: prixM2List.length,
        conf: prixM2List.length >= 10 ? 'bonne' : 'indicative',
        date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
        samples: []
      },
      geo: { lat, lng, ville, codePostal, codeInsee }
    })

  } catch (err) {
    console.log('DVF error:', err.message)
    return res.status(200).json({ error: err.message, dvf: null })
  }
}
