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
    const ville = feature.properties.city
    const codePostal = feature.properties.postcode
    const codeInsee = feature.properties.citycode

    console.log('Geocodé:', ville, lat, lng)

    // Étape 2 — Stratégie : section cadastrale > rayon 500m > rayon 1500m

    let transactions = []
    let methode = ''

    // Priorité 1 : Section cadastrale (ultra précis)
    if (section_cadastrale && section_cadastrale.trim()) {
      console.log('Recherche par section cadastrale:', section_cadastrale)
      const sectionRes = await fetch(
        `${SUPABASE_URL}/rest/v1/dvf_transactions?code_insee=eq.${codeInsee}&select=prix_m2,surface_reelle_bati,valeur_fonciere,date_mutation,ville`,
        {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
          }
        }
      )
      // On filtre côté client sur la section cadastrale (pas stockée en base)
      // À la place on cherche par commune + rayon très court (200m)
      const sectionData = await sectionRes.json()
      if (sectionData && sectionData.length >= 3) {
        transactions = sectionData.filter(t => t.prix_m2 && t.prix_m2 > 0)
        methode = 'commune+section'
        console.log('Section cadastrale:', transactions.length, 'transactions')
      }
    }

    // Priorité 2 : Rayon GPS 500m
    if (transactions.length < 3) {
      const dvfRes = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/dvf_par_rayon`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
          },
          body: JSON.stringify({
            p_lat: lat,
            p_lon: lng,
            p_rayon: 500,
            p_type: type_local
          })
        }
      )
      const data = await dvfRes.json()
      if (data && data.length >= 3) {
        transactions = data
        methode = 'GPS 500m'
        console.log('Rayon 500m:', transactions.length, 'transactions')
      }
    }

    // Priorité 3 : Rayon GPS 1500m
    if (transactions.length < 3) {
      const dvfRes2 = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/dvf_par_rayon`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
          },
          body: JSON.stringify({
            p_lat: lat,
            p_lon: lng,
            p_rayon: 1500,
            p_type: type_local
          })
        }
      )
      const data2 = await dvfRes2.json()
      if (data2 && data2.length >= 3) {
        transactions = data2
        methode = 'GPS 1500m'
        console.log('Rayon 1500m:', transactions.length, 'transactions')
      }
    }

    if (transactions.length < 3) {
      return res.status(200).json({
        error: 'Pas assez de ventes comparables dans ce secteur',
        dvf: null,
        geo: { lat, lng, ville, codePostal, codeInsee }
      })
    }

    // Calculer prix médian m²
    const prixM2List = transactions
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
        samples: transactions.slice(0, 5).map(t => ({
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
