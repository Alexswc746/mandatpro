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
    // Étape 1 — Géocoder l'adresse via API Adresse officielle
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

    const surfNum = surface ? parseFloat(surface) : null

    // Étape 2 — Recherche par proximité GPS via Immo API
    // Rayon de 1500m autour du bien
    const nearbyUrl = `https://immoapi.app/v1/mutations/nearby?lat=${lat}&lon=${lng}&radius=1500&type_local=Appartement&limit=30`
    
    const dvfRes = await fetch(nearbyUrl, {
      headers: {
        'Authorization': `Bearer ${IMMO_API_KEY}`,
        'Accept': 'application/json'
      }
    })

    let mutations = []

    if (dvfRes.ok) {
      const dvfData = await dvfRes.json()
      mutations = dvfData.mutations || dvfData.results || dvfData || []
    }

    // Fallback — recherche par commune si pas assez de résultats GPS
    if (mutations.length < 3) {
      const communeUrl = `https://immoapi.app/v1/mutations?code_commune=${codeInsee}&type_local=Appartement&limit=40`
      const communeRes = await fetch(communeUrl, {
        headers: {
          'Authorization': `Bearer ${IMMO_API_KEY}`,
          'Accept': 'application/json'
        }
      })
      if (communeRes.ok) {
        const communeData = await communeRes.json()
        mutations = communeData.mutations || communeData.results || communeData || []
      }
    }

    if (mutations.length === 0) {
      return res.status(200).json({
        error: 'Aucune vente trouvée dans ce secteur',
        dvf: null,
        geo: { lat, lng, ville, codePostal, codeInsee }
      })
    }

    // Normaliser les champs
    const normalized = mutations
      .map(r => ({
        prix: parseFloat(r.valeur_fonciere || r.prix || 0),
        surface: parseFloat(r.surface_reelle_bati || r.surface || 0),
        prixM2: parseFloat(r.prix_m2 || 0),
        date: r.date_mutation || r.date || ''
      }))
      .filter(r => r.prix > 50000 && r.surface > 10)

    // Filtrer par surface ±30% si fournie
    const filtered = surfNum
      ? normalized.filter(r => r.surface >= surfNum * 0.7 && r.surface <= surfNum * 1.3)
      : normalized

    const ventes = (filtered.length >= 3 ? filtered : normalized).slice(0, 15)

    if (ventes.length === 0) {
      return res.status(200).json({
        error: 'Données insuffisantes',
        dvf: null,
        geo: { lat, lng, ville, codePostal, codeInsee }
      })
    }

    // Calculer prix moyen au m²
    const prixM2List = ventes.map(v => v.prixM2 || (v.prix / v.surface))
    const avgM2 = Math.round(prixM2List.reduce((a, b) => a + b, 0) / prixM2List.length)
    const estValeur = surfNum ? Math.round(avgM2 * surfNum) : null

    const samples = ventes.slice(0, 5).map(v => ({
      d: v.date ? new Date(v.date).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' }) : '',
      s: Math.round(v.surface),
      p: Math.round(v.prix),
      m: Math.round(v.prixM2 || v.prix / v.surface)
    }))

    return res.status(200).json({
      dvf: {
        avgM2,
        est: estValeur,
        comp: ventes.length,
        conf: ventes.length >= 5 ? 'bonne' : 'indicative',
        date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
        samples
      },
      geo: { lat, lng, ville, codePostal, codeInsee }
    })

  } catch (err) {
    return res.status(200).json({ error: err.message, dvf: null })
  }
}
