export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { adresse, surface, section_cadastrale, type_local = 'Appartement' } = req.body
  if (!adresse) return res.status(400).json({ error: 'Adresse manquante' })

  const surfNum = surface ? parseFloat(surface) : null

  try {
    // Étape 1 — Géocoder pour obtenir code INSEE
    const geoRes = await fetch(
      `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(adresse)}&limit=1`
    )
    const geoData = await geoRes.json()
    if (!geoData.features?.length) {
      return res.status(200).json({ error: 'Adresse introuvable', dvf: null })
    }

    const feature = geoData.features[0]
    const [lng, lat] = feature.geometry.coordinates
    const ville = feature.properties.city
    const codePostal = feature.properties.postcode
    const codeInsee = feature.properties.citycode

    console.log('Geocodé:', ville, codeInsee)

    // Parser la référence cadastrale : "870H117" → section=H, numero=117
    let sectionLettre = null
    let numeroParcelle = null

    if (section_cadastrale?.trim()) {
      const raw = section_cadastrale.trim().toUpperCase()
      const match = raw.match(/([A-Z]+)(\d+)?$/)
      if (match) {
        sectionLettre = match[1]
        numeroParcelle = match[2] || null
      }
      console.log(`Référence: "${raw}" → section="${sectionLettre}" numéro="${numeroParcelle}"`)
    }

    let mutations = []
    let methode = ''

    // Priorité 1 : API DVF officielle par parcelle exacte
    if (sectionLettre && numeroParcelle) {
      const apiUrl = `https://apidf-preprod.cerema.fr/dvf_opendata/mutations/?section=${sectionLettre}&numero_plan=${numeroParcelle}&code_insee=${codeInsee}&nb_resultats=50`
      console.log('API DVF parcelle:', apiUrl)
      try {
        const r = await fetch(apiUrl)
        const data = await r.json()
        if (data.results?.length >= 1) {
          mutations = data.results
          methode = `Parcelle ${sectionLettre}${numeroParcelle}`
          console.log(`Parcelle exacte: ${mutations.length} ventes`)
        }
      } catch(e) { console.log('API parcelle erreur:', e.message) }
    }

    // Priorité 2 : API DVF par section
    if (mutations.length < 3 && sectionLettre) {
      const apiUrl = `https://apidf-preprod.cerema.fr/dvf_opendata/mutations/?section=${sectionLettre}&code_insee=${codeInsee}&nb_resultats=100`
      console.log('API DVF section:', apiUrl)
      try {
        const r = await fetch(apiUrl)
        const data = await r.json()
        if (data.results?.length >= 3) {
          mutations = data.results
          methode = `Section ${sectionLettre}`
          console.log(`Section: ${mutations.length} ventes`)
        }
      } catch(e) { console.log('API section erreur:', e.message) }
    }

    // Priorité 3 : Notre base Supabase par commune
    if (mutations.length < 3) {
      const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xzkzzxgkoxipmkbxynfq.supabase.co'
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
      const url = `${SUPABASE_URL}/rest/v1/dvf_transactions?code_insee=eq.${codeInsee}&type_local=eq.${encodeURIComponent(type_local)}&order=date_mutation.desc&limit=100`
      const r = await fetch(url, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      })
      const data = await r.json()
      if (data?.length >= 3) {
        // Convertir format Supabase vers format API
        mutations = data.map(t => ({
          valeur_fonciere: t.valeur_fonciere,
          surface_reelle_bati: t.surface_reelle_bati,
          date_mutation: t.date_mutation,
          prix_m2: t.prix_m2
        }))
        methode = `Commune ${ville}`
        console.log(`Commune: ${mutations.length} ventes`)
      }
    }

    if (mutations.length < 3) {
      return res.status(200).json({
        error: 'Pas assez de ventes comparables dans ce secteur',
        dvf: null,
        geo: { lat, lng, ville, codePostal, codeInsee }
      })
    }

    // Filtrage par surface ±40%
    let filtered = mutations
    if (surfNum) {
      const avecSurface = mutations.filter(t => {
        const s = t.surface_reelle_bati || t.surface_bati
        return s >= surfNum * 0.6 && s <= surfNum * 1.4
      })
      if (avecSurface.length >= 3) {
        filtered = avecSurface
        console.log(`Filtrage surface ±40%: ${filtered.length} ventes`)
      }
    }

    // Prix médian au m²
    const prixM2List = filtered
      .map(t => t.prix_m2 || (t.valeur_fonciere && t.surface_reelle_bati ? Math.round(t.valeur_fonciere / t.surface_reelle_bati) : null))
      .filter(p => p && p > 500 && p < 25000)
      .sort((a, b) => a - b)

    if (!prixM2List.length) {
      return res.status(200).json({ error: 'Données insuffisantes', dvf: null })
    }

    const avgM2 = Math.round(prixM2List[Math.floor(prixM2List.length / 2)])
    const est = surfNum ? Math.round(avgM2 * surfNum) : null

    console.log(`DVF [${methode}]: ${avgM2}€/m² — ${prixM2List.length} ventes`)

    return res.status(200).json({
      dvf: {
        avgM2, medianM2: avgM2, est,
        comp: prixM2List.length,
        methode,
        conf: prixM2List.length >= 10 ? 'bonne' : 'indicative',
        date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
        samples: filtered.slice(0, 5).map(t => ({
          d: t.date_mutation,
          s: t.surface_reelle_bati || t.surface_bati,
          p: t.valeur_fonciere,
          m: t.prix_m2 || Math.round(t.valeur_fonciere / (t.surface_reelle_bati || 1))
        }))
      },
      geo: { lat, lng, ville, codePostal, codeInsee }
    })

  } catch (err) {
    console.error('DVF error:', err.message)
    return res.status(200).json({ error: err.message, dvf: null })
  }
}
