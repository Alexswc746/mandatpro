export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { adresse, surface, section_cadastrale, type_local = 'Appartement' } = req.body
  if (!adresse) return res.status(400).json({ error: 'Adresse manquante' })

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xzkzzxgkoxipmkbxynfq.supabase.co'
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
  const surfNum = surface ? parseFloat(surface) : null

  try {
    // Étape 1 — Géocoder l'adresse pour obtenir le code INSEE
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
    const ville = feature.properties.city
    const codePostal = feature.properties.postcode
    const codeInsee = feature.properties.citycode

    console.log('Geocodé:', ville, codeInsee)

    let transactions = []
    let methode = ''

    // Priorité 1 : Section cadastrale (ultra précis)
    if (section_cadastrale && section_cadastrale.trim()) {
      const section = section_cadastrale.trim().toUpperCase()
      console.log('Recherche par section cadastrale:', section, 'commune:', codeInsee)

      const url = `${SUPABASE_URL}/rest/v1/dvf_transactions?code_insee=eq.${codeInsee}&section_cadastrale=eq.${section}&type_local=eq.${encodeURIComponent(type_local)}&order=date_mutation.desc&limit=100`
      const dvfRes = await fetch(url, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      })
      const data = await dvfRes.json()
      if (data && data.length >= 3) {
        transactions = data
        methode = `Section ${section}`
        console.log('Section cadastrale trouvée:', transactions.length, 'ventes')
      } else {
        console.log('Pas assez de ventes pour section', section, '— élargissement à la commune')
      }
    }

    // Priorité 2 : Toute la commune (code INSEE)
    if (transactions.length < 3) {
      console.log('Recherche par commune:', codeInsee)
      const url = `${SUPABASE_URL}/rest/v1/dvf_transactions?code_insee=eq.${codeInsee}&type_local=eq.${encodeURIComponent(type_local)}&order=date_mutation.desc&limit=100`
      const dvfRes = await fetch(url, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      })
      const data = await dvfRes.json()
      if (data && data.length >= 3) {
        transactions = data
        methode = `Commune ${ville}`
        console.log('Commune trouvée:', transactions.length, 'ventes')
      }
    }

    if (transactions.length < 3) {
      return res.status(200).json({
        error: 'Pas assez de ventes comparables dans ce secteur',
        dvf: null,
        geo: { lat, lng, ville, codePostal, codeInsee }
      })
    }

    // Filtrer par surface similaire si disponible (±40%)
    let filtered = transactions
    if (surfNum) {
      const avecSurface = transactions.filter(t =>
        t.surface_reelle_bati >= surfNum * 0.6 &&
        t.surface_reelle_bati <= surfNum * 1.4
      )
      if (avecSurface.length >= 3) {
        filtered = avecSurface
        console.log('Filtrage surface ±40%:', filtered.length, 'ventes retenues')
      }
    }

    // Calculer prix médian au m²
    const prixM2List = filtered
      .map(t => t.prix_m2)
      .filter(p => p && p > 500 && p < 25000)
      .sort((a, b) => a - b)

    if (prixM2List.length === 0) {
      return res.status(200).json({ error: 'Données insuffisantes', dvf: null })
    }

    const avgM2 = Math.round(prixM2List[Math.floor(prixM2List.length / 2)])
    const est = surfNum ? Math.round(avgM2 * surfNum) : null

    console.log(`DVF [${methode}]: ${avgM2}€/m² — ${prixM2List.length} ventes`)

    return res.status(200).json({
      dvf: {
        avgM2,
        medianM2: avgM2,
        est,
        comp: prixM2List.length,
        methode,
        conf: prixM2List.length >= 10 ? 'bonne' : 'indicative',
        date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
        samples: filtered.slice(0, 5).map(t => ({
          d: t.date_mutation,
          s: t.surface_reelle_bati,
          p: t.valeur_fonciere,
          m: t.prix_m2
        }))
      },
      geo: { lat, lng, ville, codePostal, codeInsee }
    })

  } catch (err) {
    console.error('DVF error:', err.message)
    return res.status(200).json({ error: err.message, dvf: null })
  }
}
